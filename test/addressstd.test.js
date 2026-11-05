import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
const { pool, q } = await import('../server/db.js');
const { server } = await import('../server/index.js');
const { hashPassword } = await import('../server/auth.js');
const addr = await import('../server/address.js');

let base, owner, asst, pm, emp, gc, trade;
const census = async (url) => { const u = new URL(url), street = u.searchParams.get('street'); const hit = !/nowhere/i.test(street);
  return { ok: true, json: async () => ({ result: { addressMatches: hit ? [{ matchedAddress: street, addressComponents: { city: u.searchParams.get('city').toUpperCase(), state: u.searchParams.get('state'), zip: u.searchParams.get('zip') } }] : [] } }) }; };
const call = async (method, path, body, cookie) => { const r = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); let b = null; try { b = t ? JSON.parse(t) : null; } catch { b = t; } return { status: r.status, body: b }; };
const login = async (email) => (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct horse battery' }) })).headers.get('set-cookie').split(';')[0];
const verified = async (street, city, zip, kind = 'project', state = 'FL', who = asst) => { const r = (await call('POST', '/api/address/verify', { street, city, state, zip, kind }, who)).body; assert.equal(r.verified, true, JSON.stringify(r)); return { ...r.address, token: r.token }; };

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  const h = await hashPassword('correct horse battery');
  for (const [e, r] of [['owner@x.net', 'Super Admin'], ['asst@x.net', 'Exec Assistant'], ['pm@x.net', 'Project Manager']]) await q('INSERT INTO app_users(email,name,role,password_hash) VALUES ($1,$2,$3,$4)', [e, e.split('@')[0], r, h]);
  addr.setAddressFetch(census);
  [gc] = await q(`INSERT INTO gcs(name) VALUES ('GC') RETURNING id`); [trade] = await q(`INSERT INTO trades(name,sort) VALUES ('Demo',1) RETURNING id`);
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
  owner = await login('owner@x.net'); asst = await login('asst@x.net'); pm = await login('pm@x.net');
});
after(async () => { server.close(); await pool.end(); });

test('the address box works for every office role, in three kinds: project (Florida only), GC and other (any state)', async () => {
  assert.equal((await call('POST', '/api/address/verify', { street: '1 Main St', city: 'Orlando', state: 'FL', zip: '32801', kind: 'other' }, pm)).body.verified, true);
  assert.equal((await call('POST', '/api/address/verify', { street: '1 Peachtree St', city: 'Atlanta', state: 'GA', zip: '30303', kind: 'other' }, asst)).body.verified, true);   // a vendor can be anywhere
  const fl = (await call('POST', '/api/address/verify', { street: '1 Peachtree St', city: 'Atlanta', state: 'GA', zip: '30303', kind: 'project' }, asst)).body; assert.equal(fl.verified, false); assert.match(fl.errors[0], /Florida/);
  assert.equal((await call('POST', '/api/address/verify', { street: '1 Main St', city: 'Orlando', state: 'FL', zip: '32801' })).status, 401);
});

test('a new project takes street, city, state and ZIP with the green check; the one-line address is gone from the form', async () => {
  const body = { name: 'Wingstop', gcId: gc.id, client: 'C', retainagePct: 10, trades: [{ tradeId: trade.id, amount: 1000 }] };
  const none = await call('POST', '/api/projects', { ...body, addr: {} }, asst); assert.equal(none.status, 400); assert.match(none.body.error, /Project address is required/);
  const unchecked = await call('POST', '/api/projects', { ...body, addr: { street: '1200 13th St', city: 'St Cloud', state: 'FL', zip: '34769' } }, asst); assert.equal(unchecked.status, 400); assert.match(unchecked.body.error, /Verify/);
  const out = await call('POST', '/api/projects', { ...body, addr: { street: '1200 13th St', city: 'St Cloud', state: 'GA', zip: '34769', token: 'census.fake' } }, asst); assert.equal(out.status, 400);
  const a = await verified('1200 13th St', 'St Cloud', '34769'); const r = await call('POST', '/api/projects', { ...body, addr: a }, asst); assert.equal(r.status, 200, JSON.stringify(r.body));
  const p = (await call('GET', `/api/projects/${r.body.id}`, null, asst)).body.project;
  assert.deepEqual(p.addr, { street: '1200 13th St', city: 'St Cloud', state: 'FL', zip: '34769', verified: true }); assert.equal(p.address, '1200 13th St, St Cloud, FL 34769');
  assert.equal((await call('GET', '/api/projects', null, asst)).body.find((x) => x.id === r.body.id).address, '1200 13th St, St Cloud, FL 34769');
  // a token for one address cannot be reused for another
  const other = await call('POST', '/api/projects', { ...body, name: 'Other', addr: { ...a, street: '99 Elsewhere Rd' } }, asst); assert.equal(other.status, 400);
});

test('editing a project: an unchanged checked address is kept, a changed one needs a new check, name-only edits do not touch it', async () => {
  const a = await verified('50 Oak Ave', 'Orlando', '32801'); const id = (await call('POST', '/api/projects', { name: 'Oak', gcId: gc.id, client: 'C', addr: a, trades: [{ tradeId: trade.id, amount: 500 }] }, asst)).body.id;
  assert.equal((await call('PUT', `/api/projects/${id}`, { name: 'Oak Ave Job' }, asst)).status, 200);
  assert.equal((await call('PUT', `/api/projects/${id}`, { addr: { street: '50 Oak Ave', city: 'Orlando', state: 'FL', zip: '32801' } }, asst)).status, 200);   // same address, already checked
  const moved = await call('PUT', `/api/projects/${id}`, { addr: { street: '51 Oak Ave', city: 'Orlando', state: 'FL', zip: '32801' } }, asst); assert.equal(moved.status, 400);
  const b = await verified('51 Oak Ave', 'Orlando', '32801'); assert.equal((await call('PUT', `/api/projects/${id}`, { addr: b }, asst)).status, 200);
  assert.equal((await call('GET', `/api/projects/${id}`, null, asst)).body.project.addr.street, '51 Oak Ave');
  assert.equal((await call('PUT', `/api/projects/${id}`, { addr: {} }, asst)).status, 400);   // a project always has an address
});

test('vendors and subcontractors take the same address (any state, optional); an old one-line address is split up and marked unchecked', async () => {
  const a = await verified('1 Peachtree St', 'Atlanta', '30303', 'other', 'GA');
  const v = await call('POST', '/api/admin/suppliers', { name: 'Atlanta Supply', provider_type: 'Materials', addr: a }, asst); assert.equal(v.status, 200, JSON.stringify(v.body));
  const row = (await call('GET', '/api/admin/suppliers', null, asst)).body.find((x) => x.name === 'Atlanta Supply');
  assert.deepEqual([row.address, row.city, row.state, row.zip, row.address_verified], ['1 Peachtree St', 'Atlanta', 'GA', '30303', true]);
  assert.equal((await call('POST', '/api/admin/subcontractors', { name: 'No Address Sub' }, asst)).status, 200);   // optional
  assert.equal((await call('POST', '/api/admin/subcontractors', { name: 'Unchecked Sub', addr: { street: '5 Fake St', city: 'Miami', state: 'FL', zip: '33101' } }, asst)).status, 400);
  const legacy = await call('POST', '/api/admin/subcontractors', { name: 'Old Sub', address: '8001 South Orange Blossom Trail, Suite 606, Orlando, FL 32809' }, asst); assert.equal(legacy.status, 200);
  const o = (await call('GET', '/api/admin/subcontractors', null, asst)).body.find((x) => x.name === 'Old Sub'); assert.deepEqual([o.address, o.city, o.state, o.zip, o.address_verified], ['8001 South Orange Blossom Trail, Suite 606', 'Orlando', 'FL', '32809', false]);
  assert.equal((await call('PUT', `/api/admin/subcontractors/${legacy.body.id}`, { phone: '407-555-0100' }, asst)).status, 200);   // editing the phone leaves the address alone
  assert.equal((await call('GET', '/api/admin/subcontractors', null, asst)).body.find((x) => x.name === 'Old Sub').city, 'Orlando');
  const clear = await call('PUT', `/api/admin/suppliers/${v.body.id}`, { addr: {} }, asst); assert.equal(clear.status, 200); assert.equal(clear.body.city, null);
  const fake = await call('PUT', `/api/admin/suppliers/${v.body.id}`, { address_verified: true, city: 'Nowhere' }, asst); assert.equal(fake.status, 400);   // the checked flag cannot be set directly
});

test('the old single-line project address is split in the migration and by older callers', async () => {
  const r = await call('POST', '/api/projects', { name: 'Legacy', gcId: gc.id, client: 'C', address: '10 Pine St, Tampa, FL 33602', trades: [{ tradeId: trade.id, amount: 100 }] }, asst); assert.equal(r.status, 200);
  const p = (await call('GET', `/api/projects/${r.body.id}`, null, asst)).body.project; assert.deepEqual(p.addr, { street: '10 Pine St', city: 'Tampa', state: 'FL', zip: '33602', verified: false });
  const odd = await call('POST', '/api/projects', { name: 'Odd', gcId: gc.id, client: 'C', address: 'A', trades: [{ tradeId: trade.id, amount: 100 }] }, asst); assert.equal(odd.status, 200);
  assert.equal((await call('GET', `/api/projects/${odd.body.id}`, null, asst)).body.project.addr.street, 'A');
  // the migration's text split gives the same answer
  const [m] = await q(`SELECT trim((regexp_match('8001 South Orange Blossom Trail, Suite 606, Orlando, FL 32809', '^(.+),\\s*([^,]+),\\s*([A-Za-z]{2})(?:\\s+(\\d{5})(?:-\\d{4})?)?\\.?$'))[1]) AS street`); assert.equal(m.street, '8001 South Orange Blossom Trail, Suite 606');
});
