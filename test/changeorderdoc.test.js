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

let base, owner, pm, reply, tDemo, tDry, tPaint, pid, aiDown = false;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
const claude = async (url, init) => { const tool = JSON.parse(init.body).tools[0].name; return aiDown ? { ok: false, status: 500, json: async () => ({}) } : { ok: true, json: async () => ({ content: [{ type: 'tool_use', name: tool, input: reply }], usage: { input_tokens: 500, output_tokens: 90 } }) }; };
const res = (body, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body, arrayBuffer: async () => (Buffer.isBuffer(body) ? body.buffer.slice(body.byteOffset, body.byteOffset + body.length) : new ArrayBuffer(0)) });
const graph = async (url) => { const u = new URL(url), p = decodeURIComponent(u.pathname);
  if (u.hostname === 'login.microsoftonline.com') return res({ access_token: 'tok', expires_in: 3600 }); if (/^\/v1.0\/sites\/[^/]+:/.test(p)) return res({ id: 'site1' }); if (p === '/v1.0/sites/site1/drives') return res({ value: [{ id: 'dr1', name: 'Documents' }] });
  if (p === '/v1.0/drives/dr1/items/co1/content') return res(PDF); if (p === '/v1.0/drives/dr1/items/co1') return res({ id: 'co1', name: 'CO 7 Signed.pdf', size: PDF.length, file: {} }); return res({}, 404); };
const call = async (method, path, body, cookie, raw) => { const r = await fetch(base + path, { method, headers: { ...(body && !raw ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(raw ? { 'x-file-name': raw } : {}) }, body: body ? (raw ? body : JSON.stringify(body)) : undefined }); const t = await r.text(); let b = null; try { b = t ? JSON.parse(t) : null; } catch { b = t; } return { status: r.status, body: b }; };
const login = async (email) => (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct horse battery' }) })).headers.get('set-cookie').split(';')[0];
const proj = async () => (await call('GET', `/api/projects/${pid}`, null, owner)).body;
const docCount = async () => (await q(`SELECT count(*)::int AS n FROM documents WHERE project_id=$1 AND category='Approved CO'`, [pid]))[0].n;
const baseReply = () => ({ isChangeOrder: true, number: 'CO-07', date: '2026-10-30', executed: true, description: 'Added soffit and credit for paint', totalAmount: 11000,
  lines: [{ description: 'Add demolition at rear', amount: 10000, tradeHint: 'demolition' }, { description: 'Drywall credit', amount: -1500, tradeHint: 'drywall' }, { description: 'New paint scope', amount: 2500, tradeHint: 'paint' }], warnings: [] });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  const h = await hashPassword('correct horse battery');
  for (const [e, r] of [['owner@x.net', 'Super Admin'], ['pm@x.net', 'Project Manager']]) await q('INSERT INTO app_users(email,name,role,password_hash) VALUES ($1,$2,$3,$4)', [e, e.split('@')[0], r, h]);
  [tDemo, tDry, tPaint] = (await Promise.all(['Demo', 'Framing & Drywall', 'Paint'].map((n, i) => q('INSERT INTO trades(name,sort) VALUES ($1,$2) RETURNING id', [n, i + 1])))).map((r) => r[0].id);
  const [g] = await q(`INSERT INTO gcs(name) VALUES ('GC') RETURNING id`);
  const [p] = await q(`INSERT INTO projects(name,gc_id,client,address,city,state,zip) VALUES ('Job',$1,'C','1 Main St','Orlando','FL','32801') RETURNING id`, [g.id]); pid = p.id;
  await q('INSERT INTO project_trades(project_id,trade_id,original_amount) VALUES ($1,$2,20000), ($1,$3,85000)', [pid, tDemo, tDry]);
  ai.setFetch(claude); sp.setGraphFetch(graph);
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`; owner = await login('owner@x.net'); pm = await login('pm@x.net');
});
after(async () => { server.close(); await pool.end(); });

test('a change order PDF is read into a draft: number, date, signed or not, each line matched to a trade, trades new to the project flagged; the file is kept', async () => {
  reply = baseReply(); const r = await call('POST', `/api/projects/${pid}/change-orders/read`, PDF, owner, 'CO 7.pdf'); assert.equal(r.status, 200, JSON.stringify(r.body)); const d = r.body;
  assert.deepEqual([d.number, d.status, d.approvedDate, d.total, d.fileName], ['CO-07', 'Approved', '2026-10-30', 11000, 'CO 7.pdf']);
  assert.deepEqual(d.lines.map((l) => [l.tradeId, l.amount, l.newTrade]), [[tDemo, 10000, false], [tDry, -1500, false], [tPaint, 2500, true]]); assert.ok(d.warnings.some((w) => /not on this project yet will be added/.test(w))); assert.equal(await docCount(), 1);
  reply = { ...baseReply(), executed: false, totalAmount: 9000, lines: [...baseReply().lines, { description: 'Mystery', amount: null, tradeHint: 'xyz' }] };
  const u = (await call('POST', `/api/projects/${pid}/change-orders/read`, PDF, owner, 'CO 7 draft.pdf')).body; assert.equal(u.status, 'Pending'); assert.equal(u.approvedDate, '');
  assert.ok(u.warnings.some((w) => /not show it was signed/.test(w)) && u.warnings.some((w) => /add up to 11000.00 but the printed total is 9000.00/.test(w)) && u.warnings.some((w) => /Choose a trade/.test(w)));
  assert.equal((await call('POST', `/api/projects/${pid}/change-orders/read`, PDF, pm, 'x.pdf')).status, 403); assert.equal((await call('POST', `/api/projects/${pid}/change-orders/read`, PDF, owner, 'x.docx')).status, 400);
  // a draft that is never added is cleaned up again
  await call('DELETE', `/api/projects/${pid}/change-orders/draft/${u.documentId}`, null, owner); await call('DELETE', `/api/projects/${pid}/change-orders/draft/${d.documentId}`, null, owner); assert.equal(await docCount(), 0);
  aiDown = true; const down = await call('POST', `/api/projects/${pid}/change-orders/read`, PDF, owner, 'CO 8.pdf'); aiDown = false;
  assert.equal(down.status, 200); assert.ok(down.body.error && down.body.lines.length === 0 && down.body.documentId); assert.equal(await docCount(), 1);   // AI down: the file is kept, details by hand
  await call('DELETE', `/api/projects/${pid}/change-orders/draft/${down.body.documentId}`, null, owner);
});

test('adding it to the trades: one change order per trade, a new trade is brought onto the project, totals follow, the file is linked', async () => {
  reply = baseReply(); const d = (await call('POST', `/api/projects/${pid}/change-orders/read`, PDF, owner, 'CO 7.pdf')).body;
  const before = (await proj()).totals.contract;
  assert.equal((await call('POST', `/api/projects/${pid}/change-orders/from-document`, { documentId: d.documentId, number: 'CO-07', status: 'Approved', approvedDate: null, lines: d.lines }, owner)).status, 400);   // approved needs its date
  assert.equal((await call('POST', `/api/projects/${pid}/change-orders/from-document`, { documentId: d.documentId, number: 'CO-07', status: 'Approved', approvedDate: '2026-10-30', lines: [d.lines[0], d.lines[0]] }, owner)).status, 400);   // a trade only once
  const ok = await call('POST', `/api/projects/${pid}/change-orders/from-document`, { documentId: d.documentId, number: 'CO-07', status: 'Approved', approvedDate: '2026-10-30', description: d.description, lines: d.lines }, owner); assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.created.map((c) => c.number).sort(), ['CO-07 - Demo', 'CO-07 - Framing & Drywall', 'CO-07 - Paint']);
  const p = await proj(); assert.equal(p.totals.contract, before + 11000); assert.equal(p.trades.find((t) => t.name === 'Paint').original, 0);   // Paint came onto the project through the change order
  assert.ok(p.changeOrders.every((c) => c.documentId === d.documentId && c.documentName === 'CO 7.pdf'));
  assert.equal((await call('POST', `/api/projects/${pid}/change-orders/from-document`, { documentId: d.documentId, number: 'CO-07 - Demo', status: 'Pending', lines: [{ tradeId: tDry, amount: 1 }] }, owner)).status, 409);   // CO # already used
  assert.equal((await call('POST', `/api/projects/${pid}/change-orders/from-document`, { documentId: d.documentId, number: 'CO-09', status: 'Approved', approvedDate: '2026-10-30', lines: [{ tradeId: tDry, amount: -999999 }] }, owner)).status, 400);   // would take the trade below zero
  assert.equal((await proj()).changeOrders.length, 3);   // nothing half-saved
});

test('a change order file can be replaced and removed; deleting the last change order that uses a file deletes the file', async () => {
  const cos = (await proj()).changeOrders, a = cos[0], b = cos[1], c = cos[2];
  const r = await call('POST', `/api/projects/${pid}/change-orders/${a.id}/file`, PDF, owner, 'CO 7 corrected.pdf'); assert.equal(r.status, 200); assert.equal(r.body.replaced, true);
  let p = await proj(); assert.equal(p.changeOrders.find((c) => c.id === a.id).documentName, 'CO 7 corrected.pdf'); assert.equal(p.changeOrders.find((c) => c.id === b.id).documentName, 'CO 7.pdf');   // the other one keeps its file
  assert.equal(await docCount(), 2); assert.equal((await call('POST', `/api/projects/${pid}/change-orders/${a.id}/file`, PDF, pm, 'x.pdf')).status, 403);
  assert.equal((await call('DELETE', `/api/projects/${pid}/change-orders/${a.id}/file`, null, owner)).status, 200); p = await proj(); assert.equal(p.changeOrders.find((c) => c.id === a.id).documentId, null); assert.equal(await docCount(), 1);
  assert.equal((await call('DELETE', `/api/projects/${pid}/change-orders/${b.id}`, null, owner)).status, 200); assert.equal(await docCount(), 1);   // another change order still uses the file
  assert.equal((await call('DELETE', `/api/projects/${pid}/change-orders/${c.id}`, null, owner)).status, 200); assert.equal(await docCount(), 0);   // last one: deleted with its change order
  assert.equal((await proj()).changeOrders.length, 1);
});

test('a change order can come from SharePoint', async () => {
  reply = { ...baseReply(), number: 'CO-11' }; const d = await call('POST', `/api/projects/${pid}/change-orders/read-sharepoint`, { itemId: 'co1' }, owner); assert.equal(d.status, 200, JSON.stringify(d.body)); assert.equal(d.body.fileName, 'CO 7 Signed.pdf'); assert.equal(d.body.number, 'CO-11');
  assert.equal((await call('POST', `/api/projects/${pid}/change-orders/read-sharepoint`, { itemId: 'zzz' }, owner)).status, 404); await call('DELETE', `/api/projects/${pid}/change-orders/draft/${d.body.documentId}`, null, owner);
});
