import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
process.env.ANTHROPIC_API_KEY = 'test-key';
Object.assign(process.env, { MS_TENANT_ID: 't', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 's', MS_SITE_URL: 'https://x.sharepoint.com/sites/Proj' });
const { pool, q } = await import('../server/db.js');
const { server } = await import('../server/index.js');
const { hashPassword } = await import('../server/auth.js');
const ai = await import('../server/ai.js');
const sp = await import('../server/sharepoint.js');
const addr = await import('../server/address.js');

let base, owner, pm, reply, tDemo, tDry, tPaint, gcId, aiDown = false, tool = null;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
const claude = async (url, init) => { tool = JSON.parse(init.body).tools[0].name; return aiDown ? { ok: false, status: 500, json: async () => ({}) } : { ok: true, json: async () => ({ content: [{ type: 'tool_use', name: tool, input: reply }], usage: { input_tokens: 500, output_tokens: 90 } }) }; };
const res = (body, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body, arrayBuffer: async () => (Buffer.isBuffer(body) ? body.buffer.slice(body.byteOffset, body.byteOffset + body.length) : new ArrayBuffer(0)) });
const files = { f1: { id: 'f1', name: 'Signed Subcontract.pdf', size: PDF.length, file: {}, bytes: PDF }, big: { id: 'big', name: 'Huge.pdf', size: 30 * 1024 * 1024, file: {} }, d1: { id: 'd1', name: '2026', folder: {} } };
const graph = async (url, init = {}) => {
  const u = new URL(url), p = decodeURIComponent(u.pathname);
  if (u.hostname === 'login.microsoftonline.com') return res({ access_token: 'tok', expires_in: 3600 });
  if (/^\/v1.0\/sites\/[^/]+:/.test(p)) return res({ id: 'site1' }); if (p === '/v1.0/sites/site1/drives') return res({ value: [{ id: 'dr1', name: 'Documents' }] });
  let m;
  if ((m = p.match(/^\/v1.0\/drives\/dr1\/items\/([^/]+)\/content$/))) return files[m[1]]?.bytes ? res(files[m[1]].bytes) : res({}, 404);
  if ((m = p.match(/^\/v1.0\/drives\/dr1\/items\/([^/]+)\/children$/))) return res({ value: [files.d1, files.f1, { id: 'x', name: 'notes.docx', file: {} }] });
  if (p === '/v1.0/drives/dr1/root/children') return res({ value: [files.d1, files.f1, { id: 'x', name: 'notes.docx', file: {} }, { id: 'pic', name: 'photo.JPG', file: {} }] });
  if ((m = p.match(/^\/v1.0\/drives\/dr1\/items\/([^/]+)$/))) return files[m[1]] ? res(files[m[1]]) : res({}, 404);
  return res({}, 404);
};
const call = async (method, path, body, cookie, raw) => { const r = await fetch(base + path, { method, headers: { ...(body && !raw ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(raw ? { 'x-file-name': raw } : {}) }, body: body ? (raw ? body : JSON.stringify(body)) : undefined }); const t = await r.text(); let b = null; try { b = t ? JSON.parse(t) : null; } catch { b = t; } return { status: r.status, body: b }; };
const login = async (email) => (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct horse battery' }) })).headers.get('set-cookie').split(';')[0];
const census = async (url) => { const u = new URL(url); return { ok: true, json: async () => ({ result: { addressMatches: [{ matchedAddress: 'x', addressComponents: { city: u.searchParams.get('city').toUpperCase(), state: 'FL', zip: u.searchParams.get('zip') } }] } }) }; };
const baseReply = () => ({ documentType: 'Contract', projectName: 'Mall at Millenia - Zara', gcName: 'Sachse Construction, LLC', clientName: 'Zara USA', siteStreet: '4200 Conroy Rd, Suite 120', siteCity: 'Orlando', siteState: 'FL', siteZip: '32839', contractNumber: 'SC-1042', totalAmount: 120000, retainagePercent: 5,
  lines: [{ description: 'Selective demolition', amount: 20000, tradeHint: 'demolition' }, { description: 'Metal stud framing and gypsum board', amount: 85000, tradeHint: 'drywall' }, { description: 'Painting', amount: 15000, tradeHint: 'paint' }], warnings: [] });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  const h = await hashPassword('correct horse battery');
  for (const [e, r] of [['owner@x.net', 'Super Admin'], ['pm@x.net', 'Project Manager']]) await q('INSERT INTO app_users(email,name,role,password_hash) VALUES ($1,$2,$3,$4)', [e, e.split('@')[0], r, h]);
  [tDemo, tDry, tPaint] = (await Promise.all(['Demo', 'Framing & Drywall', 'Paint'].map((n, i) => q('INSERT INTO trades(name,sort) VALUES ($1,$2) RETURNING id', [n, i + 1])))).map((r) => r[0].id);
  [{ id: gcId }] = await q(`INSERT INTO gcs(name) VALUES ('Sachse Construction') RETURNING id`);
  ai.setFetch(claude); sp.setGraphFetch(graph); addr.setAddressFetch(census);
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`; owner = await login('owner@x.net'); pm = await login('pm@x.net');
});
after(async () => { server.close(); await pool.end(); });

test('a document fills the new-project form: name, GC from the list, client, Florida address, retainage, each trade with its amount, and warnings', async () => {
  reply = baseReply(); const r = await call('POST', '/api/projects/draft', PDF, owner, 'Subcontract.pdf'); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(tool, 'record_project_document');
  const d = r.body; assert.deepEqual([d.documentType, d.name, d.gcId, d.client, d.contractNumber, d.total, d.retainagePct], ['Contract', 'Mall at Millenia - Zara', gcId, 'Zara USA', 'SC-1042', 120000, 5]);   // "Sachse Construction, LLC" finds "Sachse Construction"
  assert.deepEqual(d.addr, { street: '4200 Conroy Rd, Suite 120', city: 'Orlando', state: 'FL', zip: '32839' });
  assert.deepEqual(d.lines.map((l) => [l.tradeId, l.amount]), [[tDemo, 20000], [tDry, 85000], [tPaint, 15000]]); assert.deepEqual(d.warnings, []);
  reply = { ...baseReply(), gcName: 'Unknown GC Inc', totalAmount: 130000, siteStreet: '1 Main St, Orlando, FL 32801', siteCity: null, siteZip: null, lines: [...baseReply().lines, { description: 'Mystery scope', amount: null, tradeHint: 'xyz' }] };
  const w = (await call('POST', '/api/projects/draft', PDF, owner, 'Subcontract.pdf')).body; assert.equal(w.gcId, null); assert.equal(w.client, 'Zara USA');
  assert.deepEqual(w.addr, { street: '1 Main St', city: 'Orlando', state: 'FL', zip: '32801' });   // a whole address in the street line is split
  assert.ok(w.warnings.some((x) => /not in the GC list/.test(x)) && w.warnings.some((x) => /add up to 120000.00 but the printed total is 130000.00/.test(x)) && w.warnings.some((x) => /Choose a trade/.test(x)) && w.warnings.some((x) => /no price/.test(x)));
  assert.equal((await call('POST', '/api/projects/draft', PDF, pm, 'Subcontract.pdf')).status, 403);   // office only
  assert.equal((await call('POST', '/api/projects/draft', PDF, owner, 'notes.docx')).status, 400);
  aiDown = true; assert.equal((await call('POST', '/api/projects/draft', PDF, owner, 'Subcontract.pdf')).status, 502); aiDown = false;   // nothing is saved when AI is down: the form just stays manual
  assert.equal((await q('SELECT count(*)::int AS n FROM projects'))[0].n, 0);   // reading a document never creates anything
});

test('the contract file is kept when the project is created, can be replaced and removed; no contract link needed', async () => {
  const a = (await call('POST', '/api/address/verify', { street: '4200 Conroy Rd', city: 'Orlando', state: 'FL', zip: '32839', kind: 'project' }, owner)).body;
  const c = await call('POST', '/api/projects', { name: 'Zara', gcId, client: 'Zara USA', addr: { ...a.address, token: a.token }, retainagePct: 5, trades: [{ tradeId: tDemo, amount: 20000 }] }, owner); assert.equal(c.status, 200);
  const id = c.body.id; assert.equal((await call('GET', `/api/projects/${id}/contract-file`, null, owner)).body.file, null);
  const k = await call('POST', `/api/projects/${id}/contract-file?kind=Contract`, PDF, owner, 'Signed Zara.pdf'); assert.equal(k.status, 200, JSON.stringify(k.body)); assert.equal(k.body.replaced, false);
  const f = (await call('GET', `/api/projects/${id}/contract-file`, null, owner)).body.file; assert.equal(f.name, 'Signed Zara.pdf'); assert.equal(f.kind, 'Contract');
  assert.equal((await call('GET', `/api/projects/${id}`, null, owner)).body.project.contractUrl, f.url);   // the project header links to it
  assert.equal((await fetch(base + f.url, { headers: { cookie: owner } })).status, 200);
  const r2 = await call('POST', `/api/projects/${id}/contract-file?kind=Proposal`, PDF, owner, 'Zara Proposal.pdf'); assert.equal(r2.body.replaced, true);
  assert.equal((await call('GET', `/api/projects/${id}/contract-file`, null, owner)).body.file.name, 'Zara Proposal.pdf');
  assert.equal((await call('POST', `/api/projects/${id}/contract-file`, PDF, pm, 'x.pdf')).status, 403);
  assert.equal((await call('DELETE', `/api/projects/${id}/contract-file`, null, owner)).status, 200); assert.equal((await call('GET', `/api/projects/${id}/contract-file`, null, owner)).body.file, null);
  assert.equal((await call('DELETE', `/api/projects/${id}/contract-file`, null, owner)).status, 200);   // already gone: fine
});

test('a file can come from SharePoint instead: browse folders, read it, keep it', async () => {
  const b = (await call('GET', '/api/sharepoint/browse?id=root', null, owner)).body; assert.deepEqual(b.items.map((i) => i.name), ['2026', 'photo.JPG', 'Signed Subcontract.pdf']);   // folders first; only PDFs and photos are offered
  assert.equal((await call('GET', '/api/sharepoint/browse?id=root', null, pm)).status, 403);
  reply = baseReply(); const d = await call('POST', '/api/projects/draft-sharepoint', { itemId: 'f1' }, owner); assert.equal(d.status, 200, JSON.stringify(d.body)); assert.equal(d.body.fileName, 'Signed Subcontract.pdf'); assert.equal(d.body.lines.length, 3);
  assert.equal((await call('POST', '/api/projects/draft-sharepoint', { itemId: 'big' }, owner)).status, 413); assert.equal((await call('POST', '/api/projects/draft-sharepoint', { itemId: 'd1' }, owner)).status, 400); assert.equal((await call('POST', '/api/projects/draft-sharepoint', { itemId: 'nope' }, owner)).status, 404);
  const pid = (await q('SELECT id FROM projects LIMIT 1'))[0].id; const k = await call('POST', `/api/projects/${pid}/contract-file-sharepoint`, { itemId: 'f1', kind: 'Contract' }, owner); assert.equal(k.status, 200, JSON.stringify(k.body));
  assert.equal((await call('GET', `/api/projects/${pid}/contract-file`, null, owner)).body.file.name, 'Signed Subcontract.pdf');
});
