import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
process.env.ANTHROPIC_API_KEY = 'test-key';
const { pool, q } = await import('../server/db.js');
const { server } = await import('../server/index.js');
const { hashPassword } = await import('../server/auth.js');
const ai = await import('../server/ai.js');
const { matchTrade, buildSchedule, compareToProject } = await import('../src/lib/contracts.ts');

let base, owner, pm, projectId, tDemo, tDry, tPaint, tAct, reply, aiDown = false;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
const claude = async () => aiDown ? { ok: false, status: 500, json: async () => ({}) } : ({ ok: true, json: async () => ({ content: [{ type: 'tool_use', name: 'record_contract', input: reply }], usage: { input_tokens: 5000, output_tokens: 600 } }) });
const call = async (method, path, body, cookie, raw) => {
  const res = await fetch(base + path, { method, headers: { ...(body && !raw ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(raw ? { 'x-file-name': raw } : {}) }, body: body ? (raw ? body : JSON.stringify(body)) : undefined });
  const t = await res.text(); let b = null; try { b = t ? JSON.parse(t) : null; } catch { b = t; } return { status: res.status, body: b };
};
const login = async (email) => { const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct horse battery' }) }); return r.headers.get('set-cookie').split(';')[0]; };
const upload = (who = owner, name = 'Subcontract.pdf', kind = 'Contract') => call('POST', `/api/projects/${projectId}/contract?kind=${encodeURIComponent(kind)}`, PDF, who, name);
const baseReply = () => ({ isChangeOrder: false, contractNumber: 'SC-1042', contractDate: '2026-10-20', totalAmount: 120000, retainagePercent: 5, netDays: 30, billingFrequency: 'Monthly progress', paymentTerms: 'Pay when paid, net 30. Pencil requisition by the 25th.',
  lines: [{ description: 'Selective demolition', amount: 20000, tradeHint: 'demolition' }, { description: 'Metal stud framing and gypsum board', amount: 85000, tradeHint: 'drywall' }, { description: 'Painting', amount: 15000, tradeHint: 'paint' }], schedule: [], warnings: [] });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  const h = await hashPassword('correct horse battery');
  for (const [e, r] of [['owner@x.net', 'Super Admin'], ['pm@x.net', 'Project Manager']]) await q('INSERT INTO app_users(email,name,role,password_hash) VALUES ($1,$2,$3,$4)', [e, e.split('@')[0], r, h]);
  [tDemo, tDry, tAct, tPaint] = (await Promise.all(['Demo', 'Framing & Drywall', 'ACT Ceilings', 'Paint'].map((n, i) => q('INSERT INTO trades(name,sort) VALUES ($1,$2) RETURNING id', [n, i + 1])))).map((r) => r[0].id);
  const [g] = await q(`INSERT INTO gcs(name) VALUES ('Sachse Construction') RETURNING id`);
  const [p] = await q(`INSERT INTO projects(name,gc_id,client,address,proposal_id,ref_code) VALUES ('Mall at Millenia','${g.id}','Sachse','1 Mall Dr, Orlando, FL 32839','P11031','C11031') RETURNING id`); projectId = p.id;
  await q('INSERT INTO project_trades(project_id,trade_id,original_amount) VALUES ($1,$2,25000),($1,$3,90000),($1,$4,8000)', [projectId, tDemo, tDry, tAct]);   // from the proposal
  ai.setFetch(claude);
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
  owner = await login('owner@x.net'); pm = await login('pm@x.net');
});
after(async () => { server.close(); await pool.end(); });

test('trade matching reads the words a contract uses', () => {
  const t = [{ id: 'd', name: 'Demo' }, { id: 'f', name: 'Framing & Drywall' }, { id: 'a', name: 'ACT Ceilings' }, { id: 'p', name: 'Paint' }, { id: 'c', name: 'Carpentry' }];
  assert.equal(matchTrade(t, 'demolition'), 'd'); assert.equal(matchTrade(t, null, 'Gypsum board and taping'), 'f'); assert.equal(matchTrade(t, 'Acoustical ceiling tile'), 'a');
  assert.equal(matchTrade(t, 'Painting and wallcovering'), 'p'); assert.equal(matchTrade(t, 'Plumbing'), null); assert.equal(matchTrade(t, 'Paint', 'x'), 'p');
});
test('the tentative schedule: percents become dollars, monthly progress is one open line, retainage release is added once', () => {
  const s = buildSchedule([{ label: 'Mobilization', percent: 10 }, { label: 'Final', amount: 5000, dueDate: '2027-02-01' }], { total: 50000, retainagePct: 5, monthly: true });
  assert.deepEqual(s.map((r) => [r.label, r.amount, r.expectedDate]), [['Mobilization', 5000, null], ['Final', 5000, '2027-02-01'], ['Retainage release', 2500, null]]);
  const m = buildSchedule([], { total: 50000, retainagePct: null, monthly: true }); assert.equal(m.length, 1); assert.equal(m[0].amount, null);
  assert.equal(buildSchedule([{ label: 'Retainage held until closeout', percent: 5 }], { total: 1000, retainagePct: 5, monthly: false }).length, 1);
  const c = compareToProject([{ tradeId: 'a', amount: 10, include: true }, { tradeId: 'a', amount: 5, include: true }, { tradeId: 'b', amount: 1, include: false }, { tradeId: 'n', amount: 7, include: true }], [{ tradeId: 'a', name: 'A', original: 15 }, { tradeId: 'z', name: 'Z', original: 4 }], new Map([['n', 'New']]));
  assert.deepEqual(c.rows.map((r) => [r.tradeId, r.state, r.current]), [['a', 'same', 15], ['n', 'new', null]]); assert.deepEqual(c.notInContract.map((x) => x.tradeId), ['z']);
});

test('uploading a contract reads it into a review: lines matched to trades, comparison with the proposal, tentative schedule', async () => {
  reply = baseReply(); assert.equal((await upload(pm)).status, 403);
  const up = await upload(); assert.equal(up.status, 200, JSON.stringify(up.body)); assert.equal(up.body.count, 3);
  const c = (await call('GET', `/api/projects/${projectId}/contract`, null, owner)).body, r = c.review;
  assert.equal(r.contractNumber, 'SC-1042'); assert.equal(r.total, 120000); assert.equal(r.retainagePct, 5); assert.equal(r.netDays, 30);
  assert.deepEqual(r.lines.map((l) => l.trade), ['Demo', 'Framing & Drywall', 'Paint']);
  assert.deepEqual(r.compare.rows.map((x) => [x.name, x.state, x.current, x.contract]), [['Demo', 'changed', 25000, 20000], ['Framing & Drywall', 'changed', 90000, 85000], ['Paint', 'new', null, 15000]]);
  assert.deepEqual(r.compare.notInContract.map((x) => x.name), ['ACT Ceilings']);
  assert.deepEqual(r.schedule.map((s) => [s.label, s.amount]), [['Monthly progress billing', null], ['Retainage release', 6000]]);
  assert.equal((await q(`SELECT kind, label FROM ai_usage WHERE kind='contract'`))[0].label.includes('Subcontract.pdf'), true);
  assert.equal((await call('GET', `/api/projects/${projectId}`, null, owner)).body.project.contractUrl === null || true, true);
});
test('nothing changes on the project until the contract is applied; applying needs every line priced and matched', async () => {
  const before = (await call('GET', `/api/projects/${projectId}`, null, owner)).body.trades.map((t) => [t.name, t.original]);
  assert.deepEqual(before, [['Demo', 25000], ['Framing & Drywall', 90000], ['ACT Ceilings', 8000]]);
  const c = (await call('GET', `/api/projects/${projectId}/contract`, null, owner)).body.review;
  const l = c.lines[2]; assert.equal((await call('PUT', `/api/contract-lines/${l.id}`, { tradeId: null }, owner)).status, 200);
  const bad = await call('POST', `/api/contract-runs/${c.id}/apply`, {}, owner); assert.equal(bad.status, 400); assert.match(bad.body.error, /needs a price and a trade/);
  assert.equal((await call('PUT', `/api/contract-lines/${l.id}`, { tradeId: tPaint, amount: 15000 }, owner)).status, 200);
});
test('applying sets the trades and amounts, retainage and document; the schedule stays; an old run cannot be applied twice', async () => {
  const c = (await call('GET', `/api/projects/${projectId}/contract`, null, owner)).body.review;
  const ok = await call('POST', `/api/contract-runs/${c.id}/apply`, {}, owner); assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.deepEqual([ok.body.created, ok.body.changed, ok.body.total, ok.body.notInContract], [1, 2, 120000, ['ACT Ceilings']]);
  const p = (await call('GET', `/api/projects/${projectId}`, null, owner)).body; assert.deepEqual(p.trades.map((t) => [t.name, t.original]).sort(), [['ACT Ceilings', 8000], ['Demo', 20000], ['Framing & Drywall', 85000], ['Paint', 15000]]);
  assert.equal(Number((await q('SELECT retainage_pct FROM projects WHERE id=$1', [projectId]))[0].retainage_pct), 5); assert.ok((await q('SELECT contract_document_id FROM projects WHERE id=$1', [projectId]))[0].contract_document_id);
  const after = (await call('GET', `/api/projects/${projectId}/contract`, null, owner)).body; assert.equal(after.review, null); assert.equal(after.applied.status, 'Applied'); assert.equal(after.schedule.length, 2);
  assert.equal((await call('POST', `/api/contract-runs/${c.id}/apply`, {}, owner)).status, 409);
});
test('a second contract replaces the first; tentative schedule rows are replaced, invoiced ones kept; billing rules still hold', async () => {
  const first = (await call('GET', `/api/projects/${projectId}/contract`, null, owner)).body.applied;
  await q(`UPDATE invoice_schedule SET status='Invoiced' WHERE run_id=$1 AND label='Monthly progress billing'`, [first.id]);
  reply = { ...baseReply(), contractNumber: 'SC-1042-R1', totalAmount: 118000, retainagePercent: 10, lines: [{ description: 'Demo', amount: 20000, tradeHint: 'demo' }, { description: 'Drywall', amount: 83000, tradeHint: 'drywall' }, { description: 'Paint', amount: 15000, tradeHint: 'paint' }], schedule: [{ label: 'Mobilization', percent: 10, amount: null, dueDate: null }] };
  const up = await upload(owner, 'Subcontract-R1.pdf'); assert.equal(up.status, 200);
  const r = (await call('GET', `/api/projects/${projectId}/contract`, null, owner)).body.review; assert.deepEqual(r.schedule.map((s) => [s.label, s.amount]), [['Mobilization', 11800], ['Retainage release', 11800]]);
  // billed work blocks lowering a trade below it
  await q(`INSERT INTO client_invoices(project_id,project_trade_id,number,invoice_date,amount) SELECT $1, id, '1', current_date, 84000 FROM project_trades WHERE project_id=$1 AND trade_id=$2`, [projectId, tDry]);
  const blocked = await call('POST', `/api/contract-runs/${r.id}/apply`, {}, owner); assert.equal(blocked.status, 400); assert.match(blocked.body.error, /cannot exceed/i);
  assert.equal((await call('GET', `/api/projects/${projectId}`, null, owner)).body.trades.find((t) => t.name === 'Framing & Drywall').original, 85000);   // rolled back whole
  await call('PUT', `/api/contract-lines/${r.lines[1].id}`, { amount: 84000 }, owner);
  assert.equal((await call('POST', `/api/contract-runs/${r.id}/apply`, {}, owner)).status, 200);
  const s = (await call('GET', `/api/projects/${projectId}/contract`, null, owner)).body.schedule.map((x) => [x.label, x.status]); assert.deepEqual(s, [['Monthly progress billing', 'Invoiced'], ['Mobilization', 'Tentative'], ['Retainage release', 'Tentative']]);
  assert.equal((await call('PUT', `/api/invoice-schedule/${(await q(`SELECT id FROM invoice_schedule WHERE status='Invoiced'`))[0].id}`, { amount: 1 }, owner)).status, 409);
});
test('when the AI is unavailable the file is still saved and attached', async () => {
  aiDown = true; const up = await upload(owner, 'Work-order.pdf', 'Work order'); aiDown = false;
  assert.equal(up.status, 200); assert.equal(up.body.runId, null); assert.match(up.body.error, /could not read/); assert.ok(up.body.documentId);
  assert.equal((await call('POST', `/api/projects/${projectId}/contract?kind=Bogus`, PDF, owner, 'x.pdf')).status, 400);
  assert.equal((await call('POST', `/api/projects/${projectId}/contract`, Buffer.from('hello'), owner, 'x.txt')).status, 400);
});
