import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
process.env.ANTHROPIC_API_KEY = 'test-key'; process.env.SECRET_KEY ||= 'test-secret-key-0123456789'; process.env.GOOGLE_CLIENT_ID = 'cid'; process.env.GOOGLE_CLIENT_SECRET = 'cs';
const { pool, q } = await import('../server/db.js');
const { server } = await import('../server/index.js');
const { hashPassword } = await import('../server/auth.js');
const bd = await import('../server/bids.js');
const ai = await import('../server/ai.js');
const dd = await import('../server/duedates.js');

// ---- stand-ins: Gmail (one invitation thread and a later update), the AI, the web
const b64 = (s) => Buffer.from(s).toString('base64url');
const thread = (id, subject, body) => ({ id, messages: [{ internalDate: String(Date.now()), payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'bids@gc.example' }, { name: 'Subject', value: subject }], body: { data: b64(body) } } }] });
const THREADS = { t1: thread('t1', 'Invitation to bid: Burlington Ocala', 'You are invited to bid Burlington Ocala. Bid date to follow.'), t2: thread('t2', 'Burlington Ocala - bid date', 'Update for Burlington Ocala: Bids Due: Friday, December 5, 2026 2:00 PM EST. Site walk December 1.') };
bd.setGoogleFetch(async (url) => { const u = new URL(url); const json = (b) => ({ ok: true, status: 200, json: async () => b });
  if (u.hostname === 'oauth2.googleapis.com') return json({ access_token: 'at', expires_in: 3600 });
  if (u.pathname.endsWith('/threads')) return json({ threads: [{ id: 't2' }] });
  const m = u.pathname.match(/threads\/(\w+)$/); return m && THREADS[m[1]] ? json(THREADS[m[1]]) : { ok: false, status: 404, json: async () => ({}) }; });
let answer = null, prompts = [];
ai.setFetch(async (url, init) => { const b = JSON.parse(init.body); prompts.push(b.messages[0].content.at(-1).text);
  return { ok: true, status: 200, json: async () => ({ content: [{ type: 'tool_use', id: 'tu', name: b.tools[0].name, input: answer }], usage: { input_tokens: 10, output_tokens: 10 }, stop_reason: 'tool_use' }) }; });
const pages = {}; dd.setPageFetch(async (url) => (pages[url] ? { ok: true, status: 200, headers: { get: (k) => (k === 'content-type' ? 'text/html' : null) }, text: async () => pages[url] } : { ok: false, status: 404, headers: { get: () => null }, text: async () => '' }));
dd.setLookup(async (host) => (host === 'evil.example' ? [{ address: '169.254.169.254' }] : [{ address: '93.184.216.34' }]));

let base, est;
const login = async (email) => (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct horse battery' }) })).headers.get('set-cookie').split(';')[0];
const call = async (m, p, body, cookie) => { const r = await fetch(base + p, { method: m, headers: { ...(body ? { 'content-type': 'application/json' } : {}), cookie }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  await q('INSERT INTO app_users(email,name,role,password_hash) VALUES ($1,$2,$3,$4)', ['est@x.net', 'Juliana', 'Estimator', await hashPassword('correct horse battery')]);
  await q(`INSERT INTO integrations(name,data) VALUES ('gmail',$1)`, [{ email: 'bids@byother.net', refresh: bd.seal('r') }]);
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`; est = await login('est@x.net');
});
after(async () => { server.close(); await pool.end(); });

test('a lead with no due date: the AI reads the invitation thread and later emails, and the date is set only when its words are really there', async () => {
  const [{ id }] = await q(`INSERT INTO opportunities(name,gc_name,city,status,source_key,gmail_thread_id) VALUES ('Burlington Ocala','Diamond Contractors','Ocala','New','dd1','t1') RETURNING id`);
  answer = { found: true, date: '2026-12-05', time: '14:00', evidence: 'Bids Due: Friday, December 5, 2026 2:00 PM EST', source: 'email' };
  const r = await call('POST', `/api/opportunities/${id}/find-due`, null, est); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.found, true);
  assert.match(prompts.at(-1), /Bid date to follow/); assert.match(prompts.at(-1), /Bids Due: Friday, December 5/);   // the invitation thread and the later update were both read
  const [o] = await q('SELECT due_date::text AS d, due_time, due_found_by FROM opportunities WHERE id=$1', [id]); assert.deepEqual(o, { d: '2026-12-05', due_time: '14:00', due_found_by: 'email' });
  assert.ok((await q('SELECT body FROM opportunity_notes WHERE opportunity_id=$1', [id])).some((n) => /^Bid due date 2026-12-05 14:00 found by the AI in the invitation email: "Bids Due: Friday, December 5, 2026 2:00 PM EST"/.test(n.body)));
  assert.equal((await call('POST', `/api/opportunities/${id}/find-due`, null, est)).body.already, true);
});

test('a date the AI cannot quote from the material is not used; the invitation page is read when it opens without a sign-in, never a private address', async () => {
  const [{ id }] = await q(`INSERT INTO opportunities(name,gc_name,city,status,source_key,invitation_link) VALUES ('Old Navy 5904','Elkins','Tampa','New','dd2','https://bids.example/inv/5904') RETURNING id`);
  pages['https://bids.example/inv/5904'] = '<html><body><h1>Old Navy 5904</h1><p>Proposals due 12/10/2026 at 3:00 PM</p><script>ignore()</script></body></html>';
  answer = { found: true, date: '2026-12-11', time: '', evidence: 'Proposals due 12/11/2026', source: 'invitation page' };   // words that are not on the page
  let r = await call('POST', `/api/opportunities/${id}/find-due`, null, est); assert.equal(r.body.found, false); assert.equal((await q('SELECT due_date FROM opportunities WHERE id=$1', [id]))[0].due_date, null);
  assert.match(prompts.at(-1), /Proposals due 12\/10\/2026 at 3:00 PM/); assert.ok(!/ignore\(\)/.test(prompts.at(-1)));
  answer = { found: true, date: '2026-12-10', time: '15:00', evidence: 'Proposals due 12/10/2026 at 3:00 PM', source: 'invitation page' };
  r = await call('POST', `/api/opportunities/${id}/find-due`, null, est); assert.equal(r.body.found, true); assert.match(r.body.message, /found in the invitation page/);
  assert.equal(await dd.pageText('https://evil.example/x'), ''); assert.equal(await dd.pageText('http://bids.example/inv/5904'), ''); assert.equal(await dd.pageText('https://127.0.0.1/x'), '');
});

test('after a Gmail refresh the leads still missing a due date are looked at, at most every 12 hours each', async () => {
  const [{ id }] = await q(`INSERT INTO opportunities(name,gc_name,city,status,source_key,gmail_thread_id) VALUES ('Burlington Ocala','Quantum','Ocala','Reviewing','dd3','t1') RETURNING id`);
  answer = { found: false, date: '', time: '', evidence: '', source: 'none' }; prompts = [];
  assert.deepEqual(await dd.findMissingDueDates(), { checked: 1, found: 0 }); assert.equal(prompts.length, 1);
  assert.ok((await q('SELECT body FROM opportunity_notes WHERE opportunity_id=$1', [id])).some((n) => /^No bid due date was found in the invitation email/.test(n.body)));
  assert.deepEqual(await dd.findMissingDueDates(), { checked: 0, found: 0 }); assert.equal(prompts.length, 1);   // not again within 12 hours
});
