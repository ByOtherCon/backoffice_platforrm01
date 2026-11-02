import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
const { pool, q } = await import('../server/db.js');
const { server } = await import('../server/index.js');
const { hashPassword } = await import('../server/auth.js');

let base, owner, sub, est, ids = {};
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  const h = await hashPassword('correct horse battery');
  for (const [e, n, r] of [['owner@x.net', 'Benny', 'Super Admin'], ['sub@x.net', 'Sub', 'Sub Admin'], ['est@x.net', 'Juliana', 'Estimator']]) ids[e] = (await q('INSERT INTO app_users(email,name,role,password_hash) VALUES ($1,$2,$3,$4) RETURNING id', [e, n, r, h]))[0].id;
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });
async function call(method, path, body, cookie) {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text(); return { status: res.status, body: t ? JSON.parse(t) : null };
}
const login = async (email) => { const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct horse battery' }) }); return r.headers.get('set-cookie').split(';')[0]; };
const use = (who, kind, i, o, label = null, ago = '0 days') => q(`INSERT INTO ai_usage(user_id,kind,label,model,input_tokens,output_tokens,created_at) VALUES ($1,$2,$3,'claude-sonnet-5-5',$4,$5, now() - $6::interval)`, [who ? ids[who] : null, kind, label, i, o, ago]);

test('only the Super Admin sees AI spending', async () => {
  owner = await login('owner@x.net'); sub = await login('sub@x.net'); est = await login('est@x.net');
  assert.equal((await call('GET', '/api/ai/report', null, sub)).status, 403); assert.equal((await call('GET', '/api/ai/report', null, est)).status, 403); assert.equal((await call('GET', '/api/ai/report')).status, 401);
  assert.equal((await call('PUT', '/api/settings/ai', { inputPerM: 3 }, sub)).status, 403);
  assert.equal((await call('POST', '/api/reports/run', { source: 'ai_usage' }, sub)).status, 403);
});

test('usage is read by person, by task and by day, with the scheduled refresh named as such', async () => {
  await use('est@x.net', 'receipt', 1000, 200, null, '1 day'); await use('est@x.net', 'proposal', 5000, 800, 'Proposal.pdf', '2 days'); await use('owner@x.net', 'takeoff', 40000, 6000, 'plans.pdf', '3 days');
  await use(null, 'bids', 20000, 3000, '4 email threads', '0 days'); await use('est@x.net', 'receipt', 2000, 300, null, '40 days');
  const r = (await call('GET', '/api/ai/report?days=30', null, owner)).body;
  assert.deepEqual([r.total.calls, r.total.input, r.total.output, r.total.tokens], [4, 66000, 10000, 76000]);                       // the 40-day-old call is outside the window
  assert.deepEqual(r.byUser.map((u) => [u.who, u.tokens]), [['Benny', 46000], ['Automatic (scheduled)', 23000], ['Juliana', 7000]]);
  assert.deepEqual(r.byTask.map((t) => [t.task, t.calls]), [['Plan takeoff', 1], ['Gmail bid emails', 1], ['Proposal PDFs', 1], ['Receipts and invoices', 1]]);
  assert.ok(r.byUserTask.some((x) => x.who === 'Juliana' && x.task === 'Proposal PDFs' && x.tokens === 5800)); assert.equal(r.byDay.length, 4);
  assert.deepEqual(r.recent.slice(0, 2).map((x) => [x.who, x.label]), [['Automatic (scheduled)', '4 email threads'], ['Juliana', null]]); assert.equal(r.byMonth.reduce((n, m) => n + m.calls, 0), 5);
  assert.equal((await call('GET', '/api/ai/report?days=7', null, owner)).body.days, 7); assert.equal((await call('GET', '/api/ai/report?days=999', null, owner)).body.days, 30);
});

test('dollar estimates appear only once prices are entered, and the cap and prices are validated', async () => {
  let r = (await call('GET', '/api/ai/report', null, owner)).body; assert.equal(r.priced, false); assert.equal(r.total.cost, null);
  assert.equal((await call('PUT', '/api/settings/ai', { inputPerM: -1 }, owner)).status, 400); assert.equal((await call('PUT', '/api/settings/ai', { inputPerM: 'abc' }, owner)).status, 400); assert.equal((await call('PUT', '/api/settings/ai', { monthlyTokenCap: 1.5 }, owner)).status, 400);
  assert.equal((await call('PUT', '/api/settings/ai', { inputPerM: 3, outputPerM: 15 }, owner)).status, 200);
  r = (await call('GET', '/api/ai/report', null, owner)).body; assert.equal(r.priced, true); assert.equal(r.total.cost, 0.35);               // 66,000 x $3/M + 10,000 x $15/M
  assert.equal(r.byUser[0].cost, 0.21); assert.equal(r.month.cap, 2000000);                                                             // the cap was left alone by a price change
  assert.equal((await call('PUT', '/api/settings/ai', { monthlyTokenCap: 100000 }, owner)).status, 200); const m = (await call('GET', '/api/ai/report', null, owner)).body; assert.deepEqual([m.month.cap, m.rates.inputPerM], [100000, 3]);
  const thisMonth = Number((await q(`SELECT COALESCE(SUM(input_tokens+output_tokens),0) AS t FROM ai_usage WHERE created_at >= date_trunc('month', now())`))[0].t);
  assert.deepEqual([m.month.tokens, m.month.pctOfCap], [thisMonth, Math.round((thisMonth / 100000) * 1000) / 10]);   // the cap counts this calendar month only
});

test('the Reports page can filter and export the same usage', async () => {
  assert.ok((await call('GET', '/api/reports/sources', null, owner)).body.sources.some((s) => s.id === 'ai_usage'));
  const rows = (await call('POST', '/api/reports/run', { source: 'ai_usage' }, owner)).body.rows; assert.equal(rows.length, 5); assert.ok(rows.every((x) => x.totalTokens > 0)); assert.ok(rows.some((x) => x.person === 'Automatic (scheduled)'));
});
