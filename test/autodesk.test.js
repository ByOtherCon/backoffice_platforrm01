import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
Object.assign(process.env, { SECRET_KEY: 'a-long-test-secret-key-1234', PUBLIC_URL: 'https://desk.example' }); delete process.env.APS_CLIENT_ID; delete process.env.APS_CLIENT_SECRET;
const { pool, q } = await import('../server/db.js');
const { server } = await import('../server/index.js');
const { hashPassword } = await import('../server/auth.js');
const aps = await import('../server/autodesk.js');

const OPP = 'a'.repeat(12) + 'b'.repeat(12); let calls, tokenCalls, apiStatus;
const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o });
const standIn = async (url, init = {}) => {
  const u = new URL(url); calls.push(u.pathname + u.search);
  if (u.pathname.endsWith('/authentication/v2/token')) { tokenCalls.push({ body: new URLSearchParams(init.body), auth: init.headers.authorization }); const g = new URLSearchParams(init.body).get('grant_type');
    return g === 'authorization_code' ? json({ access_token: 'AT1', refresh_token: 'RT1', expires_in: 3600, scope: 'data:read' }) : json({ access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600 }); }
  if (!['Bearer AT1', 'Bearer AT2'].includes(init.headers?.authorization)) return json({}, 401);
  const p = u.pathname.replace('/construction/buildingconnected/v2/', '') + u.search;
  if (p === 'users/me') return json({ id: 'u1', email: 'Benny@ByOther.net', name: 'Benny Jr', company: { name: 'By Other Construction' } });
  if (p === 'offices?limit=20') return json({ results: [{ id: 'o1' }] });
  if (p === 'opportunities/' + OPP) return apiStatus === 200 ? json({ id: OPP, name: 'Zara - Orlando', bidDueAt: '2026-11-20T21:00:00Z', client: { name: 'Dunham GC', address: { street: '500 Corporate Dr' } }, secretToken: 'x' }) : json({ error: 'forbidden' }, apiStatus);
  if (p === 'opportunities?limit=5') return json({ results: [{ id: OPP, name: 'Zara' }, { id: 'zzz', name: 'Other' }] });
  return json({}, 404);
};
let base, owner, sub;
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool); calls = []; tokenCalls = []; apiStatus = 200; aps.setApsFetch(standIn);
  const h = await hashPassword('correct horse battery'); for (const [e, r] of [['owner@x.net', 'Super Admin'], ['sub@x.net', 'Sub Admin']]) await q('INSERT INTO app_users(email,name,role,password_hash) VALUES ($1,$1,$2,$3)', [e, r, h]);
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });
async function call(method, path, body, cookie) { const res = await fetch(base + path, { method, redirect: 'manual', headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }); const t = await res.text(); let b = null; try { b = t ? JSON.parse(t) : null; } catch { b = t; } return { status: res.status, body: b, headers: res.headers }; }
const login = async (email) => { const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct horse battery' }) }); return r.headers.get('set-cookie').split(';')[0]; };

test('not set up: the card says what is missing and the callback address to register', async () => {
  owner = await login('owner@x.net'); sub = await login('sub@x.net');
  const s = (await call('GET', '/api/autodesk/status', null, owner)).body; assert.deepEqual([s.configured, s.connected, s.callback], [false, false, 'https://desk.example/api/autodesk/callback']);
  const c = await call('POST', '/api/autodesk/connect', {}, owner); assert.equal(c.status, 503); assert.match(c.body.error, /APS_CLIENT_ID/);
  Object.assign(process.env, { APS_CLIENT_ID: 'client-id-123', APS_CLIENT_SECRET: 'client-secret-456' });
});

test('connecting: only the Super Admin, read-only scope, PKCE, a one-time state, and the lasting key is stored encrypted', async () => {
  assert.equal((await call('POST', '/api/autodesk/connect', {}, sub)).status, 403);
  const u = new URL((await call('POST', '/api/autodesk/connect', {}, owner)).body.url);
  assert.equal(u.origin + u.pathname, 'https://developer.api.autodesk.com/authentication/v2/authorize'); assert.equal(u.searchParams.get('scope'), 'data:read'); assert.equal(u.searchParams.get('code_challenge_method'), 'S256'); assert.equal(u.searchParams.get('redirect_uri'), 'https://desk.example/api/autodesk/callback'); assert.equal(u.searchParams.get('client_id'), 'client-id-123');
  const state = u.searchParams.get('state'), challenge = u.searchParams.get('code_challenge');
  assert.equal((await call('GET', '/api/autodesk/callback?code=abc&state=nope', null, owner)).status, 400);                                  // unknown state
  assert.equal((await call('GET', `/api/autodesk/callback?code=abc&state=${state}`, null, sub)).status, 403);
  const ok = await call('GET', `/api/autodesk/callback?code=abc&state=${state}`, null, owner); assert.equal(ok.status, 302); assert.equal(ok.headers.get('location'), '/#/admin');
  const t = tokenCalls[0]; assert.equal(t.body.get('grant_type'), 'authorization_code'); assert.equal(t.auth, 'Basic ' + Buffer.from('client-id-123:client-secret-456').toString('base64'));
  assert.equal(crypto.createHash('sha256').update(t.body.get('code_verifier')).digest('base64url'), challenge);                                // the verifier matches the challenge that was sent
  assert.equal((await call('GET', `/api/autodesk/callback?code=abc&state=${state}`, null, owner)).status, 400);                              // a sign-in link works once
  const raw = JSON.stringify((await q(`SELECT data FROM integrations WHERE name='autodesk'`))[0].data); assert.ok(!raw.includes('RT1')); assert.ok(raw.includes('benny@byother.net'));
  const s = (await call('GET', '/api/autodesk/status', null, owner)).body; assert.deepEqual([s.connected, s.account, s.company], [true, 'benny@byother.net', 'By Other Construction']); assert.ok(!JSON.stringify(s).includes('RT1'));
});

test('check: reads one invitation and a short list and shows the fields Autodesk returned; only allowed reads are possible', async () => {
  assert.equal((await call('POST', '/api/autodesk/check', { link: OPP }, sub)).status, 403); assert.equal((await call('POST', '/api/autodesk/check', { link: 'https://app.buildingconnected.com/opportunities/nope' }, owner)).status, 400);
  const r = (await call('POST', '/api/autodesk/check', { link: `https://app.buildingconnected.com/opportunities/${OPP}/details` }, owner)).body;
  assert.deepEqual([r.account, r.offices, r.opportunity, r.list, r.listCount], ['Available', 'Available', 'Available', 'Available', 2]); assert.deepEqual(r.opportunityKeys.slice(0, 3), ['id', 'name', 'bidDueAt']); assert.match(r.sample, /Zara - Orlando/); assert.match(r.sample, /500 Corporate Dr/);
  assert.equal((await call('GET', '/api/autodesk/status', null, owner)).body.lastCheck.opportunityId, OPP); assert.equal((await call('GET', '/api/autodesk/status', null, sub)).body.lastCheck, undefined);   // the sample is for the Super Admin only
  await assert.rejects(() => aps.read('users/me/../../admin'), /not allowed/); await assert.rejects(() => aps.read('opportunities/short'), /not allowed/); await assert.rejects(() => aps.read('projects'), /not allowed/);
  apiStatus = 403; const no = (await call('POST', '/api/autodesk/check', { link: OPP }, owner)).body; assert.equal(no.opportunity, 'Not permitted by the current product access'); assert.equal(no.sample.includes('forbidden'), true); apiStatus = 200;
});

test('the access token is renewed from the stored key (and the new key is kept); a revoked key asks for a reconnect', async () => {
  const connect = async () => { const u = new URL((await call('POST', '/api/autodesk/connect', {}, owner)).body.url); await call('GET', `/api/autodesk/callback?code=abc&state=${u.searchParams.get('state')}`, null, owner); };
  await connect(); tokenCalls.length = 0; aps.expireTokenCache();
  const ok = await call('POST', '/api/autodesk/check', { link: OPP }, owner); assert.equal(ok.status, 200);
  assert.equal(tokenCalls.length, 1); assert.deepEqual([tokenCalls[0].body.get('grant_type'), tokenCalls[0].body.get('refresh_token'), tokenCalls[0].body.get('scope')], ['refresh_token', 'RT1', 'data:read']);
  const raw = JSON.stringify((await q(`SELECT data FROM integrations WHERE name='autodesk'`))[0].data); assert.ok(!raw.includes('RT2'));          // the rotated key is stored encrypted too
  aps.setApsFetch(async (url, init) => (new URL(url).pathname.endsWith('/token') ? json({ error: 'invalid_grant' }, 400) : standIn(url, init))); aps.expireTokenCache();
  const bad = await call('POST', '/api/autodesk/check', { link: OPP }, owner); assert.equal(bad.status, 503); assert.match(bad.body.error, /expired or was revoked/);
  const s = (await call('GET', '/api/autodesk/status', null, owner)).body; assert.deepEqual([s.connected, s.needsReconnect], [false, true]);
  aps.setApsFetch(standIn); assert.equal((await call('POST', '/api/autodesk/check', { link: OPP }, owner)).status, 409);                                   // asks to connect again, no guessing
  assert.equal((await call('DELETE', '/api/autodesk', null, sub)).status, 403); assert.equal((await call('DELETE', '/api/autodesk', null, owner)).status, 200); assert.equal((await call('GET', '/api/autodesk/status', null, owner)).body.account, null);
});
