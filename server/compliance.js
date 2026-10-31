import nodemailer from 'nodemailer';
import { q, tx } from './db.js';
import { bad, text, dateStr, httpsUrl, HttpError } from './http.js';
import { MANAGE } from './auth.js';
import { evaluate, stageFor } from '../src/lib/compliance.ts';

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const DOC_COL = { 'W-9': 'w9_document_id', COI: 'coi_document_id', Exemption: 'exemption_document_id' };

// ------------------------------------------------------------------ vendor documents and status
const SELECT = `SELECT s.id, s.name, s.email, s.archived, w.id AS w9_id, w.name AS w9_name, w.url AS w9_url, w.storage_key AS w9_key,
    c.id AS coi_id, c.name AS coi_name, c.url AS coi_url, c.storage_key AS coi_key, c.expires_on AS coi_expires,
    x.id AS ex_id, x.name AS ex_name, x.url AS ex_url, x.storage_key AS ex_key, x.expires_on AS ex_expires
  FROM subcontractors s LEFT JOIN documents w ON w.id=s.w9_document_id LEFT JOIN documents c ON c.id=s.coi_document_id LEFT JOIN documents x ON x.id=s.exemption_document_id`;
const shape = (r, asOf) => {
  const ev = evaluate({ w9: !!r.w9_id, coi: { present: !!r.coi_id, expires: r.coi_expires }, exemption: { present: !!r.ex_id, expires: r.ex_expires } }, asOf);
  return { id: r.id, name: r.name, email: r.email, archived: r.archived, ...ev,
    docs: { 'W-9': r.w9_id ? { id: r.w9_id, name: r.w9_name, url: r.w9_url, file: !!r.w9_key } : null, COI: r.coi_id ? { id: r.coi_id, name: r.coi_name, url: r.coi_url, file: !!r.coi_key, expires: r.coi_expires } : null, Exemption: r.ex_id ? { id: r.ex_id, name: r.ex_name, url: r.ex_url, file: !!r.ex_key, expires: r.ex_expires } : null } };
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
export async function assertCanPay(t, subcontractorId, asOf = today()) {
  const [r] = await t(`${SELECT} WHERE s.id=$1`, [subcontractorId]); if (!r) throw bad('Vendor not found.');
  const v = shape(r, asOf);
  if (!v.canPay) throw new HttpError(409, `${v.name} cannot be paid: ${v.reasons.join('; ')}.`);
}

// ------------------------------------------------------------------ notifications and email outbox
export async function notifyRoles(roles, { kind, title, body, link, dedupe }) {
  const users = await q('SELECT id FROM app_users WHERE active AND role = ANY($1::text[])', [roles]);
  let n = 0;
  for (const u of users) n += (await q(`INSERT INTO notifications(user_id,kind,title,body,link,dedupe_key) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (user_id, dedupe_key) DO NOTHING RETURNING id`, [u.id, kind, title, body ?? null, link ?? null, dedupe ?? null])).length;
  return n;
}
export const notifyUser = (userId, { kind, title, body, link, dedupe }) => q(`INSERT INTO notifications(user_id,kind,title,body,link,dedupe_key) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (user_id, dedupe_key) DO NOTHING`, [userId, kind, title, body ?? null, link ?? null, dedupe ?? null]);
export const listNotifications = (userId) => q('SELECT id, kind, title, body, link, created_at, read_at FROM notifications WHERE user_id=$1 ORDER BY (read_at IS NULL) DESC, created_at DESC LIMIT 60', [userId]);
export const markRead = (userId, ids) => ids === 'all' ? q('UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL', [userId]) : q('UPDATE notifications SET read_at=now() WHERE user_id=$1 AND id = ANY($2::uuid[])', [userId, ids]);

export async function queueEmail({ to, subject, body, kind, relatedId, dedupe }) {
  return (await q(`INSERT INTO email_outbox(to_email,subject,body,kind,related_id,dedupe_key) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`, [to, subject, body, kind ?? null, relatedId ?? null, dedupe ?? null])).length;
}
let transport = null;
export const setTransport = (t) => { transport = t; };
const getTransport = () => transport ?? (process.env.SMTP_URL ? (transport = nodemailer.createTransport(process.env.SMTP_URL)) : null);
export const emailConnected = () => !!getTransport();
export async function sendQueued() {
  const t = getTransport(); if (!t) return { sent: 0, failed: 0, connected: false };
  let sent = 0, failed = 0;
  for (const m of await q(`SELECT * FROM email_outbox WHERE status='Queued' ORDER BY created_at LIMIT 50`)) {
    try { await t.sendMail({ from: process.env.EMAIL_FROM || 'ByOther Construction <no-reply@byother.net>', to: m.to_email, subject: m.subject, text: m.body }); await q(`UPDATE email_outbox SET status='Sent', sent_at=now(), error=NULL WHERE id=$1`, [m.id]); sent++; }
    catch (e) { await q(`UPDATE email_outbox SET status='Failed', error=$2 WHERE id=$1`, [m.id, String(e.message).slice(0, 300)]); failed++; }
  }
  return { sent, failed, connected: true };
}
export const listOutbox = () => q('SELECT id, to_email, subject, status, kind, error, created_at, sent_at FROM email_outbox ORDER BY created_at DESC LIMIT 100');
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
