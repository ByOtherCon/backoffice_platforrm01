import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
process.env.SECRET_KEY = 'test-secret-key-0123456789';
process.env.PUBLIC_URL = 'https://app.example';
const { pool, q } = await import('../server/db.js');
const { server } = await import('../server/index.js');
const { hashPassword } = await import('../server/auth.js');
const bd = await import('../server/bids.js');
let base, sent = [], canSend = true;
const PW = 'correct horse battery';
const gmail = async (url, opts = {}) => {
  if (String(url).includes('oauth2.googleapis.com')) return { ok: true, json: async () => ({ access_token: 'a', expires_in: 3000 }) };
  if (String(url).endsWith('/messages/send')) { sent.push(Buffer.from(JSON.parse(opts.body).raw, 'base64url').toString()); return { ok: true, json: async () => ({}) }; }
  return { ok: true, json: async () => ({}) };
};
async function call(method, path, body, cookie) {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text(); let b = null; try { b = t ? JSON.parse(t) : null; } catch { b = t; } return { status: res.status, body: b, res };
}
const login = async (email, password = PW) => { const r = await call('POST', '/api/login', { email, password }); return r.status === 200 ? r.res.headers.get('set-cookie').split(';')[0] : null; };
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  const h = await hashPassword(PW);
  for (const [e, r] of [['owner@x.net', 'Super Admin'], ['est@x.net', 'Estimator']]) await q('INSERT INTO app_users(email,name,role,password_hash) VALUES ($1,$2,$3,$4)', [e, e.split('@')[0], r, h]);
  bd.setGoogleFetch(gmail);
  process.env.GOOGLE_CLIENT_ID = 'id'; process.env.GOOGLE_CLIENT_SECRET = 'secret';
  await q(`INSERT INTO integrations(name,data) VALUES ('gmail',$1)`, [{ email: 'office@x.net', refresh: bd.seal('r'), canSend }]);
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('the owner can edit their own name and phone but not their access level', async () => {
  const owner = await login('owner@x.net'), id = (await q(`SELECT id FROM app_users WHERE email='owner@x.net'`))[0].id;
  const ok = await call('PUT', '/api/admin/users/' + id, { name: 'Benny Jr', title: 'Owner', phone: '407-555-0100' }, owner); assert.equal(ok.status, 200); assert.equal(ok.body.name, 'Benny Jr');
  assert.equal((await call('PUT', '/api/admin/users/' + id, { role: 'Estimator' }, owner)).status, 400);
});

test('changing your own password needs the current one and signs out other devices', async () => {
  const a = await login('est@x.net'), b = await login('est@x.net');
  assert.equal((await call('POST', '/api/me/password', { current: 'wrong wrong wrong', next: 'a brand new password' }, a)).status, 400);
  assert.equal((await call('POST', '/api/me/password', { current: PW, next: 'short' }, a)).status, 400);
  assert.equal((await call('POST', '/api/me/password', { current: PW, next: 'a brand new password' }, a)).status, 200);
  assert.equal((await call('GET', '/api/me', null, a)).status, 200);   // this device stays signed in
  assert.equal((await call('GET', '/api/me', null, b)).status, 401);   // the other one is signed out
  assert.equal(await login('est@x.net'), null); assert.ok(await login('est@x.net', 'a brand new password'));
  await call('POST', '/api/me/password', { current: 'a brand new password', next: PW }, a);
});

test('forgot password emails a one-time link and gives the same answer for unknown emails', async () => {
  sent = [];
  const known = await call('POST', '/api/password/forgot', { email: 'EST@x.net' }), unknown = await call('POST', '/api/password/forgot', { email: 'nobody@x.net' });
  assert.equal(known.status, 200); assert.deepEqual(known.body, unknown.body); assert.equal(sent.length, 1);
  assert.match(sent[0], /To: est@x\.net/); const token = sent[0].match(/\?reset=([\w-]+)/)[1];
  assert.equal((await call('GET', '/api/password/reset/' + token)).body.email, 'est@x.net');
  assert.equal((await call('POST', '/api/password/reset', { token, password: 'short' })).status, 400);
  assert.equal((await call('POST', '/api/password/reset', { token, password: 'my new reset password' })).status, 200);
  assert.ok(await login('est@x.net', 'my new reset password'));
  assert.equal((await call('POST', '/api/password/reset', { token, password: 'another password again' })).status, 400);   // used once
  assert.equal((await call('GET', '/api/password/reset/not-a-token')).status, 400);
  const [{ n }] = await q(`SELECT count(*)::int n FROM password_resets`); assert.equal(n, 1);
});

test('reset links expire and are limited to three requests an hour', async () => {
  sent = []; await call('POST', '/api/password/forgot', { email: 'est@x.net' });
  const token = sent[0].match(/\?reset=([\w-]+)/)[1]; await q(`UPDATE password_resets SET expires_at=now() - interval '1 minute'`);
  assert.equal((await call('POST', '/api/password/reset', { token, password: 'yet another password' })).status, 400);
  sent = []; for (let i = 0; i < 5; i++) await call('POST', '/api/password/forgot', { email: 'est@x.net' }); assert.equal(sent.length, 1);   // two were already used this hour
});
