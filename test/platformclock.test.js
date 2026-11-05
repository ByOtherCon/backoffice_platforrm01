import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
const { pool, q } = await import('../server/db.js');
const { server } = await import('../server/index.js');
const { hashPassword } = await import('../server/auth.js');
const { todayEastern } = await import('../src/lib/estimating.ts');

let base, owner, silvia, juliana, ids = {}, empA, empB, pid, ptDemo;
const call = async (method, path, body, cookie) => { const r = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); let b = null; try { b = t ? JSON.parse(t) : null; } catch { b = t; } return { status: r.status, body: b }; };
const login = async (email) => (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct horse battery' }) })).headers.get('set-cookie').split(';')[0];
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  const h = await hashPassword('correct horse battery');
  for (const [e, r] of [['owner@x.net', 'Super Admin'], ['silvia@x.net', 'Exec Assistant'], ['juliana@x.net', 'Estimator']]) { const [u] = await q('INSERT INTO app_users(email,name,role,password_hash) VALUES ($1,$2,$3,$4) RETURNING id', [e, e.split('@')[0], r, h]); ids[e.split('@')[0]] = u.id; }
  [{ id: empA }, { id: empB }] = await Promise.all([q(`INSERT INTO employees(name,hourly_rate) VALUES ('Silvia Time',25) RETURNING id`).then((r) => r[0]), q(`INSERT INTO employees(name,hourly_rate) VALUES ('Spare',20) RETURNING id`).then((r) => r[0])]);
  const [g] = await q(`INSERT INTO gcs(name) VALUES ('GC') RETURNING id`); const [t] = await q(`INSERT INTO trades(name,sort) VALUES ('Demo',1) RETURNING id`);
  [{ id: pid }] = await q(`INSERT INTO projects(name,gc_id,client,address) VALUES ('Job',$1,'C','A') RETURNING id`, [g.id]); [{ id: ptDemo }] = await q('INSERT INTO project_trades(project_id,trade_id,original_amount) VALUES ($1,$2,50000) RETURNING id', [pid, t.id]);
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
  owner = await login('owner@x.net'); silvia = await login('silvia@x.net'); juliana = await login('juliana@x.net');
});
after(async () => { server.close(); await pool.end(); });

test('linking a login to an employee: owner only, one employee per login, active employees only; the login then knows it can clock', async () => {
  assert.equal((await call('GET', '/api/me', null, silvia)).body.user.clock, false); assert.equal((await call('GET', '/api/me/clock/home', null, silvia)).status, 403);
  assert.equal((await call('PUT', `/api/admin/users/${ids.silvia}`, { employeeId: empA }, silvia)).status, 403);
  assert.equal((await call('PUT', `/api/admin/users/${ids.silvia}`, { employeeId: empA }, owner)).status, 200);
  assert.equal((await call('PUT', `/api/admin/users/${ids.juliana}`, { employeeId: empA }, owner)).status, 400);        // already linked to Silvia
  await q('UPDATE employees SET active=false WHERE id=$1', [empB]); assert.equal((await call('PUT', `/api/admin/users/${ids.juliana}`, { employeeId: empB }, owner)).status, 400); await q('UPDATE employees SET active=true WHERE id=$1', [empB]);
  assert.equal((await call('GET', '/api/me', null, silvia)).body.user.clock, true); assert.equal((await call('GET', '/api/me', null, juliana)).body.user.clock, false);
  const u = (await call('GET', '/api/admin/users', null, owner)).body.find((x) => x.email === 'silvia@x.net'); assert.deepEqual([u.employee_id, u.employee], [empA, 'Silvia Time']);
});
test('clock in and out from inside the platform: the same clock, tied to project and trade, feeding Labor; others cannot use it', async () => {
  const home = (await call('GET', '/api/me/clock/home', null, silvia)).body; assert.equal(home.employee.name, 'Silvia Time'); assert.equal(home.open, null); assert.ok(home.projects.find((p) => p.id === pid).trades.length);
  assert.equal((await call('POST', '/api/me/clock/in', { projectId: pid, projectTradeId: ptDemo, gps: null }, silvia)).status, 200);
  assert.equal((await call('GET', '/api/me/clock/home', null, silvia)).body.open.project, 'Job'); assert.equal((await call('POST', '/api/me/clock/in', { projectId: pid, projectTradeId: ptDemo }, silvia)).status >= 400, true);   // already in
  await q(`UPDATE time_entries SET clock_in = now() - interval '2 hours' WHERE employee_id=$1 AND status='open'`, [empA]);   // a real shift, not an instant one
  assert.equal((await call('POST', '/api/me/clock/out', {}, silvia)).status, 200); assert.equal((await call('GET', '/api/me/clock/home', null, silvia)).body.open, null);
  assert.equal((await call('POST', '/api/me/clock/in', { projectId: pid, projectTradeId: ptDemo }, juliana)).status, 403);   // not linked
  const m = await call('POST', '/api/me/clock/manual', { date: todayEastern(), projectId: pid, projectTradeId: ptDemo, hours: 6, notes: 'Forgot to clock' }, silvia); assert.equal(m.status, 200, JSON.stringify(m.body));
  const labor = await q(`SELECT hours::float8 AS hours, rate::float8 AS rate FROM labor_entries WHERE employee_id=$1 AND project_trade_id=$2`, [empA, ptDemo]); assert.ok(labor.length >= 1); assert.ok(labor.reduce((n, l) => n + l.hours, 0) >= 6);   // it reaches the project's labor cost
  assert.equal((await call('GET', '/api/me/clock/home')).status, 401);
});
test('unlinking removes the clock, and creating a login can link in one step (a bad link keeps no login)', async () => {
  assert.equal((await call('PUT', `/api/admin/users/${ids.silvia}`, { employeeId: null }, owner)).status, 200); assert.equal((await call('GET', '/api/me/clock/home', null, silvia)).status, 403);
  const ok = await call('POST', '/api/admin/users', { email: 'crew@x.net', name: 'Crew', role: 'Project Manager', password: 'a long password here', employeeId: empB }, owner); assert.equal(ok.status, 200); assert.equal(ok.body.employee_id, empB);
  const bad = await call('POST', '/api/admin/users', { email: 'dupe@x.net', name: 'Dupe', role: 'Estimator', password: 'a long password here', employeeId: empB }, owner); assert.equal(bad.status, 400);
  assert.equal((await q(`SELECT count(*)::int n FROM app_users WHERE email='dupe@x.net'`))[0].n, 0);
});
