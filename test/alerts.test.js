import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
const { pool, q } = await import('../server/db.js');
const { server } = await import('../server/index.js');
const { hashPassword } = await import('../server/auth.js');
const cp = await import('../server/compliance.js');

let base, owner, office, ownerId, pid;
const call = async (method, path, body, cookie) => { const r = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); let b = null; try { b = t ? JSON.parse(t) : null; } catch { b = t; } return { status: r.status, body: b }; };
const login = async (email) => (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct horse battery' }) })).headers.get('set-cookie').split(';')[0];
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  const h = await hashPassword('correct horse battery');
  for (const [e, r] of [['owner@x.net', 'Super Admin'], ['office@x.net', 'Exec Assistant']]) await q('INSERT INTO app_users(email,name,role,password_hash) VALUES ($1,$1,$2,$3)', [e, r, h]);
  ownerId = (await q(`SELECT id FROM app_users WHERE email='owner@x.net'`))[0].id;
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`; owner = await login('owner@x.net'); office = await login('office@x.net');
  const [g] = await q(`INSERT INTO gcs(name) VALUES ('GC') RETURNING id`);
  [{ id: pid }] = await q(`INSERT INTO projects(name,gc_id,client,address) VALUES ('Job',$1,'C','A') RETURNING id`, [g.id]);
});
after(async () => { server.close(); await pool.end(); });

test('bell alerts can be cleared one at a time or all at once, for the person only, and the same alert is not raised again', async () => {
  await cp.notifyUser(ownerId, { kind: 'compliance', title: 'Insurance expiring', body: 'x', dedupe: 'd1' });
  await cp.notifyUser(ownerId, { kind: 'approval', title: 'Approval needed', body: 'y', dedupe: 'd2' });
  const list = async (c = owner) => (await call('GET', '/api/notifications', null, c)).body;
  assert.equal((await list()).length, 2);
  const first = (await list()).find((n) => n.title === 'Insurance expiring');
  assert.equal((await call('POST', '/api/notifications/clear', { ids: [first.id] }, office)).status, 200);   // another person's clear does nothing here
  assert.equal((await list()).length, 2);
  assert.equal((await call('POST', '/api/notifications/clear', { ids: [first.id] }, owner)).status, 200); assert.deepEqual((await list()).map((n) => n.title), ['Approval needed']);
  await cp.notifyUser(ownerId, { kind: 'compliance', title: 'Insurance expiring', body: 'x', dedupe: 'd1' });   // the scanner raises it again: it stays cleared
  assert.equal((await list()).length, 1);
  assert.equal((await call('POST', '/api/notifications/clear', { all: true }, owner)).status, 200); assert.deepEqual(await list(), []);
  assert.equal((await call('POST', '/api/notifications/clear', { all: true })).status, 401);
});

test('Projects page alerts can be cleared, stay cleared, come back when more serious, and can all be restored', async () => {
  const home = async (c = owner) => (await call('GET', '/api/projects/home', null, c)).body;
  const a = await home(); const noContract = a.alerts.find((x) => x.kind === 'contract'); assert.ok(noContract && noContract.key, JSON.stringify(a.alerts));
  assert.equal((await call('POST', '/api/projects/home/alerts/clear', { keys: [noContract.key] }, owner)).status, 200);
  const b = await home(); assert.ok(!b.alerts.some((x) => x.kind === 'contract')); assert.equal(b.clearedCount, 1); assert.equal(b.alertCount, a.alertCount - 1);
  assert.ok((await home(office)).alerts.some((x) => x.kind === 'contract'));   // it is cleared for the person who cleared it
  assert.equal((await call('POST', '/api/projects/home/alerts/clear', { keys: b.alerts.map((x) => x.key) }, owner)).status, 200);
  assert.deepEqual([(await home()).alerts.length, (await home()).clearedCount], [0, a.alertCount]);
  assert.equal((await call('POST', '/api/projects/home/alerts/clear', { restore: true }, owner)).status, 200);
  assert.equal((await home()).alertCount, a.alertCount);
});
