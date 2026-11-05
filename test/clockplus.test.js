import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
const { pool, q } = await import('../server/db.js');
const { server } = await import('../server/index.js');
const { hashPassword } = await import('../server/auth.js');
const tc = await import('../server/timeclock.js');
const { todayEastern, shift } = await import('../src/lib/estimating.ts');
const { weekStart } = await import('../src/lib/payroll.ts');
const today = todayEastern(), yesterday = shift(today, -1), old = shift(today, -5);

let base, owner, office, pm, pid, pid2, demo, dry, tDemo, tDry, ann, bob, cy;
async function call(method, path, body, cookie) {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text(); let b = null; try { b = t ? JSON.parse(t) : null; } catch { b = t; } return { status: res.status, body: b, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
const login = async (email) => (await call('POST', '/api/login', { email, password: 'correct horse battery' })).cookie;
const pin = async (e, p) => { const r = await call('POST', '/api/clock/login', { employeeId: e.id, pin: p }); return r.status === 200 ? r.cookie : null; };
const home = async (c) => (await call('GET', '/api/clock/home', null, c)).body;

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  const h = await hashPassword('correct horse battery');
  for (const [e, r] of [['owner@x.net', 'Super Admin'], ['office@x.net', 'Exec Assistant'], ['pm@x.net', 'Project Manager']]) await q('INSERT INTO app_users(email,name,role,password_hash) VALUES ($1,$1,$2,$3)', [e, r, h]);
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
  owner = await login('owner@x.net'); office = await login('office@x.net'); pm = await login('pm@x.net');
  tDemo = (await call('POST', '/api/admin/trades', { name: 'Demolition' }, office)).body.id; tDry = (await call('POST', '/api/admin/trades', { name: 'Drywall' }, office)).body.id;
  const gc = (await call('POST', '/api/admin/gcs', { name: 'GC' }, office)).body.id;
  for (const [n, k] of [['Site A', 'pid'], ['Site B', 'pid2']]) { const r = (await call('POST', '/api/projects', { name: n, gcId: gc, client: 'C', address: 'A', trades: [{ tradeId: tDemo, amount: 50000 }, { tradeId: tDry, amount: 50000 }] }, office)).body.id; if (k === 'pid') pid = r; else pid2 = r; }
  const p = (await call('GET', `/api/projects/${pid}`, null, office)).body; demo = p.trades.find((t) => t.name === 'Demolition').id; dry = p.trades.find((t) => t.name === 'Drywall').id;
  ann = (await call('POST', '/api/admin/employees', { name: 'Ann', hourly_rate: 20, phone: '(407) 555-1234' }, owner)).body;
  bob = (await call('POST', '/api/admin/employees', { name: 'Bob', hourly_rate: 30 }, owner)).body;
  cy = (await call('POST', '/api/admin/employees', { name: 'Cy', hourly_rate: 10, phone: '99' }, owner)).body;
});
after(async () => { server.close(); await pool.end(); });

test('every employee starts with an automatic PIN: last 4 of the phone, else 0000; a chosen PIN is never replaced; the office can go back to automatic', async () => {
  assert.equal(tc.defaultPin('(407) 555-1234'), '1234'); assert.equal(tc.defaultPin(''), '0000'); assert.equal(tc.defaultPin('99'), '0000');
  assert.ok(await pin(ann, '1234')); assert.ok(await pin(bob, '0000')); assert.ok(await pin(cy, '0000')); assert.equal(await pin(ann, '0000'), null);
  assert.equal((await call('PUT', `/api/admin/employees/${ann.id}`, { phone: '321-555-9876' }, office)).status, 200); assert.ok(await pin(ann, '9876'));   // the automatic PIN follows the phone
  assert.equal((await call('PUT', `/api/admin/employees/${ann.id}/pin`, { pin: '4455' }, office)).status, 200); assert.equal((await call('PUT', `/api/admin/employees/${ann.id}`, { phone: '111-111-2222' }, office)).status, 200);
  assert.ok(await pin(ann, '4455')); assert.equal(await pin(ann, '2222'), null);   // a PIN the office chose stays
  assert.equal((await call('PUT', `/api/admin/employees/${ann.id}/pin`, { default: true }, office)).status, 200); assert.ok(await pin(ann, '2222'));
  assert.equal((await call('PUT', `/api/admin/employees/${ann.id}/pin`, { default: true }, pm)).status, 403);
  assert.equal((await call('GET', '/api/admin/employees', null, office)).body.find((e) => e.name === 'Ann').pin_default, true);
  await q(`UPDATE employees SET pin_hash=NULL, pin_default=false WHERE id=$1`, [bob.id]); assert.equal(await tc.ensureDefaultPins(), 1); assert.ok(await pin(bob, '0000'));   // anyone left without one is given it at start-up
});

test('a day at an "Other" jobsite: name and place needed, no project, trades from the trade list, and it counts toward the week\'s pay', async () => {
  const b = await pin(bob, '0000'); assert.equal((await call('POST', '/api/clock/in', { other: { name: 'X', address: '' } }, b)).status, 400);
  assert.equal((await call('POST', '/api/clock/in', { other: { name: 'Dr. Smith office', address: '12 Palm Ave, Tampa FL' } }, b)).status, 200);
  assert.equal((await home(b)).open.other, true); assert.equal((await home(b)).open.project, 'Other: Dr. Smith office');
  await q(`UPDATE time_entries SET clock_in = now() - interval '5 hours' WHERE employee_id=$1 AND status='open'`, [bob.id]);
  assert.equal((await call('POST', '/api/clock/out', { lines: [{ projectTradeId: demo, hours: 5 }] }, b)).status, 400);   // a project's trade is not an "Other" site's trade
  const r = await call('POST', '/api/clock/out', { lines: [{ tradeId: tDemo, hours: 2 }, { tradeId: tDry, hours: 3 }] }, b); assert.equal(r.status, 200, JSON.stringify(r.body));
  const rows = await q(`SELECT project_id, other_name, trade_id, hours::float h, pay::float p FROM labor_entries WHERE employee_id=$1 ORDER BY hours`, [bob.id]);
  assert.deepEqual(rows.map((x) => [x.project_id, x.other_name, x.trade_id, x.h]), [[null, 'Dr. Smith office', tDemo, 2], [null, 'Dr. Smith office', tDry, 3]]); assert.equal(Math.round(rows.reduce((n, x) => n + x.p, 0) * 100) / 100, 150);   // 5 h at $30
  const w = (await home(b)).weeks[0]; assert.deepEqual([w.hours, w.pay], [5, 150]); assert.equal(w.entries[0].site, 'Other: Dr. Smith office');
});

test('trades are chosen at the end of the day, several per day; a project day needs the project\'s own trades', async () => {
  const a = await pin(ann, '2222'); assert.equal((await call('POST', '/api/clock/in', { projectId: pid }, a)).status, 200);   // no trade at clock-in
  await q(`UPDATE time_entries SET clock_in = now() - interval '8 hours' WHERE employee_id=$1 AND status='open'`, [ann.id]);
  assert.equal((await call('POST', '/api/clock/out', {}, a)).status, 400);   // a trade must be named
  assert.equal((await call('POST', '/api/clock/out', { lines: [{ projectTradeId: demo, hours: 2 }, { projectTradeId: dry, hours: 5 }] }, a)).status, 400);   // 7 of 8 hours
  assert.equal((await call('POST', '/api/clock/out', { lines: [{ hours: 8 }] }, a)).status, 400);
  const ok = await call('POST', '/api/clock/out', { lines: [{ projectTradeId: demo, hours: 4 }, { projectTradeId: dry, hours: 4 }], injured: false, notes: 'Done' }, a); assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual((await q(`SELECT hours::float h, project_trade_id FROM labor_entries WHERE employee_id=$1 ORDER BY hours, project_trade_id`, [ann.id])).map((x) => x.h), [4, 4]);
});

test('a day left open overnight must be finished first: nothing else works until the stop time and trades are entered', async () => {
  const c = await pin(cy, '0000'); await call('POST', '/api/clock/in', { projectId: pid }, c);
  await q(`UPDATE time_entries SET work_date=$2, clock_in=($2::date + time '07:00') AT TIME ZONE 'America/New_York' WHERE employee_id=$1 AND status='open'`, [cy.id, yesterday]);
  const h = await home(c); assert.equal(h.open.stale, true); assert.equal(h.open.workDate, yesterday);
  assert.equal((await call('POST', '/api/clock/in', { projectId: pid2 }, c)).status, 409); assert.match((await call('POST', '/api/clock/manual', { date: yesterday, projectId: pid, hours: 2, lines: [{ projectTradeId: demo, hours: 2 }] }, c)).body.error, /did not clock out/);
  assert.match((await call('POST', '/api/clock/out', { lines: [{ projectTradeId: demo, hours: 9 }] }, c)).body.error, /Enter the time you stopped/);
  assert.equal((await call('POST', '/api/clock/out', { outTime: '06:00', lines: [{ projectTradeId: demo, hours: 1 }] }, c)).status, 400);   // before the start
  const ok = await call('POST', '/api/clock/out', { outTime: '16:00', lines: [{ projectTradeId: demo, hours: 5 }, { projectTradeId: dry, hours: 4 }], notes: 'Forgot' }, c); assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.totalHours, 9);
  assert.equal((await home(c)).open, null); assert.equal((await call('POST', '/api/clock/in', { projectId: pid2 }, c)).status, 200);
  await q(`DELETE FROM time_entries WHERE employee_id=$1 AND status='open'`, [cy.id]);
});

test('three weeks of history, Monday to Sunday, each person sees only their own hours and pay', async () => {
  const a = await pin(ann, '2222'), b = await pin(bob, '0000');
  for (const [date, hrs] of [[yesterday, 6], [shift(weekStart(today), -3), 8], [shift(weekStart(today), -10), 7], [shift(weekStart(today), -20), 5]]) await call('POST', '/api/clock/manual', { date, projectId: pid, hours: hrs, lines: [{ projectTradeId: dry, hours: hrs }] }, a);
  const h = await home(a); assert.equal(h.weeks.length, 3); assert.deepEqual(h.weeks.map((w) => w.start), [weekStart(today), shift(weekStart(today), -7), shift(weekStart(today), -14)]);
  const all = h.weeks.flatMap((w) => w.entries); assert.ok(!all.some((e) => e.date === shift(weekStart(today), -20)));   // older than two weeks back is not shown
  assert.ok(h.weeks[1].entries.some((e) => e.hours === 8) && h.weeks[2].entries.some((e) => e.hours === 7));
  assert.ok(h.weeks.every((w) => w.pay !== null)); assert.ok(!JSON.stringify(h).includes('Dr. Smith'));   // Bob's day at the other site is not in Ann's data
  assert.equal(h.weeks[1].pay, 160);   // 8 h at $20
});

test('an employee can change today and yesterday; older days go to the office as a request that is applied or declined', async () => {
  const a = await pin(ann, '2222'); const h = await home(a); const yest = h.weeks.flatMap((w) => w.entries).find((e) => e.date === yesterday), older = h.weeks[1].entries.find((e) => e.hours === 8);
  assert.equal(yest.editable, true); assert.equal(older.editable, false);
  assert.equal((await call('PUT', `/api/clock/entries/${yest.id}`, { totalHours: 7, lines: [{ projectTradeId: demo, hours: 3 }, { projectTradeId: dry, hours: 4 }], notes: 'Corrected' }, a)).status, 200);
  const after = (await home(a)).weeks.flatMap((w) => w.entries).find((e) => e.id === yest.id); assert.deepEqual([after.hours, after.lines.length, after.notes], [7, 2, 'Corrected']);
  assert.equal((await call('PUT', `/api/clock/entries/${yest.id}`, { totalHours: 7, lines: [{ projectTradeId: demo, hours: 3 }] }, a)).status, 400);   // trades must add up
  assert.equal((await call('PUT', `/api/clock/entries/${older.id}`, { notes: 'x' }, a)).status, 403); assert.equal((await call('POST', `/api/clock/entries/${yest.id}/request`, { message: 'x' }, a)).status, 400);
  const bobDay = (await q(`SELECT id FROM time_entries WHERE employee_id=$1 LIMIT 1`, [bob.id]))[0]; assert.equal((await call('PUT', `/api/clock/entries/${bobDay.id}`, { notes: 'x' }, a)).status, 404);   // never someone else's day
  const req = await call('POST', `/api/clock/entries/${older.id}/request`, { message: 'I worked 6 hours, not 8', proposal: { totalHours: 6, lines: [{ projectTradeId: dry, hours: 6 }] } }, a); assert.equal(req.status, 200, JSON.stringify(req.body));
  assert.equal((await call('POST', `/api/clock/entries/${older.id}/request`, { message: 'again' }, a)).status, 409);
  assert.equal((await home(a)).weeks[1].entries.find((e) => e.id === older.id).request, 'Pending');
  assert.ok((await call('GET', '/api/notifications', null, office)).body.some((n) => /Time change request: Ann/.test(n.title)));
  const list = (await call('GET', '/api/time/corrections', null, office)).body; assert.equal(list.length, 1); assert.deepEqual([list[0].employee, list[0].hours, list[0].message], ['Ann', 8, 'I worked 6 hours, not 8']);
  assert.equal((await call('POST', `/api/time/corrections/${list[0].id}/apply`, {}, pm)).status, 403);
  assert.equal((await call('POST', `/api/time/corrections/${list[0].id}/apply`, {}, office)).status, 200); assert.equal((await home(a)).weeks[1].entries.find((e) => e.id === older.id).hours, 6);
  assert.equal((await call('POST', `/api/time/corrections/${list[0].id}/decline`, {}, office)).status, 409);
  const third = (await home(a)).weeks[2].entries[0]; await call('POST', `/api/clock/entries/${third.id}/request`, { message: 'wrong site' }, a); const l2 = (await call('GET', '/api/time/corrections', null, office)).body;
  assert.equal((await call('POST', `/api/time/corrections/${l2[0].id}/decline`, { note: 'Checked the sheet' }, office)).status, 200); assert.equal((await call('GET', '/api/time/corrections?status=Declined', null, office)).body[0].note, 'Checked the sheet');
});

test('the office adds or changes a day for anyone, and sees the weekly tally and project / trade totals (pay for the Super Admin only)', async () => {
  const add = await call('POST', '/api/time/entries', { employeeId: bob.id, date: shift(weekStart(today), -2), projectId: pid2, hours: 8, lines: [{ projectTradeId: (await call('GET', `/api/projects/${pid2}`, null, office)).body.trades[0].id, hours: 8 }] }, office); assert.equal(add.status, 200, JSON.stringify(add.body));
  assert.equal((await call('POST', '/api/time/entries', { employeeId: bob.id, date: shift(today, 3), projectId: pid2, hours: 8 }, office)).status, 400); assert.equal((await call('POST', '/api/time/entries', { employeeId: bob.id, date: today, projectId: pid2, hours: 8 }, pm)).status, 403);
  const wk = (s) => shift(weekStart(today), s * 7);
  const sOwner = (await call('GET', `/api/time/summary?start=${wk(0)}`, null, owner)).body, sOffice = (await call('GET', `/api/time/summary?start=${wk(0)}`, null, office)).body;
  const bobRow = sOwner.people.find((p) => p.name === 'Bob'); assert.deepEqual([bobRow.hours, bobRow.pay, bobRow.otherHours], [5, 150, 5]); assert.equal(sOffice.people.find((p) => p.name === 'Bob').pay, null); assert.equal(sOffice.sites[0].cost, null);
  assert.equal(sOwner.start, wk(0)); assert.equal(sOwner.end, shift(wk(0), 6)); assert.ok(sOwner.sites.some((x) => x.site === 'Other: Dr. Smith office' && x.trade === 'Demolition' && x.hours === 2 && x.cost === 60));
  const all = (await call('GET', '/api/time/summary?scope=all', null, owner)).body; assert.ok(all.sites.some((x) => x.site === 'Site A') && all.sites.some((x) => x.site === 'Site B') && all.sites.some((x) => x.site === 'Other: Dr. Smith office'));   // every project, all time
  assert.equal((await call('GET', '/api/time/summary', null, pm)).status, 403);
});

test('the export is one row per employee, day, site and trade with the Monday of its week, ready for pivot tables; pay only for the Super Admin', async () => {
  const csv = async (c, q2 = '') => { const r = await fetch(base + '/api/time/export' + q2, { headers: { cookie: c } }); return { status: r.status, type: r.headers.get('content-type'), text: await r.text() }; };
  const o = await csv(owner); assert.equal(o.status, 200); assert.match(o.type, /text\/csv/); const lines = o.text.replace(/^﻿/, '').trim().split('\r\n'); assert.equal(lines[0], 'Week of (Monday),Date,Employee,Site type,Project / site,Site location,Trade,Hours,Rate,Pay,Injury reported,Entered by,Edited,Notes');
  assert.ok(lines.some((l) => /Other,Dr\. Smith office,"?12 Palm Ave, Tampa FL"?,Demolition,2,30,60/.test(l))); assert.ok(lines.some((l) => /Project,Site A/.test(l)));
  const f = await csv(office); assert.ok(!/,30,60/.test(f.text)); assert.equal((await csv(pm)).status, 403);
  const ranged = await csv(owner, `?from=${today}&to=${today}`); assert.ok(ranged.text.replace(/^﻿/, '').trim().split('\r\n').length < lines.length);
});

test('a jobsite is put on the map from its checked address, fenced to 3 miles by default; the office can redo it; far away clock-ins are refused', async () => {
  const ad = await import('../server/address.js');
  ad.setAddressFetch(async (url) => { const u = new URL(url); return { ok: true, json: async () => ({ result: { addressMatches: [{ matchedAddress: 'x', coordinates: { x: -81.3792, y: 28.5383 }, addressComponents: { city: u.searchParams.get('city').toUpperCase(), state: 'FL', zip: u.searchParams.get('zip') } }] } }) }; });
  const v = (await call('POST', '/api/address/verify', { street: '400 S Orange Ave', city: 'Orlando', state: 'FL', zip: '32801', kind: 'project' }, office)).body;
  const id = (await call('POST', '/api/projects', { name: 'Fenced', gcId: (await q('SELECT id FROM gcs LIMIT 1'))[0].id, client: 'C', addr: { ...v.address, token: v.token }, trades: [{ tradeId: tDemo, amount: 1000 }] }, office)).body.id;
  const p = (await call('GET', `/api/projects/${id}`, null, office)).body.project; assert.deepEqual([p.lat, p.lng, p.geofenceRequired, p.geofenceMiles], [28.5383, -81.3792, true, 3]);
  const a = await pin(ann, '2222'); assert.match((await call('POST', '/api/clock/in', { projectId: id, gps: { lat: 28.7, lng: -81.3792 } }, a)).body.error, /miles from this jobsite/);   // about 11 miles away
  assert.equal((await call('POST', '/api/clock/in', { projectId: id }, a)).status, 403);   // no location, no clock-in
  assert.equal((await call('POST', '/api/clock/in', { projectId: id, gps: { lat: 28.5400, lng: -81.3790 } }, a)).status, 200);
  await q(`UPDATE projects SET lat=NULL, lng=NULL, geofence_required=false WHERE id=$1`, [id]); const g = await call('POST', `/api/projects/${id}/locate`, {}, office); assert.equal(g.status, 200); assert.equal(g.body.lat, 28.5383);
  const on = await call('POST', `/api/projects/${id}/locate`, { enable: true }, office); assert.equal(on.status, 200); assert.equal((await call('GET', `/api/projects/${id}`, null, office)).body.project.geofenceRequired, true);   // the Labor tab button turns the fence on too
  assert.equal((await call('POST', `/api/projects/${id}/locate`, {}, pm)).status, 403);
  ad.setAddressFetch(async () => ({ ok: true, json: async () => ({ result: { addressMatches: [] } }) })); assert.equal((await call('POST', `/api/projects/${id}/locate`, {}, office)).status, 422);
});
