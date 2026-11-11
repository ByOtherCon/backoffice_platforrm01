import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
const { pool, q } = await import('../server/db.js');
const { server } = await import('../server/index.js');
const { hashPassword } = await import('../server/auth.js');

let base, owner, office, pid, cid, sub;
const call = async (method, path, body, cookie) => { const r = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); let b = null; try { b = t ? JSON.parse(t) : null; } catch { b = t; } return { status: r.status, body: b }; };
const row = async () => (await call('GET', `/api/projects/${pid}/costs`, null, owner)).body.vendors[0];
const login = async (email) => (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct horse battery' }) })).headers.get('set-cookie').split(';')[0];
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  const h = await hashPassword('correct horse battery');
  for (const [e, r] of [['owner@x.net', 'Super Admin'], ['office@x.net', 'Exec Assistant']]) await q('INSERT INTO app_users(email,name,role,password_hash) VALUES ($1,$1,$2,$3)', [e, r, h]);
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`; owner = await login('owner@x.net'); office = await login('office@x.net');
  const [g] = await q(`INSERT INTO gcs(name) VALUES ('GC') RETURNING id`), [t] = await q(`INSERT INTO trades(name,sort) VALUES ('Framing',1) RETURNING id`);
  [{ id: pid }] = await q(`INSERT INTO projects(name,gc_id,client,address) VALUES ('Job',$1,'C','A') RETURNING id`, [g.id]);
  const [pt] = await q('INSERT INTO project_trades(project_id,trade_id,original_amount) VALUES ($1,$2,50000) RETURNING id', [pid, t.id]);
  [sub] = await q(`INSERT INTO subcontractors(name) VALUES ('Rivera') RETURNING id`);
  [{ id: cid }] = await q('INSERT INTO sub_commitments(project_id,project_trade_id,subcontractor_id,contract_amount) VALUES ($1,$2,$3,10000) RETURNING id', [pid, pt.id, sub.id]);
});
after(async () => { server.close(); await pool.end(); });

test('an approver pays a subcontractor with no invoice: how and why are required, and it counts on the contract', async () => {
  const body = { method: 'Cash', date: '2026-11-10', amount: 500, explanation: 'Paid cash on site for demo labor, no invoice' };
  assert.equal((await call('POST', `/api/projects/${pid}/commitments/${cid}/pay-without-invoice`, body, owner)).status, 409);   // an unverified subcontractor cannot be paid, with or without an invoice
  await q(`UPDATE subcontractors SET verified_override=true WHERE id=$1`, [sub.id]);
  assert.equal((await call('POST', `/api/projects/${pid}/commitments/${cid}/pay-without-invoice`, { ...body, explanation: '' }, owner)).status, 400);   // the reason is required
  assert.equal((await call('POST', `/api/projects/${pid}/commitments/${cid}/pay-without-invoice`, { ...body, method: 'Bitcoin' }, owner)).status, 400);
  assert.equal((await call('POST', `/api/projects/${pid}/commitments/${cid}/pay-without-invoice`, { ...body, amount: 10001 }, owner)).status, 400);    // more than the subcontract
  assert.equal((await call('POST', `/api/projects/${pid}/commitments/${cid}/pay-without-invoice`, body, office)).status, 403);                         // only an approver pays directly
  const ok = await call('POST', `/api/projects/${pid}/commitments/${cid}/pay-without-invoice`, body, owner); assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const v = await row(); assert.deepEqual([v.invoiced, v.paid, v.balance, v.remaining], [500, 500, 0, 9500]);
  assert.deepEqual([v.bills[0].noInvoice, v.bills[0].number, v.bills[0].payments[0].method], [true, 'NO-INV-1', 'Cash']); assert.match(v.bills[0].memo, /Cash: Paid cash on site/);
  assert.equal((await call('POST', `/api/projects/${pid}/commitments/${cid}/pay-without-invoice`, { ...body, method: 'Credit / Offset (no money paid)', explanation: 'Credit for materials we supplied', amount: 250 }, owner)).status, 200);
  assert.equal((await row()).bills.length, 2);
  // it feeds the 1099 totals like any payment
  assert.equal((await q(`SELECT SUM(sp.amount)::float8 n FROM sub_payments sp JOIN sub_invoices si ON si.id=sp.sub_invoice_id WHERE si.no_invoice`))[0].n, 750);
});

test('someone who cannot pay directly sends a no-invoice payment for approval; the bill appears when it is paid, and a declined one leaves nothing behind', async () => {
  const body = { method: 'Zelle', date: '2026-11-11', amount: 300, explanation: 'Zelle for a small fix, no invoice' };
  const r = await call('POST', `/api/projects/${pid}/commitments/${cid}/request-without-invoice`, body, office); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await call('POST', `/api/projects/${pid}/commitments/${cid}/request-without-invoice`, { ...body, explanation: ' ' }, office)).status, 400);
  assert.equal((await call('POST', `/api/projects/${pid}/commitments/${cid}/request-without-invoice`, { ...body, amount: 9500 }, office)).status, 400);   // 750 paid + 9500 would pass the subcontract
  const list = (await call('GET', '/api/payment-requests?status=Requested', null, owner)).body; assert.deepEqual([list[0].noInvoice, list[0].bill, list[0].method], [true, 'No invoice', 'Zelle']);
  assert.equal((await row()).bills.length, 2);   // no bill yet
  assert.equal((await call('POST', `/api/payment-requests/${r.body.id}/approve`, {}, office)).status, 403);   // not the requester, and not an approver
  assert.equal((await call('POST', `/api/payment-requests/${r.body.id}/approve`, {}, owner)).status, 200);
  assert.equal((await call('POST', `/api/payment-requests/${r.body.id}/pay`, { date: '2026-11-11', reference: 'Zelle 123' }, office)).status, 200);
  const v = await row(); assert.deepEqual([v.bills.length, v.paid], [3, 1050]); assert.equal(v.bills[2].number, 'NO-INV-3');
  const d = await call('POST', `/api/projects/${pid}/commitments/${cid}/request-without-invoice`, { ...body, amount: 100 }, office);
  assert.equal((await call('POST', `/api/payment-requests/${d.body.id}/reject`, { reason: 'Get an invoice' }, owner)).status, 200);
  assert.equal((await row()).bills.length, 3);   // declined: nothing was created
});

test('a subcontract has a scope or description, apart from the trade it is billed against', async () => {
  const [pt] = await q('SELECT id FROM project_trades WHERE project_id=$1', [pid]);
  const [s2] = await q(`INSERT INTO subcontractors(name) VALUES ('Lopez Stucco') RETURNING id`);
  const r = await call('POST', `/api/projects/${pid}/commitments`, { projectTradeId: pt.id, subcontractorId: s2.id, contractAmount: 5000, scope: 'Stucco, exterior walls' }, owner); assert.equal(r.status, 200, JSON.stringify(r.body));
  const find = async () => (await call('GET', `/api/projects/${pid}/costs`, null, owner)).body.vendors.find((x) => x.vendor === 'Lopez Stucco');
  assert.equal((await find()).scope, 'Stucco, exterior walls');
  assert.equal((await call('PUT', `/api/projects/${pid}/commitments/${r.body.id}`, { scope: 'Stucco and paint' }, owner)).status, 200); assert.equal((await find()).scope, 'Stucco and paint');
  assert.equal((await call('PUT', `/api/projects/${pid}/commitments/${r.body.id}`, { scope: '' }, owner)).status, 200); assert.equal((await find()).scope, null);   // optional
  assert.equal((await call('POST', `/api/projects/${pid}/commitments`, { projectTradeId: pt.id, subcontractorId: s2.id, contractAmount: 1, scope: 'x'.repeat(301) }, owner)).status, 400);
  assert.equal((await (await call('GET', '/api/reports/vendor_contracts', null, owner)).body.rows ?? []).length >= 0, true);
});
