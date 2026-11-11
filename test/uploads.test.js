import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
delete process.env.ANTHROPIC_API_KEY;
const { pool, q } = await import('../server/db.js');
const { server } = await import('../server/index.js');
const { hashPassword } = await import('../server/auth.js');
const docs = await import('../server/documents.js');

let base, office, pid, pid2, pt;
let est;
const up = async (path, bytes, name, as = office) => { const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name), cookie: as }, body: bytes }); const t = await r.text(); let b = null; try { b = JSON.parse(t); } catch { b = t; } return { status: r.status, body: b }; };
const get = async (path) => { const r = await fetch(base + path, { headers: { cookie: office } }); return { status: r.status, body: await r.json() }; };
const pdf = (n) => Buffer.from(`%PDF-1.4\n% upload ${n}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF`);
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  const h = await hashPassword('correct horse battery');
  await q(`INSERT INTO app_users(email,name,role,password_hash) VALUES ('office@x.net','Office','Exec Assistant',$1), ('est@x.net','Est','Estimator',$1)`, [h]);
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
  office = (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'office@x.net', password: 'correct horse battery' }) })).headers.get('set-cookie').split(';')[0];
  est = (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'est@x.net', password: 'correct horse battery' }) })).headers.get('set-cookie').split(';')[0];
  const [g] = await q(`INSERT INTO gcs(name) VALUES ('GC') RETURNING id`), [t] = await q(`INSERT INTO trades(name,sort) VALUES ('Framing',1) RETURNING id`);
  [{ id: pid }, { id: pid2 }] = await q(`INSERT INTO projects(name,gc_id,client,address) VALUES ('Job',$1,'C','A'), ('Job 2',$1,'C','B') RETURNING id`, [g.id]);
  [{ id: pt }] = await q('INSERT INTO project_trades(project_id,trade_id,original_amount) VALUES ($1,$2,50000) RETURNING id', [pid, t.id]);
});
after(async () => { server.close(); await pool.end(); });

test('the same file is never saved twice, in any project or kind of upload; the message says where it already is', async () => {
  const f = pdf(1);
  const a = await up(`/api/documents/upload?category=Other&projectId=${pid}`, f, 'Spec Sheet.pdf'); assert.equal(a.status, 200, JSON.stringify(a.body));
  const again = await up(`/api/documents/upload?category=Other&projectId=${pid}`, f, 'Renamed Copy.pdf'); assert.equal(again.status, 409); assert.match(again.body.error, /already saved as "Spec Sheet\.pdf" in project Job/);
  assert.equal((await up(`/api/documents/upload?category=Other&projectId=${pid2}`, f, 'Other Project.pdf')).status, 409);   // not in another project either
  assert.equal((await up('/api/receipts/parse', f, 'receipt.pdf')).status, 409);                                              // nor as a receipt
  assert.equal((await q(`SELECT count(*)::int n FROM documents`))[0].n, 1);
  assert.equal((await up(`/api/documents/upload?category=Other&projectId=${pid}`, pdf(2), 'Different.pdf')).status, 200);       // a different file is fine
  // files on disk: only one copy of the first
  assert.equal((await q(`SELECT count(DISTINCT storage_key)::int n FROM documents`))[0].n, 2);
});

test('reading a contract again reuses the saved file instead of storing it a second time', async () => {
  const f = pdf(3);
  const a = await up(`/api/projects/${pid}/contract`, f, 'Contract.pdf'); assert.equal(a.status, 200, JSON.stringify(a.body));
  const b = await up(`/api/projects/${pid}/contract`, f, 'Contract again.pdf'); assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.equal(a.body.documentId, b.body.documentId);
  assert.equal((await q(`SELECT count(*)::int n FROM documents WHERE sha256=$1`, [docs.sha256(f)]))[0].n, 1);
  assert.equal((await up(`/api/projects/${pid2}/contract`, f, 'Contract.pdf')).status, 409);   // a file that is another project's is refused
});

test('a lead file is a duplicate too, and the project Documents list holds everything tied to the project', async () => {
  const [o] = await q(`INSERT INTO opportunities(name,gc_name,city,due_date,status,accepted_date,source_key,project_id) VALUES ('Lead','GC','Orlando',current_date,'Accepted',current_date,'k1',$1) RETURNING id`, [pid]);
  const lead = pdf(4);
  assert.equal((await up(`/api/opportunities/${o.id}/files?kind=Other`, lead, 'Lead Doc.pdf', est)).status, 200);
  assert.equal((await up(`/api/opportunities/${o.id}/files?kind=Other`, lead, 'Lead Doc 2.pdf', est)).status, 409);   // the lead refuses its own duplicate
  assert.equal((await up(`/api/documents/upload?category=Other&projectId=${pid}`, lead, 'Same As Lead.pdf')).status, 409);
  // a receipt split onto the project, a client-invoice file and a subcontractor's W-9 all show on the project
  const r = await up('/api/receipts/parse', pdf(5), 'hd.pdf'); assert.equal(r.status, 200);
  const rec = await fetch(base + '/api/receipts', { method: 'POST', headers: { 'content-type': 'application/json', cookie: office }, body: JSON.stringify({ supplierName: 'Home Depot', saveVendor: false, reference: 'HD-1', date: '2026-11-10', documentId: r.body.documentId, lines: [{ description: 'Screws', amount: 20, projectId: pid, projectTradeId: pt }] }) }); assert.equal(rec.status, 200);
  const [sub] = await q(`INSERT INTO subcontractors(name) VALUES ('Rivera') RETURNING id`);
  assert.equal((await up(`/api/documents/upload?category=W-9&subcontractorId=${sub.id}`, pdf(6), 'w9.pdf')).status, 200);
  await q(`INSERT INTO sub_commitments(project_id,project_trade_id,subcontractor_id,contract_amount) VALUES ($1,$2,$3,1000)`, [pid, pt, sub.id]);
  const list = (await get(`/api/documents?projectId=${pid}`)).body.map((d) => [d.category, d.name]).sort((x, y) => String(x).localeCompare(String(y)));
  assert.deepEqual(list.map((x) => x[1]).sort(), ['Contract.pdf', 'Different.pdf', 'Spec Sheet.pdf', 'hd.pdf', 'w9.pdf'].sort());
  assert.deepEqual((await get(`/api/documents?projectId=${pid2}`)).body, []);   // the other project sees none of it
});

test('files saved before fingerprints existed are fingerprinted at start, then count as duplicates', async () => {
  const f = pdf(7), a = await up(`/api/documents/upload?category=Other&projectId=${pid}`, f, 'Old File.pdf'); assert.equal(a.status, 200);
  await q('UPDATE documents SET sha256=NULL WHERE id=$1', [a.body.id]);
  assert.equal((await up(`/api/documents/upload?category=Other&projectId=${pid}`, f, 'Old File Again.pdf')).status, 200);   // not known yet
  await q('DELETE FROM documents WHERE name=$1', ['Old File Again.pdf']);
  assert.ok((await docs.backfillHashes()) >= 1);
  assert.equal((await up(`/api/documents/upload?category=Other&projectId=${pid}`, f, 'Old File Again.pdf')).status, 409);
});
