import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
process.env.ANTHROPIC_API_KEY = 'test-key';
Object.assign(process.env, { MS_TENANT_ID: 't', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 's', MS_SITE_URL: 'https://byother.sharepoint.com/sites/ByOther' });
const { pool, q } = await import('../server/db.js');
const { server } = await import('../server/index.js');
const { hashPassword } = await import('../server/auth.js');
const SP = await import('../server/sharepoint.js');
const ai = await import('../server/ai.js');
const addr = await import('../server/address.js');
const { sameStreetAddress, addressChecks, addrKey } = await import('../src/lib/compliance.ts');

// ---- a small stand-in for Microsoft Graph
let nodes, seq, down = false;
const reset = () => { nodes = new Map([['root', { id: 'root', name: '', parent: null, folder: true }]]); seq = 0; down = false; };
const pathOf = (n) => (n.parent ? [...pathOf(nodes.get(n.parent)), n.name] : []);
const item = (n) => ({ id: n.id, name: n.name, webUrl: 'https://byother.sharepoint.com/sites/ByOther/Shared Documents/' + pathOf(n).map(encodeURIComponent).join('/'), ...(n.folder ? { folder: {} } : {}) });
const kids = (id) => [...nodes.values()].filter((n) => n.parent === id);
const add = (parent, name, folder = true) => { const n = { id: 'i' + ++seq, name, parent, folder }; nodes.set(n.id, n); return n; };
const res = (body, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body });
const graph = async (url, init = {}) => {
  const u = new URL(url), p = decodeURIComponent(u.pathname), m = init.method || 'GET';
  if (u.hostname === 'login.microsoftonline.com') return res({ access_token: 'tok', expires_in: 3600 });
  if (down) return res({ error: { code: 'serviceNotAvailable' } }, 500);
  const r = p.slice('/v1.0'.length); let g;
  if (/^\/sites\/[^/:]+:/.test(r)) return res({ id: 'site1' }); if (r === '/sites/site1/drives') return res({ value: [{ id: 'drv1', name: 'Documents' }] });
  if ((g = r.match(/^\/drives\/drv1\/(root|items\/([^/]+))\/children$/))) { const id = g[2] || 'root'; if (m === 'GET') return res({ value: kids(id).map(item) }); const b = JSON.parse(init.body); if (kids(id).some((n) => n.name.toLowerCase() === b.name.toLowerCase())) return res({ error: { code: 'nameAlreadyExists' } }, 409); return res(item(add(id, b.name)), 201); }
  if ((g = r.match(/^\/drives\/drv1\/items\/([^/]+)$/)) && m === 'PATCH') { const n = nodes.get(g[1]); if (!n) return res({}, 404); n.name = JSON.parse(init.body).name; return res(item(n)); }
  if ((g = r.match(/^\/drives\/drv1\/items\/([^/]+):\/(.+):\/content$/)) && m === 'PUT') return res(item(add(g[1], g[2], false)), 201);
  return res({ error: { code: 'notFound' } }, 404);
};
const find = (...segs) => { let cur = 'root'; for (const s of segs) { const n = kids(cur).find((x) => x.name === s); if (!n) return null; cur = n.id; } return nodes.get(cur); };

let base, owner, office, pm, w9Read, pid, ptId, ptDemo;
let pdfN = 0; const mkPdf = () => Buffer.from('%PDF-1.4\n% sample ' + (++pdfN) + '\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
const claude = async (url, init) => { const tool = JSON.parse(init.body).tools[0].name; return w9Read === 'down' ? { ok: false, status: 500, json: async () => ({}) } : { ok: true, json: async () => ({ content: [{ type: 'tool_use', name: tool, input: w9Read }], usage: { input_tokens: 100, output_tokens: 30 } }) }; };
async function call(method, path, body, cookie, raw) {
  const r = await fetch(base + path, { method, headers: { ...(body && !raw ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(raw ? { 'x-file-name': raw } : {}) }, body: body ? (raw ? body : JSON.stringify(body)) : undefined });
  const t = await r.text(); let b = null; try { b = t ? JSON.parse(t) : null; } catch { b = t; } return { status: r.status, body: b };
}
const login = async (email) => (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct horse battery' }) })).headers.get('set-cookie').split(';')[0];
const verified = async (street, city, zip) => { const r = (await call('POST', '/api/address/verify', { street, city, state: 'FL', zip, kind: 'other' }, office)).body; assert.equal(r.verified, true); return { ...r.address, token: r.token }; };
const comp = async (id) => (await call('GET', '/api/compliance/vendors', null, office)).body.find((x) => x.id === id);
const w9 = (city = 'Orlando') => ({ documentType: 'W-9', legalName: 'Rivera Framing LLC', businessName: 'Rivera Framing', street: '8001 South Orange Blossom Trail, Suite 606', city, state: 'FL', zip: '32809', warnings: [] });

before(async () => {
  reset(); SP.setGraphFetch(graph); SP.resetCache();
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  const h = await hashPassword('correct horse battery');
  for (const [e, r] of [['owner@x.net', 'Super Admin'], ['office@x.net', 'Exec Assistant'], ['pm@x.net', 'Project Manager']]) await q('INSERT INTO app_users(email,name,role,password_hash) VALUES ($1,$1,$2,$3)', [e, r, h]);
  addr.setAddressFetch(async (url) => { const u = new URL(url); return { ok: true, json: async () => ({ result: { addressMatches: [{ addressComponents: { city: u.searchParams.get('city'), state: u.searchParams.get('state'), zip: u.searchParams.get('zip') } }] } }) }; });
  ai.setFetch(claude); w9Read = w9();
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`; owner = await login('owner@x.net'); office = await login('office@x.net'); pm = await login('pm@x.net');
  const [g] = await q(`INSERT INTO gcs(name) VALUES ('GC') RETURNING id`); const [t] = await q(`INSERT INTO trades(name,sort) VALUES ('Framing',1) RETURNING id`);
  [{ id: pid }] = await q(`INSERT INTO projects(name,gc_id,client,address) VALUES ('Job',$1,'C','A') RETURNING id`, [g.id]); [{ id: ptId }] = await q('INSERT INTO project_trades(project_id,trade_id,original_amount) VALUES ($1,$2,50000) RETURNING id', [pid, t.id]);
});
after(async () => { server.close(); await pool.end(); });

test('the address rules: the same place is recognized through suite numbers and St / Street spellings, a different one is not', () => {
  const a = { street: '8001 South Orange Blossom Trail, Suite 606', city: 'Orlando', state: 'FL', zip: '32809' };
  assert.ok(sameStreetAddress(a, { street: '8001 S Orange Blossom Trl', zip: '32809-1234' }) || sameStreetAddress(a, { street: '8001 S. Orange Blossom Trail Ste 606', zip: '32809' }));
  assert.ok(sameStreetAddress({ street: '123 Main Street', zip: '32801' }, { street: '123 Main St., Apt 4', zip: '32801' }));
  assert.ok(!sameStreetAddress({ street: '123 Main St', zip: '32801' }, { street: '125 Main St', zip: '32801' })); assert.ok(!sameStreetAddress({ street: '123 Main St', zip: '32801' }, { street: '123 Main St', zip: '32802' })); assert.ok(!sameStreetAddress({ street: '123 Main St', zip: '32801' }, { street: '123 Oak St', zip: '32801' }));
  const sub = { street: '1 A St', city: 'X', state: 'FL', zip: '32801', verified: true, confirmedKey: null };
  assert.equal(addressChecks({ ...sub, verified: false }, { street: '1 A St', zip: '32801' }).match, 'None'); assert.equal(addressChecks(sub, null).match, 'Unread'); assert.equal(addressChecks(sub, { street: '1 A St', zip: '32801' }).match, 'Matched');
  assert.equal(addressChecks(sub, { street: '9 B St', zip: '32801' }).match, 'Mismatch'); assert.equal(addressChecks({ ...sub, confirmedKey: addrKey(sub) }, { street: '9 B St', zip: '32801' }).match, 'Confirmed'); assert.equal(addressChecks({ ...sub, street: '2 A St', confirmedKey: addrKey(sub) }, null).match, 'Unread');
});

test('adding a subcontractor from Admin makes its folder in SharePoint: ByOther / Subcontractors / its name; a rename renames the folder', async () => {
  const id = (await call('POST', '/api/admin/subcontractors', { name: 'Rivera Framing, LLC' }, office)).body.id;
  assert.ok(find('ByOther', 'Subcontractors', 'Rivera Framing, LLC')); const row = (await call('GET', '/api/admin/subcontractors', null, office)).body.find((s) => s.id === id); assert.match(row.folder_url, /Subcontractors\/Rivera%20Framing%2C%20LLC/); assert.equal(row.sp_path, 'ByOther/Subcontractors/Rivera Framing, LLC');
  assert.equal(row.verified, false); assert.ok(row.blockers.length >= 2);
  await call('PUT', `/api/admin/subcontractors/${id}`, { name: 'Rivera Framing' }, office); assert.ok(find('ByOther', 'Subcontractors', 'Rivera Framing')); assert.equal(find('ByOther', 'Subcontractors', 'Rivera Framing, LLC'), null);
  down = true; const id2 = (await call('POST', '/api/admin/subcontractors', { name: 'Offline Sub' }, office)).status; down = false; assert.equal(id2, 200);   // a SharePoint outage never loses the record
  const again = (await call('GET', '/api/admin/subcontractors', null, office)).body.find((s) => s.name === 'Offline Sub'); assert.equal(again.folder_url, null);
  assert.equal((await call('POST', `/api/admin/subcontractors/${again.id}/folder`, {}, office)).status, 200); assert.ok(find('ByOther', 'Subcontractors', 'Offline Sub'));   // and the folder can be made afterwards
});

test('W-9 and insurance are uploaded onto the subcontractor, copied into its folder, and the address on the W-9 is read', async () => {
  const id = (await q(`SELECT id FROM subcontractors WHERE name='Rivera Framing'`))[0].id;
  await call('PUT', `/api/admin/subcontractors/${id}`, { addr: await verified('8001 South Orange Blossom Trail, Suite 606', 'Orlando', '32809') }, office);
  const up = await call('POST', `/api/documents/upload?category=W-9&subcontractorId=${id}`, mkPdf(), office, 'rivera-w9.pdf'); assert.equal(up.status, 200, JSON.stringify(up.body)); assert.match(up.body.sharepoint, /Rivera%20Framing/); assert.equal(up.body.read.address.zip, '32809');
  assert.ok(find('ByOther', 'Subcontractors', 'Rivera Framing', 'W-9 - rivera-w9.pdf'));
  const coi = await call('POST', `/api/documents/upload?category=COI&subcontractorId=${id}&expiresOn=2099-01-01`, mkPdf(), office, 'rivera-coi.pdf'); assert.equal(coi.status, 200); assert.ok(find('ByOther', 'Subcontractors', 'Rivera Framing', 'COI - rivera-coi.pdf'));
  const c = await comp(id); assert.deepEqual([c.docsOk, c.addressMatch, c.verified, c.blockers], [true, 'Matched', true, []]); assert.equal(c.addressOnDocs.w9.zip, '32809'); assert.match(c.folderUrl, /Subcontractors/);
  assert.equal((await q('SELECT read_name FROM documents WHERE id=$1', [up.body.id]))[0].read_name, 'Rivera Framing');
});

test('a W-9 and unexpired insurance make a subcontractor verified, whatever address they have; without them it is unverified and cannot be paid, and the message says so', async () => {
  const id = (await q(`SELECT id FROM subcontractors WHERE name='Rivera Framing'`))[0].id;
  const com = (await call('POST', `/api/projects/${pid}/commitments`, { projectTradeId: ptId, subcontractorId: id, contractAmount: 20000 }, office)); assert.equal(com.status, 200, JSON.stringify(com.body));
  const bill = (await call('POST', `/api/projects/${pid}/commitments/${com.body.id}/bills`, { number: '1', date: '2026-11-01', amount: 5000 }, office)).body.id;
  const pay = () => call('POST', `/api/projects/${pid}/sub-bills/${bill}/payments`, { date: '2026-11-02', amount: 100 }, owner);
  assert.equal((await pay()).status, 200);
  // the address on the record changes and no longer matches the W-9: still verified, still payable
  await call('PUT', `/api/admin/subcontractors/${id}`, { addr: await verified('55 Different Rd', 'Tampa', '33602') }, office);
  let c = await comp(id); assert.deepEqual([c.verified, c.addressMatch, c.blockers], [true, 'Mismatch', []]); assert.equal((await pay()).status, 200);
  // no address at all: still verified
  await call('PUT', `/api/admin/subcontractors/${id}`, { addr: {} }, office); assert.equal((await comp(id)).verified, true);
  // insurance that has expired: unverified, and payment is refused with the reason
  await q(`UPDATE documents SET expires_on='2020-01-01' WHERE id=(SELECT coi_document_id FROM subcontractors WHERE id=$1)`, [id]);
  c = await comp(id); assert.deepEqual([c.verified, c.docsOk], [false, false]); const x = await pay(); assert.equal(x.status, 409); assert.match(x.body.error, /Rivera Framing is an unverified subcontractor and cannot be paid: .*expired/);
  assert.ok(JSON.stringify((await call('GET', `/api/projects/${pid}/costs`, null, office)).body).includes('"verified":false'));   // the project's costs view shows it too
  // a new subcontractor with nothing on file
  const none = (await call('POST', '/api/admin/subcontractors', { name: 'Nothing On File' }, office)).body.id; const n = await comp(none); assert.equal(n.verified, false); assert.ok(n.blockers.includes('No W-9 on file'));
  await q(`UPDATE documents SET expires_on='2099-01-01' WHERE id=(SELECT coi_document_id FROM subcontractors WHERE id=$1)`, [id]); assert.equal((await comp(id)).verified, true);   // renewed: verified again with no further step
});

test('the Super Admin can verify a subcontractor by hand (and take it back); nobody else can; the Admin list says who still needs it', async () => {
  const none = (await q(`SELECT id FROM subcontractors WHERE name='Nothing On File'`))[0].id;
  let row = (await call('GET', '/api/admin/subcontractors', null, office)).body.find((r) => r.id === none); assert.deepEqual([row.verified, row.override], [false, false]);   // the Verify button shows for this one
  assert.equal((await call('POST', `/api/admin/subcontractors/${none}/verify`, {}, office)).status, 403); assert.equal((await call('POST', `/api/admin/subcontractors/${none}/verify`, {}, pm)).status, 403);
  assert.equal((await call('POST', `/api/admin/subcontractors/${none}/verify`, {}, owner)).status, 200);
  row = (await call('GET', '/api/admin/subcontractors', null, office)).body.find((r) => r.id === none); assert.deepEqual([row.verified, row.override, row.blockers], [true, true, []]);   // no Verify button any more
  const c = await comp(none); assert.deepEqual([c.verified, c.override, c.canPay], [true, true, true]);
  const com = (await call('POST', `/api/projects/${pid}/commitments`, { projectTradeId: ptId, subcontractorId: none, contractAmount: 1000 }, office)); const bill = (await call('POST', `/api/projects/${pid}/commitments/${com.body.id}/bills`, { number: 'X1', date: '2026-11-01', amount: 500 }, office)).body.id;
  assert.equal((await call('POST', `/api/projects/${pid}/sub-bills/${bill}/payments`, { date: '2026-11-02', amount: 50 }, owner)).status, 200);   // payable
  assert.equal((await call('POST', `/api/admin/subcontractors/${none}/verify`, { override: false }, office)).status, 403);
  assert.equal((await call('POST', `/api/admin/subcontractors/${none}/verify`, { override: false }, owner)).status, 200); assert.equal((await comp(none)).verified, false);
  assert.equal((await call('POST', `/api/projects/${pid}/sub-bills/${bill}/payments`, { date: '2026-11-02', amount: 50 }, owner)).status, 409);
  assert.equal((await call('POST', `/api/admin/subcontractors/00000000-0000-4000-8000-000000000000/verify`, {}, owner)).status, 404);
});
