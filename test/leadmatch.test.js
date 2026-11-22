import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bo-match-'));
const { pool, q } = await import('../server/db.js');
const { server } = await import('../server/index.js');
const { hashPassword } = await import('../server/auth.js');
const R = await import('../src/lib/bidrules.ts');

let base, est, pm, trade;
async function call(method, p, body, cookie) {
  const r = await fetch(base + p, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); return { status: r.status, body: t ? JSON.parse(t) : null };
}
const login = async (email) => (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct horse battery' }) })).headers.get('set-cookie').split(';')[0];
const lead = async (name, gc, city, address, status = 'Accepted', extra = {}) => (await q(`INSERT INTO opportunities(name,gc_name,city,address,status,source_key,client_name,proposal_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [name, gc, city, address, status, name + gc + Math.random(), extra.client ?? null, extra.proposalId ?? null]))[0].id;
const pdfFile = async (oppId, name) => { const key = 'k' + Math.random().toString(16).slice(2) + '.pdf'; fs.writeFileSync(path.join(process.env.UPLOAD_DIR, key), '%PDF-1.4\n% ' + name + '\n%%EOF');
  return (await q(`INSERT INTO opportunity_files(opportunity_id,kind,name,storage_key,mime,size,sha256) VALUES ($1,'Proposal',$2,$3,'application/pdf',30,$4) RETURNING id`, [oppId, name, key, 'sha' + Math.random()]))[0].id; };
const submit = (id, fileId) => call('POST', `/api/opportunities/${id}/submissions`, { fileId, date: '2026-11-20', method: (globalThis.METHOD), prices: [{ tradeId: trade, amount: 12000 }] }, est);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  const h = await hashPassword('correct horse battery');
  for (const [e, n, r] of [['est@x.net', 'Juliana', 'Estimator'], ['pm@x.net', 'Pat', 'Project Manager']]) await q('INSERT INTO app_users(email,name,role,password_hash) VALUES ($1,$2,$3,$4)', [e, n, r, h]);
  [{ id: trade }] = await q(`INSERT INTO trades(name,sort) VALUES ('Framing',1) RETURNING id`);
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
  est = await login('est@x.net'); pm = await login('pm@x.net');
  globalThis.METHOD = (await call('GET', '/api/estimating/options', null, est)).body.methods[0];
});
after(async () => { server.close(); await pool.end(); fs.rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true }); });

test('maybe the same job: the same store name in the same city with the address written differently is asked about; other cities or other suites never', () => {
  const a = { name: 'Burlington - Ocala', city: 'Ocala', address: '3100 SW College Rd' };
  assert.match(R.maybeSameJob(a, { name: 'Burlington #1234 Paddock Mall', city: 'Ocala', address: '3100 College Road SW' }), /^The same store name \(burlington\) in the same city, written with a different address\./);
  assert.equal(R.maybeSameJob(a, { name: 'Burlington - Gainesville', city: 'Gainesville', address: '3100 SW College Rd' }), null);
  assert.equal(R.maybeSameJob({ ...a, address: '3100 SW College Rd, Suite 101' }, { ...a, name: 'Burlington Ocala', address: '3100 SW College Rd, Suite 240' }), null);
  assert.match(R.maybeSameJob({ name: 'Store Refresh', city: 'Tampa', address: '', client: 'TJX' }, { name: 'Interior Remodel', city: 'Tampa', address: '', client: 'TJX' }), /The same client \(TJX\)/);
  assert.equal(R.maybeSameJob({ name: 'Wingstop', city: 'Orlando', address: '' }, { name: 'Chipotle', city: 'Orlando', address: '' }), null);
  assert.match(R.maybeSameJob({ name: 'Old Navy 5904', city: 'Tampa', address: '12851 Citrus Plaza Dr' }, { name: 'Old Navy 5904 Refresh', city: 'Tampa', address: '12851 Citrus Plaza Drive' }), /^Same job/);
});

test('after a submission: possible matches with why, join and submit-too; "Not The Same Job" is remembered', async () => {
  const a = await lead('Burlington - Ocala', 'Diamond Contractors', 'Ocala', '3100 SW College Rd', 'Accepted', { proposalId: 'P26050' });
  const b = await lead('Burlington #1234 Paddock Mall', 'Quantum Installation Group', 'Ocala', '3100 College Road SW', 'Accepted');
  const c = await lead('Burlington Ocala Remodel', 'Diamond Contractors', 'Ocala', '', 'New');
  const d = await lead('Burlington Ocala', 'Elkins Constructors', 'Ocala', '3100 SW College Rd, Suite 9', 'Reviewing');
  await lead('Burlington - Gainesville', 'Diamond Contractors', 'Gainesville', '1 Main St', 'Accepted');
  const f = await pdfFile(a, 'byOther Proposal-P26050_Burlington.pdf');
  assert.equal((await submit(a, f)).status, 200);
  let m = (await call('GET', `/api/opportunities/${a}/possible-matches`, null, est)).body.leads;
  assert.deepEqual(m.map((x) => x.name).sort(), ['Burlington #1234 Paddock Mall', 'Burlington Ocala', 'Burlington Ocala Remodel']);
  const mb = m.find((x) => x.id === b), mc = m.find((x) => x.id === c);
  assert.deepEqual([mb.canSubmit, mb.canMerge, mb.sameGc], [true, true, false]); assert.match(mb.why, /same store name/);
  assert.deepEqual([mc.canSubmit, mc.canMerge, mc.sameGc], [false, true, true]);
  // not the same job: never asked about again
  assert.equal((await call('POST', `/api/opportunities/${a}/not-same`, { otherId: d }, pm)).status, 403);
  assert.equal((await call('POST', `/api/opportunities/${a}/not-same`, { otherId: d }, est)).status, 200);
  assert.ok(!(await call('GET', `/api/opportunities/${a}/possible-matches`, null, est)).body.leads.some((x) => x.id === d));
  // submit the same proposal to the other GC too: the PDF is copied onto that lead and submitted there
  const cp = await call('POST', `/api/opportunities/${b}/files/copy`, { fileId: f }, est); assert.equal(cp.status, 200, JSON.stringify(cp.body)); assert.notEqual(cp.body.fileId, f);
  assert.equal((await submit(b, cp.body.fileId)).status, 200);
  assert.equal((await q(`SELECT status FROM opportunities WHERE id=$1`, [b]))[0].status, 'Submitted');
  assert.ok(fs.existsSync(path.join(process.env.UPLOAD_DIR, (await q('SELECT storage_key FROM opportunity_files WHERE id=$1', [cp.body.fileId]))[0].storage_key)));
  // the same GC, listed twice: joined into the kept lead
  const j = await call('POST', `/api/opportunities/${a}/merge`, { otherId: c }, est); assert.equal(j.status, 200, JSON.stringify(j.body)); assert.equal(j.body.how, 'combined');
  assert.equal((await q('SELECT merged_into FROM opportunities WHERE id=$1', [c]))[0].merged_into, a);
  assert.ok((await q(`SELECT body FROM opportunity_notes WHERE opportunity_id=$1`, [a])).some((n) => /Joined by Juliana: combined with a duplicate/.test(n.body)));
  // two leads that each have a submission stay two leads; a lead with its own submission is the one to keep
  const r1 = await call('POST', `/api/opportunities/${a}/merge`, { otherId: b }, est); assert.equal(r1.status, 409); assert.match(r1.body.error, /Both leads have their own P number or submission/);
  const e = await lead('Burlington Ocala TI', 'Quantum Installation Group', 'Ocala', '', 'New');
  const r2 = await call('POST', `/api/opportunities/${e}/merge`, { otherId: a }, est); assert.equal(r2.status, 409); assert.match(r2.body.error, /already has its own P number or submission\. Open that lead and join this one into it instead\./);
  // another GC: bundled into the kept lead
  const r3 = await call('POST', `/api/opportunities/${a}/merge`, { otherId: e }, est); assert.equal(r3.status, 200, JSON.stringify(r3.body)); assert.equal(r3.body.how, 'bundled');
  assert.equal((await q('SELECT merged_into FROM opportunities WHERE id=$1', [e]))[0].merged_into, a);
  assert.equal((await call('POST', `/api/opportunities/${a}/merge`, { otherId: a }, est)).status, 409);
});
