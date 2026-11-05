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
const qbi = await import('../server/qbImport.js');

let base, owner, asst, pm, pid, tDemo, tDry, ptDemo, ptDry, queries = [];
const LU = '2026-11-04T10:00:00-05:00';
let invoices, payments;
const fixtures = () => {
  invoices = [
    { Id: '101', DocNumber: 'C11031-1', TxnDate: '2026-11-01', DueDate: '2026-12-01', TotalAmt: 36000, Balance: 16000, CustomerRef: { value: '55', name: 'Sachse Construction:Mall at Millenia' }, MetaData: { LastUpdatedTime: LU },
      Line: [{ DetailType: 'SalesItemLineDetail', Amount: 10000, Description: 'Selective demolition - progress', SalesItemLineDetail: { ItemRef: { name: 'Demolition' } } }, { DetailType: 'SalesItemLineDetail', Amount: 30000, Description: 'Metal stud framing and drywall - progress', SalesItemLineDetail: { ItemRef: { name: 'Services' } } }, { DetailType: 'SalesItemLineDetail', Amount: -4000, Description: 'Retainage held 10%', SalesItemLineDetail: { ItemRef: { name: 'Retainage' } } }, { DetailType: 'SubTotalLineDetail', Amount: 36000 }] },
    { Id: '102', DocNumber: '2001', TxnDate: '2026-11-02', TotalAmt: 500, CustomerRef: { value: '77', name: 'Some Other Job' }, MetaData: { LastUpdatedTime: LU }, Line: [{ DetailType: 'SalesItemLineDetail', Amount: 500, Description: 'Misc', SalesItemLineDetail: { ItemRef: { name: 'Services' } } }] }];
  payments = [{ Id: '900', TxnDate: '2026-11-10', TotalAmt: 20000, MetaData: { LastUpdatedTime: LU }, Line: [{ Amount: 20000, LinkedTxn: [{ TxnId: '101', TxnType: 'Invoice' }] }] }];
};
const intuit = async (url, init = {}) => {
  const u = new URL(url), res = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  if (u.hostname === 'oauth.platform.intuit.com') return res({ access_token: 'a', refresh_token: 'r', expires_in: 3600 });
  const sql = u.searchParams.get('query') || ''; if (sql) queries.push(sql);
  if (/from Invoice/.test(sql)) return res({ QueryResponse: { Invoice: invoices } });
  if (/from Payment/.test(sql)) return res({ QueryResponse: { Payment: payments } });
  return res({}, 404);
};
const call = async (method, path, body, cookie) => { const r = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); let b = null; try { b = t ? JSON.parse(t) : null; } catch { b = t; } return { status: r.status, body: b }; };
const login = async (email) => (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct horse battery' }) })).headers.get('set-cookie').split(';')[0];
const staged = async (n) => (await call('GET', '/api/quickbooks/invoices?status=All', null, owner)).body.find((i) => i.number === n);
const billing = async () => (await call('GET', `/api/projects/${pid}/billing`, null, owner)).body;

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  const h = await hashPassword('correct horse battery');
  for (const [e, r] of [['owner@x.net', 'Super Admin'], ['asst@x.net', 'Exec Assistant'], ['pm@x.net', 'Project Manager']]) await q('INSERT INTO app_users(email,name,role,password_hash) VALUES ($1,$2,$3,$4)', [e, e, r, h]);
  [tDemo, tDry] = (await Promise.all([['Demolition', 1], ['Framing & Drywall', 2]].map(([n, s]) => q('INSERT INTO trades(name,sort) VALUES ($1,$2) RETURNING id', [n, s])))).map((r) => r[0].id);
  const [g] = await q(`INSERT INTO gcs(name) VALUES ('Sachse Construction') RETURNING id`);
  [{ id: pid }] = await q(`INSERT INTO projects(name,gc_id,client,address,proposal_id,ref_code,retainage_pct) VALUES ('Mall at Millenia',$1,'Sachse','1 Mall Dr',$2,$3,10) RETURNING id`, [g.id, 'P11031', 'C11031']);
  [{ id: ptDemo }, { id: ptDry }] = await q('INSERT INTO project_trades(project_id,trade_id,original_amount) VALUES ($1,$2,20000),($1,$3,60000) RETURNING id', [pid, tDemo, tDry]);
  await q(`INSERT INTO contract_runs(project_id,status,total) VALUES ($1,'Applied',80000)`, [pid]);
  await q(`INSERT INTO invoice_schedule(project_id,run_id,label,amount) SELECT $1, id, 'First billing', 36000 FROM contract_runs WHERE project_id=$1`, [pid]);
  // connect (a stored connection is all the sync needs)
  await q(`INSERT INTO integrations(name,data) VALUES ('quickbooks',$1)`, [{ realmId: '9130', refresh: bd.seal('r'), environment: 'sandbox', company: 'Sandbox', connectedAt: new Date().toISOString() }]);
  qbo.setIntuitFetch(intuit); fixtures();
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
  owner = await login('owner@x.net'); asst = await login('asst@x.net'); pm = await login('pm@x.net');
});
after(async () => { server.close(); await pool.end(); });

test('who may sync and review: the office, not a project manager', async () => {
  assert.equal((await call('POST', '/api/quickbooks/sync', {}, pm)).status, 403); assert.equal((await call('GET', '/api/quickbooks/invoices', null, pm)).status, 403); assert.equal((await call('GET', '/api/quickbooks/invoices', null, asst)).status, 200);
});
test('sync stages invoices (nothing touches billing), suggests the project from the contract code or name, and is safe to repeat', async () => {
  assert.equal((await call('PUT', '/api/quickbooks/settings', { startDate: '2026-01-01', autoImport: false }, asst)).status, 200);
  const r = (await call('POST', '/api/quickbooks/sync', {}, asst)).body; assert.deepEqual([r.added, r.invoicesSeen, r.payments], [2, 2, 1]);
  const a = await staged('C11031-1'), b = await staged('2001'); assert.deepEqual([a.status, a.suggestedProjectId, a.suggestedBy, a.total], ['New', pid, 'contract code C11031', 36000]); assert.equal(b.suggestedProjectId, null);
  assert.deepEqual(a.lines.map((l) => [l.amount, l.retainage]), [[10000, false], [30000, false], [-4000, true]]); assert.deepEqual(a.payments.map((p) => [p.amount, p.imported]), [[20000, false]]);
  assert.equal((await billing()).length, 0);
  queries = []; assert.equal((await call('POST', '/api/quickbooks/sync', {}, asst)).body.added, 0); assert.ok(queries.every((s) => /where TxnDate >= '2026-01-01' and MetaData\.LastUpdatedTime >= '/.test(s)));   // the second run asks only for what changed
  assert.equal((await q('SELECT count(*)::int n FROM qb_invoices'))[0].n, 2);
});
test('review: lines are matched to the project trades; importing builds one billing row per trade with retainage and payments spread in proportion', async () => {
  const a = await staged('C11031-1'); const prep = (await call('GET', `/api/quickbooks/invoices/${a.id}/prepare?projectId=${pid}`, null, asst)).body;
  assert.deepEqual(prep.guess, [ptDemo, ptDry, null]); assert.equal(prep.project.retainagePct, 10);
  assert.deepEqual(prep.project.trades.map((t) => [t.name, t.contract, t.room]), [['Demolition', 20000, 20000], ['Framing & Drywall', 60000, 60000]]);   // the screen shows how much room each trade has
  assert.equal((await call('POST', `/api/quickbooks/invoices/${a.id}/import`, { projectId: pid, lines: [{ index: 0, projectTradeId: ptDemo }] }, asst)).status, 400);   // a line still has no trade
  const ok = await call('POST', `/api/quickbooks/invoices/${a.id}/import`, { projectId: pid, lines: [{ index: 0, projectTradeId: ptDemo }, { index: 1, projectTradeId: ptDry }] }, asst); assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.deepEqual([ok.body.invoices, ok.body.scheduled], [2, true]);
  const rows = (await billing()).sort((x, y) => x.amount - y.amount); assert.deepEqual(rows.map((r) => [r.number, r.amount, r.retainageHeld, r.collected]), [['C11031-1', 10000, 1000, 5000], ['C11031-1', 30000, 3000, 15000]]);   // the -4000 retainage line split 1000 / 3000; the 20000 payment 5000 / 15000
  assert.equal((await staged('C11031-1')).status, 'Imported'); assert.equal((await q(`SELECT status FROM invoice_schedule WHERE label='First billing'`))[0].status, 'Invoiced');
  assert.equal((await call('POST', `/api/quickbooks/invoices/${a.id}/import`, { projectId: pid }, asst)).status, 409);   // never twice
});
test('the customer is remembered; billing rules still apply: an invoice that passes the contract is refused whole', async () => {
  invoices.push({ Id: '103', DocNumber: 'C11031-2', TxnDate: '2026-11-20', TotalAmt: 90000, CustomerRef: { value: '55', name: 'Sachse Construction:Mall at Millenia' }, MetaData: { LastUpdatedTime: LU }, Line: [{ DetailType: 'SalesItemLineDetail', Amount: 90000, Description: 'Drywall', SalesItemLineDetail: { ItemRef: { name: 'Services' } } }] });
  await call('POST', '/api/quickbooks/sync', {}, asst); const c = await staged('C11031-2'); assert.equal(c.suggestedProjectId, pid);
  const r = await call('POST', `/api/quickbooks/invoices/${c.id}/import`, { projectId: pid, lines: [{ index: 0, projectTradeId: ptDry }], retainageHeld: 0 }, asst); assert.equal(r.status, 400); assert.match(r.body.error, /Not imported\. Framing & Drywall: this invoice bills \$90,000\.00, but the trade's contract is \$60,000\.00 and \$30,000\.00 is already billed \(room left: \$30,000\.00\)/);
  assert.equal((await staged('C11031-2')).status, 'New'); assert.equal((await billing()).length, 2);   // nothing half-saved
});
test('later payments on an imported invoice arrive by themselves; a changed total is flagged, never rewritten', async () => {
  payments.push({ Id: '901', TxnDate: '2026-11-25', TotalAmt: 5000, MetaData: { LastUpdatedTime: LU }, Line: [{ Amount: 4000, LinkedTxn: [{ TxnId: '101', TxnType: 'Invoice' }] }] });
  const r = (await call('POST', '/api/quickbooks/sync', {}, asst)).body; assert.equal(r.autoPaid, 1);
  assert.equal((await billing()).reduce((n, i) => n + i.collected, 0), 24000);
  invoices[0].TotalAmt = 36500; const s = (await call('POST', '/api/quickbooks/sync', {}, asst)).body; assert.equal(s.changed, 1);
  const a = await staged('C11031-1'); assert.equal(a.status, 'Changed'); assert.match(a.message, /36500\.00/); assert.equal((await billing()).reduce((n, i) => n + i.amount, 0), 40000);
});
test('unmatched invoices: choose a project, ignore, or restore', async () => {
  const b = await staged('2001'); assert.equal((await call('POST', `/api/quickbooks/invoices/${b.id}/import`, {}, asst)).status, 400);   // no project chosen
  assert.equal((await call('POST', `/api/quickbooks/invoices/${b.id}/ignore`, {}, asst)).status, 200); assert.equal((await staged('2001')).status, 'Ignored');
  assert.equal((await call('POST', `/api/quickbooks/invoices/${b.id}/restore`, {}, asst)).status, 200); assert.equal((await staged('2001')).status, 'New');
  assert.equal((await call('PUT', `/api/quickbooks/invoices/${b.id}/project`, { projectId: pid }, asst)).status, 200); assert.equal((await staged('2001')).projectId, pid);
  const c = (await call('GET', '/api/quickbooks/status', null, owner)).body; assert.ok(c.lastSync.at); assert.deepEqual(c.counts, { Changed: 1, New: 2 });
});

test('start date: older invoices stay out of the list and the count, it is part of every QuickBooks query, and changing it reads again from that date', async () => {
  const dflt = (await call('GET', '/api/quickbooks/settings', null, asst)).body; assert.deepEqual([dflt.startDate, dflt.autoImport], ['2026-01-01', false]);
  assert.equal((await call('PUT', '/api/quickbooks/settings', { startDate: 'soon' }, asst)).status, 400); assert.equal((await call('PUT', '/api/quickbooks/settings', { startDate: '2026-01-01' }, pm)).status, 403);
  invoices.push({ Id: '120', DocNumber: 'OLD-1', TxnDate: '2025-06-01', TotalAmt: 100, CustomerRef: { value: '88', name: 'Old Customer' }, MetaData: { LastUpdatedTime: LU }, Line: [{ DetailType: 'SalesItemLineDetail', Amount: 100, Description: 'Old', SalesItemLineDetail: { ItemRef: { name: 'Services' } } }] });
  queries = []; await call('POST', '/api/quickbooks/sync', {}, asst); assert.ok(queries.every((x) => /where TxnDate >= '2026-01-01'/.test(x)));
  assert.ok(!(await call('GET', '/api/quickbooks/invoices?status=New', null, asst)).body.some((i) => i.number === 'OLD-1')); assert.equal((await call('GET', '/api/quickbooks/status', null, owner)).body.counts.New, 2);
  assert.equal((await call('PUT', '/api/quickbooks/settings', { startDate: '2025-01-01' }, asst)).status, 200);
  assert.ok((await call('GET', '/api/quickbooks/invoices?status=New', null, asst)).body.some((i) => i.number === 'OLD-1'));
  queries = []; await call('POST', '/api/quickbooks/sync', {}, asst); assert.ok(queries.every((x) => /where TxnDate >= '2025-01-01'$/.test(x.split(' orderby ')[0])));   // reads everything again from the new date, not just what changed
  assert.deepEqual((await call('GET', '/api/quickbooks/invoices?status=New&search=old', null, asst)).body.map((i) => i.number), ['OLD-1']);   // search by number, customer or memo
  await call('PUT', '/api/quickbooks/settings', { startDate: '2026-01-01' }, asst);
});
test('Ignore all not matched: only New invoices with no project, in one step', async () => {
  invoices.push({ Id: '121', DocNumber: 'ZZ-1', TxnDate: '2026-11-03', TotalAmt: 10, CustomerRef: { value: '89', name: 'Nobody At All' }, MetaData: { LastUpdatedTime: LU }, Line: [{ DetailType: 'SalesItemLineDetail', Amount: 10, Description: 'x', SalesItemLineDetail: { ItemRef: { name: 'Services' } } }] });
  await call('POST', '/api/quickbooks/sync', {}, asst);
  const r = (await call('POST', '/api/quickbooks/invoices/ignore-unmatched', {}, asst)).body; assert.equal(r.ignored, 1);   // ZZ-1 has no match; 2001 was matched by hand and C11031-2 has a suggestion
  assert.equal((await staged('ZZ-1')).status, 'Ignored'); assert.equal((await staged('2001')).status, 'New'); assert.equal((await staged('C11031-2')).status, 'New');
  assert.equal((await call('POST', '/api/quickbooks/invoices/ignore-unmatched', {}, pm)).status, 403);
});
test('automatic log: a confident match imports itself (lines without a trade spread over the whole project); one that cannot is left for a person with the reason', async () => {
  await call('PUT', '/api/quickbooks/settings', { autoImport: true }, asst);
  invoices.push({ Id: '110', DocNumber: 'C11031-9', TxnDate: '2026-11-22', TotalAmt: 2000, CustomerRef: { value: '91', name: 'Whatever' }, MetaData: { LastUpdatedTime: LU }, Line: [{ DetailType: 'SalesItemLineDetail', Amount: 1000, Description: 'Selective demolition', SalesItemLineDetail: { ItemRef: { name: 'Demolition' } } }, { DetailType: 'SalesItemLineDetail', Amount: 1000, Description: 'General conditions', SalesItemLineDetail: { ItemRef: { name: 'Services' } } }] },
    { Id: '111', DocNumber: 'C11031-10', TxnDate: '2026-11-23', TotalAmt: 90000, CustomerRef: { value: '92', name: 'Whatever 2' }, MetaData: { LastUpdatedTime: LU }, Line: [{ DetailType: 'SalesItemLineDetail', Amount: 90000, Description: 'Selective demolition', SalesItemLineDetail: { ItemRef: { name: 'Demolition' } } }] });
  const before = (await billing()).length; const r = (await call('POST', '/api/quickbooks/sync', {}, asst)).body; assert.deepEqual([r.auto, r.needLook], [1, 2]);   // C11031-9 imports; C11031-10 and the earlier too-big C11031-2 are tried and left for a person
  const a = await staged('C11031-9'); assert.equal(a.status, 'Imported'); assert.match(a.message, /Imported automatically \(matched by contract code C11031\)/);
  const rows = (await billing()).filter((x) => x.number === 'C11031-9').sort((x, y) => x.amount - y.amount); assert.deepEqual(rows.map((x) => [x.trade, x.amount]), [['Framing & Drywall', 750], ['Demolition', 1250]]);   // 1000 to Demolition + 1000 spread 250 / 750 by contract amount
  assert.equal((await billing()).length, before + 2);
  const b = await staged('C11031-10'); assert.equal(b.status, 'New'); assert.match(b.message, /^Not imported automatically: Not imported\. Demolition: this invoice bills \$90,000\.00/);
  await call('PUT', '/api/quickbooks/settings', { autoImport: false }, asst);
});
test('an invoice against the whole project, or split by hand across trades (for example 5.00 as 2.50 and 2.50)', async () => {
  invoices.push({ Id: '112', DocNumber: '3001', TxnDate: '2026-11-24', TotalAmt: 5, CustomerRef: { value: '93', name: 'Some Job' }, MetaData: { LastUpdatedTime: LU }, Line: [{ DetailType: 'SalesItemLineDetail', Amount: 5, Description: 'Mobilization', SalesItemLineDetail: { ItemRef: { name: 'Services' } } }] });
  await call('POST', '/api/quickbooks/sync', {}, asst); const c = await staged('3001');
  const bad = await call('POST', `/api/quickbooks/invoices/${c.id}/import`, { projectId: pid, lines: [{ index: 0, split: [{ projectTradeId: ptDemo, amount: 2 }, { projectTradeId: ptDry, amount: 2 }] }] }, asst); assert.equal(bad.status, 400); assert.match(bad.body.error, /must add up to the line/);
  const ok = await call('POST', `/api/quickbooks/invoices/${c.id}/import`, { projectId: pid, lines: [{ index: 0, split: [{ projectTradeId: ptDemo, amount: 2.5 }, { projectTradeId: ptDry, amount: 2.5 }] }], retainageHeld: 0 }, asst); assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual((await billing()).filter((x) => x.number === '3001').map((x) => x.amount).sort(), [2.5, 2.5]);
  const d = await staged('2001'); const sp = await call('POST', `/api/quickbooks/invoices/${d.id}/import`, { projectId: pid, lines: [{ index: 0, spread: true }], retainageHeld: 0 }, asst); assert.equal(sp.status, 200, JSON.stringify(sp.body));   // 500 over the whole project
  assert.deepEqual((await billing()).filter((x) => x.number === '2001').map((x) => x.amount).sort((x, y) => x - y), [125, 375]);
});
test("a project's own page can list the invoices that look like it", async () => {
  invoices.push({ Id: '130', DocNumber: 'C11031-20', TxnDate: '2026-11-25', TotalAmt: 70, CustomerRef: { value: '95', name: 'Whatever 3' }, MetaData: { LastUpdatedTime: LU }, Line: [{ DetailType: 'SalesItemLineDetail', Amount: 70, Description: 'Demolition', SalesItemLineDetail: { ItemRef: { name: 'Demolition' } } }] });
  await call('POST', '/api/quickbooks/sync', {}, asst);
  const sug = (await call('GET', `/api/projects/${pid}/qb-suggestions`, null, asst)).body; assert.ok(sug.some((x) => x.number === 'C11031-20' && /contract code/.test(x.why))); assert.ok(!sug.some((x) => x.number === 'C11031-9'));   // already imported ones are not suggestions
  assert.equal((await call('GET', `/api/projects/${pid}/qb-suggestions`, null, pm)).status, 403);
});
