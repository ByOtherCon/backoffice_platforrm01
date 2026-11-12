import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
const { pool, q } = await import('../server/db.js');
const { server } = await import('../server/index.js');
const { hashPassword } = await import('../server/auth.js');
const addr = await import('../server/address.js');
const bd = await import('../server/bids.js');
const { todayEastern, shift } = await import('../src/lib/estimating.ts');
const today = todayEastern();

let base, est, estId, tDemo;
const census = async (url) => { const u = new URL(url), street = u.searchParams.get('street'); return { ok: true, json: async () => ({ result: { addressMatches: [{ matchedAddress: `${street.toUpperCase()}, ${u.searchParams.get('city').toUpperCase()}, ${u.searchParams.get('state')}, ${u.searchParams.get('zip')}`, addressComponents: { city: u.searchParams.get('city').toUpperCase(), state: u.searchParams.get('state'), zip: u.searchParams.get('zip'), fromAddress: street.toUpperCase() } }] } }) }; };
const call = async (method, path, body, cookie) => { const r = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); let b = null; try { b = t ? JSON.parse(t) : null; } catch { b = t; } return { status: r.status, body: b }; };
const lead = async (name, gc, o = {}) => (await q(`INSERT INTO opportunities(name,gc_name,client_name,city,address,tier,status,source_key,due_date,contact_name,contact_email,project_type,estimator_id,gmail_thread_id) VALUES ($1,$2,$2,$3,$4,1,$5,$6,$7,$8,$9,'Retail',$10,$11) RETURNING id`,
  [name, gc, o.city ?? 'Orlando', o.address ?? '8001 S Orange Blossom Trl', o.status ?? 'New', `k-${name}-${gc}`, o.due ?? shift(today, 9), o.contact ?? gc + ' Contact', o.email ?? null, estId, o.thread ?? null]))[0].id;
const get = async (id) => (await call('GET', `/api/opportunities/${id}`, null, est)).body;
const listIds = async () => { const r = (await call('GET', '/api/opportunities?tab=bids&all=1', null, est)).body; return r.groups.flatMap((g) => g.rows.map((x) => x.id)); };

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  await q('INSERT INTO app_users(email,name,role,password_hash) VALUES ($1,$2,$3,$4)', ['est@x.net', 'est', 'Estimator', await hashPassword('correct horse battery')]);
  estId = (await q(`SELECT id FROM app_users WHERE email='est@x.net'`))[0].id; addr.setAddressFetch(census);
  tDemo = (await q(`INSERT INTO trades(name,sort) VALUES ('Demolition',1) RETURNING id`))[0].id;
  await q(`INSERT INTO region_tiers(city,tier) VALUES ('Orlando',1) ON CONFLICT DO NOTHING`);
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
  est = (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'est@x.net', password: 'correct horse battery' }) })).headers.get('set-cookie').split(';')[0];
});
after(async () => { server.close(); await pool.end(); });

let a, b, c, other;
test('the same job under three GCs is found as one group; a different address is not pulled in', async () => {
  a = await lead('New Balance - Orlando', 'Hayes Builders'); b = await lead('New Balance Orlando', 'Moss & Associates'); c = await lead('NEW BALANCE (Orlando, FL)', 'Brasfield Gorrie', { city: 'Orlando, FL' });
  other = await lead('New Balance - Orlando Other Rd', 'Hayes Builders', { address: '5000 Other Rd', due: shift(today, 20) });
  const r = (await call('GET', '/api/opportunities/bundles', null, est)).body;
  assert.equal(r.groups.length, 1); assert.deepEqual(r.groups[0].leads.map((l) => l.gc).sort(), ['Brasfield Gorrie', 'Hayes Builders', 'Moss & Associates']);
  assert.equal(r.groups[0].blocked, null); assert.ok(!r.groups[0].leads.some((l) => l.id === other));
});

test('bundling makes one lead that lists every GC; the others are hidden, nothing is deleted, notes and files move', async () => {
  await q(`INSERT INTO opportunity_notes(opportunity_id,kind,body) VALUES ($1,'User','Call GC about the plans')`, [b]);
  await q(`INSERT INTO opportunity_files(opportunity_id,kind,name,mime,size) VALUES ($1,'Plans','plans.pdf','application/pdf',10)`, [c]);
  const before = await listIds(); assert.ok([a, b, c].every((x) => before.includes(x)));
  const r = await call('POST', '/api/opportunities/bundle', { primaryId: a, otherIds: [b, c], folderPerGc: true }, est); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.gcs, ['Hayes Builders', 'Moss & Associates', 'Brasfield Gorrie']);
  const ids = await listIds(); assert.ok(ids.includes(a) && !ids.includes(b) && !ids.includes(c));
  const o = await get(a); assert.equal(o.additionalGcs, 'Moss & Associates; Brasfield Gorrie'); assert.equal(o.folderPerGc, true); assert.equal(o.gcs.length, 3);
  assert.equal(o.invitations.length, 3); assert.ok(o.files.some((f) => f.name === 'plans.pdf')); assert.ok(o.notes.some((n) => /Call GC about the plans/.test(n.body)) && o.notes.some((n) => /Bundled by/.test(n.body)));
  assert.equal((await q('SELECT merged_into FROM opportunities WHERE id=$1', [b]))[0].merged_into, a);
  assert.equal((await get(b)).id, a);                                                                        // opening a bundled lead opens the main one
  assert.equal((await call('PUT', `/api/opportunities/${b}`, { note: 'x' }, est)).status, 409);
  assert.equal((await call('POST', `/api/opportunities/${b}/status`, { status: 'Reviewing' }, est)).status, 409);
  assert.equal((await call('GET', '/api/opportunities/bundles', null, est)).body.groups.length, 0);
  assert.equal((await call('POST', '/api/opportunities/bundle', { primaryId: a, otherIds: [b] }, est)).status, 409);   // already in a bundle
});

test('a re-sent email for a bundled GC goes to the one lead and never makes a second', async () => {
  const rec = { name: 'New Balance - Orlando', gc: 'Moss & Associates', contact: 'M', email: 'm@moss.example', phone: '', city: 'Orlando', address: '8001 S Orange Blossom Trl', due: shift(today, 9), dueTime: null, link: 'https://app.buildingconnected.com/x', threadId: 'thr-moss', mall: false, type: 'Retail', nda: false, gcAddr: {} };
  const before = (await q('SELECT count(*)::int AS n FROM opportunities'))[0].n;
  await bd.mergeRecords([rec], 'me@x.net'); await bd.mergeRecords([rec], 'me@x.net');
  assert.equal((await q('SELECT count(*)::int AS n FROM opportunities'))[0].n, before);
  assert.equal((await get(a)).invitations.length, 3);
});

test('a bundled lead can be taken back out as its own lead', async () => {
  const r = await call('POST', `/api/opportunities/${c}/unbundle`, null, est); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok((await listIds()).includes(c)); assert.equal((await get(a)).additionalGcs, 'Moss & Associates');
  assert.equal((await call('POST', `/api/opportunities/${a}/unbundle`, null, est)).status, 400);   // the main lead is not bundled into anything
  assert.equal((await call('POST', '/api/opportunities/bundle', { primaryId: a, otherIds: [c] }, est)).status, 200);
});

test('entering a job that is already on the list under another GC asks first, and can join it', async () => {
  const s = (await call('GET', '/api/opportunities/similar?name=New%20Balance%20-%20Orlando&city=Orlando&gc=Turner%20Construction&address=8001%20S%20Orange%20Blossom%20Trl', null, est)).body;
  assert.deepEqual(s.leads.map((l) => l.id), [a]); assert.equal(s.leads[0].gcs.length, 3);
  assert.deepEqual((await call('GET', '/api/opportunities/similar?name=New%20Balance%20-%20Orlando&city=Orlando&gc=Hayes%20Builders', null, est)).body.leads, []);   // that GC is already on it
  const v = (await call('POST', '/api/address/verify', { street: '8001 S Orange Blossom Trl', city: 'Orlando', state: 'FL', zip: '32809', kind: 'project' }, est)).body;
  const r = await call('POST', '/api/opportunities', { name: 'New Balance - Orlando', client: 'Turner', gc: 'Turner Construction', addr: { ...v.address, token: v.token }, sourceType: 'PlanHub', estimatorId: estId, due: shift(today, 9), type: 'Retail', bundleWith: a, folderPerGc: false }, est);
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.id, a); assert.equal(r.body.bundled, true);
  const o = await get(a); assert.equal(o.gcs.length, 4); assert.equal(o.folderPerGc, false);
  assert.equal((await call('POST', '/api/opportunities', { name: 'x', gc: 'y', bundleWith: 'nope' }, est)).status, 400);
});

test('a lead with its own proposal cannot be joined into another; the one with the submission is the main lead', async () => {
  const x = await lead('Dunkin - Kissimmee', 'GC One', { address: '10 Main St', city: 'Kissimmee', status: 'Submitted' }), y = await lead('Dunkin Kissimmee', 'GC Two', { address: '10 Main St', city: 'Kissimmee' });
  await q(`UPDATE opportunities SET proposal_id='P26901', accepted_date=$2 WHERE id=$1`, [x, today]); await q(`INSERT INTO submissions(opportunity_id,version,submitted_date,method,price) VALUES ($1,1,$2,'Email',1000)`, [x, today]);
  const g = (await call('GET', '/api/opportunities/bundles', null, est)).body.groups.find((z) => z.leads.some((l) => l.id === x)); assert.equal(g.primaryId, x);
  assert.equal((await call('POST', '/api/opportunities/bundle', { primaryId: y, otherIds: [x] }, est)).status, 409);
  assert.equal((await call('POST', '/api/opportunities/bundle', { primaryId: x, otherIds: [y] }, est)).status, 200);
});

test('awarding a job pitched to several GCs asks which GC awarded it, and the project goes to that GC', async () => {
  const id = await lead('Chipotle - Winter Park', 'GC One', { address: '77 Park Ave', city: 'Winter Park', status: 'Submitted' }), two = await lead('Chipotle Winter Park', 'GC Two', { address: '77 Park Ave', city: 'Winter Park', email: 'two@gc2.example', contact: 'Two Contact' });
  await q(`UPDATE opportunities SET proposal_id='P26902', accepted_date=$2 WHERE id=$1`, [id, today]); await q(`INSERT INTO submissions(opportunity_id,version,submitted_date,method,price) VALUES ($1,1,$2,'Email',5000)`, [id, today]);
  await q('INSERT INTO opportunity_trades(opportunity_id,trade_id,amount) VALUES ($1,$2,5000)', [id, tDemo]);
  assert.equal((await call('POST', '/api/opportunities/bundle', { primaryId: id, otherIds: [two] }, est)).status, 200);
  assert.equal((await call('POST', `/api/opportunities/${id}/status`, { status: 'Awarded' }, est)).status, 400);                      // which GC?
  assert.equal((await call('POST', `/api/opportunities/${id}/status`, { status: 'Awarded', awardedGc: 'Somebody Else' }, est)).status, 400);
  const r = await call('POST', `/api/opportunities/${id}/status`, { status: 'Awarded', awardedGc: 'GC Two' }, est); assert.equal(r.status, 200, JSON.stringify(r.body));
  const o = await get(id); assert.equal(o.status, 'Awarded'); assert.equal(o.gc, 'GC Two'); assert.equal(o.tier, 0); assert.equal(o.additionalGcs, 'GC One'); assert.equal(o.email, 'two@gc2.example');
  assert.match(o.notes.map((n) => n.body).join(' | '), /GC Two awarded it/);
  const [p] = await q('SELECT g.name AS gc, p.client FROM projects p JOIN gcs g ON g.id=p.gc_id WHERE p.id=$1', [o.projectId]); assert.equal(p.gc, 'GC Two');
});

test('a job with one GC is awarded as before, with no GC question', async () => {
  const id = await lead('Subway - Clermont', 'Solo GC', { address: '5 Lake Rd', city: 'Clermont', status: 'Submitted' });
  await q(`UPDATE opportunities SET proposal_id='P26903', accepted_date=$2 WHERE id=$1`, [id, today]); await q(`INSERT INTO submissions(opportunity_id,version,submitted_date,method,price) VALUES ($1,1,$2,'Email',900)`, [id, today]);
  await q('INSERT INTO opportunity_trades(opportunity_id,trade_id,amount) VALUES ($1,$2,900)', [id, tDemo]);
  assert.equal((await call('POST', `/api/opportunities/${id}/status`, { status: 'Awarded' }, est)).status, 200); assert.equal((await get(id)).gc, 'Solo GC');
});

test('the folder choice for a bundled job can be changed, and is written to the log', async () => {
  const r = await call('PUT', `/api/opportunities/${a}/folder-policy`, { perGc: true }, est); assert.equal(r.status, 200);
  const o = await get(a); assert.equal(o.folderPerGc, true); assert.match(o.notes.map((n) => n.body).join(' | '), /separate folder under each GC/);
  assert.equal((await call('PUT', `/api/opportunities/${c}/folder-policy`, { perGc: true }, est)).status, 409);   // c is bundled: change it on the main lead
});
