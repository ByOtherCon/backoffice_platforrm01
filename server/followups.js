// Follow Ups: one case per submitted bid version. Emails and calls are logged by a person (sending is manual for now).
// The schedule, the pause and stop rules, and the message templates follow the approved Submittal Follow-Up workflow.
import { q, tx } from './db.js';
import { bad, text, dateStr, HttpError } from './http.js';
import * as E from '../src/lib/estimating.ts';
import * as W from '../src/lib/workflow.ts';
import { loadAll, addNote, transition } from './estimating.js';
import { notifyUser } from './compliance.js';
import { createTodo } from './messaging.js';

const who = (u) => u?.name || u?.email || 'the system';
const sys = (t, id, user, body) => addNote(t, id, user, 'System', body);
const ACTIVE_STOPPED = ['Superseded', 'Closed / Awarded', 'Not Selected / Not Won'];

async function ctxFor(o, user) {
  const [est] = o.estimatorId ? await q('SELECT name, phone FROM app_users WHERE id=$1', [o.estimatorId]) : [null], last = o.lastSubmission;
  return { project: o.name, address: W.addrLine({ street: o.address, city: o.city, state: 'FL', zip: o.zip }), proposalId: o.proposalId || '', submittedDate: last?.date || '', trades: (last?.trades || []).map((x) => x.name).join(', '),
    gcContact: o.contact || '', estimator: est?.name || '', estimatorPhone: est?.phone || '', caller: user?.name || '', callerPhone: user?.id ? (await q('SELECT phone FROM app_users WHERE id=$1', [user.id]))[0]?.phone || '' : '' };
}
const summary = (o) => ({ id: o.id, name: o.name, proposalId: o.proposalId, gc: o.gc, contact: o.contact, email: o.email, phone: o.phone, address: W.addrLine({ street: o.address, city: o.city, state: 'FL', zip: o.zip }), estimator: o.estimator,
  version: o.lastSubmission.version, submittedDate: o.lastSubmission.date, price: o.lastSubmission.price, trades: (o.lastSubmission.trades || []).map((x) => x.name), plannedStart: o.plannedStart, oppStatus: o.status, ...o.followup });

const FILTERS = ['Action Needed', 'Due Now', 'Active', 'Waiting', 'Closed', 'All'];
export async function list({ filter } = {}) {
  await closeDueCases();
  const today = E.todayEastern(), rows = (await loadAll()).filter((o) => o.lastSubmission && o.followup).map(summary);
  const isClosed = (r) => ['Closed / No Response', 'Closed / Awarded', 'Not Selected / Not Won', 'Superseded'].includes(r.status);
  const pick = { 'Action Needed': (r) => r.status === 'Replied / Action Needed' || r.status === 'Needs Schedule Review', 'Due Now': (r) => r.status === 'Active' && r.due && r.due <= today, Active: (r) => r.status === 'Active', Waiting: (r) => ['Paused', 'Awaiting GC Award', 'Selected / Awaiting Contract'].includes(r.status), Closed: isClosed, All: () => true }[FILTERS.includes(filter) ? filter : 'Active'];
  const counts = Object.fromEntries(FILTERS.map((f) => [f, rows.filter({ 'Action Needed': (r) => r.status === 'Replied / Action Needed' || r.status === 'Needs Schedule Review', 'Due Now': (r) => r.status === 'Active' && r.due && r.due <= today, Active: (r) => r.status === 'Active', Waiting: (r) => ['Paused', 'Awaiting GC Award', 'Selected / Awaiting Contract'].includes(r.status), Closed: isClosed, All: () => true }[f]).length]));
  const out = rows.filter(pick).filter((r) => r.status !== 'Superseded' || filter === 'All' || filter === 'Closed').sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));
  return { rows: out, counts, filter: FILTERS.includes(filter) ? filter : 'Active' };
}
export async function get(user, id) {
  const [o] = await loadAll('WHERE o.id=$1', [id]); if (!o) throw new HttpError(404, 'Opportunity not found.'); if (!o.lastSubmission) throw new HttpError(404, 'This opportunity has no submitted proposal, so there is nothing to follow up.');
  const last = o.lastSubmission, log = o.communications.filter((c) => c.cycle === last.id), today = E.todayEastern();
  const plan = W.followupPlan(last.date, log.map((c) => ({ kind: c.kind, date: c.date })), { startDate: o.plannedStart, today });
  const people = await q('SELECT c.id, c.kind, c.comm_date, c.note, c.outcome, c.created_at, u.name AS who FROM communications c LEFT JOIN app_users u ON u.id=c.user_id WHERE c.opportunity_id=$1 ORDER BY c.comm_date DESC, c.created_at DESC', [id]);
  return { ...summary(o), caseId: o.followup.caseId, steps: plan.steps, cutoff: plan.cutoff, drafts: W.followupDrafts(await ctxFor(o, user)), notePrefill: null,
    history: people.map((p) => ({ id: p.id, kind: p.kind, date: p.comm_date, note: p.note, outcome: p.outcome, who: p.who, at: p.created_at, cycle: p.cycle })), versions: o.submissions.map((s) => ({ version: s.version, date: s.date, price: s.price })), nextCheck: o.followup.nextCheck };
}

async function theCase(t, id) {
  const [o] = await t('SELECT * FROM opportunities WHERE id=$1 FOR UPDATE', [id]); if (!o) throw new HttpError(404, 'Opportunity not found.');
  const [s] = await t('SELECT * FROM submissions WHERE opportunity_id=$1 AND voided_at IS NULL ORDER BY version DESC LIMIT 1', [id]); if (!s) throw bad('Submit the proposal before logging follow-up.');
  const [c] = await t('SELECT * FROM followup_cases WHERE submission_id=$1 FOR UPDATE', [s.id]); if (!c) throw new HttpError(404, 'No follow-up case for this bid version.');
  return { o, s, c };
}
// Log something that really happened. A missed call or an unsent email is not logged.
export async function logActivity(user, id, b) {
  const kind = String(b.kind || ''); if (!['First Email Sent', 'Call 1', 'Call 2', 'Final Email Sent', 'Reply Received', 'Note'].includes(kind)) throw bad('Choose what happened.');
  const date = dateStr(b.date, 'Date', true), today = E.todayEastern(); if (date > today) throw bad('Log it when it has happened, not before.');
  const note = text(b.note, 'Note', { max: 500, required: kind === 'Note' });
  const outcome = b.outcome || null; if (kind.startsWith('Call')) { if (!['Answered', 'No Answer', 'Voicemail Left', 'No Voicemail Available'].includes(outcome)) throw bad('Record how the call went: answered, no answer, voicemail left, or no voicemail available.'); }
  else if (outcome) throw bad('Only calls have an outcome.');
  return tx(async (t) => {
    const { o, s, c } = await theCase(t, id);
    if (date < s.submitted_date) throw bad('That is before the proposal was submitted.');
    const log = await t('SELECT kind, comm_date::text AS date FROM communications WHERE submission_id=$1', [s.id]); const has = (k) => log.find((l) => l.kind === k);
    if (!['Reply Received', 'Note'].includes(kind)) {
      if (ACTIVE_STOPPED.includes(c.status) || c.status === 'Closed / No Response') throw new HttpError(409, 'This follow-up is closed.');
      if (c.status !== 'Active') throw new HttpError(409, `Outreach is paused (${c.status}). Resume it first.`);
      if (has(kind)) throw new HttpError(409, `${kind} was already logged for this bid version.`);
      if (kind === 'Call 1' && !has('First Email Sent')) throw bad('Send and log the first email before the first call.');
      if (kind === 'Call 2') { const c1 = has('Call 1'); if (!c1) throw bad('Log the first call before the second.'); if (date < E.addBusinessDays(c1.date, 2)) throw bad(`Call 2 is at least two business days after Call 1 (${E.addBusinessDays(c1.date, 2)} or later).`); }
      if (kind === 'Final Email Sent' && !has('Call 2')) throw bad('Complete and log the second call before the final email.');
      if (kind === 'First Email Sent' && !o.contact_email) throw bad('Add the GC contact email on the opportunity first. Nothing is sent without it.');
    }
    await t('INSERT INTO communications(opportunity_id,submission_id,kind,comm_date,note,outcome,user_id) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, s.id, kind, date, note || null, outcome, user.id]);
    await t('UPDATE followup_cases SET next_check=NULL, updated_at=now() WHERE id=$1', [c.id]);
    let line = `${kind} logged by ${who(user)} for ${date}${outcome ? ` (${outcome})` : ''}.`;
    if (kind === 'Reply Received' && !ACTIVE_STOPPED.includes(c.status)) { await t(`UPDATE followup_cases SET status='Replied / Action Needed', updated_at=now() WHERE id=$1`, [c.id]); line += ' Outreach paused; the reply needs a response.'; if (o.estimator_id && o.estimator_id !== user.id) await notifyUser(o.estimator_id, { kind: 'followup', title: `Reply from ${o.gc_name}`, body: o.name, link: `#/estimating/followups/${id}`, dedupe: `reply:${s.id}:${date}` }); }
    if (kind.startsWith('Call') && outcome === 'Answered' && !note) throw bad('Add what was said on the call. An answered call usually changes the plan.');
    await sys(t, id, user, line);
    return { ok: true };
  });
}
// What the GC said, in the workflow's own terms.
export async function classify(user, id, b) {
  const resp = String(b.response || ''), note = text(b.note, 'Note', { max: 500, required: false });
  if (resp === 'Not Selected') { if (!(await q('SELECT 1 FROM submissions WHERE opportunity_id=$1', [id])).length) throw bad('Nothing was submitted.'); await transition(user, id, { status: 'Not Awarded', reason: b.reason, note }); return { ok: true }; }
  const result = await tx(async (t) => {
    const { o, c } = await theCase(t, id), today = E.todayEastern();
    if (ACTIVE_STOPPED.includes(c.status)) throw new HttpError(409, 'This follow-up is already closed.');
    if (resp === 'Awaiting GC Award') {
      const d = dateStr(b.nextCheck, 'Next check date', true); const cut = o.planned_start ? W.subBusinessDays(o.planned_start, 4) : null;
      if (d < today) throw bad('Pick a check date that has not passed.'); if (cut && d > cut) throw bad(`The next check must be on or before ${cut}, four business days before the project starts.`);
      await t(`UPDATE followup_cases SET status='Awaiting GC Award', next_check=$2, updated_at=now() WHERE id=$1`, [c.id, d]); await sys(t, id, user, `GC says it is not yet awarded. Outreach paused; next check ${d}. Set by ${who(user)}.`); return {};
    }
    if (resp === 'Selected') {
      await t(`UPDATE followup_cases SET status='Selected / Awaiting Contract', next_check=NULL, updated_at=now() WHERE id=$1`, [c.id]);
      await sys(t, id, user, `GC selected byOther. Pursuit emails stopped. Obtain and confirm the issued contract before creating the project. Set by ${who(user)}.`); return { todo: { title: `Get the issued contract: ${o.name} (${o.gc_name})`, assignee: o.estimator_id } };
    }
    if (resp === 'Needs Response') { await t(`UPDATE followup_cases SET status='Replied / Action Needed', updated_at=now() WHERE id=$1`, [c.id]); await sys(t, id, user, `Marked Replied / Action Needed by ${who(user)}.`); return {}; }
    throw bad('Choose what the GC said.');
  });
  if (result.todo) await createTodo(user, { title: result.todo.title, assignedToId: result.todo.assignee || user.id, links: [{ kind: 'opportunity', id }] });
  if (note) await addUser(user, id, note);
  return { ok: true };
}
const addUser = (user, id, body) => tx((t) => addNote(t, id, user, 'User', body));
export async function pause(user, id, b = {}) {
  await tx(async (t) => { const { c } = await theCase(t, id); if (c.status !== 'Active') throw new HttpError(409, `This follow-up is ${c.status}.`);
    await t(`UPDATE followup_cases SET status='Paused', updated_at=now() WHERE id=$1`, [c.id]); await sys(t, id, user, `Follow-up paused by ${who(user)}.${b.note ? ' ' + text(b.note, 'Note', { max: 300 }) : ''}`); });
}
// Resuming needs a chosen next date (not past, and inside the start-date cutoff). The log is kept and completed steps are never resent.
export async function resume(user, id, b = {}) {
  await tx(async (t) => {
    const { o, c } = await theCase(t, id), today = E.todayEastern();
    if (!['Paused', 'Awaiting GC Award', 'Replied / Action Needed', 'Needs Schedule Review', 'Closed / No Response'].includes(c.status)) throw new HttpError(409, `This follow-up is ${c.status}.`);
    const d = dateStr(b.nextCheck, 'Next action date', true), cut = o.planned_start ? W.subBusinessDays(o.planned_start, 4) : null;
    if (d < today) throw bad('Pick a date that has not passed.'); if (E.isWeekend(d)) throw bad('Outreach happens Monday to Friday. Pick a weekday.'); if (cut && d > cut) throw bad(`The next action must be on or before ${cut}, four business days before the project starts.`);
    await t(`UPDATE followup_cases SET status='Active', next_check=$2, updated_at=now() WHERE id=$1`, [c.id, d]); await sys(t, id, user, `Follow-up resumed by ${who(user)}; next action ${d}. Earlier steps are not repeated.`);
  });
}

// Run on a timer and whenever the list is opened.
export async function closeDueCases() {
  const today = E.todayEastern(); let closed = 0;
  const cases = await q(`SELECT c.id, c.opportunity_id, c.submission_id, c.next_check FROM followup_cases c WHERE c.status='Active'`);
  for (const c of cases) {
    const [s] = await q('SELECT submitted_date::text AS d FROM submissions WHERE id=$1', [c.submission_id]); const [o] = await q('SELECT planned_start::text AS ps, estimator_id, name FROM opportunities WHERE id=$1', [c.opportunity_id]); if (!s) continue;
    const log = (await q('SELECT kind, comm_date::text AS date FROM communications WHERE submission_id=$1', [c.submission_id])).map((l) => ({ kind: l.kind, date: l.date }));
    const plan = W.followupPlan(s.d, log, { startDate: o.ps, today });
    if (plan.closeDue) { await tx(async (t) => { await t(`UPDATE followup_cases SET status='Closed / No Response', updated_at=now() WHERE id=$1 AND status='Active'`, [c.id]); await sys(t, c.opportunity_id, null, 'Follow-up closed as No Response: both emails sent, both calls completed, and no human reply two business days after the final email. This is not a loss; the proposal and history are kept.'); }); closed++; }
    else if (plan.needsReview) { await tx(async (t) => { await t(`UPDATE followup_cases SET status='Needs Schedule Review', updated_at=now() WHERE id=$1 AND status='Active'`, [c.id]); await sys(t, c.opportunity_id, null, `Needs Schedule Review: the remaining contacts cannot fit before the cutoff (${plan.cutoff}). Outreach is paused. Choose a feasible plan or confirm a new start date.`); }); if (o.estimator_id) await notifyUser(o.estimator_id, { kind: 'followup', title: 'Follow-up needs a schedule review', body: o.name, link: `#/estimating/followups/${c.opportunity_id}`, dedupe: `review:${c.submission_id}` }); }
  }
  return closed;
}
