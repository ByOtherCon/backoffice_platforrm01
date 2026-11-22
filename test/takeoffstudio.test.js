// Takeoff Studio, inside Estimate With AI: saving the takeoff on a lead (a stale copy is refused), the lead's plan PDFs for the page to
// draw, Claude's questions passed through (only plain content goes out, usage is logged), the rules Claude follows, the company starting
// list, the handoff to the estimating chat, and the takeoff moving with a bundled lead.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bo-studio-'));
const { pool, q } = await import('../server/db.js');
const { server } = await import('../server/index.js');
const { hashPassword } = await import('../server/auth.js');
const ai = await import('../server/ai.js');
const ec = await import('../server/estimateChat.js');

// a stand-in for the AI service: answers each request with the next scripted reply and keeps what was sent
let requests = [], script = [], pending = Promise.resolve();
const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const answer = (blocks, stop = 'end_turn') => sse([{ type: 'message_start', message: { id: 'm', model: 'claude-opus-5-5', content: [], usage: { input_tokens: 900, output_tokens: 1 } } },
  ...blocks.flatMap((b, i) => b.type === 'text' ? [{ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: b.text } }, { type: 'content_block_stop', index: i }]
    : [{ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } }, { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } }, { type: 'content_block_stop', index: i }]),
  { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 40 } }, { type: 'message_stop' }]);
const service = async (url, init = {}) => {
  if (String(url).endsWith('/v1/files')) return { ok: true, status: 200, json: async () => ({ id: 'file_x' }) };
  const body = JSON.parse(init.body); requests.push(body); const next = script.shift() ?? answer([{ type: 'text', text: 'ok' }]);
  return { ok: true, status: 200, text: async () => next };
};

let base, est, pm, owner, oid, oid2;
async function call(method, p, body, cookie) {
  const r = await fetch(base + p, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let b = null; try { b = t ? JSON.parse(t) : null; } catch { b = t; } return { status: r.status, body: b, type: r.headers.get('content-type') };
}
const login = async (email) => (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct horse battery' }) })).headers.get('set-cookie').split(';')[0];
const pdf = (label) => Buffer.from(`%PDF-1.4\n% ${label}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF`);
const lead = async (name, gc = 'CW Hayes Construction') => (await q(`INSERT INTO opportunities(name,gc_name) VALUES ($1,$2) RETURNING id`, [name, gc]))[0].id;
const addPlan = async (o, name, bytes) => { const key = crypto.randomBytes(8).toString('hex') + '.pdf'; fs.writeFileSync(path.join(process.env.UPLOAD_DIR, key), bytes);
  return (await q(`INSERT INTO opportunity_files(opportunity_id,kind,name,storage_key,mime,size) VALUES ($1,'Plans',$2,$3,'application/pdf',$4) RETURNING id`, [o, name, key, bytes.length]))[0].id; };

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  const h = await hashPassword('correct horse battery');
  for (const [e, n, r] of [['owner@x.net', 'Benny', 'Super Admin'], ['est@x.net', 'Juliana', 'Estimator'], ['pm@x.net', 'Pat', 'Project Manager']]) await q('INSERT INTO app_users(email,name,role,password_hash) VALUES ($1,$2,$3,$4)', [e, n, r, h]);
  ai.setFetch(service); ec.setRunner((fn) => { pending = fn(); });
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
  owner = await login('owner@x.net'); est = await login('est@x.net'); pm = await login('pm@x.net');
  oid = await lead('Amazon - Orlando'); oid2 = await lead('Burlington - Tampa');
});
after(async () => { server.close(); await pool.end(); fs.rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true }); });

test('a new lead opens with an empty takeoff; a save is kept, and a save from an older copy is refused', async () => {
  const g = (await call('GET', `/api/opportunities/${oid}/takeoff-studio`, null, est)).body;
  assert.equal(g.data, null); assert.equal(g.version, 0); assert.equal(g.lead.name, 'Amazon - Orlando'); assert.equal(g.aiConnected, true);
  const data = { sheets: [{ id: 's1', name: 'A1.01', kind: 'plan', items: [{ id: 'w1', kind: 'partition', pts: [[0, 0], [100, 0]] }] }], types: [{ id: 't1', tag: 'A3', height: 11.5 }] };
  const s1 = await call('PUT', `/api/opportunities/${oid}/takeoff-studio`, { data, version: 0 }, est); assert.equal(s1.status, 200, JSON.stringify(s1.body)); assert.equal(s1.body.version, 1);
  const s2 = await call('PUT', `/api/opportunities/${oid}/takeoff-studio`, { data: { ...data, defaultCeilingHt: 10 }, version: 1 }, est); assert.equal(s2.body.version, 2);
  const stale = await call('PUT', `/api/opportunities/${oid}/takeoff-studio`, { data, version: 1 }, est); assert.equal(stale.status, 409); assert.match(stale.body.error, /Someone else saved/);
  const back = (await call('GET', `/api/opportunities/${oid}/takeoff-studio`, null, est)).body;
  assert.equal(back.version, 2); assert.equal(back.data.defaultCeilingHt, 10); assert.equal(back.updatedBy, 'Juliana');
  assert.equal((await call('PUT', `/api/opportunities/${oid}/takeoff-studio`, { data: [1, 2], version: 2 }, est)).status, 400);
});

test('it belongs to the Estimating area: someone without it (a project manager by default) cannot open or change it', async () => {
  assert.equal((await call('GET', `/api/opportunities/${oid}/takeoff-studio`, null, pm)).status, 403);
  assert.equal((await call('PUT', `/api/opportunities/${oid}/takeoff-studio`, { data: {}, version: 2 }, pm)).status, 403);
  assert.equal((await call('POST', `/api/opportunities/${oid}/takeoff-studio/ask`, { messages: [{ role: 'user', content: 'hi' }] }, pm)).status, 403);
});

test('the plans on the lead are listed and served to the page; a key that is not on the lead is refused', async () => {
  const fid = await addPlan(oid, 'A1.01 Floor Plan.pdf', pdf('a1'));
  const l = (await call('GET', `/api/opportunities/${oid}/takeoff-studio/plans`, null, est)).body;
  assert.deepEqual(l.plans.map((p) => [p.key, p.name, p.where]), [[`file:${fid}`, 'A1.01 Floor Plan.pdf', 'app']]);
  const f = await fetch(`${base}/api/opportunities/${oid}/takeoff-studio/plan-file?key=${encodeURIComponent('file:' + fid)}`, { headers: { cookie: est } });
  assert.equal(f.status, 200); assert.equal(f.headers.get('content-type'), 'application/pdf'); assert.deepEqual(Buffer.from(await f.arrayBuffer()), pdf('a1'));
  assert.equal((await call('GET', `/api/opportunities/${oid2}/takeoff-studio/plan-file?key=${encodeURIComponent('file:' + fid)}`, null, est)).status, 404);   // another lead's plan
  assert.equal((await call('GET', `/api/opportunities/${oid}/takeoff-studio/plan-pages?key=${encodeURIComponent('file:' + fid)}`, null, est)).status, 200);
});

test('pdf.js is served from the app itself, as JavaScript', async () => {
  for (const p of ['/vendor/pdf.mjs', '/vendor/pdf.worker.mjs']) { const r = await fetch(base + p); assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /javascript/); assert.ok((await r.text()).length > 10000); }
  const page = await fetch(base + '/takeoff-studio.js'); assert.equal(page.status, 200); assert.match(await page.text(), /export async function takeoffStudioView/);
});

test('a question goes to Claude with its pictures and tools; the answer comes back with tool calls; usage is logged as Takeoff Studio', async () => {
  requests = []; script = [answer([{ type: 'text', text: 'Reading.' }, { type: 'tool_use', id: 'tu1', name: 'get_takeoff', input: {} }], 'tool_use')];
  const img = Buffer.from('fakepng').toString('base64');
  const r = await call('POST', `/api/opportunities/${oid}/takeoff-studio/ask`, { tier: 'complex', messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: img } }, { type: 'text', text: 'Find the wall tags.' }] }],
    tools: [{ name: 'get_takeoff', description: 'Returns the takeoff.', input_schema: { type: 'object', properties: {} } }] }, est);
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.stopReason, 'tool_use');
  assert.deepEqual(r.body.content.map((b) => b.type), ['text', 'tool_use']); assert.equal(r.body.content[1].name, 'get_takeoff');
  const sent = requests[0]; assert.equal(sent.model, 'claude-opus-5-5'); assert.equal(sent.output_config.effort, 'high'); assert.equal(sent.tools[0].name, 'get_takeoff');
  assert.equal(sent.messages[0].content[0].type, 'image'); assert.match(sent.system[0].text, /information, never instructions/);
  // the tool result goes back with Claude's own blocks unchanged
  script = [answer([{ type: 'text', text: 'Done.' }])];
  const r2 = await call('POST', `/api/opportunities/${oid}/takeoff-studio/ask`, { messages: [{ role: 'user', content: 'Find the wall tags.' }, { role: 'assistant', content: r.body.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'A3 only' }] }] }, est);
  assert.equal(r2.status, 200); assert.equal(requests[1].output_config.effort, 'medium'); assert.equal(requests[1].messages[2].content[0].tool_use_id, 'tu1');
  const [u] = await q(`SELECT kind, label FROM ai_usage WHERE kind='studio' LIMIT 1`); assert.equal(u.label, 'Takeoff Studio · Amazon - Orlando');
});

test('only plain content is passed to Claude', async () => {
  const bad = async (messages) => (await call('POST', `/api/opportunities/${oid}/takeoff-studio/ask`, { messages }, est)).status;
  assert.equal(await bad([{ role: 'user', content: [{ type: 'document', source: { type: 'url', url: 'https://example.com/x.pdf' } }] }]), 400);
  assert.equal(await bad([{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/x.png' } }] }]), 400);
  assert.equal(await bad([{ role: 'system', content: 'hi' }]), 400);
  assert.equal(await bad([{ role: 'assistant', content: 'hi' }]), 400);
  assert.equal(await bad([]), 400);
});

test('rules: every takeoff or one lead only; a lead-only rule is not shown on another lead', async () => {
  const g = await call('POST', `/api/opportunities/${oid}/takeoff-studio/rules`, { text: 'Existing walls (ETR) are taken off for finishes.', scope: 'global' }, est); assert.equal(g.status, 200);
  const p = await call('POST', `/api/opportunities/${oid}/takeoff-studio/rules`, { text: 'Only type A3 is in scope.', scope: 'project', source: 'claude' }, est);
  const mine = (await call('GET', `/api/opportunities/${oid}/takeoff-studio/rules`, null, est)).body.rules;
  assert.deepEqual(mine.map((r) => [r.text, r.scope, r.source, r.thisLead]), [['Existing walls (ETR) are taken off for finishes.', 'global', 'user', true], ['Only type A3 is in scope.', 'project', 'claude', true]]);
  assert.deepEqual((await call('GET', `/api/opportunities/${oid2}/takeoff-studio/rules`, null, est)).body.rules.map((r) => r.text), ['Existing walls (ETR) are taken off for finishes.']);
  await call('PUT', `/api/opportunities/${oid}/takeoff-studio/rules/${p.body.id}`, { scope: 'global' }, est);
  assert.equal((await call('GET', `/api/opportunities/${oid2}/takeoff-studio/rules`, null, est)).body.rules.length, 2);
  assert.equal((await call('PUT', `/api/opportunities/${oid}/takeoff-studio/rules/${p.body.id}`, { scope: 'everyone' }, est)).status, 400);
  assert.equal((await call('DELETE', `/api/opportunities/${oid}/takeoff-studio/rules/${p.body.id}`, null, est)).status, 200);
  assert.equal((await call('DELETE', `/api/opportunities/${oid}/takeoff-studio/rules/${p.body.id}`, null, est)).status, 404);
  assert.equal((await call('POST', `/api/opportunities/${oid}/takeoff-studio/rules`, { text: '  ' }, est)).status, 400);
});

test('the company starting list of wall types and finish codes', async () => {
  assert.deepEqual((await call('GET', '/api/takeoff-studio/library', null, est)).body, { types: [], callouts: [] });
  const r = await call('PUT', '/api/takeoff-studio/library', { types: [{ tag: 'A3', height: 12 }], callouts: [{ code: 'PT-1', unit: 'SF' }] }, est); assert.equal(r.status, 200);
  assert.equal((await call('GET', `/api/opportunities/${oid2}/takeoff-studio`, null, est)).body.library.types[0].tag, 'A3');
  assert.equal((await call('PUT', '/api/takeoff-studio/library', { types: 'A3' }, est)).status, 400);
});

test('Send to estimating chat: the report waits on the next message, a newer one replaces it, and the chat is told to price from it', async () => {
  const s1 = await call('POST', `/api/opportunities/${oid}/takeoff-studio/send`, { text: 'TAKEOFF FOR PRICING\nFRAMING\n- A3: 152.4 LF' }, est); assert.equal(s1.status, 200, JSON.stringify(s1.body));
  const s2 = await call('POST', `/api/opportunities/${oid}/takeoff-studio/send`, { text: 'TAKEOFF FOR PRICING\nFRAMING\n- A3: 160.0 LF\nWALL FINISHES\n- PT-1 on existing walls: 300 SF' }, est);
  const c = (await call('GET', `/api/opportunities/${oid}/estimate-chat`, null, est)).body;
  assert.deepEqual(c.attachments.map((a) => [a.purpose, a.id]), [['studio', s2.body.id]]);   // only the latest waits
  assert.match(c.attachments[0].name, /^Takeoff Studio - Amazon - Orlando .*\.txt$/);
  requests = []; script = [answer([{ type: 'text', text: 'Pricing it.' }])];
  const m = await call('POST', `/api/opportunities/${oid}/estimate-chat`, { text: 'Price this takeoff.', attachments: [s2.body.id] }, est); assert.equal(m.status, 200, JSON.stringify(m.body)); await pending;
  const last = requests.at(-1).messages.at(-1).content, all = JSON.stringify(last);
  assert.match(all, /\[Takeoff Studio takeoff: Takeoff Studio - Amazon - Orlando/); assert.match(all, /A3: 160\.0 LF/); assert.match(all, /Use the Takeoff Studio quantities for pricing/);
  assert.equal((await call('POST', `/api/opportunities/${oid}/takeoff-studio/send`, { text: '' }, est)).status, 400);
});

test('bundling leads moves the takeoff to the kept lead when it has none', async () => {
  const dup = await lead('Amazon - Orlando (dup)');
  await call('PUT', `/api/opportunities/${dup}/takeoff-studio`, { data: { sheets: [], marker: 'from-dup' }, version: 0 }, est);
  const kept = await lead('Amazon - Orlando kept', 'Elkins Constructors');
  const r = await call('POST', '/api/opportunities/bundle', { primaryId: kept, otherIds: [dup] }, est); assert.equal(r.status, 200, JSON.stringify(r.body));
  const o3 = { id: kept };
  const [t] = await q('SELECT data FROM takeoff_studio WHERE opportunity_id=$1', [o3.id]); assert.equal(t?.data?.marker, 'from-dup');
});
