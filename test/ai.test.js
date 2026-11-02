import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
process.env.ANTHROPIC_API_KEY = 'test-key'; delete process.env.ANTHROPIC_WORKSPACE_ID;
const { pool, q } = await import('../server/db.js');
const ai = await import('../server/ai.js');
before(async () => { await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool); });
after(async () => { await pool.end(); });
const TOOL = { name: 'record_thing', description: 'x', input_schema: { type: 'object', properties: { a: { type: 'string' } } } };
const reply = (content, usage = { input_tokens: 10, output_tokens: 5 }) => ({ ok: true, json: async () => ({ content, usage }) });

test('the request works for models that refuse a forced tool choice, and names the workspace when one is set', async () => {
  const seen = [];
  ai.setFetch(async (url, init) => { const b = JSON.parse(init.body); seen.push({ headers: init.headers, body: b });
    if (['tool', 'any'].includes(b.tool_choice?.type)) return { ok: false, status: 400, json: async () => ({ error: { type: 'invalid_request_error', message: 'tool_choice: type "tool" and "any" are not supported for this model.' } }) };
    return reply([{ type: 'tool_use', name: 'record_thing', input: { a: 'ok' } }]); });
  assert.deepEqual(await ai.callClaude({ userId: null, kind: 'receipt', prompt: 'p', tool: TOOL }), { a: 'ok' });
  assert.deepEqual(seen[0].body.tool_choice, { type: 'auto' }); assert.match(seen[0].body.system, /Answer only by calling the record_thing tool/); assert.equal(seen[0].headers['anthropic-workspace-id'], undefined);
  process.env.ANTHROPIC_WORKSPACE_ID = 'wrkspc_123'; await ai.callClaude({ userId: null, kind: 'receipt', prompt: 'p', tool: TOOL }); assert.equal(seen[1].headers['anthropic-workspace-id'], 'wrkspc_123'); delete process.env.ANTHROPIC_WORKSPACE_ID;
});

test('if the model answers in plain text it is asked once more, and both calls are counted', async () => {
  let n = 0; await q('DELETE FROM ai_usage');
  ai.setFetch(async (url, init) => { n++; const b = JSON.parse(init.body);
    if (n === 1) return reply([{ type: 'text', text: 'Here you go: …' }], { input_tokens: 100, output_tokens: 20 });
    assert.equal(b.messages.length, 3); assert.match(b.messages.at(-1).content[0].text, /Call the record_thing tool now/);
    return reply([{ type: 'tool_use', name: 'record_thing', input: { a: 'second try' } }], { input_tokens: 110, output_tokens: 8 }); });
  assert.deepEqual(await ai.callClaude({ userId: null, kind: 'bids', label: '2 email threads', prompt: 'p', tool: TOOL }), { a: 'second try' });
  const [u] = await q('SELECT kind, label, input_tokens, output_tokens FROM ai_usage'); assert.deepEqual([u.kind, u.label, u.input_tokens, u.output_tokens], ['bids', '2 email threads', 210, 28]);
});

test('if it never uses the tool, the person is told to enter the details by hand; a rejection shows what Anthropic said', async () => {
  ai.setFetch(async () => reply([{ type: 'text', text: 'no' }]));
  await assert.rejects(() => ai.callClaude({ userId: null, kind: 'receipt', prompt: 'p', tool: TOOL }), /no readable result/);
  ai.setFetch(async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'Your credit balance is too low' } }) }));
  await assert.rejects(() => ai.callClaude({ userId: null, kind: 'receipt', prompt: 'p', tool: TOOL }), /\(400: Your credit balance is too low\)/);
});
