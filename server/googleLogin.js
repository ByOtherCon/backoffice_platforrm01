// "Sign in with Google" for the company's Google Workspace. Google only proves who someone is; they still need a Desk Platform account
// (added by the owner in Admin, with their access chosen) and it must be active. Only accounts of the company domain are accepted.
import crypto from 'node:crypto';
import { q } from './db.js';
import { HttpError, parseCookies } from './http.js';
import { baseUrl, sign } from './bids.js';
import { createSession } from './auth.js';

let gfetch = (u, init = {}) => fetch(u, { signal: AbortSignal.timeout(20000), ...init });
export const setLoginFetch = (f) => { gfetch = f; };   // tests stand in for Google
export const configured = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
export const domain = () => String(process.env.GOOGLE_LOGIN_DOMAIN || 'byother.net').trim().toLowerCase().replace(/^@/, '');
export const redirectUri = () => `${baseUrl()}/api/auth/google/callback`;
export const options = () => { let redirect = null; try { redirect = redirectUri(); } catch { /* no site address yet */ } return { google: configured(), domain: domain(), redirectUri: redirect }; };
export const NONCE_COOKIE = 'bo_oauth';
const cookie = (value, secure, maxAge) => `${NONCE_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/api/auth; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;

// Step 1: send the person to Google. A one-time value goes in the address Google sends back and in a cookie, so only the browser that started it can finish it.
export function start(secure) {
  if (!configured()) throw new HttpError(503, 'Sign in with Google is not set up yet. The owner adds GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the server.');
  const nonce = crypto.randomBytes(16).toString('hex'), payload = Buffer.from(JSON.stringify({ n: nonce, exp: Date.now() + 10 * 60000 })).toString('base64url');
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri(), response_type: 'code', scope: 'openid email profile', state: `${payload}.${sign(payload)}`, hd: domain(), prompt: 'select_account' });
  return { url, setCookie: cookie(nonce, secure, 600) };
}
const fail = (msg) => ({ error: msg });
// Step 2: Google sends the person back. Returns { token } for a session, or { error } to show on the sign-in page.
export async function finish(req, code, state) {
  const [payload, sig] = String(state || '').split('.');
  if (!payload || !sig || sig !== sign(payload)) return fail('That sign-in link is not valid. Try again.');
  let st; try { st = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { return fail('That sign-in link is not valid. Try again.'); }
  if (st.exp < Date.now()) return fail('That sign-in took too long. Try again.');
  if (parseCookies(req.headers.cookie)[NONCE_COOKIE] !== st.n) return fail('That sign-in was not started in this browser. Try again.');
  if (!code) return fail('Google did not finish the sign-in.');
  const tr = await gfetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code: String(code), client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri(), grant_type: 'authorization_code' }) });
  const tok = await tr.json().catch(() => ({})); if (!tr.ok || !tok.access_token) return fail('Google did not accept the sign-in. Try again.');
  const ur = await gfetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: 'Bearer ' + tok.access_token } });
  const info = await ur.json().catch(() => ({})); const email = String(info.email || '').trim().toLowerCase();
  if (!ur.ok || !email) return fail('Google did not share an email address.');
  if (info.email_verified !== true) return fail('Google says that email address is not verified.');
  if (!email.endsWith('@' + domain()) || String(info.hd || '').toLowerCase() !== domain()) return fail(`Use your @${domain()} Google account.`);
  const [u] = await q('SELECT id FROM app_users WHERE lower(email)=$1 AND active', [email]);
  if (!u) return fail(`${email} does not have a by Other Desk Platform login yet. Ask the owner to add you.`);
  return { token: await createSession(u.id), email };
}
export const clearNonce = (secure) => cookie('', secure, 0);
