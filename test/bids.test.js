import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
Object.assign(process.env, { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret', SECRET_KEY: 'a-long-test-secret-key-1234', PUBLIC_URL: 'https://desk.example', ANTHROPIC_API_KEY: 'test-key' });
const { pool, q } = await import('../server/db.js');
const { server } = await import('../server/index.js');
const { hashPassword } = await import('../server/auth.js');
const ai = await import('../server/ai.js');
const bd = await import('../server/bids.js');
const { shift, todayEastern } = await import('../src/lib/estimating.ts');
const today = todayEastern();

let base, owner, sub, est, asst;
const b64 = (s) => Buffer.from(s).toString('base64url');
const THREADS = {
  t1: { text: 'Sun Industrial Inc invited you to bid.\nProject: Aldi - Orlando (New Shell Space)\nAddress: 1401 South Hiawassee Road, Orlando, FL\nBid Due: 11/09/2026 5:00 PM EST\nContact: Brandon McMurray brandon@sunindustrial.example\nView invitation (https://app.buildingconnected.com/projects/aldi1)', hid: 'h1' },
  t2: { text: 'MEC General Contractors invited you to bid.\nProject: Aldi Orlando New Shell Space\n1401 S Hiawassee Rd, Orlando, FL\nBid Due: 11/09/2026\nContact: Craig craig@mec.example\n(https://app.buildingconnected.com/projects/aldi2)', hid: 'h2' },
  t3: { text: 'Big GC invited you to bid. Project: Atlanta Store, 5 Peachtree St, Atlanta, GA. Bid Due: 11/12/2026 (https://app.buildingconnected.com/projects/atl)', hid: 'h3' },
  t4: { text: 'Marco Contractors invited you to bid. Project: Sunglass Hut - Lutz, Premium Outlets, 2382 Grand Cypress Drive, Lutz, FL. Please send pricing soon. (https://app.buildingconnected.com/projects/sg1)', hid: 'h4' },
};
const CLAUDE = {
  t1: { name: 'Aldi - Orlando (New Shell Space)', gc: 'Sun Industrial Inc', contactName: 'Brandon McMurray', email: 'brandon@sunindustrial.example', phone: '', city: 'Orlando', state: 'FL', address: '1401 South Hiawassee Road', due: '2026-11-09', dueEvidence: 'Bid Due: 11/09/2026 5:00 PM EST', dueTime: '17:00', link: 'https://app.buildingconnected.com/projects/aldi1', type: 'Retail', mall: false, nda: false, scope: 'Interior build-out', threadId: 't1' },
  t2: { name: 'Aldi Orlando New Shell Space', gc: 'MEC General Contractors', contactName: 'Craig', email: 'craig@mec.example', phone: '', city: 'Orlando', state: 'FL', address: '1401 S Hiawassee Rd', due: '2026-11-09', dueEvidence: 'Bid Due: 11/09/2026', dueTime: '', link: 'https://app.buildingconnected.com/projects/aldi2', type: 'Retail', mall: false, nda: false, scope: '', threadId: 't2' },
  t3: { name: 'Atlanta Store', gc: 'Big GC', contactName: '', email: '', phone: '', city: 'Atlanta', state: 'GA', address: '5 Peachtree St', due: '2026-11-12', dueEvidence: 'Bid Due: 11/12/2026', dueTime: '', link: 'https://app.buildingconnected.com/projects/atl', type: 'Retail', mall: false, nda: false, scope: '', threadId: 't3' },
  // the model invents a deadline, an email address and a link that are not in the email: all three must be thrown away
  t4: { name: 'Sunglass Hut - Lutz Premium Outlets', gc: 'Marco Contractors', contactName: '', email: 'made.up@marco.example', phone: '', city: 'Lutz', state: 'FL', address: '2382 Grand Cypress Drive', due: '2026-11-20', dueEvidence: 'Bids are due 11/20/2026', dueTime: '12:00', link: 'https://evil.example/phish', type: 'Retail', mall: false, nda: false, scope: '', threadId: 't4' },
};
let gmailCalls = [], claudeCalls = 0, extraRecords = [];
const thread = (id) => ({ id, messages: [{ id: 'm' + id, internalDate: '1793000000000', payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'invites@buildingconnected.com' }, { name: 'Subject', value: 'Invitation to bid' }], body: { data: b64(THREADS[id].text) } } }] });
const googleStandIn = async (url, init = {}) => {
  const u = new URL(url), json = (o, ok = true, status = 200) => ({ ok, status, json: async () => o });
  if (u.hostname === 'oauth2.googleapis.com') { const g = new URLSearchParams(init.body).get('grant_type'); return g === 'authorization_code' ? json({ access_token: 'at1', refresh_token: 'RT-SECRET-123', expires_in: 3600 }) : json({ access_token: 'at2', expires_in: 3600 }); }
  gmailCalls.push(u.pathname + u.search);
  if (u.pathname.endsWith('/profile')) return json({ emailAddress: 'benny@byother.net' });
  if (u.pathname.endsWith('/threads')) return json({ threads: Object.entries(THREADS).map(([id, t]) => ({ id, historyId: t.hid })) });
  const m = u.pathname.match(/threads\/(t\d)$/); if (m) return json(thread(m[1]));
  return json({}, false, 404);
};
const claudeStandIn = async (url, init) => { claudeCalls++; const body = JSON.parse(init.body), prompt = body.messages[0].content.at(-1).text; const ids = [...prompt.matchAll(/=== THREAD (t\d) ===/g)].map((x) => x[1]);
  return { ok: true, json: async () => ({ content: [{ type: 'tool_use', name: 'record_bids', input: { opportunities: [...ids.map((i) => CLAUDE[i]), ...extraRecords] } }], usage: { input_tokens: 4000, output_tokens: 600 } }) }; };

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  const h = await hashPassword('correct horse battery');
  for (const [e, r] of [['owner@x.net', 'Super Admin'], ['sub@x.net', 'Sub Admin'], ['est@x.net', 'Estimator'], ['asst@x.net', 'Exec Assistant']]) await q('INSERT INTO app_users(email,name,role,password_hash) VALUES ($1,$1,$2,$3)', [e, r, h]);
  bd.setGoogleFetch(googleStandIn); ai.setFetch(claudeStandIn);
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });
async function call(method, path, body, cookie, opts = {}) {
  const res = await fetch(base + path, { method, redirect: 'manual', headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text(); let b = null; try { b = t ? JSON.parse(t) : null; } catch { b = t; } return { status: res.status, body: b, headers: res.headers };
}
const login = async (email) => { const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct horse battery' }) }); return r.headers.get('set-cookie').split(';')[0]; };
const waitIdle = async () => { for (let i = 0; i < 100 && bd.isRunning(); i++) await new Promise((r) => setTimeout(r, 50)); };
const lead = async (name) => (await q('SELECT * FROM opportunities WHERE name ILIKE $1', [name + '%']))[0];

test('setup; refreshing before Gmail is connected explains what to do', async () => {
  owner = await login('owner@x.net'); sub = await login('sub@x.net'); est = await login('est@x.net'); asst = await login('asst@x.net');
  const r = await call('POST', '/api/bids/refresh', {}, est); assert.equal(r.status, 409); assert.match(r.body.error, /not connected/i);
  const s = (await call('GET', '/api/bids/status', null, est)).body; assert.deepEqual([s.googleSetUp, s.connected, s.running], [true, false, false]);
  assert.equal((await call('POST', '/api/bids/refresh', {}, asst)).status, 403);                  // refresh is for estimators and up
});

test('connecting Gmail: only the owner, read-only access, a signed state, and the lasting key is stored encrypted', async () => {
  assert.equal((await call('GET', '/api/gmail/connect', null, sub)).status, 403);
  const u = new URL((await call('GET', '/api/gmail/connect', null, owner)).body.url);
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth'); assert.equal(u.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.readonly'); assert.equal(u.searchParams.get('access_type'), 'offline'); assert.equal(u.searchParams.get('redirect_uri'), 'https://desk.example/api/gmail/callback');
  const state = u.searchParams.get('state');
  assert.equal((await call('GET', `/api/gmail/callback?code=abc&state=${state}x`, null, owner)).status, 400);         // tampered
  assert.equal((await call('GET', `/api/gmail/callback?code=abc&state=${state}`, null, sub)).status, 403);
  const ok = await call('GET', `/api/gmail/callback?code=abc&state=${state}`, null, owner); assert.equal(ok.status, 302); assert.equal(ok.headers.get('location'), '/#/admin');
  const raw = JSON.stringify((await q(`SELECT data FROM integrations WHERE name='gmail'`))[0].data); assert.ok(!raw.includes('RT-SECRET-123')); assert.ok(raw.includes('benny@byother.net'));
  const s = (await call('GET', '/api/bids/status', null, est)).body; assert.deepEqual([s.connected, s.email], [true, 'benny@byother.net']); assert.ok(!JSON.stringify(s).includes('RT-SECRET'));
});

test('city tiers: edited by approvers, used to rank', async () => {
  assert.equal((await call('PUT', '/api/regions', { city: 'Orlando', tier: 1 }, est)).status, 403);
  assert.equal((await call('PUT', '/api/regions', { city: 'Orlando', tier: 9 }, sub)).status, 400);
  for (const [city, tier] of [['Orlando', 1], ['Lutz', 2]]) assert.equal((await call('PUT', '/api/regions', { city, tier }, sub)).status, 200);
  assert.deepEqual((await call('GET', '/api/regions', null, est)).body, [{ city: 'Orlando', tier: 1 }, { city: 'Lutz', tier: 2 }]);
});

test('Refresh reads the emails: new leads added, the same job from two GCs merged, non-Florida skipped, made-up details thrown away', async () => {
  const r = await call('POST', '/api/bids/refresh', {}, est); assert.equal(r.status, 200); await waitIdle();
  const run = (await call('GET', '/api/bids/status', null, est)).body.last; assert.deepEqual([run.status, run.trigger, run.threads, run.added, run.updated, run.skipped], ['Done', 'Manual', 4, 2, 1, 1]);
  const aldi = await lead('Aldi'); assert.deepEqual([aldi.gc_name, aldi.tier, aldi.status, aldi.due_date, aldi.due_time, aldi.invitation_link], ['Sun Industrial Inc', 1, 'New', '2026-11-09', '17:00', 'https://app.buildingconnected.com/projects/aldi1']);
  assert.equal(aldi.invitations.length, 2); assert.equal(aldi.additional_gcs, 'MEC General Contractors'); assert.match(aldi.email_link, /^https:\/\/mail\.google\.com\/mail\/u\/\?authuser=benny%40byother\.net#all\/t1$/);
  const sg = await lead('Sunglass'); assert.deepEqual([sg.due_date, sg.contact_email, sg.invitation_link, sg.tier, sg.mall], [null, null, null, 2, true]);   // no quoted deadline, no email or link in the mail, 'Premium Outlets' = shopping center
  assert.equal((await q(`SELECT count(*)::int n FROM opportunities WHERE name ILIKE 'Atlanta%'`))[0].n, 0);
  assert.equal((await q(`SELECT count(*)::int n FROM ai_usage WHERE kind='bids'`))[0].n, 1);
});

test('the list ranks and groups the new leads; a second refresh pays for nothing it has already read', async () => {
  const g = (await call('GET', '/api/opportunities?tab=bids', null, est)).body.groups; const names = g.flatMap((x) => x.rows.map((o) => o.name));
  assert.deepEqual(names, ['Aldi - Orlando (New Shell Space)', 'Sunglass Hut - Lutz Premium Outlets']);       // Tier 1 before Tier 2
  assert.ok(g.some((x) => x.name === 'No Bid Due Date Provided' && x.rows[0].name.startsWith('Sunglass')));   // undated leads stay visible
  const before = claudeCalls; await call('POST', '/api/bids/refresh', {}, est); await waitIdle();
  assert.equal(claudeCalls, before); const run = (await call('GET', '/api/bids/status', null, est)).body.last; assert.deepEqual([run.threads, run.added, run.updated], [0, 0, 0]);
  THREADS.t4.hid = 'h4b'; THREADS.t4.text += ' Bids are due 11/20/2026.'; CLAUDE.t4 = { ...CLAUDE.t4, email: '', link: 'https://app.buildingconnected.com/projects/sg1', due: '2026-11-20', dueEvidence: 'Bids are due 11/20/2026' };
  await call('POST', '/api/bids/refresh', {}, est); await waitIdle();                          // new mail on a thread: read again, and now the quoted deadline and link are accepted
  const sg = await lead('Sunglass'); assert.deepEqual([sg.due_date, sg.invitation_link], ['2026-11-20', 'https://app.buildingconnected.com/projects/sg1']);
  assert.equal((await q('SELECT count(*)::int n FROM opportunities'))[0].n, 2);                // updated in place, not duplicated
});

test('a refresh never changes work that has been accepted, but keeps the lead seen', async () => {
  const aldi = await lead('Aldi'); assert.equal((await call('POST', `/api/opportunities/${aldi.id}/accept`, {}, est)).status, 200);
  THREADS.t1.hid = 'h1b'; CLAUDE.t1 = { ...CLAUDE.t1, contactName: 'Someone Else', due: '2026-12-01', dueEvidence: 'Bid Due: 11/09/2026 5:00 PM EST' };
  await q(`UPDATE opportunities SET last_seen_at = now() - interval '5 days' WHERE id=$1`, [aldi.id]);
  await call('POST', '/api/bids/refresh', {}, est); await waitIdle(); const after = await lead('Aldi');
  assert.deepEqual([after.contact_name, after.due_date, after.status], ['Brandon McMurray', '2026-11-09', 'Bidding']); assert.ok(Date.now() - new Date(after.last_seen_at) < 60000);
});

test('Reviewing: shows in the Proposal Tracker too', async () => {
  const sg = await lead('Sunglass'); assert.equal((await call('POST', `/api/opportunities/${sg.id}/review`, {}, est)).status, 200); assert.equal((await call('POST', `/api/opportunities/${sg.id}/review`, {}, est)).status, 400);
  const bids = (await call('GET', '/api/opportunities?tab=bids', null, est)).body.groups.flatMap((g) => g.rows); assert.deepEqual(bids.map((o) => o.statusLabel), ['Reviewing']);
  const props = (await call('GET', '/api/opportunities?tab=proposals', null, est)).body.rows; assert.deepEqual(props.map((o) => o.statusLabel).sort(), ['Accepted', 'Reviewing']);
  assert.equal((await call('POST', `/api/opportunities/${sg.id}/review`, {}, asst)).status, 403);
});

test('decline rules: New one day past due, Reviewing two days, undated leads and accepted work never', async () => {
  const mk = (name, status, due, accepted = false) => q(`INSERT INTO opportunities(name,gc_name,city,due_date,status,accepted_date,source_key) VALUES ($1,'GC','Orlando',$2,$3,$4,$1) RETURNING id`, [name, due, status, accepted ? today : null]);
  await mk('R-new-due-today', 'New', today); await mk('R-new-yesterday', 'New', shift(today, -1)); await mk('R-rev-yesterday', 'Reviewing', shift(today, -1)); await mk('R-rev-2days', 'Reviewing', shift(today, -2)); await mk('R-undated-new', 'New', null); await mk('R-future', 'New', shift(today, 9)); await mk('R-accepted-late', 'Bidding', shift(today, -9), true);
  const all = (await call('GET', '/api/opportunities?tab=bids&all=1', null, est)).body.groups.flatMap((g) => g.rows); const st = (n) => all.find((o) => o.name === n)?.statusLabel;
  assert.deepEqual(['R-new-due-today', 'R-new-yesterday', 'R-rev-yesterday', 'R-rev-2days', 'R-undated-new', 'R-future'].map(st), ['New', 'Declined', 'Reviewing', 'Declined', 'New', 'New']);
  assert.equal((await lead('R-accepted-late')).status, 'Bidding');
  const d = await lead('R-new-yesterday'); assert.deepEqual([d.auto_declined, d.declined_reason], [true, 'Auto-declined: past its bid date']);
  assert.equal((await call('POST', `/api/opportunities/${d.id}/reopen`, {}, est)).status, 400);                      // would just decline again; the message says why
});

test('search reaches declined leads seen in the last 30 days, and no further back', async () => {
  const seen = async (name, days) => q(`UPDATE opportunities SET last_seen_at = now() - ($2 || ' days')::interval WHERE name=$1`, [name, String(days)]);
  await seen('R-new-yesterday', 10); await seen('R-rev-2days', 45);
  const find = async (qs) => (await call('GET', `/api/opportunities?tab=bids&q=${qs}`, null, est)).body.groups.flatMap((g) => g.rows.map((o) => o.name));
  assert.deepEqual(await find('R-new-yesterday'), ['R-new-yesterday']); assert.deepEqual(await find('R-rev-2days'), []);
  const inbox = (await call('GET', '/api/opportunities?tab=bids', null, est)).body.groups.flatMap((g) => g.rows.map((o) => o.name)); assert.ok(!inbox.includes('R-new-yesterday'));
});

test('the 8:00 and 1:00 schedule: runs in those slots once, never at other times', async () => {
  await q('DELETE FROM bid_refresh_runs'); const at = (h, m) => new Date(Date.UTC(2026, 10, 2, h + 5, m));      // Nov 2 2026 is standard time: Eastern = UTC-5
  assert.deepEqual(await bd.scheduleTick(at(7, 59)), { ran: false }); assert.deepEqual(await bd.scheduleTick(at(9, 0)), { ran: false }); assert.deepEqual(await bd.scheduleTick(at(12, 59)), { ran: false });
  assert.deepEqual(await bd.scheduleTick(at(8, 0)), { ran: true }); await waitIdle();
  assert.deepEqual(await bd.scheduleTick(at(8, 5)), { ran: false });                                           // already ran this slot
  await q('DELETE FROM bid_refresh_runs'); assert.deepEqual(await bd.scheduleTick(at(13, 4)), { ran: true }); await waitIdle();
  assert.deepEqual((await q(`SELECT trigger FROM bid_refresh_runs`)).map((r) => r.trigger), ['Scheduled']);
});

test('failures are reported, not hidden; leads already in the list are kept; settings and disconnecting', async () => {
  const before = (await q('SELECT count(*)::int n FROM opportunities'))[0].n;
  ai.setFetch(async () => ({ ok: false, status: 500, json: async () => ({}) })); THREADS.t2.hid = 'h2b';
  await call('POST', '/api/bids/refresh', {}, est); await waitIdle(); const run = (await call('GET', '/api/bids/status', null, est)).body.last; assert.equal(run.status, 'Error'); assert.match(run.error, /AI service could not read/);
  assert.equal((await q('SELECT count(*)::int n FROM opportunities'))[0].n, before); ai.setFetch(claudeStandIn);
  assert.equal((await call('PUT', '/api/bids/settings', { label: 'Building Connected' }, est)).status, 403); assert.equal((await call('PUT', '/api/bids/settings', { label: 'bad"label' }, sub)).status, 400);
  assert.equal((await call('PUT', '/api/bids/settings', { label: 'Building Connected' }, sub)).status, 200); gmailCalls = [];
  THREADS.t3.hid = 'h3b'; await call('POST', '/api/bids/refresh', {}, est); await waitIdle(); assert.ok(gmailCalls.some((c) => decodeURIComponent(c.replaceAll('+', ' ')).includes('label:"Building Connected"')));
  assert.equal((await call('DELETE', '/api/gmail', null, sub)).status, 403); assert.equal((await call('DELETE', '/api/gmail', null, owner)).status, 200); assert.equal((await call('GET', '/api/bids/status', null, est)).body.connected, false);
});
