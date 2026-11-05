import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
process.env.PUBLIC_URL = 'https://desk.example.com/';
delete process.env.QBO_CLIENT_ID; delete process.env.QBO_CLIENT_SECRET;
const { pool, q } = await import('../server/db.js');
const { server } = await import('../server/index.js');
const { hashPassword } = await import('../server/auth.js');
let base;
const call = async (path, cookie) => { const r = await fetch(base + path, { headers: cookie ? { cookie } : {} }); const t = await r.text(); return { status: r.status, body: t ? JSON.parse(t) : null }; };
const login = async (email) => (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct horse battery' }) })).headers.get('set-cookie').split(';')[0];
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  const h = await hashPassword('correct horse battery');
  for (const [e, r] of [['owner@x.net', 'Super Admin'], ['sub@x.net', 'Sub Admin']]) await q('INSERT INTO app_users(email,name,role,password_hash) VALUES ($1,$2,$3,$4)', [e, e, r, h]);
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('QuickBooks status: owner only; shows the exact redirect address built from the site address, and which keys are missing', async () => {
  assert.equal((await call('/api/quickbooks/status')).status, 401); assert.equal((await call('/api/quickbooks/status', await login('sub@x.net'))).status, 403);
  const s = (await call('/api/quickbooks/status', await login('owner@x.net'))).body;
  assert.equal(s.redirectUri, 'https://desk.example.com/api/quickbooks/callback');   // the trailing slash on the site address does not double up
  assert.deepEqual([s.configured, s.connected, s.environment, s.needs], [false, false, 'production', ['QBO_CLIENT_ID', 'QBO_CLIENT_SECRET']]);
  Object.assign(process.env, { QBO_CLIENT_ID: 'id', QBO_CLIENT_SECRET: 'secret', QBO_ENVIRONMENT: 'sandbox' });
  const t = (await call('/api/quickbooks/status', await login('owner@x.net'))).body; assert.deepEqual([t.configured, t.environment, t.needs], [true, 'sandbox', []]);
});
