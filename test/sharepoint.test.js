import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
process.env.ANTHROPIC_API_KEY = 'test-key';
const { pool, q } = await import('../server/db.js');
const { server } = await import('../server/index.js');
const { hashPassword } = await import('../server/auth.js');
const SP = await import('../server/sharepoint.js');
const ai = await import('../server/ai.js');
const addr = await import('../server/address.js');
const folders = await import('../server/folders.js');
const { todayEastern, shift } = await import('../src/lib/estimating.ts');
const today = todayEastern(), YEAR = today.slice(0, 4);

// ---- a small in-memory stand-in for Microsoft Graph: one site, one library, folders and files
let nodes, seq, graphDown, uploads;
const reset = () => { nodes = new Map([['root', { id: 'root', name: '', parent: null, folder: true }]]); seq = 0; graphDown = false; uploads = {}; };
const pathOf = (n) => (n.parent ? [...pathOf(nodes.get(n.parent)), n.name] : []);
const item = (n) => ({ id: n.id, name: n.name, webUrl: 'https://byother.sharepoint.com/sites/ByOther/Shared Documents/' + pathOf(n).map(encodeURIComponent).join('/'), size: n.size ?? 0, lastModifiedDateTime: n.mtime, ...(n.folder ? { folder: {} } : { file: {} }) });
const kids = (id) => [...nodes.values()].filter((n) => n.parent === id);
const T0 = Date.now();
const add = (parent, name, folder = true, extra = {}) => { const n = { id: 'i' + ++seq, name, parent, folder, mtime: new Date(T0 + seq * 1000).toISOString(), ...extra }; nodes.set(n.id, n); return n; };   // each new item is a second newer than the last
const drop = (id) => { for (const k of kids(id)) drop(k.id); nodes.delete(id); };
const res = (body, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body });
const graph = async (url, init = {}) => {
  const u = new URL(url), p = decodeURIComponent(u.pathname + (u.hostname === 'graph.microsoft.com' ? '' : '')), m = init.method || 'GET';
  if (u.hostname === 'login.microsoftonline.com') return res({ access_token: 'tok', expires_in: 3600 });
  if (u.hostname === 'upload.fake') { const part = Buffer.from(init.body), range = init.headers['content-range'].match(/bytes (\d+)-(\d+)\/(\d+)/); uploads[u.pathname] = [...(uploads[u.pathname] || []), part]; const done = Number(range[2]) + 1 === Number(range[3]); if (!done) return res({}, 202); const n = add(uploads.parent[u.pathname], uploads.name[u.pathname], false, { size: Buffer.concat(uploads[u.pathname]).length }); return res(item(n), 201); }
  if (graphDown) return res({ error: { code: 'serviceNotAvailable' } }, 500);
  const base = '/v1.0'; if (!p.startsWith(base)) return res({}, 404); const r = p.slice(base.length);
  let g;
  if ((g = r.match(/^\/sites\/([^/:]+):(.+)$/))) return /^\/sites\/ByOther$/i.test(g[2]) ? res({ id: 'site1' }) : res({}, 404);
  if (r === '/sites') return res({ value: [{ webUrl: 'https://byother.sharepoint.com/sites/ByOther' }, { webUrl: 'https://byother-my.sharepoint.com/personal/x' }] });
  if (r === '/sites/site1/drives') return res({ value: [{ id: 'drv1', name: 'Documents' }] });
  if (r === '/drives/drv1/root') return res({ name: 'Documents', webUrl: 'https://byother.sharepoint.com/sites/ByOther/Shared Documents' });
  if ((g = r.match(/^\/drives\/drv1\/(root|items\/([^/]+))\/children$/))) { const id = g[2] || 'root';
    if (m === 'GET') return res({ value: kids(id).map(item) });
    const b = JSON.parse(init.body); if (kids(id).some((n) => n.name.toLowerCase() === b.name.toLowerCase())) return res({ error: { code: 'nameAlreadyExists' } }, 409); return res(item(add(id, b.name)), 201); }
  if ((g = r.match(/^\/drives\/drv1\/items\/([^/]+):\/(.+):\/children$/)) && m === 'GET') { let cur = nodes.get(g[1]); for (const seg of g[2].split('/')) cur = cur && kids(cur.id).find((n) => n.name === seg); return cur ? res({ value: kids(cur.id).map(item) }) : res({}, 404); }
  if ((g = r.match(/^\/drives\/drv1\/items\/([^/]+)\/copy$/)) && m === 'POST') { const src = nodes.get(g[1]), to = JSON.parse(init.body).parentReference.id; if (!src || !nodes.get(to)) return res({}, 404); if (kids(to).some((n) => n.name.toLowerCase() === src.name.toLowerCase())) return res({ error: { code: 'nameAlreadyExists' } }, 409); const dup = (n, parent) => { const c = add(parent, n.name, n.folder, { size: n.size, bytes: n.bytes }); for (const k of kids(n.id)) dup(k, c.id); }; dup(src, to); return res({}, 202); }
  if ((g = r.match(/^\/drives\/drv1\/items\/([^/]+)$/)) && m === 'DELETE') { if (!nodes.get(g[1])) return res({}, 404); drop(g[1]); return res({}, 204); }
  if ((g = r.match(/^\/drives\/drv1\/items\/([^/]+)$/)) && m === 'PATCH') { const n = nodes.get(g[1]); if (!n) return res({}, 404); n.name = JSON.parse(init.body).name; return res(item(n)); }
  if ((g = r.match(/^\/drives\/drv1\/items\/([^/]+):\/(.+):\/content$/)) && m === 'PUT') { const n = add(g[1], g[2], false, { size: init.body.length, text: Buffer.from(init.body).toString('latin1').slice(0, 20), bytes: init.body.length < 2e6 ? Buffer.from(init.body) : null }); return res(item(n), 201); }
  // reading a file back: its details, then its bytes
  if ((g = r.match(/^\/drives\/drv1\/items\/([^/]+)\/content$/)) && m === 'GET') { const n = nodes.get(g[1]); if (!n?.bytes) return res({}, 404); return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => n.bytes.buffer.slice(n.bytes.byteOffset, n.bytes.byteOffset + n.bytes.length) }; }
  if ((g = r.match(/^\/drives\/drv1\/items\/([^/]+)$/)) && m === 'GET') { const n = nodes.get(g[1]); if (!n) return res({}, 404); return res(item(n)); }
  if ((g = r.match(/^\/drives\/drv1\/items\/([^/]+):\/(.+):\/createUploadSession$/))) { const key = '/' + (++seq); uploads.parent = { ...(uploads.parent || {}), [key]: g[1] }; uploads.name = { ...(uploads.name || {}), [key]: g[2] }; return res({ uploadUrl: 'https://upload.fake' + key }); }
  return res({ error: { code: 'notFound' } }, 404);
};
const tree = () => { const out = []; const walk = (id, depth) => { for (const n of kids(id).sort((a, b) => a.name.localeCompare(b.name))) { out.push('  '.repeat(depth) + n.name + (n.folder ? '/' : '')); if (n.folder) walk(n.id, depth + 1); } }; walk('root', 0); return out; };
const find = (...segs) => { let cur = 'root'; for (const s of segs) { const n = kids(cur).find((x) => x.name === s); if (!n) return null; cur = n.id; } return nodes.get(cur); };

let base, owner, est, pm, estId, tDemo;
const addrOk = async (street, city, zip) => { const r = (await call('POST', '/api/address/verify', { street, city, state: 'FL', zip, kind: 'project' }, est)).body; return { ...r.address, token: r.token }; };
before(async () => {
  reset(); SP.setGraphFetch(graph); SP.resetCache();
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  const h = await hashPassword('correct horse battery');
  for (const [e, r] of [['owner@x.net', 'Super Admin'], ['est@x.net', 'Estimator'], ['pm@x.net', 'Project Manager']]) await q('INSERT INTO app_users(email,name,role,password_hash) VALUES ($1,$2,$3,$4)', [e, e.split('@')[0], r, h]);
  addr.setAddressFetch(async (url) => { const u = new URL(url), c = (k) => u.searchParams.get(k); return { ok: true, json: async () => ({ result: { addressMatches: [{ addressComponents: { city: c('city'), state: c('state'), zip: c('zip') } }] } }) }; });
  ai.setFetch(async () => ({ ok: true, json: async () => ({ content: [{ type: 'tool_use', name: 'record_proposal', input: { trades: [{ trade: 'Demolition', amount: 5000 }], total: 5000, warnings: [] } }], usage: { input_tokens: 10, output_tokens: 5 } }) }));
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });
async function call(method, path, body, cookie, raw) {
  const r = await fetch(base + path, { method, headers: { ...(body && !raw ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(raw ? { 'x-file-name': raw } : {}) }, body: body ? (raw ? body : JSON.stringify(body)) : undefined });
  const t = await r.text(); let b = null; try { b = t ? JSON.parse(t) : null; } catch { b = t; } return { status: r.status, body: b };
}
const login = async (email) => { const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct horse battery' }) }); return r.headers.get('set-cookie').split(';')[0]; };
const mk = async (o = {}) => (await call('POST', '/api/opportunities', { name: 'Wingstop', client: 'Wingstop', gc: 'CW Hayes Construction', addr: await addrOk('1200 13th St', 'St Cloud', '34769'), sourceType: 'PlanHub', estimatorId: estId, due: shift(today, 7), type: 'Restaurant', ...o }, est)).body.id;
const opp = async (id) => (await call('GET', `/api/opportunities/${id}`, null, est)).body;
let pdfN = 0; const mkPdf = () => Buffer.from('%PDF-1.4\n% sample ' + (++pdfN) + '\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');

test('without Microsoft settings nothing breaks, and the folder button explains what is missing', async () => {
  owner = await login('owner@x.net'); est = await login('est@x.net'); pm = await login('pm@x.net'); estId = (await q(`SELECT id FROM app_users WHERE email='est@x.net'`))[0].id;
  tDemo = (await call('POST', '/api/admin/trades', { name: 'Demolition' }, owner)).body.id;
  const a = await mk({ name: 'Early lead' }); assert.equal((await call('POST', `/api/opportunities/${a}/status`, { status: 'Accepted' }, est)).status, 200);   // accepting works without SharePoint
  const f = await call('POST', `/api/opportunities/${a}/folder`, {}, est); assert.equal(f.status, 503); assert.match(f.body.error, /SharePoint is not connected/);
  assert.deepEqual((await call('GET', '/api/sharepoint/status', null, est)).body, { configured: false });
  Object.assign(process.env, { MS_TENANT_ID: 't', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 's', MS_SITE_URL: 'https://byother.sharepoint.com/sites/ByOther' }); SP.resetCache();
});

test('status check: anyone on the team sees whether it is set up; only the owner can run the live test', async () => {
  assert.deepEqual((await call('GET', '/api/sharepoint/status', null, est)).body, { configured: true });
  assert.equal((await call('GET', '/api/sharepoint/status', null, pm)).status, 403);
  const t = (await call('GET', '/api/sharepoint/status?test=1', null, owner)).body; assert.deepEqual([t.configured, t.connected, t.library, t.root], [true, true, 'Documents', 'ByOther']);
  graphDown = true; SP.resetCache(); const bad = (await call('GET', '/api/sharepoint/status?test=1', null, owner)).body; assert.equal(bad.connected, false); assert.match(bad.error, /SharePoint answered with an error/); graphDown = false; SP.resetCache();
});

test('a messy or wrong MS_SITE_URL is cleaned up, or explained with the sites the app can see', async () => {
  assert.deepEqual(SP.siteParts('https://byother.sharepoint.com/sites/ByOther/Shared%20Documents/Forms/AllItems.aspx?id=%2Fx'), { host: 'byother.sharepoint.com', path: '/sites/ByOther', personal: false });
  assert.deepEqual(SP.siteParts('https://byothercon.sharepoint.com/:u:/r/sites/ByOtherProjects/SitePages/CollabHome.aspx?d=w8&csf=1&web=2&share=abc&e=o9'), { host: 'byothercon.sharepoint.com', path: '/sites/ByOtherProjects', personal: false });   // a pasted share link
  assert.deepEqual(SP.siteParts('byother.sharepoint.com'), { host: 'byother.sharepoint.com', path: '', personal: false }); assert.equal(SP.siteParts('https://x-my.sharepoint.com/personal/a_b').personal, true); assert.equal(SP.siteParts('not a url at all'), null);
  const check = async (url) => { process.env.MS_SITE_URL = url; SP.resetCache(); return (await call('GET', '/api/sharepoint/status?test=1', null, owner)).body; };
  assert.equal((await check('https://byother.sharepoint.com/sites/ByOther/Shared%20Documents/Forms/AllItems.aspx?id=%2Fsites%2FByOther')).connected, true);
  const wrong = await check('https://byother.sharepoint.com/sites/Wrong'); assert.equal(wrong.connected, false);
  assert.match(wrong.error, /no site at byother\.sharepoint\.com\/sites\/Wrong/); assert.match(wrong.error, /Sites this app can see: https:\/\/byother\.sharepoint\.com\/sites\/ByOther\./); assert.doesNotMatch(wrong.error, /-my\./);
  assert.match((await check('https://byother-my.sharepoint.com/personal/ben_byother_net')).error, /personal OneDrive/);
  assert.match((await check('hello world')).error, /is not a web address/);
  await check('https://byother.sharepoint.com/sites/ByOther'); SP.resetCache();
});

test('accepting creates ByOther / year / GC / P-code folder with the numbered sub-folders, and links it', async () => {
  const id = await mk(); const r = await call('POST', `/api/opportunities/${id}/status`, { status: 'Accepted' }, est); assert.equal(r.status, 200);
  const o = await opp(id); const pid = o.proposalId, name = `${pid}_Wingstop_St Cloud`;
  assert.ok(pid.startsWith('P'), pid); assert.equal(o.spPath, `ByOther/${YEAR}/CW Hayes Construction/${name}`); assert.match(o.folderUrl, /^https:\/\/byother\.sharepoint\.com\//); assert.equal(r.body.folderUrl, o.folderUrl);
  assert.deepEqual(kids(find('ByOther', YEAR, 'CW Hayes Construction', name).id).map((n) => n.name).sort(), ['01. DL', '02. Proposal', '03. Change Orders', '04. Documents', '05. Material & Equipment Specs']);
  assert.ok(o.notes.some((n) => /Created the SharePoint folder ByOther \/ \d{4} \/ CW Hayes Construction/.test(n.body)));
  assert.equal((await call('POST', `/api/opportunities/${id}/folder`, {}, est)).status, 200); assert.equal(kids(find('ByOther', YEAR, 'CW Hayes Construction').id).length, 1);   // pressing it again changes nothing
});

test('an existing GC folder (any capitalisation) and a hand-made project folder are reused, never duplicated', async () => {
  const gc = add(find('ByOther', YEAR).id, 'Epic Construction Services, LLC'); const hand = add(gc.id, 'Dollar Tree - 11636_Palm Bay');
  const id = await mk({ name: 'Dollar Tree - 11636', gc: 'EPIC construction services LLC', addr: await addrOk('5 Main St', 'Palm Bay', '32905') });
  await call('POST', `/api/opportunities/${id}/status`, { status: 'Accepted' }, est); const o = await opp(id);
  assert.equal(kids(find('ByOther', YEAR).id).filter((n) => /epic/i.test(n.name)).length, 1); assert.equal(o.spPath, `ByOther/${YEAR}/Epic Construction Services, LLC/Dollar Tree - 11636_Palm Bay`);
  assert.equal(kids(gc.id).length, 1); assert.equal(kids(hand.id).length, 5);                                                         // the old folder got the numbered sub-folders it lacked
  assert.ok((await opp(id)).notes.some((n) => /Linked the existing SharePoint folder/.test(n.body)));
});

test('Reviewing makes the folder before there is a P number; Accepting renames that same folder', async () => {
  const id = await mk({ name: 'Old Navy Refresh', gc: 'Weekes Construction', addr: await addrOk('9 Plaza Dr', 'Tampa', '33625') });
  await call('POST', `/api/opportunities/${id}/status`, { status: 'Reviewing' }, est); let o = await opp(id); assert.equal(o.proposalId, null); assert.equal(o.spPath, `ByOther/${YEAR}/Weekes Construction/Old Navy Refresh_Tampa`);
  const itemId = (await q('SELECT sp_item_id FROM opportunities WHERE id=$1', [id]))[0].sp_item_id;
  await call('POST', `/api/opportunities/${id}/status`, { status: 'Accepted' }, est); o = await opp(id);
  assert.equal((await q('SELECT sp_item_id FROM opportunities WHERE id=$1', [id]))[0].sp_item_id, itemId); assert.equal(o.spPath, `ByOther/${YEAR}/Weekes Construction/${o.proposalId}_Old Navy Refresh_Tampa`);
  assert.equal(kids(find('ByOther', YEAR, 'Weekes Construction').id).length, 1); assert.ok(o.notes.some((n) => /SharePoint folder renamed to P\d+_Old Navy Refresh_Tampa/.test(n.body)));
});

let wing, wingCode;
test('the proposal PDF is saved in the app and copied into 02. Proposal; a SharePoint outage only adds a note', async () => {
  wing = await mk({ name: 'Wingstop 2', gc: 'Hayes GC', addr: await addrOk('7 Elm St', 'Orlando', '32801'), due: shift(today, 9) }); await call('POST', `/api/opportunities/${wing}/status`, { status: 'Accepted' }, est);
  const up = await call('POST', `/api/opportunities/${wing}/files?kind=Proposal`, mkPdf(), est, 'Proposal v1.pdf'); assert.deepEqual([up.status, up.body.sharepoint], [200, true]);
  const o = await opp(wing); wingCode = o.proposalId; const folder = find('ByOther', YEAR, 'Hayes GC', `${wingCode}_Wingstop 2_Orlando`); const f = find('ByOther', YEAR, 'Hayes GC', `${wingCode}_Wingstop 2_Orlando`, '02. Proposal', 'Proposal v1.pdf'); assert.ok(folder && f); assert.equal(f.size, mkPdf().length);
  assert.ok((await q('SELECT sp_url FROM opportunity_files WHERE opportunity_id=$1', [wing]))[0].sp_url.startsWith('https://byother.sharepoint.com/'));
  graphDown = true; const down = await call('POST', `/api/opportunities/${wing}/files?kind=Submittal`, mkPdf(), est, 'notes.pdf'); graphDown = false;
  assert.deepEqual([down.status, down.body.sharepoint], [200, false]); assert.equal((await opp(wing)).files.length, 2); assert.ok((await opp(wing)).notes.some((n) => /Saved in the app, but not copied to SharePoint/.test(n.body)));
  const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(9 * 1024 * 1024, 65)]);                                              // a large file goes up in pieces
  assert.equal((await call('POST', `/api/opportunities/${wing}/files?kind=Submittal`, big, est, 'Big plans.pdf')).body.sharepoint, true); assert.equal(find('ByOther', YEAR, 'Hayes GC', `${wingCode}_Wingstop 2_Orlando`, '02. Proposal', 'Big plans.pdf').size, big.length);
});

test('awarding turns P into C on the folder and the project; later documents carry the C code and land in the right folder', async () => {
  const f = (await call('POST', `/api/opportunities/${wing}/files?kind=Proposal`, mkPdf(), est, 'Final.pdf')).body.fileId;
  assert.equal((await call('POST', `/api/opportunities/${wing}/submissions`, { fileId: f, date: today, method: 'Email', prices: [{ tradeId: tDemo, amount: 5000 }] }, est)).status, 200);
  const r = await call('POST', `/api/opportunities/${wing}/status`, { status: 'Awarded' }, est); assert.equal(r.status, 200); const code = 'C' + wingCode.slice(1);
  assert.equal(r.body.refCode, code); assert.match(r.body.folderUrl, /byother\.sharepoint\.com/);
  assert.ok(find('ByOther', YEAR, 'Hayes GC', `${code}_Wingstop 2_Orlando`)); assert.equal(find('ByOther', YEAR, 'Hayes GC', `${wingCode}_Wingstop 2_Orlando`), null);
  const p = (await call('GET', `/api/projects/${r.body.projectId}`, null, owner)).body.project; assert.deepEqual([p.refCode, p.proposalId, p.spPath], [code, wingCode, `ByOther/${YEAR}/Hayes GC/${code}_Wingstop 2_Orlando`]); assert.match(p.folderUrl, /byother\.sharepoint\.com/);
  assert.ok((await opp(wing)).notes.some((n) => /renamed to C\d+.*P became C/.test(n.body)));
  // documents added to the project from now on: named with the contract code, filed by kind
  const doc = async (category, name) => call('POST', `/api/documents/upload?category=${encodeURIComponent(category)}&projectId=${r.body.projectId}`, mkPdf(), owner, name);
  assert.equal((await doc('Contract', 'Subcontract.pdf')).status, 200); assert.equal((await doc('Approved CO', 'CO 1.pdf')).status, 200); assert.equal((await doc('Plans', 'A1.pdf')).status, 200);
  const root = ['ByOther', YEAR, 'Hayes GC', `${code}_Wingstop 2_Orlando`];
  assert.ok(find(...root, '04. Documents', `${code} - Subcontract.pdf`)); assert.ok(find(...root, '03. Change Orders', `${code} - CO 1.pdf`)); assert.ok(find(...root, '01. DL', `${code} - A1.pdf`));
  assert.equal((await q(`SELECT ref_code FROM documents WHERE name='Subcontract.pdf'`))[0].ref_code, code);
});

test('a project that did not come from an estimate gets its own folder on request', async () => {
  const gc = (await call('POST', '/api/admin/gcs', { name: 'Direct GC' }, owner)).body.id;
  const pid = (await call('POST', '/api/projects', { name: 'Direct job', gcId: gc, client: 'C', address: 'A', trades: [{ tradeId: tDemo, amount: 1000 }] }, owner)).body.id;
  const f = await call('POST', `/api/projects/${pid}/folder`, {}, owner); assert.equal(f.status, 200); assert.ok(find('ByOther', YEAR, 'Direct GC', 'Direct job')); assert.equal((await call('POST', `/api/projects/${pid}/folder`, {}, pm)).status, 403);
});

test('the GC list fills itself from the GC folders already in the year folder: new ones only, nothing removed, run again and nothing changes', async () => {
  const year = find('ByOther', YEAR).id;
  for (const n of ['Sachse Construction', 'axxys construction group', 'S.A Casey Construction, Inc', '_old stuff', '00. Proposal Kit', '05. Administration', '2026 Regions Bank Docs']) add(year, n);
  await q(`INSERT INTO gcs(name) VALUES ('Axxys Construction Group')`); await q(`INSERT INTO gcs(name, archived) VALUES ('Archived GC', true)`);
  const before = (await q('SELECT count(*)::int n FROM gcs'))[0].n; const r = await folders.syncGcs();
  const names = (await q('SELECT name, archived FROM gcs ORDER BY name')).map((g) => g.name);
  assert.ok(names.includes('Sachse Construction') && names.includes('S.A Casey Construction, Inc')); assert.ok(!names.includes('axxys construction group'));   // same GC, different capitalisation: not added twice
  assert.ok(!names.includes('_old stuff') && !names.includes('00. Proposal Kit') && !names.includes('05. Administration') && !names.includes('2026 Regions Bank Docs'));   // office folders are not GCs
   assert.equal((await q(`SELECT archived FROM gcs WHERE name='Archived GC'`))[0].archived, true);              // nothing re-activated or removed
  assert.ok(r.added >= 2); const after = (await q('SELECT count(*)::int n FROM gcs'))[0].n; assert.equal(after, before + r.added);
  assert.deepEqual(await folders.syncGcs(), { added: 0, found: r.found });                                                                              // run again: nothing new
  const known = (await call('GET', '/api/gcs/known', null, est)).body.map((g) => g.name); assert.ok(known.includes('Sachse Construction'));             // and the opportunity form's GC list offers them
});

test('Upload plans: a zip is streamed to disk, filed with the opportunity, copied to 01. DL in the background, and the local copy is then removed', async () => {
  const id = await mk({ name: 'Plans job', gc: 'Plans GC', addr: await addrOk('11 Plan St', 'Orlando', '32801') }); await call('POST', `/api/opportunities/${id}/status`, { status: 'Accepted' }, est);
  const zip = (mb) => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(mb * 1024 * 1024, 7)]); const up = (b, name, who = est) => call('POST', `/api/opportunities/${id}/plans`, b, who, name);
  assert.equal((await up(Buffer.from('MZ not a zip'), 'plans.zip')).status, 400); assert.equal((await up(zip(0), 'plans.exe')).status, 400); assert.equal((await up(zip(0), 'plans.zip', pm)).status, 403); assert.equal((await up(Buffer.alloc(0), 'plans.zip')).status, 400);
  const big = zip(9); const r = await up(big, 'Plans Set.zip'); assert.deepEqual([r.status, r.body.size, r.body.sharepoint], [200, big.length, true]);
  const o0 = await opp(id); assert.equal(o0.files[0].kind, 'Plans');
  // the copy runs after the answer: first the local file is released, then the "copied" note is written, so wait for both
  for (let i = 0; i < 200 && !((await q('SELECT storage_key FROM opportunity_files WHERE opportunity_id=$1', [id]))[0].storage_key === null && (await q(`SELECT 1 FROM opportunity_notes WHERE opportunity_id=$1 AND body LIKE '%copied to the 01. DL folder%'`, [id])).length); i++) await new Promise((ok) => setTimeout(ok, 50));
  const row = (await q('SELECT storage_key, sp_url FROM opportunity_files WHERE opportunity_id=$1', [id]))[0]; assert.equal(row.storage_key, null); assert.match(row.sp_url, /byother\.sharepoint\.com/);
  const o = await opp(id); const code = o.proposalId; const f = find('ByOther', YEAR, 'Plans GC', `${code}_Plans job_Orlando`, '01. DL', 'Plans Set.zip'); assert.ok(f); assert.equal(f.size, big.length);   // came up in pieces
  assert.deepEqual([o.files[0].local, !!o.files[0].spUrl], [false, true]); const nb = o.notes.map((n) => n.body); assert.ok(nb.some((b) => /Plans "Plans Set\.zip" \(9\.0 MB\) uploaded by est\. Copying/.test(b))); assert.ok(nb.some((b) => /Plans "Plans Set\.zip" copied to the 01\. DL folder/.test(b)));
  const dl = await fetch(`${base}/api/opportunity-files/${o.files[0].id}`, { headers: { cookie: est } }); assert.equal(dl.status, 404);                                       // the open link for such a file is its SharePoint link
  // when SharePoint is down the app keeps its own copy, and says so
  graphDown = true; const r2 = await up(zip(1), 'More plans.zip'); assert.equal(r2.status, 200); await new Promise((ok) => setTimeout(ok, 400)); graphDown = false;
  const kept = (await q(`SELECT storage_key FROM opportunity_files WHERE name='More plans.zip'`))[0]; assert.ok(kept.storage_key); assert.ok((await opp(id)).notes.some((n) => /Saved in the app, but not copied to SharePoint/.test(n.body)));
  const dl2 = await fetch(`${base}/api/opportunity-files/${(await opp(id)).files.find((x) => x.name === 'More plans.zip').id}`, { headers: { cookie: est } }); assert.equal(dl2.status, 200); assert.equal(dl2.headers.get('content-type'), 'application/zip');
});

test('a job bundled under several GCs has a folder under each GC once it is Accepted; plans go into all of them, each GC keeps its own proposal, and the GC that awards it gets the C folder', async () => {
  const addrB = await addrOk('55 Orange Ave', 'Orlando', '32801');
  const a = await mk({ name: 'Bundle Store', gc: 'GC Alpha', addr: addrB, due: shift(today, 9) }), b = await mk({ name: 'Bundle Store - Orlando', gc: 'GC Beta', addr: await addrOk('55 Orange Ave', 'Orlando', '32801'), due: shift(today, 9) });
  // bundled while still New: no folder anywhere; Accepting makes one under each GC
  assert.equal((await call('POST', '/api/opportunities/bundle', { primaryId: a, otherIds: [b] }, est)).status, 200); assert.equal(find('ByOther', YEAR, 'GC Alpha'), null); assert.equal(find('ByOther', YEAR, 'GC Beta'), null);
  assert.equal((await call('POST', `/api/opportunities/${a}/status`, { status: 'Accepted' }, est)).status, 200); const code = (await opp(a)).proposalId, dir = `${code}_Bundle Store_Orlando`, A = ['ByOther', YEAR, 'GC Alpha', dir], B = ['ByOther', YEAR, 'GC Beta', dir];
  assert.ok(find(...A, '02. Proposal')); assert.ok(find(...B, '02. Proposal'), 'the same folder exists under the second GC'); assert.ok((await opp(a)).notes.some((n) => /SharePoint folder for GC Beta/.test(n.body)));
  // plans: uploaded in the app they go into both folders; dropped into the main folder by hand they are copied across by the sync
  assert.equal((await call('POST', `/api/opportunities/${a}/plans`, mkPdf(), est, 'BID SET.pdf')).status, 200);
  for (let i = 0; i < 200 && !find(...B, '01. DL', 'BID SET.pdf'); i++) await new Promise((ok) => setTimeout(ok, 50));
  assert.ok(find(...A, '01. DL', 'BID SET.pdf')); assert.ok(find(...B, '01. DL', 'BID SET.pdf'));
  add(find(...A, '01. DL').id, 'Addendum 1.pdf', false, { size: 4 }); const specs = add(find(...A, '01. DL').id, 'Specs'); add(specs.id, 'Div 09.pdf', false, { size: 6 });
  let v = await syncNow(a); assert.equal(v.sync.plansCopied, 2); assert.ok(find(...B, '01. DL', 'Addendum 1.pdf')); assert.ok(find(...B, '01. DL', 'Specs', 'Div 09.pdf')); assert.ok((await opp(a)).notes.some((n) => /Plans copied to the GC Beta folder: Addendum 1\.pdf, Specs/.test(n.body)));
  // a proposal belongs to one GC: the lead's own goes into the main GC's folder only
  const up = await call('POST', `/api/opportunities/${a}/files?kind=Proposal`, mkPdf(), est, 'Bundle proposal.pdf'); assert.equal(up.status, 200);
  assert.ok(find(...A, '02. Proposal', 'Bundle proposal.pdf')); assert.equal(find(...B, '02. Proposal', 'Bundle proposal.pdf'), null);
  // one made for the other GC goes into that GC's folder only, and is listed under that GC
  const upB = await call('POST', `/api/opportunities/${a}/files?kind=Proposal&gc=${encodeURIComponent('gc beta')}`, mkPdf(), est, 'Beta price.pdf'); assert.deepEqual([upB.status, upB.body.sharepoint], [200, true]);
  assert.ok(find(...B, '02. Proposal', 'Beta price.pdf')); assert.equal(find(...A, '02. Proposal', 'Beta price.pdf'), null);
  assert.equal((await call('POST', `/api/opportunities/${a}/files?kind=Proposal&gc=Nobody`, mkPdf(), est, 'x.pdf')).status, 400);
  add(find(...B, '02. Proposal').id, 'Beta price edited.docx', false, { size: 3 });   // and its Word file, saved there by hand
  drop(find(...B, '01. DL', 'Addendum 1.pdf').id);   // taken out of the second GC's folder by hand: it is not copied there again
  v = await syncNow(a); assert.deepEqual([v.sync.pushed, v.sync.plansCopied, v.sync.failed], [0, 0, []]); assert.equal(find(...A, '02. Proposal', 'Beta price.pdf'), null); assert.equal(find(...B, '01. DL', 'Addendum 1.pdf'), null);
  assert.deepEqual([v.gc, v.latestPdf.name, v.total], ['GC Alpha', 'Bundle proposal.pdf', 1]);
  assert.deepEqual(v.gcs.map((g) => [g.gc, g.latestPdf?.name, g.latestWord?.name, g.total]), [['GC Beta', 'Beta price.pdf', 'Beta price edited.docx', 2]]); assert.match(v.gcs[0].proposalFolderUrl, /GC%20Beta\/.*\/02\.%20Proposal$/);
  folders.forgetLatestPdfs(); const lp = (await call('GET', `/api/opportunities/${a}/latest-pdfs`, null, est)).body; assert.equal(lp.perGc, true); assert.deepEqual(lp.pdfs.map((x) => [x.gc, x.name]), [['GC Alpha', 'Bundle proposal.pdf'], ['GC Beta', 'Beta price.pdf']]);
  // Beta awards it: its folder is the contract folder; Alpha keeps its own proposal, the submitted one goes with the award
  assert.equal((await call('POST', `/api/opportunities/${a}/submissions`, { fileId: upB.body.fileId, date: today, method: 'Email', prices: [{ tradeId: tDemo, amount: 5000 }] }, est)).status, 200);
  const r = await call('POST', `/api/opportunities/${a}/status`, { status: 'Awarded', awardedGc: 'GC Beta' }, est); assert.equal(r.status, 200, JSON.stringify(r.body)); const c = 'C' + code.slice(1), W = ['ByOther', YEAR, 'GC Beta', `${c}_Bundle Store_Orlando`];
  assert.ok(find(...W), 'the winner\'s folder is the contract folder'); assert.equal(find(...B), null);
  assert.ok(find(...A), 'the other GC keeps its proposal folder'); assert.equal(find('ByOther', YEAR, 'GC Alpha', `${c}_Bundle Store_Orlando`), null);
  const p = (await call('GET', `/api/projects/${r.body.projectId}`, null, owner)).body.project; assert.equal(p.spPath, `ByOther/${YEAR}/GC Beta/${c}_Bundle Store_Orlando`);
  v = await syncNow(a); assert.deepEqual([v.sync.pushed, v.sync.failed], [0, []]); assert.equal(find(...W, '02. Proposal', 'Bundle proposal.pdf'), null);   // Alpha's proposal is not copied into the winner's folder
  assert.deepEqual([v.gc, v.latestPdf.name], ['GC Beta', 'Beta price.pdf']); assert.deepEqual(v.gcs.map((g) => [g.gc, g.latestPdf?.name]), [['GC Alpha', 'Bundle proposal.pdf']]);
});

test('plans that live in SharePoint are read from there for the estimating chat: uploaded ones the app no longer keeps, and ones dropped straight into 01. DL', async () => {
  const plans = await import('../server/plans.js'); const sent = [];
  ai.setFetch(async (url, init) => { if (String(url).endsWith('/v1/files')) { const f = init.body.get('file'); sent.push([f.name, Buffer.from(await f.arrayBuffer()).toString()]); return { ok: true, status: 200, json: async () => ({ id: 'file_sp_' + sent.length }) }; } return { ok: false, status: 500, json: async () => ({}) }; });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const id = await mk({ name: 'SP plans job', gc: 'SP Plans GC', addr: await addrOk('12 Plan St', 'Orlando', '32801') }); await call('POST', `/api/opportunities/${id}/status`, { status: 'Accepted' }, est);
  const body = Buffer.from('%PDF-1.4\n% bid set from the app\n%%EOF'); assert.equal((await call('POST', `/api/opportunities/${id}/plans`, body, est, 'BID SET.pdf')).status, 200);
  for (let i = 0; i < 200 && (await q('SELECT storage_key FROM opportunity_files WHERE opportunity_id=$1', [id]))[0].storage_key !== null; i++) await new Promise((ok) => setTimeout(ok, 50));
  assert.equal((await q('SELECT storage_key FROM opportunity_files WHERE opportunity_id=$1', [id]))[0].storage_key, null);   // the app's own copy is gone; SharePoint has it
  const o = await opp(id), dl = find('ByOther', YEAR, 'SP Plans GC', `${o.proposalId}_SP plans job_Orlando`, '01. DL'); const extra = Buffer.from('%PDF-1.4\n% dropped into the folder by hand\n%%EOF'); add(dl.id, 'Addendum 2.pdf', false, { size: extra.length, bytes: extra });
  const src = await plans.planSources(id); assert.deepEqual(src.map((x) => [x.name, x.where, !!x.spId]), [['BID SET.pdf', 'SharePoint', true], ['Addendum 2.pdf', 'SharePoint', true]]);
  const prep = await plans.preparePlans(id); assert.deepEqual(prep.problems, []); assert.deepEqual(prep.docs.map((d) => [d.name, d.fileId]), [['BID SET.pdf', 'file_sp_1'], ['Addendum 2.pdf', 'file_sp_2']]);
  assert.deepEqual(sent.map((x) => x[0]), ['BID SET.pdf', 'Addendum 2.pdf']); assert.match(sent[0][1], /bid set from the app/); assert.match(sent[1][1], /dropped into the folder by hand/);
  const again = await plans.preparePlans(id); assert.equal(again.docs.length, 2); assert.equal(sent.length, 2);   // nothing is fetched or sent a second time
});

// ---------------------------------------------------------------- the lead and its library folder kept in step
const syncNow = async (id, force) => (await call('POST', `/api/opportunities/${id}/sync`, { force: !!force }, est)).body;
test('opening a new lead makes no folder; Sync With SharePoint does; a reader cannot run it', async () => {
  const id = await mk({ name: 'Quiet lead', gc: 'Quiet GC', addr: await addrOk('3 Calm St', 'Orlando', '32801') });
  const v = await syncNow(id); assert.equal(v.sync.waiting, true); assert.equal(v.linked, false); assert.equal(find('ByOther', YEAR, 'Quiet GC'), null);
  assert.equal((await call('POST', `/api/opportunities/${id}/sync`, { force: true }, pm)).status, 403);
  const f = await syncNow(id, true); assert.equal(f.sync.linked, true); assert.equal(f.linked, true); assert.ok(find('ByOther', YEAR, 'Quiet GC', 'Quiet lead_Orlando', '02. Proposal')); assert.match(f.proposalFolderUrl, /02\.%20Proposal$/);
});

test('a lead whose folder was missed gets it at Started, and the files it already holds are copied in as a backup', async () => {
  const id = await mk({ name: 'Allstate Pavilion', gc: 'Pavilion GC', addr: await addrOk('8 Arena Way', 'Orlando', '32801') });
  graphDown = true; await call('POST', `/api/opportunities/${id}/status`, { status: 'Accepted' }, est);
  await call('POST', `/api/opportunities/${id}/files?kind=Proposal`, mkPdf(), est, 'Pavilion v1.pdf'); await call('POST', `/api/opportunities/${id}/files?kind=Submittal`, mkPdf(), est, 'Scope notes.pdf'); graphDown = false;
  assert.equal(find('ByOther', YEAR, 'Pavilion GC'), null);
  const r = await call('POST', `/api/opportunities/${id}/status`, { status: 'Started' }, est); assert.equal(r.status, 200); assert.match(r.body.folderUrl, /byother\.sharepoint\.com/);
  const o = await opp(id), root = ['ByOther', YEAR, 'Pavilion GC', `${o.proposalId}_Allstate Pavilion_Orlando`]; assert.ok(find(...root)); assert.equal(find(...root, '02. Proposal', 'Pavilion v1.pdf'), null);
  const v = await syncNow(id); assert.equal(v.sync.pushed, 2); assert.deepEqual(v.sync.failed, []);
  assert.ok(find(...root, '02. Proposal', 'Pavilion v1.pdf')); assert.ok(find(...root, '02. Proposal', 'Scope notes.pdf'));
  assert.ok((await q('SELECT sp_url FROM opportunity_files WHERE opportunity_id=$1', [id])).every((f) => /byother\.sharepoint\.com/.test(f.sp_url)));
  assert.ok((await opp(id)).notes.some((n) => /Copied to the SharePoint folder as a backup: Pavilion v1\.pdf, Scope notes\.pdf/.test(n.body)));
  const again = await syncNow(id); assert.equal(again.sync.pushed, 0); assert.equal(kids(find(...root, '02. Proposal').id).length, 2);   // nothing is copied twice
});

test('a folder deleted from the library is made again and the files kept in the app are copied back into it', async () => {
  const id = await mk({ name: 'Lost folder job', gc: 'Lost GC', addr: await addrOk('4 Gone Rd', 'Tampa', '33625') }); await call('POST', `/api/opportunities/${id}/status`, { status: 'Accepted' }, est);
  assert.equal((await call('POST', `/api/opportunities/${id}/files?kind=Proposal`, mkPdf(), est, 'Lost v1.pdf')).body.sharepoint, true);
  const o = await opp(id), root = ['ByOther', YEAR, 'Lost GC', `${o.proposalId}_Lost folder job_Tampa`]; drop(find(...root).id); assert.equal(find(...root), null);
  const seen = (await call('GET', `/api/opportunities/${id}/proposal-files`, null, est)).body; assert.equal(seen.linked, false); assert.match(seen.error, /no longer in the library/); assert.equal(seen.latestPdf.name, 'Lost v1.pdf');   // still opens from the app
  const v = await syncNow(id); assert.equal(v.sync.pushed, 1); assert.equal(v.linked, true); assert.ok(find(...root, '02. Proposal', 'Lost v1.pdf')); assert.equal(kids(find(...root).id).length, 5);
  assert.ok((await opp(id)).notes.some((n) => /was no longer in the library/.test(n.body))); assert.match((await opp(id)).folderUrl, /Lost%20folder%20job_Tampa$/);
});

test('a proposal saved straight into 02. Proposal shows as the latest on the lead, on the project, and keeps the C folder', async () => {
  const id = await mk({ name: 'Hand saved job', gc: 'Hand GC', addr: await addrOk('6 Desk Ln', 'Orlando', '32801') }); await call('POST', `/api/opportunities/${id}/status`, { status: 'Accepted' }, est);
  const fid = (await call('POST', `/api/opportunities/${id}/files?kind=Proposal`, mkPdf(), est, 'byOther Proposal v1.pdf')).body.fileId;
  let o = await opp(id); const root = () => ['ByOther', YEAR, 'Hand GC', `${o.proposalId}_Hand saved job_Orlando`]; add(find(...root(), '02. Proposal').id, 'byOther Proposal v1.docx', false, { size: 500 });
  let v = (await call('GET', `/api/opportunities/${id}/proposal-files`, null, est)).body; assert.deepEqual([v.latestPdf.name, v.latestWord.name, v.total], ['byOther Proposal v1.pdf', 'byOther Proposal v1.docx', 2]); assert.equal(v.latestPdf.where, 'App and SharePoint');
  // edited in Word and saved in the library by hand, with a new PDF beside it; Word's lock file is ignored
  const prop = find(...root(), '02. Proposal'); add(prop.id, 'byOther Proposal v2 edited.docx', false, { size: 900 }); add(prop.id, 'byOther Proposal v2 edited.pdf', false, { size: 700 }); add(prop.id, '~$Other Proposal v2 edited.docx', false, { size: 1 });
  v = await syncNow(id); assert.deepEqual([v.latestPdf.name, v.latestWord.name, v.total], ['byOther Proposal v2 edited.pdf', 'byOther Proposal v2 edited.docx', 4]);
  assert.deepEqual([v.latestPdf.where, v.latestPdf.fileId], ['SharePoint', null]); assert.match(v.latestPdf.href, /02\.%20Proposal\/byOther%20Proposal%20v2%20edited\.pdf$/); assert.deepEqual(v.earlier.map((x) => x.name).sort(), ['byOther Proposal v1.docx', 'byOther Proposal v1.pdf']);
  assert.equal(v.sync.pushed, 0);
  // awarded: the project shows the same, and syncing does not turn the C folder back into P
  assert.equal((await call('POST', `/api/opportunities/${id}/submissions`, { fileId: fid, date: today, method: 'Email', prices: [{ tradeId: tDemo, amount: 4000 }] }, est)).status, 200);
  const aw = await call('POST', `/api/opportunities/${id}/status`, { status: 'Awarded' }, est); assert.equal(aw.status, 200); const code = 'C' + o.proposalId.slice(1);
  await syncNow(id); assert.ok(find('ByOther', YEAR, 'Hand GC', `${code}_Hand saved job_Orlando`)); assert.equal(find(...root()), null);
  const cprop = find('ByOther', YEAR, 'Hand GC', `${code}_Hand saved job_Orlando`, '02. Proposal'); add(cprop.id, 'byOther Proposal v3 after award.pdf', false, { size: 800 });
  const pv = (await call('GET', `/api/projects/${aw.body.projectId}/lead-proposals`, null, owner)).body; assert.deepEqual([pv.latestPdf.name, pv.latestWord.name], ['byOther Proposal v3 after award.pdf', 'byOther Proposal v2 edited.docx']); assert.match(pv.proposalFolderUrl, new RegExp(`${code}_Hand%20saved%20job_Orlando/02\\.%20Proposal$`));
});

test('a long file name keeps its .pdf / .docx in SharePoint, and copies saved without it are given their full name, not copied again', async () => {
  const { cleanFileName, cleanName } = await import('../src/lib/estimating.ts');
  const long = 'byOther Proposal-P11151_Allstate Construction, Inc_Gandy and Palonis Park - Picnic Shelters_Tampa_11-16-2026';
  assert.equal(cleanFileName(long + '.pdf'), long + '.pdf'); assert.equal(cleanFileName(long + '.docx'), long + '.docx'); assert.equal(cleanName(long + '.pdf').length, 90);
  const huge = cleanFileName('x'.repeat(400) + '.docx'); assert.equal(huge.length, 180); assert.ok(huge.endsWith('.docx')); assert.equal(cleanFileName('a<b>:c?.PDF'), 'a b c.PDF'); assert.equal(cleanFileName('no ending'), 'no ending');
  const id = await mk({ name: 'Gandy and Palonis Park - Picnic Shelters', gc: 'Allstate Construction, Inc', addr: await addrOk('1 Park Rd', 'Tampa', '33625') }); await call('POST', `/api/opportunities/${id}/status`, { status: 'Accepted' }, est);
  const o = await opp(id), root = ['ByOther', YEAR, 'Allstate Construction, Inc', `${o.proposalId}_Gandy and Palonis Park - Picnic Shelters_Tampa`];
  // a new upload: the whole name, with its ending
  const a = mkPdf(); assert.equal((await call('POST', `/api/opportunities/${id}/files?kind=Proposal`, a, est, long + '.pdf')).body.sharepoint, true); assert.ok(find(...root, '02. Proposal', long + '.pdf'));
  // two copies as they were saved before the fix: cut at 90 characters, no ending, the second one numbered by SharePoint
  const b = Buffer.concat([mkPdf(), Buffer.from('second')]), c = Buffer.concat([mkPdf(), Buffer.from('third one')]), prop = find(...root, '02. Proposal'), cut = cleanName(long + ' (2).pdf');
  for (const [name, bytes] of [[long + ' (2).pdf', b], [long + ' (3).pdf', c]]) { graphDown = true; await call('POST', `/api/opportunities/${id}/files?kind=Submittal`, bytes, est, name); graphDown = false; }
  const old1 = add(prop.id, cut, false, { size: b.length }), old2 = add(prop.id, cut + ' 1', false, { size: c.length });
  await q('UPDATE opportunity_files SET sp_url=$2 WHERE opportunity_id=$1 AND name=$3', [id, 'https://byother.sharepoint.com/old1', long + ' (2).pdf']); await q('UPDATE opportunity_files SET sp_url=$2 WHERE opportunity_id=$1 AND name=$3', [id, 'https://byother.sharepoint.com/old2', long + ' (3).pdf']);
  const v = await syncNow(id); assert.deepEqual([v.sync.fixed, v.sync.pushed, v.sync.failed], [2, 0, []]);
  assert.deepEqual(kids(prop.id).map((n) => n.name).sort(), [long + ' (2).pdf', long + ' (3).pdf', long + '.pdf']); assert.equal(nodes.get(old1.id).name, long + ' (2).pdf'); assert.equal(nodes.get(old2.id).name, long + ' (3).pdf');   // renamed in place, by size
  assert.ok((await q('SELECT sp_url FROM opportunity_files WHERE opportunity_id=$1', [id])).every((f) => /\.pdf$/.test(decodeURIComponent(f.sp_url))));
  assert.ok((await opp(id)).notes.some((n) => /had lost their ending/.test(n.body)));
  const again = await syncNow(id); assert.deepEqual([again.sync.fixed, again.sync.pushed], [0, 0]); assert.equal(kids(prop.id).length, 3);
});

test('Submittal Tracker: the latest proposal PDF only (never Word or plans), newest of app and library, and one per GC for a bundled job with a folder under each', async () => {
  const latest = async (id) => { folders.forgetLatestPdfs(); return (await call('GET', `/api/opportunities/${id}/latest-pdfs`, null, est)).body; };
  const id = await mk({ name: 'Tracker job', gc: 'Tracker GC', addr: await addrOk('2 List Ave', 'Orlando', '32801') }); await call('POST', `/api/opportunities/${id}/status`, { status: 'Accepted' }, est);
  assert.deepEqual(await latest(id), { pdfs: [], perGc: false, error: null });
  await call('POST', `/api/opportunities/${id}/plans`, mkPdf(), est, 'Site Plan.pdf'); await call('POST', `/api/opportunities/${id}/files?kind=Proposal`, mkPdf(), est, 'Tracker v1.pdf'); await call('POST', `/api/opportunities/${id}/files?kind=Proposal`, mkPdf(), est, 'Tracker v2.pdf');
  let r = await latest(id); assert.deepEqual(r.pdfs.map((x) => [x.gc, x.name, x.where]), [['Tracker GC', 'Tracker v2.pdf', 'SharePoint']]); assert.equal(r.perGc, false);
  const o = await opp(id), prop = find('ByOther', YEAR, 'Tracker GC', `${o.proposalId}_Tracker job_Orlando`, '02. Proposal'); add(prop.id, 'Tracker v3 by hand.docx', false, { size: 9 }); add(prop.id, 'Tracker v3 by hand.pdf', false, { size: 9 });
  r = await latest(id); assert.deepEqual(r.pdfs.map((x) => x.name), ['Tracker v3 by hand.pdf']); assert.match(r.pdfs[0].href, /02\.%20Proposal\/Tracker%20v3%20by%20hand\.pdf$/);
  graphDown = true; const down = await latest(id); graphDown = false; assert.deepEqual(down.pdfs.map((x) => [x.name, x.where]), [['Tracker v2.pdf', 'App']]); assert.ok(down.error);   // SharePoint down: the app's own latest still shows
  assert.equal((await call('GET', `/api/opportunities/${id}/latest-pdfs`, null, pm)).status, 403);
  // a job that keeps a folder under a second GC: that GC's own latest PDF, which can be a different file
  const xf = add(add(find('ByOther', YEAR).id, 'Second GC').id, 'Tracker job_Orlando'), xp = add(xf.id, '02. Proposal'); add(xp.id, 'Tracker for Second GC.pdf', false, { size: 5 });
  await q('UPDATE opportunities SET folder_per_gc=true WHERE id=$1', [id]); await q('INSERT INTO opportunity_folders(opportunity_id, gc_name, sp_item_id, sp_path, folder_url) VALUES ($1,$2,$3,$4,$5)', [id, 'Second GC', xf.id, 'x', 'https://byother.sharepoint.com/x']);
  r = await latest(id); assert.equal(r.perGc, true); assert.deepEqual(r.pdfs.map((x) => [x.gc, x.name]), [['Tracker GC', 'Tracker v3 by hand.pdf'], ['Second GC', 'Tracker for Second GC.pdf']]);
});

test('a proposal name too long for Word on a PC leaves out the GC, then the project name; ones already saved are renamed in the library and in the app', async () => {
  const gandy = { proposal_id: 'P11151', gc_name: 'Allstate Construction, Inc', name: 'Gandy and Palonis Park - Picnic Shelters', city: 'Tampa', sp_path: 'ByOther/2026/Allstate Construction, Inc/P11151_Gandy and Palonis Park - Picnic Shelters_Tampa' };
  assert.equal(folders.proposalStem(gandy, '2026-11-16'), 'byOther Proposal-P11151_Tampa_11-16-2026');
  assert.equal(folders.proposalStem({ proposal_id: 'P26011', gc_name: 'CW Hayes Construction', name: 'Wingstop - St Cloud', city: 'St Cloud', sp_path: 'ByOther/2026/CW Hayes Construction/P26011_Wingstop - St Cloud_St Cloud' }, '2026-11-16'), 'byOther Proposal-P26011_CW Hayes Construction_Wingstop - St Cloud_St Cloud_11-16-2026');   // fits: the full name
  assert.equal(folders.proposalStem({ proposal_id: 'P1', gc_name: 'A Fairly Long General Contractor Name LLC', name: 'Medium Project Name Here', city: 'Orlando', sp_path: 'ByOther/2026/A Fairly Long General Contractor Name LLC/P1_Medium Project Name Here_Orlando' }, '2026-01-05'), 'byOther Proposal-P1_Medium Project Name Here_Orlando_01-05-2026');   // the GC goes first
  const id = await mk({ name: 'Gandy Park Picnic Shelters And Pavilions Phase Two', gc: 'Allstate Builders Of Florida, Inc', addr: await addrOk('5151 W Gandy Blvd', 'Tampa', '33611') }); await call('POST', `/api/opportunities/${id}/status`, { status: 'Accepted' }, est);
  const o = await opp(id), root = ['ByOther', YEAR, 'Allstate Builders Of Florida, Inc', `${o.proposalId}_Gandy Park Picnic Shelters And Pavilions Phase Two_Tampa`], long = `byOther Proposal-${o.proposalId}_Allstate Builders Of Florida, Inc_Gandy Park Picnic Shelters And Pavilions Phase Two_Tampa_11-16-2026`, short = `byOther Proposal-${o.proposalId}_Tampa_11-16-2026`;
  for (const n of [long + '.pdf', long + ' (2).pdf', 'Hand named by the estimator with a very long name that stays exactly as it is because the app did not write it - 11-16-2026.pdf']) assert.equal((await call('POST', `/api/opportunities/${id}/files?kind=Proposal`, mkPdf(), est, n)).body.sharepoint, true);
  await q(`UPDATE opportunity_files SET version=1 WHERE opportunity_id=$1 AND name LIKE 'byOther Proposal-%'`, [id]);   // as the estimating chat writes them
  const prop = find(...root, '02. Proposal'), ids = kids(prop.id).map((n) => n.id).sort();
  const v = await syncNow(id); assert.deepEqual([v.sync.shortened, v.sync.pushed, v.sync.failed], [2, 0, []]);
  assert.deepEqual(kids(prop.id).map((n) => n.name).sort(), ['Hand named by the estimator with a very long name that stays exactly as it is because the app did not write it - 11-16-2026.pdf', short + ' (2).pdf', short + '.pdf'].sort()); assert.deepEqual(kids(prop.id).map((n) => n.id).sort(), ids);   // renamed in place, nothing copied
  assert.deepEqual((await q(`SELECT name FROM opportunity_files WHERE opportunity_id=$1 AND version=1 ORDER BY name`, [id])).map((r) => r.name), [short + ' (2).pdf', short + '.pdf']);
  assert.ok((await q(`SELECT sp_url FROM opportunity_files WHERE opportunity_id=$1 AND version=1`, [id])).every((r) => decodeURIComponent(r.sp_url).includes(short)));
  assert.ok((await opp(id)).notes.some((n) => /given a shorter name so Word can open and save them/.test(n.body)));
  const again = await syncNow(id); assert.deepEqual([again.sync.shortened, again.sync.pushed], [0, 0]); assert.equal(kids(prop.id).length, 3); assert.equal(again.total, 3);
});

test('a file deleted in SharePoint stays deleted: it is not copied back and drops off the lead; a renamed one keeps its new name; my own newer file is the latest', async () => {
  const id = await mk({ name: 'Cleanup job', gc: 'Cleanup GC', addr: await addrOk('9 Tidy Ct', 'Orlando', '32801') }); await call('POST', `/api/opportunities/${id}/status`, { status: 'Accepted' }, est);
  for (const n of ['Old v1.pdf', 'Old v2.pdf', 'Old v3.pdf']) assert.equal((await call('POST', `/api/opportunities/${id}/files?kind=Proposal`, mkPdf(), est, n)).body.sharepoint, true);
  assert.equal((await call('POST', `/api/opportunities/${id}/plans`, mkPdf(), est, 'BID SET.pdf')).status, 200);
  for (let i = 0; i < 200 && (await q(`SELECT storage_key FROM opportunity_files WHERE opportunity_id=$1 AND kind='Plans'`, [id]))[0].storage_key !== null; i++) await new Promise((ok) => setTimeout(ok, 50));
  const o = await opp(id), root = ['ByOther', YEAR, 'Cleanup GC', `${o.proposalId}_Cleanup job_Orlando`], prop = find(...root, '02. Proposal'); assert.equal(o.files.length, 4);
  assert.equal((await syncNow(id)).sync.removed, 0);
  // in Explorer: two old proposals and the plan set deleted, one proposal renamed, and my own final PDF saved in
  drop(find(...root, '02. Proposal', 'Old v1.pdf').id); drop(find(...root, '02. Proposal', 'Old v2.pdf').id); drop(find(...root, '01. DL', 'BID SET.pdf').id);
  find(...root, '02. Proposal', 'Old v3.pdf').name = 'Renamed by me.pdf'; add(prop.id, 'My own final.pdf', false, { size: 8 });
  const v = await syncNow(id); assert.deepEqual([v.sync.removed, v.sync.pushed, v.sync.failed], [3, 0, []]);
  assert.deepEqual(kids(prop.id).map((n) => n.name).sort(), ['My own final.pdf', 'Renamed by me.pdf']); assert.equal(kids(find(...root, '01. DL').id).length, 0);   // nothing was put back
  assert.deepEqual([v.latestPdf.name, v.latestPdf.where, v.total], ['My own final.pdf', 'SharePoint', 2]); assert.deepEqual(v.earlier.map((x) => [x.name, x.where]), [['Renamed by me.pdf', 'App and SharePoint']]);
  const after = await opp(id); assert.deepEqual(after.files.map((f) => f.name), ['Renamed by me.pdf']); assert.ok(after.notes.some((n) => /Deleted from the SharePoint folder by hand, so no longer listed on the lead and not copied back: Old v1\.pdf, Old v2\.pdf, BID SET\.pdf/.test(n.body)));
  assert.match((await q(`SELECT sp_url FROM opportunity_files WHERE opportunity_id=$1 AND name='Renamed by me.pdf'`, [id]))[0].sp_url, /Renamed%20by%20me\.pdf$/);
  folders.forgetLatestPdfs(); assert.deepEqual((await call('GET', `/api/opportunities/${id}/latest-pdfs`, null, est)).body.pdfs.map((x) => x.name), ['My own final.pdf']);
  const again = await syncNow(id); assert.deepEqual([again.sync.removed, again.sync.pushed], [0, 0]); assert.equal(kids(prop.id).length, 2);
  // moved into a folder of my own inside the job folder: left alone, still listed
  const mineDir = add(prop.id, 'Old versions'); find(...root, '02. Proposal', 'Renamed by me.pdf').parent = mineDir.id;
  const moved = await syncNow(id); assert.deepEqual([moved.sync.removed, moved.sync.pushed], [0, 0]); assert.equal(kids(prop.id).filter((n) => !n.folder).length, 1); assert.deepEqual((await opp(id)).files.map((f) => f.name), ['Renamed by me.pdf']);
});

test('proposals are uploaded and removed on the lead like plans: PDF or Word; Remove takes the file off the lead and out of SharePoint, and the next newest shows', async () => {
  const id = await mk({ name: 'Proposal desk job', gc: 'Desk GC', addr: await addrOk('3 Paper St', 'Orlando', '32801') }); await call('POST', `/api/opportunities/${id}/status`, { status: 'Accepted' }, est);
  const view = async () => (await call('GET', `/api/opportunities/${id}/proposal-files`, null, est)).body, remove = (b, who = est) => call('POST', `/api/opportunities/${id}/proposals/remove`, b, who);
  const docx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('word/document.xml a small word file')]);
  const p1 = await call('POST', `/api/opportunities/${id}/files?kind=Proposal`, mkPdf(), est, 'Price v1.pdf'); assert.equal(p1.status, 200);
  const w1 = await call('POST', `/api/opportunities/${id}/files?kind=Proposal`, docx, est, 'Price v1.docx'); assert.equal(w1.status, 200, JSON.stringify(w1.body)); assert.equal(w1.body.parsed, null);
  assert.match((await call('POST', `/api/opportunities/${id}/files?kind=Proposal`, Buffer.from('hello'), est, 'notes.txt')).body.error, /PDF or a Word/);
  assert.equal((await call('POST', `/api/opportunities/${id}/submissions`, { fileId: w1.body.fileId, date: today, method: 'Email', prices: [{ tradeId: tDemo, amount: 100 }] }, est)).status, 400);   // only a PDF can be submitted
  const o = await opp(id), root = ['ByOther', YEAR, 'Desk GC', `${o.proposalId}_Proposal desk job_Orlando`], prop = find(...root, '02. Proposal'); add(prop.id, 'Hand saved.pdf', false, { size: 8 });
  let v = await view(); assert.deepEqual([v.latestPdf.name, v.latestPdf.fileId, !!v.latestPdf.itemId, v.latestWord.name], ['Hand saved.pdf', null, true, 'Price v1.docx']); assert.deepEqual(v.earlier.map((x) => x.name), ['Price v1.pdf']);
  // a file saved into the folder by hand: removed from the folder
  let r = await remove({ itemId: v.latestPdf.itemId }); assert.deepEqual([r.status, r.body.library, r.body.name], [200, true, 'Hand saved.pdf']); assert.equal(find(...root, '02. Proposal', 'Hand saved.pdf'), null);
  assert.equal((await remove({ itemId: find(...root, '01. DL').id })).status, 404); assert.equal((await remove({ itemId: 'nope' })).status, 404); assert.equal((await remove({})).status, 400); assert.equal((await remove({ fileId: p1.body.fileId }, pm)).status, 403);
  // one the app holds: off the lead and out of the folder, and the sync does not bring it back
  v = await view(); assert.equal(v.latestPdf.name, 'Price v1.pdf'); r = await remove({ fileId: v.latestPdf.fileId, itemId: v.latestPdf.itemId }); assert.deepEqual([r.status, r.body.library, r.body.kept], [200, true, false]);
  assert.equal(find(...root, '02. Proposal', 'Price v1.pdf'), null); assert.deepEqual((await opp(id)).files.map((f) => f.name), ['Price v1.docx']);
  const s1 = await syncNow(id); assert.deepEqual([s1.sync.pushed, s1.sync.removed, s1.latestPdf], [0, 0, null]); assert.equal(s1.latestWord.name, 'Price v1.docx');
  assert.ok((await opp(id)).notes.some((n) => /Proposal file "Price v1\.pdf" removed by est \(also from the SharePoint folder/.test(n.body)));
  // one that was submitted: gone from the folder and the list, kept on the submission
  const p2 = await call('POST', `/api/opportunities/${id}/files?kind=Proposal`, mkPdf(), est, 'Sent.pdf');
  assert.equal((await call('POST', `/api/opportunities/${id}/submissions`, { fileId: p2.body.fileId, date: today, method: 'Email', prices: [{ tradeId: tDemo, amount: 4000 }] }, est)).status, 200);
  r = await remove({ fileId: p2.body.fileId }); assert.deepEqual([r.status, r.body.kept, r.body.library], [200, true, true]); assert.equal(find(...root, '02. Proposal', 'Sent.pdf'), null);
  const after = await opp(id); assert.ok(after.files.some((f) => f.name === 'Sent.pdf' && f.removed)); assert.equal(after.submissions[0].fileId, p2.body.fileId); assert.equal((await view()).latestPdf, null);
  assert.equal((await fetch(`${base}/api/opportunity-files/${p2.body.fileId}`, { headers: { cookie: est } })).status, 200);   // still opens from the submission
});

test('Started with several GCs: each GC gets its own proposal with the folder under that GC (renamed to its own number) and the plans in its 01. DL', async () => {
  const a = await mk({ name: 'Fan Out Store', gc: 'Fan GC One', addr: await addrOk('40 Fan Rd', 'Orlando', '32801'), due: shift(today, 9) }), b = await mk({ name: 'Fan Out Store - Orlando', gc: 'Fan GC Two', addr: await addrOk('40 Fan Rd', 'Orlando', '32801'), due: shift(today, 9) });
  assert.equal((await call('POST', '/api/opportunities/bundle', { primaryId: a, otherIds: [b] }, est)).status, 200); assert.equal((await call('POST', `/api/opportunities/${a}/status`, { status: 'Accepted' }, est)).status, 200);
  const pid = (await opp(a)).proposalId, dir = `${pid}_Fan Out Store_Orlando`, A = ['ByOther', YEAR, 'Fan GC One', dir];
  assert.equal((await call('POST', `/api/opportunities/${a}/plans`, mkPdf(), est, 'BID SET.pdf')).status, 200);
  for (let i = 0; i < 200 && !find('ByOther', YEAR, 'Fan GC Two', dir, '01. DL', 'BID SET.pdf'); i++) await new Promise((ok) => setTimeout(ok, 50));
  add(find(...A, '01. DL').id, 'Addendum 3.pdf', false, { size: 5 });   // dropped into the main folder by hand, not yet under the second GC
  const st = await call('POST', `/api/opportunities/${a}/status`, { status: 'Started' }, est); assert.equal(st.status, 200, JSON.stringify(st.body)); assert.deepEqual(st.body.split.map((m) => [m.gc, m.proposalId]), [['Fan GC Two', pid + '-B']]);
  const B = ['ByOther', YEAR, 'Fan GC Two', `${pid}-B_Fan Out Store_Orlando`]; assert.ok(find(...B), 'the folder under the second GC carries that proposal\'s own number'); assert.equal(find('ByOther', YEAR, 'Fan GC Two', dir), null);
  assert.ok(find(...B, '01. DL', 'BID SET.pdf')); assert.ok(find(...B, '01. DL', 'Addendum 3.pdf')); assert.ok(find(...A, '01. DL', 'BID SET.pdf'));   // the plans are in both
  const two = await opp(st.body.split[0].id); assert.deepEqual([two.status, two.gc, two.spPath], ['Started', 'Fan GC Two', B.join('/')]); assert.equal((await opp(a)).spPath, A.join('/'));
  assert.equal((await q('SELECT count(*)::int AS n FROM opportunity_folders WHERE opportunity_id=$1', [a]))[0].n, 0);
  // a proposal uploaded on the second GC's proposal goes into that GC's folder, and only there
  assert.equal((await call('POST', `/api/opportunities/${two.id}/files?kind=Proposal`, mkPdf(), est, 'Two price.pdf')).body.sharepoint, true);
  assert.ok(find(...B, '02. Proposal', 'Two price.pdf')); assert.equal(find(...A, '02. Proposal', 'Two price.pdf'), null);
  const v = await syncNow(two.id); assert.deepEqual([v.sync.pushed, v.sync.failed, v.latestPdf.name, v.gcs], [0, [], 'Two price.pdf', []]);
});

test('a file Windows saved under a short name (BYOTHE-1.PDF) is given its proper name and type, read from the file itself', async () => {
  const id = await mk({ name: 'Short Name Job', gc: 'Short GC', addr: await addrOk('8 Short St', 'Orlando', '32801') }); await call('POST', `/api/opportunities/${id}/status`, { status: 'Accepted' }, est);
  const o = await opp(id), prop = find('ByOther', YEAR, 'Short GC', `${o.proposalId}_Short Name Job_Orlando`, '02. Proposal');
  const word = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('[Content_Types].xml word/document.xml')]), pdf = mkPdf();
  add(prop.id, 'BYOTHE-1.PDF', false, { size: word.length, bytes: word }); add(prop.id, 'BYOTHE~2.PDF', false, { size: pdf.length, bytes: pdf }); add(prop.id, 'Notes.PDF', false, { size: pdf.length, bytes: pdf });
  const v = await syncNow(id); assert.equal(v.sync.renamedShort, 2, JSON.stringify(v.sync));
  const names = kids(prop.id).map((n) => n.name).sort(), md = (d) => `${d.slice(5, 7)}-${d.slice(8, 10)}-${d.slice(0, 4)}`;
  assert.ok(names.includes('Notes.PDF')); assert.ok(names.some((n) => new RegExp(`^byOther Proposal-${o.proposalId}_.*\\d\\d-\\d\\d-\\d{4}\\.docx$`).test(n)), names.join(' | ')); assert.ok(names.some((n) => /^byOther Proposal-.*\.pdf$/.test(n)), names.join(' | '));
  assert.ok(!names.some((n) => /^BYOTHE/.test(n))); assert.ok((await opp(id)).notes.some((n) => /given their proper name and type: BYOTHE-1\.PDF is now byOther Proposal-/.test(n.body)));
  assert.equal((await syncNow(id)).sync.renamedShort, 0);
});
