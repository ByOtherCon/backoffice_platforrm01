import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
const { pool, q } = await import('../server/db.js');
const { server } = await import('../server/index.js');
const { hashPassword } = await import('../server/auth.js');
const { todayEastern, shift } = await import('../src/lib/estimating.ts');
const { addMonths } = await import('../src/lib/forecast.ts');

let base, owner, sub, asst, est, pm, field, pid, pid2, ptA;
// Billing history is pinned to calendar months (never "N days ago", which lands in a different month on the 1st-4th of a month).
const CUR = todayEastern().slice(0, 7), mid = (back) => `${addMonths(CUR, -back)}-15`, FIRST_PREV = `${addMonths(CUR, -1)}-01`;
const I3_DUE = ago31() >= FIRST_PREV ? ago31() : FIRST_PREV;   // the 90k invoice is about a month past due; a due date cannot precede its invoice date
const bucketOf = (due) => { const d = Math.round((Date.parse(todayEastern()) - Date.parse(due)) / 864e5); return d <= 0 ? 'Not due' : d <= 30 ? '1-30 days' : d <= 60 ? '31-60 days' : '61+ days'; };
function ago31() { return shift(todayEastern(), -31); }
const ago = (days) => shift(todayEastern(), -days);   // calendar days before the Eastern today, like the app (never days x 24 hours: a clock change would move the day)
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
  // billing history: 3 completed months at 30k/60k/90k plus this month 10k; the 90k invoice is about a month past due and unpaid
  for (const [n, date, due, amt] of [['I1', mid(3), null, 30000], ['I2', mid(2), null, 60000], ['I3', FIRST_PREV, I3_DUE, 90000], ['I4', ago(0), null, 10000]]) await q(`INSERT INTO client_invoices(project_id,project_trade_id,number,invoice_date,due_date,amount,retainage_held) VALUES ($1,$2,$3,$4,$5,$6,0)`, [pid, ptA, n, date, due, amt]);
});

test('dates the database stamps are Eastern, like the rest of the app (not the UTC date, which is a day ahead in the evening)', async () => {
  const [p] = await q(`SELECT logged_date::text AS d FROM projects WHERE id=$1`, [pid]); assert.equal(p.d, todayEastern());
  const rows = await q(`SELECT to_char(date_trunc('month', (now() AT TIME ZONE 'America/New_York')::date), 'YYYY-MM') AS m`); assert.equal(rows[0].m, todayEastern().slice(0, 7));
});

test('what each role sees', async () => {
  const keys = async (c) => Object.keys((await call('GET', '/api/dashboard/widgets', null, c)).body).filter((k) => !['role', 'widgets', 'period', 'all', 'prefs', 'defaults', 'locked'].includes(k)).sort();
  assert.equal((await call('GET', '/api/dashboard/widgets', null, field)).status, 403); assert.equal((await call('GET', '/api/dashboard/widgets')).status, 401);
  assert.deepEqual(await keys(est), ['estimating', 'messages', 'todos']);                                                                        // estimators: estimating and their own to-dos, no money
  assert.deepEqual(await keys(pm), ['costing', 'messages', 'presence', 'projects', 'todos']);
  assert.deepEqual((await call('GET', '/api/dashboard/widgets', null, asst)).body.widgets.includes('overhead'), false);              // overhead is for approvers
  const full = await keys(sub); for (const k of ['chart', 'costing', 'compliance', 'estimating', 'forecast', 'overhead', 'payables', 'presence', 'projects', 'receivables', 'todos', 'messages']) assert.ok(full.includes(k) || k === 'chart', k);
  assert.ok((await call('GET', '/api/dashboard/widgets', null, owner)).body.widgets.includes('overhead'));
  const p = (await call('GET', '/api/dashboard/widgets', null, pm)).body; assert.deepEqual(p.projects.map((x) => x.name), ['Project A']); assert.equal(p.costing.activeProjects, 1);   // only the PM's own project
});

test('macro costing, time clock presence, aging, payables, compliance', async () => {
  const d = (await call('GET', '/api/dashboard/widgets', null, owner)).body;
  assert.equal(d.costing.activeProjects, 2); assert.equal(d.costing.contract, 150000); assert.equal(d.costing.billed, 190000);
  assert.deepEqual(d.presence.active.map((a) => [a.employee, a.project, a.trade]), [['Alex', 'Project A', 'Demolition']]);
  assert.deepEqual(d.receivables.find((r) => r.bucket === bucketOf(I3_DUE)), { bucket: bucketOf(I3_DUE), amount: 90000 }); assert.equal(d.receivables.find((r) => r.bucket === 'No due date').amount, 100000);
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
  assert.deepEqual((await call('GET', '/api/prefs/dashboard', null, sub)).body, { ...layout, widgets: [...layout.widgets, { id: 'messages', visible: true }] }); assert.deepEqual((await call('GET', '/api/prefs/dashboard', null, owner)).body, {});   // messages was not listed, so it is added: it can never be left out
  assert.equal((await call('GET', '/api/dashboard/widgets', null, sub)).body.prefs.period, 'quarter');
  assert.equal((await call('PUT', '/api/prefs/dashboard', { widgets: [{ id: 'costing', visible: true }] }, est)).status, 400);       // estimator may not pin a money widget
  assert.equal((await call('PUT', '/api/prefs/dashboard', { widgets: [{ id: 'todos', visible: true }, { id: 'todos', visible: true }] }, est)).status, 400);
  assert.equal((await call('PUT', '/api/prefs/dashboard', { widgets: [{ id: 'todos', visible: 'yes' }] }, est)).status, 400);
  assert.equal((await call('PUT', '/api/prefs/dashboard', { widgets: [{ id: 'todos', visible: true }], period: 'decade' }, est)).status, 400);
  assert.equal((await call('PUT', '/api/prefs/secrets', {}, est)).status, 404); assert.equal((await call('PUT', '/api/prefs/dashboard', layout, field)).status, 401);
});

test('widgets have a size and a level of detail; the to-do list and messages can move but never be removed; each job has a starting layout', async () => {
  const put = (b, who) => call('PUT', '/api/prefs/dashboard', b, who);
  const ok = await put({ widgets: [{ id: 'projects', visible: true, size: 'XL', detail: 'full' }, { id: 'todos', visible: false, size: 'S', detail: 'compact' }, { id: 'messages', visible: true, size: 'L' }, { id: 'costing', visible: false }] }, sub); assert.equal(ok.status, 200);
  const saved = (await call('GET', '/api/prefs/dashboard', null, sub)).body.widgets; assert.deepEqual(saved.find((w) => w.id === 'projects'), { id: 'projects', visible: true, size: 'XL', detail: 'full' });
  assert.deepEqual(saved.find((w) => w.id === 'todos'), { id: 'todos', visible: true, size: 'S', detail: 'compact' });   // asked to hide it: it stays, but keeps the size
  assert.equal((await put({ widgets: [{ id: 'projects', visible: true, size: 'HUGE' }] }, sub)).status, 400); assert.equal((await put({ widgets: [{ id: 'projects', visible: true, detail: 'everything' }] }, sub)).status, 400);
  assert.equal((await put({ widgets: [{ id: 'estimating', visible: true }] }, est)).status, 200); assert.deepEqual((await call('GET', '/api/prefs/dashboard', null, est)).body.widgets.map((w) => w.id).sort(), ['estimating', 'messages', 'todos']);
  const d = (await call('GET', '/api/dashboard/widgets', null, est)).body; assert.deepEqual(d.locked.sort(), ['messages', 'todos']);
  const start = (c) => call('GET', '/api/dashboard/widgets', null, c).then((r) => r.body.defaults); const e = await start(pm); assert.equal(e[0].id, 'projects'); assert.deepEqual([e[0].size, e[0].visible], ['XL', true]);   // a project manager starts with the projects table, full width
  assert.deepEqual((await start(est)).map((w) => w.id), ['estimating', 'todos', 'messages']); const o = await start(owner); assert.ok(o.find((w) => w.id === 'overhead' && !w.visible));   // cards a role may have but does not start with are waiting in the tray
  assert.ok((await start(est)).every((w) => w.visible));
});
test('the messages card carries unread conversations', async () => {
  await q('DELETE FROM threads'); await call('POST', '/api/threads', { subject: 'Hello there', body: 'Ping about the job', memberIds: [(await q(`SELECT id FROM app_users WHERE email='est@x.net'`))[0].id] }, owner);
  const m = (await call('GET', '/api/dashboard/widgets', null, est)).body.messages; assert.equal(m.unread, 1); assert.deepEqual([m.items[0].subject, m.items[0].unread, m.items[0].preview], ['Hello there', 1, 'Ping about the job']);
});
