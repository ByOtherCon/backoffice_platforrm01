import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
const { pool, q } = await import('../server/db.js');
const { server } = await import('../server/index.js');
const { hashPassword } = await import('../server/auth.js');

let base, office, pid, pt;
const call = async (method, path, body, cookie) => { const r = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); let b = null; try { b = t ? JSON.parse(t) : null; } catch { b = t; } return { status: r.status, body: b }; };
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  const h = await hashPassword('correct horse battery');
  await q(`INSERT INTO app_users(email,name,role,password_hash) VALUES ('office@x.net','Office','Exec Assistant',$1)`, [h]);
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
  office = (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'office@x.net', password: 'correct horse battery' }) })).headers.get('set-cookie').split(';')[0];
  const [g] = await q(`INSERT INTO gcs(name) VALUES ('GC') RETURNING id`), [t] = await q(`INSERT INTO trades(name,sort) VALUES ('Framing',1) RETURNING id`);
  [{ id: pid }] = await q(`INSERT INTO projects(name,gc_id,client,address) VALUES ('Job',$1,'C','A') RETURNING id`, [g.id]);
  [{ id: pt }] = await q('INSERT INTO project_trades(project_id,trade_id,original_amount) VALUES ($1,$2,50000) RETURNING id', [pid, t.id]);
});
after(async () => { server.close(); await pool.end(); });

const receipt = (extra) => call('POST', '/api/receipts', { reference: 'R-' + Math.random().toString(36).slice(2, 8), date: '2026-11-10', lines: [{ description: 'Screws', amount: 20, projectId: pid, projectTradeId: pt }], ...extra }, office);
const vendors = async () => (await call('GET', '/api/admin/suppliers', null, office)).body;

test('a receipt can save its new vendor for next time, or be a one-time purchase that stays out of the vendor list', async () => {
  assert.equal((await receipt({ supplierName: 'Lowes', saveVendor: true })).status, 200);
  assert.equal((await receipt({ supplierName: 'Corner Hardware', saveVendor: false })).status, 200);
  assert.equal((await receipt({ supplierName: 'Default Vendor' })).status, 200);   // callers that say nothing keep the vendor, as before
  const v = Object.fromEntries((await vendors()).map((x) => [x.name, x.one_time]));
  assert.deepEqual([v['Lowes'], v['Corner Hardware'], v['Default Vendor']], [false, true, false]);
  // the same one-time vendor again reuses it; choosing to save it later puts it on the list
  assert.equal((await receipt({ supplierName: 'corner hardware', saveVendor: false })).status, 200);
  assert.equal((await q(`SELECT count(*)::int n FROM suppliers WHERE lower(name)='corner hardware'`))[0].n, 1);
  assert.equal((await receipt({ supplierName: 'Corner Hardware', saveVendor: true })).status, 200);
  assert.equal((await vendors()).find((x) => x.name === 'Corner Hardware').one_time, false);
});

test('the project vendor invoice can name a new vendor, saved or one-time, and Admin can save a one-time one later', async () => {
  const inv = (extra) => call('POST', '/api/projects/' + pid + '/supplier-invoices'.replace('/api/projects/' + pid, ''), {}, office);
  void inv;
  const add = (body) => call('POST', '/api/supplier-invoices', { reference: 'V-' + Math.random().toString(36).slice(2, 7), date: '2026-11-10', total: 100, allocations: [{ projectId: pid, projectTradeId: pt, amount: 100 }], ...body }, office);
  assert.equal((await add({ supplierName: 'Web Shop', saveVendor: false })).status, 200);
  assert.equal((await add({})).status, 400);   // a vendor is needed
  const web = (await vendors()).find((x) => x.name === 'Web Shop'); assert.equal(web.one_time, true);
  assert.equal((await call('PUT', `/api/admin/suppliers/${web.id}`, { one_time: false }, office)).status, 200);
  assert.equal((await vendors()).find((x) => x.name === 'Web Shop').one_time, false);
  // picking an existing one-time vendor and choosing to save it keeps it
  await q(`UPDATE suppliers SET one_time=true WHERE id=$1`, [web.id]);
  assert.equal((await add({ supplierId: web.id, saveVendor: true })).status, 200);
  assert.equal((await vendors()).find((x) => x.name === 'Web Shop').one_time, false);
  // the cost import's vendor list leaves one-time vendors out
  await q(`UPDATE suppliers SET one_time=true WHERE name='Web Shop'`);
  const costs = (await call('GET', '/api/projects/' + pid + '/costs', null, office)).body; assert.ok(costs.suppliers.some((s) => s.supplier === 'Web Shop'));   // still on its invoices
});
