import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
const { pool, q } = await import('../server/db.js');
const { server } = await import('../server/index.js');
const { hashPassword } = await import('../server/auth.js');

let base, owner, asst, pid;
const call = async (method, path, body, cookie) => { const r = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); let b = null; try { b = t ? JSON.parse(t) : null; } catch { b = t; } return { status: r.status, body: b }; };
const login = async (email) => (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct horse battery' }) })).headers.get('set-cookie').split(';')[0];

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  const h = await hashPassword('correct horse battery');
  for (const [e, r] of [['owner@x.net', 'Super Admin'], ['asst@x.net', 'Exec Assistant']]) await q('INSERT INTO app_users(email,name,role,password_hash) VALUES ($1,$2,$3,$4)', [e, e.split('@')[0], r, h]);
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
  owner = await login('owner@x.net'); asst = await login('asst@x.net');
  const [gc] = await q(`INSERT INTO gcs(name) VALUES ('GC') RETURNING id`);
  [{ id: pid }] = await q(`INSERT INTO projects(name,gc_id,client,address,retainage_pct) VALUES ('P',$1,'C','1 A St',10) RETURNING id`, [gc.id]);
});
after(async () => { server.close(); await pool.end(); });

test('go-live: clearing QuickBooks test data removes only what came from QuickBooks, and only for the owner while it is a sandbox or disconnected', async () => {
  const [ci] = await q(`INSERT INTO client_invoices(project_id,number,invoice_date,amount,qb_invoice_id) VALUES ($1,'QB-1','2026-01-05',1000,'q1') RETURNING id`, [pid]);
  await q(`INSERT INTO client_payments(client_invoice_id,paid_date,amount,qb_payment_id) VALUES ($1,'2026-01-20',400,'qp1')`, [ci.id]);
  await q(`INSERT INTO client_invoices(project_id,number,invoice_date,amount) VALUES ($1,'MINE-1','2026-01-06',500)`, [pid]);
  const [sup] = await q(`INSERT INTO suppliers(name) VALUES ('Home Depot') RETURNING id`);
  const [si] = await q(`INSERT INTO supplier_invoices(supplier_id,reference,invoice_date,total,source,qb_bill_id) VALUES ($1,'B1','2026-01-07',300,'QuickBooks','b1') RETURNING id`, [sup.id]);
  await q(`INSERT INTO supplier_allocations(supplier_invoice_id,project_id,amount) VALUES ($1,$2,300)`, [si.id, pid]);
  await q(`INSERT INTO supplier_invoices(supplier_id,reference,invoice_date,total) VALUES ($1,'MINE-B','2026-01-08',80)`, [sup.id]);
  await q(`INSERT INTO qb_invoices(qb_id,doc_number,total,status) VALUES ('q2','2',50,'New')`);
  await q(`INSERT INTO qb_costs(qb_type,qb_id,kind,total,vendor_key) VALUES ('Bill','b2','Bill',20,'v')`);
  await q(`INSERT INTO app_settings(key,value) VALUES ('qbo_sync','{"startDate":"2026-01-01","autoImport":false,"since":"2026-01-01T00:00:00Z","lastRun":"x"}') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`);

  assert.equal((await call('POST', '/api/quickbooks/clear-test-data', { confirm: 'clear' }, asst)).status, 403);
  const s = (await call('GET', '/api/quickbooks/status', null, owner)).body.testData; assert.deepEqual([s.invoices, s.payments, s.costs, s.waiting, s.allowed], [1, 1, 1, 2, true]);
  assert.equal((await call('POST', '/api/quickbooks/clear-test-data', {}, owner)).status, 400);   // needs the word CLEAR

  // a connection to a live company blocks it
  await q(`INSERT INTO integrations(name,data) VALUES ('quickbooks','{"realmId":"1","environment":"production","company":"Real Co"}') ON CONFLICT (name) DO UPDATE SET data=EXCLUDED.data`);
  assert.equal((await call('POST', '/api/quickbooks/clear-test-data', { confirm: 'CLEAR' }, owner)).status, 409);
  await q(`UPDATE integrations SET data='{"realmId":"1","environment":"sandbox","company":"Sandbox Co"}' WHERE name='quickbooks'`);
  const r = await call('POST', '/api/quickbooks/clear-test-data', { confirm: 'CLEAR' }, owner); assert.equal(r.status, 200, JSON.stringify(r.body));

  assert.deepEqual((await q('SELECT number FROM client_invoices ORDER BY number')).map((x) => x.number), ['MINE-1']);
  assert.equal((await q('SELECT count(*)::int n FROM client_payments'))[0].n, 0);
  assert.deepEqual((await q('SELECT reference FROM supplier_invoices')).map((x) => x.reference), ['MINE-B']);
  assert.equal((await q('SELECT count(*)::int n FROM qb_invoices'))[0].n + (await q('SELECT count(*)::int n FROM qb_costs'))[0].n, 0);
  assert.equal((await q('SELECT count(*)::int n FROM projects'))[0].n, 1);
  const st = (await q(`SELECT value FROM app_settings WHERE key='qbo_sync'`))[0].value; assert.deepEqual([st.startDate, st.autoImport, st.since, st.lastRun], ['2026-01-01', false, undefined, undefined]);   // choices kept, sync position reset
  assert.equal(r.body.now.total, 0);
});

test('the license agreement and privacy policy pages are public, for Intuit\'s app review', async () => {
  for (const [path, text] of [['/terms', 'End-User License Agreement'], ['/privacy', 'Privacy Policy']]) { const r = await fetch(base + path); assert.equal(r.status, 200); assert.match(await r.text(), new RegExp(text)); }
});

test('after connecting the real company, rows read before that moment (the sandbox ones) can be removed and the real ones stay', async () => {
  await q('DELETE FROM qb_invoices'); await q('DELETE FROM qb_costs'); await q('DELETE FROM client_invoices');
  const t0 = new Date(Date.now() - 3600e3).toISOString();
  await q(`INSERT INTO integrations(name,data) VALUES ('quickbooks',$1) ON CONFLICT (name) DO UPDATE SET data=$1`, [{ realmId: '9', environment: 'production', company: 'Real Co', connectedAt: t0 }]);
  await q(`INSERT INTO qb_invoices(qb_id,doc_number,total,status,customer_id,synced_at) VALUES ('old1','FAKE',10,'New','c1', now() - interval '2 days'), ('new1','REAL',20,'New','c2', now())`);
  await q(`INSERT INTO client_invoices(project_id,number,invoice_date,amount,qb_invoice_id) VALUES ($1,'FAKE','2026-01-01',10,'old1')`, [pid]);
  const s = (await call('GET', '/api/quickbooks/status', null, owner)).body.testData; assert.deepEqual([s.leftover.invoices, s.leftover.costs], [1, 0]);
  assert.equal((await call('POST', '/api/quickbooks/clear-leftover', {}, owner)).status, 400);
  assert.equal((await call('POST', '/api/quickbooks/clear-leftover', { confirm: 'CLEAR' }, asst)).status, 403);
  assert.equal((await call('POST', '/api/quickbooks/clear-leftover', { confirm: 'CLEAR' }, owner)).status, 200);
  assert.deepEqual((await q('SELECT doc_number FROM qb_invoices')).map((x) => x.doc_number), ['REAL']);
  assert.equal((await q('SELECT count(*)::int n FROM client_invoices'))[0].n, 0);   // what was imported from the fake one goes too
  assert.equal((await call('GET', '/api/quickbooks/status', null, owner)).body.testData.leftover.total, 0);
});
