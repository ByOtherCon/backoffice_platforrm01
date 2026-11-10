import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
const { pool, q } = await import('../server/db.js');
const { server } = await import('../server/index.js');
const { hashPassword } = await import('../server/auth.js');
const addr = await import('../server/address.js');
const { todayEastern, shift } = await import('../src/lib/estimating.ts');
const today = todayEastern();

let base, est, estId;
const census = async (url) => { const u = new URL(url), street = u.searchParams.get('street'); return { ok: true, json: async () => ({ result: { addressMatches: [{ matchedAddress: street, addressComponents: { city: u.searchParams.get('city').toUpperCase(), state: u.searchParams.get('state'), zip: u.searchParams.get('zip') } }] } }) }; };
const call = async (method, path, body, cookie) => { const r = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); let b = null; try { b = t ? JSON.parse(t) : null; } catch { b = t; } return { status: r.status, body: b }; };
const verified = async (street, city, zip, kind = 'project') => { const r = (await call('POST', '/api/address/verify', { street, city, state: 'FL', zip, kind }, est)).body; assert.equal(r.verified, true); return { ...r.address, token: r.token }; };

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  const h = await hashPassword('correct horse battery');
  await q('INSERT INTO app_users(email,name,role,password_hash) VALUES ($1,$2,$3,$4)', ['est@x.net', 'est', 'Estimator', h]);
  estId = (await q(`SELECT id FROM app_users WHERE email='est@x.net'`))[0].id;
  addr.setAddressFetch(census);
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
  est = (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'est@x.net', password: 'correct horse battery' }) })).headers.get('set-cookie').split(';')[0];
});
after(async () => { server.close(); await pool.end(); });

const lead = async (o) => call('POST', '/api/opportunities', { name: 'Job', client: 'C', gc: 'Hayes Builders', sourceType: 'PlanHub', estimatorId: estId, due: shift(today, 7), type: 'Restaurant', addr: await verified('1200 13th St', 'St Cloud', '34769'), ...o }, est);

test('a GC address entered on a lead is saved on the GC and comes back when that GC is picked again', async () => {
  const gcAddr = await verified('500 Corporate Dr', 'Orlando', '32801', 'gc');
  const a = await lead({ gc: 'Hayes Builders', gcAddr, contact: 'Pat Hayes', email: 'pat@hayes.example', phone: '407-555-0199' }); assert.equal(a.status, 200, JSON.stringify(a.body));
  const [g] = await q(`SELECT * FROM gcs WHERE name='Hayes Builders'`);
  assert.deepEqual([g.address, g.city, g.zip, g.address_verified, g.contact_name, g.email], ['500 Corporate Dr', 'Orlando', '32801', true, 'Pat Hayes', 'pat@hayes.example']);
  const known = (await call('GET', '/api/gcs/known', null, est)).body.find((x) => x.name === 'Hayes Builders');
  assert.deepEqual(known.addr, { street: '500 Corporate Dr', city: 'Orlando', state: 'FL', zip: '32801', verified: true }); assert.equal(known.contact, 'Pat Hayes');
  // the form fills that address in without a new check, and a second lead keeps it
  const filled = { street: known.addr.street, city: known.addr.city, state: known.addr.state, zip: known.addr.zip, verified: true };
  const b = await lead({ name: 'Second Job', gc: 'hayes builders', gcAddr: filled }); assert.equal(b.status, 200, JSON.stringify(b.body));
  const full = (await call('GET', `/api/opportunities/${b.body.id}`, null, est)).body; assert.equal(full.gcAddr.street, '500 Corporate Dr'); assert.equal(full.gcAddr.verified, true);
  // an address nobody checked is still refused
  const bad = await lead({ name: 'Third', gc: 'Hayes Builders', gcAddr: { street: '9 Fake Rd', city: 'Orlando', state: 'FL', zip: '32801' } }); assert.equal(bad.status, 400);
  assert.equal((await q(`SELECT count(*)::int AS n FROM gcs WHERE lower(name)='hayes builders'`))[0].n, 1);
});

test('editing a lead updates the GC, and Admin shows and edits a GC address and contact', async () => {
  const gcAddr = await verified('700 Main St', 'Tampa', '33602', 'gc');
  const id = (await lead({ name: 'Edit Job', gc: 'Bay Builders' })).body.id;
  assert.equal((await call('PUT', `/api/opportunities/${id}`, { gcAddr, contact: 'Lee' }, est)).status, 200);
  assert.equal((await q(`SELECT city FROM gcs WHERE name='Bay Builders'`))[0].city, 'Tampa');
  const owner = est; // Estimators may not use Admin; use a super admin
  const h = await hashPassword('correct horse battery'); await q(`INSERT INTO app_users(email,name,role,password_hash) VALUES ('boss@x.net','boss','Super Admin',$1)`, [h]);
  const boss = (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'boss@x.net', password: 'correct horse battery' }) })).headers.get('set-cookie').split(';')[0];
  const list = (await call('GET', '/api/admin/gcs', null, boss)).body.find((x) => x.name === 'Bay Builders'); assert.equal(list.address, '700 Main St'); assert.equal(list.contact_name, 'Lee');
  const a2 = await verified('1 Orange Ave', 'Orlando', '32801', 'gc');
  assert.equal((await call('PUT', `/api/admin/gcs/${list.id}`, { addr: a2, phone: '407-555-0111' }, boss)).status, 200);
  assert.equal((await call('GET', '/api/gcs/known', null, boss)).body.find((x) => x.name === 'Bay Builders').addr.street, '1 Orange Ave');
  void owner;
});

test('a lead can be added with a bid date that has already passed, and stays open', async () => {
  const r = await lead({ name: 'Late Invite', gc: 'Late GC', due: shift(today, -10) }); assert.equal(r.status, 200, JSON.stringify(r.body));
  const bids = await import('../server/bids.js'); await bids.sweepDeclines();
  const full = (await call('GET', `/api/opportunities/${r.body.id}`, null, est)).body; assert.equal(full.status, 'New'); assert.equal(full.autoDeclined, false);
});

test('moving a lead to another past date by hand keeps it open; a future date goes back to the normal rules', async () => {
  const r = await lead({ name: 'Moved Date', gc: 'Late GC', due: shift(today, -3) }); assert.equal(r.status, 200);
  assert.equal((await call('PUT', `/api/opportunities/${r.body.id}`, { due: shift(today, -5) }, est)).status, 200);
  assert.equal((await q('SELECT keep_past_due FROM opportunities WHERE id=$1', [r.body.id]))[0].keep_past_due, true);
  assert.equal((await call('PUT', `/api/opportunities/${r.body.id}`, { due: shift(today, 4) }, est)).status, 200);
  assert.equal((await q('SELECT keep_past_due FROM opportunities WHERE id=$1', [r.body.id]))[0].keep_past_due, false);
});
