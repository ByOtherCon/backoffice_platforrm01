import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
process.env.PUBLIC_URL = 'https://desk.example.com/'; process.env.SECRET_KEY = 'test-secret-key-0123456789';
delete process.env.QBO_CLIENT_ID; delete process.env.QBO_CLIENT_SECRET; delete process.env.QBO_ENVIRONMENT;
const { pool, q } = await import('../server/db.js');
const { server } = await import('../server/index.js');
const { hashPassword } = await import('../server/auth.js');
const qbo = await import('../server/quickbooks.js');
let base, owner, sub, calls = [], refreshN = 0, staleOnce = false, grantOk = true;
// a small stand-in for Intuit: token endpoint, company info and a query
const intuit = async (url, init = {}) => {
  const u = new URL(url); calls.push({ url: String(url), method: init.method || 'GET', auth: init.headers?.authorization, body: init.body ? String(init.body) : null });
  const res = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  if (u.hostname === 'oauth.platform.intuit.com') {
    const p = new URLSearchParams(String(init.body));
    if (p.get('grant_type') === 'authorization_code') return grantOk && p.get('code') === 'good-code' ? res({ access_token: 'acc1', refresh_token: 'ref1', expires_in: 3600, x_refresh_token_expires_in: 8726400 }) : res({ error: 'invalid_grant' }, 400);
    if (p.get('grant_type') === 'refresh_token') return p.get('refresh_token') === `ref${refreshN + 1}` ? res({ access_token: 'acc' + (++refreshN + 1), refresh_token: 'ref' + (refreshN + 1), expires_in: 3600 }) : res({ error: 'invalid_grant' }, 400);
  }
  if (u.hostname.endsWith('quickbooks.api.intuit.com')) {
    if (staleOnce) { staleOnce = false; return res({}, 401); }
    if (u.pathname.endsWith('/companyinfo/9130')) return res({ CompanyInfo: { CompanyName: 'Sandbox Company_US_1' } });
    if (u.pathname.endsWith('/query')) return res({ QueryResponse: { Invoice: [{ Id: '1' }] } });
  }
  return res({}, 404);
};
const call = async (method, path, cookie) => { const r = await fetch(base + path, { method, redirect: 'manual', headers: cookie ? { cookie } : {} }); const t = await r.text(); let b = null; try { b = t ? JSON.parse(t) : null; } catch { b = t; } return { status: r.status, body: b, location: r.headers.get('location') }; };
const login = async (email) => (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct horse battery' }) })).headers.get('set-cookie').split(';')[0];
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  const h = await hashPassword('correct horse battery');
  for (const [e, r] of [['owner@x.net', 'Super Admin'], ['sub@x.net', 'Sub Admin']]) await q('INSERT INTO app_users(email,name,role,password_hash) VALUES ($1,$2,$3,$4)', [e, e, r, h]);
  qbo.setIntuitFetch(intuit);
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
  owner = await login('owner@x.net'); sub = await login('sub@x.net');
});
after(async () => { server.close(); await pool.end(); });

test('status: owner only; shows the exact redirect address built from the site address, and which keys are missing', async () => {
  assert.equal((await call('GET', '/api/quickbooks/status')).status, 401); assert.equal((await call('GET', '/api/quickbooks/status', sub)).status, 403);
  const s = (await call('GET', '/api/quickbooks/status', owner)).body;
  assert.equal(s.redirectUri, 'https://desk.example.com/api/quickbooks/callback');   // the trailing slash on the site address does not double up
  assert.deepEqual([s.configured, s.connected, s.environment, s.needs], [false, false, 'production', ['QBO_CLIENT_ID', 'QBO_CLIENT_SECRET']]);
  assert.equal((await call('GET', '/api/quickbooks/connect', owner)).status, 503);   // no keys yet
  Object.assign(process.env, { QBO_CLIENT_ID: 'cid', QBO_CLIENT_SECRET: 'csecret', QBO_ENVIRONMENT: 'sandbox' });
  const t = (await call('GET', '/api/quickbooks/status', owner)).body; assert.deepEqual([t.configured, t.environment, t.needs], [true, 'sandbox', []]);
});
test('connecting: owner only, signed state, token exchange with the keys, company name saved, refresh token stored sealed', async () => {
  assert.equal((await call('GET', '/api/quickbooks/connect', sub)).status, 403);
  const url = new URL((await call('GET', '/api/quickbooks/connect', owner)).body.url), p = url.searchParams;
  assert.equal(url.origin + url.pathname, 'https://appcenter.intuit.com/connect/oauth2'); assert.deepEqual([p.get('client_id'), p.get('scope'), p.get('response_type'), p.get('redirect_uri')], ['cid', 'com.intuit.quickbooks.accounting', 'code', 'https://desk.example.com/api/quickbooks/callback']);
  const state = p.get('state');
  assert.equal((await call('GET', `/api/quickbooks/callback?code=good-code&realmId=9130&state=${encodeURIComponent(state + 'x')}`, owner)).status, 400);   // tampered state
  assert.equal((await call('GET', `/api/quickbooks/callback?code=good-code&state=${encodeURIComponent(state)}`, owner)).status, 400);                   // no company chosen
  assert.equal((await call('GET', `/api/quickbooks/callback?code=bad&realmId=9130&state=${encodeURIComponent(state)}`, owner)).status, 400);
  assert.equal((await call('GET', `/api/quickbooks/callback?code=good-code&realmId=9130&state=${encodeURIComponent(state)}`, sub)).status, 403);
  calls = []; const ok = await call('GET', `/api/quickbooks/callback?code=good-code&realmId=9130&state=${encodeURIComponent(state)}`, owner); assert.equal(ok.status, 302); assert.equal(ok.location, '/#/admin/connections');
  const tok = calls.find((c) => c.url.includes('/tokens/bearer')); assert.equal(tok.auth, 'Basic ' + Buffer.from('cid:csecret').toString('base64')); assert.match(tok.body, /grant_type=authorization_code/);
  assert.ok(calls.some((c) => c.url.startsWith('https://sandbox-quickbooks.api.intuit.com/v3/company/9130/companyinfo/9130')));   // sandbox keys talk to the sandbox server
  const s = (await call('GET', '/api/quickbooks/status', owner)).body; assert.deepEqual([s.connected, s.company, s.realmId, s.connectedEnvironment], [true, 'Sandbox Company_US_1', '9130', 'sandbox']);
  const raw = JSON.stringify((await q(`SELECT data FROM integrations WHERE name='quickbooks'`))[0].data); assert.ok(!raw.includes('ref1') && !raw.includes('acc1'));   // sealed, not plain
});
test('reading: a stale token is refreshed once, and the NEW refresh token is kept (Intuit rotates them)', async () => {
  calls = []; staleOnce = true;
  const r = await qbo.query('select * from Invoice'); assert.deepEqual(r.QueryResponse.Invoice, [{ Id: '1' }]);
  assert.equal(refreshN, 1); assert.ok(calls.some((c) => /grant_type=refresh_token/.test(c.body || '') && /refresh_token=ref1/.test(c.body)));
  staleOnce = true; await qbo.query('select * from Invoice'); assert.equal(refreshN, 2);   // the second refresh had to use ref2, the rotated one
  const [a, b] = await Promise.all([qbo.query('x'), qbo.query('y')]); assert.ok(a && b);
  assert.ok(calls.some((c) => c.url.includes('/v3/company/9130/query?') && c.url.includes('minorversion=75') && c.auth === 'Bearer acc2' || c.auth === 'Bearer acc3'));
});
test('a revoked connection says to reconnect; switching environment asks to reconnect; disconnect removes it', async () => {
  refreshN = 99; staleOnce = true; await assert.rejects(() => qbo.query('x'), /Reconnect QuickBooks/); refreshN = 2;
  process.env.QBO_ENVIRONMENT = 'production'; await assert.rejects(() => qbo.query('x'), /connected to the sandbox environment/); process.env.QBO_ENVIRONMENT = 'sandbox';
  assert.equal((await call('DELETE', '/api/quickbooks', sub)).status, 403); assert.equal((await call('DELETE', '/api/quickbooks', owner)).status, 200);
  assert.equal((await call('GET', '/api/quickbooks/status', owner)).body.connected, false); await assert.rejects(() => qbo.query('x'), /not connected/);
});
