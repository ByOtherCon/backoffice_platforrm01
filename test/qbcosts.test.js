import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
process.env.PUBLIC_URL = 'https://desk.example.com'; process.env.SECRET_KEY = 'test-secret-key-0123456789';
Object.assign(process.env, { QBO_CLIENT_ID: 'cid', QBO_CLIENT_SECRET: 'csecret', QBO_ENVIRONMENT: 'sandbox' });
const { pool, q } = await import('../server/db.js');
const { server } = await import('../server/index.js');
const { hashPassword } = await import('../server/auth.js');
const bd = await import('../server/bids.js');
const qbo = await import('../server/quickbooks.js');
const { readCostLines, guessOverhead, looksNonProject, vendorKey } = await import('../src/lib/qbmatch.ts');

let base, owner, asst, pm, pid, tDemo, tDry, ptDemo, ptDry, queries = [], bills, purchases, billPays;
const LU = '2026-11-04T10:00:00-05:00';
const exp = (amount, desc, acct = 'Job Materials', cust = null) => ({ DetailType: 'AccountBasedExpenseLineDetail', Amount: amount, Description: desc, AccountBasedExpenseLineDetail: { AccountRef: { name: acct }, ...(cust ? { CustomerRef: cust } : {}) } });
const fixtures = () => {
  bills = [
    { Id: 'B1', DocNumber: 'INV-5001', TxnDate: '2026-11-02', TotalAmt: 1500, Balance: 1500, VendorRef: { value: 'V1', name: 'Gold Coast Drywall Supply' }, MetaData: { LastUpdatedTime: LU }, Line: [exp(1000, 'Drywall board 5/8 x 4 x 12', 'Job Materials'), exp(500, 'Metal studs framing', 'Job Materials')] },
    { Id: 'B2', DocNumber: 'P-77', TxnDate: '2026-11-03', TotalAmt: 3200, Balance: 3200, VendorRef: { value: 'V9', name: 'Acme Insurance Co' }, MetaData: { LastUpdatedTime: LU }, Line: [exp(3200, 'General liability premium', 'Insurance')] },
  ];
  purchases = [
    { Id: 'P1', PaymentType: 'Check', DocNumber: '1042', TxnDate: '2026-11-03', TotalAmt: 800, EntityRef: { value: 'V3', name: 'Sunbelt Rentals' }, AccountRef: { name: 'Operating Checking' }, MetaData: { LastUpdatedTime: LU }, Line: [exp(800, 'Lift rental for Mall at Millenia', 'Equipment Rental', { value: '55', name: 'Sachse Construction:Mall at Millenia' })] },
    { Id: 'P2', PaymentType: 'CreditCard', TxnDate: '2026-11-04', TotalAmt: 90, EntityRef: { value: 'V4', name: 'Shell Oil' }, AccountRef: { name: 'Visa 4242' }, MetaData: { LastUpdatedTime: LU }, Line: [exp(90, 'Fuel', 'Auto & fuel')] },
    { Id: 'P3', PaymentType: 'Check', DocNumber: '1043', TxnDate: '2026-11-04', TotalAmt: 400, EntityRef: { value: 'V5', name: 'IRS' }, AccountRef: { name: 'Operating Checking' }, MetaData: { LastUpdatedTime: LU }, Line: [exp(400, 'Payroll tax deposit', 'Payroll Taxes')] },
    { Id: 'P4', PaymentType: 'CreditCard', TxnDate: '2026-11-04', TotalAmt: 50, Credit: true, EntityRef: { value: 'V4', name: 'Shell Oil' }, AccountRef: { name: 'Visa 4242' }, MetaData: { LastUpdatedTime: LU }, Line: [exp(50, 'Refund', 'Auto & fuel')] },
    { Id: 'P5', PaymentType: 'Check', DocNumber: '1044', TxnDate: '2026-11-04', TotalAmt: 2000, EntityRef: { value: 'V6', name: 'Rivera Framing LLC' }, AccountRef: { name: 'Operating Checking' }, MetaData: { LastUpdatedTime: LU }, Line: [exp(2000, 'Framing labor', 'Subcontractors')] },
    { Id: 'P0', PaymentType: 'Check', DocNumber: '900', TxnDate: '2025-06-01', TotalAmt: 10, EntityRef: { value: 'V3', name: 'Sunbelt Rentals' }, MetaData: { LastUpdatedTime: LU }, Line: [exp(10, 'Old')] },
  ];
  billPays = [];
};
const intuit = async (url) => {
  const u = new URL(url), res = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  if (u.hostname === 'oauth.platform.intuit.com') return res({ access_token: 'a', refresh_token: 'r', expires_in: 3600 });
  const sql = u.searchParams.get('query') || ''; if (sql) queries.push(sql);
  const startOk = (x) => { const m = sql.match(/TxnDate >= '(\d{4}-\d{2}-\d{2})'/); return !m || x.TxnDate >= m[1]; };
  if (/from Bill\b/.test(sql)) return res({ QueryResponse: { Bill: bills.filter(startOk) } }); if (/from Purchase\b/.test(sql)) return res({ QueryResponse: { Purchase: purchases.filter(startOk) } });
  if (/from BillPayment\b/.test(sql)) return res({ QueryResponse: { BillPayment: billPays } });
  return res({}, 404);
};
const call = async (method, path, body, cookie) => { const r = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); let b = null; try { b = t ? JSON.parse(t) : null; } catch { b = t; } return { status: r.status, body: b }; };
const login = async (email) => (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct horse battery' }) })).headers.get('set-cookie').split(';')[0];
const all = async () => (await call('GET', '/api/quickbooks/costs?status=All', null, owner)).body;
const find = async (vendor, number) => (await all()).find((c) => c.vendor === vendor && (!number || c.number === number));
const sync = () => call('POST', '/api/quickbooks/costs/sync', {}, asst);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  const h = await hashPassword('correct horse battery');
  for (const [e, r] of [['owner@x.net', 'Super Admin'], ['asst@x.net', 'Exec Assistant'], ['pm@x.net', 'Project Manager']]) await q('INSERT INTO app_users(email,name,role,password_hash) VALUES ($1,$2,$3,$4)', [e, e, r, h]);
  [tDemo, tDry] = (await Promise.all([['Demolition', 1], ['Framing & Drywall', 2]].map(([n, s]) => q('INSERT INTO trades(name,sort) VALUES ($1,$2) RETURNING id', [n, s])))).map((r) => r[0].id);
  const [g] = await q(`INSERT INTO gcs(name) VALUES ('Sachse Construction') RETURNING id`);
  [{ id: pid }] = await q(`INSERT INTO projects(name,gc_id,client,address,proposal_id,ref_code,retainage_pct) VALUES ('Mall at Millenia',$1,'Sachse','1 Mall Dr',$2,$3,10) RETURNING id`, [g.id, 'P11031', 'C11031']);
  [{ id: ptDemo }, { id: ptDry }] = await q('INSERT INTO project_trades(project_id,trade_id,original_amount) VALUES ($1,$2,20000),($1,$3,60000) RETURNING id', [pid, tDemo, tDry]);
  await q(`INSERT INTO subcontractors(name) VALUES ('Rivera Framing, LLC')`);
  await q(`INSERT INTO integrations(name,data) VALUES ('quickbooks',$1)`, [{ realmId: '9130', refresh: bd.seal('r'), environment: 'sandbox', company: 'Sandbox', connectedAt: new Date().toISOString() }]);
  qbo.setIntuitFetch(intuit); fixtures();
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
  owner = await login('owner@x.net'); asst = await login('asst@x.net'); pm = await login('pm@x.net');
});
after(async () => { server.close(); await pool.end(); });

test('the cost rules: lines, vendor key, overhead guess and the non-project hint', () => {
  assert.deepEqual(readCostLines([exp(10, 'x', 'Acct', { value: '5', name: 'GC:Job' }), { DetailType: 'SubTotalLineDetail', Amount: 10 }, { DetailType: 'ItemBasedExpenseLineDetail', Amount: 5, ItemBasedExpenseLineDetail: { ItemRef: { name: 'Studs' } } }]).map((l) => [l.amount, l.account, l.item, l.customerName]), [[10, 'Acct', '', 'GC:Job'], [5, '', 'Studs', null]]);
  assert.equal(vendorKey('V1', 'x'), 'id:V1'); assert.equal(vendorKey(null, 'Shell Oil Co.'), 'name:shell oil co');
  assert.equal(guessOverhead('Insurance', 'Acme'), 'Insurance'); assert.equal(guessOverhead('Auto & fuel', 'Shell'), 'Vehicles & fuel'); assert.equal(guessOverhead('Job Materials', 'Gold Coast Drywall'), null);
  assert.ok(looksNonProject('IRS', 'Payroll Taxes')); assert.ok(looksNonProject('Acme Insurance Co')); assert.ok(!looksNonProject('Gold Coast Drywall Supply'));
});

test('sync stages costs (nothing touches costing), honours the start date, refuses refunds, and who may use it', async () => {
  assert.equal((await call('POST', '/api/quickbooks/costs/sync', {}, pm)).status, 403); assert.equal((await call('GET', '/api/quickbooks/costs', null, pm)).status, 403);
  assert.equal((await call('PUT', '/api/quickbooks/settings', { startDate: '2026-01-01', autoImport: false }, asst)).status, 200);
  const r = (await sync()).body; assert.deepEqual([r.added, r.seen], [7, 7]);   // two bills + five purchases dated this year; the 2025 check is never read
  assert.ok(queries.some((x) => /from Bill where TxnDate >= '2026-01-01'/.test(x))); assert.equal((await q('SELECT count(*)::int n FROM supplier_invoices'))[0].n, 0);
  const rows = await all(); assert.equal(rows.find((c) => c.vendor === 'Shell Oil' && c.total === 50).status, 'Ignored');   // a refund is not a cost
  const b1 = rows.find((c) => c.number === 'INV-5001'); assert.deepEqual([b1.kind, b1.total, b1.lines.length, b1.suggestedProjectId], ['Bill', 1500, 2, null]);
  const p1 = rows.find((c) => c.number === '1042'); assert.equal(p1.suggestedProjectId, pid); assert.match(p1.suggestedBy, /customer/); assert.equal(p1.kind, 'Check');   // the customer on the line is "GC:Job"
  assert.equal(rows.find((c) => c.vendor === 'Acme Insurance Co').suggestedOverhead, 'Insurance'); assert.ok(rows.find((c) => c.vendor === 'IRS').looksNonProject); assert.ok(rows.find((c) => c.vendor === 'Rivera Framing LLC').isSubcontractor);
  assert.equal((await sync()).body.added, 0);   // safe to repeat
});

test('import to a trade, the whole project, or overhead; the vendor invoice follows the costing rules; a bill is unpaid, a check is paid', async () => {
  const b1 = await find('Gold Coast Drywall Supply'); const prep = (await call('GET', `/api/quickbooks/costs/${b1.id}/prepare?projectId=${pid}`, null, asst)).body;
  assert.deepEqual(prep.project.trades.map((t) => t.name), ['Demolition', 'Framing & Drywall']); assert.deepEqual(prep.guess, [ptDry, ptDry]);   // "drywall" and "framing" lines guess Framing & Drywall
  assert.equal((await call('POST', `/api/quickbooks/costs/${b1.id}/import`, { mode: 'project' }, asst)).status, 400);   // needs a project
  assert.equal((await call('POST', `/api/quickbooks/costs/${b1.id}/import`, { mode: 'overhead', overheadCategory: 'Lunch' }, asst)).status, 400);
  const ok = await call('POST', `/api/quickbooks/costs/${b1.id}/import`, { mode: 'project', projectId: pid, lines: [{ index: 0, projectTradeId: ptDry }, { index: 1 }] }, asst); assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const inv = (await q(`SELECT * FROM supplier_invoices WHERE id=$1`, [ok.body.invoiceId]))[0]; assert.deepEqual([inv.source, inv.qb_bill_id, Number(inv.total), inv.reference], ['QuickBooks', 'Bill:B1', 1500, 'INV-5001']);
  const al = await q('SELECT project_trade_id, project_id, amount::float8 AS amount FROM supplier_allocations WHERE supplier_invoice_id=$1 ORDER BY seq', [inv.id]); assert.deepEqual(al.map((a) => [a.project_trade_id, a.amount]), [[ptDry, 1000], [null, 500]]);   // trade, and the whole project
  assert.equal((await q('SELECT count(*)::int n FROM supplier_payments WHERE supplier_invoice_id=$1', [inv.id]))[0].n, 0);   // a bill is not paid yet
  assert.equal((await call('POST', `/api/quickbooks/costs/${b1.id}/import`, { mode: 'project', projectId: pid }, asst)).status, 409);   // not twice
  assert.equal((await find('Gold Coast Drywall Supply')).status, 'Imported');
  const p1 = await find('Sunbelt Rentals', '1042'); const c = await call('POST', `/api/quickbooks/costs/${p1.id}/import`, { mode: 'project', projectId: pid, lines: [{ index: 0, projectTradeId: ptDemo }] }, asst); assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal((await q('SELECT COALESCE(sum(amount),0)::float8 s FROM supplier_payments WHERE supplier_invoice_id=$1', [c.body.invoiceId]))[0].s, 800);   // a check is paid when written
  const ins = await find('Acme Insurance Co'); const o = await call('POST', `/api/quickbooks/costs/${ins.id}/import`, { mode: 'overhead', overheadCategory: 'Insurance' }, asst); assert.equal(o.status, 200, JSON.stringify(o.body));
  assert.deepEqual((await q('SELECT overhead_category, project_id, amount::float8 a FROM supplier_allocations WHERE supplier_invoice_id=$1', [o.body.invoiceId])).map((r) => [r.overhead_category, r.project_id, r.a]), [['Insurance', null, 3200]]);
  const cost = (await call('GET', `/api/projects/${pid}`, null, owner)).body.totals; assert.ok(cost.supplierCost >= 2300);   // 1500 + 800 on the project
  assert.ok((await call('GET', '/api/quickbooks/costs/' + (await find('Shell Oil')).id + '/prepare', null, asst)).status === 200);
});

test('a bill paid later in QuickBooks gets its payment automatically; a changed total is flagged, not rewritten', async () => {
  billPays = [{ Id: 'BP1', TxnDate: '2026-11-20', TotalAmt: 1000, Line: [{ Amount: 1000, LinkedTxn: [{ TxnId: 'B1', TxnType: 'Bill' }] }] }]; bills[0].Balance = 500;
  const r = (await sync()).body; assert.equal(r.autoPaid, 1);
  const inv = (await q(`SELECT id FROM supplier_invoices WHERE qb_bill_id='Bill:B1'`))[0]; assert.deepEqual((await q('SELECT paid_date::text d, amount::float8 a FROM supplier_payments WHERE supplier_invoice_id=$1', [inv.id])).map((p) => [p.d, p.a]), [['2026-11-20', 1000]]);
  assert.equal((await sync()).body.autoPaid, 0);   // not added twice
  bills[0].TotalAmt = 1600; bills[0].MetaData = { LastUpdatedTime: '2026-11-21T10:00:00-05:00' }; await sync(); const c = await find('Gold Coast Drywall Supply'); assert.equal(c.status, 'Changed'); assert.match(c.message, /1500.00 to 1600.00/);
  assert.equal(Number((await q('SELECT total FROM supplier_invoices WHERE id=$1', [inv.id]))[0].total), 1500);   // Job Costing is untouched
});

test('subcontractors are not imported here, and one transaction with a credit line is refused with a reason', async () => {
  const r = await find('Rivera Framing LLC'); const x = await call('POST', `/api/quickbooks/costs/${r.id}/import`, { mode: 'project', projectId: pid }, asst); assert.equal(x.status, 400); assert.match(x.body.error, /is a subcontractor/);
  assert.equal((await call('POST', `/api/quickbooks/costs/${r.id}/ignore`, {}, asst)).status, 200); assert.equal((await find('Rivera Framing LLC')).status, 'Ignored'); assert.equal((await call('POST', `/api/quickbooks/costs/${r.id}/restore`, {}, asst)).status, 200);
  await q(`UPDATE qb_costs SET lines='[{"description":"credit","amount":-5,"account":"","item":""},{"description":"x","amount":405,"account":"","item":""}]' WHERE vendor_name='IRS'`);
  const irs = await find('IRS'); const c = await call('POST', `/api/quickbooks/costs/${irs.id}/import`, { mode: 'overhead', overheadCategory: 'Other' }, asst); assert.equal(c.status, 400); assert.match(c.body.error, /credit/);
});

test('hiding what is not a project cost: one item, or the vendor for good (learned), with a searchable list and a way back', async () => {
  const irs = await find('IRS'); const one = await call('POST', `/api/quickbooks/costs/${irs.id}/hide`, { learn: false }, asst); assert.equal(one.status, 200); assert.equal(one.body.remembered, false);
  assert.ok(!(await call('GET', '/api/quickbooks/costs?status=All', null, asst)).body.some((c) => c.vendor === 'IRS'));   // out of the way
  let h = (await call('GET', '/api/quickbooks/costs/hidden', null, asst)).body; assert.deepEqual([h.vendors.length, h.items.map((i) => i.vendor)], [0, ['IRS']]);
  assert.equal((await call('POST', `/api/quickbooks/costs/${irs.id}/unhide`, {}, asst)).status, 200); assert.equal((await find('IRS')).status, 'New');
  // learn: hiding the vendor hides every New one from it now, and the next ones as they arrive
  purchases.push({ Id: 'P7', PaymentType: 'Check', DocNumber: '1050', TxnDate: '2026-11-05', TotalAmt: 410, EntityRef: { value: 'V5', name: 'IRS' }, MetaData: { LastUpdatedTime: LU }, Line: [exp(410, 'Payroll tax deposit', 'Payroll Taxes')] }); await sync();
  const all2 = await call('POST', `/api/quickbooks/costs/${(await find('IRS', '1043')).id}/hide`, { learn: true }, asst); assert.equal(all2.body.hidden, 2); assert.equal(all2.body.remembered, true);
  purchases.push({ Id: 'P8', PaymentType: 'Check', DocNumber: '1051', TxnDate: '2026-11-06', TotalAmt: 420, EntityRef: { value: 'V5', name: 'IRS' }, MetaData: { LastUpdatedTime: LU }, Line: [exp(420, 'Payroll tax deposit', 'Payroll Taxes')] });
  const s = (await sync()).body; assert.equal(s.hidden, 1); assert.equal(s.added, 0);   // arrived already hidden
  h = (await call('GET', '/api/quickbooks/costs/hidden', null, asst)).body; assert.deepEqual([h.vendors.length, h.vendors[0].vendor, h.vendors[0].hidden, h.vendors[0].amount, h.items.length], [1, 'IRS', 3, 1230, 3]);
  assert.equal((await call('GET', '/api/quickbooks/costs/hidden?search=irs', null, asst)).body.items.length, 3); assert.equal((await call('GET', '/api/quickbooks/costs/hidden?search=zzz', null, asst)).body.items.length, 0);
  assert.equal((await call('GET', '/api/quickbooks/costs/hidden?search=payroll', null, asst)).body.items.length, 3);   // searches the memo and account too
  assert.equal((await call('POST', `/api/quickbooks/costs/${(await find('Gold Coast Drywall Supply')).id}/hide`, {}, asst)).status, 409);   // already imported
  const back = await call('DELETE', `/api/quickbooks/costs/rules/${h.vendors[0].id}`, null, asst); assert.equal(back.body.restored, 3); assert.equal((await find('IRS', '1051')).status, 'New');
});

test('learning from an import: the vendor, and where its costs usually go, are remembered for next time', async () => {
  const rule = (await q(`SELECT * FROM qb_vendor_rules WHERE vendor_key='id:V1'`))[0]; assert.ok(rule.supplier_id); assert.equal(rule.project_id, pid);
  bills.push({ Id: 'B3', DocNumber: 'INV-5002', TxnDate: '2026-11-07', TotalAmt: 250, Balance: 250, VendorRef: { value: 'V1', name: 'Gold Coast Drywall Supply' }, MetaData: { LastUpdatedTime: LU }, Line: [exp(250, 'Screws')] }); await sync();
  const next = await find('Gold Coast Drywall Supply', 'INV-5002'); assert.equal(next.suggestedProjectId, pid); assert.match(next.suggestedBy, /remembered/);
  const prep = (await call('GET', `/api/quickbooks/costs/${next.id}/prepare?projectId=${pid}`, null, asst)).body; assert.equal(prep.supplierGuess, rule.supplier_id);
  const ok = await call('POST', `/api/quickbooks/costs/${next.id}/import`, { mode: 'project', projectId: pid, supplierId: prep.supplierGuess }, asst); assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await q('SELECT count(*)::int n FROM suppliers WHERE lower(name)=lower($1)', ['Gold Coast Drywall Supply']))[0].n, 1);   // one vendor, not a copy each time
});
