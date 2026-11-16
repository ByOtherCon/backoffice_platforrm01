// Text messages (SMS) through Twilio. Nothing is sent until the three Twilio values are on the server; until then every alert is skipped quietly.
// Two alerts run on their own:
//  - Follow-ups: on weekday mornings each estimator gets ONE text listing the follow-ups that are due or overdue.
//  - Still clocked in: in the evening anyone whose clock is still running gets ONE text with the link to clock out.
// Every text, sent or failed, is written to sms_log, which is also how a person never gets the same alert twice in a day.
import { q } from './db.js';
import { HttpError, bad, text } from './http.js';
import { todayEastern } from '../src/lib/estimating.ts';

let tfetch = (u, init = {}) => fetch(u, { signal: AbortSignal.timeout(20000), ...init });
export const setSmsFetch = (f) => { tfetch = f; };   // tests stand in for Twilio
const env = () => ({ sid: process.env.TWILIO_ACCOUNT_SID, token: process.env.TWILIO_AUTH_TOKEN, from: process.env.TWILIO_FROM, service: process.env.TWILIO_MESSAGING_SERVICE_SID });
export const configured = () => { const e = env(); return !!(e.sid && e.token && (e.from || e.service)); };
const site = () => String(process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');

// A U.S. number as typed ("(407) 555-0150", "407.555.0150", "+1 407 555 0150") in the form carriers use, or null when it is not one.
export function usNumber(v) {
  const d = String(v || '').replace(/[^0-9]/g, ''), ten = d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
  return ten.length === 10 && /^[2-9]\d{2}[2-9]\d{6}$/.test(ten) ? '+1' + ten : null;
}

const DEFAULTS = { followups: true, followupsAt: '08:30', clock: true, clockAt: '19:00' };
export async function getSettings() { const [r] = await q(`SELECT value FROM app_settings WHERE key='sms'`); return { ...DEFAULTS, ...(r?.value || {}) }; }
export async function saveSettings(b) {
  const cur = await getSettings(), hm = (v, label) => { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v))) throw bad(`${label} looks like 08:30.`); return String(v); };
  const next = { followups: b.followups === undefined ? cur.followups : !!b.followups, followupsAt: b.followupsAt === undefined ? cur.followupsAt : hm(b.followupsAt, 'The follow-up time'), clock: b.clock === undefined ? cur.clock : !!b.clock, clockAt: b.clockAt === undefined ? cur.clockAt : hm(b.clockAt, 'The clock reminder time') };
  await q(`INSERT INTO app_settings(key,value) VALUES ('sms',$1) ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=now()`, [next]); return next;
}

// Sends one text and records it. Returns { sent, error }. A number that is not a U.S. mobile-looking number is recorded as skipped, not sent.
export async function send(to, body, { kind = 'Other', userId = null, employeeId = null, day = null } = {}) {
  const num = usNumber(to), msg = String(body || '').slice(0, 600);
  const log = (status, error = null, sidOut = null) => q('INSERT INTO sms_log(to_number, body, kind, status, error, provider_id, user_id, employee_id, alert_day) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [num || String(to || '').slice(0, 40), msg, kind, status, error, sidOut, userId, employeeId, day]);
  if (!num) { await log('Skipped', 'Not a 10-digit U.S. number.'); return { sent: false, error: 'Not a 10-digit U.S. number.' }; }
  if (!configured()) { await log('Skipped', 'Text messages are not set up on the server.'); return { sent: false, error: 'Text messages are not set up on the server.' }; }
  const e = env(), form = new URLSearchParams({ To: num, Body: msg, ...(e.service ? { MessagingServiceSid: e.service } : { From: e.from }) });
  try {
    const r = await tfetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(e.sid)}/Messages.json`, { method: 'POST', headers: { authorization: 'Basic ' + Buffer.from(`${e.sid}:${e.token}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const why = j.code === 21610 ? 'This number replied STOP, so it cannot be texted until it replies START.' : j.code === 21211 || j.code === 21614 ? 'Twilio says this is not a mobile number that can get texts.' : `Twilio refused it (${r.status}${j.code ? ', code ' + j.code : ''})${j.message ? ': ' + String(j.message).slice(0, 160) : ''}`; await log('Failed', why); return { sent: false, error: why }; }
    await log('Sent', null, j.sid ?? null); return { sent: true, error: null };
  } catch { await log('Failed', 'Twilio could not be reached.'); return { sent: false, error: 'Twilio could not be reached.' }; }
}
const already = async (kind, day, { userId = null, employeeId = null }) => (await q(`SELECT 1 FROM sms_log WHERE kind=$1 AND alert_day=$2 AND status IN ('Sent','Failed') AND user_id IS NOT DISTINCT FROM $3 AND employee_id IS NOT DISTINCT FROM $4 LIMIT 1`, [kind, day, userId, employeeId])).length > 0;

// ---- follow-ups that are due or overdue: one text per estimator per day
export async function followupAlerts(today = todayEastern()) {
  if (!configured() || !(await getSettings()).followups) return { sent: 0 };
  const { loadAll } = await import('./estimating.js');
  const due = (await loadAll()).filter((o) => o.followup && o.estimatorId && ((o.followup.status === 'Active' && o.followup.due && o.followup.due <= today) || o.followup.status === 'Replied / Action Needed'));
  const by = new Map(); for (const o of due) (by.get(o.estimatorId) ?? by.set(o.estimatorId, []).get(o.estimatorId)).push(o);
  let sent = 0;
  for (const [userId, list] of by) {
    const [u] = await q('SELECT id, phone FROM app_users WHERE id=$1 AND active', [userId]); if (!u || !usNumber(u.phone) || (await already('Follow-ups', today, { userId }))) continue;
    const names = list.slice(0, 4).map((o) => `${o.name} (${o.gc})`).join('; ');
    const r = await send(u.phone, `byOther: ${list.length} follow-up${list.length === 1 ? ' is' : 's are'} due today or overdue: ${names}${list.length > 4 ? `, and ${list.length - 4} more` : ''}. ${site()}/#/estimating/followups`, { kind: 'Follow-ups', userId, day: today });
    if (r.sent) sent++;
  }
  return { sent };
}
// ---- still clocked in: one text per person per day
export async function clockAlerts(today = todayEastern()) {
  if (!configured() || !(await getSettings()).clock) return { sent: 0 };
  const rows = await q(`SELECT e.id, e.name, e.phone, p.name AS project, to_char(t.clock_in AT TIME ZONE 'America/New_York', 'FMHH12:MI AM') AS since FROM time_entries t JOIN employees e ON e.id=t.employee_id JOIN projects p ON p.id=t.project_id
    WHERE t.status='open' AND t.clock_out IS NULL AND e.active ORDER BY t.clock_in`);
  let sent = 0; const seen = new Set();
  for (const e of rows) {
    if (seen.has(e.id) || !usNumber(e.phone) || (await already('Still clocked in', today, { employeeId: e.id }))) continue; seen.add(e.id);
    const r = await send(e.phone, `byOther: ${e.name.split(' ')[0]}, your time clock is still running at ${e.project} since ${e.since}. Clock out here: ${site()}/clock  If you already left, tell the office.`, { kind: 'Still clocked in', employeeId: e.id, day: today });
    if (r.sent) sent++;
  }
  return { sent };
}

// ---- the schedule: checked every minute, each alert once a day after its time (follow-ups on weekdays only)
const hmEastern = (d = new Date()) => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit', weekday: 'short' }).formatToParts(d).map((x) => [x.type, x.value])); return { hm: `${p.hour === '24' ? '00' : p.hour}:${p.minute}`, weekday: !['Sat', 'Sun'].includes(p.weekday) }; };
export async function tick(now = new Date()) {
  if (!configured()) return { ran: [] };
  const s = await getSettings(), { hm, weekday } = hmEastern(now), today = todayEastern(now), [r] = await q(`SELECT value FROM app_settings WHERE key='sms_runs'`), runs = r?.value || {}, ran = [];
  const mark = async (k) => { runs[k] = today; await q(`INSERT INTO app_settings(key,value) VALUES ('sms_runs',$1) ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=now()`, [runs]); ran.push(k); };
  if (s.followups && weekday && hm >= s.followupsAt && runs.followups !== today) { await mark('followups'); await followupAlerts(today).catch((e) => console.error('follow-up texts', e.message)); }
  if (s.clock && hm >= s.clockAt && runs.clock !== today) { await mark('clock'); await clockAlerts(today).catch((e) => console.error('clock texts', e.message)); }
  return { ran };
}
export function startScheduler() { setInterval(() => tick().catch((e) => console.error('sms tick', e.message)), 60000); }

// ---- what Admin shows
export async function status() {
  const e = env(), s = await getSettings();
  const recent = await q(`SELECT l.created_at, l.to_number, l.kind, l.status, l.error, COALESCE(u.name, em.name) AS who FROM sms_log l LEFT JOIN app_users u ON u.id=l.user_id LEFT JOIN employees em ON em.id=l.employee_id ORDER BY l.created_at DESC LIMIT 15`);
  const [{ n: users }] = await q(`SELECT count(*)::int AS n FROM app_users WHERE active AND phone IS NOT NULL AND phone <> ''`), [{ n: crew }] = await q(`SELECT count(*)::int AS n FROM employees WHERE active AND phone IS NOT NULL AND phone <> ''`);
  return { configured: configured(), needs: [['TWILIO_ACCOUNT_SID', e.sid], ['TWILIO_AUTH_TOKEN', e.token], ['TWILIO_FROM', e.from || e.service]].filter((x) => !x[1]).map((x) => x[0]), from: e.service ? 'a messaging service' : e.from || null, settings: s, usersWithPhone: users, crewWithPhone: crew,
    recent: recent.map((r) => ({ at: r.created_at, to: String(r.to_number).replace(/\d(?=\d{4})/g, '•'), kind: r.kind, status: r.status, error: r.error, who: r.who })) };
}
export async function sendTest(user, b) {
  if (!configured()) throw new HttpError(503, 'Text messages are not set up on the server yet.');
  const to = text(b.to, 'Mobile number', { max: 40 }); if (!usNumber(to)) throw bad('Enter a 10-digit U.S. mobile number.');
  const r = await send(to, `byOther Desk Platform: this is a test text sent by ${user.name || user.email}. Texts are working.`, { kind: 'Test', userId: user.id });
  if (!r.sent) throw new HttpError(502, r.error); return { ok: true };
}
