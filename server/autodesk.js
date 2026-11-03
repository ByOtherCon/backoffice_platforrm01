// BuildingConnected through the Autodesk Platform Services API: a read-only (data:read) sign-in by the Super Admin, kept as an
// encrypted refresh token. This follows the connection the ChatGPT build already used. What it can read is checked against the real
// account (Admin -> BuildingConnected -> Check), and the check shows exactly what Autodesk returns so fields are mapped from facts.
import crypto from 'node:crypto';
import { q } from './db.js';
import { bad, HttpError } from './http.js';
import { seal, unseal, baseUrl } from './bids.js';

let afetch = (...a) => fetch(...a);
export const setApsFetch = (f) => { afetch = f; };   // tests stand in for Autodesk
const SCOPE = 'data:read', API = 'https://developer.api.autodesk.com/construction/buildingconnected/v2/', AUTH = 'https://developer.api.autodesk.com/authentication/v2/';
export const configured = () => !!(process.env.APS_CLIENT_ID && process.env.APS_CLIENT_SECRET);
export const redirectUri = () => `${baseUrl()}/api/autodesk/callback`;
const b64u = (b) => Buffer.from(b).toString('base64url');
const stored = async () => (await q(`SELECT data FROM integrations WHERE name='autodesk'`))[0]?.data ?? null;
const save = (d) => q(`INSERT INTO integrations(name,data) VALUES ('autodesk',$1) ON CONFLICT (name) DO UPDATE SET data=$1, updated_at=now()`, [d]);
let cached = { token: null, exp: 0 };

async function tokenRequest(params) {
  let r; try { r = await afetch(AUTH + 'token', { method: 'POST', signal: AbortSignal.timeout(20000), redirect: 'manual', headers: { authorization: 'Basic ' + Buffer.from(process.env.APS_CLIENT_ID + ':' + process.env.APS_CLIENT_SECRET).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) }); }
  catch { throw new HttpError(503, 'Autodesk could not be reached. Try again shortly.'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) { const e = new HttpError(503, j.error === 'invalid_grant' ? 'Autodesk sign-in expired or was revoked. Connect BuildingConnected again.' : 'Autodesk did not accept the sign-in. Check APS_CLIENT_ID and APS_CLIENT_SECRET, and the callback address registered in the Autodesk app.'); e.invalid = r.status === 400 || r.status === 401; throw e; }
  return j;
}
export async function connectUrl(user) {
  if (!configured()) throw new HttpError(503, 'Autodesk is not set up yet. Add APS_CLIENT_ID and APS_CLIENT_SECRET on the server first.');
  const state = crypto.randomBytes(24).toString('base64url'), verifier = crypto.randomBytes(32).toString('base64url');
  await q(`DELETE FROM integrations WHERE name LIKE 'aps_auth_%' AND updated_at < now() - interval '15 minutes'`);
  await q(`INSERT INTO integrations(name,data) VALUES ($1,$2)`, ['aps_auth_' + state, { uid: user.id, verifier, exp: Date.now() + 10 * 60000 }]);
  const u = new URL(AUTH + 'authorize'); u.search = new URLSearchParams({ response_type: 'code', client_id: process.env.APS_CLIENT_ID, redirect_uri: redirectUri(), scope: SCOPE, state, code_challenge: b64u(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256' }).toString();
  return u.href;
}
export async function finishConnect(user, code, state, error) {
  const [row] = await q(`DELETE FROM integrations WHERE name=$1 RETURNING data`, ['aps_auth_' + String(state || '')]);        // a sign-in link works once
  if (!row || row.data.exp < Date.now() || row.data.uid !== user.id) throw bad('That Autodesk sign-in expired or is not valid. Connect again from Admin.');
  if (error) throw bad('Autodesk did not allow the connection (' + String(error).slice(0, 60) + ').');
  if (!code) throw bad('Autodesk did not return a sign-in code.');
  const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(), code_verifier: row.data.verifier });
  if (!String(t.scope || SCOPE).split(' ').includes(SCOPE)) throw bad('Autodesk did not grant read access. Connect again and approve the permission.');
  if (!t.refresh_token) throw new HttpError(503, 'Autodesk did not give a lasting connection. Connect again.');
  const me = await rawRead(t.access_token, 'users/me');
  if (me.status !== 200) throw new HttpError(503, 'Autodesk signed in, but BuildingConnected API access is not available. Check that the BuildingConnected API is enabled for the Autodesk app and that this account belongs to your BuildingConnected company.');
  const p = me.data?.user || me.data || {};
  cached = { token: t.access_token, exp: Date.now() + Number(t.expires_in || 3600) * 1000 };
  await save({ email: String(p.email || '').toLowerCase(), name: String(p.name || [p.firstName, p.lastName].filter(Boolean).join(' ') || '').slice(0, 120), company: String(p.company?.name || '').slice(0, 160), refresh: seal(t.refresh_token), connectedAt: new Date().toISOString(), needsReconnect: false, connectedBy: user.id });
}
export const expireTokenCache = () => { cached = { token: null, exp: 0 }; };   // used by tests; a real token also ages out on its own
export const disconnect = async () => { cached = { token: null, exp: 0 }; await q(`DELETE FROM integrations WHERE name='autodesk'`); };

// Only these reads are allowed: who we are, the offices, and invitations (one by id, or a short list).
const ALLOWED = [/^users\/me$/, /^offices\?limit=\d{1,3}$/, /^opportunities\/[a-f0-9]{24}$/, /^opportunities\?limit=\d{1,3}(&offset=\d{1,6})?$/];
async function rawRead(token, path) {
  if (!ALLOWED.some((re) => re.test(path))) throw bad('That Autodesk read is not allowed.');
  let r; try { r = await afetch(API + path, { signal: AbortSignal.timeout(20000), redirect: 'manual', headers: { authorization: 'Bearer ' + token, accept: 'application/json' } }); } catch { throw new HttpError(503, 'BuildingConnected could not be reached. Try again shortly.'); }
  return { status: r.status, data: await r.json().catch(() => null) };
}
async function accessToken() {
  if (cached.token && cached.exp > Date.now() + 120000) return cached.token;
  const d = await stored(); if (!d || d.needsReconnect) throw new HttpError(409, 'BuildingConnected is not connected. Connect it in Admin.');
  try {
    const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: unseal(d.refresh), scope: SCOPE });
    cached = { token: t.access_token, exp: Date.now() + Number(t.expires_in || 3600) * 1000 };
    await save({ ...d, refresh: t.refresh_token ? seal(t.refresh_token) : d.refresh }); return cached.token;
  } catch (e) { if (e.invalid) await save({ ...d, needsReconnect: true }); throw e; }
}
export async function read(path) { return rawRead(await accessToken(), path); }
export async function status() {
  const d = await stored();
  return { configured: configured(), connected: !!d && !d.needsReconnect, needsReconnect: !!d?.needsReconnect, account: d?.email ?? null, company: d?.company ?? null, connectedAt: d?.connectedAt ?? null, callback: (() => { try { return redirectUri(); } catch { return null; } })(), lastCheck: d?.lastCheck ?? null };
}

// Admin check: read one invitation (and a short list) and show what comes back, so the fields can be mapped from the real response.
const say = (s) => (s === 200 ? 'Available' : s === 403 ? 'Not permitted by the current product access' : s === 404 ? 'Not available to this account' : s === 429 ? 'Try again later' : s === 401 ? 'Reconnect required' : 'Autodesk check failed (' + s + ')');
const keysOf = (v) => (v && typeof v === 'object' ? Object.keys(Array.isArray(v) ? v[0] || {} : v).slice(0, 60) : []);
const rows = (d) => (Array.isArray(d) ? d : d?.results || d?.data || d?.items || d?.opportunities || []);
export async function check(linkOrId) {
  const m = String(linkOrId || '').match(/[a-f0-9]{24}/); if (!m) throw bad('Paste a BuildingConnected invitation link (it contains a 24-character ID), or the ID itself.');
  const d = await stored(); const me = await read('users/me'); if (me.status === 401) { await save({ ...d, needsReconnect: true }); throw new HttpError(409, 'Reconnect BuildingConnected.'); }
  const offices = await read('offices?limit=20'), one = await read('opportunities/' + m[0]), list = await read('opportunities?limit=5');
  const out = { at: new Date().toISOString(), opportunityId: m[0], account: say(me.status), offices: say(offices.status), opportunity: say(one.status), list: say(list.status), opportunityKeys: keysOf(one.data), listKeys: keysOf(rows(list.data)), listCount: rows(list.data).length,
    sample: one.status === 200 ? JSON.stringify(one.data, null, 1).slice(0, 7000) : (one.data ? JSON.stringify(one.data).slice(0, 600) : '') };
  await save({ ...(await stored()), lastCheck: out }); return out;
}
