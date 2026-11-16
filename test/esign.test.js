import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
process.env.PUBLIC_URL = 'https://desk.example.com'; process.env.SECRET_KEY ||= 'test-secret-key-0123456789';
delete process.env.ANTHROPIC_API_KEY; for (const k of ['DOCUSIGN_INTEGRATION_KEY', 'DOCUSIGN_SECRET_KEY', 'DOCUSIGN_ENVIRONMENT']) delete process.env[k];
const { pool, q } = await import('../server/db.js');
const { server } = await import('../server/index.js');
const { hashPassword } = await import('../server/auth.js');
const esign = await import('../server/esign.js');

// ---- a stand-in for DocuSign: the sign-in, one account, envelopes that move through their statuses
let calls = [], envStatus = 'sent', refreshN = 0, envN = 0;
const J = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, arrayBuffer: async () => new Uint8Array(0).buffer });
esign.setDocusignFetch(async (url, init = {}) => {
  const u = new URL(url), m = init.method || 'GET'; calls.push({ m, path: u.pathname, host: u.host, body: init.body, auth: init.headers?.authorization });
  if (u.pathname === '/oauth/token') { const f = new URLSearchParams(init.body); return f.get('grant_type') === 'authorization_code' && f.get('code') !== 'good' ? J({ error: 'invalid_grant' }, 400) : J({ access_token: 'at' + ++refreshN, refresh_token: 'rt' + refreshN, expires_in: 28800 }); }
  if (u.pathname === '/oauth/userinfo') return J({ email: 'owner@byother.net', name: 'Benny', accounts: [{ account_id: 'acc-other', base_uri: 'https://na1.docusign.net', is_default: false }, { account_id: 'acc-1', account_name: 'By Other Construction', base_uri: 'https://demo.docusign.net', is_default: true }] });
  const p = u.pathname.replace('/restapi/v2.1/accounts/acc-1', '');
  if (m === 'POST' && p === '/envelopes') return J({ envelopeId: 'env-' + ++envN, status: 'sent' }, 201);
  if (m === 'GET' && /^\/envelopes\/env-\d+$/.test(p)) return J({ status: envStatus, ...(envStatus === 'completed' ? { completedDateTime: '2026-11-18T15:00:00Z' } : {}) });
  if (m === 'GET' && /\/documents\/combined$/.test(p)) { const b = Buffer.from(`%PDF-1.4\n% signed copy of ${p}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF`); return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) }; }
  if (m === 'PUT' && /^\/envelopes\/env-\d+$/.test(p)) return J({});
  return J({ errorCode: 'NOT_FOUND', message: 'no such thing' }, 404);
});

let base, owner, office, est, pm, pid, docId, wordId;
const call = async (method, path, body, cookie) => { const r = await fetch(base + path, { method, redirect: 'manual', headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); let b = null; try { b = t ? JSON.parse(t) : null; } catch { b = t; } return { status: r.status, body: b, location: r.headers.get('location') }; };
const up = async (path, bytes, name, as) => { const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name), cookie: as }, body: bytes }); return { status: r.status, body: await r.json() }; };
const login = async (email) => (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct horse battery' }) })).headers.get('set-cookie').split(';')[0];
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  const h = await hashPassword('correct horse battery');
  await q(`INSERT INTO app_users(email,name,role,password_hash) VALUES ('owner@x.net','Benny','Super Admin',$1), ('office@x.net','Office','Exec Assistant',$1), ('est@x.net','Est','Estimator',$1), ('pm@x.net','Pat','Project Manager',$1)`, [h]);
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
  owner = await login('owner@x.net'); office = await login('office@x.net'); est = await login('est@x.net'); pm = await login('pm@x.net');
  const [g] = await q(`INSERT INTO gcs(name) VALUES ('GC') RETURNING id`); [{ id: pid }] = await q(`INSERT INTO projects(name,gc_id,client,address) VALUES ('Sign Job',$1,'C','A') RETURNING id`, [g.id]);
  docId = (await up(`/api/documents/upload?category=Contract&projectId=${pid}`, Buffer.from('%PDF-1.4\n% subcontract\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF'), 'Drywall Subcontract.pdf', office)).body.id;
  wordId = (await up(`/api/documents/upload?category=Other&projectId=${pid}`, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('word/document.xml notes')]), 'Notes.docx', office)).body.id;
});
after(async () => { server.close(); await pool.end(); });

test('until the DocuSign keys are on the server it says what is missing, and nothing can be sent', async () => {
  const s = (await call('GET', '/api/docusign/status', null, owner)).body; assert.deepEqual([s.configured, s.connected, s.needs, s.environment], [false, false, ['DOCUSIGN_INTEGRATION_KEY', 'DOCUSIGN_SECRET_KEY'], 'demo']); assert.equal(s.redirectUri, 'https://desk.example.com/api/docusign/callback');
  assert.equal((await call('GET', '/api/docusign/connect', null, owner)).status, 503); assert.equal((await call('GET', '/api/docusign/status', null, office)).status, 403);
  assert.deepEqual((await call('GET', `/api/projects/${pid}/esign`, null, office)).body, { connected: false, envelopes: [] });
  assert.equal((await call('POST', `/api/documents/${docId}/esign`, { signers: [{ name: 'A', email: 'a@x.com' }] }, office)).status, 409);
});

test('the owner connects the account through DocuSign\'s sign-in; a bad or stale answer is refused', async () => {
  Object.assign(process.env, { DOCUSIGN_INTEGRATION_KEY: 'ik-123', DOCUSIGN_SECRET_KEY: 'sk-456' });
  const url = new URL((await call('GET', '/api/docusign/connect', null, owner)).body.url); assert.equal(url.origin + url.pathname, 'https://account-d.docusign.com/oauth/auth');
  assert.deepEqual([url.searchParams.get('client_id'), url.searchParams.get('scope'), url.searchParams.get('response_type'), url.searchParams.get('redirect_uri')], ['ik-123', 'signature', 'code', 'https://desk.example.com/api/docusign/callback']);
  const state = url.searchParams.get('state');
  assert.equal((await call('GET', `/api/docusign/callback?code=good&state=${encodeURIComponent(state)}x`, null, owner)).status, 400); assert.equal((await call('GET', `/api/docusign/callback?code=bad&state=${encodeURIComponent(state)}`, null, owner)).status, 400);
  assert.equal((await call('GET', `/api/docusign/callback?error=access_denied`, null, owner)).status, 400); assert.equal((await call('GET', `/api/docusign/callback?code=good&state=${encodeURIComponent(state)}`, null, office)).status, 403);
  const ok = await call('GET', `/api/docusign/callback?code=good&state=${encodeURIComponent(state)}`, null, owner); assert.deepEqual([ok.status, ok.location], [302, '/#/admin/connections']);
  const s = (await call('GET', '/api/docusign/status', null, owner)).body; assert.deepEqual([s.connected, s.account, s.email, s.connectedEnvironment], [true, 'By Other Construction', 'owner@byother.net', 'demo']);
  const [{ data }] = await q(`SELECT data FROM integrations WHERE name='docusign'`); assert.deepEqual([data.accountId, data.baseUri], ['acc-1', 'https://demo.docusign.net']); assert.ok(!JSON.stringify(data).includes('rt1'), 'the refresh token is stored sealed, not in the clear');
});

test('a project PDF is sent to its signers in order; what is sent is checked first; only office staff and that project\'s manager can send', async () => {
  const send = (b, who = office, id = docId) => call('POST', `/api/documents/${id}/esign`, b, who);
  assert.equal((await send({ signers: [] })).status, 400); assert.match((await send({ signers: [{ name: 'Sam Sub', email: 'not-an-email' }] })).body.error, /Sam Sub needs a valid email/);
  assert.match((await send({ signers: [{ name: 'A', email: 'a@x.com' }, { name: 'B', email: 'A@x.com' }] })).body.error, /different email/); assert.match((await send({ signers: [{ name: 'A', email: 'a@x.com' }] }, office, wordId)).body.error, /Only a PDF/);
  assert.equal((await send({ signers: [{ name: 'A', email: 'a@x.com' }] }, est)).status, 403); assert.equal((await send({ signers: [{ name: 'A', email: 'a@x.com' }] }, pm)).status, 403);   // a manager who is not on this project
  calls = [];
  const r = await send({ signers: [{ name: 'Benny De Jesus', email: 'Benny@byother.net' }, { name: 'Sam Sub', email: 'sam@drywall.example' }], cc: 'office@byother.net', subject: 'Please sign the drywall subcontract', message: 'Thanks' });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.deepEqual([r.body.status, r.body.statusLabel, r.body.open, r.body.signers.map((s) => s.email)], ['sent', 'Sent, not opened yet', true, ['benny@byother.net', 'sam@drywall.example']]);
  const post = calls.find((c) => c.m === 'POST' && c.path.endsWith('/envelopes')), body = JSON.parse(post.body); assert.equal(post.host, 'demo.docusign.net'); assert.match(post.auth, /^Bearer at\d+$/);
  assert.deepEqual([body.status, body.emailSubject, body.emailBlurb, body.documents[0].name, body.documents[0].fileExtension], ['sent', 'Please sign the drywall subcontract', 'Thanks', 'Drywall Subcontract', 'pdf']); assert.match(Buffer.from(body.documents[0].documentBase64, 'base64').toString(), /^%PDF-1\.4\n% subcontract/);
  assert.deepEqual(body.recipients.signers.map((s) => [s.name, s.email, s.routingOrder]), [['Benny De Jesus', 'benny@byother.net', '1'], ['Sam Sub', 'sam@drywall.example', '2']]); assert.deepEqual(body.recipients.carbonCopies.map((c) => [c.email, c.routingOrder]), [['office@byother.net', '3']]);
  assert.equal(body.recipients.signers[0].tabs, undefined);   // no fields prepared: each signer places their own signature
  await q('INSERT INTO project_members(project_id,user_id) VALUES ($1,(SELECT id FROM app_users WHERE email=$2))', [pid, 'pm@x.net']); assert.equal((await call('GET', `/api/projects/${pid}/esign`, null, pm)).body.envelopes.length, 1);
});

test('the request is followed until everyone has signed; then the signed PDF is saved in the project once; an open request can be cancelled', async () => {
  const [e] = (await call('GET', `/api/projects/${pid}/esign`, null, office)).body.envelopes;
  envStatus = 'delivered'; let r = await call('POST', `/api/esign/${e.id}/refresh`, {}, office); assert.deepEqual([r.status, r.body.status, r.body.statusLabel, r.body.signedDocumentId], [200, 'delivered', 'Opened, not signed yet', null]);
  envStatus = 'completed'; r = await call('POST', `/api/esign/${e.id}/refresh`, {}, pm); assert.deepEqual([r.body.status, r.body.open, r.body.completedAt.slice(0, 10)], ['completed', false, '2026-11-18']); assert.ok(r.body.signedDocumentId);
  const docs = (await call('GET', `/api/documents?projectId=${pid}`, null, office)).body, signed = docs.find((d) => d.id === r.body.signedDocumentId); assert.deepEqual([signed.name, signed.category, signed.mime], ['Drywall Subcontract - signed.pdf', 'Contract', 'application/pdf']);
  const again = await call('POST', `/api/esign/${e.id}/refresh`, {}, office); assert.equal(again.body.signedDocumentId, r.body.signedDocumentId); assert.equal((await call('GET', `/api/documents?projectId=${pid}`, null, office)).body.length, docs.length);   // not saved twice
  assert.equal((await call('POST', `/api/esign/${e.id}/cancel`, {}, office)).status, 409);   // already signed
  // a second request, cancelled while it is still out
  envStatus = 'sent'; const two = (await call('POST', `/api/documents/${docId}/esign`, { signers: [{ name: 'Sam Sub', email: 'sam@drywall.example' }] }, office)).body; assert.equal(two.subject, 'Please sign: Drywall Subcontract.pdf');
  calls = []; const c = await call('POST', `/api/esign/${two.id}/cancel`, { reason: 'Wrong amount' }, office); assert.deepEqual([c.status, c.body.status, c.body.statusLabel], [200, 'voided', 'Cancelled']);
  assert.deepEqual(JSON.parse(calls.find((x) => x.m === 'PUT').body), { status: 'voided', voidedReason: 'Wrong amount' });
  // the ones still out are checked on a timer
  const three = (await call('POST', `/api/documents/${docId}/esign`, { signers: [{ name: 'Sam Sub', email: 'sam@drywall.example' }] }, office)).body; envStatus = 'declined';
  assert.equal(await esign.pollOpen(), 1); assert.equal((await call('GET', `/api/projects/${pid}/esign`, null, office)).body.envelopes.find((x) => x.id === three.id).statusLabel, 'Declined by a signer'); assert.equal(await esign.pollOpen(), 0);
});
