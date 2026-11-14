import nodemailer from 'nodemailer';
import { sendMail, canSendMail, baseUrl } from './bids.js';
import { q, tx } from './db.js';
import { bad, text, dateStr, httpsUrl, HttpError } from './http.js';
import { MANAGE } from './auth.js';
import { evaluate, stageFor, addressChecks, addrKey } from '../src/lib/compliance.ts';

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const DOC_COL = { 'W-9': 'w9_document_id', COI: 'coi_document_id', Exemption: 'exemption_document_id' };

// ------------------------------------------------------------------ vendor documents and status
const SELECT = `SELECT s.id, s.name, s.email, s.archived, s.verified_override, s.address AS a_street, s.city AS a_city, s.state AS a_state, s.zip AS a_zip, s.address_verified, s.address_confirmed_key, s.address_confirmed_at, s.folder_url, w.read_address AS w9_read, w.read_name AS w9_read_name, c.read_address AS coi_read, c.read_policies AS coi_policies, x.read_policies AS ex_policies, w.id AS w9_id, w.name AS w9_name, w.url AS w9_url, w.storage_key AS w9_key,
    c.id AS coi_id, c.name AS coi_name, c.url AS coi_url, c.storage_key AS coi_key, c.expires_on AS coi_expires,
    x.id AS ex_id, x.name AS ex_name, x.url AS ex_url, x.storage_key AS ex_key, x.expires_on AS ex_expires
  FROM subcontractors s LEFT JOIN documents w ON w.id=s.w9_document_id LEFT JOIN documents c ON c.id=s.coi_document_id LEFT JOIN documents x ON x.id=s.exemption_document_id`;
const shape = (r, asOf) => {
  const ev = evaluate({ w9: !!r.w9_id, coi: { present: !!r.coi_id, expires: r.coi_expires }, exemption: { present: !!r.ex_id, expires: r.ex_expires } }, asOf);
  const addr = { street: r.a_street, city: r.a_city, state: r.a_state, zip: r.a_zip }, ac = addressChecks({ ...addr, verified: !!r.address_verified, confirmedKey: r.address_confirmed_key }, r.w9_read);
  // verified = a W-9 and unexpired insurance (or exemption) on file, or the owner verified it by hand. Only a verified subcontractor can be paid.
  // (Address and W-9 matching is for the 1099 information, not for payment.)
  const verified = ev.canPay || !!r.verified_override, blockers = verified ? [] : ev.reasons;
  return { id: r.id, name: r.name, email: r.email, archived: r.archived, ...ev, docsOk: ev.canPay, canPay: verified, verified, override: !!r.verified_override && !ev.canPay, blockers, addressMatch: ac.match, address: addr, addressChecked: !!r.address_verified, folderUrl: r.folder_url ?? null,
    addressOnDocs: { w9: r.w9_read ?? null, w9Name: r.w9_read_name ?? null, coi: r.coi_read ?? null }, confirmedAt: ac.match === 'Confirmed' ? r.address_confirmed_at : null,
    docs: { 'W-9': r.w9_id ? { id: r.w9_id, name: r.w9_name, url: r.w9_url, file: !!r.w9_key } : null, COI: r.coi_id ? { id: r.coi_id, name: r.coi_name, url: r.coi_url, file: !!r.coi_key, expires: r.coi_expires, policies: r.coi_policies ?? null } : null, Exemption: r.ex_id ? { id: r.ex_id, name: r.ex_name, url: r.ex_url, file: !!r.ex_key, expires: r.ex_expires, policies: r.ex_policies ?? null } : null } };
};
export async function vendorCompliance(asOf = today()) {
  const rows = (await q(`${SELECT} ORDER BY s.name`)).map((r) => shape(r, asOf));
  const active = await q(`SELECT sc.subcontractor_id, array_agg(DISTINCT p.name) AS projects FROM sub_commitments sc JOIN projects p ON p.id=sc.project_id WHERE p.active GROUP BY sc.subcontractor_id`);
  return rows.map((r) => ({ ...r, activeProjects: active.find((a) => a.subcontractor_id === r.id)?.projects ?? [] }));
}
export async function setVendorDoc(subId, b) {
  const category = b.category; if (!DOC_COL[category]) throw bad('Choose W-9, COI, or Exemption.');
  const expires = dateStr(b.expiresOn, 'Expiration date', category === 'COI');
  const url = httpsUrl(b.url, 'Document link'); const key = b.storageKey ? text(b.storageKey, 'File', { max: 200 }) : null;
  if (!url && !key) throw bad('Add a document link or upload a file.');
  return tx(async (t) => {
    if (!(await t('SELECT 1 FROM subcontractors WHERE id=$1', [subId])).length) throw new HttpError(404, 'Vendor not found.');
    const [d] = await t('INSERT INTO documents(category,name,url,storage_key,expires_on) VALUES ($1,$2,$3,$4,$5) RETURNING id', [category, text(b.name, 'Name', { max: 200, required: false }) || `${category} document`, url, key, expires]);
    await t(`UPDATE subcontractors SET ${DOC_COL[category]}=$2 WHERE id=$1`, [subId, d.id]);
    return { id: d.id };
  });
}
export async function clearVendorDoc(subId, category) {
  if (!DOC_COL[category]) throw bad('Choose W-9, COI, or Exemption.');
  const r = await q(`UPDATE subcontractors SET ${DOC_COL[category]}=NULL WHERE id=$1 RETURNING id`, [subId]);
  if (!r.length) throw new HttpError(404, 'Vendor not found.');
}
// Used by every payment path: no W-9 + valid insurance, no payment.
// allowUnverified: the Super Admin has said to go ahead anyway. Returns what was bypassed (so the payment can note it), or null.
export async function assertCanPay(t, subcontractorId, asOf = today(), { allowUnverified = false } = {}) {
  const [r] = await t(`${SELECT} WHERE s.id=$1`, [subcontractorId]); if (!r) throw bad('Vendor not found.');
  const v = shape(r, asOf);
  if (!v.canPay && allowUnverified) return { name: v.name, blockers: v.blockers };
  if (!v.canPay) throw new HttpError(409, `${v.name} is an unverified subcontractor and cannot be paid: ${v.blockers.join('; ')}.`);
}

// ------------------------------------------------------------------ notifications and email outbox
export async function notifyRoles(roles, { kind, title, body, link, dedupe }) {
  const users = await q('SELECT id FROM app_users WHERE active AND role = ANY($1::text[])', [roles]);
  let n = 0;
  for (const u of users) n += (await q(`INSERT INTO notifications(user_id,kind,title,body,link,dedupe_key) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (user_id, dedupe_key) DO NOTHING RETURNING id`, [u.id, kind, title, body ?? null, link ?? null, dedupe ?? null])).length;
  return n;
}
export const notifyUser = (userId, { kind, title, body, link, dedupe }) => q(`INSERT INTO notifications(user_id,kind,title,body,link,dedupe_key) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (user_id, dedupe_key) DO NOTHING`, [userId, kind, title, body ?? null, link ?? null, dedupe ?? null]);
export const listNotifications = (userId) => q('SELECT id, kind, title, body, link, created_at, read_at FROM notifications WHERE user_id=$1 AND cleared_at IS NULL ORDER BY (read_at IS NULL) DESC, created_at DESC LIMIT 60', [userId]);
// Housekeeping: old sessions, sign-in attempt records and cleared alerts are not kept forever.
export async function purgeOld() {
  await q(`DELETE FROM sessions WHERE expires_at < now() - interval '1 day'`);
  await q(`DELETE FROM login_attempts WHERE attempted_at < now() - interval '30 days'`);
  await q(`DELETE FROM notifications WHERE cleared_at IS NOT NULL AND cleared_at < now() - interval '180 days'`);
  await q(`DELETE FROM email_outbox WHERE kind='user_alert' AND created_at < now() - interval '90 days'`);
}
export const markRead = (userId, ids) => ids === 'all' ? q('UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL', [userId]) : q('UPDATE notifications SET read_at=now() WHERE user_id=$1 AND id = ANY($2::uuid[])', [userId, ids]);
// Clearing hides an alert for good (the row stays so the same alert is not raised again).
export const clearNotifications = (userId, ids) => ids === 'all' ? q(`UPDATE notifications SET cleared_at=now(), read_at=COALESCE(read_at, now()) WHERE user_id=$1 AND cleared_at IS NULL`, [userId]) : q(`UPDATE notifications SET cleared_at=now(), read_at=COALESCE(read_at, now()) WHERE user_id=$1 AND id = ANY($2::uuid[])`, [userId, ids]);

export async function queueEmail({ to, subject, body, kind, relatedId, dedupe }) {
  return (await q(`INSERT INTO email_outbox(to_email,subject,body,kind,related_id,dedupe_key) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`, [to, subject, body, kind ?? null, relatedId ?? null, dedupe ?? null])).length;
}
let transport = null;
export const setTransport = (t) => { transport = t; };
const getTransport = () => transport ?? (process.env.SMTP_URL ? (transport = nodemailer.createTransport(process.env.SMTP_URL)) : null);
export const emailConnected = () => !!getTransport();
// Sends what is waiting. Alerts to our own people (a new message, a to-do from someone else) go out through the connected Gmail mailbox,
// or through SMTP when that is what is set up. Emails to vendors go through SMTP only, exactly as before.
// Each email is claimed before it is sent, so two runs at the same moment never send it twice.
export async function sendQueued({ only } = {}) {
  const t = getTransport(), gmail = await canSendMail().catch(() => false);
  if (!t && !gmail) return { sent: 0, failed: 0, connected: false };
  let sent = 0, failed = 0;
  const rows = await q(`SELECT * FROM email_outbox WHERE status='Queued' AND ($1::text IS NULL OR kind=$1) AND ($2::boolean OR kind='user_alert') ORDER BY created_at LIMIT 50`, [only ?? null, !!t]);
  for (const m of rows) {
    if (!(await q(`UPDATE email_outbox SET status='Sent', sent_at=now(), error=NULL WHERE id=$1 AND status='Queued' RETURNING id`, [m.id])).length) continue;
    try {
      if (m.kind === 'user_alert' && gmail) await sendMail({ to: m.to_email, subject: m.subject, text: m.body });
      else await t.sendMail({ from: process.env.EMAIL_FROM || 'ByOther Construction <no-reply@byother.net>', to: m.to_email, subject: m.subject, text: m.body });
      sent++;
    } catch (e) { await q(`UPDATE email_outbox SET status='Failed', sent_at=NULL, error=$2 WHERE id=$1`, [m.id, String(e.message).slice(0, 300)]); failed++; }
  }
  return { sent, failed, connected: true };
}
// An email to one of our own people about something sent to them in the app. Queued (once per event and person) and sent straight away in the
// background; if it cannot go out now it stays in the outbox and goes with the next run. Never slows down or fails the action that caused it.
export async function emailUser(userId, { subject, text, dedupe }) {
  try {
    const [u] = await q('SELECT email, name FROM app_users WHERE id=$1 AND active', [userId]); if (!u?.email) return 0;
    let link = ''; try { link = baseUrl(); } catch { /* the server does not know its address: the email goes without a link */ }
    const body = `Hello${u.name ? ' ' + u.name : ''},\n\n${text(link)}\n\nThis email was sent by by Other Desk Platform because it was addressed to you there.\n`;
    const n = await queueEmail({ to: u.email, subject: String(subject).replace(/\s+/g, ' ').slice(0, 200), body, kind: 'user_alert', relatedId: userId, dedupe });
    if (n) sendQueued({ only: 'user_alert' }).catch((e) => console.error('alert email not sent:', e.message));
    return n;
  } catch (e) { console.error('alert email not queued:', e.message); return 0; }
}
// The outbox list on the Compliance page is the email to subcontractors; alerts to our own people (which carry message subjects) are not shown there.
export const listOutbox = () => q(`SELECT id, to_email, subject, status, kind, error, created_at, sent_at FROM email_outbox WHERE kind IS DISTINCT FROM 'user_alert' ORDER BY created_at DESC LIMIT 100`);
// An alert email that failed (Gmail was down) is tried again by the regular check for two days, then left.
export const retryAlerts = () => q(`UPDATE email_outbox SET status='Queued', error=NULL WHERE kind='user_alert' AND status='Failed' AND created_at > now() - interval '2 days'`);
export const retryEmail = (id) => q(`UPDATE email_outbox SET status='Queued', error=NULL WHERE id=$1 AND status='Failed'`, [id]);

// Expiry watch: notify the team, and email the vendor, only while the vendor is on a project that is still active.
export async function scan(asOf = today()) {
  const wk = (() => { const d = new Date(asOf + 'T00:00:00Z'), j = new Date(Date.UTC(d.getUTCFullYear(), 0, 1)); return `${d.getUTCFullYear()}-W${Math.ceil(((d - j) / 86400000 + j.getUTCDay() + 1) / 7)}`; })();
  const vendors = await vendorCompliance(asOf); let notified = 0, emails = 0;
  for (const v of vendors) {
    if (v.archived || !v.activeProjects.length) continue;
    const stage = stageFor(v.daysLeft, v.status); if (!stage) continue;
    const key = `compliance:${v.id}:${stage}:${stage === 'expired' ? wk : v.nextExpiry}`; // expired vendors are re-flagged weekly
    const title = stage === 'expired' ? `${v.name}: insurance has lapsed` : `${v.name}: insurance expires in ${v.daysLeft} day${v.daysLeft === 1 ? '' : 's'}`;
    notified += await notifyRoles(MANAGE, { kind: 'compliance', title, body: `${v.reasons.join('; ') || `Coverage ends ${v.nextExpiry}`}. Active on: ${v.activeProjects.join(', ')}. ${stage === 'expired' ? 'They cannot be paid until a current certificate is on file.' : ''}`.trim(), link: '#/compliance', dedupe: key });
    if (v.email) emails += await queueEmail({ to: v.email, subject: 'Updated certificate of insurance needed - ByOther Construction', kind: 'coi_request', relatedId: v.id, dedupe: key,
      body: `Hello ${v.name},\n\n${stage === 'expired' ? 'Our records show your certificate of insurance (or exemption) has expired' : `Our records show your certificate of insurance (or exemption) expires ${v.nextExpiry}`}. You are currently working on: ${v.activeProjects.join(', ')}.\n\nPlease send an updated certificate${stage === 'expired' ? ' right away so we can continue processing your payments' : ' before it expires'}.\n\nThank you,\nByOther Construction` });
  }
  return { notified, emails };
}

// ------------------------------------------------------------------ Notices to Owner
export const NTO_DAYS = 45; // Florida: serve within 45 days of first furnishing. Confirm with your attorney.
const ntoShape = (r, yearView) => {
  const first = r.first_furnished_eff; const due = first ? new Date(Date.parse(first + 'T00:00:00Z') + NTO_DAYS * 86400000).toISOString().slice(0, 10) : null;
  const t = today(); const daysLeft = due ? Math.round((Date.parse(due + 'T00:00:00Z') - Date.parse(t + 'T00:00:00Z')) / 86400000) : null;
  return { projectId: r.project_id, project: r.project, gc: r.gc, projectActive: r.active, year: r.year, status: r.status, firstFurnished: first, firstFurnishedSet: !!r.first_furnished, due, daysLeft, overdue: r.status === 'Needed' && daysLeft !== null && daysLeft < 0,
    sentDate: r.sent_date, method: r.method, recipient: r.recipient, documentUrl: r.document_url, notes: r.notes, rolledOver: yearView != null && r.year < yearView };
};
const NTO_SQL = `SELECT n.*, p.name AS project, p.active, g.name AS gc, COALESCE(n.first_furnished, (SELECT MIN(work_date) FROM time_entries te WHERE te.project_id=p.id)) AS first_furnished_eff
  FROM project_ntos n JOIN projects p ON p.id=n.project_id JOIN gcs g ON g.id=p.gc_id`;
export async function listNtos(year) {
  const y = Number(year) || Number(today().slice(0, 4));
  const rows = await q(`${NTO_SQL} WHERE n.year = $1 OR (n.year < $1 AND p.active AND n.status = 'Needed') ORDER BY n.status = 'Sent', p.name`, [y]);
  return rows.map((r) => ntoShape(r, y));
}
export async function ntosFor(ids) { if (!ids.length) return []; return (await q(`${NTO_SQL} WHERE n.project_id = ANY($1::uuid[])`, [ids])).map((r) => ntoShape(r)); }
export async function getNto(projectId) { const [r] = await q(`${NTO_SQL} WHERE n.project_id=$1`, [projectId]); return r ? ntoShape(r) : null; }
export async function updateNto(projectId, b) {
  const [cur] = await q('SELECT * FROM project_ntos WHERE project_id=$1', [projectId]); if (!cur) throw new HttpError(404, 'Project not found.');
  const v = {};
  if (b.status !== undefined) { if (!['Needed', 'Sent', 'Not Required'].includes(b.status)) throw bad('Choose a valid status.'); v.status = b.status; }
  if (b.firstFurnished !== undefined) v.first_furnished = dateStr(b.firstFurnished, 'First furnished date');
  if (b.sentDate !== undefined) v.sent_date = dateStr(b.sentDate, 'Sent date');
  if (b.method !== undefined) v.method = text(b.method, 'Method', { max: 100, required: false }) || null;
  if (b.recipient !== undefined) v.recipient = text(b.recipient, 'Recipient', { max: 300, required: false }) || null;
  if (b.documentUrl !== undefined) v.document_url = httpsUrl(b.documentUrl, 'Document link');
  if (b.notes !== undefined) v.notes = text(b.notes, 'Notes', { max: 2000, required: false }) || null;
  if (b.year !== undefined) { const n = Number(b.year); if (!Number.isInteger(n) || n < 2000 || n > 2100) throw bad('Enter a valid year.'); v.year = n; }
  const m = { ...cur, ...v }; if (m.status === 'Sent' && !m.sent_date) throw bad('Enter the date the notice was sent.');
  const keys = Object.keys(v); if (!keys.length) throw bad('Nothing to save.');
  await q(`UPDATE project_ntos SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(',')}, updated_at=now() WHERE project_id=$1`, [projectId, ...keys.map((k) => v[k])]);
}
// Remind the team about notices that are close to (or past) their deadline.
export async function scanNtos(asOf = today()) {
  let n = 0;
  for (const r of await listNtos(Number(asOf.slice(0, 4)))) {
    if (r.status !== 'Needed' || !r.projectActive || r.daysLeft === null || r.daysLeft > 10) continue;
    n += await notifyRoles(MANAGE, { kind: 'nto', title: r.overdue ? `Notice to Owner overdue: ${r.project}` : `Notice to Owner due in ${r.daysLeft} day${r.daysLeft === 1 ? '' : 's'}: ${r.project}`, body: `First furnished ${r.firstFurnished}; deadline ${r.due}.`, link: `#/projects/${r.projectId}/docs`, dedupe: `nto:${r.projectId}:${r.overdue ? 'overdue' : 'soon'}` });
  }
  return n;
}

// A person compared the address on the documents with the subcontractor's address and says they are the same. It stands only while the address stays as it was.
export async function confirmAddress(subId, userId, confirm = true) {
  const [r] = await q('SELECT address, city, state, zip, address_verified FROM subcontractors WHERE id=$1', [subId]); if (!r) throw new HttpError(404, 'Subcontractor not found.');
  if (!confirm) { await q('UPDATE subcontractors SET address_confirmed_key=NULL, address_confirmed_by=NULL, address_confirmed_at=NULL WHERE id=$1', [subId]); return; }
  if (!r.address_verified || !r.address || !r.city || !r.state || !r.zip) throw bad('Verify the subcontractor\'s address first (Admin, Lists, Subcontractors).');
  await q('UPDATE subcontractors SET address_confirmed_key=$2, address_confirmed_by=$3, address_confirmed_at=now() WHERE id=$1', [subId, addrKey({ street: r.address, city: r.city, state: r.state, zip: r.zip }), userId]);
}

// ------------------------------------------------------------------ 1099 information
// Everyone who gets a 1099 (1099 crew and subcontractors) needs a checked address and a W-9 whose address matches. The tax number itself is
// never read or stored here: it stays on the W-9 file, which the office opens when the forms are prepared.
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const sameName = (a, b) => { const x = norm(a), y = norm(b); if (!x || !y) return true; if (x === y || x.includes(y) || y.includes(x)) return true; const xs = x.split(' ').filter((w) => w.length > 2), ys = y.split(' ').filter((w) => w.length > 2); return xs.length > 0 && xs.every((w) => ys.includes(w)) || ys.length > 0 && ys.every((w) => xs.includes(w)); };
const line = (a) => [a?.street, a?.city, [a?.state, a?.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
function taxOf(r, { w9Present, w9Read, w9Name }) {
  const addr = { street: r.address, city: r.city, state: r.state, zip: r.zip }, ac = addressChecks({ ...addr, verified: !!r.address_verified, confirmedKey: r.address_confirmed_key }, w9Read);
  const blockers = [...(w9Present ? [] : ['No W-9 on file']), ...ac.reasons];
  return { id: r.id, name: r.name, active: r.active ?? !r.archived, address: addr, addressLine: line(addr), addressChecked: !!r.address_verified, w9: w9Present, w9Name: w9Name ?? null, w9Address: w9Read ?? null, addressMatch: ac.match, blockers, ready: blockers.length === 0,
    nameNote: w9Present && w9Name && !sameName(r.name, w9Name) ? `The W-9 is in the name "${w9Name}", which differs from "${r.name}". The 1099 uses the W-9 name.` : null };
}
export async function employeeTax() {
  const rows = await q(`SELECT e.id, e.name, e.active, e.address, e.city, e.state, e.zip, e.address_verified, e.address_confirmed_key, w.id AS w9_id, w.read_name, w.read_address FROM employees e LEFT JOIN documents w ON w.id=e.w9_document_id ORDER BY e.name`);
  return rows.map((r) => taxOf(r, { w9Present: !!r.w9_id, w9Read: r.read_address, w9Name: r.read_name }));
}
export async function subTax() {
  const rows = await q(`SELECT s.id, s.name, s.archived, s.address, s.city, s.state, s.zip, s.address_verified, s.address_confirmed_key, w.id AS w9_id, w.read_name, w.read_address FROM subcontractors s LEFT JOIN documents w ON w.id=s.w9_document_id ORDER BY s.name`);
  return rows.map((r) => taxOf(r, { w9Present: !!r.w9_id, w9Read: r.read_address, w9Name: r.read_name }));
}
export async function confirmEmployeeAddress(employeeId, userId, confirm = true) {
  const [r] = await q('SELECT address, city, state, zip, address_verified FROM employees WHERE id=$1', [employeeId]); if (!r) throw new HttpError(404, 'Employee not found.');
  if (!confirm) { await q('UPDATE employees SET address_confirmed_key=NULL, address_confirmed_by=NULL, address_confirmed_at=NULL WHERE id=$1', [employeeId]); return; }
  if (!r.address_verified || !r.address || !r.city || !r.state || !r.zip) throw bad('Verify the employee\'s address first (Admin, Lists, Employees).');
  await q('UPDATE employees SET address_confirmed_key=$2, address_confirmed_by=$3, address_confirmed_at=now() WHERE id=$1', [employeeId, addrKey({ street: r.address, city: r.city, state: r.state, zip: r.zip }), userId]);
}
// The year-end view: what each 1099 payee was paid in a calendar year (crew pay is the Super Admin's to see) and whether their information is complete.
// year = null gives every year that has payments.
export async function taxSummary(year, { showCrewPay = false } = {}) {
  const y = year == null ? null : Number(year); if (y !== null && !(Number.isInteger(y) && y >= 2000 && y <= 2100)) throw bad('Choose a valid year.');
  const crew = await q(`SELECT employee_id AS id, EXTRACT(YEAR FROM work_date)::int AS yr, SUM(COALESCE(pay, ROUND(hours*rate,2)))::float8 AS total FROM labor_entries WHERE source='Time clock' ${y ? 'AND EXTRACT(YEAR FROM work_date)=$1' : ''} GROUP BY 1, 2`, y ? [y] : []);
  const subs = await q(`SELECT sc.subcontractor_id AS id, EXTRACT(YEAR FROM sp.paid_date)::int AS yr, SUM(sp.amount)::float8 AS total FROM sub_payments sp JOIN sub_invoices si ON si.id=sp.sub_invoice_id JOIN sub_commitments sc ON sc.id=si.commitment_id ${y ? 'WHERE EXTRACT(YEAR FROM sp.paid_date)=$1' : ''} GROUP BY 1, 2`, y ? [y] : []);
  const et = new Map((await employeeTax()).map((x) => [x.id, x])), st = new Map((await subTax()).map((x) => [x.id, x]));
  const r2 = (n) => Math.round(n * 100) / 100, out = [];
  for (const c of crew) { const t = et.get(c.id); if (!t) continue; out.push({ ...t, type: '1099 Crew', year: c.yr, paid: showCrewPay ? r2(c.total) : null, over600: r2(c.total) >= 600 }); }
  for (const c of subs) { const t = st.get(c.id); if (!t) continue; out.push({ ...t, type: 'Subcontractor', year: c.yr, paid: r2(c.total), over600: r2(c.total) >= 600 }); }
  return out.sort((a, b) => b.year - a.year || a.name.localeCompare(b.name));
}

// The Super Admin verifies a subcontractor by hand (for example paperwork is being sorted out), or takes that back.
export async function setVerifyOverride(subId, userId, on = true) {
  const r = await q(`UPDATE subcontractors SET verified_override=$2, verified_override_by=$3, verified_override_at=CASE WHEN $2 THEN now() END WHERE id=$1 RETURNING id`, [subId, !!on, on ? userId : null]);
  if (!r.length) throw new HttpError(404, 'Subcontractor not found.');
}
