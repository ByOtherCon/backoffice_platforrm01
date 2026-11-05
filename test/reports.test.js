import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
const { pool, q } = await import('../server/db.js');
const { server } = await import('../server/index.js');
const { hashPassword } = await import('../server/auth.js');
const { PRESETS } = await import('../server/reports.js');

let base, owner, sub, asst, est, pm, pidA, pidB, ptA1, ptA2;
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  const h = await hashPassword('correct horse battery');
  for (const [e, r] of [['owner@x.net', 'Super Admin'], ['sub@x.net', 'Sub Admin'], ['asst@x.net', 'Exec Assistant'], ['est@x.net', 'Estimator'], ['pm@x.net', 'Project Manager']]) await q('INSERT INTO app_users(email,name,role,password_hash) VALUES ($1,$1,$2,$3)', [e, r, h]);
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });
async function call(method, path, body, cookie) {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text(); let b = null; try { b = t ? JSON.parse(t) : null; } catch { b = t; } return { status: res.status, body: b, headers: res.headers };
}
const login = async (email) => { const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct horse battery' }) }); return r.headers.get('set-cookie').split(';')[0]; };
const run = (cfg, c = owner) => call('POST', '/api/reports/run', cfg, c);

test('setup: two projects on two GCs with costs, billing, labor, a receipt, and a lost bid', async () => {
  owner = await login('owner@x.net'); sub = await login('sub@x.net'); asst = await login('asst@x.net'); est = await login('est@x.net'); pm = await login('pm@x.net');
  const t1 = (await call('POST', '/api/admin/trades', { name: 'Demolition' }, owner)).body.id, t2 = (await call('POST', '/api/admin/trades', { name: 'Paint' }, owner)).body.id;
  const g1 = (await call('POST', '/api/admin/gcs', { name: 'CW Hayes' }, owner)).body.id, g2 = (await call('POST', '/api/admin/gcs', { name: 'Epic Construction' }, owner)).body.id;
  pidA = (await call('POST', '/api/projects', { name: 'Wingstop', gcId: g1, client: 'C', address: 'A', trades: [{ tradeId: t1, amount: 25000 }, { tradeId: t2, amount: 10000 }] }, owner)).body.id;
  pidB = (await call('POST', '/api/projects', { name: 'Pilates', gcId: g2, client: 'C', address: 'B', trades: [{ tradeId: t1, amount: 40000 }] }, owner)).body.id;
  await q('INSERT INTO project_members SELECT $1, id FROM app_users WHERE email=$2', [pidA, 'pm@x.net']);
  const pa = (await call('GET', `/api/projects/${pidA}`, null, owner)).body.trades; ptA1 = pa.find((t) => t.name === 'Demolition').id; ptA2 = pa.find((t) => t.name === 'Paint').id;
  const v = (await call('POST', '/api/admin/subcontractors', { name: 'Atlas, "The Best" Interiors' }, owner)).body.id; const c = (await call('POST', `/api/projects/${pidA}/commitments`, { projectTradeId: ptA1, subcontractorId: v, contractAmount: 10000 }, owner)).body.id;
  await call('POST', `/api/projects/${pidA}/commitments/${c}/bills`, { number: 'A1', date: '2026-10-10', amount: 6000 }, owner);
  const s = (await call('POST', '/api/admin/suppliers', { name: 'The Home Depot' }, owner)).body.id;
  assert.equal((await call('POST', '/api/receipts', { supplierId: s, reference: 'R1', date: '2026-10-12', tax: 0, lines: [{ description: '=HYPERLINK("http://evil.example","click")', amount: 100, projectId: pidA, projectTradeId: ptA2, itemKind: 'Materials' }, { description: 'Blades', amount: 50, overheadCategory: 'Tools', itemKind: 'Tools' }] }, owner)).status, 200);
  for (const [pid, pt, n, amt, held] of [[pidA, ptA1, 'I1', 20000, 2000], [pidB, null, 'I2', 30000, 3000]]) { const tr = pt ?? (await call('GET', `/api/projects/${pidB}`, null, owner)).body.trades[0].id; assert.equal((await call('POST', `/api/projects/${pid}/invoices`, { projectTradeId: tr, number: n, date: '2026-10-05', dueDate: '2026-11-04', amount: amt, retainageHeld: held }, owner)).status, 200); }
  const e = (await call('POST', '/api/admin/employees', { name: 'Alex', hourly_rate: 20 }, owner)).body; await q(`INSERT INTO labor_entries(project_id,project_trade_id,employee_id,work_date,hours,rate,pay,source) VALUES ($1,$2,$3,'2026-10-08',8,20,160,'Time clock')`, [pidA, ptA1, e.id]);
  const o = (await q(`INSERT INTO opportunities(name,client_name,gc_name,city,due_date,source_key,source_type,project_type) VALUES ('Lost Job','Epic Construction','Epic Construction','Tampa','2026-11-20','lostjob','PlanHub','Retail') RETURNING id`))[0].id; await call('POST', `/api/opportunities/${o}/status`, { status: 'Accepted' }, est);
  const t = (await call('GET', '/api/admin/trades', null, owner)).body.find((x) => x.name === 'Paint').id;
  const up = await fetch(base + `/api/opportunities/${o}/files?kind=Proposal`, { method: 'POST', headers: { cookie: est, 'x-file-name': 'p.pdf' }, body: Buffer.from('%PDF-1.4\n%%EOF') }); const fileId = (await up.json()).fileId;
  await call('POST', `/api/opportunities/${o}/submissions`, { fileId, date: new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date()), method: 'Email', prices: [{ tradeId: t, amount: 9000 }] }, est); await call('POST', `/api/opportunities/${o}/status`, { status: 'Not Awarded', reason: 'Price too high' }, est);
});

test('each role is offered only its own sources', async () => {
  const ids = async (c) => (await call('GET', '/api/reports/sources', null, c)).body.sources.map((s) => s.id).sort();
  assert.deepEqual(await ids(est), ['follow_ups', 'opportunities', 'todos', 'trade_prices']);
  assert.deepEqual(await ids(pm), ['change_orders', 'labor', 'project_trades', 'projects', 'time_entries', 'time_lines', 'todos']);
  const mgr = await ids(asst); assert.ok(mgr.includes('client_invoices') && mgr.includes('vendors') && !mgr.includes('employees') && !mgr.includes('overhead') && !mgr.includes('ai_usage'));
  const sa = await ids(owner); for (const x of ['employees', 'overhead', 'ai_usage', 'ntos', 'documents', 'supplier_lines', 'vendor_bills', 'payment_requests']) assert.ok(sa.includes(x), x);
  assert.equal((await run({ source: 'client_invoices' }, est)).status, 403); assert.equal((await run({ source: 'employees' }, asst)).status, 403); assert.equal((await run({ source: 'nope' })).status, 400);
  assert.equal((await call('POST', '/api/reports/run', { source: 'projects' })).status, 401);
});

test('every source and every preset runs cleanly (smoke test of all the SQL)', async () => {
  for (const s of (await call('GET', '/api/reports/sources', null, owner)).body.sources) { const r = await run({ source: s.id }); assert.equal(r.status, 200, `${s.id}: ${JSON.stringify(r.body)}`); assert.deepEqual(r.body.columns.map((c) => c.key), s.columns.map((c) => c.key)); }
  for (const p of PRESETS) { const r = await run(p); assert.equal(r.status, 200, `${p.name}: ${JSON.stringify(r.body)}`); }
  assert.equal((await call('GET', '/api/reports/sources', null, est)).body.presets.every((p) => ['opportunities', 'trade_prices', 'follow_ups'].includes(p.source)), true);
});

test('the numbers agree: projects, trades, GCs and the project screen all give the same profit', async () => {
  const proj = (await run({ source: 'projects', sort: { col: 'project', dir: 'asc' } })).body; const w = proj.rows.find((r) => r.project === 'Wingstop');
  assert.deepEqual([w.contract, w.billed, w.vendors, w.suppliers, w.labor, w.actualCost], [35000, 20000, 6000, 100, 160, 6260]);   // the $50 of tools went to overhead, not the project
  assert.equal(w.projectedProfit, 35000 - 6260 - 4000);                                                                            // plus the $4,000 still to bill on the vendor contract
  const screen = (await call('GET', `/api/projects/${pidA}`, null, owner)).body.totals; assert.equal(w.projectedProfit, screen.projectedProfit); assert.equal(w.margin, screen.marginPct);
  const byTrade = (await run({ source: 'project_trades', groupBy: 'trade', measures: ['projectedProfit', 'contract'], sort: { col: 'trade', dir: 'asc' } })).body;
  assert.deepEqual(byTrade.rows.map((r) => [r.trade, r.count, r.sum_contract]), [['Demolition', 2, 65000], ['Paint', 1, 10000]]);
  assert.equal(byTrade.totals.sum_projectedProfit, proj.totals.projectedProfit);
  const byGc = (await run({ source: 'projects', groupBy: 'gc', measures: [{ col: 'billed', fn: 'sum' }, { col: 'margin', fn: 'avg' }], sort: { col: 'gc', dir: 'asc' } })).body; assert.deepEqual(byGc.rows.map((r) => [r.gc, r.sum_billed]), [['CW Hayes', 20000], ['Epic Construction', 30000]]);
});

test('filters, date ranges, sorting and aging', async () => {
  assert.equal((await run({ source: 'projects', filters: [{ col: 'gc', op: 'eq', value: 'cw hayes' }] })).body.rows.length, 1);
  assert.equal((await run({ source: 'projects', filters: [{ col: 'contract', op: 'gt', value: '36000' }] })).body.rows[0].project, 'Pilates');
  assert.equal((await run({ source: 'projects', filters: [{ col: 'project', op: 'contains', value: 'PIL' }, { col: 'billed', op: 'gte', value: 1 }] })).body.rows.length, 1);
  assert.equal((await run({ source: 'projects', filters: [{ col: 'contract', op: 'gt', value: 'lots' }] })).status, 400); assert.equal((await run({ source: 'projects', filters: [{ col: 'secret', op: 'eq', value: 'x' }] })).status, 400); assert.equal((await run({ source: 'projects', filters: [{ col: 'gc', op: 'drop', value: 'x' }] })).status, 400);
  assert.equal((await run({ source: 'client_invoices', dateRange: { col: 'date', from: '2026-10-06' } })).body.rows.length, 0); assert.equal((await run({ source: 'client_invoices', dateRange: { col: 'date', from: '2026-10-01', to: '2026-10-31' } })).body.rows.length, 2);
  assert.equal((await run({ source: 'client_invoices', dateRange: { col: 'amount' } })).status, 400);
  assert.deepEqual((await run({ source: 'projects', columns: ['project', 'contract'], sort: { col: 'contract', dir: 'desc' } })).body.rows.map((r) => r.project), ['Pilates', 'Wingstop']);
  assert.equal((await run({ source: 'projects', columns: ['project'], sort: { col: 'contract' } })).status, 400);
  assert.equal((await run({ source: 'projects', groupBy: 'gc', measures: ['client'] })).status, 400);                       // cannot total text
  const ag = (await run({ source: 'client_invoices', groupBy: 'aging', measures: ['collectable'] })).body.rows; assert.equal(ag.reduce((n, r) => n + r.sum_collectable, 0), 45000);   // 18,000 + 27,000 after retainage
  assert.equal((await run({ source: 'supplier_lines', filters: [{ col: 'overhead', op: 'notempty' }] })).body.rows[0].amount, 50);
});

test('a PM sees only assigned projects; estimators see estimating, including lost bids', async () => {
  assert.deepEqual((await run({ source: 'projects' }, pm)).body.rows.map((r) => r.project), ['Wingstop']); assert.deepEqual((await run({ source: 'labor' }, pm)).body.rows.map((r) => r.project), ['Wingstop']); assert.equal((await run({ source: 'project_trades' }, pm)).body.rows.every((r) => r.project === 'Wingstop'), true);
  const o = (await run({ source: 'opportunities', filters: [{ col: 'result', op: 'eq', value: 'Lost' }] }, est)).body.rows; assert.deepEqual([o.length, o[0].lostReason, o[0].total], [1, 'Price too high', 9000]);
});

test('CSV export: opens cleanly in Excel, quotes commas and quotes, and defuses spreadsheet formulas', async () => {
  const r = await fetch(`${base}/api/reports/export`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: owner }, body: JSON.stringify({ source: 'supplier_lines', columns: ['supplier', 'description', 'amount'] }) });
  assert.equal(r.status, 200); assert.match(r.headers.get('content-disposition'), /attachment; filename="vendor-invoices-and-receipts-every-line-\d{4}-\d{2}-\d{2}\.csv"/);
  const raw = Buffer.from(await r.arrayBuffer()); assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf]);   // byte-order mark so Excel reads it as UTF-8
  const csv = raw.toString('utf8').slice(1); assert.ok(csv.startsWith('Vendor,Item,Amount\r\n'));
  assert.ok(csv.includes(`"'=HYPERLINK(""http://evil.example"",""click"")"`)); assert.ok(csv.trim().endsWith('Totals,,150'));
  const v = await (await fetch(`${base}/api/reports/export`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: owner }, body: JSON.stringify({ source: 'vendor_bills', columns: ['vendor', 'amount'] }) })).text(); assert.ok(v.includes('"Atlas, ""The Best"" Interiors",6000'));
  assert.equal((await fetch(`${base}/api/reports/export`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: est }, body: JSON.stringify({ source: 'projects' }) })).status, 403);
});

test('saved report views are kept per user and validated', async () => {
  const views = { views: [{ name: 'Profit by GC', config: { source: 'projects', groupBy: 'gc', measures: ['billed'] } }] };
  assert.equal((await call('PUT', '/api/prefs/reports', views, asst)).status, 200); assert.deepEqual((await call('GET', '/api/prefs/reports', null, asst)).body, views); assert.deepEqual((await call('GET', '/api/prefs/reports', null, sub)).body, {});
  assert.equal((await call('PUT', '/api/prefs/reports', { views: [{ name: '', config: { source: 'projects' } }] }, asst)).status, 400); assert.equal((await call('PUT', '/api/prefs/reports', { views: 'x' }, asst)).status, 400);
});
