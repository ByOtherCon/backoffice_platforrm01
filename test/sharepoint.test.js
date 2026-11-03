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
const item = (n) => ({ id: n.id, name: n.name, webUrl: 'https://byother.sharepoint.com/sites/ByOther/Shared Documents/' + pathOf(n).map(encodeURIComponent).join('/'), ...(n.folder ? { folder: {} } : {}) });
const kids = (id) => [...nodes.values()].filter((n) => n.parent === id);
const add = (parent, name, folder = true, extra = {}) => { const n = { id: 'i' + ++seq, name, parent, folder, ...extra }; nodes.set(n.id, n); return n; };
const res = (body, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body });
const graph = async (url, init = {}) => {
  const u = new URL(url), p = decodeURIComponent(u.pathname + (u.hostname === 'graph.microsoft.com' ? '' : '')), m = init.method || 'GET';
  if (u.hostname === 'login.microsoftonline.com') return res({ access_token: 'tok', expires_in: 3600 });
  if (u.hostname === 'upload.fake') { const part = Buffer.from(init.body), range = init.headers['content-range'].match(/bytes (\d+)-(\d+)\/(\d+)/); uploads[u.pathname] = [...(uploads[u.pathname] || []), part]; const done = Number(range[2]) + 1 === Number(range[3]); if (!done) return res({}, 202); const n = add(uploads.parent[u.pathname], uploads.name[u.pathname], false, { size: Buffer.concat(uploads[u.pathname]).length }); return res(item(n), 201); }
  if (graphDown) return res({ error: { code: 'serviceNotAvailable' } }, 500);
  const base = '/v1.0'; if (!p.startsWith(base)) return res({}, 404); const r = p.slice(base.length);
  let g;
  if ((g = r.match(/^\/sites\/([^/:]+):(.+)$/))) return res({ id: 'site1' });
  if (r === '/sites/site1/drives') return res({ value: [{ id: 'drv1', name: 'Documents' }] });
  if (r === '/drives/drv1/root') return res({ name: 'Documents', webUrl: 'https://byother.sharepoint.com/sites/ByOther/Shared Documents' });
  if ((g = r.match(/^\/drives\/drv1\/(root|items\/([^/]+))\/children$/))) { const id = g[2] || 'root';
    if (m === 'GET') return res({ value: kids(id).map(item) });
    const b = JSON.parse(init.body); if (kids(id).some((n) => n.name.toLowerCase() === b.name.toLowerCase())) return res({ error: { code: 'nameAlreadyExists' } }, 409); return res(item(add(id, b.name)), 201); }
  if ((g = r.match(/^\/drives\/drv1\/items\/([^/]+)$/)) && m === 'PATCH') { const n = nodes.get(g[1]); if (!n) return res({}, 404); n.name = JSON.parse(init.body).name; return res(item(n)); }
  if ((g = r.match(/^\/drives\/drv1\/items\/([^/]+):\/(.+):\/content$/)) && m === 'PUT') { const n = add(g[1], g[2], false, { size: init.body.length, text: Buffer.from(init.body).toString('latin1').slice(0, 20) }); return res(item(n), 201); }
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
const PDF = Buffer.from('%PDF-1.4\n%%EOF');

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
  const up = await call('POST', `/api/opportunities/${wing}/files?kind=Proposal`, PDF, est, 'Proposal v1.pdf'); assert.deepEqual([up.status, up.body.sharepoint], [200, true]);
  const o = await opp(wing); wingCode = o.proposalId; const folder = find('ByOther', YEAR, 'Hayes GC', `${wingCode}_Wingstop 2_Orlando`); const f = find('ByOther', YEAR, 'Hayes GC', `${wingCode}_Wingstop 2_Orlando`, '02. Proposal', 'Proposal v1.pdf'); assert.ok(folder && f); assert.equal(f.size, PDF.length);
  assert.ok((await q('SELECT sp_url FROM opportunity_files WHERE opportunity_id=$1', [wing]))[0].sp_url.startsWith('https://byother.sharepoint.com/'));
  graphDown = true; const down = await call('POST', `/api/opportunities/${wing}/files?kind=Submittal`, PDF, est, 'notes.pdf'); graphDown = false;
  assert.deepEqual([down.status, down.body.sharepoint], [200, false]); assert.equal((await opp(wing)).files.length, 2); assert.ok((await opp(wing)).notes.some((n) => /Saved in the app, but not copied to SharePoint/.test(n.body)));
  const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(9 * 1024 * 1024, 65)]);                                              // a large file goes up in pieces
  assert.equal((await call('POST', `/api/opportunities/${wing}/files?kind=Submittal`, big, est, 'Big plans.pdf')).body.sharepoint, true); assert.equal(find('ByOther', YEAR, 'Hayes GC', `${wingCode}_Wingstop 2_Orlando`, '02. Proposal', 'Big plans.pdf').size, big.length);
});

test('awarding turns P into C on the folder and the project; later documents carry the C code and land in the right folder', async () => {
  const f = (await call('POST', `/api/opportunities/${wing}/files?kind=Proposal`, PDF, est, 'Final.pdf')).body.fileId;
  assert.equal((await call('POST', `/api/opportunities/${wing}/submissions`, { fileId: f, date: today, method: 'Email', prices: [{ tradeId: tDemo, amount: 5000 }] }, est)).status, 200);
  const r = await call('POST', `/api/opportunities/${wing}/status`, { status: 'Awarded' }, est); assert.equal(r.status, 200); const code = 'C' + wingCode.slice(1);
  assert.equal(r.body.refCode, code); assert.match(r.body.folderUrl, /byother\.sharepoint\.com/);
  assert.ok(find('ByOther', YEAR, 'Hayes GC', `${code}_Wingstop 2_Orlando`)); assert.equal(find('ByOther', YEAR, 'Hayes GC', `${wingCode}_Wingstop 2_Orlando`), null);
  const p = (await call('GET', `/api/projects/${r.body.projectId}`, null, owner)).body.project; assert.deepEqual([p.refCode, p.proposalId, p.spPath], [code, wingCode, `ByOther/${YEAR}/Hayes GC/${code}_Wingstop 2_Orlando`]); assert.match(p.folderUrl, /byother\.sharepoint\.com/);
  assert.ok((await opp(wing)).notes.some((n) => /renamed to C\d+.*P became C/.test(n.body)));
  // documents added to the project from now on: named with the contract code, filed by kind
  const doc = async (category, name) => call('POST', `/api/documents/upload?category=${encodeURIComponent(category)}&projectId=${r.body.projectId}`, PDF, owner, name);
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
  for (const n of ['Sachse Construction', 'axxys construction group', 'S.A Casey Construction, Inc', '_old stuff']) add(year, n);
  await q(`INSERT INTO gcs(name) VALUES ('Axxys Construction Group')`); await q(`INSERT INTO gcs(name, archived) VALUES ('Archived GC', true)`);
  const before = (await q('SELECT count(*)::int n FROM gcs'))[0].n; const r = await folders.syncGcs();
  const names = (await q('SELECT name, archived FROM gcs ORDER BY name')).map((g) => g.name);
  assert.ok(names.includes('Sachse Construction') && names.includes('S.A Casey Construction, Inc')); assert.ok(!names.includes('axxys construction group'));   // same GC, different capitalisation: not added twice
  assert.ok(!names.includes('_old stuff')); assert.equal((await q(`SELECT archived FROM gcs WHERE name='Archived GC'`))[0].archived, true);              // nothing re-activated or removed
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
  for (let i = 0; i < 100 && (await q('SELECT storage_key FROM opportunity_files WHERE opportunity_id=$1', [id]))[0].storage_key; i++) await new Promise((ok) => setTimeout(ok, 50));        // the copy runs after the answer
  const row = (await q('SELECT storage_key, sp_url FROM opportunity_files WHERE opportunity_id=$1', [id]))[0]; assert.equal(row.storage_key, null); assert.match(row.sp_url, /byother\.sharepoint\.com/);
  const o = await opp(id); const code = o.proposalId; const f = find('ByOther', YEAR, 'Plans GC', `${code}_Plans job_Orlando`, '01. DL', 'Plans Set.zip'); assert.ok(f); assert.equal(f.size, big.length);   // came up in pieces
  assert.deepEqual([o.files[0].local, !!o.files[0].spUrl], [false, true]); const nb = o.notes.map((n) => n.body); assert.ok(nb.some((b) => /Plans "Plans Set\.zip" \(9\.0 MB\) uploaded by est\. Copying/.test(b))); assert.ok(nb.some((b) => /Plans "Plans Set\.zip" copied to the 01\. DL folder/.test(b)));
  const dl = await fetch(`${base}/api/opportunity-files/${o.files[0].id}`, { headers: { cookie: est } }); assert.equal(dl.status, 404);                                       // the open link for such a file is its SharePoint link
  // when SharePoint is down the app keeps its own copy, and says so
  graphDown = true; const r2 = await up(zip(1), 'More plans.zip'); assert.equal(r2.status, 200); await new Promise((ok) => setTimeout(ok, 400)); graphDown = false;
  const kept = (await q(`SELECT storage_key FROM opportunity_files WHERE name='More plans.zip'`))[0]; assert.ok(kept.storage_key); assert.ok((await opp(id)).notes.some((n) => /Saved in the app, but not copied to SharePoint/.test(n.body)));
  const dl2 = await fetch(`${base}/api/opportunity-files/${(await opp(id)).files.find((x) => x.name === 'More plans.zip').id}`, { headers: { cookie: est } }); assert.equal(dl2.status, 200); assert.equal(dl2.headers.get('content-type'), 'application/zip');
});
