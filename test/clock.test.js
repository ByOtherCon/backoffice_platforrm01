import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
const { pool, q } = await import('../server/db.js');
const { server } = await import('../server/index.js');
const { hashPassword } = await import('../server/auth.js');

let base, office, pm, pid, demo, dry, e1, e2, e1c, far;
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  const h = await hashPassword('correct horse battery');
  for (const [e, r] of [['office@x.net', 'Exec Assistant'], ['pm@x.net', 'Project Manager']]) await q('INSERT INTO app_users(email,name,role,password_hash) VALUES ($1,$1,$2,$3)', [e, r, h]);
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });
async function call(method, path, body, cookie) {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text(); return { status: res.status, body: t ? JSON.parse(t) : null, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
const login = async (email) => (await call('POST', '/api/login', { email, password: 'correct horse battery' })).cookie;
const clockLogin = async (id, pin) => call('POST', '/api/clock/login', { employeeId: id, pin });

test('setup: project with trades, two employees with PINs', async () => {
  office = await login('office@x.net'); pm = await login('pm@x.net');
  const t1 = (await call('POST', '/api/admin/trades', { name: 'Demolition' }, office)).body.id, t2 = (await call('POST', '/api/admin/trades', { name: 'Drywall' }, office)).body.id;
  const gc = (await call('POST', '/api/admin/gcs', { name: 'GC' }, office)).body.id;
  pid = (await call('POST', '/api/projects', { name: 'Site A', gcId: gc, client: 'C', address: 'A', trades: [{ tradeId: t1, amount: 50000 }, { tradeId: t2, amount: 50000 }] }, office)).body.id;
  const p = (await call('GET', `/api/projects/${pid}`, null, office)).body; demo = p.trades.find((t) => t.name === 'Demolition').id; dry = p.trades.find((t) => t.name === 'Drywall').id;
  e1 = (await call('POST', '/api/admin/employees', { name: 'Alex', hourly_rate: 20 }, office)).body;
  e2 = (await call('POST', '/api/admin/employees', { name: 'Blake', hourly_rate: 25 }, office)).body;
  assert.equal(e1.has_pin, false); assert.equal(e1.pin_hash, undefined);
  assert.equal((await call('PUT', `/api/admin/employees/${e1.id}/pin`, { pin: '12' }, office)).status, 400);
  assert.equal((await call('PUT', `/api/admin/employees/${e1.id}/pin`, { pin: '4821' }, pm)).status, 403);
  assert.equal((await call('PUT', `/api/admin/employees/${e1.id}/pin`, { pin: '4821' }, office)).status, 200);
  assert.equal((await call('PUT', `/api/admin/employees/${e2.id}/pin`, { pin: '7733' }, office)).status, 200);
  const list = (await call('GET', '/api/admin/employees', null, office)).body;
  assert.ok(list.every((e) => e.pin_hash === undefined) && list.find((e) => e.name === 'Alex').has_pin === true);
  assert.deepEqual((await call('GET', '/api/clock/roster')).body.map((e) => e.name), ['Alex', 'Blake']);
});

test('PIN sign-in: wrong PIN rejected, 5 misses lock the employee, a field session cannot reach office data', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await clockLogin(e2.id, '0000')).status, 401);
  assert.equal((await clockLogin(e2.id, '7733')).status, 429);
  assert.equal((await clockLogin('not-an-id', '1234')).status, 401);
  const r = await clockLogin(e1.id, '4821'); assert.equal(r.status, 200); e1c = r.cookie;
  assert.equal((await call('GET', '/api/projects', null, e1c)).status, 403);
  assert.equal((await call('GET', '/api/dashboard', null, e1c)).status, 403);
  assert.equal((await call('GET', '/api/time/entries', null, e1c)).status, 403);
  assert.equal((await call('GET', '/api/clock/home')).status, 401);
  assert.equal((await call('GET', '/api/clock/home', null, office)).status, 401); // office login is not a clock session
  await q('UPDATE employees SET pin_failed=0, pin_locked_until=NULL WHERE id=$1', [e2.id]);
});

test('clock home lists active projects with their trades from the project outline', async () => {
  const h = (await call('GET', '/api/clock/home', null, e1c)).body;
  assert.equal(h.open, null); assert.equal(h.projects.length, 1);
  assert.deepEqual(h.projects[0].trades.map((t) => t.name).sort(), ['Demolition', 'Drywall']);
});

test('clock in needs an active project and a trade on that project; one open shift at a time; geofence enforced', async () => {
  assert.equal((await call('POST', '/api/clock/in', { projectId: '00000000-0000-0000-0000-000000000000' }, e1c)).status, 400);
  assert.equal((await call('POST', '/api/clock/in', { projectId: pid, projectTradeId: '00000000-0000-0000-0000-000000000000' }, e1c)).status, 400);
  await q(`UPDATE projects SET lat=28.5383, lng=-81.3792, geofence_required=true, geofence_miles=1 WHERE id=$1`, [pid]);
  assert.equal((await call('POST', '/api/clock/in', { projectId: pid, projectTradeId: demo }, e1c)).status, 403);                       // no location
  assert.equal((await call('POST', '/api/clock/in', { projectId: pid, projectTradeId: demo, gps: { lat: 28.7, lng: -81.3 } }, e1c)).status, 403); // ~11 miles away
  const ok = await call('POST', '/api/clock/in', { projectId: pid, projectTradeId: demo, gps: { lat: 28.5390, lng: -81.3800, accuracy: 12 } }, e1c);
  assert.equal(ok.status, 200);
  assert.equal((await call('POST', '/api/clock/in', { projectId: pid, projectTradeId: demo, gps: { lat: 28.5390, lng: -81.3800 } }, e1c)).status, 409);
  const act = (await call('GET', '/api/time/active', null, office)).body;
  assert.deepEqual([act.length, act[0].employee, act[0].project, act[0].trade], [1, 'Alex', 'Site A', 'Demolition']);
  assert.equal((await call('GET', '/api/time/active', null, e1c)).status, 403);
});

test('clock out: trade hours must add up; labor posts to the project trades automatically', async () => {
  await q(`UPDATE time_entries SET clock_in = now() - interval '8 hours 30 minutes' WHERE status='open'`);
  assert.equal((await call('POST', '/api/clock/out', { lines: [{ projectTradeId: demo, hours: 5 }, { projectTradeId: dry, hours: 3 }] }, e1c)).status, 400); // 8.0 of 8.5
  assert.equal((await call('POST', '/api/clock/out', { lines: [{ projectTradeId: '00000000-0000-0000-0000-000000000000', hours: 8.5 }] }, e1c)).status, 400);
  const out = await call('POST', '/api/clock/out', { lines: [{ projectTradeId: demo, hours: 5.5 }, { projectTradeId: dry, hours: 3 }], notes: 'done' }, e1c);
  assert.equal(out.status, 200); assert.equal(out.body.totalHours, 8.5);
  assert.equal((await call('POST', '/api/clock/out', {}, e1c)).status, 409);
  const costs = (await call('GET', `/api/projects/${pid}/costs`, null, office)).body.labor;
  assert.deepEqual(costs.map((l) => [l.trade, l.employee, l.hours, l.pay]), [['Demolition', 'Alex', 5.5, 110], ['Drywall', 'Alex', 3, 60]]);
  const p = (await call('GET', `/api/projects/${pid}`, null, office)).body;
  assert.equal(p.trades.find((t) => t.name === 'Demolition').laborCost, 110); assert.equal(p.totals.laborCost, 170);
  assert.equal((await call('GET', '/api/time/active', null, office)).body.length, 0);
});

test('weekly overtime: hours past 40 cost 1.5x, shared across the week, and follow the entries when edited', async () => {
  // Alex already has 8.5h on today's week; use a clean past week for exact numbers
  const day = (d) => `2026-09-0${d}`; // Mon 7 Sep 2026 is day 7 -> use 7,8,9,10 plus 11
  for (const d of ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11']) {
    const r = await call('POST', '/api/clock/manual', { date: d, projectId: pid, projectTradeId: demo, hours: 9 }, e1c); assert.equal(r.status, 200);
  }
  const wk = (await call('GET', `/api/projects/${pid}/costs`, null, office)).body.labor.find((l) => l.trade === 'Demolition');
  // this week's 5.5h*20=110 plus 45h in the past week: 40*20 + 5*30 = 950
  assert.equal(wk.pay, 110 + 950); assert.equal(wk.hours, 5.5 + 45);
  // office shortens one day: 36h -> no overtime at all
  const entries = (await call('GET', '/api/time/entries?from=2026-09-07&to=2026-09-11', null, office)).body;
  assert.equal(entries.length, 5); assert.ok(entries.every((e) => e.method === 'Manual'));
  const one = entries[0];
  assert.equal((await call('PUT', `/api/time/entries/${one.id}`, { totalHours: 4, lines: [{ projectTradeId: demo, hours: 3 }] }, office)).status, 400); // lines must match
  assert.equal((await call('PUT', `/api/time/entries/${one.id}`, { totalHours: 4, lines: [{ projectTradeId: demo, hours: 4 }] }, office)).status, 200);
  const after = (await call('GET', `/api/projects/${pid}/costs`, null, office)).body.labor.find((l) => l.trade === 'Demolition');
  assert.equal(after.hours, 5.5 + 40); assert.equal(after.pay, 110 + 40 * 20);
  assert.equal((await call('DELETE', `/api/time/entries/${one.id}`, null, office)).status, 200);
  const gone = (await call('GET', `/api/projects/${pid}/costs`, null, office)).body.labor.find((l) => l.trade === 'Demolition');
  assert.equal(gone.hours, 5.5 + 36); assert.equal(gone.pay, 110 + 36 * 20);
  assert.equal((await call('PUT', `/api/time/entries/${one.id}`, { notes: 'x' }, office)).status, 404);
});

test('manual entries cannot be in the future or absurd; money rules still hold', async () => {
  assert.equal((await call('POST', '/api/clock/manual', { date: '2099-01-01', projectId: pid, hours: 8 }, e1c)).status, 400);
  assert.equal((await call('POST', '/api/clock/manual', { date: '2026-09-07', projectId: pid, hours: 20 }, e1c)).status, 400);
  assert.equal((await call('POST', '/api/clock/manual', { date: '2026-13-07', projectId: pid, hours: 8 }, e1c)).status, 400);
});

test('settings: office can read, only approvers change; overtime rule change applies on recalculate', async () => {
  await q(`INSERT INTO app_users(email,name,role,password_hash) VALUES ('sub@x.net','s','Sub Admin',$1)`, [await hashPassword('correct horse battery')]);
  const sub = await login('sub@x.net');
  assert.equal((await call('GET', '/api/settings/timeclock', null, office)).status, 200);
  assert.equal((await call('PUT', '/api/settings/timeclock', { otAfter: 30 }, pm)).status, 403);
  assert.equal((await call('PUT', '/api/settings/timeclock', { otEnabled: false }, office)).status, 403); // Exec Assistant cannot change pay rules
  assert.equal((await call('PUT', '/api/settings/timeclock', { otAfter: 500 }, sub)).status, 400);
  assert.equal((await call('PUT', '/api/settings/timeclock', { dayStart: '7am' }, sub)).status, 400);
  // lower the overtime threshold: the 36h past week now has 6h of overtime (30h regular at $20 + 6h at $30)
  assert.equal((await call('PUT', '/api/settings/timeclock', { otAfter: 30 }, sub)).status, 200);
  assert.equal((await call('POST', '/api/time/recalculate', {}, sub)).status, 200);
  const l = (await call('GET', `/api/projects/${pid}/costs`, null, office)).body.labor.find((x) => x.trade === 'Demolition');
  assert.equal(l.pay, 5.5 * 20 + 30 * 20 + 6 * 30);
});
