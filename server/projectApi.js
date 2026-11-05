import { q, tx } from './db.js';
import { bad, money, text, dateStr, httpsUrl, HttpError } from './http.js';
import { loadInputs, summarize } from './projects.js';
import { validateTrade } from '../src/lib/costing.ts';

const dbError = (e) => {
  if (e.code === '23505') return new HttpError(409, 'That already exists on this project.');
  if (e.code === '23503') return new HttpError(409, 'This record is used elsewhere.');
  return e;
};

export async function listProjects(user, manageAll) {
  const rows = manageAll
    ? await q('SELECT p.*, g.name AS gc FROM projects p JOIN gcs g ON g.id=p.gc_id ORDER BY p.active DESC, p.name')
    : await q('SELECT p.*, g.name AS gc FROM projects p JOIN gcs g ON g.id=p.gc_id JOIN project_members m ON m.project_id=p.id AND m.user_id=$1 ORDER BY p.active DESC, p.name', [user.id]);
  if (!rows.length) return [];
  const loaded = await loadInputs(rows.map((r) => r.id));
  return rows.map((r) => ({ id: r.id, name: r.name, gc: r.gc, client: r.client, address: r.address, active: r.active, proposalId: r.proposal_id, ...summarize(loaded.get(r.id)).project }));
}

export async function getProject(id) {
  const [p] = await q(`SELECT p.*, g.name AS gc, d.url AS contract_url FROM projects p JOIN gcs g ON g.id=p.gc_id
                       LEFT JOIN documents d ON d.id=p.contract_document_id WHERE p.id=$1`, [id]);
  if (!p) throw new HttpError(404, 'Project not found.');
  const loaded = await loadInputs([id]);
  const cos = await q(`SELECT c.*, t.name AS trade FROM change_orders c JOIN project_trades pt ON pt.id=c.project_trade_id JOIN trades t ON t.id=pt.trade_id
                       WHERE c.project_id=$1 ORDER BY c.number`, [id]);
  const s = summarize(loaded.get(id));
  const approved = cos.filter((c) => c.status === 'Approved').reduce((n, c) => n + Math.round(c.amount * 100), 0) / 100;
  const pending = cos.filter((c) => c.status === 'Pending').reduce((n, c) => n + Math.round(c.amount * 100), 0) / 100;
  return {
    project: { id: p.id, name: p.name, gc: p.gc, gcId: p.gc_id, client: p.client, address: p.address, retainagePct: p.retainage_pct, active: p.active, proposalId: p.proposal_id, refCode: p.ref_code ?? null, folderUrl: p.folder_url ?? null, spPath: p.sp_path ?? null, contractUrl: p.contract_url ?? null, lat: p.lat === null ? null : Number(p.lat), lng: p.lng === null ? null : Number(p.lng), geofenceRequired: p.geofence_required, geofenceMiles: Number(p.geofence_miles) },
    trades: s.trades, totals: s.project,
    changeOrders: cos.map((c) => ({ id: c.id, number: c.number, description: c.description, projectTradeId: c.project_trade_id, trade: c.trade, status: c.status, approvedDate: c.approved_date, amount: c.amount })),
    coTotals: { approved, pending },
  };
}

function parseTrades(list) {
  if (!Array.isArray(list) || !list.length) throw bad('Add at least one trade.');
  const seen = new Set();
  return list.map((t) => {
    if (!t.tradeId) throw bad('Choose a trade.');
    if (seen.has(t.tradeId)) throw bad('Each trade can be added only once.');
    seen.add(t.tradeId);
    return { tradeId: t.tradeId, amount: money(t.amount, 'Contract amount') };
  });
}

export async function createProject(b, outerTx = null) {
  const name = text(b.name, 'Project name', { max: 200 }), client = text(b.client, 'Client', { max: 200 }), address = text(b.address, 'Project address', { max: 300 });
  if (!b.gcId) throw bad('Choose a GC.');
  const trades = parseTrades(b.trades);
  const retainage = b.retainagePct === undefined ? 10 : Number(b.retainagePct);
  if (!(retainage >= 0 && retainage <= 100)) throw bad('Retainage must be between 0 and 100.');
  const contractUrl = httpsUrl(b.contractUrl, 'Contract link');
  try {
    const body = async (t) => {
      const [p] = await t(`INSERT INTO projects(name,gc_id,client,address,retainage_pct,proposal_id,logged_date,start_date)
                           VALUES ($1,$2,$3,$4,$5,$6,(now() AT TIME ZONE 'America/New_York')::date,$7) RETURNING id`,
        [name, b.gcId, client, address, retainage, text(b.proposalId, 'Proposal ID', { max: 40, required: false }) || null, dateStr(b.startDate, 'Start date')]);
      for (const tr of trades) await t('INSERT INTO project_trades(project_id,trade_id,original_amount) VALUES ($1,$2,$3)', [p.id, tr.tradeId, tr.amount]);
      await t('INSERT INTO project_ntos(project_id, year) VALUES ($1, $2)', [p.id, Number((dateStr(b.startDate, 'Start date') || new Date().toISOString()).slice(0, 4))]);
      if (contractUrl) {
        const [d] = await t(`INSERT INTO documents(category,name,url) VALUES ('Contract',$1,$2) RETURNING id`, [`${name} contract`, contractUrl]);
        await t('UPDATE projects SET contract_document_id=$1 WHERE id=$2', [d.id, p.id]);
      }
      return { id: p.id };
    };
    return outerTx ? await body(outerTx) : await tx(body);
  } catch (e) { throw dbError(e); }
}

export async function updateProject(id, b) {
  const sets = [], vals = [id];
  const add = (c, v) => { vals.push(v); sets.push(`${c}=$${vals.length}`); };
  if (b.name !== undefined) add('name', text(b.name, 'Project name', { max: 200 }));
  if (b.client !== undefined) add('client', text(b.client, 'Client', { max: 200 }));
  if (b.address !== undefined) add('address', text(b.address, 'Project address', { max: 300 }));
  if (b.gcId !== undefined) add('gc_id', b.gcId);
  if (b.active !== undefined) { if (typeof b.active !== 'boolean') throw bad('Active must be true or false.'); add('active', b.active); }
  if (b.retainagePct !== undefined) { const n = Number(b.retainagePct); if (!(n >= 0 && n <= 100)) throw bad('Retainage must be between 0 and 100.'); add('retainage_pct', n); }
  const coord = (v, lim, l) => { if (v === '' || v === null) return null; const n = Number(v); if (!Number.isFinite(n) || Math.abs(n) > lim) throw bad(`${l} is not a valid number.`); return n; };
  if (b.lat !== undefined || b.lng !== undefined) { const la = coord(b.lat, 90, 'Latitude'), ln = coord(b.lng, 180, 'Longitude'); if ((la === null) !== (ln === null)) throw bad('Enter both latitude and longitude, or neither.'); add('lat', la); add('lng', ln); }
  if (b.geofenceMiles !== undefined) { const n = Number(b.geofenceMiles); if (!(n >= 0.05 && n <= 100)) throw bad('Geofence radius must be between 0.05 and 100 miles.'); add('geofence_miles', n); }
  if (b.geofenceRequired !== undefined) { if (typeof b.geofenceRequired !== 'boolean') throw bad('geofenceRequired must be true or false.'); add('geofence_required', b.geofenceRequired); }
  if (!sets.length) throw bad('Nothing to save.');
  const r = await q(`UPDATE projects SET ${sets.join(',')} WHERE id=$1 RETURNING id`, vals);
  if (!r.length) throw new HttpError(404, 'Project not found.');
}

// After any change that affects contract value, make sure the trade's numbers still obey the billing rules.
async function assertTradeValid(projectId, ptId) {
  const loaded = await loadInputs([projectId]);
  const t = loaded.get(projectId).trades.find((x) => x.ptId === ptId);
  const errs = t ? validateTrade(t.input) : [];
  if (errs.length) throw bad(errs[0]);
}

export async function addTrade(projectId, b) {
  const [tr] = parseTrades([b]);
  try { await q('INSERT INTO project_trades(project_id,trade_id,original_amount) VALUES ($1,$2,$3)', [projectId, tr.tradeId, tr.amount]); } catch (e) { throw dbError(e); }
}
export async function setTradeAmount(projectId, ptId, b) {
  const amount = money(b.amount, 'Contract amount');
  await tx(async (t) => {
    const r = await t('UPDATE project_trades SET original_amount=$1 WHERE id=$2 AND project_id=$3 RETURNING id', [amount, ptId, projectId]);
    if (!r.length) throw new HttpError(404, 'Trade not found on this project.');
    const loaded = await loadInputsWith(t, projectId);
    const tr = loaded.find((x) => x.ptId === ptId);
    const errs = tr ? validateTrade(tr.input) : [];
    if (errs.length) throw bad(errs[0]);
  });
}
export async function removeTrade(projectId, ptId) {
  try {
    const r = await q('DELETE FROM project_trades WHERE id=$1 AND project_id=$2 RETURNING id', [ptId, projectId]);
    if (!r.length) throw new HttpError(404, 'Trade not found on this project.');
  } catch (e) { throw e.code === '23503' ? new HttpError(409, 'This trade has change orders, costs, or billing. Remove those first.') : e; }
}

// Re-load a project's numbers inside a transaction (so rules are checked against the uncommitted change).
export async function loadInputsWith(t, projectId) {
  return (await loadInputs([projectId], t)).get(projectId).trades;
}
// Throws if any trade (or unallocated cost) now breaks a billing rule.
export async function assertValid(t, projectId) {
  const loaded = (await loadInputs([projectId], t)).get(projectId);
  for (const tr of loaded.trades) { const e = validateTrade(tr.input); if (e.length) throw bad(`${tr.name}: ${e[0]}`); }
  const e = validateTrade({ original: 0, cos: [], invoices: [], ...loaded.unallocated });
  if (e.length) throw bad(`Project-level costs: ${e[0]}`);
}

function parseCO(b, creating) {
  const out = {};
  if (creating || b.number !== undefined) out.number = text(b.number, 'CO #', { max: 40 });
  if (creating || b.description !== undefined) out.description = text(b.description, 'CO description', { max: 1000 });
  if (creating || b.projectTradeId !== undefined) { if (!b.projectTradeId) throw bad('Choose a trade.'); out.project_trade_id = b.projectTradeId; }
  if (creating || b.status !== undefined) { if (!['Pending', 'Approved', 'Rejected'].includes(b.status)) throw bad('Choose a valid status.'); out.status = b.status; }
  if (creating || b.amount !== undefined) out.amount = money(b.amount, 'Revenue change', { negative: true });
  if (creating || b.approvedDate !== undefined) out.approved_date = dateStr(b.approvedDate, 'Approved date');
  return out;
}
const needApprovedDate = (c) => { if (c.status === 'Approved' && !c.approved_date) throw bad('Enter the approved date for an approved change order.'); };

export async function addChangeOrder(projectId, b) {
  const v = parseCO(b, true); needApprovedDate(v);
  try {
    return await tx(async (t) => {
      const own = await t('SELECT 1 FROM project_trades WHERE id=$1 AND project_id=$2', [v.project_trade_id, projectId]);
      if (!own.length) throw bad('That trade is not on this project.');
      const [c] = await t(`INSERT INTO change_orders(project_id,project_trade_id,number,description,status,approved_date,amount) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [projectId, v.project_trade_id, v.number, v.description, v.status, v.approved_date, v.amount]);
      const tr = (await loadInputsWith(t, projectId)).find((x) => x.ptId === v.project_trade_id);
      const errs = validateTrade(tr.input); if (errs.length) throw bad(errs[0]);
      return { id: c.id };
    });
  } catch (e) { throw e instanceof HttpError ? e : (e.code === '23505' ? new HttpError(409, 'That CO # is already used on this project.') : e); }
}
export async function updateChangeOrder(projectId, id, b) {
  const v = parseCO(b, false);
  try {
    await tx(async (t) => {
      const [cur] = await t('SELECT * FROM change_orders WHERE id=$1 AND project_id=$2', [id, projectId]);
      if (!cur) throw new HttpError(404, 'Change order not found.');
      const merged = { status: cur.status, approved_date: cur.approved_date, ...v };
      needApprovedDate(merged);
      if (v.project_trade_id) { const own = await t('SELECT 1 FROM project_trades WHERE id=$1 AND project_id=$2', [v.project_trade_id, projectId]); if (!own.length) throw bad('That trade is not on this project.'); }
      const keys = Object.keys(v); if (!keys.length) throw bad('Nothing to save.');
      await t(`UPDATE change_orders SET ${keys.map((k, i) => `${k}=$${i + 3}`).join(',')} WHERE id=$1 AND project_id=$2`, [id, projectId, ...keys.map((k) => v[k])]);
      for (const ptId of new Set([cur.project_trade_id, v.project_trade_id].filter(Boolean))) {
        const tr = (await loadInputsWith(t, projectId)).find((x) => x.ptId === ptId);
        const errs = validateTrade(tr.input); if (errs.length) throw bad(errs[0]);
      }
    });
  } catch (e) { throw e.code === '23505' ? new HttpError(409, 'That CO # is already used on this project.') : e; }
}
export async function deleteChangeOrder(projectId, id) {
  await tx(async (t) => {
    const [cur] = await t('DELETE FROM change_orders WHERE id=$1 AND project_id=$2 RETURNING project_trade_id', [id, projectId]);
    if (!cur) throw new HttpError(404, 'Change order not found.');
    const tr = (await loadInputsWith(t, projectId)).find((x) => x.ptId === cur.project_trade_id);
    const errs = tr ? validateTrade(tr.input) : []; if (errs.length) throw bad(errs[0]);
  });
}
export async function dashboard(user, manageAll) {
  const rows = await listProjects(user, manageAll);
  const active = rows.filter((r) => r.active);
  const sum = (k) => Math.round(active.reduce((n, r) => n + Math.round((r[k] ?? 0) * 100), 0)) / 100;
  const byGc = new Map();
  for (const r of active) {
    const g = byGc.get(r.gc) ?? { gc: r.gc, projects: 0, contract: 0, currentlyDue: 0, projectedProfit: 0 };
    g.projects++; g.contract = Math.round((g.contract + r.contract) * 100) / 100; g.currentlyDue = Math.round((g.currentlyDue + r.currentlyDue) * 100) / 100; g.projectedProfit = Math.round((g.projectedProfit + r.projectedProfit) * 100) / 100;
    byGc.set(r.gc, g);
  }
  const contract = sum('contract'), profit = sum('projectedProfit');
  return {
    activeProjects: active.length, contract, billed: sum('billed'), received: sum('received'), totalOwed: sum('totalOwed'), currentlyDue: sum('currentlyDue'),
    retainageOutstanding: sum('retainageOutstanding'), totalPayable: sum('totalPayable'), projectedProfit: profit, marginPct: contract > 0 ? Math.round((profit / contract) * 10000) / 100 : null,
    byGc: [...byGc.values()].sort((a, b) => b.contract - a.contract),
  };
}
