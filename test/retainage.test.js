import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
const { pool, q } = await import('../server/db.js');
const { server } = await import('../server/index.js');
const { hashPassword } = await import('../server/auth.js');
const { tradeStats, retainageOn } = await import('../src/lib/costing.ts');

let base, office, pm, pid, demo, dry, gc, t1, t2;
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  const h = await hashPassword('correct horse battery');
  for (const [e, r] of [['office@x.net', 'Sub Admin'], ['pm@x.net', 'Project Manager']]) await q('INSERT INTO app_users(email,name,role,password_hash) VALUES ($1,$1,$2,$3)', [e, r, h]);
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });
async function call(method, path, body, cookie) {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text(); return { status: res.status, body: t ? JSON.parse(t) : null, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
const login = async (email) => (await call('POST', '/api/login', { email, password: 'correct horse battery' })).cookie;
const P = (s = '') => `/api/projects/${pid}${s}`;
const totals = async () => (await call('GET', P(), null, office)).body.totals;
const billing = async () => (await call('GET', P('/billing'), null, office)).body;
const newProject = async (name, pct) => { const b = { name, gcId: gc, client: 'C', address: 'A', trades: [{ tradeId: t1, amount: 40000 }, { tradeId: t2, amount: 60000 }] }; if (pct !== undefined) b.retainagePct = pct; return (await call('POST', '/api/projects', b, office)).body.id; };

test('the rule in numbers: a 45,000 invoice at 10% is 50,000 of work with 5,000 held back', () => {
  assert.equal(retainageOn(45000, 10), 5000); assert.equal(retainageOn(9000, 10), 1000); assert.equal(retainageOn(1000, 0), 0); assert.equal(retainageOn(3409, 10), 378.78); assert.equal(retainageOn(950, 5), 50);
  const inv = (payable, paid) => ({ amount: payable + retainageOn(payable, 10), retainageHeld: retainageOn(payable, 10), payments: paid, retainageReleased: 0 });
  const base = { original: 100000, cos: [], subs: [], suppliers: [], labor: [] };
  let s = tradeStats({ ...base, invoices: [inv(45000, 45000), inv(45000, 20000)] });
  assert.deepEqual([s.billed, s.invoiced, s.received, s.retainageOutstanding, s.currentlyDue, s.unbilled, s.totalOwed], [100000, 90000, 65000, 10000, 25000, 0, 35000]);
  // the final retainage invoice: not new work, owed until paid
  s = tradeStats({ ...base, invoices: [inv(45000, 45000), inv(45000, 45000), { amount: 10000, retainageHeld: 0, payments: 0, retainageReleased: 0, retainageInvoice: true }] });
  assert.deepEqual([s.billed, s.invoiced, s.retainageOutstanding, s.currentlyDue, s.retainageInvoiced], [100000, 100000, 0, 10000, 10000]);
  s = tradeStats({ ...base, invoices: [inv(45000, 45000), inv(45000, 45000), { amount: 10000, retainageHeld: 0, payments: 10000, retainageReleased: 0, retainageInvoice: true }] });
  assert.deepEqual([s.received, s.currentlyDue, s.totalOwed], [100000, 0, 0]);
  // retainage invoiced that was never logged still counts toward the contract, so the totals add up
  s = tradeStats({ ...base, invoices: [{ amount: 90000, retainageHeld: 0, payments: 90000, retainageReleased: 0 }, { amount: 10000, retainageHeld: 0, payments: 0, retainageReleased: 0, retainageInvoice: true }] });
  assert.deepEqual([s.billed, s.retainageOutstanding, s.currentlyDue, s.unbilled], [100000, 0, 10000, 0]);
});

test('a new project holds no retainage unless a percent is given', async () => {
  office = await login('office@x.net'); pm = await login('pm@x.net');
  t1 = (await call('POST', '/api/admin/trades', { name: 'Demolition' }, office)).body.id; t2 = (await call('POST', '/api/admin/trades', { name: 'Drywall' }, office)).body.id;
  gc = (await call('POST', '/api/admin/gcs', { name: 'GC' }, office)).body.id;
  const none = await newProject('No Retainage');
  assert.equal((await call('GET', `/api/projects/${none}`, null, office)).body.project.retainagePct, 0);
  pid = await newProject('Ten Percent', 10); const p = (await call('GET', P(), null, office)).body; assert.equal(p.project.retainagePct, 10);
  demo = p.trades.find((t) => t.name === 'Demolition').id; dry = p.trades.find((t) => t.name === 'Drywall').id;
});

test('an invoice entered by hand is what gets paid: retainage is logged from the project percent and never taken off; it can be typed or left out', async () => {
  const a = await call('POST', P('/invoices'), { projectTradeId: demo, number: 'A-1', date: '2026-10-01', payable: 9000 }, office); assert.equal(a.status, 200, JSON.stringify(a.body));
  let [i] = await billing(); assert.deepEqual([i.payable, i.retainageHeld, i.amount, i.owed, i.retainageInvoice], [9000, 1000, 10000, 9000, false]);
  assert.equal((await call('POST', P(`/invoices/${i.id}/payments`), { amount: 9000, date: '2026-10-20' }, office)).status, 200);   // the whole invoice is paid; nothing was deducted
  [i] = await billing(); assert.deepEqual([i.owed, i.collected, i.aging], [0, 9000, 'Paid']);
  let t = await totals(); assert.deepEqual([t.billed, t.invoiced, t.received, t.retainageOutstanding, t.currentlyDue], [10000, 9000, 9000, 1000, 0]);
  // typed retainage, and none at all
  assert.equal((await call('POST', P('/invoices'), { projectTradeId: dry, number: 'A-2', date: '2026-10-05', payable: 5000, retainageHeld: 250 }, office)).status, 200);
  assert.equal((await call('POST', P('/invoices'), { projectTradeId: dry, number: 'A-3', date: '2026-10-06', payable: 700, retainageHeld: '' }, office)).status, 200);
  const by = Object.fromEntries((await billing()).map((x) => [x.number, x]));
  assert.deepEqual([by['A-2'].payable, by['A-2'].retainageHeld, by['A-2'].amount], [5000, 250, 5250]); assert.deepEqual([by['A-3'].payable, by['A-3'].retainageHeld, by['A-3'].amount], [700, 0, 700]);
  // editing: the invoice amount and the retainage logged change separately
  assert.equal((await call('PUT', P(`/invoices/${by['A-2'].id}`), { payable: 5400, retainageHeld: 600 }, office)).status, 200);
  const e = (await billing()).find((x) => x.number === 'A-2'); assert.deepEqual([e.payable, e.retainageHeld, e.amount], [5400, 600, 6000]);
  assert.equal((await call('PUT', P(`/invoices/${by['A-3'].id}`), { retainageHeld: 77.78 }, office)).status, 200);
  const f = (await billing()).find((x) => x.number === 'A-3'); assert.deepEqual([f.payable, f.retainageHeld, f.amount], [700, 77.78, 777.78]);   // the invoice itself did not move
});

test('the retainage invoice entered by hand: shared over the trades by the retainage each has held, not new work, owed until paid', async () => {
  let t = await totals(); const heldBefore = t.retainageOutstanding, billedBefore = t.billed; assert.equal(heldBefore, 1677.78);   // 1,000 on Demolition, 677.78 on Drywall
  assert.equal((await call('POST', P('/invoices'), { retainageInvoice: true, number: 'RET-1', date: '2026-12-01', payable: 1677.78 }, pm)).status, 403);
  const r = await call('POST', P('/invoices'), { retainageInvoice: true, number: 'RET-1', date: '2026-12-01', payable: 1677.78 }, office); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.rows, 2);
  const rows = (await billing()).filter((x) => x.number === 'RET-1').sort((x, y) => x.amount - y.amount);
  assert.deepEqual(rows.map((x) => [x.trade, x.amount, x.retainageHeld, x.retainageInvoice, x.owed]), [['Drywall', 677.78, 0, true, 677.78], ['Demolition', 1000, 0, true, 1000]]);
  t = await totals(); assert.deepEqual([t.billed, t.retainageOutstanding, t.retainageInvoiced], [billedBefore, 0, 1677.78]);   // nothing new was billed against the contract
  assert.equal((await call('PUT', P(`/invoices/${rows[0].id}`), { retainageHeld: 50 }, office)).status, 200);
  assert.equal((await billing()).find((x) => x.id === rows[0].id).retainageHeld, 0);   // a retainage invoice never holds retainage itself
});

test('Update Retainage lists what would change on older invoices and changes nothing until it is applied', async () => {
  pid = await newProject('Old Invoices', 10); const p = (await call('GET', P(), null, office)).body; demo = p.trades.find((t) => t.name === 'Demolition').id; dry = p.trades.find((t) => t.name === 'Drywall').id;
  // the old way: retainage typed on the invoice was taken off it (a 9,000 invoice with 900 "held" showed 8,100 owed), and one with none
  await q(`INSERT INTO client_invoices(project_id,project_trade_id,number,invoice_date,amount,retainage_held) VALUES ($1,$2,'OLD-1','2026-09-01',9000,900), ($1,$3,'OLD-2','2026-09-02',4500,0)`, [pid, demo, dry]);
  // from QuickBooks with its own retainage line: the lines are the work, the line is what is held. Already right.
  await q(`INSERT INTO qb_invoices(qb_id,doc_number,total,lines,status,imported_total,project_id) VALUES ('q1','QB-1',1800,$2,'Imported',1800,$1)`, [pid, JSON.stringify([{ description: 'Demolition', itemName: 'Demolition', amount: 2000, retainage: false }, { description: 'Retainage', itemName: '', amount: -200, retainage: true }])]);
  await q(`INSERT INTO client_invoices(project_id,project_trade_id,number,invoice_date,amount,retainage_held,qb_invoice_id) VALUES ($1,$2,'QB-1','2026-09-03',2000,200,'q1')`, [pid, demo]);
  // from QuickBooks without one, where retainage was typed at import and taken off the invoice
  await q(`INSERT INTO qb_invoices(qb_id,doc_number,total,lines,status,imported_total,project_id) VALUES ('q2','QB-2',2700,$2,'Imported',2700,$1)`, [pid, JSON.stringify([{ description: 'Drywall', itemName: 'Services', amount: 2700, retainage: false }])]);
  await q(`INSERT INTO client_invoices(project_id,project_trade_id,number,invoice_date,amount,retainage_held,qb_invoice_id) VALUES ($1,$2,'QB-2','2026-09-04',2700,270,'q2')`, [pid, dry]);
  assert.equal((await call('GET', P('/retainage-check'), null, pm)).status, 403);
  const c = (await call('GET', P('/retainage-check'), null, office)).body; assert.equal(c.pct, 10);
  assert.deepEqual(c.rows.map((r) => [r.number, r.owedNow, r.loggedNow, r.owedAfter, r.loggedAfter, r.workBilledAfter]), [['OLD-1', 8100, 900, 9000, 1000, 10000], ['OLD-2', 4500, 0, 4500, 500, 5000], ['QB-2', 2430, 270, 2700, 300, 3000]]);
  assert.match(c.rows[0].note, /Entered by hand/); assert.match(c.rows[2].note, /taken off the QuickBooks invoice/); assert.deepEqual(c.totals, { owedNow: 15030, owedAfter: 16200, loggedNow: 1170, loggedAfter: 1800 });
  assert.equal((await billing()).find((x) => x.number === 'OLD-1').owed, 8100);   // looking changes nothing
  const a = await call('POST', P('/retainage-apply'), {}, office); assert.equal(a.status, 200, JSON.stringify(a.body)); assert.equal(a.body.changed, 3);
  const by = Object.fromEntries((await billing()).map((x) => [x.number, x]));
  assert.deepEqual([by['OLD-1'].payable, by['OLD-1'].retainageHeld, by['OLD-1'].owed], [9000, 1000, 9000]); assert.deepEqual([by['QB-2'].payable, by['QB-2'].retainageHeld], [2700, 300]);
  assert.deepEqual([by['QB-1'].payable, by['QB-1'].retainageHeld, by['QB-1'].amount], [1800, 200, 2000]);   // left alone
  assert.deepEqual((await call('GET', P('/retainage-check'), null, office)).body.rows, []);   // nothing left to do, and running it again changes nothing
  assert.equal((await call('POST', P('/retainage-apply'), {}, office)).body.changed, 0);
});

test('changing the project percent offers the same update: to 0 removes the log, the invoices stay what is owed', async () => {
  assert.equal((await call('PUT', P(), { retainagePct: 0 }, office)).status, 200);
  const c = (await call('GET', P('/retainage-check'), null, office)).body;
  assert.deepEqual(c.rows.map((r) => [r.number, r.owedNow, r.owedAfter, r.loggedAfter]), [['OLD-1', 9000, 9000, 0], ['OLD-2', 4500, 4500, 0], ['QB-2', 2700, 2700, 0]]);
  assert.equal((await call('POST', P('/retainage-apply'), {}, office)).body.changed, 3);
  const t = await totals(); assert.deepEqual([t.invoiced, t.retainageOutstanding], [18000, 200]);   // only the QuickBooks invoice with its own retainage line still holds any
});

test('Update Retainage is refused whole when the work billed would pass a trade contract, and says why', async () => {
  pid = await newProject('Tight', 0); const p = (await call('GET', P(), null, office)).body; demo = p.trades.find((t) => t.name === 'Demolition').id;
  assert.equal((await call('POST', P('/invoices'), { projectTradeId: demo, number: 'T-1', date: '2026-10-01', payable: 39000 }, office)).status, 200);
  assert.equal((await call('PUT', P(), { retainagePct: 10 }, office)).status, 200);
  const r = await call('POST', P('/retainage-apply'), {}, office); assert.equal(r.status, 400); assert.match(r.body.error, /^Not changed\. Demolition: Billed to date cannot exceed/); assert.match(r.body.error, /retainage logged counts as work billed/);
  assert.equal((await billing())[0].retainageHeld, 0);
});
