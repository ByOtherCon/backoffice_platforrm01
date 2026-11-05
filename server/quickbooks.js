// QuickBooks Online (invoices and expenses). Connection to the company file through Intuit's OAuth2, with the refresh token stored
// sealed in the database (it rotates on every refresh, so each new one is saved). Reading data builds on this.
import { q } from './db.js';
import { bad, HttpError } from './http.js';
import { baseUrl, seal, unseal, sign } from './bids.js';
import crypto from 'node:crypto';

let ifetch = (...a) => fetch(...a);
export const setIntuitFetch = (f) => { ifetch = f; };   // tests stand in for Intuit
export const settings = () => ({ clientId: process.env.QBO_CLIENT_ID, secret: process.env.QBO_CLIENT_SECRET, environment: process.env.QBO_ENVIRONMENT === 'sandbox' ? 'sandbox' : 'production' });
export const configured = () => { const s = settings(); return !!(s.clientId && s.secret); };
export const redirectUri = () => `${baseUrl()}/api/quickbooks/callback`;
const API = () => (settings().environment === 'sandbox' ? 'https://sandbox-quickbooks.api.intuit.com' : 'https://quickbooks.api.intuit.com');
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const need = () => { if (!configured()) throw new HttpError(503, 'QuickBooks is not set up yet. Add QBO_CLIENT_ID and QBO_CLIENT_SECRET on the server.'); return settings(); };
const basic = (s) => 'Basic ' + Buffer.from(`${s.clientId}:${s.secret}`).toString('base64');
const stored = async () => (await q(`SELECT data FROM integrations WHERE name='quickbooks'`))[0]?.data ?? null;

export function connectUrl(user) {
  const s = need();
  const payload = Buffer.from(JSON.stringify({ uid: user.id, exp: Date.now() + 10 * 60000, n: crypto.randomBytes(6).toString('hex') })).toString('base64url');
  return 'https://appcenter.intuit.com/connect/oauth2?' + new URLSearchParams({ client_id: s.clientId, response_type: 'code', scope: 'com.intuit.quickbooks.accounting', redirect_uri: redirectUri(), state: `${payload}.${sign(payload)}` });
}
async function tokenCall(params) {
  const s = need();
  const r = await ifetch(TOKEN_URL, { method: 'POST', headers: { authorization: basic(s), accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
  const j = await r.json().catch(() => ({})); return { ok: r.ok && !!j.access_token, j };
}
export async function finishConnect(code, state, realmId) {
  const [payload, sig] = String(state || '').split('.');
  if (!payload || !sig || sig !== sign(payload)) throw bad('That sign-in link is not valid. Start the connection again from Admin.');
  const st = JSON.parse(Buffer.from(payload, 'base64url').toString()); if (st.exp < Date.now()) throw bad('That sign-in took too long. Start the connection again from Admin.');
  if (!code || !realmId) throw bad('Intuit did not return a company. Start the connection again and choose the company.');
  const { ok, j } = await tokenCall({ grant_type: 'authorization_code', code: String(code), redirect_uri: redirectUri() });
  if (!ok || !j.refresh_token) throw bad('Intuit did not accept the sign-in. Check the Client ID, Client Secret and that the redirect address matches, then try again.');
  cache = { token: j.access_token, exp: Date.now() + (j.expires_in || 3000) * 1000, realm: String(realmId) };
  let company = null; try { company = (await api('GET', `companyinfo/${realmId}`, { realm: String(realmId) }))?.CompanyInfo?.CompanyName ?? null; } catch { /* the name is only for display */ }
  await q(`INSERT INTO integrations(name,data) VALUES ('quickbooks',$1) ON CONFLICT (name) DO UPDATE SET data=$1, updated_at=now()`, [{ realmId: String(realmId), refresh: seal(j.refresh_token), environment: settings().environment, company, connectedAt: new Date().toISOString(), connectedBy: st.uid }]);
  return { company, realmId: String(realmId) };
}
export const disconnect = () => { cache = { token: null, exp: 0, realm: null }; return q(`DELETE FROM integrations WHERE name='quickbooks'`); };

let cache = { token: null, exp: 0, realm: null }, refreshing = null;
async function accessToken(force = false) {
  const d = await stored(); if (!d) throw new HttpError(409, 'QuickBooks is not connected. Connect it in Admin.');
  if (d.environment !== settings().environment) throw new HttpError(409, `QuickBooks was connected to the ${d.environment} environment, but the server is set to ${settings().environment}. Disconnect and connect again.`);
  if (!force && cache.token && cache.realm === d.realmId && cache.exp > Date.now() + 60000) return { token: cache.token, realm: d.realmId };
  // one refresh at a time: Intuit hands out a new refresh token each time, and the old one stops working
  refreshing ||= (async () => {
    try {
      const cur = await stored(); const { ok, j } = await tokenCall({ grant_type: 'refresh_token', refresh_token: unseal(cur.refresh) });
      if (!ok) throw new HttpError(409, 'Intuit no longer allows access to this company (the connection expires after about 100 days unused). Reconnect QuickBooks in Admin.');
      if (j.refresh_token) await q(`UPDATE integrations SET data = data || $1::jsonb, updated_at=now() WHERE name='quickbooks'`, [{ refresh: seal(j.refresh_token) }]);
      cache = { token: j.access_token, exp: Date.now() + (j.expires_in || 3000) * 1000, realm: cur.realmId };
    } finally { refreshing = null; }
  })();
  await refreshing; return { token: cache.token, realm: d.realmId };
}
// Intuit explains a refusal in its body ("Fault"), in either capitalisation. The tid lets Intuit support find the request.
async function qbError(r, path) {
  let why = ''; try {
    const j = JSON.parse(await r.text()), f = j.Fault || j.fault, e = (f?.Error || f?.error || [])[0] || {};
    why = [e.Message || e.message, e.Detail || e.detail, e.code ? `code ${e.code}` : ''].filter(Boolean).join(' · ').replace(/\s+/g, ' ').slice(0, 300);
  } catch { /* not JSON */ }
  const tid = r.headers?.get?.('intuit_tid'); console.error(`QuickBooks ${r.status} on ${path.split('?')[0]}${tid ? ' intuit_tid=' + tid : ''}: ${why || 'no detail'}`);
  return new HttpError(502, `QuickBooks answered with an error (${r.status})${why ? ': ' + why : ''}${tid ? ' [ref ' + tid + ']' : ''}.`);
}
// One call to the QuickBooks API (query or read). Retries once with a fresh token if Intuit says the token is stale.
export async function api(method, path, { realm: forcedRealm, params } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { token, realm } = forcedRealm && cache.token ? { token: cache.token, realm: forcedRealm } : await accessToken(attempt > 0);
    const url = `${API()}/v3/company/${realm}/${path}${path.includes('?') ? '&' : '?'}${new URLSearchParams({ minorversion: '75', ...(params || {}) })}`;
    let r; try { r = await ifetch(url, { method, headers: { authorization: 'Bearer ' + token, accept: 'application/json' } }); } catch { throw new HttpError(502, 'QuickBooks could not be reached.'); }
    if (r.status === 401 && attempt === 0) { cache = { token: null, exp: 0, realm: null }; continue; }
    if (!r.ok) throw await qbError(r, path);
    return r.json();
  }
}
export const query = (sql) => api('GET', 'query', { params: { query: sql } });

export async function status() {
  let redirect = null, problem = null; try { redirect = redirectUri(); } catch (e) { problem = e.message; }
  const s = settings(), d = await stored();
  return { configured: configured(), connected: !!d, company: d?.company ?? null, realmId: d?.realmId ?? null, connectedAt: d?.connectedAt ?? null, connectedEnvironment: d?.environment ?? null, environment: s.environment, redirectUri: redirect, problem,
    needs: ['QBO_CLIENT_ID', 'QBO_CLIENT_SECRET'].filter((k) => !process.env[k]) };
}
