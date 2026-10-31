import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
const { pool, q } = await import('../server/db.js');
const { server } = await import('../server/index.js');
const { hashPassword } = await import('../server/auth.js');

let base, office, pm, pm2, pid, demo, dry, other, vendorId, supplierId;
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await applyAll(pool);
  const h = await hashPassword('correct horse battery');
  for (const [e, r] of [['office@x.net', 'Sub Admin'], ['pm@x.net', 'Project Manager'], ['pm2@x.net', 'Project Manager']]) await q('INSERT INTO app_users(email,name,role,password_hash) VALUES ($1,$1,$2,$3)', [e, r, h]);
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });
async function call(method, path, body, cookie) {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text(); return { status: res.status, body: t ? JSON.parse(t) : null, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
const login = async (email) => (await call('POST', '/api/login', { email, password: 'correct horse battery' })).cookie;
const P = (s = '') => `/api/projects/${pid}${s}`;
const trades = async () => (await call('GET', P(), null, office)).body;

test('setup: project with two trades, one vendor, one supplier', async () => {
  office = await login('office@x.net'); pm = await login('pm@x.net'); pm2 = await login('pm2@x.net');
  const t1 = (await call('POST', '/api/admin/trades', { name: 'Demolition' }, office)).body.id, t2 = (await call('POST', '/api/admin/trades', { name: 'Drywall' }, office)).body.id;
  const gc = (await call('POST', '/api/admin/gcs', { name: 'GC' }, office)).body.id;
  vendorId = (await call('POST', '/api/admin/subcontractors', { name: 'Atlas Interiors' }, office)).body.id;
  for (const d of [{ category: 'W-9', url: 'https://example.com/w9.pdf' }, { category: 'COI', url: 'https://example.com/coi.pdf', expiresOn: '2099-12-31' }]) assert.equal((await call('POST', `/api/admin/subcontractors/${vendorId}/documents`, d, office)).status, 200);
  supplierId = (await call('POST', '/api/admin/suppliers', { name: 'Build Supply Co.' }, office)).body.id;
  pid = (await call('POST', '/api/projects', { name: 'Proj', gcId: gc, client: 'C', address: 'A', retainagePct: 10, trades: [{ tradeId: t1, amount: 25000 }, { tradeId: t2, amount: 100000 }] }, office)).body.id;
  const p = await trades(); demo = p.trades.find((t) => t.name === 'Demolition').id; dry = p.trades.find((t) => t.name === 'Drywall').id;
  await q('INSERT INTO project_members SELECT $1, id FROM app_users WHERE email=$2', [pid, 'pm@x.net']);
});

let inv;
test('invoice defaults to 10% retainage; payments reduce what is due; retainage is held separately', async () => {
  const r = await call('POST', P('/invoices'), { projectTradeId: demo, number: 'INV-1', date: '2026-10-01', dueDate: '2026-10-31', amount: 10000 }, office);
  assert.equal(r.status, 200); inv = r.body.id;
  let d = (await trades()).trades.find((t) => t.id === demo);
  assert.deepEqual([d.billed, d.retainageOutstanding, d.currentlyDue, d.received, d.unbilled], [10000, 1000, 9000, 0, 15000]);
  assert.equal((await call('POST', P(`/invoices/${inv}/payments`), { date: '2026-10-15', amount: 9000 }, office)).status, 200);
  d = (await trades()).trades.find((t) => t.id === demo);
  assert.deepEqual([d.received, d.currentlyDue, d.retainageOutstanding, d.totalOwed], [9000, 0, 1000, 1000]);
  const b = (await call('GET', P('/billing'), null, office)).body[0];
  assert.equal(b.aging, 'Paid'); assert.equal(b.outstanding, 1000); assert.equal(b.payments.length, 1);
});

test('overpaying, over-releasing and over-billing are refused', async () => {
  assert.equal((await call('POST', P(`/invoices/${inv}/payments`), { date: '2026-10-16', amount: 0.01 }, office)).status, 400);
  assert.equal((await call('POST', P(`/invoices/${inv}/payments`), { date: '2026-10-16', amount: 1000.01, kind: 'Retainage Release' }, office)).status, 400);
  assert.equal((await call('POST', P(`/invoices/${inv}/payments`), { date: '2026-10-16', amount: 1000, kind: 'Retainage Release' }, office)).status, 200);
  assert.equal((await trades()).trades.find((t) => t.id === demo).totalOwed, 0);
  assert.equal((await call('POST', P('/invoices'), { projectTradeId: demo, number: 'INV-2', date: '2026-10-20', amount: 15000.01 }, office)).status, 400); // 10000 + 15000.01 > 25000
  assert.equal((await call('POST', P('/invoices'), { projectTradeId: demo, number: 'INV-2', date: '2026-10-20', amount: 100, retainageHeld: 101 }, office)).status, 400);
  assert.equal((await call('POST', P('/invoices'), { projectTradeId: demo, number: 'INV-2', date: '2026-13-40', amount: 100 }, office)).status, 400);
  assert.equal((await call('POST', P('/invoices'), { projectTradeId: demo, number: 'INV-2', date: '2026-10-20', dueDate: '2026-10-01', amount: 100 }, office)).status, 400);
  assert.equal((await call('PUT', P(`/invoices/${inv}`), { amount: 5000 }, office)).status, 400); // collected 10000 > new amount
  assert.equal((await call('POST', P('/invoices'), { projectTradeId: '00000000-0000-0000-0000-000000000000', number: 'X', date: '2026-10-20', amount: 1 }, office)).status, 400);
});

test('billed-to-date, retainage and received can all be corrected by editing', async () => {
  const r = await call('POST', P('/invoices'), { projectTradeId: dry, number: 'D-1', date: '2026-10-05', amount: 40000, retainageHeld: 0 }, office);
  assert.equal(r.status, 200);
  assert.equal((await call('PUT', P(`/invoices/${r.body.id}`), { retainageHeld: 4000 }, office)).status, 200);
  const d = (await trades()).trades.find((t) => t.id === dry);
  assert.deepEqual([d.billed, d.retainageOutstanding, d.currentlyDue], [40000, 4000, 36000]);
});

let com, bill;
test('vendor: $10,000 bill with $1,000 final-payment hold; hold stays in the payable until released', async () => {
  const c = await call('POST', P('/commitments'), { projectTradeId: demo, subcontractorId: vendorId, contractAmount: 10000, holdAmount: 1000, holdReason: 'Punch list' }, office);
  assert.equal(c.status, 200); com = c.body.id;
  assert.equal((await call('POST', P(`/commitments/${com}/bills`), { number: 'A-1', date: '2026-10-10', amount: 10000.01 }, office)).status, 400); // over contract
  const b = await call('POST', P(`/commitments/${com}/bills`), { number: 'A-1', date: '2026-10-10', amount: 10000 }, office); assert.equal(b.status, 200); bill = b.body.id;
  let v = (await call('GET', P('/costs'), null, office)).body.vendors[0];
  assert.deepEqual([v.invoiced, v.balance, v.held, v.availableToPay], [10000, 10000, 1000, 9000]);
  assert.equal((await call('POST', P(`/sub-bills/${bill}/payments`), { date: '2026-10-20', amount: 9000.01 }, office)).status, 400);
  assert.equal((await call('POST', P(`/sub-bills/${bill}/payments`), { date: '2026-10-20', amount: 9000 }, office)).status, 200);
  v = (await call('GET', P('/costs'), null, office)).body.vendors[0];
  assert.deepEqual([v.balance, v.held, v.availableToPay], [1000, 1000, 0]);
  assert.equal((await call('POST', P(`/sub-bills/${bill}/payments`), { date: '2026-10-21', amount: 1 }, office)).status, 400);
  const d = (await trades()).trades.find((t) => t.id === demo);
  assert.equal(d.actualCost, 10000); // expense is the bill, not the payments
  assert.equal(d.projectedProfit, 15000 - 0); // 25000 - 10000
  assert.equal((await call('PUT', P(`/commitments/${com}`), { holdReleased: true }, office)).status, 200);
  assert.equal((await call('POST', P(`/sub-bills/${bill}/payments`), { date: '2026-10-22', amount: 1000 }, office)).status, 200);
  assert.equal((await call('GET', P('/costs'), null, office)).body.vendors[0].balance, 0);
  assert.equal((await call('PUT', P(`/commitments/${com}`), { holdAmount: 20000 }, office)).status, 400);
});

test('supplier invoice split across trades; allocation must equal total; payments pro-rate', async () => {
  const body = (alloc, total = 3000) => ({ supplierId, reference: 'INV-9', date: '2026-10-12', total, allocations: alloc });
  assert.equal((await call('POST', '/api/supplier-invoices', body([{ projectId: pid, projectTradeId: demo, amount: 1000 }, { projectId: pid, projectTradeId: dry, amount: 1999 }]), office)).status, 400);
  assert.equal((await call('POST', '/api/supplier-invoices', body([]), office)).status, 400);
  const r = await call('POST', '/api/supplier-invoices', body([{ projectId: pid, projectTradeId: demo, amount: 1000 }, { projectId: pid, projectTradeId: dry, amount: 2000 }]), office);
  assert.equal(r.status, 200);
  assert.equal((await call('POST', '/api/supplier-invoices', body([{ projectId: pid, projectTradeId: demo, amount: 3000 }]), office)).status, 409); // same supplier + reference
  assert.equal((await call('POST', `/api/supplier-invoices/${r.body.id}/payments`, { date: '2026-10-25', amount: 1500 }, office)).status, 200);
  assert.equal((await call('POST', `/api/supplier-invoices/${r.body.id}/payments`, { date: '2026-10-25', amount: 1500.01 }, office)).status, 400);
  const s = (await call('GET', P('/costs'), null, office)).body.suppliers;
  assert.deepEqual(s.map((x) => [x.trade, x.amount, x.paid, x.balance]), [['Demolition', 1000, 500, 500], ['Drywall', 2000, 1000, 1000]]);
  const p = await trades();
  assert.equal(p.trades.find((t) => t.id === demo).actualCost, 11000);
  assert.equal(p.totals.actualCost, 13000);
  assert.equal((await call('POST', '/api/supplier-invoices', { supplierId, reference: 'BAD', total: 10, allocations: [{ projectId: pid, projectTradeId: '00000000-0000-0000-0000-000000000000', amount: 10 }] }, office)).status, 400);
});

test('access: PM can read their project but cannot enter money; other PMs are blocked', async () => {
  assert.equal((await call('GET', P('/billing'), null, pm)).status, 200);
  assert.equal((await call('GET', P('/costs'), null, pm)).status, 200);
  assert.equal((await call('POST', P('/invoices'), { projectTradeId: demo, number: 'Z', date: '2026-10-01', amount: 1 }, pm)).status, 403);
  assert.equal((await call('POST', P('/commitments'), { projectTradeId: demo, subcontractorId: vendorId, contractAmount: 1 }, pm)).status, 403);
  assert.equal((await call('POST', '/api/supplier-invoices', {}, pm)).status, 403);
  assert.equal((await call('GET', P('/billing'), null, pm2)).status, 403);
  assert.equal((await call('GET', P('/costs'), null)).status, 401);
});

test('dashboard payables reflect what is owed to vendors and suppliers', async () => {
  const d = (await call('GET', '/api/dashboard', null, office)).body;
  assert.equal(d.totalPayable, 1500); // suppliers: 3000 invoiced - 1500 paid; vendor fully paid
  assert.equal(d.billed, 50000); assert.equal(d.received, 10000);
});

test('deleting an invoice or bill re-checks the rules and removes its payments', async () => {
  assert.equal((await call('DELETE', P(`/invoices/${inv}`), null, office)).status, 200);
  assert.equal((await trades()).trades.find((t) => t.id === demo).received, 0);
  assert.equal((await call('DELETE', P(`/invoices/${inv}`), null, office)).status, 404);
  assert.equal((await call('DELETE', P(`/commitments/${com}/bills/${bill}`), null, office)).status, 200);
  assert.equal((await call('DELETE', P(`/commitments/${com}`), null, office)).status, 200);
});
