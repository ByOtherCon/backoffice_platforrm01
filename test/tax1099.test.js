import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
process.env.ANTHROPIC_API_KEY = 'test-key';
const { pool, q } = await import('../server/db.js');
const { server } = await import('../server/index.js');
const { hashPassword } = await import('../server/auth.js');
const ai = await import('../server/ai.js');
const addr = await import('../server/address.js');

let base, owner, subAdmin, asst, pm, read, ann, bob, sub, YEAR;
let pdfN = 0; const mkPdf = () => Buffer.from('%PDF-1.4\n% sample ' + (++pdfN) + '\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
const claude = async (url, init) => { const tool = JSON.parse(init.body).tools[0].name; return { ok: true, json: async () => ({ content: [{ type: 'tool_use', name: tool, input: read }], usage: { input_tokens: 80, output_tokens: 20 } }) }; };
async function call(method, path, body, cookie, raw) {
  const r = await fetch(base + path, { method, headers: { ...(body && !raw ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(raw ? { 'x-file-name': raw } : {}) }, body: body ? (raw ? body : JSON.stringify(body)) : undefined });
  const t = await r.text(); let b = null; try { b = t ? JSON.parse(t) : null; } catch { b = t; } return { status: r.status, body: b };
}
const login = async (email) => (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct horse battery' }) })).headers.get('set-cookie').split(';')[0];
const verified = async (street, city, zip) => { const r = (await call('POST', '/api/address/verify', { street, city, state: 'FL', zip, kind: 'other' }, asst)).body; assert.equal(r.verified, true); return { ...r.address, token: r.token }; };
const w9 = (street = '12 Palm Ave', zip = '33602') => ({ documentType: 'W-9', legalName: 'Ann Marie Lopez', businessName: null, street, city: 'Tampa', state: 'FL', zip, warnings: [] });
const emps = async () => (await call('GET', '/api/admin/employees', null, asst)).body;
const rowOf = async (name) => (await emps()).find((e) => e.name === name);
const upW9 = (id, who = asst, name = 'w9.pdf') => call('POST', `/api/documents/upload?category=W-9&employeeId=${id}`, mkPdf(), who, name);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  const h = await hashPassword('correct horse battery');
  for (const [e, r] of [['owner@x.net', 'Super Admin'], ['sub@x.net', 'Sub Admin'], ['asst@x.net', 'Exec Assistant'], ['pm@x.net', 'Project Manager']]) await q('INSERT INTO app_users(email,name,role,password_hash) VALUES ($1,$1,$2,$3)', [e, r, h]);
  addr.setAddressFetch(async (url) => { const u = new URL(url); return { ok: true, json: async () => ({ result: { addressMatches: [{ addressComponents: { city: u.searchParams.get('city'), state: u.searchParams.get('state'), zip: u.searchParams.get('zip') } }] } }) }; });
  ai.setFetch(claude); read = w9();
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
  owner = await login('owner@x.net'); subAdmin = await login('sub@x.net'); asst = await login('asst@x.net'); pm = await login('pm@x.net');
  YEAR = new Date().getFullYear();
  ann = (await call('POST', '/api/admin/employees', { name: 'Ann Lopez', hourly_rate: 20 }, owner)).body.id; bob = (await call('POST', '/api/admin/employees', { name: 'Bob Reyes', hourly_rate: 30 }, owner)).body.id;
});
after(async () => { server.close(); await pool.end(); });

test('an employee has a checked address like everyone else, and without a W-9 the 1099 information is not ready', async () => {
  const r = await rowOf('Ann Lopez'); assert.deepEqual([r.tax_ready, r.address_match], [false, 'None']); assert.ok(r.tax_blockers.includes('No W-9 on file'));
  const unchecked = await call('PUT', `/api/admin/employees/${ann}`, { addr: { street: '12 Palm Ave', city: 'Tampa', state: 'FL', zip: '33602' } }, asst); assert.equal(unchecked.status, 400);   // needs the green check
  assert.equal((await call('PUT', `/api/admin/employees/${ann}`, { addr: await verified('12 Palm Ave', 'Tampa', '33602') }, asst)).status, 200);
  const a = await rowOf('Ann Lopez'); assert.deepEqual([a.address, a.city, a.state, a.zip, a.address_verified], ['12 Palm Ave', 'Tampa', 'FL', '33602', true]); assert.deepEqual(a.tax_blockers, ['No W-9 on file', 'The address on the W-9 has not been checked against this one']);
});

test('the employee W-9 is private: stored in the platform only, readable by the owner and Sub Admin, never listed or linkable; its address is read and compared', async () => {
  assert.equal((await call('POST', `/api/documents/upload?category=COI&employeeId=${ann}&expiresOn=2099-01-01`, mkPdf(), asst, 'x.pdf')).status, 400);   // only a W-9 attaches to an employee
  const up = await upW9(ann); assert.equal(up.status, 200, JSON.stringify(up.body)); assert.equal(up.body.read.address.zip, '33602'); assert.equal(up.body.sharepoint, undefined);
  const a = await rowOf('Ann Lopez'); assert.deepEqual([a.w9, a.address_match, a.tax_ready, a.w9_name], [true, 'Matched', true, 'Ann Marie Lopez']); assert.equal(a.name_note, null);   // "Ann Marie Lopez" is the same person as "Ann Lopez"
  const id = up.body.id;
  assert.equal((await fetch(base + `/api/documents/${id}/file`, { headers: { cookie: owner } })).status, 200); assert.equal((await fetch(base + `/api/documents/${id}/file`, { headers: { cookie: subAdmin } })).status, 200);
  assert.equal((await fetch(base + `/api/documents/${id}/file`, { headers: { cookie: asst } })).status, 403);   // office staff cannot open a document that holds a tax number
  assert.ok(!(await call('GET', '/api/documents', null, owner)).body.some((d) => d.id === id)); assert.ok(!(await call('GET', '/api/search/records?kind=document&q=w9', null, owner)).body.some((d) => d.id === id));
  assert.equal((await call('POST', `/api/documents/upload?category=W-9&employeeId=00000000-0000-4000-8000-000000000000`, mkPdf(), asst, 'x.pdf')).status, 404);
});

test('a W-9 that shows another address blocks it until a person confirms; the confirmation ends when the address changes; a different name is noted', async () => {
  read = { ...w9('99 Other Rd', '33603'), legalName: 'Anna Lopez-Garcia' }; await upW9(bob); assert.equal((await call('PUT', `/api/admin/employees/${bob}`, { addr: await verified('50 Elm St', 'Tampa', '33602') }, asst)).status, 200);
  let b = await rowOf('Bob Reyes'); assert.deepEqual([b.address_match, b.tax_ready], ['Mismatch', false]); assert.match(b.tax_blockers.join(';'), /does not match/); assert.match(b.name_note, /W-9 is in the name "Anna Lopez-Garcia"/);
  assert.equal((await call('POST', `/api/admin/employees/${bob}/confirm-address`, {}, pm)).status, 403);
  assert.equal((await call('POST', `/api/admin/employees/${bob}/confirm-address`, {}, asst)).status, 200); b = await rowOf('Bob Reyes'); assert.deepEqual([b.address_match, b.tax_ready], ['Confirmed', true]);
  await call('PUT', `/api/admin/employees/${bob}`, { addr: await verified('51 Elm St', 'Tampa', '33602') }, asst); assert.equal((await rowOf('Bob Reyes')).tax_ready, false);   // a changed address needs a new look
  const none = (await call('POST', '/api/admin/employees', { name: 'No Address', hourly_rate: 10 }, owner)).body.id; assert.equal((await call('POST', `/api/admin/employees/${none}/confirm-address`, {}, asst)).status, 400);
  await call('POST', `/api/admin/employees/${bob}/confirm-address`, {}, asst); await call('POST', `/api/admin/employees/${bob}/confirm-address`, { confirm: false }, asst); assert.equal((await rowOf('Bob Reyes')).address_match, 'Mismatch');
  await call('POST', `/api/admin/employees/${bob}/confirm-address`, {}, asst);
});

test('the 1099 page: what each payee was paid in the year, whether their information is complete; crew pay is for the Super Admin only; subcontractors are included', async () => {
  sub = (await call('POST', '/api/admin/subcontractors', { name: 'Rivera Framing LLC', addr: await verified('8001 S Orange Blossom Trl', 'Orlando', '32809') }, asst)).body.id;
  read = { ...w9(), legalName: 'Rivera Framing LLC', street: '8001 South Orange Blossom Trail, Suite 606', city: 'Orlando', zip: '32809' };
  await call('POST', `/api/documents/upload?category=W-9&subcontractorId=${sub}`, mkPdf(), asst, 'w9.pdf');
  const [g] = await q(`INSERT INTO gcs(name) VALUES ('GC') RETURNING id`); const [t] = await q(`INSERT INTO trades(name,sort) VALUES ('Framing',1) RETURNING id`);
  const [p] = await q(`INSERT INTO projects(name,gc_id,client,address) VALUES ('Job',$1,'C','A') RETURNING id`, [g.id]); const [pt] = await q('INSERT INTO project_trades(project_id,trade_id,original_amount) VALUES ($1,$2,90000) RETURNING id', [p.id, t.id]);
  const [sc] = await q('INSERT INTO sub_commitments(project_id,project_trade_id,subcontractor_id,contract_amount) VALUES ($1,$2,$3,20000) RETURNING id', [p.id, pt.id, sub]); const [si] = await q(`INSERT INTO sub_invoices(commitment_id,number,invoice_date,amount) VALUES ($1,'1',$2,5000) RETURNING id`, [sc.id, `${YEAR}-03-01`]);
  await q(`INSERT INTO sub_payments(sub_invoice_id,paid_date,amount) VALUES ($1,$2,3000), ($1,$3,500)`, [si.id, `${YEAR}-04-01`, `${YEAR - 1}-12-15`]);
  await q(`INSERT INTO labor_entries(project_id,employee_id,work_date,hours,rate,pay,source,import_key) VALUES ($1,$2,$3,8,20,800,'Time clock','k1'), ($1,$2,$4,8,20,200,'Time clock','k2'), ($1,$5,$3,8,30,240,'Time clock','k3')`, [p.id, ann, `${YEAR}-05-05`, `${YEAR - 1}-05-05`, bob]);
  const o = (await call('GET', `/api/tax/1099?year=${YEAR}`, null, owner)).body; const find = (rows, n) => rows.find((r) => r.name === n);
  assert.deepEqual([find(o.rows, 'Ann Lopez').paid, find(o.rows, 'Ann Lopez').ready, find(o.rows, 'Ann Lopez').over600, find(o.rows, 'Ann Lopez').type], [800, true, true, '1099 Crew']);
  assert.deepEqual([find(o.rows, 'Bob Reyes').paid, find(o.rows, 'Bob Reyes').over600], [240, false]); assert.deepEqual([find(o.rows, 'Rivera Framing LLC').paid, find(o.rows, 'Rivera Framing LLC').type, find(o.rows, 'Rivera Framing LLC').ready], [3000, 'Subcontractor', true]);
  const off = (await call('GET', `/api/tax/1099?year=${YEAR}`, null, asst)).body; assert.equal(find(off.rows, 'Ann Lopez').paid, null); assert.equal(find(off.rows, 'Rivera Framing LLC').paid, 3000);   // crew pay is the owner's
  const last = (await call('GET', `/api/tax/1099?year=${YEAR - 1}`, null, owner)).body; assert.deepEqual([find(last.rows, 'Ann Lopez').paid, find(last.rows, 'Rivera Framing LLC').paid, find(last.rows, 'Bob Reyes')], [200, 500, undefined]);
  assert.equal((await call('GET', '/api/tax/1099?year=1800', null, owner)).status, 400); assert.equal((await call('GET', '/api/tax/1099', null, pm)).status, 403);
});

test('the export has one row per payee and year with the W-9 name and address, and the same pay rules', async () => {
  const csv = async (c, y = '') => { const r = await fetch(base + '/api/tax/1099/export' + y, { headers: { cookie: c } }); return { status: r.status, text: (await r.text()).replace(/^﻿/, '') }; };
  const o = await csv(owner, `?year=${YEAR}`); assert.equal(o.status, 200); const lines = o.text.trim().split('\r\n');
  assert.equal(lines[0], 'Year,Payee,Type,Name on the W-9,Address on file,Address verified,W-9 on file,Address vs W-9,Paid in the year,$600 or more,Ready for the 1099,What is missing');
  assert.ok(lines.some((l) => /^\d+,Ann Lopez,1099 Crew,Ann Marie Lopez,"12 Palm Ave, Tampa, FL 33602",Yes,Yes,Matched,800,Yes,Yes,/.test(l))); assert.ok(lines.some((l) => /Rivera Framing LLC,Subcontractor,Rivera Framing LLC/.test(l)));
  assert.ok(!lines.some((l) => new RegExp(`^${YEAR - 1},`).test(l)));
  const off = await csv(asst, `?year=${YEAR}`); assert.ok(/Ann Lopez,1099 Crew,Ann Marie Lopez,"[^"]+",Yes,Yes,Matched,,Yes/.test(off.text) || off.text.includes('Ann Lopez,1099 Crew')); assert.ok(!/Ann Lopez[^\n]*,800,/.test(off.text));
  assert.equal((await csv(pm)).status, 403);
});
