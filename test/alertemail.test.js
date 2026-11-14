import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
process.env.PUBLIC_URL = 'https://desk.example'; process.env.SECRET_KEY = 'test-secret-key-0123456789';
const { pool, q } = await import('../server/db.js');
const { server } = await import('../server/index.js');
const { hashPassword } = await import('../server/auth.js');
const bd = await import('../server/bids.js');
const cp = await import('../server/compliance.js');

// Google stands in: every email "sent" is kept here as its raw text
let sent = [], gmailDown = false;
const gmail = async (url, opts = {}) => {
  if (String(url).includes('oauth2.googleapis.com/token')) return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
  if (String(url).endsWith('/messages/send')) { if (gmailDown) return { ok: false, status: 500, json: async () => ({}) }; sent.push(Buffer.from(JSON.parse(opts.body).raw, 'base64url').toString()); return { ok: true, json: async () => ({}) }; }
  return { ok: true, json: async () => ({}) };
};
const subjectOf = (raw) => Buffer.from(raw.match(/Subject: =\?UTF-8\?B\?([^?]+)\?=/)[1], 'base64').toString();
const toOf = (raw) => raw.match(/^To: (.+)$/m)[1].trim();
// the email goes out in the background: wait until the outbox has nothing left waiting
const settle = async () => { for (let i = 0; i < 100; i++) { await new Promise((r) => setTimeout(r, 30)); const [{ n }] = await q(`SELECT count(*)::int AS n FROM email_outbox WHERE status='Queued'`); if (!n) { await new Promise((r) => setTimeout(r, 60)); return; } } };

let base, owner, est, pm, ids = {};
const call = async (method, path, body, cookie) => { const r = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); let b = null; try { b = t ? JSON.parse(t) : null; } catch { b = t; } return { status: r.status, body: b }; };
const login = async (email) => (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct horse battery' }) })).headers.get('set-cookie').split(';')[0];
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  const h = await hashPassword('correct horse battery');
  for (const [e, n, r] of [['owner@x.net', 'Benny', 'Super Admin'], ['est@x.net', 'Juliana', 'Estimator'], ['pm@x.net', 'Pat', 'Project Manager']]) ids[e.split('@')[0]] = (await q('INSERT INTO app_users(email,name,role,password_hash) VALUES ($1,$2,$3,$4) RETURNING id', [e, n, r, h]))[0].id;
  bd.setGoogleFetch(gmail); process.env.GOOGLE_CLIENT_ID = 'id'; process.env.GOOGLE_CLIENT_SECRET = 'secret';
  await q(`INSERT INTO integrations(name,data) VALUES ('gmail',$1)`, [{ email: 'office@x.net', refresh: bd.seal('r'), canSend: true }]);
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
  owner = await login('owner@x.net'); est = await login('est@x.net'); pm = await login('pm@x.net');
});
after(async () => { server.close(); await pool.end(); });

let thread;
test('a new message emails everyone it was sent to (not the sender), with the text and a link to open it', async () => {
  const r = await call('POST', '/api/threads', { subject: 'Wingstop bid', body: 'Can you price the drywall today?', memberIds: [ids.est, ids.pm] }, owner); assert.equal(r.status, 200, JSON.stringify(r.body)); thread = r.body.id;
  await settle(); assert.deepEqual(sent.map(toOf).sort(), ['est@x.net', 'pm@x.net']);
  const m = sent.find((x) => toOf(x) === 'est@x.net'); assert.equal(subjectOf(m), 'New message from Benny: Wingstop bid');
  assert.match(m, /Hello Juliana,/); assert.match(m, /Benny sent you a message\./); assert.match(m, /Can you price the drywall today\?/); assert.ok(m.includes(`https://desk.example/#/messages/${thread}`));
});

test('a reply emails the other people in the conversation, once each', async () => {
  sent = []; assert.equal((await call('POST', `/api/threads/${thread}/messages`, { body: 'Yes, by 3pm.' }, est)).status, 200);
  await settle(); assert.deepEqual(sent.map(toOf).sort(), ['owner@x.net', 'pm@x.net']); assert.equal(subjectOf(sent[0]), 'New message from Juliana: Wingstop bid');
  sent = []; await cp.sendQueued(); await cp.sendQueued({ only: 'user_alert' }); assert.equal(sent.length, 0);   // nothing is sent a second time
});

test('a to-do assigned to someone else emails them; a to-do for yourself does not', async () => {
  sent = []; const a = await call('POST', '/api/todos', { title: 'Call the GC about plans', assignedToId: ids.est, priority: 'High', dueDate: '2030-01-15', notes: 'Ask for the BID SET.' }, owner); assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal((await call('POST', '/api/todos', { title: 'My own reminder' }, owner)).status, 200);
  await settle(); assert.equal(sent.length, 1); const m = sent[0];
  assert.equal(toOf(m), 'est@x.net'); assert.equal(subjectOf(m), 'New to-do from Benny: Call the GC about plans');
  assert.match(m, /Benny assigned you a to-do\./); assert.match(m, /Priority: High/); assert.match(m, /Due: 2030-01-15/); assert.match(m, /Ask for the BID SET\./); assert.ok(m.includes('https://desk.example/#/messages/todos'));
  // handing an existing to-do to someone else emails the new person; saving it again does not email them twice
  sent = []; const mine = (await call('POST', '/api/todos', { title: 'Order dumpster' }, owner)).body.id;
  assert.equal((await call('PUT', `/api/todos/${mine}`, { assignedToId: ids.pm }, owner)).status, 200); assert.equal((await call('PUT', `/api/todos/${mine}`, { assignedToId: ids.pm, priority: 'Urgent' }, owner)).status, 200);
  await settle(); assert.deepEqual(sent.map(toOf), ['pm@x.net']); assert.equal(subjectOf(sent[0]), 'To-do assigned to you from Benny: Order dumpster');
});

test('if the email cannot go out the message is still sent, and the email shows as failed in the outbox so it can be retried', async () => {
  sent = []; gmailDown = true; const r = await call('POST', '/api/threads', { subject: 'Down', body: 'x', memberIds: [ids.est] }, owner); assert.equal(r.status, 200);
  await settle(); gmailDown = false; assert.equal(sent.length, 0);
  const [row] = await q(`SELECT id, status, kind FROM email_outbox WHERE subject LIKE '%Down%'`); assert.deepEqual([row.status, row.kind], ['Failed', 'user_alert']);
  assert.ok(!(await call('GET', '/api/outbox', null, owner)).body.emails.some((e) => /Down/.test(e.subject)));   // message subjects are not listed on the Compliance page
  await cp.retryAlerts(); await cp.sendQueued(); assert.deepEqual(sent.map(toOf), ['est@x.net']);   // the regular check tries it again
});

test('emails waiting for vendors are not sent through Gmail: only alerts to our own people are', async () => {
  sent = []; await cp.queueEmail({ to: 'vendor@sub.example', subject: 'Updated certificate needed', body: 'x', kind: 'coi_request', dedupe: 'v1' });
  const r = await cp.sendQueued(); assert.equal(r.sent, 0); assert.equal(sent.length, 0);
  assert.equal((await q(`SELECT status FROM email_outbox WHERE dedupe_key='v1'`))[0].status, 'Queued');
});

test('without Gmail connected nothing breaks: the message goes through and the email waits in the outbox', async () => {
  await q(`DELETE FROM integrations WHERE name='gmail'`); sent = [];
  assert.equal((await call('POST', '/api/threads', { subject: 'No mail', body: 'x', memberIds: [ids.est] }, owner)).status, 200);
  await new Promise((r) => setTimeout(r, 200)); assert.equal(sent.length, 0);
  assert.equal((await q(`SELECT status FROM email_outbox WHERE subject LIKE '%No mail%'`))[0].status, 'Queued');
});
