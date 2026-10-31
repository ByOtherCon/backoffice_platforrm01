import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
const { pool, q } = await import('../server/db.js');
const { server } = await import('../server/index.js');
const { hashPassword } = await import('../server/auth.js');

let base;
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await applyAll(pool);
  const h = await hashPassword('correct horse battery');
  for (const [email, role] of [['owner@byother.net', 'Super Admin'], ['office@byother.net', 'Exec Assistant'], ['pm@byother.net', 'Project Manager'], ['emp@byother.net', 'Employee']])
    await q('INSERT INTO app_users(email,name,role,password_hash) VALUES ($1,$1,$2,$3)', [email, role, h]);
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

async function call(method, path, body, cookie) {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
const loginAs = async (email) => (await call('POST', '/api/login', { email, password: 'correct horse battery' })).cookie;

test('unauthenticated requests are rejected', async () => {
  assert.equal((await call('GET', '/api/projects')).status, 401);
  assert.equal((await call('GET', '/api/me')).status, 401);
});

test('wrong password fails, and 5 failures lock the account for 15 minutes', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/api/login', { email: 'emp@byother.net', password: 'nope-nope-nope' })).status, 401);
  assert.equal((await call('POST', '/api/login', { email: 'emp@byother.net', password: 'correct horse battery' })).status, 429);
  assert.equal((await call('POST', '/api/login', { email: 'nobody@x.com', password: 'whatever-long' })).status, 401);
});

let owner, office, pm, gcId, t1, t2, projectId, ptDemo;
test('owner signs in; session cookie is HttpOnly', async () => {
  const r = await call('POST', '/api/login', { email: 'owner@byother.net', password: 'correct horse battery' });
  assert.equal(r.status, 200); owner = r.cookie;
  const raw = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@byother.net', password: 'correct horse battery' }) });
  assert.match(raw.headers.get('set-cookie'), /HttpOnly/);
  assert.equal((await call('GET', '/api/me', null, owner)).body.user.role, 'Super Admin');
  office = await loginAs('office@byother.net'); pm = await loginAs('pm@byother.net');
});

test('roles: Employee cannot reach projects; PM cannot create admin records; only Admin manages users', async () => {
  await q(`UPDATE app_users SET active=true WHERE email='emp@byother.net'`);
  assert.equal((await call('GET', '/api/projects', null, await (async () => { await q('DELETE FROM login_attempts'); return loginAs('emp@byother.net'); })())).status, 403);
  assert.equal((await call('POST', '/api/admin/gcs', { name: 'X' }, pm)).status, 403);
  assert.equal((await call('GET', '/api/admin/users', null, office)).status, 403);
  assert.equal((await call('GET', '/api/admin/users', null, owner)).status, 200);
});

test('admin creates trades and a GC; duplicates and bad input are refused', async () => {
  t1 = (await call('POST', '/api/admin/trades', { name: 'Demolition', sort: 1 }, office)).body;
  t2 = (await call('POST', '/api/admin/trades', { name: 'Framing & Drywall', sort: 2 }, office)).body;
  assert.equal((await call('POST', '/api/admin/trades', { name: 'Demolition' }, office)).status, 409);
  gcId = (await call('POST', '/api/admin/gcs', { name: "O'Brien Builders" }, owner)).body.id;
  assert.equal((await call('POST', '/api/admin/suppliers', { name: 'S', provider_type: 'Bogus' }, owner)).status, 400);
  assert.equal((await call('POST', '/api/admin/employees', { name: 'E', hourly_rate: 10.123 }, owner)).status, 400);
  assert.equal((await call('POST', '/api/admin/subcontractors', { name: '' }, owner)).status, 400);
});

test('new project setup with trades and contract amounts; rolled up correctly', async () => {
  const bad = await call('POST', '/api/projects', { name: 'P', gcId, client: 'C', address: 'A', trades: [] }, office);
  assert.equal(bad.status, 400);
  const dup = await call('POST', '/api/projects', { name: 'P', gcId, client: 'C', address: 'A', trades: [{ tradeId: t1.id, amount: 1 }, { tradeId: t1.id, amount: 2 }] }, office);
  assert.equal(dup.status, 400);
  const r = await call('POST', '/api/projects', { name: 'Wingstop - St Cloud', gcId, client: 'CW Hayes', address: '1 Main St', contractUrl: 'https://example.com/c.pdf',
    trades: [{ tradeId: t1.id, amount: 25000 }, { tradeId: t2.id, amount: 132000.5 }] }, office);
  assert.equal(r.status, 200); projectId = r.body.id;
  const p = (await call('GET', `/api/projects/${projectId}`, null, office)).body;
  assert.equal(p.trades.length, 2);
  assert.equal(p.totals.contract, 157000.5);
  assert.equal(p.project.contractUrl, 'https://example.com/c.pdf');
  ptDemo = p.trades.find((t) => t.name === 'Demolition').id;
  assert.equal((await call('POST', '/api/projects', { name: 'X', gcId, client: 'C', address: 'A', contractUrl: 'http://insecure.example', trades: [{ tradeId: t1.id, amount: 1 }] }, office)).status, 400);
});

test('PM sees only assigned projects', async () => {
  assert.equal((await call('GET', `/api/projects/${projectId}`, null, pm)).status, 403);
  assert.equal((await call('GET', '/api/projects', null, pm)).body.length, 0);
  await q('INSERT INTO project_members SELECT $1, id FROM app_users WHERE email=$2', [projectId, 'pm@byother.net']);
  assert.equal((await call('GET', `/api/projects/${projectId}`, null, pm)).status, 200);
});

test('change orders: only approved COs change the contract; totals tally; CRUD works', async () => {
  const co = (b) => call('POST', `/api/projects/${projectId}/change-orders`, b, office);
  const a = await co({ number: 'CO-001', description: 'Partition revision', projectTradeId: ptDemo, status: 'Approved', approvedDate: '2026-09-08', amount: 5000 });
  assert.equal(a.status, 200);
  const pend = await co({ number: 'CO-002', description: 'Extra scope', projectTradeId: ptDemo, status: 'Pending', amount: 2000 });
  assert.equal(pend.status, 200);
  let p = (await call('GET', `/api/projects/${projectId}`, null, office)).body;
  assert.equal(p.trades.find((t) => t.id === ptDemo).contract, 30000);
  assert.deepEqual(p.coTotals, { approved: 5000, pending: 2000 });
  // approve the pending one
  assert.equal((await call('PUT', `/api/projects/${projectId}/change-orders/${pend.body.id}`, { status: 'Approved' }, office)).status, 400); // no date yet
  assert.equal((await call('PUT', `/api/projects/${projectId}/change-orders/${pend.body.id}`, { status: 'Approved', approvedDate: '2026-09-20' }, office)).status, 200);
  p = (await call('GET', `/api/projects/${projectId}`, null, office)).body;
  assert.equal(p.trades.find((t) => t.id === ptDemo).contract, 32000);
  assert.equal((await call('DELETE', `/api/projects/${projectId}/change-orders/${pend.body.id}`, null, office)).status, 200);
  p = (await call('GET', `/api/projects/${projectId}`, null, office)).body;
  assert.equal(p.trades.find((t) => t.id === ptDemo).contract, 30000);
  // validation
  assert.equal((await co({ number: 'CO-001', description: 'dup', projectTradeId: ptDemo, status: 'Pending', amount: 1 })).status, 409);
  assert.equal((await co({ number: 'CO-9', description: 'x', projectTradeId: ptDemo, status: 'Pending', amount: 1.005 })).status, 400);
  assert.equal((await co({ number: 'CO-9', description: 'x', projectTradeId: ptDemo, status: 'Approved', amount: 10 })).status, 400);
  assert.equal((await co({ number: 'CO-9', description: 'x', projectTradeId: ptDemo, status: 'Maybe', amount: 10 })).status, 400);
});

test('a change that would push contract below what is already billed is refused', async () => {
  await q(`INSERT INTO client_invoices(project_id,project_trade_id,number,invoice_date,amount,retainage_held) VALUES ($1,$2,'INV-1','2026-10-01',28000,2800)`, [projectId, ptDemo]);
  const r = await call('POST', `/api/projects/${projectId}/change-orders`, { number: 'CO-NEG', description: 'deduct', projectTradeId: ptDemo, status: 'Approved', approvedDate: '2026-10-02', amount: -4000 }, office);
  assert.equal(r.status, 400); assert.match(r.body.error, /Billed to date/);
  assert.equal((await call('PUT', `/api/projects/${projectId}/trades/${ptDemo}`, { amount: 10000 }, office)).status, 400);
  const p = (await call('GET', `/api/projects/${projectId}`, null, office)).body;
  const demo = p.trades.find((t) => t.id === ptDemo);
  assert.equal(demo.contract, 30000); assert.equal(demo.billed, 28000); assert.equal(demo.retainageOutstanding, 2800); assert.equal(demo.currentlyDue, 25200);
});

test('trade with billing cannot be removed; dashboard totals add up', async () => {
  assert.equal((await call('DELETE', `/api/projects/${projectId}/trades/${ptDemo}`, null, office)).status, 409);
  const d = (await call('GET', '/api/dashboard', null, office)).body;
  assert.equal(d.activeProjects, 1); assert.equal(d.contract, 162000.5); assert.equal(d.billed, 28000);
  assert.equal(d.byGc[0].gc, "O'Brien Builders");
});

test('admin records in use cannot be deleted; unknown/invalid ids are safe', async () => {
  assert.equal((await call('DELETE', `/api/admin/gcs/${gcId}`, null, owner)).status, 409);
  assert.equal((await call('GET', '/api/projects/not-a-uuid', null, owner)).status, 404);
  assert.equal((await call('GET', `/api/projects/00000000-0000-0000-0000-000000000000`, null, owner)).status, 404);
});

test('users: short passwords refused; deactivating a user ends their sessions; cannot demote self', async () => {
  assert.equal((await call('POST', '/api/admin/users', { email: 'new@byother.net', role: 'Exec Assistant', password: 'short' }, owner)).status, 400);
  const u = (await call('POST', '/api/admin/users', { email: 'temp@byother.net', name: 'T', role: 'Exec Assistant', password: 'a long enough pass' }, owner)).body;
  const c = (await call('POST', '/api/login', { email: 'temp@byother.net', password: 'a long enough pass' })).cookie;
  assert.equal((await call('GET', '/api/me', null, c)).status, 200);
  await call('PUT', `/api/admin/users/${u.id}`, { active: false }, owner);
  assert.equal((await call('GET', '/api/me', null, c)).status, 401);
  const me = (await call('GET', '/api/me', null, owner)).body.user;
  assert.equal((await call('PUT', `/api/admin/users/${me.id}`, { role: 'Exec Assistant' }, owner)).status, 400);
  assert.equal((await call('PUT', `/api/admin/users/${me.id}`, { active: false }, owner)).status, 400);
  assert.equal((await call('POST', '/api/admin/users', { email: 'second@byother.net', role: 'Super Admin', password: 'a long enough pass' }, owner)).status, 400); // only one Super Admin
  assert.equal((await call('PUT', `/api/admin/users/${u.id}`, { role: 'Super Admin' }, owner)).status, 400);
});

test('static files served; path traversal blocked; security headers set', async () => {
  const bad = await fetch(base + '/..%2fserver%2fdb.js'); assert.equal(bad.status, 404);
  const bad2 = await fetch(base + '/%2e%2e/package.json'); assert.equal(bad2.status, 404);
  const r = await fetch(base + '/nope.html'); assert.equal(r.status, 404);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
});

test('logout invalidates the session', async () => {
  const c = await loginAs('office@byother.net');
  await call('POST', '/api/logout', {}, c);
  assert.equal((await call('GET', '/api/me', null, c)).status, 401);
});
