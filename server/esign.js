// E-signatures through DocuSign, for subcontracts, change orders and any other project PDF.
// The owner connects the company's DocuSign account once (OAuth, like QuickBooks). From a project's Documents a PDF is sent to up to three
// signers, who sign in order; DocuSign emails each one. The platform asks DocuSign how each envelope is doing every few minutes, and when
// everyone has signed it saves the signed PDF back into the project's Documents (and its SharePoint folder), next to the original.
// Signers place their own signature and date on the page ("free-form signing"), so any PDF works without preparing fields in it.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { q } from './db.js';
import { bad, text, HttpError } from './http.js';
import { baseUrl, seal, unseal, sign } from './bids.js';
import * as dc from './documents.js';

let dfetch = (u, init = {}) => fetch(u, { signal: AbortSignal.timeout(60000), ...init });
export const setDocusignFetch = (f) => { dfetch = f; };   // tests stand in for DocuSign
export const settings = () => ({ key: process.env.DOCUSIGN_INTEGRATION_KEY, secret: process.env.DOCUSIGN_SECRET_KEY, environment: /^prod/i.test(String(process.env.DOCUSIGN_ENVIRONMENT || '').trim()) ? 'production' : 'demo' });
export const configured = () => { const s = settings(); return !!(s.key && s.secret); };
export const redirectUri = () => `${baseUrl()}/api/docusign/callback`;
const AUTH = () => (settings().environment === 'production' ? 'https://account.docusign.com' : 'https://account-d.docusign.com');
const need = () => { if (!configured()) throw new HttpError(503, 'DocuSign is not set up yet. Add DOCUSIGN_INTEGRATION_KEY and DOCUSIGN_SECRET_KEY on the server.'); return settings(); };
const basic = (s) => 'Basic ' + Buffer.from(`${s.key}:${s.secret}`).toString('base64');
const stored = async () => (await q(`SELECT data FROM integrations WHERE name='docusign'`))[0]?.data ?? null;
export const connected = async () => configured() && !!(await stored());

// ---- connecting the account
export function connectUrl(user) {
  const s = need(), payload = Buffer.from(JSON.stringify({ uid: user.id, exp: Date.now() + 10 * 60000, n: crypto.randomBytes(6).toString('hex') })).toString('base64url');
  return `${AUTH()}/oauth/auth?` + new URLSearchParams({ response_type: 'code', scope: 'signature', client_id: s.key, redirect_uri: redirectUri(), state: `${payload}.${sign(payload)}` });
}
async function tokenCall(params) {
  const s = need(), r = await dfetch(`${AUTH()}/oauth/token`, { method: 'POST', headers: { authorization: basic(s), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() });
  const j = await r.json().catch(() => ({})); return { ok: r.ok && !!j.access_token, j };
}
export async function finishConnect(code, state) {
  const [payload, sig] = String(state || '').split('.');
  if (!payload || !sig || sig !== sign(payload)) throw bad('That sign-in link is not valid. Start the connection again from Admin.');
  const st = JSON.parse(Buffer.from(payload, 'base64url').toString()); if (st.exp < Date.now()) throw bad('That sign-in took too long. Start the connection again from Admin.');
  if (!code) throw bad('DocuSign did not finish the sign-in. Start the connection again.');
  const { ok, j } = await tokenCall({ grant_type: 'authorization_code', code: String(code) });
  if (!ok || !j.refresh_token) throw bad('DocuSign did not accept the sign-in. Check the Integration Key, the Secret Key and that the redirect address in DocuSign matches, then try again.');
  const ui = await dfetch(`${AUTH()}/oauth/userinfo`, { headers: { authorization: 'Bearer ' + j.access_token } }), info = await ui.json().catch(() => ({}));
  const acct = (info.accounts || []).find((a) => a.is_default) || (info.accounts || [])[0]; if (!ui.ok || !acct?.account_id || !acct.base_uri) throw bad('DocuSign did not say which account this sign-in belongs to. Try again.');
  cache = { token: j.access_token, exp: Date.now() + (j.expires_in || 3000) * 1000 };
  await q(`INSERT INTO integrations(name,data) VALUES ('docusign',$1) ON CONFLICT (name) DO UPDATE SET data=$1, updated_at=now()`, [{ accountId: String(acct.account_id), baseUri: String(acct.base_uri).replace(/\/$/, ''), accountName: acct.account_name ?? null, email: info.email ?? null, name: info.name ?? null, refresh: seal(j.refresh_token), environment: settings().environment, connectedAt: new Date().toISOString(), connectedBy: st.uid }]);
  return { account: acct.account_name ?? null };
}
export const disconnect = () => { cache = { token: null, exp: 0 }; return q(`DELETE FROM integrations WHERE name='docusign'`); };

let cache = { token: null, exp: 0 }, refreshing = null;
async function accessToken(force = false) {
  const d = await stored(); if (!d) throw new HttpError(409, 'DocuSign is not connected. The owner connects it in Admin, Connections.');
  if (d.environment !== settings().environment) throw new HttpError(409, `DocuSign was connected to the ${d.environment} environment, but the server is set to ${settings().environment}. Disconnect and connect again.`);
  if (!force && cache.token && cache.exp > Date.now() + 60000) return { token: cache.token, d };
  refreshing ||= (async () => {   // one refresh at a time: DocuSign hands out a new refresh token each time
    try {
      const cur = await stored(), { ok, j } = await tokenCall({ grant_type: 'refresh_token', refresh_token: unseal(cur.refresh) });
      if (!ok) throw new HttpError(409, 'DocuSign no longer allows access (the connection lapses after about 30 days unused). Reconnect DocuSign in Admin.');
      if (j.refresh_token) await q(`UPDATE integrations SET data = data || $1::jsonb, updated_at=now() WHERE name='docusign'`, [{ refresh: seal(j.refresh_token) }]);
      cache = { token: j.access_token, exp: Date.now() + (j.expires_in || 3000) * 1000 };
    } finally { refreshing = null; }
  })();
  await refreshing; return { token: cache.token, d };
}
// One call to DocuSign's eSignature API. Retries once with a fresh token; an error is given in DocuSign's own words.
async function api(method, path, { body, binary = false } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { token, d } = await accessToken(attempt === 1);
    const r = await dfetch(`${d.baseUri}/restapi/v2.1/accounts/${d.accountId}${path}`, { method, headers: { authorization: 'Bearer ' + token, ...(body ? { 'content-type': 'application/json' } : {}), accept: binary ? 'application/pdf' : 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 401 && attempt === 0) continue;
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new HttpError(502, `DocuSign answered with an error (${r.status})${j.message ? ': ' + String(j.message).slice(0, 300) : j.errorCode ? ': ' + j.errorCode : ''}.`); }
    return binary ? Buffer.from(await r.arrayBuffer()) : r.json().catch(() => ({}));
  }
}

export async function status() {
  let redirect = null; try { redirect = redirectUri(); } catch { /* no site address yet */ }
  const s = settings(), d = await stored();
  return { configured: configured(), needs: [['DOCUSIGN_INTEGRATION_KEY', s.key], ['DOCUSIGN_SECRET_KEY', s.secret]].filter((x) => !x[1]).map((x) => x[0]), environment: s.environment, connected: !!d, account: d?.accountName ?? null, email: d?.email ?? null, connectedAt: d?.connectedAt ?? null, connectedEnvironment: d?.environment ?? null, redirectUri: redirect };
}

// ---- sending a document for signature
const LABEL = { created: 'Not sent yet', sent: 'Sent, not opened yet', delivered: 'Opened, not signed yet', signed: 'Signed', completed: 'Signed by everyone', declined: 'Declined by a signer', voided: 'Cancelled' };
const OPEN = ['created', 'sent', 'delivered'];
const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const row = (r) => ({ id: r.id, documentId: r.document_id, document: r.document, projectId: r.project_id, status: r.status, statusLabel: LABEL[r.status] || r.status, open: OPEN.includes(r.status), signers: r.signers || [], cc: r.cc_email, subject: r.subject, sentAt: r.sent_at, sentBy: r.sender, completedAt: r.completed_at, signedDocumentId: r.signed_document_id, error: r.error, checkedAt: r.last_checked_at });
const SELECT = `SELECT e.*, d.name AS document, u.name AS sender FROM esign_envelopes e LEFT JOIN documents d ON d.id=e.document_id LEFT JOIN app_users u ON u.id=e.sent_by`;

export async function listForProject(projectId) { return { connected: await connected(), envelopes: (await q(`${SELECT} WHERE e.project_id=$1 ORDER BY e.sent_at DESC`, [projectId])).map(row) }; }
export async function documentProject(documentId) { const [d] = await q('SELECT project_id FROM documents WHERE id=$1', [documentId]); if (!d) throw new HttpError(404, 'Document not found.'); if (!d.project_id) throw bad('Only a document that belongs to a project can be sent for signature.'); return d.project_id; }
export async function envelopeProject(id) { const [e] = await q('SELECT project_id FROM esign_envelopes WHERE id=$1', [id]); if (!e) throw new HttpError(404, 'That signature request was not found.'); return e.project_id; }

export async function send(user, documentId, b) {
  const doc = await dc.getFile(documentId); if (doc.restricted) throw new HttpError(403, 'That document is private.');
  if (doc.mime !== 'application/pdf') throw bad('Only a PDF can be sent for signature. Save the file as a PDF first.');
  const signers = (Array.isArray(b.signers) ? b.signers : []).map((s) => ({ name: text(s?.name, 'Signer name', { max: 100, required: false }), email: String(s?.email || '').trim().toLowerCase() })).filter((s) => s.name || s.email);
  if (!signers.length) throw bad('Add at least one signer.'); if (signers.length > 3) throw bad('Up to three signers.');
  for (const s of signers) { if (!s.name) throw bad('Each signer needs a name.'); if (!emailOk(s.email)) throw bad(`${s.name} needs a valid email.`); }
  if (new Set(signers.map((s) => s.email)).size !== signers.length) throw bad('Each signer needs a different email.');
  const cc = String(b.cc || '').trim().toLowerCase(); if (cc && !emailOk(cc)) throw bad('The copy-to email is not valid.');
  const subject = text(b.subject, 'Subject', { max: 100, required: false }) || `Please sign: ${doc.name}`.slice(0, 100), message = text(b.message, 'Message', { max: 1000, required: false });
  const bytes = await fs.promises.readFile(doc.file); if (bytes.length > 20 * 1024 * 1024) throw bad('That PDF is over 20 MB, which is too large to send for signature.');
  const env = await api('POST', '/envelopes', { body: { emailSubject: subject, ...(message ? { emailBlurb: message } : {}), status: 'sent',
    documents: [{ documentBase64: bytes.toString('base64'), name: doc.name.replace(/\.pdf$/i, '') || 'Document', fileExtension: 'pdf', documentId: '1' }],
    recipients: { signers: signers.map((s, i) => ({ email: s.email, name: s.name, recipientId: String(i + 1), routingOrder: String(i + 1) })), ...(cc ? { carbonCopies: [{ email: cc, name: cc, recipientId: '9', routingOrder: String(signers.length + 1) }] } : {}) } } });
  if (!env.envelopeId) throw new HttpError(502, 'DocuSign did not confirm the request. Nothing was recorded; try again.');
  const [r] = await q(`INSERT INTO esign_envelopes(project_id, document_id, envelope_id, status, signers, cc_email, subject, sent_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [doc.project_id, documentId, String(env.envelopeId), String(env.status || 'sent').toLowerCase(), JSON.stringify(signers), cc || null, subject, user.id]);
  return row((await q(`${SELECT} WHERE e.id=$1`, [r.id]))[0]);
}

// Asks DocuSign where one envelope stands. When everyone has signed, the signed PDF is saved into the project's documents once.
export async function refresh(id) {
  const [e] = await q('SELECT * FROM esign_envelopes WHERE id=$1', [id]); if (!e) throw new HttpError(404, 'That signature request was not found.');
  try {
    const env = await api('GET', `/envelopes/${encodeURIComponent(e.envelope_id)}`), st = String(env.status || e.status).toLowerCase();
    await q('UPDATE esign_envelopes SET status=$2, last_checked_at=now(), error=NULL, completed_at = CASE WHEN $2 = \'completed\' THEN COALESCE(completed_at, $3::timestamptz, now()) ELSE completed_at END WHERE id=$1', [id, st, env.completedDateTime || null]);
    if (st === 'completed' && !e.signed_document_id) {
      const pdf = await api('GET', `/envelopes/${encodeURIComponent(e.envelope_id)}/documents/combined`, { binary: true });
      const [src] = await q('SELECT name, category FROM documents WHERE id=$1', [e.document_id]), base = String(src?.name || 'Document').replace(/\.pdf$/i, '');
      const saved = await dc.uploadDocument({ id: e.sent_by }, { category: src?.category || 'Contract', name: `${base} - signed.pdf`, filename: `${base} - signed.pdf`, bytes: pdf, projectId: e.project_id });
      await q('UPDATE esign_envelopes SET signed_document_id=$2 WHERE id=$1', [id, saved.id]);
    }
  } catch (err) { await q('UPDATE esign_envelopes SET last_checked_at=now(), error=$2 WHERE id=$1', [id, err instanceof HttpError ? err.message : 'DocuSign could not be reached.']); if (!(err instanceof HttpError)) console.error('esign refresh', err.message); }
  return row((await q(`${SELECT} WHERE e.id=$1`, [id]))[0]);
}
export async function cancel(user, id, b) {
  const [e] = await q('SELECT * FROM esign_envelopes WHERE id=$1', [id]); if (!e) throw new HttpError(404, 'That signature request was not found.');
  if (!OPEN.includes(e.status)) throw new HttpError(409, `This request is already ${(LABEL[e.status] || e.status).toLowerCase()}.`);
  const reason = text(b?.reason, 'Reason', { max: 200, required: false }) || `Cancelled by ${user.name || user.email}`;
  await api('PUT', `/envelopes/${encodeURIComponent(e.envelope_id)}`, { body: { status: 'voided', voidedReason: reason } });
  await q(`UPDATE esign_envelopes SET status='voided', last_checked_at=now(), error=NULL WHERE id=$1`, [id]);
  return row((await q(`${SELECT} WHERE e.id=$1`, [id]))[0]);
}
// Every envelope still out, checked at most once every 10 minutes.
export async function pollOpen() {
  if (!(await connected())) return 0;
  const rows = await q(`SELECT id FROM esign_envelopes WHERE status = ANY($1::text[]) AND (last_checked_at IS NULL OR last_checked_at < now() - interval '10 minutes') ORDER BY sent_at LIMIT 40`, [OPEN]);
  for (const r of rows) await refresh(r.id).catch(() => null);
  return rows.length;
}
export function startScheduler() { setInterval(() => pollOpen().catch((e) => console.error('esign poll', e.message)), 5 * 60000); }
