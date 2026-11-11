import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
process.env.UPLOAD_DIR = '/tmp/byother-test-uploads';
const { pool, q } = await import('../server/db.js');
const { server } = await import('../server/index.js');
const { hashPassword } = await import('../server/auth.js');
const ai = await import('../server/ai.js');
const { matchProject } = await import('../server/receipts.js');

let base, owner, sub, asst, pm, pid, demo, dry, projectDocId;
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  const h = await hashPassword('correct horse battery');
  for (const [e, r] of [['owner@x.net', 'Super Admin'], ['sub@x.net', 'Sub Admin'], ['asst@x.net', 'Exec Assistant'], ['pm@x.net', 'Project Manager']]) await q('INSERT INTO app_users(email,name,role,password_hash) VALUES ($1,$1,$2,$3)', [e, r, h]);
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });
async function call(method, path, body, cookie) {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text(); return { status: res.status, body: t ? JSON.parse(t) : null };
}
const login = async (email) => { const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct horse battery' }) }); return r.headers.get('set-cookie').split(';')[0]; };
const upload = async (path, bytes, name, cookie) => { const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name), cookie }, body: bytes }); const t = await r.text(); return { status: r.status, body: t ? JSON.parse(t) : null }; };
let pdfN = 0; const mkPdf = () => Buffer.from('%PDF-1.4\n% sample ' + (++pdfN) + '\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');

test('setup', async () => {
  owner = await login('owner@x.net'); sub = await login('sub@x.net'); asst = await login('asst@x.net'); pm = await login('pm@x.net');
  const t1 = (await call('POST', '/api/admin/trades', { name: 'Demolition' }, asst)).body.id, t2 = (await call('POST', '/api/admin/trades', { name: 'Drywall' }, asst)).body.id, gc = (await call('POST', '/api/admin/gcs', { name: 'CW Hayes' }, asst)).body.id;
  pid = (await call('POST', '/api/projects', { name: 'Wingstop - St Cloud, FL', gcId: gc, client: 'C', address: 'A', trades: [{ tradeId: t1, amount: 50000 }, { tradeId: t2, amount: 50000 }] }, asst)).body.id;
  const p = (await call('GET', `/api/projects/${pid}`, null, asst)).body; demo = p.trades.find((t) => t.name === 'Demolition').id; dry = p.trades.find((t) => t.name === 'Drywall').id;
});

test('uploads: type and contents are verified; files are served only to people with access', async () => {
  assert.equal((await upload('/api/documents/upload?category=Contract', Buffer.from('not a pdf at all'), 'contract.pdf', asst)).status, 400);   // wrong contents
  assert.equal((await upload('/api/documents/upload?category=Contract', mkPdf(), 'run.exe', asst)).status, 400);                                         // wrong type
  assert.equal((await upload('/api/documents/upload?category=Contract', Buffer.alloc(0), 'a.pdf', asst)).status, 400);
  assert.equal((await upload('/api/documents/upload?category=Bogus', mkPdf(), 'a.pdf', asst)).status, 400);
  assert.equal((await upload('/api/documents/upload?category=Contract', mkPdf(), 'a.pdf', pm)).status, 403);
  const sent = mkPdf(), ok = await upload(`/api/documents/upload?category=Contract&projectId=${pid}&name=${encodeURIComponent('Signed contract')}`, sent, '../../etc/passwd.pdf', asst);
  assert.equal(ok.status, 200); projectDocId = ok.body.id;
  const f = await fetch(`${base}/api/documents/${projectDocId}/file`, { headers: { cookie: asst } });
  assert.equal(f.status, 200); assert.equal(f.headers.get('content-type'), 'application/pdf'); assert.equal(f.headers.get('x-content-type-options'), 'nosniff'); assert.deepEqual(Buffer.from(await f.arrayBuffer()), sent);
  assert.equal((await fetch(`${base}/api/documents/${projectDocId}/file`, { headers: { cookie: pm } })).status, 403);           // PM not on the project
  assert.equal((await fetch(`${base}/api/documents/${projectDocId}/file`)).status, 401);
  assert.equal((await call('GET', `/api/documents?projectId=${pid}`, null, asst)).body[0].name, 'Signed contract');
  assert.equal((await call('POST', '/api/documents', { category: 'Plans', name: 'Set A', url: 'http://insecure.example/a.pdf', projectId: pid }, asst)).status, 400);
  assert.equal((await call('POST', '/api/documents', { category: 'Plans', name: 'Set A', url: 'https://example.com/a.pdf', projectId: pid }, asst)).status, 200);
});

test('vendor documents can be uploaded straight onto a vendor and unlock payment status', async () => {
  const v = (await call('POST', '/api/admin/subcontractors', { name: 'Atlas' }, asst)).body.id;
  assert.equal((await upload(`/api/documents/upload?category=W-9&subcontractorId=${v}`, mkPdf(), 'w9.pdf', asst)).status, 200);
  assert.equal((await upload(`/api/documents/upload?category=COI&subcontractorId=${v}`, mkPdf(), 'coi.pdf', asst)).status, 400);                    // COI needs an expiry
  assert.equal((await upload(`/api/documents/upload?category=COI&subcontractorId=${v}&expiresOn=2027-12-31`, mkPdf(), 'coi.pdf', asst)).status, 200);
  assert.equal((await upload(`/api/documents/upload?category=Contract&subcontractorId=${v}`, mkPdf(), 'x.pdf', asst)).status, 400);
  const c = (await call('GET', '/api/compliance/vendors', null, asst)).body.find((x) => x.id === v); assert.deepEqual([c.status, c.docsOk, c.canPay, c.docs.COI.file], ['Valid', true, true, true]);   // a W-9 and unexpired insurance make a subcontractor verified (no address needed)
  const w9 = c.docs['W-9'].id;
  assert.equal((await call('DELETE', `/api/documents/${w9}`, null, asst)).status, 200);                                                         // deleting clears the vendor's pointer
  assert.equal((await call('GET', '/api/compliance/vendors', null, asst)).body.find((x) => x.id === v).canPay, false);
});

test('matchProject picks the project named on a receipt, and stays quiet when unsure', () => {
  const ps = [{ id: 'a', name: 'Wingstop - St Cloud, FL' }, { id: 'b', name: 'Banana Republic #6763 - Tampa, FL' }];
  assert.equal(matchProject('JOB: WINGSTOP ST CLOUD', ps), 'a'); assert.equal(matchProject('banana republic tampa', ps), 'b');
  assert.equal(matchProject('cash sale', ps), null); assert.equal(matchProject('', ps), null); assert.equal(matchProject('FL', ps), null);
});

const HD = { merchant: 'The Home Depot', number: '8573 00412 91837', date: '2026-10-28', subtotal: 150, tax: 15, total: 165, paid: true, jobHint: 'JOB NAME: WINGSTOP ST CLOUD', warnings: [],
  lines: [{ description: '5/8 in. x 4 ft. x 8 ft. Drywall', quantity: 20, amount: 100, kind: 'Materials' }, { description: 'Milwaukee Sawzall Blade 9in 5pk', quantity: 1, amount: 50, kind: 'Tools' }] };
const mockClaude = (payload, seen) => async (url, init) => { seen.push({ url, init }); return { ok: true, json: async () => ({ content: [{ type: 'tool_use', name: 'record_receipt', input: payload }], usage: { input_tokens: 1500, output_tokens: 300 } }) }; };

test('receipt parsing without an AI key saves the file and tells the user to enter it by hand', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const r = await upload('/api/receipts/parse', mkPdf(), 'hd.pdf', asst); assert.equal(r.status, 200);
  assert.equal(r.body.parsed, null); assert.match(r.body.aiError, /not connected/i); assert.ok(r.body.documentId);
  assert.equal((await call('GET', '/api/ai/usage', null, asst)).body.connected, false);
});

test('receipt parsing with AI: structured lines, project guess, supplier match, usage logged', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key-not-real'; const seen = []; ai.setFetch(mockClaude(HD, seen));
  await call('POST', '/api/admin/suppliers', { name: 'The Home Depot' }, asst);
  const r = await upload('/api/receipts/parse', mkPdf(), 'hd.pdf', asst); assert.equal(r.status, 200);
  assert.equal(r.body.parsed.merchant, 'The Home Depot'); assert.equal(r.body.parsed.lines.length, 2); assert.deepEqual(r.body.parsed.lines.map((l) => l.kind), ['Materials', 'Tools']);
  assert.equal(r.body.suggestedProjectId, pid); assert.ok(r.body.supplierId); assert.deepEqual(r.body.parsed.warnings, []);
  const sent = JSON.parse(seen[0].init.body);
  assert.deepEqual(sent.tool_choice, { type: 'auto' }); assert.match(sent.system, /Answer only by calling the record_receipt tool/); assert.equal(sent.messages[0].content[0].type, 'document'); assert.equal(seen[0].init.headers['x-api-key'], 'test-key-not-real');
  assert.ok(!JSON.stringify(r.body).includes('test-key-not-real'));
  const u = (await call('GET', '/api/ai/usage', null, asst)).body; assert.deepEqual([u.connected, u.tokens, u.calls], [true, 1800, 1]);
  // totals that do not add up are flagged, never silently fixed
  ai.setFetch(mockClaude({ ...HD, total: 170 }, [])); const w = await upload('/api/receipts/parse', mkPdf(), 'hd2.pdf', asst); assert.match(w.body.parsed.warnings[0], /printed total/);
  // images work too; other types are refused by the reader
  ai.setFetch(mockClaude(HD, [])); assert.equal((await upload('/api/receipts/parse', Buffer.from('a,b\n1,2'), 'x.csv', asst)).body.aiError.includes('PDF, PNG or JPG'), true);
});

test('usage cap: when the monthly budget is used up, reading stops but entry by hand still works', async () => {
  assert.equal((await call('PUT', '/api/settings/ai', { monthlyTokenCap: 1000 }, sub)).status, 403);
  assert.equal((await call('PUT', '/api/settings/ai', { monthlyTokenCap: 1000 }, owner)).status, 200);
  const r = await upload('/api/receipts/parse', mkPdf(), 'hd3.pdf', asst); assert.match(r.body.aiError, /cap/);
  await call('PUT', '/api/settings/ai', { monthlyTokenCap: 2000000 }, owner);
});

test('a Home Depot receipt is split: materials to a project trade, tools to company overhead; tax is shared to the cent', async () => {
  const doc = (await q(`SELECT id FROM documents WHERE category='Receipt' LIMIT 1`))[0].id;
  const body = (o = {}) => ({ supplierName: 'The Home Depot', reference: '8573 00412 91837', date: '2026-10-28', tax: 15, paid: true, documentId: doc, source: 'AI', total: 165,
    lines: [{ description: 'Drywall', amount: 100, itemKind: 'Materials', projectId: pid, projectTradeId: dry }, { description: 'Sawzall blades', amount: 50, itemKind: 'Tools', overheadCategory: 'Tools' }], ...o });
  assert.equal((await call('POST', '/api/receipts', body({ lines: [{ description: 'x', amount: 10, projectId: pid, overheadCategory: 'Tools' }] }), asst)).status, 400);   // both targets
  assert.equal((await call('POST', '/api/receipts', body({ lines: [{ description: 'x', amount: 10 }] }), asst)).status, 400);                                          // neither
  assert.equal((await call('POST', '/api/receipts', body({ total: 170 }), asst)).status, 400);                                                                           // total mismatch
  assert.equal((await call('POST', '/api/receipts', body({ lines: [{ description: 'x', amount: 10, projectId: pid, projectTradeId: '00000000-0000-0000-0000-000000000000' }] }), asst)).status, 400);
  assert.equal((await call('POST', '/api/receipts', body({ lines: [] }), asst)).status, 400);
  assert.equal((await call('POST', '/api/receipts', body(), pm)).status, 403);
  const ok = await call('POST', '/api/receipts', body(), asst); assert.equal(ok.status, 200); assert.equal(ok.body.total, 165);
  assert.equal((await call('POST', '/api/receipts', body(), asst)).status, 409);                                                                                          // same receipt twice
  const costs = (await call('GET', `/api/projects/${pid}/costs`, null, asst)).body.suppliers;
  assert.deepEqual(costs.map((c) => [c.supplier, c.trade, c.amount, c.paid]), [['The Home Depot', 'Drywall', 110, 110]]);                                                  // 100 + 2/3 of the tax
  const p = (await call('GET', `/api/projects/${pid}`, null, asst)).body; assert.equal(p.trades.find((t) => t.name === 'Drywall').actualCost, 110); assert.equal(p.totals.actualCost, 110);
  const list = (await call('GET', '/api/receipts', null, asst)).body; assert.deepEqual([list[0].supplier, list[0].source, list[0].paid, list[0].lines.map((l) => l.overhead || l.trade)], ['The Home Depot', 'AI', 165, ['Drywall', 'Tools']]);
  assert.equal((await q(`SELECT COUNT(*)::int n FROM suppliers WHERE name='The Home Depot'`))[0].n, 1);                                                                    // matched, not duplicated
});

test('no-number receipts still save; unknown suppliers are created once', async () => {
  const r = await call('POST', '/api/receipts', { supplierName: "Lowe's", date: '2026-10-29', lines: [{ description: 'tape', amount: 12.34, itemKind: 'Materials', projectId: pid, projectTradeId: demo }] }, asst); assert.equal(r.status, 200);
  assert.equal((await q(`SELECT reference FROM supplier_invoices WHERE supplier_id=(SELECT id FROM suppliers WHERE name='Lowe''s')`))[0].reference.startsWith('NO-NUMBER-'), true);
  const r2 = await call('POST', '/api/receipts', { supplierName: "lowe's", reference: 'B2', date: '2026-10-29', lines: [{ description: 'tape', amount: 1, projectId: pid }] }, asst); assert.equal(r2.status, 200);
  assert.equal((await q(`SELECT COUNT(*)::int n FROM suppliers WHERE lower(name)='lowe''s'`))[0].n, 1);
});

test('overhead: Super Admin sets it, approvers can see it; 2.5% insurance follows project revenue; profit after overhead', async () => {
  assert.equal((await call('POST', '/api/overhead', { name: 'Insurance', kind: 'percent_of_revenue', value: 2.5 }, sub)).status, 403);
  assert.equal((await call('GET', '/api/overhead', null, asst)).status, 403);
  assert.equal((await call('POST', '/api/overhead', { name: 'Insurance', kind: 'percent_of_revenue', value: 2.5 }, owner)).status, 200);
  assert.equal((await call('POST', '/api/overhead', { name: 'Bad', kind: 'whatever', value: 1 }, owner)).status, 400);
  const o = (await call('GET', '/api/overhead', null, sub)).body;
  assert.equal(o.allocation.total, 2500); assert.equal(o.allocation.byProject[0].overhead, 2500); assert.equal(o.allocation.byProject[0].profitAfterOverhead, o.allocation.byProject[0].projectedProfit - 2500);
  assert.deepEqual(o.actualSpendThisYear, [{ category: 'Tools', amount: 55 }]);                                                                                            // tools bought for the company, with tax
  assert.equal((await call('PUT', '/api/settings/overhead', { basis: 'billed' }, owner)).status, 200);
  assert.equal((await call('GET', '/api/overhead', null, sub)).body.allocation.total, 0);                                                                                   // nothing billed yet
  assert.equal((await call('PUT', '/api/settings/overhead', { basis: 'nope' }, owner)).status, 400);
});
