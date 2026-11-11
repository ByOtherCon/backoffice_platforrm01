import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
const { pool, q } = await import('../server/db.js');
const { server } = await import('../server/index.js');
const { hashPassword } = await import('../server/auth.js');

let base, owner, subadmin, office, pid, cid, bill;
const call = async (method, path, body, cookie) => { const r = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); let b = null; try { b = t ? JSON.parse(t) : null; } catch { b = t; } return { status: r.status, body: b }; };
const login = async (email) => (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct horse battery' }) })).headers.get('set-cookie').split(';')[0];
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  const h = await hashPassword('correct horse battery');
  for (const [e, r] of [['owner@x.net', 'Super Admin'], ['sub@x.net', 'Sub Admin'], ['office@x.net', 'Exec Assistant']]) await q('INSERT INTO app_users(email,name,role,password_hash) VALUES ($1,$1,$2,$3)', [e, r, h]);
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`; owner = await login('owner@x.net'); subadmin = await login('sub@x.net'); office = await login('office@x.net');
  const [g] = await q(`INSERT INTO gcs(name) VALUES ('GC') RETURNING id`), [t] = await q(`INSERT INTO trades(name,sort) VALUES ('Framing',1) RETURNING id`);
  [{ id: pid }] = await q(`INSERT INTO projects(name,gc_id,client,address) VALUES ('Job',$1,'C','A') RETURNING id`, [g.id]);
  const [pt] = await q('INSERT INTO project_trades(project_id,trade_id,original_amount) VALUES ($1,$2,50000) RETURNING id', [pid, t.id]);
  const [s] = await q(`INSERT INTO subcontractors(name) VALUES ('Unpapered Framing') RETURNING id`);   // no W-9, no insurance: unverified
  [{ id: cid }] = await q('INSERT INTO sub_commitments(project_id,project_trade_id,subcontractor_id,contract_amount) VALUES ($1,$2,$3,10000) RETURNING id', [pid, pt.id, s.id]);
  [{ id: bill }] = await q(`INSERT INTO sub_invoices(commitment_id,number,invoice_date,amount) VALUES ($1,'A-1','2026-11-01',4000) RETURNING id`, [cid]);
});
after(async () => { server.close(); await pool.end(); });

test('an unverified subcontractor cannot be paid by anyone, until the Super Admin confirms; then it goes through and is noted', async () => {
  const pay = (body, who) => call('POST', `/api/projects/${pid}/sub-bills/${bill}/payments`, { date: '2026-11-10', amount: 1000, ...body }, who);
  const stop = await pay({}, owner); assert.equal(stop.status, 409); assert.match(stop.body.error, /unverified subcontractor and cannot be paid/);   // the form shows this and asks "Proceed anyway?"
  assert.equal((await pay({ confirmUnverified: true }, subadmin)).status, 409);   // a Sub Admin cannot bypass it, whatever the request says
  assert.equal((await pay({ confirmUnverified: true }, office)).status, 403);
  assert.equal((await pay({ confirmUnverified: 'yes' }, owner)).status, 409);       // only a real true counts
  const ok = await pay({ confirmUnverified: true }, owner); assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const [p] = await q('SELECT amount::float8 AS amount, memo FROM sub_payments'); assert.equal(p.amount, 1000); assert.match(p.memo, /Paid while unverified \(No W-9 on file/);
});

test('the same applies to paying with no invoice and to approving or paying a request', async () => {
  const body = { method: 'Cash', date: '2026-11-10', amount: 500, explanation: 'Cash on site' };
  assert.equal((await call('POST', `/api/projects/${pid}/commitments/${cid}/pay-without-invoice`, body, owner)).status, 409);
  assert.equal((await call('POST', `/api/projects/${pid}/commitments/${cid}/pay-without-invoice`, { ...body, confirmUnverified: true }, subadmin)).status, 409);
  assert.equal((await call('POST', `/api/projects/${pid}/commitments/${cid}/pay-without-invoice`, { ...body, confirmUnverified: true }, owner)).status, 200);
  // an assistant's request for an unverified subcontractor is refused outright; once they are verified a request goes through and the owner approves it
  assert.equal((await call('POST', `/api/projects/${pid}/sub-bills/${bill}/payment-requests`, { amount: 100 }, office)).status, 409);
  await q(`UPDATE subcontractors SET verified_override=true`);
  const r = await call('POST', `/api/projects/${pid}/sub-bills/${bill}/payment-requests`, { amount: 100 }, office); assert.equal(r.status, 200);
  await q(`UPDATE subcontractors SET verified_override=false`);   // verification lapses before it is approved
  assert.equal((await call('POST', `/api/payment-requests/${r.body.id}/approve`, {}, owner)).status, 409);
  assert.equal((await call('POST', `/api/payment-requests/${r.body.id}/approve`, { confirmUnverified: true }, subadmin)).status, 409);
  assert.equal((await call('POST', `/api/payment-requests/${r.body.id}/approve`, { confirmUnverified: true }, owner)).status, 200);
  assert.equal((await call('POST', `/api/payment-requests/${r.body.id}/pay`, { date: '2026-11-11' }, office)).status, 409);   // the assistant records it: still blocked
  assert.equal((await call('POST', `/api/payment-requests/${r.body.id}/pay`, { date: '2026-11-11', confirmUnverified: true }, owner)).status, 200);
});
