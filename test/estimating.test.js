import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
const { pool, q } = await import('../server/db.js');
const { server } = await import('../server/index.js');
const { hashPassword } = await import('../server/auth.js');
const { todayEastern, shift } = await import('../src/lib/estimating.ts');
const today = todayEastern();

let base, owner, est, asst, pm, tDemo, tDry, tPaint;
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  const h = await hashPassword('correct horse battery');
  for (const [e, r] of [['owner@x.net', 'Super Admin'], ['est@x.net', 'Estimator'], ['asst@x.net', 'Exec Assistant'], ['pm@x.net', 'Project Manager']]) await q('INSERT INTO app_users(email,name,role,password_hash) VALUES ($1,$1,$2,$3)', [e, r, h]);
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });
async function call(method, path, body, cookie) {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text(); return { status: res.status, body: t ? JSON.parse(t) : null };
}
const login = async (email) => { const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct horse battery' }) }); return r.headers.get('set-cookie').split(';')[0]; };
const lead = (o = {}) => ({ name: 'Wingstop - St Cloud', gc: 'CW Hayes Construction', city: 'St Cloud', due: shift(today, 7), tier: 1, ...o });
const mk = async (o) => (await call('POST', '/api/opportunities', lead(o), est)).body.id;

test('setup and who may do what', async () => {
  owner = await login('owner@x.net'); est = await login('est@x.net'); asst = await login('asst@x.net'); pm = await login('pm@x.net');
  tDemo = (await call('POST', '/api/admin/trades', { name: 'Demolition', sort: 1 }, owner)).body.id; tDry = (await call('POST', '/api/admin/trades', { name: 'Framing & Drywall', sort: 2 }, owner)).body.id; tPaint = (await call('POST', '/api/admin/trades', { name: 'Paint', sort: 3 }, owner)).body.id;
  assert.equal((await call('POST', '/api/opportunities', lead(), asst)).status, 403);             // read-only for the assistant
  assert.equal((await call('GET', '/api/opportunities?tab=bids', null, asst)).status, 200);
  assert.equal((await call('GET', '/api/opportunities?tab=bids', null, pm)).status, 403);
  assert.equal((await call('GET', '/api/opportunities?tab=bids')).status, 401);
  assert.deepEqual((await call('GET', '/api/team/estimators', null, est)).body.map((u) => u.email), ['est@x.net', 'owner@x.net']);
});

test('leads are Florida only, validated, and not duplicated', async () => {
  assert.equal((await call('POST', '/api/opportunities', lead({ state: 'TX' }), est)).status, 400);
  assert.equal((await call('POST', '/api/opportunities', lead({ due: '2026-02-30' }), est)).status, 400);
  assert.equal((await call('POST', '/api/opportunities', lead({ email: 'nope' }), est)).status, 400);
  assert.equal((await call('POST', '/api/opportunities', lead({ link: 'http://x.example' }), est)).status, 400);
  assert.equal((await call('POST', '/api/opportunities', lead({ name: '' }), est)).status, 400);
  assert.equal((await call('POST', '/api/opportunities', lead(), est)).status, 200);
  assert.equal((await call('POST', '/api/opportunities', lead({ name: 'WINGSTOP St. Cloud' }), est)).status, 409);        // same GC, project and due date
});

test('CSV import from BuildingConnected: adds new, skips non-Florida and bad dates, ignores repeats', async () => {
  const csv = ['Project,Company,City,State,Bid Due,Contact Email,Invitation',
    `"Aldi - Orlando, FL",Sun Industrial Inc,Orlando,FL,${shift(today, 9)},brandon@sun.com,https://app.buildingconnected.com/a`,
    `Joy Child Academy,MEC General Contractors,Apopka,FL,${shift(today, 10)},,`, `Atlanta Store,Big GC,Atlanta,GA,${shift(today, 10)},,`, `Bad Date Job,Some GC,Tampa,FL,someday,,`,
    `Old Bid,Old GC,Miami,FL,${shift(today, -6)},,`].join('\n');
  let r = (await call('POST', '/api/opportunities/import', { csv, source: 'BuildingConnected' }, est)).body;
  assert.deepEqual([r.added, r.duplicates, r.skipped.length], [3, 0, 2]); assert.match(r.skipped.join(' '), /not in Florida/); assert.match(r.skipped.join(' '), /not a date/);
  r = (await call('POST', '/api/opportunities/import', { csv }, est)).body; assert.deepEqual([r.added, r.duplicates], [0, 3]);
  assert.equal((await call('POST', '/api/opportunities/import', { csv: 'Foo,Bar\n1,2' }, est)).status, 400);
  assert.equal((await call('POST', '/api/opportunities/import', { csv }, asst)).status, 403);
});

test('lead inbox: weekly groups, old bids hidden unless asked for, counts', async () => {
  const r = (await call('GET', '/api/opportunities?tab=bids', null, est)).body;
  const names = r.groups.flatMap((g) => g.rows.map((o) => o.name)); assert.ok(names.includes('Aldi - Orlando, FL') && names.includes('Wingstop - St Cloud')); assert.ok(!names.includes('Old Bid'));
  assert.ok(r.groups.every((g) => /^Week Of |Due This Week|Missed|No Bid/.test(g.name))); assert.equal(r.stats.openLeads, 3);                                                                                // Wingstop, Aldi, Joy (Old Bid has expired)
  const all = (await call('GET', '/api/opportunities?tab=bids&all=1', null, est)).body; assert.ok(all.groups.flatMap((g) => g.rows).some((o) => o.name === 'Old Bid'));
  assert.equal((await call('GET', '/api/opportunities?tab=bids&q=aldi', null, est)).body.count, 1);
});

let wing, aldi;
test('accept assigns a proposal number and moves the lead to the proposal tracker; decline needs a reason', async () => {
  const list = (await call('GET', '/api/opportunities?tab=bids', null, est)).body.groups.flatMap((g) => g.rows); wing = list.find((o) => o.name === 'Wingstop - St Cloud').id; aldi = list.find((o) => o.name === 'Aldi - Orlando, FL').id;
  const a = (await call('POST', `/api/opportunities/${wing}/accept`, {}, est)); assert.equal(a.status, 200);
  const prefix = 'P' + today.slice(5, 7) + today.slice(8, 10); assert.equal(a.body.proposalId, prefix + '1'); assert.equal(a.body.folderPlan.folders.length, 6); assert.match(a.body.folderPlan.root, new RegExp(`^ByOther/${today.slice(0, 4)}/CW Hayes Construction/${prefix}1_Wingstop - St Cloud`));
  assert.equal((await call('POST', `/api/opportunities/${wing}/accept`, {}, est)).status, 409);
  assert.equal((await call('POST', `/api/opportunities/${aldi}/accept`, { estimatorId: '00000000-0000-0000-0000-000000000000' }, est)).status, 400);
  assert.equal((await call('POST', `/api/opportunities/${aldi}/accept`, {}, owner)).body.proposalId, prefix + '2');
  assert.equal((await call('POST', `/api/opportunities/${wing}/decline`, { reason: 'x' }, est)).status, 409);                // accepted work cannot be declined
  const joy = (await call('GET', '/api/opportunities?tab=bids&q=joy', null, est)).body.groups[0].rows[0].id;
  assert.equal((await call('POST', `/api/opportunities/${joy}/decline`, {}, est)).status, 400);
  assert.equal((await call('POST', `/api/opportunities/${joy}/decline`, { reason: 'Too far out' }, est)).status, 200);
  assert.equal((await call('GET', '/api/opportunities?tab=bids&q=joy', null, est)).body.count, 0);
  assert.equal((await call('POST', `/api/opportunities/${joy}/reopen`, {}, est)).status, 200); assert.equal((await call('GET', '/api/opportunities?tab=bids&q=joy', null, est)).body.count, 1);
  const s = (await call('GET', '/api/opportunities?tab=proposals', null, est)).body; assert.deepEqual([s.count, s.stats.accepted, s.stats.working], [2, 2, 2]);
});

test('trade prices come from Admin trades; the proposal total follows them', async () => {
  assert.equal((await call('PUT', `/api/opportunities/${wing}/trade-prices`, { prices: [{ tradeId: tDemo, amount: 25000.555 }] }, est)).status, 400);
  assert.equal((await call('PUT', `/api/opportunities/${wing}/trade-prices`, { prices: [{ tradeId: tDemo, amount: 1 }, { tradeId: tDemo, amount: 2 }] }, est)).status, 400);
  assert.equal((await call('PUT', `/api/opportunities/${wing}/trade-prices`, { prices: [{ tradeId: '00000000-0000-0000-0000-000000000000', amount: 5 }] }, est)).status, 400);
  assert.equal((await call('PUT', `/api/opportunities/${wing}/trade-prices`, { prices: [{ tradeId: tDemo, amount: 25000 }, { tradeId: tDry, amount: 132000.5 }] }, est)).status, 200);
  const o = (await call('GET', `/api/opportunities/${wing}`, null, est)).body; assert.deepEqual([o.total, o.tradePrices.map((p) => p.name)], [157000.5, ['Demolition', 'Framing & Drywall']]);
  const fresh = await mk({ name: 'Unaccepted', gc: 'Other GC' }); assert.equal((await call('PUT', `/api/opportunities/${fresh}/trade-prices`, { prices: [{ tradeId: tDemo, amount: 1 }] }, est)).status, 400);
});

test('submitting: needs prices, a real date and a method; resubmitting makes a new version; follow-up runs on a schedule', async () => {
  assert.equal((await call('POST', `/api/opportunities/${aldi}/submissions`, { date: today, method: 'Email' }, est)).status, 400);                 // no price yet
  assert.equal((await call('POST', `/api/opportunities/${wing}/submissions`, { date: shift(today, 1), method: 'Email' }, est)).status, 400);          // future
  assert.equal((await call('POST', `/api/opportunities/${wing}/submissions`, { date: today, method: 'Carrier pigeon' }, est)).status, 400);
  assert.equal((await call('POST', `/api/opportunities/${wing}/communications`, { kind: 'First Email Sent', date: today }, est)).status, 400);         // nothing to follow up yet
  const s = await call('POST', `/api/opportunities/${wing}/submissions`, { date: today, method: 'via BuildingConnected', link: 'https://example.com/p.pdf' }, est); assert.deepEqual([s.status, s.body.version, s.body.price], [200, 1, 157000.5]);
  const o = (await call('GET', `/api/opportunities/${wing}`, null, est)).body; assert.deepEqual([o.status, o.progress, o.countdown, o.followup.stage], ['Submitted', 'Done', 'Submitted', 'First Email']);
  assert.equal((await call('GET', '/api/opportunities?tab=submissions', null, est)).body.count, 1);
  await call('POST', `/api/opportunities/${wing}/communications`, { kind: 'First Email Sent', date: today }, est);                                      // follow-up on version 1
  assert.equal((await call('GET', `/api/opportunities/${wing}`, null, est)).body.followup.stage, 'Call / Message');
  assert.equal((await call('POST', `/api/opportunities/${wing}/submissions`, { date: today, method: 'Email', price: 150000 }, est)).body.version, 2);
  assert.equal((await call('GET', `/api/opportunities/${wing}`, null, est)).body.followup.stage, 'First Email');                                       // a revised proposal starts a fresh follow-up cycle
  await call('POST', `/api/opportunities/${wing}/communications`, { kind: 'First Email Sent', date: today }, est);
  assert.equal((await call('GET', `/api/opportunities/${wing}`, null, est)).body.followup.stage, 'Call / Message');
  await call('POST', `/api/opportunities/${wing}/communications`, { kind: 'Reply Received', date: today, note: 'Wants to talk Monday' }, est);
  const done = (await call('GET', `/api/opportunities/${wing}`, null, est)).body; assert.equal(done.followup.stage, 'Interested'); assert.equal((await call('GET', '/api/opportunities?tab=bids', null, est)).body.stats.interested, 1);
  assert.ok(done.events.some((e) => e.action === 'Resubmitted (v2)'));
});

test('awarding builds the project: trades, amounts, GC, proposal number; it cannot be awarded twice', async () => {
  assert.equal((await call('POST', `/api/opportunities/${aldi}/result`, { result: 'Awarded' }, est)).status, 400);                                      // never submitted
  assert.equal((await call('POST', `/api/opportunities/${wing}/result`, { result: 'Lost' }, est)).status, 400);                                          // loss needs a reason
  const r = await call('POST', `/api/opportunities/${wing}/result`, { result: 'Awarded' }, est); assert.equal(r.status, 200);
  const p = (await call('GET', `/api/projects/${r.body.projectId}`, null, owner)).body;
  assert.deepEqual([p.project.name, p.project.gc, p.project.proposalId, p.totals.contract, p.trades.map((t) => t.name)], ['Wingstop - St Cloud', 'CW Hayes Construction', (await call('GET', `/api/opportunities/${wing}`, null, est)).body.proposalId, 157000.5, ['Demolition', 'Framing & Drywall']]);
  assert.equal((await call('POST', `/api/opportunities/${wing}/result`, { result: 'Awarded' }, est)).status, 409);
  assert.equal((await call('DELETE', `/api/opportunities/${wing}`, null, est)).status, 409);
  assert.equal((await call('GET', `/api/ntos?year=${today.slice(0, 4)}`, null, owner)).body[0].project, 'Wingstop - St Cloud');                       // notice-to-owner tracking starts with the project
  const o = (await call('GET', `/api/opportunities/${wing}`, null, est)).body; assert.deepEqual([o.status, o.result, o.followup.stage], ['Awarded', 'Awarded', 'Paused']);
});

test('opportunities can be linked from messages and to-dos', async () => {
  const t = await call('POST', '/api/threads', { subject: 'Aldi bid', body: 'Look at this', memberIds: [], links: [{ kind: 'opportunity', id: aldi }] }, est); assert.equal(t.status, 200);
  const th = (await call('GET', `/api/threads/${t.body.id}`, null, est)).body; assert.deepEqual([th.messages[0].links[0].label, th.messages[0].links[0].route], ['Aldi - Orlando, FL', `#/estimating/${aldi}`]);
  assert.deepEqual((await call('GET', '/api/search/records?kind=opportunity&q=aldi', null, est)).body.map((r) => r.label), ['Aldi - Orlando, FL']);
});

test('insights: win rates, loss reasons, realized margin vs target, expected awards (only once there is enough history)', async () => {
  assert.equal((await call('GET', '/api/estimating/insights', null, est)).body.enough, false);
  const bid = async (name, gc, price, result, reason) => {
    const id = await mk({ name, gc }); await call('POST', `/api/opportunities/${id}/accept`, {}, est);
    await call('PUT', `/api/opportunities/${id}/trade-prices`, { prices: [{ tradeId: tPaint, amount: price }] }, est); await call('POST', `/api/opportunities/${id}/submissions`, { date: today, method: 'Email' }, est);
    if (result) { const r = await call('POST', `/api/opportunities/${id}/result`, { result, reason }, est); assert.equal(r.status, 200); return r.body.projectId; } return id;
  };
  const p1 = await bid('Job A', 'GC One', 10000, 'Awarded'); await bid('Job B', 'GC One', 12000, 'Awarded'); await bid('Job C', 'GC Two', 9000, 'Lost', 'Price too high'); await bid('Job D', 'GC Two', 8000, 'Lost', 'Price too high'); await bid('Job E', 'GC Three', 7000, 'Awarded');
  await bid('Job F', 'GC Three', 20000, null);                                                                                                         // still waiting on a decision
  // Job A actually cost $9,000 on a $10,000 trade -> 10% realized margin vs the 20% target
  const sup = (await call('POST', '/api/admin/suppliers', { name: 'Supply Co' }, owner)).body.id; const pt = (await call('GET', `/api/projects/${p1}`, null, owner)).body.trades[0].id;
  assert.equal((await call('POST', '/api/supplier-invoices', { supplierId: sup, reference: 'X1', total: 9000, allocations: [{ projectId: p1, projectTradeId: pt, amount: 9000 }] }, owner)).status, 200);
  const i = (await call('GET', '/api/estimating/insights', null, est)).body;
  assert.equal(i.enough, true); assert.deepEqual([i.overall.won, i.overall.lost, i.overall.winRate], [4, 2, 66.67]);
  assert.deepEqual(i.lossReasons, [{ reason: 'Price too high', n: 2 }]);
  assert.deepEqual(i.byGc.find((g) => g.name === 'GC Two'), { name: 'GC Two', bids: 2, won: 0, lost: 2, winRate: 0, avgPrice: 8500 });
  const m = i.margins.find((x) => x.trade === 'Paint'); assert.deepEqual([m.margin, m.gap], [10, 10]); assert.match(m.suggestion, /raise Paint pricing about 10 points/);
  assert.equal(i.pipeline.open, 1); assert.equal(i.pipeline.value, 20000); assert.equal(i.pipeline.expected, 13334);   // 20,000 x the 66.67% win rate
  assert.equal((await call('PUT', '/api/settings/estimating', { targetMargin: 5 }, est)).status, 403);
  assert.equal((await call('PUT', '/api/settings/estimating', { targetMargin: 5 }, owner)).status, 200);
  assert.equal((await call('GET', '/api/estimating/insights', null, est)).body.margins.find((x) => x.trade === 'Paint').suggestion, 'On target');
});

test('edit and delete a lead; BuildingConnected status is honest about needing credentials', async () => {
  const id = await mk({ name: 'Temp lead', gc: 'Temp GC' });
  assert.equal((await call('PUT', `/api/opportunities/${id}`, { status: 'Awarded' }, est)).status, 400); assert.equal((await call('PUT', `/api/opportunities/${id}`, { state: 'GA' }, est)).status, 400);
  assert.equal((await call('PUT', `/api/opportunities/${id}`, { notes: 'call back', tier: 2 }, est)).status, 200); assert.equal((await call('GET', `/api/opportunities/${id}`, null, est)).body.notes, 'call back');
  assert.equal((await call('DELETE', `/api/opportunities/${id}`, null, est)).status, 200); assert.equal((await call('GET', `/api/opportunities/${id}`, null, est)).status, 404);
  const c = (await call('GET', '/api/estimating/connection', null, est)).body.buildingConnected; assert.equal(c.connected, false); assert.match(c.note, /CSV/);
});
