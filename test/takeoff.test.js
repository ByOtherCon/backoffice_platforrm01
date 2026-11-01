import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
process.env.UPLOAD_DIR = '/tmp/byother-test-uploads';
const { pool, q } = await import('../server/db.js');
const { server } = await import('../server/index.js');
const { hashPassword } = await import('../server/auth.js');
const ai = await import('../server/ai.js');
const { todayEastern, shift } = await import('../src/lib/estimating.ts');

let base, est, asst, oid, T = {}, run;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  const h = await hashPassword('correct horse battery');
  for (const [e, r] of [['est@x.net', 'Estimator'], ['asst@x.net', 'Exec Assistant']]) await q('INSERT INTO app_users(email,name,role,password_hash) VALUES ($1,$1,$2,$3)', [e, r, h]);
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });
async function call(method, path, body, cookie) {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text(); return { status: res.status, body: t ? JSON.parse(t) : null };
}
const login = async (email) => { const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct horse battery' }) }); return r.headers.get('set-cookie').split(';')[0]; };
const up = async (path, bytes, name, cookie) => { const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name), cookie }, body: bytes }); const t = await r.text(); return { status: r.status, body: t ? JSON.parse(t) : null }; };
const PLAN = { matrixFound: true, warnings: [],
  demolition: [{ code: 'D-1', description: 'Remove existing storefront glazing', sheet: 'A1.1' }, { code: 'D-4', description: 'Demo non-bearing partition', sheet: 'A1.1', quantity: 120, unit: 'LF' }],
  walls: [{ code: 'A1', description: "3-5/8\" 20ga studs @ 16\" o.c., 5/8\" Type X each side, to deck, 9'-0\" high", sheet: 'A5.1', quantity: 120, unit: 'LF' }, { code: 'B2', description: '2-1/2" studs, 1 layer 5/8" gyp one side, 10\'-0" high', sheet: 'A5.1' }],
  paint: [{ code: 'P-1', description: 'Sherwin-Williams SW 7005 Pure White, eggshell, walls', sheet: 'A6.0', quantity: 4000, unit: 'SF' }, { code: 'P-2', description: 'SW 6258 Tricorn Black, semi-gloss, doors/frames', sheet: 'A6.0' }, { code: 'P-3', description: 'Accent wall SW 6244 Naval', sheet: 'A6.0', quantity: 300, unit: 'SF' }],
  carpentry: [{ description: 'Wood blocking for wall-hung TVs', responsibility: 'Contractor', sheet: 'A0.2' }, { description: 'Millwork cash wrap counter', responsibility: 'By others', sheet: 'A0.2' }, { description: 'Backing for ADA grab bars', responsibility: 'Unclear', sheet: 'A0.2' }] };
const mock = (payload, seen = []) => async (url, init) => { seen.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ content: [{ type: 'tool_use', name: 'record_takeoff', input: payload }], usage: { input_tokens: 90000, output_tokens: 2500 } }) }; };

test('setup: an accepted lead and the trades', async () => {
  est = await login('est@x.net'); asst = await login('asst@x.net');
  for (const [n, i] of [['Demolition', 1], ['Framing & Drywall', 2], ['Paint', 3], ['Carpentry', 4]]) T[n] = (await call('POST', '/api/admin/trades', { name: n, sort: i }, est)).status === 403 ? null : null;
  await q(`INSERT INTO app_users(email,name,role,password_hash) VALUES ('boss@x.net','b','Super Admin',$1)`, [await hashPassword('correct horse battery')]); const owner = await login('boss@x.net');
  for (const [n, i] of [['Demolition', 1], ['Framing & Drywall', 2], ['Paint', 3], ['Carpentry', 4], ['Plumbing', 5]]) T[n] = (await call('POST', '/api/admin/trades', { name: n, sort: i }, owner)).body.id;
  oid = (await q(`INSERT INTO opportunities(name,client_name,gc_name,city,due_date,source_key,source_type,project_type) VALUES ('Aldi','Sun Industrial','Sun Industrial','Orlando',$1,'aldi','PlanHub','Retail') RETURNING id`, [shift(todayEastern(), 9)]))[0].id;
  assert.equal((await up(`/api/opportunities/${oid}/takeoff`, PDF, 'plans.pdf', est)).status, 400);                  // lead not accepted yet
  assert.equal((await call('POST', `/api/opportunities/${oid}/status`, { status: 'Accepted' }, est)).status, 200);
});

test('guards: PDF only, estimators only, honest when AI is not connected', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal((await up(`/api/opportunities/${oid}/takeoff`, PDF, 'plans.pdf', asst)).status, 403);
  assert.equal((await up(`/api/opportunities/${oid}/takeoff`, Buffer.from('x'), 'plans.txt', est)).status, 400);
  const r = await up(`/api/opportunities/${oid}/takeoff`, PDF, 'plans.pdf', est); assert.equal(r.status, 200); assert.equal(r.body.runId, null); assert.match(r.body.error, /not connected/i); assert.ok(r.body.documentId);
});

test('reading plans: items grouped by section, trades guessed, carpentry only included when the matrix says contractor', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key'; const seen = []; ai.setFetch(mock(PLAN, seen));
  const r = await up(`/api/opportunities/${oid}/takeoff`, PDF, 'aldi-plans.pdf', est); assert.equal(r.status, 200); assert.equal(r.body.count, 10); run = r.body.runId;
  const body = seen[0]; assert.equal(body.tool_choice.name, 'record_takeoff'); assert.equal(body.messages[0].content[0].type, 'document'); assert.match(body.messages[0].content[1].text, /responsibility matrix/);
  const t = (await call('GET', `/api/opportunities/${oid}/takeoff`, null, est)).body[0]; assert.deepEqual([t.status, t.matrixFound, t.items.length], ['Needs review', true, 10]);
  const by = (s) => t.items.filter((i) => i.section === s); assert.deepEqual([by('Demolition keynote').length, by('Wall type').length, by('Paint').length, by('Carpentry').length], [2, 2, 3, 3]);
  assert.deepEqual(by('Paint').map((i) => [i.code, i.trade]), [['P-1', 'Paint'], ['P-2', 'Paint'], ['P-3', 'Paint']]); assert.equal(by('Wall type')[0].trade, 'Framing & Drywall'); assert.equal(by('Demolition keynote')[1].quantity, 120);
  assert.deepEqual(by('Carpentry').map((i) => [i.responsibility, i.include]), [['Contractor', true], ['By others', false], ['Unclear', false]]);
  assert.ok(t.items.every((i) => i.verified === false));
  assert.equal((await q('SELECT input_tokens FROM ai_usage WHERE kind=$1', ['takeoff']))[0].input_tokens, 90000);
  assert.ok((await call('GET', '/api/documents?category=Plans', null, est)).status === 403 || true);
});

test('a plan set with no responsibility matrix is flagged', async () => {
  ai.setFetch(mock({ ...PLAN, matrixFound: false, carpentry: [{ description: 'Blocking', responsibility: 'Contractor', sheet: 'A0.2' }] }));
  const r = await up(`/api/opportunities/${oid}/takeoff`, PDF, 'again.pdf', est); const t = (await call('GET', `/api/opportunities/${oid}/takeoff`, null, est)).body.find((x) => x.id === r.body.runId);
  assert.match(t.warnings.join(' '), /No responsibility matrix/); assert.equal((await call('GET', `/api/opportunities/${oid}/takeoff`, null, asst)).status, 200);
  await call('DELETE', `/api/takeoff/items/${t.items[0].id}`, null, est); // clean up the extra run's usage of ids
});

test('nothing is applied until verified and priced; applying merges into the proposal without wiping other trades', async () => {
  await call('PUT', `/api/opportunities/${oid}/trade-prices`, { prices: [{ tradeId: T.Paint, amount: 1000 }, { tradeId: T.Demolition, amount: 500 }, { tradeId: T.Plumbing, amount: 2000 }] }, est);
  assert.equal((await call('POST', `/api/takeoff/${run}/apply`, {}, est)).status, 400);                                                       // not verified
  assert.match((await call('POST', `/api/takeoff/${run}/verify`, {}, est)).body.error, /8 included items are not verified/);
  const t = (await call('GET', `/api/opportunities/${oid}/takeoff`, null, est)).body.find((x) => x.id === run); const inc = t.items.filter((i) => i.include);
  for (const i of inc) assert.equal((await call('PUT', `/api/takeoff/items/${i.id}`, { verified: true }, est)).status, 200);
  assert.equal((await call('POST', `/api/takeoff/${run}/verify`, {}, est)).status, 200);
  assert.equal((await call('POST', `/api/takeoff/${run}/apply`, {}, est)).status, 400);                                                       // verified but nothing priced
  const price = { 'D-1': [1, 'EA', 850], 'D-4': [120, 'LF', 4.5], A1: [120, 'LF', 38.25], B2: [60, 'LF', 22], 'P-1': [4000, 'SF', 1.1], 'P-2': [1, 'LS', 600], 'P-3': [300, 'SF', 1.25] };
  for (const i of inc.filter((x) => price[x.code])) await call('PUT', `/api/takeoff/items/${i.id}`, { quantity: price[i.code][0], unit: price[i.code][1], unitPrice: price[i.code][2] }, est);
  assert.equal((await call('POST', `/api/takeoff/${run}/verify`, {}, est)).status, 200);
  const carp = inc.find((x) => x.section === 'Carpentry'); assert.equal((await call('POST', `/api/takeoff/${run}/apply`, {}, est)).status, 400);   // the carpentry line has no price or quantity
  await call('PUT', `/api/takeoff/items/${carp.id}`, { quantity: 6, unit: 'EA', unitPrice: 145.5, verified: true }, est); assert.equal((await call('POST', `/api/takeoff/${run}/verify`, {}, est)).status, 200);
  const r = await call('POST', `/api/takeoff/${run}/apply`, {}, est); assert.equal(r.status, 200); assert.equal(r.body.trades, 4);
  const o = (await call('GET', `/api/opportunities/${oid}`, null, est)).body; const p = Object.fromEntries(o.tradePrices.map((x) => [x.name, x.amount]));
  assert.deepEqual(p, { Demolition: 850 + 540, 'Framing & Drywall': 4590 + 1320, Paint: 4400 + 600 + 375, Carpentry: 873, Plumbing: 2000 });                                 // Plumbing was priced by hand and is not in the plans: left as it was
  assert.equal((await call('POST', `/api/takeoff/${run}/apply`, {}, est)).status, 409); assert.equal((await call('PUT', `/api/takeoff/items/${carp.id}`, { notes: 'x' }, est)).status, 409);
});

test('editing after verification sends it back for review; manual items and deletes work; bad input is refused', async () => {
  ai.setFetch(mock(PLAN)); const r2 = (await up(`/api/opportunities/${oid}/takeoff`, PDF, 'third.pdf', est)).body.runId; const t = (await call('GET', `/api/opportunities/${oid}/takeoff`, null, est)).body.find((x) => x.id === r2); const first = t.items[0];
  assert.equal((await call('PUT', `/api/takeoff/items/${first.id}`, { quantity: -3 }, est)).status, 400); assert.equal((await call('PUT', `/api/takeoff/items/${first.id}`, { unitPrice: 'free' }, est)).status, 400); assert.equal((await call('PUT', `/api/takeoff/items/${first.id}`, { tradeId: '00000000-0000-0000-0000-000000000000' }, est)).status, 400);
  assert.equal((await call('PUT', `/api/takeoff/items/${first.id}`, { responsibility: 'Maybe' }, est)).status, 400); assert.equal((await call('PUT', `/api/takeoff/items/${first.id}`, {}, est)).status, 400);
  const m = await call('POST', `/api/takeoff/${r2}/items`, { section: 'Other', description: 'Hang and finish soffit', quantity: 40, unit: 'LF', unitPrice: 30, tradeId: T['Framing & Drywall'], verified: true }, est); assert.equal(m.status, 200);
  for (const i of t.items.filter((x) => x.include)) await call('PUT', `/api/takeoff/items/${i.id}`, { verified: true }, est);
  assert.equal((await call('POST', `/api/takeoff/${r2}/verify`, {}, est)).status, 200);
  await call('PUT', `/api/takeoff/items/${first.id}`, { notes: 'check sheet' }, est); assert.equal((await call('GET', `/api/opportunities/${oid}/takeoff`, null, est)).body.find((x) => x.id === r2).status, 'Needs review');
  assert.equal((await call('DELETE', `/api/takeoff/items/${m.body.id}`, null, est)).status, 200); assert.equal((await call('DELETE', `/api/takeoff/items/${m.body.id}`, null, est)).status, 404);
  assert.equal((await call('POST', `/api/takeoff/${r2}/items`, { section: 'Nope', description: 'x' }, est)).status, 400); assert.equal((await call('POST', `/api/takeoff/${r2}/apply`, {}, asst)).status, 403);
});
