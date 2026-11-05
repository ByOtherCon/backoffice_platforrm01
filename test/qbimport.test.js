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
  const r = (await call('POST', '/api/quickbooks/sync', {}, asst)).body; assert.deepEqual([r.added, r.invoicesSeen, r.payments], [2, 2, 1]);
  const a = await staged('C11031-1'), b = await staged('2001'); assert.deepEqual([a.status, a.suggestedProjectId, a.suggestedBy, a.total], ['New', pid, 'contract code C11031', 36000]); assert.equal(b.suggestedProjectId, null);
  assert.deepEqual(a.lines.map((l) => [l.amount, l.retainage]), [[10000, false], [30000, false], [-4000, true]]); assert.deepEqual(a.payments.map((p) => [p.amount, p.imported]), [[20000, false]]);
  assert.equal((await billing()).length, 0);
  queries = []; assert.equal((await call('POST', '/api/quickbooks/sync', {}, asst)).body.added, 0); assert.ok(queries.every((s) => /where MetaData\.LastUpdatedTime >= '/.test(s)));   // the second run asks only for what changed
  assert.equal((await q('SELECT count(*)::int n FROM qb_invoices'))[0].n, 2);
});
test('review: lines are matched to the project trades; importing builds one billing row per trade with retainage and payments spread in proportion', async () => {
  const a = await staged('C11031-1'); const prep = (await call('GET', `/api/quickbooks/invoices/${a.id}/prepare?projectId=${pid}`, null, asst)).body;
  assert.deepEqual(prep.guess, [ptDemo, ptDry, null]); assert.equal(prep.project.retainagePct, 10);
  assert.equal((await call('POST', `/api/quickbooks/invoices/${a.id}/import`, { projectId: pid, lines: [{ index: 0, projectTradeId: ptDemo }] }, asst)).status, 400);   // a line still has no trade
  const ok = await call('POST', `/api/quickbooks/invoices/${a.id}/import`, { projectId: pid, lines: [{ index: 0, projectTradeId: ptDemo }, { index: 1, projectTradeId: ptDry }] }, asst); assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.deepEqual([ok.body.invoices, ok.body.scheduled], [2, true]);
  const rows = (await billing()).sort((x, y) => x.amount - y.amount); assert.deepEqual(rows.map((r) => [r.number, r.amount, r.retainageHeld, r.collected]), [['C11031-1', 10000, 1000, 5000], ['C11031-1', 30000, 3000, 15000]]);   // the -4000 retainage line split 1000 / 3000; the 20000 payment 5000 / 15000
  assert.equal((await staged('C11031-1')).status, 'Imported'); assert.equal((await q(`SELECT status FROM invoice_schedule WHERE label='First billing'`))[0].status, 'Invoiced');
  assert.equal((await call('POST', `/api/quickbooks/invoices/${a.id}/import`, { projectId: pid }, asst)).status, 409);   // never twice
});
test('the customer is remembered; billing rules still apply: an invoice that passes the contract is refused whole', async () => {
  invoices.push({ Id: '103', DocNumber: 'C11031-2', TxnDate: '2026-11-20', TotalAmt: 90000, CustomerRef: { value: '55', name: 'Sachse Construction:Mall at Millenia' }, MetaData: { LastUpdatedTime: LU }, Line: [{ DetailType: 'SalesItemLineDetail', Amount: 90000, Description: 'Drywall', SalesItemLineDetail: { ItemRef: { name: 'Services' } } }] });
  await call('POST', '/api/quickbooks/sync', {}, asst); const c = await staged('C11031-2'); assert.equal(c.suggestedProjectId, pid);
  const r = await call('POST', `/api/quickbooks/invoices/${c.id}/import`, { projectId: pid, lines: [{ index: 0, projectTradeId: ptDry }], retainageHeld: 0 }, asst); assert.equal(r.status, 400); assert.match(r.body.error, /cannot exceed/i);
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
