import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
const { pool, q } = await import('../server/db.js');
const { server } = await import('../server/index.js');
const { hashPassword } = await import('../server/auth.js');
const acc = await import('../server/access.js');
const dash = await import('../server/dashboard.js');

let base, owner, silvia, juliana, pmx, sub, ids = {}, pid;
const call = async (method, path, body, cookie) => { const r = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); let b = null; try { b = t ? JSON.parse(t) : null; } catch { b = t; } return { status: r.status, body: b }; };
const login = async (email) => (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct horse battery' }) })).headers.get('set-cookie').split(';')[0];
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  const h = await hashPassword('correct horse battery');
  for (const [e, r] of [['owner@x.net', 'Super Admin'], ['silvia@x.net', 'Exec Assistant'], ['juliana@x.net', 'Estimator'], ['pm@x.net', 'Project Manager'], ['sub@x.net', 'Sub Admin']]) { const [u] = await q('INSERT INTO app_users(email,name,role,password_hash) VALUES ($1,$2,$3,$4) RETURNING id', [e, e.split('@')[0], r, h]); ids[e.split('@')[0]] = u.id; }
  const [g] = await q(`INSERT INTO gcs(name) VALUES ('GC') RETURNING id`); const [t] = await q(`INSERT INTO trades(name,sort) VALUES ('Demo',1) RETURNING id`);
  const [p] = await q(`INSERT INTO projects(name,gc_id,client,address) VALUES ('Job',$1,'C','A') RETURNING id`, [g.id]); pid = p.id; await q('INSERT INTO project_trades(project_id,trade_id,original_amount) VALUES ($1,$2,1000)', [pid, t.id]);
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
  owner = await login('owner@x.net'); silvia = await login('silvia@x.net'); juliana = await login('juliana@x.net'); pmx = await login('pm@x.net'); sub = await login('sub@x.net');
});
after(async () => { server.close(); await pool.end(); });
const setAccess = (who, access) => call('PUT', `/api/admin/users/${ids[who]}`, { access }, owner);

test('role defaults: the office has every area, an estimator only estimating and reports, a project manager job costing', async () => {
  assert.deepEqual(acc.areasFor({ role: 'Exec Assistant' }).sort(), acc.AREA_IDS.slice().sort()); assert.deepEqual(acc.areasFor({ role: 'Estimator' }), ['estimating', 'reports']); assert.deepEqual(acc.areasFor({ role: 'Project Manager' }), ['projects', 'reports']);
  assert.deepEqual((await call('GET', '/api/me', null, juliana)).body.user.areas, ['estimating', 'reports']);
  assert.equal((await call('GET', '/api/quickbooks/invoices', null, silvia)).status, 200); assert.equal((await call('GET', '/api/quickbooks/invoices', null, juliana)).status, 403);
});
test('turning an area off for one person (Silvia keeps invoice matching, Juliana does not; another assistant can lose it)', async () => {
  assert.equal((await call('GET', '/api/access/options', null, silvia)).status, 403); const o = (await call('GET', '/api/access/options', null, owner)).body; assert.ok(o.areas.some((a) => a.id === 'billing')); assert.ok(o.widgets.some((w) => w.id === 'todos'));
  assert.equal((await setAccess('sub', { areas: ['projects', 'estimating'] })).status, 200);
  assert.equal((await call('GET', '/api/quickbooks/invoices', null, sub)).status, 403); assert.equal((await call('GET', '/api/projects', null, sub)).status, 200); assert.equal((await call('GET', '/api/receipts', null, sub)).status, 403);
  assert.equal((await call('GET', '/api/me', null, sub)).body.user.areas.includes('billing'), false);
  assert.equal((await call('GET', '/api/quickbooks/invoices', null, silvia)).status, 200);   // untouched
  assert.equal((await call('GET', '/api/admin/trades', null, sub)).status, 200);               // shared lists keep working for every form
  assert.equal((await call('POST', '/api/admin/trades', { name: 'New trade' }, sub)).status, 403);   // but changing them is the "lists" area
});
test('an area the role does not have can be given: it lends the lowest office role for that area only', async () => {
  assert.equal((await call('GET', `/api/projects/${pid}`, null, juliana)).status, 403);
  assert.equal((await setAccess('juliana', { areas: ['estimating', 'reports', 'projects'] })).status, 200);
  assert.equal((await call('GET', `/api/projects/${pid}`, null, juliana)).status, 200); assert.equal((await call('GET', '/api/projects', null, juliana)).body.length, 1);
  assert.equal((await call('GET', '/api/quickbooks/invoices', null, juliana)).status, 403);        // still not given
  assert.equal((await call('GET', '/api/compliance/vendors', null, juliana)).status, 403);
  assert.equal((await call('GET', '/api/ai/report', null, juliana)).status, 403);                  // owner-only things never open up
  assert.equal((await call('POST', `/api/payment-requests/${ids.owner}/approve`, {}, juliana)).status, 403);
  await setAccess('juliana', { areas: ['estimating', 'reports', 'billing'] }); assert.equal((await call('GET', '/api/quickbooks/invoices', null, juliana)).status, 200);   // invoice matching alone
  assert.equal((await call('GET', `/api/projects/${pid}`, null, juliana)).status, 403);
  await setAccess('juliana', null); assert.equal((await call('GET', '/api/quickbooks/invoices', null, juliana)).status, 403);   // back to the role default
});
test('the owner cannot be restricted, and bad choices are refused', async () => {
  assert.equal((await setAccess('owner', { areas: [] })).status, 400); assert.equal((await setAccess('silvia', { areas: ['everything'] })).status, 400); assert.equal((await setAccess('silvia', { widgets: ['nope'] })).status, 400);
  const o = await call('POST', '/api/admin/users', { email: 'new@x.net', name: 'New', role: 'Estimator', password: 'a long password here', access: { areas: ['estimating'], widgets: ['estimating', 'todos'] } }, owner); assert.equal(o.status, 200); assert.deepEqual(o.body.access, { areas: ['estimating'], widgets: ['estimating', 'todos'] });
  assert.ok((await call('GET', '/api/admin/users', null, owner)).body.find((u) => u.email === 'new@x.net').access.areas.includes('estimating'));
});
test('dashboard cards follow the areas and the cards the owner chose; money cards are not lent to a project manager', async () => {
  const ws = (u) => dash.allowedWidgets(u).sort();
  assert.ok(ws({ role: 'Exec Assistant' }).includes('receivables')); assert.deepEqual(ws({ role: 'Estimator' }), ['estimating', 'messages', 'todos']); assert.ok(!ws({ role: 'Project Manager' }).includes('receivables'));
  assert.deepEqual(ws({ role: 'Exec Assistant', access: { widgets: ['todos', 'estimating'] } }), ['estimating', 'messages', 'todos']);   // to-dos and messages are always there
  assert.ok(ws({ role: 'Estimator', access: { areas: ['estimating', 'projects'] } }).includes('receivables'));   // a lent area brings its cards
  assert.ok(!ws({ role: 'Exec Assistant', access: { areas: ['estimating'] } }).includes('costing'));            // an area off removes its cards
  await setAccess('sub', { areas: ['projects', 'estimating'], widgets: ['costing', 'estimating'] });
  const d = (await call('GET', '/api/dashboard/widgets', null, sub)).body; assert.deepEqual(d.widgets.sort(), ['costing', 'estimating', 'messages', 'todos']);
  assert.equal((await call('PUT', '/api/prefs/dashboard', { widgets: [{ id: 'receivables', visible: true }] }, sub)).status, 400);   // cannot pick a card they were not given
});
test('area switches never touch pages with no area (messages, to-dos, clock, password)', async () => {
  await setAccess('silvia', { areas: [] });
  assert.equal((await call('GET', '/api/todos', null, silvia)).status, 200); assert.equal((await call('GET', '/api/notifications', null, silvia)).status, 200); assert.equal((await call('GET', '/api/me', null, silvia)).status, 200);
  assert.equal((await call('GET', '/api/projects', null, silvia)).status, 403); await setAccess('silvia', null); assert.equal((await call('GET', '/api/projects', null, silvia)).status, 200);
});
