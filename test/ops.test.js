import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll, dbFiles } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
const { pool, q } = await import('../server/db.js');
const { server } = await import('../server/index.js');
const { bootstrapOwner } = await import('../server/bootstrap.js');
let base;
before(async () => { await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`; });
after(async () => { server.close(); await pool.end(); });
test('migrations run once each; running again changes nothing', async () => {
  const first = await applyAll(pool); assert.equal(first.length, dbFiles().length);
  assert.deepEqual(await applyAll(pool), []);
  assert.equal((await q('SELECT count(*)::int n FROM schema_migrations'))[0].n, dbFiles().length);
});
test('health check works without signing in and reveals nothing', async () => {
  const r = await fetch(base + '/api/health'); assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true });
});
test('first start creates the owner once; it never overwrites an existing login', async () => {
  assert.equal((await bootstrapOwner({})).created, false);
  assert.equal((await bootstrapOwner({ ADMIN_EMAIL: 'owner@byother.net', ADMIN_PASSWORD: 'short' })).created, false);
  const r = await bootstrapOwner({ ADMIN_EMAIL: ' Owner@ByOther.net ', ADMIN_PASSWORD: 'a long enough password' }); assert.deepEqual(r, { created: true, email: 'owner@byother.net' });
  const u = (await q('SELECT email, role, password_hash FROM app_users'))[0]; assert.deepEqual([u.email, u.role], ['owner@byother.net', 'Super Admin']); assert.ok(u.password_hash.startsWith('scrypt$'));
  assert.equal((await q('SELECT count(*)::int n FROM trades'))[0].n, 7);
  assert.deepEqual(await bootstrapOwner({ ADMIN_EMAIL: 'evil@x.com', ADMIN_PASSWORD: 'another long password' }), { created: false, reason: 'users exist' });
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@byother.net', password: 'a long enough password' }) }); assert.equal(login.status, 200);
});
