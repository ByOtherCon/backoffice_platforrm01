import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
const { pool, q } = await import('../server/db.js');
const { server } = await import('../server/index.js');
const { hashPassword } = await import('../server/auth.js');

let base, owner, pid, pt, cid, bill, inv;
const call = async (method, path, body, cookie) => { const r = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); let b = null; try { b = t ? JSON.parse(t) : null; } catch { b = t; } return { status: r.status, body: b }; };
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  await q('INSERT INTO app_users(email,name,role,password_hash) VALUES ($1,$1,$2,$3)', ['owner@x.net', 'Super Admin', await hashPassword('correct horse battery')]);
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
  owner = (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@x.net', password: 'correct horse battery' }) })).headers.get('set-cookie').split(';')[0];
  const [g] = await q(`INSERT INTO gcs(name) VALUES ('GC') RETURNING id`), [t] = await q(`INSERT INTO trades(name,sort) VALUES ('Framing',1) RETURNING id`);
  [{ id: pid }] = await q(`INSERT INTO projects(name,gc_id,client,address) VALUES ('Job',$1,'C','A') RETURNING id`, [g.id]);
  [{ id: pt }] = await q('INSERT INTO project_trades(project_id,trade_id,original_amount) VALUES ($1,$2,5000) RETURNING id', [pid, t.id]);
  const [s] = await q(`INSERT INTO subcontractors(name,verified_override) VALUES ('Rivera',true) RETURNING id`);
  [{ id: cid }] = await q('INSERT INTO sub_commitments(project_id,project_trade_id,subcontractor_id,contract_amount) VALUES ($1,$2,$3,1000) RETURNING id', [pid, pt, s.id]);
  [{ id: bill }] = await q(`INSERT INTO sub_invoices(commitment_id,number,invoice_date,amount) VALUES ($1,'A-1','2026-11-01',1000) RETURNING id`, [cid]);
  [{ id: inv }] = await q(`INSERT INTO client_invoices(project_id,project_trade_id,number,invoice_date,amount,retainage_held) VALUES ($1,$2,'1001','2026-11-01',1000,0) RETURNING id`, [pid, pt]);
});
after(async () => { server.close(); await pool.end(); });

test('payments made at the same moment can never add up to more than is owed', async () => {
  const sub = await Promise.all(Array.from({ length: 10 }, () => call('POST', `/api/projects/${pid}/sub-bills/${bill}/payments`, { date: '2026-11-10', amount: 300 }, owner)));
  const ok = sub.filter((r) => r.status === 200).length; assert.equal(ok, 3, sub.map((r) => r.status).join(','));
  assert.equal((await q(`SELECT COALESCE(SUM(amount),0)::float8 n FROM sub_payments`))[0].n, 900);
  const cli = await Promise.all(Array.from({ length: 8 }, () => call('POST', `/api/projects/${pid}/invoices/${inv}/payments`, { date: '2026-11-10', amount: 300 }, owner)));
  assert.equal(cli.filter((r) => r.status === 200).length, 3, cli.map((r) => r.status).join(','));
  assert.equal((await q(`SELECT COALESCE(SUM(amount),0)::float8 n FROM client_payments`))[0].n, 900);
});

test('bills and no-invoice payments made at the same moment cannot pass the subcontract amount', async () => {
  await q('DELETE FROM sub_payments'); await q('DELETE FROM sub_invoices');
  const bills = await Promise.all(Array.from({ length: 6 }, (_, i) => call('POST', `/api/projects/${pid}/commitments/${cid}/bills`, { number: 'B' + i, date: '2026-11-10', amount: 400 }, owner)));
  assert.equal(bills.filter((r) => r.status === 200).length, 2, bills.map((r) => r.status).join(','));
  await q('DELETE FROM sub_invoices');
  const cash = await Promise.all(Array.from({ length: 6 }, () => call('POST', `/api/projects/${pid}/commitments/${cid}/pay-without-invoice`, { method: 'Cash', date: '2026-11-10', amount: 400, explanation: 'cash' }, owner)));
  assert.equal(cash.filter((r) => r.status === 200).length, 2, cash.map((r) => r.status).join(','));
  assert.equal((await q(`SELECT COALESCE(SUM(amount),0)::float8 n FROM sub_invoices`))[0].n, 800);
});
