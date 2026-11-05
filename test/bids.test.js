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
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth'); assert.equal(u.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send'); assert.equal(u.searchParams.get('access_type'), 'offline'); assert.equal(u.searchParams.get('redirect_uri'), 'https://desk.example/api/gmail/callback');
  const state = u.searchParams.get('state');
  assert.equal((await call('GET', `/api/gmail/callback?code=abc&state=${state}x`, null, owner)).status, 400);         // tampered
  assert.equal((await call('GET', `/api/gmail/callback?code=abc&state=${state}`, null, sub)).status, 403);
  const ok = await call('GET', `/api/gmail/callback?code=abc&state=${state}`, null, owner); assert.equal(ok.status, 302); assert.equal(ok.headers.get('location'), '/#/admin/connections');
  const raw = JSON.stringify((await q(`SELECT data FROM integrations WHERE name='gmail'`))[0].data); assert.ok(!raw.includes('RT-SECRET-123')); assert.ok(raw.includes('benny@byother.net'));
  const s = (await call('GET', '/api/bids/status', null, est)).body; assert.deepEqual([s.connected, s.email], [true, 'benny@byother.net']); assert.ok(!JSON.stringify(s).includes('RT-SECRET'));
});

test('city tiers: edited by approvers, used to rank', async () => {
  assert.equal((await call('PUT', '/api/regions', { city: 'Orlando', tier: 1 }, est)).status, 403);
  assert.equal((await call('PUT', '/api/regions', { city: 'Orlando', tier: 9 }, sub)).status, 400);
  const start = (await call('GET', '/api/regions', null, est)).body; const tierOf = (c) => start.find((r) => r.city === c)?.tier;
  assert.deepEqual(['Orlando', 'Ocala', 'Sarasota', 'Tampa', 'Fort Myers', 'Miami', 'Jacksonville', 'Pensacola'].map(tierOf), [1, 1, 1, 2, 2, 3, 4, 4]);   // starting lists ship with the app
  for (const [city, tier] of [['Orlando', 1], ['Lutz', 2], ['Zolfo Springs', 4]]) assert.equal((await call('PUT', '/api/regions', { city, tier }, sub)).status, 200);
  const now = (await call('GET', '/api/regions', null, est)).body; assert.deepEqual(['Orlando', 'Lutz', 'Zolfo Springs'].map((c) => now.find((r) => r.city === c)?.tier), [1, 2, 4]);
  assert.equal((await call('DELETE', '/api/regions/Zolfo%20Springs', null, sub)).status, 200);
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
  const aldi = await lead('Aldi'); assert.equal((await call('POST', `/api/opportunities/${aldi.id}/status`, { status: 'Accepted' }, est)).status, 200);
  THREADS.t1.hid = 'h1b'; CLAUDE.t1 = { ...CLAUDE.t1, contactName: 'Someone Else', due: '2026-12-01', dueEvidence: 'Bid Due: 11/09/2026 5:00 PM EST' };
  await q(`UPDATE opportunities SET last_seen_at = now() - interval '5 days' WHERE id=$1`, [aldi.id]);
  await call('POST', '/api/bids/refresh', {}, est); await waitIdle(); const after = await lead('Aldi');
  assert.deepEqual([after.contact_name, after.due_date, after.status], ['Brandon McMurray', '2026-11-09', 'Accepted']); assert.ok(Date.now() - new Date(after.last_seen_at) < 60000);
});

test('Reviewing moves to the Proposal Tracker (and out of Bid Opportunities)', async () => {
  const sg = await lead('Sunglass'); assert.equal((await call('POST', `/api/opportunities/${sg.id}/status`, { status: 'Reviewing' }, est)).status, 200); assert.equal((await call('POST', `/api/opportunities/${sg.id}/status`, { status: 'Reviewing' }, est)).status, 400);
  const bids = (await call('GET', '/api/opportunities?tab=bids', null, est)).body.groups.flatMap((g) => g.rows); assert.deepEqual(bids, []);
  const props = (await call('GET', '/api/opportunities?tab=proposals', null, est)).body.rows; assert.deepEqual(props.map((o) => o.statusLabel).sort(), ['Accepted', 'Reviewing']);
  assert.equal((await call('POST', `/api/opportunities/${sg.id}/status`, { status: 'Reviewing' }, asst)).status, 403);
  assert.equal((await q('SELECT proposal_id FROM opportunities WHERE id=$1', [sg.id]))[0].proposal_id, null);              // Reviewing does not assign a proposal number or folders
});

test('decline rules: New two days past due, Reviewing two days, undated leads never; every decline is written into Notes', async () => {
  const mk = (name, status, due, accepted = false) => q(`INSERT INTO opportunities(name,gc_name,city,due_date,status,accepted_date,source_key) VALUES ($1,'GC','Orlando',$2,$3,$4,$1) RETURNING id`, [name, due, status, accepted ? today : null]);
  await mk('R-new-due-today', 'New', today); await mk('R-new-yesterday', 'New', shift(today, -1)); await mk('R-new-2days', 'New', shift(today, -2)); await mk('R-rev-yesterday', 'Reviewing', shift(today, -1)); await mk('R-rev-2days', 'Reviewing', shift(today, -2)); await mk('R-undated-new', 'New', null); await mk('R-future', 'New', shift(today, 9)); await mk('R-accepted-late', 'Accepted', shift(today, -9), true);
  await call('GET', '/api/opportunities?tab=bids', null, est);
  const st = async (n) => (await lead(n)).status;
  assert.deepEqual(await Promise.all(['R-new-due-today', 'R-new-yesterday', 'R-new-2days', 'R-rev-yesterday', 'R-rev-2days', 'R-undated-new', 'R-future', 'R-accepted-late'].map(st)), ['New', 'New', 'Declined', 'Reviewing', 'Declined', 'New', 'New', 'Decided Not To Submit']);   // accepted work 9 days past due with nothing submitted has expired (see the clean-up test for the rest)
  const d = await lead('R-new-2days'); assert.deepEqual([d.auto_declined, d.declined_reason], [true, 'Auto-declined: past its bid date']);
  const notes = (await call('GET', `/api/opportunities/${d.id}`, null, est)).body.notes; assert.match(notes[0].body, /Status changed New → Declined by the system: its bid due date has passed\. Reason: Auto-declined: past its bid date\./);
  assert.equal((await call('POST', `/api/opportunities/${d.id}/status`, { status: 'New' }, est)).status, 400);                // would just decline again; the message says why
  assert.equal((await call('PUT', '/api/settings/estimating', { declineNewDays: 1 }, sub)).status, 200);                      // the stricter one-day rule is a setting
  await call('GET', '/api/opportunities?tab=bids', null, est); assert.equal(await st('R-new-yesterday'), 'Declined');
  assert.equal((await call('PUT', '/api/settings/estimating', { declineNewDays: 2 }, sub)).status, 200); assert.equal((await call('PUT', '/api/settings/estimating', { declineNewDays: 'x' }, sub)).status, 400);
});

test('search reaches declined leads for 30 days from the day they were declined, and no further back', async () => {
  const seen = async (name, days) => q(`UPDATE opportunities SET declined_at = now() - ($2 || ' days')::interval, last_seen_at = now() - interval '90 days' WHERE name=$1`, [name, String(days)]);   // the 30 days run from the decline, not from when the lead was last seen
  await seen('R-new-2days', 10); await seen('R-rev-2days', 45);
  const find = async (qs) => (await call('GET', `/api/opportunities?tab=bids&q=${qs}`, null, est)).body.groups.flatMap((g) => g.rows.map((o) => o.name));
  assert.deepEqual(await find('R-new-2days'), ['R-new-2days']); assert.deepEqual(await find('R-rev-2days'), []);
  const inbox = (await call('GET', '/api/opportunities?tab=bids', null, est)).body.groups.flatMap((g) => g.rows.map((o) => o.name)); assert.ok(!inbox.includes('R-new-2days'));
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

test('Gmail search follows the BuildingConnected rules: by sender and phrase, 50 newest, widen to 30 days only when nothing turns up, one retry', async () => {
  await call('PUT', '/api/bids/settings', { label: '' }, sub);
  assert.deepEqual(bd.GATHER_QUERIES(14, ''), ['from:buildingconnected.com newer_than:14d', '"invitation to bid" newer_than:14d', '"invited to bid" newer_than:14d']);
  // connect again, then make the first (14 day) searches come back empty
  const u = new URL((await call('GET', '/api/gmail/connect', null, owner)).body.url); await call('GET', `/api/gmail/callback?code=abc&state=${u.searchParams.get('state')}`, null, owner);
  gmailCalls = []; let empty = true, flaked = false;
  bd.setGoogleFetch(async (url, init) => { const x = new URL(url); if (x.pathname.endsWith('/threads') && x.searchParams.get('q')?.includes('newer_than:14d') && empty) { gmailCalls.push(x.searchParams.get('q')); return { ok: true, status: 200, json: async () => ({}) }; }
    if (x.pathname.endsWith('/threads') && x.searchParams.get('q')?.includes('newer_than:30d') && !flaked) { flaked = true; gmailCalls.push('flake'); return { ok: false, status: 503, json: async () => ({}) }; }   // a transient failure is retried once
    return googleStandIn(url, init); });
  THREADS.t1.hid = 'h1c'; await call('POST', '/api/bids/refresh', {}, est); await waitIdle();
  const qs = gmailCalls.filter((c) => c.includes('newer_than')); assert.ok(qs.some((c) => c.includes('invited to bid')) && qs.some((c) => c.includes('invitation to bid')));
  assert.ok(gmailCalls.includes('flake')); assert.equal((await call('GET', '/api/bids/status', null, est)).body.last.status, 'Done');
  assert.equal(gmailCalls.filter((c) => c.includes('newer_than:14d')).length, 3);                            // all three 14-day searches ran first; the 30-day one (which flaked once) came only after they found nothing
  bd.setGoogleFetch(googleStandIn);
});

test('NDA-locked invitations are said so, and new leads carry their audit note', async () => {
  const id = await q(`SELECT id FROM opportunities WHERE name ILIKE 'Sunglass%'`).then((r) => r[0].id);
  const notes = (await call('GET', `/api/opportunities/${id}`, null, est)).body.notes.map((n) => n.body); assert.ok(notes.some((b) => /Added from a BuildingConnected email in Gmail/.test(b)));
  const { mergeRecords } = bd; await mergeRecords([{ threadId: 'nda1', name: 'Locked Job', gc: 'Hidden GC', contact: '', email: '', phone: '', city: 'Orlando', address: '12 Locked Way', due: null, dueTime: null, link: 'https://app.buildingconnected.com/projects/locked', type: 'Retail', mall: false, scope: 'Painting', nda: true }], 'benny@byother.net');
  const locked = (await q(`SELECT id FROM opportunities WHERE name='Locked Job'`))[0].id; const ln = (await call('GET', `/api/opportunities/${locked}`, null, est)).body;
  assert.match(ln.notes.map((n) => n.body).join(' '), /locked behind an NDA/); assert.match(ln.notes.map((n) => n.body).join(' '), /No bid due date was provided/); assert.equal(ln.invitations[0].nda, true);
});

test('the GC address and the job start date come from the invitation email, only when the email really says so; trades to quote are never filled in', async () => {
  const ad = await import('../server/address.js'); ad.setAddressFetch(async (url) => { const u = new URL(url), c = (k) => u.searchParams.get(k); return { ok: true, json: async () => ({ result: { addressMatches: [{ addressComponents: { city: c('city').toUpperCase(), state: c('state'), zip: c('zip') } }] } }) }; });
  const text = 'Dunham GC invited you to bid.\nProject: Zara - Orlando\nBid Due: 11/20/2026\nStart Date: 01/12/2027\nClient Details: Dunham GC, 500 Corporate Drive, Suite 100, Tampa, FL 33602\nView this RFP (https://app.buildingconnected.com/goto/zara)';
  const rec = { threadId: 't9', name: 'Zara - Orlando', gc: 'Dunham GC', contactName: 'Pat', email: '', phone: '', city: 'Orlando', state: 'FL', address: '9 Mall Way', gcStreet: '500 Corporate Drive, Suite 100', gcCity: 'Tampa', gcState: 'FL', gcZip: '33602', gcAddressEvidence: '500 Corporate Drive, Suite 100, Tampa, FL 33602', startDate: '2027-01-12', startEvidence: 'Start Date: 01/12/2027', due: '2026-11-20', dueEvidence: 'Bid Due: 11/20/2026', dueTime: '', link: 'https://app.buildingconnected.com/goto/zara', type: 'Retail', mall: true, nda: false, scope: 'Demolition, Painting' };
  const invented = { ...rec, threadId: 't10', name: 'Invented - Orlando', gcStreet: '1 Made Up Road', gcAddressEvidence: '1 Made Up Road, Nowhere, FL', startDate: '2027-02-01', startEvidence: 'Start Date: 02/01/2027', address: '3 Mall Way' };
  const late = { ...rec, threadId: 't11', name: 'Early Start - Orlando', address: '4 Mall Way', startDate: '2026-11-01', startEvidence: 'Start Date: 01/12/2027' };
  ai.setFetch(async () => ({ ok: true, json: async () => ({ content: [{ type: 'tool_use', name: 'record_bids', input: { opportunities: [rec, invented, late] } }], usage: { input_tokens: 10, output_tokens: 5 } }) }));
  const out = await bd.extract(null, [{ id: 't9', text }, { id: 't10', text }, { id: 't11', text }]); ai.setFetch(claudeStandIn);
  const byName = (n) => out.records.find((r) => r.name === n);
  assert.deepEqual([byName('Zara - Orlando').gcAddr.street, byName('Zara - Orlando').startDate], ['500 Corporate Drive, Suite 100', '2027-01-12']);
  assert.deepEqual([byName('Invented - Orlando').gcAddr.street, byName('Invented - Orlando').startDate], ['', null]);                       // text that is not in the email is thrown away
  assert.equal(byName('Early Start - Orlando').startDate, null);                                                                               // the quoted start text does not support that date
  await bd.mergeRecords([byName('Zara - Orlando'), { ...byName('Invented - Orlando'), threadId: 't10' }], 'benny@byother.net');
  const z = await lead('Zara'), n = await lead('Invented');
  assert.deepEqual([z.gc_street, z.gc_city, z.gc_state, z.gc_zip, z.gc_address_verified, z.planned_start], ['500 Corporate Drive, Suite 100', 'Tampa', 'FL', '33602', true, '2027-01-12']);
  assert.equal((await q('SELECT count(*)::int n FROM opportunity_considered_trades WHERE opportunity_id=$1', [z.id]))[0].n, 0);               // the estimator chooses the trades, never the email
  const zn = (await call('GET', `/api/opportunities/${z.id}`, null, est)).body.notes.map((x) => x.body).join(' | '); assert.match(zn, /GC address carried over from the email: 500 Corporate Drive/); assert.match(zn, /Job start date 2027-01-12 carried over/); assert.match(zn, /Scope in the invitation: Demolition, Painting/);
  assert.equal(n.gc_street, null); assert.match((await call('GET', `/api/opportunities/${n.id}`, null, est)).body.notes.map((x) => x.body).join(' | '), /The GC address was not in the email/);
});

test('clean-up: a New lead nobody takes up is declined after 7 working days, Tier 3 and 4 leads when their week is over; Accepted work expires; every change is in Notes', async () => {
  const wd = (n) => { let d = today; while (n > 0) { d = shift(d, -1); const w = new Date(d + 'T12:00:00Z').getUTCDay(); if (w !== 0 && w !== 6) n--; } return d; };
  const { weekOf } = await import('../src/lib/estimating.ts'); const lastWeek = shift(weekOf(today), -3);   // a Friday of the previous week
  const mk = (name, tier, created, status = 'New', due = null) => q(`INSERT INTO opportunities(name,gc_name,city,tier,status,due_date,created_at,source_key,accepted_date) VALUES ($1,'GC','Orlando',$2,$3,$4,$5::date + time '12:00',$1,CASE WHEN $3 IN ('Accepted','Started') THEN $6::date END)`, [name, tier, status, due, created, today]);
  await mk('C-fresh', 2, today); await mk('C-t2-oldweek', 2, lastWeek); await mk('C-t3-oldweek', 3, lastWeek); await mk('C-t4-oldweek', 4, lastWeek); await mk('C-t3-thisweek', 3, today); await mk('C-t2-8wd', 2, wd(8)); await mk('C-t2-6wd', 2, wd(6));
  await mk('C-acc-4d', 2, wd(9), 'Accepted', shift(today, -4)); await mk('C-acc-6d', 2, wd(9), 'Accepted', shift(today, -6)); await mk('C-started-6d', 2, wd(9), 'Started', shift(today, -6)); await mk('C-acc-future', 2, wd(9), 'Accepted', shift(today, 3));
  const submitted = (await q(`INSERT INTO opportunities(name,gc_name,city,status,due_date,source_key,accepted_date) VALUES ('C-sub-6d','GC','Orlando','Accepted',$1,'c-sub',current_date) RETURNING id`, [shift(today, -6)]))[0].id;
  await q(`INSERT INTO submissions(opportunity_id,version,submitted_date,method,price) VALUES ($1,1,$2,'Email',100)`, [submitted, shift(today, -7)]);
  const rows = (await call('GET', '/api/opportunities?tab=proposals&filter=All', null, est)).body.rows; await call('GET', '/api/opportunities?tab=bids', null, est);
  const st = async (n) => (await lead(n)).status;
  assert.deepEqual(await Promise.all(['C-fresh', 'C-t2-oldweek', 'C-t3-oldweek', 'C-t4-oldweek', 'C-t3-thisweek', 'C-t2-8wd', 'C-t2-6wd'].map(st)), ['New', 'New', 'Declined', 'Declined', 'New', 'Declined', 'New']);
  assert.deepEqual(await Promise.all(['C-acc-4d', 'C-acc-6d', 'C-started-6d', 'C-acc-future', 'C-sub-6d'].map(st)), ['Accepted', 'Decided Not To Submit', 'Decided Not To Submit', 'Accepted', 'Accepted']);   // a submitted bid is never expired
  const t3 = (await call('GET', `/api/opportunities/${(await lead('C-t3-oldweek')).id}`, null, est)).body; assert.match(t3.notes[0].body, /Status changed New → Declined by the system: Tier 3 lead not taken up by the end of the week it arrived\./); assert.equal(t3.declinedReason, 'Auto-declined: Tier 3 lead not taken up by the end of the week it arrived');
  const wk = (await call('GET', `/api/opportunities/${(await lead('C-t2-8wd')).id}`, null, est)).body; assert.match(wk.notes[0].body, /no action within 7 working days of the lead arriving/i);
  const ex = (await call('GET', `/api/opportunities/${(await lead('C-acc-6d')).id}`, null, est)).body; assert.deepEqual([ex.status, ex.declinedReason], ['Decided Not To Submit', 'No action taken (lead expired)']); assert.match(ex.notes[0].body, /Status changed Accepted → Decided Not To Submit by the system: no proposal was submitted within 5 days of the bid due date/);
  // the flags the list shows: expiring from 3 days after the due date, colours by state
  const all = (await call('GET', '/api/opportunities?tab=proposals&filter=All', null, est)).body.rows; const by = (n) => all.find((o) => o.name === n);
  assert.deepEqual([by('C-acc-4d').expiry, by('C-acc-4d').tone, by('C-acc-future').expiry, by('C-acc-future').tone, by('C-sub-6d').tone], ['expiring', 'red', null, '', 'green']); void rows;
  // declined leads stay searchable for 30 days from the decline
  const found = (await call('GET', '/api/opportunities?tab=bids&q=C-t3-oldweek', null, est)).body.groups.flatMap((g) => g.rows.map((o) => o.statusLabel)); assert.deepEqual(found, ['Declined']);
});

test('the working figures are for the signed-in estimator, or the whole company on request', async () => {
  const me = (await q(`SELECT id FROM app_users WHERE email='est@x.net'`))[0].id, month = today.slice(0, 7);
  await q(`INSERT INTO opportunities(name,gc_name,city,status,estimator_id,accepted_date,due_date,source_key,proposal_id) VALUES ('M-mine','GC','Orlando','Started',$1,$2,$3,'m1','P99991'),('M-theirs','GC','Orlando','Started',$4,$2,$3,'m2','P99992'),('M-theirs2','GC','Orlando','Accepted',$4,$2,$3,'m3','P99993')`, [me, today, shift(today, 5), (await q(`SELECT id FROM app_users WHERE email='sub@x.net'`))[0].id]);
  const get = async (scope) => (await call('GET', `/api/opportunities?tab=proposals${scope ? '&scope=' + scope : ''}`, null, est)).body.stats;
  const all = await get('all'), mine = await get('mine'); assert.deepEqual([all.scope, mine.scope], ['all', 'mine']); const myWork = (await q(`SELECT count(*)::int n FROM opportunities WHERE status IN ('Accepted','Started') AND estimator_id=$1`, [me]))[0].n, allWork = (await q(`SELECT count(*)::int n FROM opportunities WHERE status IN ('Accepted','Started')`))[0].n; assert.deepEqual([mine.working, all.working], [myWork, allWork]); assert.ok(allWork - myWork >= 2);                     // my one, versus everyone's assert.equal(all.openLeads, mine.openLeads); void month;   // New leads are never split by person
});
