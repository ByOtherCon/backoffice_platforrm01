import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
const { pool, q } = await import('../server/db.js');
const { server } = await import('../server/index.js');
const { hashPassword } = await import('../server/auth.js');
const { todayEastern, shift } = await import('../src/lib/estimating.ts');
const today = todayEastern(), year = Number(today.slice(0, 4));

let base, owner, pm, pmId, gc, trade, A, B, C, D;
const call = async (method, path, body, cookie) => { const r = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); let b = null; try { b = t ? JSON.parse(t) : null; } catch { b = t; } return { status: r.status, body: b }; };
const login = async (email) => (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct horse battery' }) })).headers.get('set-cookie').split(';')[0];
const mk = async (name, extra = {}) => (await call('POST', '/api/projects', { name, gcId: gc, client: 'C', address: '1 Main St, Orlando, FL 32801', retainagePct: 10, trades: [{ tradeId: trade, amount: 10000 }], ...extra }, owner)).body.id;
const home = async (who = owner, y) => (await call('GET', '/api/projects/home' + (y ? '?year=' + y : ''), null, who)).body;

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  const h = await hashPassword('correct horse battery');
  for (const [e, r] of [['owner@x.net', 'Super Admin'], ['pm@x.net', 'Project Manager']]) { const [u] = await q('INSERT INTO app_users(email,name,role,password_hash) VALUES ($1,$2,$3,$4) RETURNING id', [e, e.split('@')[0], r, h]); if (e === 'pm@x.net') pmId = u.id; }
  [{ id: gc }] = await q(`INSERT INTO gcs(name) VALUES ('Sachse') RETURNING id`); [{ id: trade }] = await q(`INSERT INTO trades(name,sort) VALUES ('Demo',1) RETURNING id`);
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`; owner = await login('owner@x.net'); pm = await login('pm@x.net');
  A = await mk('Alpha', { startDate: shift(today, -60) }); B = await mk('Bravo', { startDate: shift(today, -10) }); C = await mk('Charlie', { startDate: shift(today, 5) }); D = await mk('Delta');
  await q('UPDATE projects SET active=false WHERE id=$1', [B]); await q(`UPDATE projects SET start_date='${year - 1}-03-01', logged_date='${year - 1}-03-01' WHERE id=$1`, [D]);
  assert.equal((await call('PUT', `/api/projects/${A}/nto`, { firstFurnished: shift(today, -60) }, owner)).status, 200);   // work began 60 days ago: the 45-day notice is overdue
  await q('INSERT INTO project_members(project_id,user_id) VALUES ($1,$2)', [A, pmId]);
  await q(`INSERT INTO change_orders(project_id,project_trade_id,number,description,status,amount) VALUES ($1,(SELECT id FROM project_trades WHERE project_id=$1),'CO-1','x','Pending',500)`, [C]);
  await q(`INSERT INTO invoice_schedule(project_id,label,basis,amount,expected_date,status) VALUES ($1,'Mobilization','Stated in contract',1000,$2,'Tentative')`, [C, shift(today, 3)]);
});
after(async () => { server.close(); await pool.end(); });

test('the summary counts active and inactive projects for the year and the open notices; last year\'s open project rolls forward in the list', async () => {
  const d = await home(); assert.equal(d.year, year); assert.ok(d.years.includes(year) && d.years.includes(year - 1));
  assert.deepEqual([d.summary.active, d.summary.inactive], [2, 1]);   // Alpha and Charlie are active this year, Bravo is inactive, Delta started last year
  assert.equal(d.summary.contractActive, 20000); assert.deepEqual([d.summary.ntoNeeded, d.summary.ntoOverdue], [3, 1]);   // Alpha is past its 45 days; Charlie and last year's Delta are still open
  assert.deepEqual(d.rows.map((r) => r.name).sort(), ['Alpha', 'Bravo', 'Charlie', 'Delta']);   // Delta is active so it stays on the list
  const ly = await home(owner, year - 1); assert.deepEqual([ly.summary.active, ly.summary.inactive], [1, 0]); assert.equal((await home(owner, 1999)).year, year);   // a year with no projects falls back to this one
});

test('alerts and deadlines: overdue notice first, then what is due soon; each links to the place to fix it', async () => {
  const d = await home(); const a = d.alerts;
  assert.equal(a[0].severity, 'high'); assert.match(a[0].title, /Notice To Owner Overdue: Alpha/); assert.equal(a[0].link, `#/projects/${A}/docs`);
  assert.ok(a.some((x) => x.kind === 'schedule' && /Mobilization/.test(x.detail) && x.link === `#/projects/${C}/contract`)); assert.ok(a.some((x) => x.kind === 'co' && /1 waiting/.test(x.detail)));
  assert.ok(a.some((x) => x.kind === 'start' && /Charlie/.test(x.title))); assert.ok(a.some((x) => x.kind === 'contract' && /Alpha/.test(x.title)));
  assert.ok(!a.some((x) => /Bravo/.test(x.title)));   // inactive projects raise no alerts
  const order = a.map((x) => ({ high: 0, medium: 1, info: 2 })[x.severity]); assert.deepEqual(order, [...order].sort((x, y) => x - y));
});

test('the list is editable: start date, active flag and the notice to owner status (a sent notice needs its date); a project manager sees only theirs and cannot edit', async () => {
  assert.equal((await call('PUT', `/api/projects/${C}`, { startDate: shift(today, 9) }, owner)).status, 200); assert.equal((await home()).rows.find((r) => r.id === C).startDate, shift(today, 9));
  assert.equal((await call('PUT', `/api/projects/${C}`, { startDate: 'soon' }, owner)).status, 400);
  assert.equal((await call('PUT', `/api/projects/${A}/nto`, { status: 'Sent' }, owner)).status, 400); assert.equal((await call('PUT', `/api/projects/${A}/nto`, { status: 'Sent', sentDate: today }, owner)).status, 200);
  let d = await home(); assert.equal(d.rows.find((r) => r.id === A).nto.status, 'Sent'); assert.deepEqual([d.summary.ntoNeeded, d.summary.ntoOverdue], [2, 0]); assert.ok(!d.alerts.some((x) => /Overdue: Alpha/.test(x.title)));
  assert.equal((await call('PUT', `/api/projects/${C}`, { active: false }, owner)).status, 200); d = await home(); assert.deepEqual([d.summary.active, d.summary.inactive], [1, 2]); assert.ok(!d.alerts.some((x) => /Charlie/.test(x.title)));
  assert.equal((await call('PUT', `/api/projects/${C}`, { active: true }, owner)).status, 200);
  const p = await home(pm); assert.deepEqual(p.rows.map((r) => r.name), ['Alpha']); assert.equal(p.summary.active, 1);
  assert.equal((await call('PUT', `/api/projects/${A}`, { active: false }, pm)).status, 403);
});
