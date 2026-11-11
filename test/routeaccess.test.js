// Every API route, tried without signing in and with a time-clock-only (employee) session. A new route that forgets its guard fails here.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
const { pool, q } = await import('../server/db.js');
const { server, _routes } = await import('../server/index.js');
const { hashPassword, COOKIE } = await import('../server/auth.js');

// Routes that are public on purpose: signing in, the Google sign-in steps, password reset, the field clock's name list and PIN sign-in, the health check.
const PUBLIC = new Set(['POST /api/login', 'GET /api/auth/options', 'GET /api/auth/google/start', 'GET /api/auth/google/callback', 'POST /api/logout', 'POST /api/password/forgot', 'GET /api/password/reset/:token', 'POST /api/password/reset', 'GET /api/clock/roster', 'POST /api/clock/login', 'GET /api/health']);
// What a time-clock-only session may use.
const FIELD = /^(GET \/api\/me|GET \/api\/clock\/home|POST \/api\/clock\/(in|out|manual)|PUT \/api\/clock\/entries\/:id|POST \/api\/clock\/entries\/:id\/request)$/;
const ID = '00000000-0000-0000-0000-000000000000';
let base, empCookie, estCookie, pmCookie;
const label = (r) => `${r.method} ${r.pattern}`;
const fill = (r) => r.pattern.replace(/:[a-z]+/gi, ID);
const hit = async (r, cookie) => { const init = { method: r.method, headers: { ...(cookie ? { cookie } : {}) } }; if (r.method !== 'GET' && r.method !== 'DELETE') { init.headers['content-type'] = r.raw ? 'application/octet-stream' : 'application/json'; init.headers['x-file-name'] = 'a.pdf'; init.body = r.raw ? Buffer.from('x') : '{}'; } return (await fetch(base + fill(r), init)).status; };

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  const h = await hashPassword('correct horse battery');
  await q(`INSERT INTO app_users(email,name,role,password_hash) VALUES ('est@x.net','E','Estimator',$1), ('pm@x.net','P','Project Manager',$1)`, [h]);
  const [emp] = await q(`INSERT INTO employees(name,phone) VALUES ('Field Guy','4075550100') RETURNING id`);
  const tok = crypto.randomBytes(24).toString('hex'); await q(`INSERT INTO sessions(token_hash, employee_id, expires_at) VALUES ($1,$2, now() + interval '1 day')`, [crypto.createHash('sha256').update(tok).digest('hex'), emp.id]); empCookie = `${COOKIE}=${tok}`;
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
  const login = async (email) => (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct horse battery' }) })).headers.get('set-cookie').split(';')[0];
  estCookie = await login('est@x.net'); pmCookie = await login('pm@x.net');
});
after(async () => { server.close(); await pool.end(); });

test('every API route refuses someone who is not signed in, except the public ones', async () => {
  assert.ok(_routes.length > 200);
  const open = [];
  for (const r of _routes) { if (PUBLIC.has(label(r))) continue; const s = await hit(r); if (s !== 401) open.push(`${s} ${label(r)}`); }
  assert.deepEqual(open, [], 'These routes answered a stranger. Add a sign-in or role check, or list them as public on purpose:\n' + open.join('\n'));
});

test('a time-clock session can use only the clock routes', async () => {
  const reach = [];
  for (const r of _routes) { if (PUBLIC.has(label(r)) || FIELD.test(label(r)) || /logout/.test(r.pattern)) continue; const s = await hit(r, empCookie); if (![401, 403].includes(s)) reach.push(`${s} ${label(r)}`); }
  assert.deepEqual(reach, [], 'A field session reached office routes:\n' + reach.join('\n'));
});

test('office-only areas stay closed to an estimator and a project manager who is on no project', async () => {
  const mustBlock = /^(GET|POST|PUT|DELETE) \/api\/(admin\/(users|access)|quickbooks|access|ai|google|microsoft|sharepoint\/test)/;
  const leaks = [];
  for (const r of _routes) { if (!mustBlock.test(label(r)) || PUBLIC.has(label(r))) continue; for (const [who, c] of [['estimator', estCookie], ['project manager', pmCookie]]) { const s = await hit(r, c); if (![401, 403].includes(s)) leaks.push(`${who} ${s} ${label(r)}`); } }
  assert.deepEqual(leaks, [], leaks.join('\n'));
  // a project manager not on the project cannot read it, whichever tab
  for (const r of _routes.filter((x) => x.method === 'GET' && /^\/api\/projects\/:id/.test(x.pattern))) { const s = await hit(r, pmCookie); assert.ok([403, 404].includes(s), `${s} ${label(r)}`); }
});

test('a project manager sees only names in the Admin lists, not addresses, phones or tax status', async () => {
  const pm = (k) => fetch(`${base}/api/admin/${k}`, { headers: { cookie: pmCookie } }).then((r) => r.json());
  await q(`INSERT INTO employees(name,phone,email,address,city,state,zip) VALUES ('Crew','4075550111','crew@x.net','1 Home St','Orlando','FL','32801')`);
  await q(`INSERT INTO subcontractors(name,email,phone,address) VALUES ('Sub Co','s@x.net','4075550122','2 Shop Rd')`);
  for (const k of ['employees', 'subcontractors']) { const rows = await pm(k); assert.ok(rows.length); for (const row of rows) assert.deepEqual(Object.keys(row).filter((x) => !['id', 'name', 'archived', 'active', 'position'].includes(x)), [], k); }
});
