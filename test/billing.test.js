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
  await q(`UPDATE subcontractors SET address='1 Main St', city='Orlando', state='FL', zip='32801', address_verified=true WHERE id=$1`, [vendorId]); assert.equal((await call('POST', `/api/admin/subcontractors/${vendorId}/confirm-address`, {}, office)).status, 200);   // a verified address that a person compared with the documents
  for (const d of [{ category: 'W-9', url: 'https://example.com/w9.pdf' }, { category: 'COI', url: 'https://example.com/coi.pdf', expiresOn: '2099-12-31' }]) assert.equal((await call('POST', `/api/admin/subcontractors/${vendorId}/documents`, d, office)).status, 200);
  supplierId = (await call('POST', '/api/admin/suppliers', { name: 'Build Supply Co.' }, office)).body.id;
  pid = (await call('POST', '/api/projects', { name: 'Proj', gcId: gc, client: 'C', address: 'A', retainagePct: 10, trades: [{ tradeId: t1, amount: 25000 }, { tradeId: t2, amount: 100000 }] }, office)).body.id;
  const p = await trades(); demo = p.trades.find((t) => t.name === 'Demolition').id; dry = p.trades.find((t) => t.name === 'Drywall').id;
  await q('INSERT INTO project_members SELECT $1, id FROM app_users WHERE email=$2', [pid, 'pm@x.net']);
});

let inv;
test('retainage is held only when entered; payments reduce what is due; retainage is held separately', async () => {
  const r = await call('POST', P('/invoices'), { projectTradeId: demo, number: 'INV-1', date: '2026-10-01', dueDate: '2026-10-31', amount: 10000, retainageHeld: 1000 }, office);
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
  // a blank retainage box means none: on a new invoice and when editing one (the project's percent is never added by itself)
  assert.equal((await call('PUT', P(`/invoices/${r.body.id}`), { retainageHeld: '' }, office)).status, 200);
  const e = (await trades()).trades.find((t) => t.id === dry); assert.deepEqual([e.retainageOutstanding, e.currentlyDue], [0, 40000]);
  const blank = await call('POST', P('/invoices'), { projectTradeId: dry, number: 'D-2', date: '2026-10-06', amount: 100, retainageHeld: '' }, office); assert.equal(blank.status, 200);
  assert.equal((await q(`SELECT retainage_held::float8 AS r FROM client_invoices WHERE number='D-2'`))[0].r, 0);
  await q(`DELETE FROM client_invoices WHERE number='D-2'`);
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

test('billing notes: anyone who can see the billing adds them, newest first; only the writer or an admin edits or deletes one; others cannot see them', async () => {
  assert.equal((await call('POST', P('/billing-notes'), { body: '' }, office)).status, 400);
  assert.equal((await call('POST', P('/billing-notes'), { body: 'Pay app goes to the GC by the 25th.' }, office)).status, 200);
  assert.equal((await call('POST', P('/billing-notes'), { body: 'GC says retainage released at\nsubstantial completion.' }, pm)).status, 200);
  assert.equal((await call('GET', P('/billing-notes'), null, pm2)).status, 403);   // a PM not on this job
  assert.equal((await call('POST', P('/billing-notes'), { body: 'x' }, pm2)).status, 403);
  let notes = (await call('GET', P('/billing-notes'), null, pm)).body;
  assert.deepEqual(notes.map((n) => [n.body, n.by, n.canChange]), [['GC says retainage released at\nsubstantial completion.', 'pm@x.net', true], ['Pay app goes to the GC by the 25th.', 'office@x.net', false]]);
  assert.equal((await call('PUT', P(`/billing-notes/${notes[1].id}`), { body: 'changed' }, pm)).status, 403); assert.equal((await call('DELETE', P(`/billing-notes/${notes[1].id}`), null, pm)).status, 403);
  assert.equal((await call('PUT', P(`/billing-notes/${notes[0].id}`), { body: 'Retainage released at substantial completion.' }, pm)).status, 200);
  assert.equal((await call('DELETE', P(`/billing-notes/${notes[0].id}`), null, office)).status, 200);   // an admin can remove anyone's
  notes = (await call('GET', P('/billing-notes'), null, office)).body; assert.deepEqual(notes.map((n) => n.body), ['Pay app goes to the GC by the 25th.']);
});

test('entries are edited in place: a GC payment, a subcontractor bill and its payment, a vendor invoice with its lines and payments, a document; the money rules still hold', async () => {
  // a payment from the GC
  const iv = (await call('POST', P('/invoices'), { projectTradeId: dry, number: 'E-1', date: '2026-11-01', amount: 5000, retainageHeld: 0 }, office)).body.id;
  assert.equal((await call('POST', P(`/invoices/${iv}/payments`), { date: '2026-11-05', amount: 1000 }, office)).status, 200);
  const payId = (await q('SELECT id FROM client_payments WHERE client_invoice_id=$1', [iv]))[0].id;
  assert.equal((await call('PUT', P(`/invoices/${iv}/payments/${payId}`), { date: '2026-11-06', amount: 2000 }, pm)).status, 403);   // a PM reads, does not enter money
  assert.equal((await call('PUT', P(`/invoices/${iv}/payments/${payId}`), { date: '2026-11-06', amount: 2000 }, office)).status, 200);
  assert.equal((await call('PUT', P(`/invoices/${iv}/payments/${payId}`), { date: '2026-11-06', amount: 6000 }, office)).status, 400);   // more than the invoice
  assert.deepEqual((await q('SELECT paid_date::text AS d, amount::float AS a FROM client_payments WHERE id=$1', [payId]))[0], { d: '2026-11-06', a: 2000 });
  // a subcontractor's bill and the payment on it
  const com = (await call('POST', P('/commitments'), { projectTradeId: dry, subcontractorId: vendorId, contractAmount: 20000 }, office)).body.id;
  const bid = (await call('POST', P(`/commitments/${com}/bills`), { number: 'B-1', date: '2026-11-02', amount: 8000 }, office)).body.id;
  assert.equal((await call('POST', P(`/sub-bills/${bid}/payments`), { date: '2026-11-10', amount: 5000 }, office)).status, 200);
  assert.equal((await call('PUT', P(`/commitments/${com}/bills/${bid}`), { number: 'B-1', date: '2026-11-02', amount: 4000 }, office)).status, 400);   // less than paid
  assert.equal((await call('PUT', P(`/commitments/${com}/bills/${bid}`), { number: 'B-1A', date: '2026-11-03', amount: 9000 }, office)).status, 200);
  const sp = (await q('SELECT id FROM sub_payments WHERE sub_invoice_id=$1', [bid]))[0].id;
  assert.equal((await call('PUT', P(`/sub-payments/${sp}`), { date: '2026-11-11', amount: 9500 }, office)).status, 400);   // more than the bill
  const ed = await call('PUT', P(`/sub-payments/${sp}`), { date: '2026-11-11', amount: 6000 }, office); assert.equal(ed.status, 200, JSON.stringify(ed.body));
  assert.deepEqual(await q('SELECT number, amount::float AS a FROM sub_invoices WHERE id=$1', [bid]), [{ number: 'B-1A', a: 9000 }]);
  assert.deepEqual(await q('SELECT paid_date::text AS d, amount::float AS a FROM sub_payments WHERE sub_invoice_id=$1', [bid]), [{ d: '2026-11-11', a: 6000 }]);
  // a vendor invoice: lines, number and payments
  const vi = (await call('POST', '/api/supplier-invoices', { supplierId, reference: 'HD-1', date: '2026-11-04', total: 300, paid: true, paidDate: '2026-11-04', allocations: [{ projectId: pid, projectTradeId: dry, amount: 300 }] }, office)).body.id;
  const got = (await call('GET', `/api/supplier-invoices/${vi}`, null, office)).body; assert.deepEqual([got.reference, got.total, got.paid, got.lines.length, got.payments.length], ['HD-1', 300, 300, 1, 1]);
  const lines = [{ description: 'Studs', amount: 250, itemKind: 'Materials', projectId: pid, projectTradeId: dry }, { description: 'Screws', amount: 150, itemKind: 'Materials', projectId: pid, projectTradeId: demo }];
  assert.equal((await call('PUT', `/api/supplier-invoices/${vi}`, { reference: 'HD-1B', date: '2026-11-04', lines, payments: [{ id: got.payments[0].id, date: '2026-11-04', amount: 500 }] }, office)).status, 400);   // payments over the total
  const up = await call('PUT', `/api/supplier-invoices/${vi}`, { reference: 'HD-1B', date: '2026-11-05', description: 'Framing materials', lines, payments: [{ id: got.payments[0].id, date: '2026-11-04', amount: 400 }] }, office); assert.equal(up.status, 200, JSON.stringify(up.body));
  const after = (await call('GET', `/api/supplier-invoices/${vi}`, null, office)).body;
  assert.deepEqual([after.reference, after.date, after.total, after.paid, after.description, after.lines.map((l) => [l.description, l.amount])], ['HD-1B', '2026-11-05', 400, 400, 'Framing materials', [['Studs', 250], ['Screws', 150]]]);
  assert.equal(after.payments[0].id, got.payments[0].id);   // the same payment, changed
  assert.equal((await call('PUT', `/api/supplier-invoices/${vi}`, { reference: 'HD-1B', date: '2026-11-05', lines: [{ amount: 100, projectId: pid }] }, office)).status, 400);   // under what was paid
  assert.equal((await call('PUT', `/api/supplier-invoices/${vi}`, { reference: 'X', date: '2026-11-05', lines }, pm)).status, 403);
  // a document: name, type, expiry
  const [{ id: doc }] = await q(`INSERT INTO documents(category,name,url,project_id) VALUES ('Other','scan001.pdf','https://example.com/a.pdf',$1) RETURNING id`, [pid]);
  assert.equal((await call('PUT', `/api/documents/${doc}`, { name: 'Signed change order 3', category: 'Approved CO', expiresOn: '' }, office)).status, 200);
  assert.deepEqual((await q('SELECT name, category FROM documents WHERE id=$1', [doc]))[0], { name: 'Signed change order 3', category: 'Approved CO' });
  assert.equal((await call('PUT', `/api/documents/${doc}`, { name: 'x', category: 'W-9' }, office)).status, 400);   // a W-9 keeps its own path
});
