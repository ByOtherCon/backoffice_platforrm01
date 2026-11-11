import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
process.env.ANTHROPIC_API_KEY = 'test-key';
const { pool, q } = await import('../server/db.js');
const { server } = await import('../server/index.js');
const { hashPassword } = await import('../server/auth.js');
const ai = await import('../server/ai.js');

let base, office, pm, reply = null, calls = 0;
const claude = async (url, init) => { calls++; const tool = JSON.parse(init.body).tools[0].name; return reply === 'down' ? { ok: false, status: 500, json: async () => ({}) } : { ok: true, json: async () => ({ content: [{ type: 'tool_use', name: tool, input: reply }], usage: { input_tokens: 100, output_tokens: 30 } }) }; };
let n = 0; const pdf = () => Buffer.from(`%PDF-1.4\n% vendor ${++n}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF`);
const read = async (bytes, params = {}, as = office, name = 'doc.pdf') => { const qs = new URLSearchParams(params).toString(); const r = await fetch(`${base}/api/subcontractors/read-document?${qs}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name), cookie: as }, body: bytes }); const t = await r.text(); let b = null; try { b = JSON.parse(t); } catch { b = t; } return { status: r.status, body: b }; };
const w9 = (o = {}) => ({ documentType: 'W-9', legalName: 'Luis Rivera', businessName: 'Rivera Framing LLC', street: '12 Oak St Suite 4', city: 'Orlando', state: 'FL', zip: '32801', warnings: [], ...o });
const coi = (o = {}) => ({ documentType: 'Certificate of insurance', legalName: 'Rivera Framing LLC', businessName: null, street: '12 Oak Street, Ste 4', city: 'Orlando', state: 'FL', zip: '32801', warnings: [],
  policies: [{ coverage: 'General Liability', insurer: 'Acme', policyNumber: 'GL1', effective: '2026-01-01', expires: '2027-06-30' }, { coverage: 'Workers Compensation', insurer: 'Acme', policyNumber: 'WC1', effective: '2026-01-01', expires: '2026-12-31' },
    { coverage: 'Automobile Liability', insurer: 'Acme', policyNumber: 'A1', effective: '2026-01-01', expires: '2027-03-01' }, { coverage: 'Umbrella / Excess', insurer: 'Acme', policyNumber: 'U1', effective: '2026-01-01', expires: 'not a date' }], ...o });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  const h = await hashPassword('correct horse battery');
  for (const [e, r] of [['office@x.net', 'Exec Assistant'], ['pm@x.net', 'Project Manager']]) await q('INSERT INTO app_users(email,name,role,password_hash) VALUES ($1,$2,$3,$4)', [e, e.split('@')[0], r, h]);
  ai.setFetch(claude);
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
  const login = async (email) => (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct horse battery' }) })).headers.get('set-cookie').split(';')[0];
  office = await login('office@x.net'); pm = await login('pm@x.net');
});
after(async () => { server.close(); await pool.end(); });

test('a W-9 is read as it is chosen: the address is compared with what was typed (same, different, or nothing typed yet)', async () => {
  reply = w9(); const f = pdf();
  const same = await read(f, { name: 'Rivera Framing', street: '12 Oak Street, Suite 4', city: 'Orlando', state: 'FL', zip: '32801' }); assert.equal(same.status, 200, JSON.stringify(same.body));
  assert.deepEqual([same.body.kind, same.body.addressMatch, same.body.nameDiffers, same.body.address.street], ['W-9', 'same', false, '12 Oak St Suite 4']);
  const diff = await read(pdf(), { name: 'Someone Else Inc', street: '99 Pine Ave', city: 'Tampa', state: 'FL', zip: '33602' }); assert.deepEqual([diff.body.addressMatch, diff.body.nameDiffers], ['different', true]);
  assert.equal((await read(pdf(), {})).body.addressMatch, 'none-entered');
  reply = w9({ street: null, city: null, state: null, zip: null }); const blank = await read(pdf(), { street: '1 A St', city: 'Orlando', state: 'FL', zip: '32801' }); assert.deepEqual([blank.body.addressMatch, blank.body.address], ['unreadable', null]);
  // the same file read twice asks the AI once
  reply = w9(); const before = calls; const g = pdf(); await read(g); await read(g); assert.equal(calls - before, 1);
});

test('an insurance certificate lists each coverage, and the earliest ending date is the expiration; an exemption reads its own date', async () => {
  reply = coi(); const r = await read(pdf(), { street: '12 Oak St Suite 4', city: 'Orlando', state: 'FL', zip: '32801' });
  assert.equal(r.body.kind, 'COI'); assert.equal(r.body.expires, '2026-12-31');   // workers comp ends first
  assert.deepEqual(r.body.policies.map((p) => [p.coverage, p.expires]), [['General Liability', '2027-06-30'], ['Workers Compensation', '2026-12-31'], ['Automobile Liability', '2027-03-01'], ['Umbrella / Excess', null]]);   // a date that is not a date is dropped, not guessed
  assert.equal(r.body.addressMatch, 'same');   // Oak Street, Ste 4 is the same place
  reply = { documentType: 'Workers comp exemption', legalName: 'Luis Rivera', businessName: null, street: null, city: null, state: null, zip: null, exemptionExpires: '2028-02-15', warnings: [] };
  const ex = await read(pdf(), {}); assert.deepEqual([ex.body.kind, ex.body.expires, ex.body.policies], ['Exemption', '2028-02-15', []]);
});

test('guards: only the office may read, bad files and an unreadable file are explained, and nothing is saved by reading', async () => {
  reply = w9(); assert.equal((await read(pdf(), {}, pm)).status, 403);
  assert.equal((await read(Buffer.from('MZ not a pdf'), {}, office, 'x.pdf')).status, 400);
  assert.equal((await read(pdf(), {}, office, 'x.exe')).status, 400);
  reply = 'down'; const bad = await read(pdf(), {}); assert.equal(bad.status, 200); assert.ok(bad.body.error);
  assert.equal((await q('SELECT count(*)::int n FROM documents'))[0].n, 0);
});

test('the coverages read from a certificate are kept with the saved file and shown with the subcontractor', async () => {
  reply = coi(); const f = pdf();
  const sub = (await (await fetch(`${base}/api/admin/subcontractors`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: office }, body: JSON.stringify({ name: 'Rivera Framing' }) })).json());
  const up = await fetch(`${base}/api/documents/upload?category=COI&subcontractorId=${sub.id}&expiresOn=2026-12-31`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-name': 'coi.pdf', cookie: office }, body: f }); assert.equal(up.status, 200);
  const v = (await (await fetch(`${base}/api/compliance/vendors`, { headers: { cookie: office } })).json()).find((x) => x.id === sub.id);
  assert.deepEqual(v.docs.COI.policies.map((p) => p.coverage), ['General Liability', 'Workers Compensation', 'Automobile Liability', 'Umbrella / Excess']);
  assert.equal(v.docs.COI.expires, '2026-12-31');
});
