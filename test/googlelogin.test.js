import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
process.env.PUBLIC_URL = 'https://desk.example.com'; process.env.SECRET_KEY = 'test-secret-key-0123456789';
delete process.env.GOOGLE_CLIENT_ID; delete process.env.GOOGLE_CLIENT_SECRET; delete process.env.GOOGLE_LOGIN_DOMAIN;
const { pool, q } = await import('../server/db.js');
const { server } = await import('../server/index.js');
const { hashPassword } = await import('../server/auth.js');
const gl = await import('../server/googleLogin.js');

let base, profile = { email: 'silvia@byother.net', email_verified: true, hd: 'byother.net' }, tokenOk = true, calls = [];
const google = async (url, init = {}) => {
  const u = new URL(url); calls.push(u.hostname + u.pathname);
  const res = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  if (u.hostname === 'oauth2.googleapis.com') return tokenOk && new URLSearchParams(String(init.body)).get('code') === 'good' ? res({ access_token: 'tok' }) : res({ error: 'invalid_grant' }, 400);
  if (u.hostname === 'openidconnect.googleapis.com') return init.headers.authorization === 'Bearer tok' ? res(profile) : res({}, 401);
  return res({}, 404);
};
const get = (path, cookie) => fetch(base + path, { redirect: 'manual', headers: cookie ? { cookie } : {} });
const cookieOf = (r, name) => (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith(name + '='));
// runs the whole round trip: start (keeps the nonce cookie), then come back from Google with that state
async function roundTrip({ code = 'good', tamper = false, keepCookie = true } = {}) {
  const s = await get('/api/auth/google/start'); const loc = new URL(s.headers.get('location')); const state = loc.searchParams.get('state') + (tamper ? 'x' : '');
  const nonce = cookieOf(s, 'bo_oauth');
  return get(`/api/auth/google/callback?code=${code}&state=${encodeURIComponent(state)}`, keepCookie ? nonce : undefined);
}
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  const h = await hashPassword('correct horse battery');
  for (const [e, r, a] of [['silvia@byother.net', 'Exec Assistant', true], ['gone@byother.net', 'Estimator', false]]) await q('INSERT INTO app_users(email,name,role,password_hash,active) VALUES ($1,$2,$3,$4,$5)', [e, e, r, h, a]);
  gl.setLoginFetch(google);
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('not set up: the sign-in page is told so, and starting is refused', async () => {
  const o = await (await get('/api/auth/options')).json(); assert.deepEqual([o.google, o.domain, o.redirectUri], [false, 'byother.net', 'https://desk.example.com/api/auth/google/callback']);
  assert.equal((await get('/api/auth/google/start')).status, 503);
  Object.assign(process.env, { GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret' }); assert.equal((await (await get('/api/auth/options')).json()).google, true);
});
test('start: goes to Google for openid and email, limited to the company domain, with a one-time value in the address and a cookie', async () => {
  const r = await get('/api/auth/google/start'); assert.equal(r.status, 302); const u = new URL(r.headers.get('location')), p = u.searchParams;
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth'); assert.deepEqual([p.get('client_id'), p.get('scope'), p.get('hd'), p.get('redirect_uri'), p.get('response_type')], ['gid', 'openid email profile', 'byother.net', 'https://desk.example.com/api/auth/google/callback', 'code']);
  assert.ok(cookieOf(r, 'bo_oauth')); assert.match(r.headers.getSetCookie().find((c) => c.startsWith('bo_oauth=')), /HttpOnly/);
});
test('a company Google account with an active login is signed in and lands on the dashboard', async () => {
  const r = await roundTrip(); assert.equal(r.status, 302); assert.equal(r.headers.get('location'), '/#/dashboard');
  const session = cookieOf(r, 'bo_session'); assert.ok(session); const me = await fetch(base + '/api/me', { headers: { cookie: session } }); assert.equal(me.status, 200); assert.equal((await me.json()).user.email, 'silvia@byother.net');
  assert.match(r.headers.getSetCookie().find((c) => c.startsWith('bo_oauth=')), /Max-Age=0/);   // the one-time cookie is cleared
});
test('refused: tampered state, a different browser, a bad code, no Back Office login, a switched-off login, unverified email, another domain', async () => {
  const back = async (opts) => { const r = await roundTrip(opts); assert.equal(r.status, 302); assert.equal(cookieOf(r, 'bo_session'), undefined, JSON.stringify(opts)); return decodeURIComponent(new URL(r.headers.get('location'), 'http://x').searchParams.get('login_error') || ''); };
  assert.match(await back({ tamper: true }), /not valid/); assert.match(await back({ keepCookie: false }), /not started in this browser/); assert.match(await back({ code: 'bad' }), /did not accept/);
  profile = { email: 'new.person@byother.net', email_verified: true, hd: 'byother.net' }; assert.match(await back({}), /new\.person@byother\.net does not have a Back Office login/);
  profile = { email: 'gone@byother.net', email_verified: true, hd: 'byother.net' }; assert.match(await back({}), /does not have a Back Office login/);   // inactive
  profile = { email: 'silvia@byother.net', email_verified: false, hd: 'byother.net' }; assert.match(await back({}), /not verified/);
  profile = { email: 'silvia@byother.net', email_verified: true }; assert.match(await back({}), /Use your @byother\.net/);                  // a personal account has no hosted domain
  profile = { email: 'silvia@byother.net', email_verified: true, hd: 'other.com' }; assert.match(await back({}), /Use your @byother\.net/);
  profile = { email: 'silvia@other.com', email_verified: true, hd: 'byother.net' }; assert.match(await back({}), /Use your @byother\.net/);
  const d = await get('/api/auth/google/callback?error=access_denied'); assert.match(decodeURIComponent(d.headers.get('location')), /did not allow/);
  profile = { email: 'silvia@byother.net', email_verified: true, hd: 'byother.net' };
});
test('the email match ignores capitals, and the domain setting can be changed', async () => {
  profile = { email: 'Silvia@ByOther.NET', email_verified: true, hd: 'byother.net' }; assert.ok(cookieOf(await roundTrip(), 'bo_session'));
  process.env.GOOGLE_LOGIN_DOMAIN = '@Example.com'; assert.equal(gl.domain(), 'example.com'); delete process.env.GOOGLE_LOGIN_DOMAIN; profile = { email: 'silvia@byother.net', email_verified: true, hd: 'byother.net' };
});
