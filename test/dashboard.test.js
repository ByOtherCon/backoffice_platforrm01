import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
const { pool, q } = await import('../server/db.js');
const { server } = await import('../server/index.js');
const { hashPassword } = await import('../server/auth.js');

let base, owner, sub, asst, est, pm, field, pid, pid2, ptA;
const ago = (days) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(Date.now() - days * 864e5));   // Eastern, like the app
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  const h = await hashPassword('correct horse battery');
  for (const [e, r] of [['owner@x.net', 'Super Admin'], ['sub@x.net', 'Sub Admin'], ['asst@x.net', 'Exec Assistant'], ['est@x.net', 'Estimator'], ['pm@x.net', 'Project Manager']]) await q('INSERT INTO app_users(email,name,role,password_hash) VALUES ($1,$1,$2,$3)', [e, r, h]);
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });
async function call(method, path, body, cookie) {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text(); return { status: res.status, body: t ? JSON.parse(t) : null };
}
const login = async (email) => { const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct horse battery' }) }); return r.headers.get('set-cookie').split(';')[0]; };

test('setup: two projects, billing history, costs, a clocked-in employee', async () => {
  owner = await login('owner@x.net'); sub = await login('sub@x.net'); asst = await login('asst@x.net'); est = await login('est@x.net'); pm = await login('pm@x.net');
  const t1 = (await call('POST', '/api/admin/trades', { name: 'Demolition' }, owner)).body.id, gc = (await call('POST', '/api/admin/gcs', { name: 'CW Hayes' }, owner)).body.id;
  pid = (await call('POST', '/api/projects', { name: 'Project A', gcId: gc, client: 'C', address: 'A', trades: [{ tradeId: t1, amount: 100000 }] }, owner)).body.id;
  pid2 = (await call('POST', '/api/projects', { name: 'Project B (not PMs)', gcId: gc, client: 'C', address: 'B', trades: [{ tradeId: t1, amount: 50000 }] }, owner)).body.id;
  await q('INSERT INTO project_members SELECT $1, id FROM app_users WHERE email=$2', [pid, 'pm@x.net']);
  ptA = (await call('GET', `/api/projects/${pid}`, null, owner)).body.trades[0].id;
  const v = (await call('POST', '/api/admin/subcontractors', { name: 'Atlas' }, owner)).body.id; const com = (await call('POST', `/api/projects/${pid}/commitments`, { projectTradeId: ptA, subcontractorId: v, contractAmount: 20000 }, owner)).body.id;
  await call('POST', `/api/projects/${pid}/commitments/${com}/bills`, { number: 'A1', date: ago(0), amount: 8000 }, owner);
  const s = (await call('POST', '/api/admin/suppliers', { name: 'Supply Co' }, owner)).body.id; await call('POST', '/api/supplier-invoices', { supplierId: s, reference: 'S1', date: ago(0), total: 2000, allocations: [{ projectId: pid, projectTradeId: ptA, amount: 2000 }] }, owner);
  const e = (await call('POST', '/api/admin/employees', { name: 'Alex', hourly_rate: 20 }, owner)).body; await call('PUT', `/api/admin/employees/${e.id}/pin`, { pin: '4821' }, owner);
  const r = await fetch(base + '/api/clock/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ employeeId: e.id, pin: '4821' }) }); field = r.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('POST', '/api/clock/in', { projectId: pid, projectTradeId: ptA }, field)).status, 200);
  // billing history: 3 completed months at 30k/60k/90k plus this month 10k; the 90k invoice is 31 days past due and unpaid
  for (const [n, d, due, amt] of [['I1', 95, null, 30000], ['I2', 65, null, 60000], ['I3', 35, ago(31), 90000], ['I4', 0, null, 10000]]) await q(`INSERT INTO client_invoices(project_id,project_trade_id,number,invoice_date,due_date,amount,retainage_held) VALUES ($1,$2,$3,$4,$5,$6,0)`, [pid, ptA, n, ago(d), due, amt]);
});

test('what each role sees', async () => {
  const keys = async (c) => Object.keys((await call('GET', '/api/dashboard/widgets', null, c)).body).filter((k) => !['role', 'widgets', 'period', 'all', 'prefs'].includes(k)).sort();
  assert.equal((await call('GET', '/api/dashboard/widgets', null, field)).status, 403); assert.equal((await call('GET', '/api/dashboard/widgets')).status, 401);
  assert.deepEqual(await keys(est), ['estimating', 'todos']);                                                                        // estimators: estimating and their own to-dos, no money
  assert.deepEqual(await keys(pm), ['costing', 'presence', 'projects', 'todos']);
  assert.deepEqual((await call('GET', '/api/dashboard/widgets', null, asst)).body.widgets.includes('overhead'), false);              // overhead is for approvers
  const full = await keys(sub); for (const k of ['chart', 'costing', 'compliance', 'estimating', 'forecast', 'overhead', 'payables', 'presence', 'projects', 'receivables', 'todos']) assert.ok(full.includes(k) || k === 'chart', k);
  assert.ok((await call('GET', '/api/dashboard/widgets', null, owner)).body.widgets.includes('overhead'));
  const p = (await call('GET', '/api/dashboard/widgets', null, pm)).body; assert.deepEqual(p.projects.map((x) => x.name), ['Project A']); assert.equal(p.costing.activeProjects, 1);   // only the PM's own project
});

test('macro costing, time clock presence, aging, payables, compliance', async () => {
  const d = (await call('GET', '/api/dashboard/widgets', null, owner)).body;
  assert.equal(d.costing.activeProjects, 2); assert.equal(d.costing.contract, 150000); assert.equal(d.costing.billed, 190000);
  assert.deepEqual(d.presence.active.map((a) => [a.employee, a.project, a.trade]), [['Alex', 'Project A', 'Demolition']]);
  assert.deepEqual(d.receivables.find((r) => r.bucket === '31-60 days'), { bucket: '31-60 days', amount: 90000 }); assert.equal(d.receivables.find((r) => r.bucket === 'No due date').amount, 100000);
  assert.equal(d.payables.total, 10000); assert.deepEqual(d.payables.top.map((t) => t.name), ['Atlas', 'Supply Co']);
  assert.deepEqual(d.compliance.vendorsBlocked, ['Atlas']); assert.equal(d.compliance.ntoNeeded, 2);
  assert.deepEqual(d.projects.map((p) => p.name), ['Project A', 'Project B (not PMs)']);
});

test('billed vs cost by month, and the forecast built from it', async () => {
  const d = (await call('GET', '/api/dashboard/widgets', null, owner)).body; assert.equal(d.series.length, 12);
  const cur = d.series.at(-1); assert.deepEqual([cur.revenue, cur.cost, cur.profit], [10000, 10000, 0]);
  assert.equal(d.series.reduce((n, m) => n + m.revenue, 0), 190000);
  assert.equal(d.forecast.month.pace, 60000);                                                  // (30k + 60k + 90k) / 3
  assert.ok(d.forecast.year.projected > d.forecast.year.billed); assert.ok(d.forecast.quarter.projected >= d.forecast.quarter.billed);
  assert.equal(d.forecast.backlog, 50000);                                                      // Project A is billed past its contract in this fixture; only B has work left to bill
});

test('forecast stays silent without history', async () => {
  await q('DELETE FROM client_invoices');
  const d = (await call('GET', '/api/dashboard/widgets', null, owner)).body; assert.equal(d.forecast.month.pace, null); assert.equal(d.forecast.year.projected, null);
});

test('saved layouts: per user, validated against the widgets that person may use', async () => {
  const layout = { widgets: [{ id: 'todos', visible: true }, { id: 'costing', visible: false }, { id: 'chart', visible: true }], period: 'quarter' };
  assert.equal((await call('PUT', '/api/prefs/dashboard', layout, sub)).status, 200);
  assert.deepEqual((await call('GET', '/api/prefs/dashboard', null, sub)).body, layout); assert.deepEqual((await call('GET', '/api/prefs/dashboard', null, owner)).body, {});
  assert.equal((await call('GET', '/api/dashboard/widgets', null, sub)).body.prefs.period, 'quarter');
  assert.equal((await call('PUT', '/api/prefs/dashboard', { widgets: [{ id: 'costing', visible: true }] }, est)).status, 400);       // estimator may not pin a money widget
  assert.equal((await call('PUT', '/api/prefs/dashboard', { widgets: [{ id: 'todos', visible: true }, { id: 'todos', visible: true }] }, est)).status, 400);
  assert.equal((await call('PUT', '/api/prefs/dashboard', { widgets: [{ id: 'todos', visible: 'yes' }] }, est)).status, 400);
  assert.equal((await call('PUT', '/api/prefs/dashboard', { widgets: [{ id: 'todos', visible: true }], period: 'decade' }, est)).status, 400);
  assert.equal((await call('PUT', '/api/prefs/secrets', {}, est)).status, 404); assert.equal((await call('PUT', '/api/prefs/dashboard', layout, field)).status, 401);
});
