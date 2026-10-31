import { q, tx } from './db.js';
import { bad, money, text, dateStr, httpsUrl, HttpError } from './http.js';
import * as E from '../src/lib/estimating.ts';
import { createProject, listProjects } from './projectApi.js';
import { loadInputs } from './projects.js';
import { registerLinkable } from './messaging.js';
import { tradeStats } from '../src/lib/costing.ts';

registerLinkable('opportunity', { sql: 'SELECT name AS label FROM opportunities WHERE id=$1', route: (id) => `#/estimating/${id}` });
export const EST_ROLES = ['Super Admin', 'Sub Admin', 'Estimator'];
const TYPES = ['Retail', 'Restaurant', 'Office / Medical / Other'], METHODS = ['Email', 'via BuildingConnected', 'PlanHub', 'Other'], KINDS = ['First Email Sent', 'Call / Message', 'Final Email Sent', 'Reply Received', 'Note'];
const log = (t, id, user, action, detail) => t('INSERT INTO opportunity_events(opportunity_id,user_id,action,detail) VALUES ($1,$2,$3,$4)', [id, user?.id ?? null, action, detail ?? null]);
const r2 = (n) => Math.round(n * 100) / 100;

// ------------------------------------------------------------------ reading
async function loadAll(where = '', params = []) {
  const rows = await q(`SELECT o.*, u.name AS estimator FROM opportunities o LEFT JOIN app_users u ON u.id=o.estimator_id ${where} ORDER BY o.due_date NULLS LAST, o.name`, params);
  const ids = rows.map((r) => r.id); if (!ids.length) return [];
  const [prices, subs, comms] = await Promise.all([
    q('SELECT ot.opportunity_id, ot.trade_id, t.name, ot.amount FROM opportunity_trades ot JOIN trades t ON t.id=ot.trade_id WHERE ot.opportunity_id = ANY($1::uuid[]) ORDER BY t.sort, t.name', [ids]),
    q('SELECT * FROM submissions WHERE opportunity_id = ANY($1::uuid[]) ORDER BY version', [ids]),
    q('SELECT * FROM communications WHERE opportunity_id = ANY($1::uuid[]) ORDER BY comm_date, created_at', [ids])]);
  const today = E.todayEastern();
  return rows.map((r) => {
    const tp = prices.filter((p) => p.opportunity_id === r.id).map((p) => ({ tradeId: p.trade_id, name: p.name, amount: p.amount }));
    const ss = subs.filter((s) => s.opportunity_id === r.id).map((s) => ({ id: s.id, version: s.version, date: s.submitted_date, method: s.method, price: s.price, link: s.link, note: s.note }));
    const cs = comms.filter((c) => c.opportunity_id === r.id).map((c) => ({ id: c.id, kind: c.kind, date: c.comm_date, note: c.note, cycle: c.submission_id }));
    const last = ss.at(-1) ?? null;
    return { id: r.id, name: r.name, gc: r.gc_name, additionalGcs: r.additional_gcs, city: r.city, address: r.address, tier: r.tier, mall: r.mall, type: r.project_type, due: r.due_date, dueTime: r.due_time, contact: r.contact_name, email: r.contact_email, phone: r.contact_phone, link: r.invitation_link,
      status: r.status, progress: r.progress, result: r.result, estimatorId: r.estimator_id, estimator: r.estimator, proposalId: r.proposal_id, acceptedDate: r.accepted_date, startDate: r.start_date, declinedReason: r.declined_reason, lostReason: r.lost_reason, folderUrl: r.folder_url, proposalUrl: r.proposal_url, notes: r.notes, source: r.source, projectId: r.project_id,
      tradePrices: tp, total: r2(tp.reduce((n, p) => n + Math.round(p.amount * 100), 0) / 100), submissions: ss, communications: cs, lastSubmission: last,
      countdown: E.countdown(r.due_date, !!last, today), week: E.groupFor(r.due_date, today), followup: E.followupPlan(last, cs, { result: r.result }) };
  });
}
const isOpenLead = (o, today) => !o.acceptedDate && !['No Bid', 'Awarded', 'Lost', 'Submitted'].includes(o.status) && !E.expiredLead(o.due, today);
const isWorking = (o) => o.acceptedDate && !o.lastSubmission && !['No Bid', 'Awarded', 'Lost'].includes(o.status);
export async function list({ tab, search, showAll } = {}) {
  const today = E.todayEastern(); let all = await loadAll();
  const term = String(search || '').toLowerCase();
  if (term) all = all.filter((o) => [o.name, o.gc, o.city, o.proposalId, o.address].some((v) => String(v || '').toLowerCase().includes(term)));
  const month = today.slice(0, 7);
  const stats = { accepted: all.filter((o) => (o.acceptedDate || '').startsWith(month)).length, working: all.filter(isWorking).length, submitted: all.filter((o) => o.submissions.some((s) => s.date.startsWith(month))).length,
    openLeads: all.filter((o) => isOpenLead(o, today)).length, awaitingFollowUp: all.filter((o) => o.lastSubmission && ['First Email', 'Call / Message', 'Final Email'].includes(o.followup.stage) && o.followup.due && o.followup.due <= today).length, interested: all.filter((o) => o.followup.stage === 'Interested' && o.result === 'Pending').length };
  let rows = all;
  if (tab === 'bids') rows = showAll ? all.filter((o) => !o.acceptedDate) : all.filter((o) => isOpenLead(o, today));
  else if (tab === 'proposals') rows = all.filter((o) => o.acceptedDate);
  else if (tab === 'submissions') rows = all.filter((o) => o.submissions.length);
  const rank = (a, b) => a.tier - b.tier || Number(b.mall) - Number(a.mall) || TYPES.indexOf(a.type) - TYPES.indexOf(b.type) || a.name.localeCompare(b.name);
  if (tab === 'bids') { const groups = new Map(); for (const o of rows) (groups.get(o.week) ?? groups.set(o.week, []).get(o.week)).push(o);
    const extra = ['Due This Week — Too Tight To Bid', 'Missed / Past Due', 'No Bid Due Date Provided'];
    return { stats, groups: [...groups].sort(([a], [b]) => (a.startsWith('Week Of') ? 0 : 1) - (b.startsWith('Week Of') ? 0 : 1) || (a.startsWith('Week Of') ? a.localeCompare(b) : extra.indexOf(a) - extra.indexOf(b))).map(([name, rs]) => ({ name, rows: rs.sort(rank) })), count: rows.length }; }
  return { stats, rows, count: rows.length };
}
export async function get(id) {
  const [o] = await loadAll('WHERE o.id=$1', [id]); if (!o) throw new HttpError(404, 'Opportunity not found.');
  const events = await q('SELECT e.action, e.detail, e.created_at, u.name AS who FROM opportunity_events e LEFT JOIN app_users u ON u.id=e.user_id WHERE e.opportunity_id=$1 ORDER BY e.created_at DESC', [id]);
  return { ...o, folderPlan: E.folderPlan({ proposalId: o.proposalId, name: o.name, city: o.city, gc: o.gc, year: Number((o.acceptedDate || E.todayEastern()).slice(0, 4)) }), events };
}

// ------------------------------------------------------------------ writing
function fields(b, creating) {
  const v = {};
  if (creating || b.name !== undefined) v.name = text(b.name, 'Project name', { max: 200 });
  if (creating || b.gc !== undefined) v.gc_name = text(b.gc, 'GC', { max: 200 });
  if (b.additionalGcs !== undefined) v.additional_gcs = text(b.additionalGcs, 'Additional GCs', { max: 500, required: false }) || null;
  if (creating || b.city !== undefined) v.city = text(b.city, 'City', { max: 100, required: creating });
  if (b.state !== undefined && String(b.state).toUpperCase() !== 'FL') throw bad('This system is for Florida projects only.');
  if (b.address !== undefined) v.address = text(b.address, 'Address', { max: 300, required: false }) || null;
  if (b.tier !== undefined) { const n = Number(b.tier); if (![1, 2, 3, 4].includes(n)) throw bad('Region tier is 1 to 4.'); v.tier = n; }
  if (b.mall !== undefined) v.mall = !!b.mall;
  if (b.type !== undefined) { if (!TYPES.includes(b.type)) throw bad('Choose a project type.'); v.project_type = b.type; }
  if (b.due !== undefined) v.due_date = dateStr(b.due, 'Bid due date');
  if (b.dueTime !== undefined) { if (b.dueTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(b.dueTime)) throw bad('Due time looks like 17:00.'); v.due_time = b.dueTime || null; }
  for (const [k, c, l] of [['contact', 'contact_name', 'Contact'], ['email', 'contact_email', 'Email'], ['phone', 'contact_phone', 'Phone'], ['notes', 'notes', 'Notes']]) if (b[k] !== undefined) v[c] = text(b[k], l, { max: 2000, required: false }) || null;
  if (v.contact_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.contact_email)) throw bad('Enter a valid contact email.');
  for (const [k, c, l] of [['link', 'invitation_link', 'Invitation link'], ['folderUrl', 'folder_url', 'Folder link'], ['proposalUrl', 'proposal_url', 'Proposal link']]) if (b[k] !== undefined) v[c] = httpsUrl(b[k], l);
  if (b.estimatorId !== undefined) v.estimator_id = b.estimatorId || null;
  if (b.progress !== undefined) { if (!['Not Started', 'In Progress', 'Needs Review', 'Done'].includes(b.progress)) throw bad('Choose a valid progress.'); v.progress = b.progress; }
  if (b.status !== undefined) { if (!['New', 'Reviewing'].includes(b.status)) throw bad('Use Accept or Decline to move a lead.'); v.status = b.status; }
  return v;
}
const insert = (t, v, extra = {}) => { const all = { ...v, ...extra }, k = Object.keys(all); return t(`INSERT INTO opportunities(${k.join(',')}) VALUES (${k.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING id`, k.map((x) => all[x])); };
export async function create(user, b) {
  const v = fields({ state: 'FL', ...b }, true); const key = E.leadKey(v.gc_name, v.name, v.due_date ?? null);
  try { return await tx(async (t) => { const [r] = await insert(t, v, { source: 'Manual', source_key: key }); await log(t, r.id, user, 'Added', 'Entered by hand'); return { id: r.id }; }); }
  catch (e) { throw e.code === '23505' ? new HttpError(409, 'That lead is already in the system.') : e; }
}
export async function update(user, id, b) {
  const v = fields(b, false), keys = Object.keys(v); if (!keys.length) throw bad('Nothing to save.');
  await tx(async (t) => {
    if (v.estimator_id && !(await t(`SELECT 1 FROM app_users WHERE id=$1 AND active AND role = ANY($2::text[])`, [v.estimator_id, EST_ROLES])).length) throw bad('Choose an estimator from the team list.');
    const r = await t(`UPDATE opportunities SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(',')} WHERE id=$1 RETURNING id`, [id, ...keys.map((k) => v[k])]); if (!r.length) throw new HttpError(404, 'Opportunity not found.');
    await log(t, id, user, 'Edited', keys.join(', '));
  });
}
export async function remove(id) {
  const [o] = await q('SELECT project_id FROM opportunities WHERE id=$1', [id]); if (!o) throw new HttpError(404, 'Opportunity not found.');
  if (o.project_id) throw new HttpError(409, 'This opportunity became a project. Delete or keep the project instead.');
  await q('DELETE FROM record_links WHERE kind=$1 AND record_id=$2', ['opportunity', id]); await q('DELETE FROM opportunities WHERE id=$1', [id]);
}
export async function importLeads(user, b) {
  let rows;
  if (typeof b.csv === 'string') { const m = E.mapLeadRows(E.parseCsv(b.csv)); if (m.missing.length) throw bad(`The file needs columns for: ${m.missing.join(', ')}. Expected headings like Project, GC/Company, City, State, Bid Due.`); rows = m.rows; }
  else if (Array.isArray(b.rows)) rows = b.rows; else throw bad('Paste or upload a CSV.');
  if (rows.length > 500) throw bad('Import up to 500 leads at a time.');
  const out = { added: 0, duplicates: 0, skipped: [] };
  for (const [i, r] of rows.entries()) {
    const label = `Row ${i + 2}`;
    try {
      if (r.state && String(r.state).toUpperCase() !== 'FL') { out.skipped.push(`${label}: ${r.name || ''} is not in Florida`); continue; }
      const due = E.normalizeDate(r.due); if (r.due && !due) { out.skipped.push(`${label}: bid date "${r.due}" is not a date`); continue; }
      const v = fields({ name: r.name, gc: r.gc, city: r.city || 'Florida', address: r.address, due, contact: r.contact, email: r.email, phone: r.phone, link: r.link, type: TYPES.includes(r.type) ? r.type : undefined, tier: Number(r.tier) || undefined }, true);
      const key = E.leadKey(v.gc_name, v.name, due);
      await tx(async (t) => { const [o] = await insert(t, v, { source: b.source === 'BuildingConnected' ? 'BuildingConnected CSV' : 'CSV import', source_key: key }); await log(t, o.id, user, 'Imported', 'Lead import'); });
      out.added++;
    } catch (e) { if (e.code === '23505') out.duplicates++; else if (e instanceof HttpError) out.skipped.push(`${label}: ${e.message}`); else throw e; }
  }
  return out;
}
export async function accept(user, id, b = {}) {
  return tx(async (t) => {
    const [o] = await t('SELECT * FROM opportunities WHERE id=$1 FOR UPDATE', [id]); if (!o) throw new HttpError(404, 'Opportunity not found.');
    if (o.accepted_date) throw new HttpError(409, 'This lead was already accepted.'); if (o.status === 'No Bid') throw new HttpError(409, 'Reopen this lead before accepting it.');
    const est = b.estimatorId || user.id;
    if (!(await t(`SELECT 1 FROM app_users WHERE id=$1 AND active AND role = ANY($2::text[])`, [est, EST_ROLES])).length) throw bad('Choose an estimator from the team list.');
    const today = E.todayEastern(), pid = E.nextProposalId((await t('SELECT proposal_id FROM opportunities WHERE proposal_id IS NOT NULL')).map((x) => x.proposal_id), today);
    await t(`UPDATE opportunities SET status='Bidding', progress='In Progress', accepted_date=$2, start_date=$2, proposal_id=$3, estimator_id=$4, result='Pending', declined_reason=NULL WHERE id=$1`, [id, today, pid, est]);
    await log(t, id, user, 'Accepted', `Proposal ${pid}`);
    return { proposalId: pid, folderPlan: E.folderPlan({ proposalId: pid, name: o.name, city: o.city, gc: o.gc_name, year: Number(today.slice(0, 4)) }) };
  });
}
export async function decline(user, id, reason) {
  const why = text(reason, 'Reason', { max: 300 });
  await tx(async (t) => {
    const [o] = await t('SELECT accepted_date FROM opportunities WHERE id=$1 FOR UPDATE', [id]); if (!o) throw new HttpError(404, 'Opportunity not found.');
    if (o.accepted_date) throw new HttpError(409, 'Accepted work cannot be declined. Mark it as lost or no bid from its proposal.');
    await t(`UPDATE opportunities SET status='No Bid', result='No Bid', declined_reason=$2 WHERE id=$1`, [id, why]); await log(t, id, user, 'Declined', why);
  });
}
export async function reopenLead(user, id) {
  const r = await q(`UPDATE opportunities SET status='New', result='Pending', declined_reason=NULL WHERE id=$1 AND accepted_date IS NULL AND status='No Bid' RETURNING id`, [id]);
  if (!r.length) throw bad('Only a declined lead can be reopened.'); await q('INSERT INTO opportunity_events(opportunity_id,user_id,action) VALUES ($1,$2,$3)', [id, user.id, 'Reopened']);
}
export async function setTradePrices(user, id, prices) {
  if (!Array.isArray(prices) || prices.length > 50) throw bad('Choose trades from Admin.');
  const seen = new Set(); const rows = prices.map((p) => { if (!p.tradeId || seen.has(p.tradeId)) throw bad('Choose each trade once.'); seen.add(p.tradeId); return { tradeId: p.tradeId, amount: money(p.amount, 'Price') }; });
  await tx(async (t) => {
    const [o] = await t('SELECT accepted_date, project_id FROM opportunities WHERE id=$1 FOR UPDATE', [id]); if (!o) throw new HttpError(404, 'Opportunity not found.');
    if (!o.accepted_date) throw bad('Accept the lead before pricing it.'); if (o.project_id) throw new HttpError(409, 'This is already a project. Change its contract amounts there.');
    for (const r of rows) if (!(await t('SELECT 1 FROM trades WHERE id=$1 AND NOT archived', [r.tradeId])).length) throw bad('Choose trades from Admin.');
    await t('DELETE FROM opportunity_trades WHERE opportunity_id=$1', [id]);
    for (const r of rows) await t('INSERT INTO opportunity_trades(opportunity_id,trade_id,amount) VALUES ($1,$2,$3)', [id, r.tradeId, r.amount]);
    await log(t, id, user, 'Priced', `${rows.length} trades, ${r2(rows.reduce((n, r) => n + r.amount, 0)).toFixed(2)}`);
  });
}
export async function addSubmission(user, id, b) {
  const date = dateStr(b.date, 'Submission date', true), today = E.todayEastern(); if (date > today) throw bad('The actual submission date cannot be in the future.');
  if (!METHODS.includes(b.method)) throw bad('Choose how it was submitted.');
  return tx(async (t) => {
    const [o] = await t('SELECT * FROM opportunities WHERE id=$1 FOR UPDATE', [id]); if (!o) throw new HttpError(404, 'Opportunity not found.');
    if (!o.accepted_date) throw bad('Accept the lead first.'); if (['Awarded', 'Lost', 'No Bid'].includes(o.result)) throw new HttpError(409, `This opportunity is ${o.result}.`);
    if (o.start_date && date < o.start_date) throw bad('Submission cannot be before the proposal started.');
    const [{ total }] = await t('SELECT COALESCE(SUM(amount),0) AS total FROM opportunity_trades WHERE opportunity_id=$1', [id]);
    const price = b.price === undefined || b.price === '' ? Number(total) : money(b.price, 'Price'); if (!(price > 0)) throw bad('Price the trades (or enter the price) before submitting.');
    const [{ v }] = await t('SELECT COALESCE(MAX(version),0)+1 AS v FROM submissions WHERE opportunity_id=$1', [id]);
    const [s] = await t('INSERT INTO submissions(opportunity_id,version,submitted_date,method,price,link,note,estimator_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id', [id, v, date, b.method, price, httpsUrl(b.link, 'Link'), text(b.note, 'Note', { max: 500, required: false }) || null, user.id]);
    await t(`UPDATE opportunities SET status='Submitted', progress='Done' WHERE id=$1`, [id]); await log(t, id, user, v > 1 ? `Resubmitted (v${v})` : 'Submitted', `${b.method}, ${price.toFixed(2)}`);
    return { id: s.id, version: v, price };
  });
}
export async function deleteSubmission(user, id, sid) {
  await tx(async (t) => {
    if (!(await t('DELETE FROM submissions WHERE id=$1 AND opportunity_id=$2 RETURNING id', [sid, id])).length) throw new HttpError(404, 'Submission not found.');
    const [{ n }] = await t('SELECT COUNT(*)::int n FROM submissions WHERE opportunity_id=$1', [id]);
    if (!n) await t(`UPDATE opportunities SET status='Bidding', progress='In Progress' WHERE id=$1 AND result='Pending'`, [id]); await log(t, id, user, 'Submission removed');
  });
}
export async function addComm(user, id, b) {
  if (!KINDS.includes(b.kind)) throw bad('Choose what happened.');
  const date = dateStr(b.date, 'Date', true);
  await tx(async (t) => {
    const [s] = await t('SELECT id FROM submissions WHERE opportunity_id=$1 ORDER BY version DESC LIMIT 1', [id]); if (!s && b.kind !== 'Note') throw bad('Submit the proposal before logging follow-up.');
    await t('INSERT INTO communications(opportunity_id,submission_id,kind,comm_date,note,user_id) VALUES ($1,$2,$3,$4,$5,$6)', [id, s?.id ?? null, b.kind, date, text(b.note, 'Note', { max: 500, required: false }) || null, user.id]);
    await log(t, id, user, b.kind);
  }).catch((e) => { throw e.code === '23503' ? new HttpError(404, 'Opportunity not found.') : e; });
}
export const deleteComm = (id, cid) => q('DELETE FROM communications WHERE id=$1 AND opportunity_id=$2', [cid, id]);

// Award: the proposal becomes a project with its trades and amounts. Loss records why, so pricing can improve.
export async function setResult(user, id, b) {
  if (!['Awarded', 'Lost', 'Pending'].includes(b.result)) throw bad('Choose Awarded, Lost, or Pending.');
  const reason = text(b.reason, 'Reason', { max: 400, required: b.result === 'Lost' });
  let projectId = null;
  await tx(async (t) => {
    const [o] = await t('SELECT * FROM opportunities WHERE id=$1 FOR UPDATE', [id]); if (!o) throw new HttpError(404, 'Opportunity not found.');
    if (!(await t('SELECT 1 FROM submissions WHERE opportunity_id=$1', [id])).length && b.result !== 'Pending') throw bad('Only a submitted proposal can be awarded or lost.');
    if (o.project_id && b.result !== 'Awarded') throw new HttpError(409, 'This became a project. Manage it from Projects.');
    if (b.result === 'Awarded') {
      if (o.project_id) throw new HttpError(409, 'A project was already created for this award.');
      const tp = await t('SELECT trade_id, amount FROM opportunity_trades WHERE opportunity_id=$1 AND amount > 0', [id]); if (!tp.length) throw bad('Price the trades first. The project is built from them.');
      let [gc] = await t('SELECT id FROM gcs WHERE lower(name)=lower($1)', [o.gc_name]); if (!gc) [gc] = await t('INSERT INTO gcs(name) VALUES ($1) RETURNING id', [o.gc_name]);
      projectId = (await createProject({ name: o.name, gcId: gc.id, client: o.gc_name, address: [o.address, o.city, o.state].filter(Boolean).join(', ') || o.name, proposalId: o.proposal_id, trades: tp.map((x) => ({ tradeId: x.trade_id, amount: x.amount })) }, t)).id;
    }
    await t(`UPDATE opportunities SET result=$2, status=$3, lost_reason=$4, project_id=COALESCE($5, project_id) WHERE id=$1`, [id, b.result, b.result === 'Pending' ? 'Submitted' : b.result, b.result === 'Lost' ? reason : null, projectId]);
    await log(t, id, user, b.result === 'Pending' ? 'Reopened result' : `Marked ${b.result}`, reason || null);
  });
  return { projectId };
}

// ------------------------------------------------------------------ learning from results
export async function insights() {
  const all = await loadAll(); const [{ value: set }] = await q(`SELECT value FROM app_settings WHERE key='estimating'`); const target = Number(set.targetMargin ?? 20);
  const scored = all.filter((o) => ['Awarded', 'Lost'].includes(o.result)); const won = scored.filter((o) => o.result === 'Awarded').length;
  const submitted = all.filter((o) => o.submissions.length);
  const rate = (rows) => { const w = rows.filter((o) => o.result === 'Awarded').length, l = rows.filter((o) => o.result === 'Lost').length; return { won: w, lost: l, winRate: w + l ? r2((w / (w + l)) * 100) : null }; };
  const group = (rows, key) => Object.entries(rows.reduce((m, o) => { (m[key(o)] ||= []).push(o); return m; }, {})).map(([name, rs]) => ({ name, bids: rs.length, ...rate(rs), avgPrice: rs.length ? r2(rs.reduce((n, o) => n + (o.lastSubmission?.price ?? o.total), 0) / rs.length) : 0 })).sort((a, b) => b.bids - a.bids);
  const byTrade = {}; for (const o of scored) for (const p of o.tradePrices) { (byTrade[p.name] ||= []).push(o); }
  // realized margin per trade across projects that already carry cost
  const projects = await listProjects({ id: null }, true); const loaded = await loadInputs(projects.map((p) => p.id)); const agg = {};
  for (const p of loaded.values()) for (const t of p.trades) { const s = tradeStats(t.input); if (s.contract > 0 && s.actualCost > 0) { const a = (agg[t.name] ||= { contract: 0, cost: 0, projects: 0 }); a.contract += s.contract; a.cost += s.projectedCost; a.projects++; } }
  const margins = Object.entries(agg).map(([trade, a]) => { const margin = r2(((a.contract - a.cost) / a.contract) * 100); return { trade, projects: a.projects, margin, target, gap: r2(target - margin), suggestion: margin >= target ? 'On target' : `Realized ${margin}% vs ${target}% target: raise ${trade} pricing about ${r2(target - margin)} points.` }; }).sort((a, b) => b.gap - a.gap);
  const overall = rate(scored); const pending = all.filter((o) => o.lastSubmission && o.result === 'Pending');
  const pipelineValue = r2(pending.reduce((n, o) => n + o.lastSubmission.price, 0));
  const months = {}; for (const o of submitted) for (const s of o.submissions) { const m = s.date.slice(0, 7); (months[m] ||= { month: m, submitted: 0, value: 0 }); months[m].submitted++; months[m].value = r2(months[m].value + s.price); }
  return { target, overall, enough: scored.length >= 5, byGc: group(submitted, (o) => o.gc), byType: group(submitted, (o) => o.type), byTrade: Object.entries(byTrade).map(([name, rs]) => ({ name, ...rate(rs) })), margins,
    pipeline: { open: pending.length, value: pipelineValue, expected: scored.length >= 5 && overall.winRate !== null ? r2(pipelineValue * (overall.winRate / 100)) : null }, monthly: Object.values(months).sort((a, b) => a.month.localeCompare(b.month)).slice(-12),
    lossReasons: Object.entries(scored.filter((o) => o.result === 'Lost' && o.lostReason).reduce((m, o) => { m[o.lostReason] = (m[o.lostReason] || 0) + 1; return m; }, {})).map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n), won, scored: scored.length };
}
export async function saveTarget(v) { const n = Number(v); if (!(n >= 0 && n < 100)) throw bad('Target margin is a percent between 0 and 99.'); await q(`INSERT INTO app_settings(key,value) VALUES ('estimating',$1) ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=now()`, [{ targetMargin: n }]); }
