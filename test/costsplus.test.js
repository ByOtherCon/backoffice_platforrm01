import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
const { pool, q } = await import('../server/db.js');
const { server } = await import('../server/index.js');
const { hashPassword } = await import('../server/auth.js');

let base, owner, office, pid, ptA, ptB, sub, sup;
async function call(method, path, body, cookie) {
  const r = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let b = null; try { b = t ? JSON.parse(t) : null; } catch { b = t; } return { status: r.status, body: b };
}
const login = async (email) => (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct horse battery' }) })).headers.get('set-cookie').split(';')[0];
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  const h = await hashPassword('correct horse battery');
  for (const [e, r] of [['owner@x.net', 'Super Admin'], ['office@x.net', 'Exec Assistant']]) await q('INSERT INTO app_users(email,name,role,password_hash) VALUES ($1,$1,$2,$3)', [e, r, h]);
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`; owner = await login('owner@x.net'); office = await login('office@x.net');
  const [g] = await q(`INSERT INTO gcs(name) VALUES ('GC') RETURNING id`); const [a] = await q(`INSERT INTO trades(name,sort) VALUES ('Framing',1) RETURNING id`); const [b] = await q(`INSERT INTO trades(name,sort) VALUES ('Paint',2) RETURNING id`);
  [{ id: pid }] = await q(`INSERT INTO projects(name,gc_id,client,address) VALUES ('Job',$1,'C','A') RETURNING id`, [g.id]);
  [{ id: ptA }, { id: ptB }] = await q('INSERT INTO project_trades(project_id,trade_id,original_amount) VALUES ($1,$2,50000),($1,$3,20000) RETURNING id', [pid, a.id, b.id]);
});
after(async () => { server.close(); await pool.end(); });

test('a subcontractor has a contact person, shown with the subcontractor on the project; a vendor can have just a website', async () => {
  sub = (await call('POST', '/api/admin/subcontractors', { name: 'Rivera Framing', contact_name: 'Luis Rivera', phone: '407-555-0101' }, office)).body; assert.equal(sub.contact_name, 'Luis Rivera');
  assert.equal((await call('PUT', `/api/admin/subcontractors/${sub.id}`, { contact_name: 'Luis R.' }, office)).body.contact_name, 'Luis R.');
  const web = await call('POST', '/api/admin/suppliers', { name: 'ScrewsOnline', provider_type: 'Materials', website: 'www.screwsonline.com' }, office); assert.equal(web.status, 200); assert.equal(web.body.website, 'https://www.screwsonline.com'); assert.equal(web.body.address, null);   // no address needed
  assert.equal((await call('POST', '/api/admin/suppliers', { name: 'Bad Site', provider_type: 'Materials', website: 'not a site' }, office)).status, 400);
  assert.equal((await call('POST', '/api/admin/suppliers', { name: 'Blank Site', provider_type: 'Materials', website: '' }, office)).body.website, null);
  sup = web.body.id;
  const com = (await call('POST', `/api/projects/${pid}/commitments`, { projectTradeId: ptA, subcontractorId: sub.id, contractAmount: 20000 }, office)); assert.equal(com.status, 200);
  const costs = (await call('GET', `/api/projects/${pid}/costs`, null, office)).body; assert.deepEqual([costs.vendors[0].contact, costs.vendors[0].contactPhone], ['Luis R.', '407-555-0101']);
});

test('bills are listed under their subcontractor; what is owed counts invoiced and not-yet-invoiced work', async () => {
  const cid = (await call('GET', `/api/projects/${pid}/costs`, null, office)).body.vendors[0].id;
  await call('POST', `/api/projects/${pid}/commitments/${cid}/bills`, { number: 'A-1', date: '2026-10-01', amount: 6000 }, office); await call('POST', `/api/projects/${pid}/commitments/${cid}/bills`, { number: 'A-2', date: '2026-11-01', amount: 4000 }, office);
  await q(`INSERT INTO sub_payments(sub_invoice_id,paid_date,amount) SELECT id, '2026-10-20', 6000 FROM sub_invoices WHERE number='A-1'`);
  const v = (await call('GET', `/api/projects/${pid}/costs`, null, office)).body.vendors[0];
  assert.deepEqual(v.bills.map((b) => [b.number, b.amount, b.paid]), [['A-1', 6000, 6000], ['A-2', 4000, 0]]);
  assert.deepEqual([v.contract, v.invoiced, v.paid, v.balance, v.remaining], [20000, 10000, 6000, 4000, 10000]);   // owed on invoices 4,000 + not yet invoiced 10,000 = 14,000 still owed
  const p = (await call('GET', `/api/projects/${pid}`, null, office)).body; const t = p.trades.find((x) => x.id === ptA); assert.deepEqual([t.subContract, t.subInvoiced, t.subPaid], [20000, 10000, 6000]);
  assert.deepEqual([p.totals.subContract, p.totals.subPaid, p.totals.supplierPaid], [20000, 6000, 0]);   // the totals the cost summary needs
});

test('a vendor invoice carries a description, and can be marked paid when it is added', async () => {
  const mk = (extra) => call('POST', '/api/supplier-invoices', { supplierId: sup, reference: extra.ref, date: '2026-11-03', total: 500, description: extra.description, paid: extra.paid, paidDate: extra.paidDate, allocations: [{ projectId: pid, projectTradeId: ptB, amount: 500 }] }, office);
  const paid = await mk({ ref: 'W-1001', description: '4 boxes of drywall screws and 2 mud buckets', paid: true, paidDate: '2026-11-03' }); assert.equal(paid.status, 200, JSON.stringify(paid.body));
  const open = await mk({ ref: 'W-1002', description: 'Paint rollers', paid: false }); assert.equal(open.status, 200);
  const rows = (await call('GET', `/api/projects/${pid}/costs`, null, office)).body.suppliers;
  const a = rows.find((r) => r.reference === 'W-1001'), b = rows.find((r) => r.reference === 'W-1002');
  assert.deepEqual([a.description, a.paid, a.balance], ['4 boxes of drywall screws and 2 mud buckets', 500, 0]); assert.deepEqual([b.description, b.paid, b.balance], ['Paint rollers', 0, 500]);   // no "create it, then click pay"
  assert.equal((await q('SELECT paid_date::text d FROM supplier_payments sp JOIN supplier_invoices si ON si.id=sp.supplier_invoice_id WHERE si.reference=$1', ['W-1001']))[0].d, '2026-11-03');
  const p = (await call('GET', `/api/projects/${pid}`, null, office)).body; assert.deepEqual([p.totals.supplierCost, p.totals.supplierPaid], [1000, 500]);
});
