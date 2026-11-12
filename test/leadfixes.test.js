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
const verified = async (street, city, zip) => { const r = (await call('POST', '/api/address/verify', { street, city, state: 'FL', zip, kind: 'project' }, est)).body; assert.equal(r.verified, true); return { ...r.address, token: r.token }; };
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  await q('INSERT INTO app_users(email,name,role,password_hash) VALUES ($1,$2,$3,$4)', ['est@x.net', 'est', 'Estimator', await hashPassword('correct horse battery')]);
  estId = (await q(`SELECT id FROM app_users WHERE email='est@x.net'`))[0].id; addr.setAddressFetch(census);
  await q(`INSERT INTO region_tiers(city,tier) VALUES ('Orlando',1),('Tampa',2) ON CONFLICT DO NOTHING`);
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
  est = (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'est@x.net', password: 'correct horse battery' }) })).headers.get('set-cookie').split(';')[0];
});
after(async () => { server.close(); await pool.end(); });
const mk = async (o) => { const r = await call('POST', '/api/opportunities', { name: 'New Balance - Orlando', client: 'C', gc: 'Hayes Builders', sourceType: 'PlanHub', estimatorId: estId, due: shift(today, 7), type: 'Retail', addr: await verified('8001 S Orange Blossom Trl', 'Orlando', '32809'), ...o }, est); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.id; };
const get = async (id) => (await call('GET', `/api/opportunities/${id}`, null, est)).body;

test('a retail store in Orlando is Tier 1, and the lead says why; changing the address or name looks again', async () => {
  const id = await mk({}); const o = await get(id); assert.equal(o.tier, 1); assert.match(o.tierNote, /Orlando: Tier 1/);
  assert.equal((await call('PUT', `/api/opportunities/${id}`, { addr: await verified('1 Main St', 'Tampa', '33602') }, est)).status, 200);
  assert.equal((await get(id)).tier, 2);
});

test('a lead whose city was typed with the state, or left out, is not silently Tier 3', async () => {
  await q(`INSERT INTO opportunities(name,gc_name,city,address,tier,status,source_key) VALUES ('New Balance Retail','GC','Orlando, FL','8001 S Orange Blossom Trl, Orlando FL',3,'New','x1'), ('Footwear Store','GC',NULL,'12 Colonial Dr, Orlando FL 32801',3,'New','x2'), ('Mystery','GC','Nowhereville',NULL,1,'New','x3')`);
  await (await import('../server/bids.js')).retier();
  const t = Object.fromEntries((await q(`SELECT name, tier, tier_note FROM opportunities`)).map((r) => [r.name, r]));
  assert.equal(t['New Balance Retail'].tier, 1); assert.equal(t['Footwear Store'].tier, 1); assert.match(t['Footwear Store'].tier_note, /No city was entered; found orlando/);
  assert.equal(t['Mystery'].tier, 3); assert.match(t['Mystery'].tier_note, /not on the city list/);
});

test('a declined lead brought back to New stays New: the clean-up counts from the day it was brought back, and the log says so', async () => {
  const id = (await q(`INSERT INTO opportunities(name,gc_name,city,tier,status,source_key,created_at,due_date,declined_reason,auto_declined,declined_at) VALUES ('Old Lead','GC','Orlando',3,'Declined','old1', now() - interval '40 days', current_date - 20, 'Auto-declined: x', true, now())  RETURNING id`))[0].id;
  assert.equal((await call('POST', `/api/opportunities/${id}/status`, { status: 'New' }, est)).status, 200);
  const sweep = (await import('../server/bids.js')).sweepDeclines; await sweep(); await sweep();
  const o = await get(id); assert.equal(o.status, 'New'); assert.equal(o.declinedReason, null);
  assert.match(o.notes.map((n) => n.body).join(' | '), /Brought back on purpose/);
});
