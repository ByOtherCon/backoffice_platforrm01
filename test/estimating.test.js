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
const fu = await import('../server/followups.js');
const { todayEastern, shift, addBusinessDays } = await import('../src/lib/estimating.ts');
const today = todayEastern();

let base, owner, est, asst, pm, estId, ownerId, tDemo, tDry, tPaint;
let censusDown = false;
const census = async (url) => {
  if (censusDown) throw new Error('offline'); const u = new URL(url), street = u.searchParams.get('street');
  const hit = !/nowhere/i.test(street);
  return { ok: true, json: async () => ({ result: { addressMatches: hit ? [{ matchedAddress: `${street.toUpperCase()}, ${u.searchParams.get('city').toUpperCase()}, ${u.searchParams.get('state')}, ${u.searchParams.get('zip')}`, addressComponents: { city: u.searchParams.get('city').toUpperCase(), state: u.searchParams.get('state'), zip: u.searchParams.get('zip') } }] : [] } }) };
};
let aiReply = null;
const claude = async () => ({ ok: true, json: async () => ({ content: [{ type: 'tool_use', name: 'record_proposal', input: aiReply }], usage: { input_tokens: 900, output_tokens: 120 } }) });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  const h = await hashPassword('correct horse battery');
  for (const [e, r] of [['owner@x.net', 'Super Admin'], ['est@x.net', 'Estimator'], ['asst@x.net', 'Exec Assistant'], ['pm@x.net', 'Project Manager']]) await q('INSERT INTO app_users(email,name,role,password_hash) VALUES ($1,$2,$3,$4)', [e, e.split('@')[0], r, h]);
  await q(`UPDATE app_users SET phone='407-555-0100' WHERE email='est@x.net'`);
  addr.setAddressFetch(census); ai.setFetch(claude);
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });
async function call(method, path, body, cookie, raw) {
  const res = await fetch(base + path, { method, headers: { ...(body && !raw ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(raw ? { 'x-file-name': raw } : {}) }, body: body ? (raw ? body : JSON.stringify(body)) : undefined });
  const t = await res.text(); let b = null; try { b = t ? JSON.parse(t) : null; } catch { b = t; } return { status: res.status, body: b };
}
const login = async (email) => { const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct horse battery' }) }); return r.headers.get('set-cookie').split(';')[0]; };
// A verified address the way the form gets one: press Verify, keep the token.
const verified = async (street, city, zip, kind = 'project', state = 'FL') => { const r = (await call('POST', '/api/address/verify', { street, city, state, zip, kind }, est)).body; assert.equal(r.verified, true, JSON.stringify(r)); return { ...r.address, token: r.token }; };
const form = async (o = {}) => ({ name: 'Wingstop - St Cloud', client: 'Wingstop Restaurants', gc: 'CW Hayes Construction', addr: await verified('1200 13th St', 'St Cloud', '34769'), sourceType: 'PlanHub', estimatorId: estId, due: shift(today, 7), type: 'Restaurant', contact: 'Dana Hayes', email: 'dana@cwhayes.example', phone: '407-555-0150', ...o });
const mk = async (o) => { const r = await call('POST', '/api/opportunities', await form(o), est); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.id; };
const get = async (id) => (await call('GET', `/api/opportunities/${id}`, null, est)).body;
const status = (id, s, extra = {}, who = est) => call('POST', `/api/opportunities/${id}/status`, { status: s, ...extra }, who);
let pdfN = 0; const mkPdf = () => Buffer.from('%PDF-1.4\n% sample ' + (++pdfN) + '\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
const upload = (id, bytes = mkPdf(), name = 'Proposal.pdf', kind = 'Proposal', who = est) => call('POST', `/api/opportunities/${id}/files?kind=${kind}`, bytes, who, name);
const submit = async (id, extra = {}) => { const up = await upload(id); assert.equal(up.status, 200); return call('POST', `/api/opportunities/${id}/submissions`, { fileId: up.body.fileId, date: today, method: 'Email', prices: [{ tradeId: tDemo, amount: 25000 }, { tradeId: tDry, amount: 132000.5 }], ...extra }, est); };

test('setup and who may do what', async () => {
  owner = await login('owner@x.net'); est = await login('est@x.net'); asst = await login('asst@x.net'); pm = await login('pm@x.net');
  estId = (await q(`SELECT id FROM app_users WHERE email='est@x.net'`))[0].id; ownerId = (await q(`SELECT id FROM app_users WHERE email='owner@x.net'`))[0].id;
  tDemo = (await call('POST', '/api/admin/trades', { name: 'Demolition', sort: 1 }, owner)).body.id; tDry = (await call('POST', '/api/admin/trades', { name: 'Framing & Drywall', sort: 2 }, owner)).body.id; tPaint = (await call('POST', '/api/admin/trades', { name: 'Paint', sort: 3 }, owner)).body.id;
  assert.equal((await call('POST', '/api/opportunities', await form(), asst)).status, 403);                    // read-only for the assistant
  assert.equal((await call('GET', '/api/opportunities?tab=bids', null, asst)).status, 200); assert.equal((await call('GET', '/api/opportunities?tab=bids', null, pm)).status, 403); assert.equal((await call('GET', '/api/opportunities?tab=bids')).status, 401);
  assert.deepEqual((await call('GET', '/api/team/estimators', null, est)).body.map((u) => u.email), ['est@x.net', 'owner@x.net']);
  const o = (await call('GET', '/api/estimating/options', null, est)).body; assert.deepEqual(o.sources, ['Building Connected', 'PlanHub', 'Website', 'In-Person']); assert.deepEqual(o.projectTypes, ['Retail', 'Restaurant', 'Office / Medical / Other']); assert.equal(o.rules.declineNewDays, 2);
});

test('addresses are checked field by field, matched to a real address, and a green check cannot be faked', async () => {
  const v = (b) => call('POST', '/api/address/verify', b, est);
  const ok = (await v({ street: '1200 13th St', city: 'st cloud', state: 'FL', zip: '34769', kind: 'project' })).body; assert.deepEqual([ok.verified, ok.address.city, ok.line], [true, 'St Cloud', '1200 13th St, St Cloud, FL 34769']);
  assert.match((await v({ street: 'Main Street', city: 'Orlando', zip: '32801', kind: 'project' })).body.errors[0], /street with its number/);
  assert.match((await v({ street: '1 A St', city: 'Atlanta', state: 'GA', zip: '30301', kind: 'project' })).body.errors[0], /Florida/);
  assert.match((await v({ street: '1 A St', city: 'Orlando', zip: '90210', kind: 'project' })).body.errors[0], /not in Florida/);
  assert.match((await v({ street: '9 Nowhere Rd', city: 'Orlando', zip: '32801', kind: 'project' })).body.errors[0], /not found/);
  assert.equal((await v({ street: '1 A St', city: 'Atlanta', state: 'GA', zip: '30301', kind: 'gc' })).body.verified, true);                                  // a GC may be out of state
  censusDown = true; const down = (await v({ street: '77 Lake Ave', city: 'Orlando', zip: '32801', kind: 'project' })).body; assert.deepEqual([down.verified, down.method], [true, 'format']); assert.match(down.token, /^format\./);   // the service cannot be reached: a well-formed address is accepted automatically
  assert.match((await v({ street: '77 Lake Ave', city: 'Orlando', zip: '', kind: 'project' })).body.errors[0], /enter the 5-digit ZIP/); censusDown = false;                 // ...but a ZIP that cannot be looked up is still asked for
  // forged or reused tokens are refused
  const a = await verified('1200 13th St', 'St Cloud', '34769'); const bad1 = await call('POST', '/api/opportunities', await form({ addr: { ...a, street: '1 Other St' } }), est); assert.equal(bad1.status, 400); assert.match(bad1.body.error, /press Verify/);
  assert.equal((await call('POST', '/api/opportunities', await form({ addr: { street: '1 A St', city: 'Orlando', zip: '32801', token: 'census.AAAA' } }), est)).status, 400);
});

test('addresses: a whole address in the street box is split up, a missing ZIP is looked up, and suite numbers do not stop the match', async () => {
  const seen = []; addr.setAddressFetch(async (url) => { const u = new URL(url); seen.push(Object.fromEntries(u.searchParams)); if (/nowhere/i.test(u.searchParams.get('street'))) return { ok: true, json: async () => ({ result: { addressMatches: [] } }) }; return { ok: true, json: async () => ({ result: { addressMatches: [{ addressComponents: { city: u.searchParams.get('city').toUpperCase(), state: u.searchParams.get('state'), zip: u.searchParams.get('zip') || '32809' } }] } }) }; });
  const r = (await call('POST', '/api/address/verify', { street: '8001 South Orange Blossom Trail, Suite 606, Orlando, FL 32809', city: 'Orlando', zip: '', kind: 'project' }, est)).body;
  assert.deepEqual([r.verified, r.address.street, r.address.city, r.address.state, r.address.zip], [true, '8001 South Orange Blossom Trail, Suite 606', 'Orlando', 'FL', '32809']); assert.equal(seen[0].street, '8001 South Orange Blossom Trail');   // the suite is kept for the record but not sent to the matcher
  const z = (await call('POST', '/api/address/verify', { street: '4200 Conroy Road Space #C-196', city: 'Orlando', zip: '', kind: 'project' }, est)).body; assert.deepEqual([z.verified, z.address.zip], [true, '32809']); assert.equal(seen[1].street, '4200 Conroy Road'); assert.equal(seen[1].zip, undefined);
  const nm = await call('POST', '/api/address/verify', { street: '1 Nowhere Rd', city: 'Orlando', zip: '32801', kind: 'project' }, est); addr.setAddressFetch(census);
  assert.deepEqual([nm.body.verified, nm.body.noMatch, /^format\./.test(nm.body.token)], [false, true, true]);                // not found: the person may still use it as entered
});

test('a new opportunity: every required field, the Building Connected link rule, a hard-coded note, duplicates', async () => {
  const post = async (o) => call('POST', '/api/opportunities', await form(o), est);
  for (const [k, v, re] of [['name', '', /Project name/], ['client', '', /Client name/], ['gc', '', /GC name/], ['due', null, /due date is required/], ['estimatorId', null, /Choose the estimator/], ['type', 'Industrial', /project type/], ['sourceType', 'Billboard', /came from/], ['email', 'nope', /valid GC contact email/], ['link', 'http://x.example', /https/]]) { const r = await post({ [k]: v }); assert.equal(r.status, 400, k); assert.match(r.body.error, re, k); }
  assert.equal((await call('POST', '/api/opportunities', { ...(await form()), addr: undefined }, est)).status, 400);                                          // project address is required
  assert.equal((await post({ due: '2026-02-30' })).status, 400); assert.equal((await post({ state: 'TX' })).status, 400); assert.equal((await post({ estimatorId: '00000000-0000-0000-0000-000000000000' })).status, 400);
  const noLink = await post({ sourceType: 'Building Connected' }); assert.equal(noLink.status, 400); assert.match(noLink.body.error, /invitation link is required when the source is Building Connected/);
  const bc = await post({ name: 'BC Job', sourceType: 'Building Connected', link: 'https://app.buildingconnected.com/goto/abc' }); assert.equal(bc.status, 200);
  const ok = await post({ tradeIds: [tDemo, tDry], note: 'Spoke with Dana, wants Demo and Drywall' }); assert.equal(ok.status, 200);
  assert.equal((await post({ name: 'WINGSTOP - St Cloud' })).status, 409);                                                    // same GC, project and due date
  const o = await get(ok.body.id); assert.deepEqual([o.status, o.client, o.gc, o.sourceType, o.type, o.addrVerified, o.city, o.zip, o.tier, o.consideredTrades.map((t) => t.name), o.estimator], ['New', 'Wingstop Restaurants', 'CW Hayes Construction', 'PlanHub', 'Restaurant', true, 'St Cloud', '34769', 1, ['Demolition', 'Framing & Drywall'], 'est']);
  const system = o.notes.find((n) => n.kind === 'System'); assert.match(system.body, /^Opportunity added manually by est on .+ ET\. Source: PlanHub\.$/); assert.equal(system.who, 'est');
  assert.deepEqual(o.notes.filter((n) => n.kind === 'User').map((n) => n.body), ['Spoke with Dana, wants Demo and Drywall']);
  assert.equal((await call('POST', `/api/opportunities/${ok.body.id}/notes`, { body: 'Left a voicemail' }, est)).status, 200); assert.equal((await call('POST', `/api/opportunities/${ok.body.id}/notes`, { body: ' ' }, est)).status, 400); assert.equal((await call('POST', `/api/opportunities/${ok.body.id}/notes`, { body: 'x' }, asst)).status, 403);
  assert.equal((await get(ok.body.id)).notes[0].body, 'Left a voicemail');
});

test('the GC list fills itself in from GCs we already have; a GC address is optional but verified when given', async () => {
  const gcAddr = await verified('500 Corporate Dr', 'Orlando', '32801', 'gc');
  const id = await mk({ name: 'GC address job', gc: 'Hayes Builders', gcAddr, contact: 'Pat Hayes', email: 'pat@hayes.example', phone: '407-555-0199' });
  const known = (await call('GET', '/api/gcs/known', null, est)).body; const h = known.find((g) => g.name === 'Hayes Builders');
  assert.deepEqual([h.addr.street, h.addr.verified, h.contact, h.email, h.phone], ['500 Corporate Dr', true, 'Pat Hayes', 'pat@hayes.example', '407-555-0199']); assert.ok(known.some((g) => g.name === 'CW Hayes Construction'));
  assert.equal((await call('PUT', `/api/opportunities/${id}`, { gcAddr: { street: '500 Corporate Dr', city: 'Orlando', state: 'FL', zip: '32801' } }, est)).status, 200);   // unchanged and already verified: no new check needed
  assert.equal((await call('PUT', `/api/opportunities/${id}`, { gcAddr: { street: '600 Corporate Dr', city: 'Orlando', state: 'FL', zip: '32801' } }, est)).status, 400);   // changed: verify again
  assert.equal((await call('PUT', `/api/opportunities/${id}`, { gcAddr: { street: '', city: '', state: '', zip: '' } }, est)).status, 200); assert.equal((await get(id)).gcAddr.verified, false);
});

test('editing: changes are written into Notes, a new address needs a new green check, the link rule follows the source', async () => {
  const id = await mk({ name: 'Edit me', gc: 'Edit GC', due: shift(today, 9) });
  const newDue = shift(today, 11);
  assert.equal((await call('PUT', `/api/opportunities/${id}`, { due: newDue, type: 'Retail', phone: '407-555-0000' }, est)).status, 200);
  const o = await get(id); assert.equal(o.due, newDue); assert.match(o.notes[0].body, new RegExp(`^Edited by est\\. GC phone: 407-555-0150 → 407-555-0000; Bid due date: ${shift(today, 9)} → ${newDue}; Project type: Restaurant → Retail$`));
  assert.equal((await call('PUT', `/api/opportunities/${id}`, { due: null }, est)).status, 400);                                                       // the due date stays mandatory
  assert.equal((await call('PUT', `/api/opportunities/${id}`, { addr: { street: '9 New St', city: 'Orlando', zip: '32801' } }, est)).status, 400);
  assert.equal((await call('PUT', `/api/opportunities/${id}`, { addr: await verified('9 New St', 'Orlando', '32801') }, est)).status, 200); const m = await get(id); assert.deepEqual([m.address, m.city, m.tier], ['9 New St', 'Orlando', 1]); assert.match(m.notes[0].body, /Project street: 1200 13th St → 9 New St/);
  assert.equal((await call('PUT', `/api/opportunities/${id}`, { sourceType: 'Building Connected' }, est)).status, 400);                                  // BC needs its link
  assert.equal((await call('PUT', `/api/opportunities/${id}`, { sourceType: 'Building Connected', link: 'https://app.buildingconnected.com/goto/e1' }, est)).status, 200);
  assert.equal((await call('PUT', `/api/opportunities/${id}`, { tradeIds: [tPaint] }, est)).status, 200); assert.match((await get(id)).notes[0].body, /Trades considered: — → Paint/);
  assert.equal((await call('PUT', `/api/opportunities/${id}`, { estimatorId: ownerId }, est)).status, 200); assert.match((await get(id)).notes[0].body, /Estimator: est → owner/);
  assert.equal((await call('PUT', `/api/opportunities/${id}`, {}, est)).status, 400);
});

test('CSV import from BuildingConnected: adds new, skips non-Florida and bad dates, ignores repeats, notes where it came from', async () => {
  const csv = ['Project,Company,City,State,Bid Due,Contact Email,Invitation',
    `"Aldi - Orlando, FL",Sun Industrial Inc,Orlando,FL,${shift(today, 9)},brandon@sun.com,https://app.buildingconnected.com/a`, `Joy Child Academy,MEC General Contractors,Apopka,FL,${shift(today, 10)},,`,
    `Atlanta Store,Big GC,Atlanta,GA,${shift(today, 10)},,`, `Bad Date Job,Some GC,Tampa,FL,someday,,`, `Old Bid,Old GC,Miami,FL,${shift(today, -6)},,`].join('\n');
  let r = (await call('POST', '/api/opportunities/import', { csv, source: 'BuildingConnected' }, est)).body; assert.deepEqual([r.added, r.duplicates, r.skipped.length], [3, 0, 2]); assert.match(r.skipped.join(' '), /not in Florida/); assert.match(r.skipped.join(' '), /not a date/);
  r = (await call('POST', '/api/opportunities/import', { csv }, est)).body; assert.deepEqual([r.added, r.duplicates], [0, 3]);
  assert.equal((await call('POST', '/api/opportunities/import', { csv: 'Foo,Bar\n1,2' }, est)).status, 400); assert.equal((await call('POST', '/api/opportunities/import', { csv }, asst)).status, 403);
  const aldi = (await call('GET', '/api/opportunities?tab=bids&q=aldi', null, est)).body.groups[0].rows[0]; assert.deepEqual([aldi.sourceType, aldi.tier, aldi.client], ['Building Connected', 1, 'Sun Industrial Inc']); assert.match((await get(aldi.id)).notes[0].body, /^Imported from a CSV file by est/);
});

test('Bid Opportunities lists New only: weekly groups, old bids hidden unless asked for', async () => {
  const r = (await call('GET', '/api/opportunities?tab=bids', null, est)).body; const names = r.groups.flatMap((g) => g.rows.map((o) => o.name));
  assert.ok(names.includes('Aldi - Orlando, FL') && names.includes('Wingstop - St Cloud') && !names.includes('Old Bid')); assert.ok(r.groups.every((g) => /^Week Of |Due This Week|Missed|No Bid/.test(g.name)));
  const all = (await call('GET', '/api/opportunities?tab=bids&all=1', null, est)).body.groups.flatMap((g) => g.rows); assert.ok(all.some((o) => o.name === 'Old Bid' && o.statusLabel === 'Declined')); assert.equal((await call('GET', '/api/opportunities?tab=bids&q=aldi', null, est)).body.count, 1);
});

let wing, aldi, joy;
test('status moves: Reviewing and Accepted go to the Proposal Tracker; Accept needs a date and an estimator; reasons come from a list; everything is logged', async () => {
  const bids = (await call('GET', '/api/opportunities?tab=bids', null, est)).body.groups.flatMap((g) => g.rows); wing = bids.find((o) => o.name === 'Wingstop - St Cloud').id; aldi = bids.find((o) => o.name === 'Aldi - Orlando, FL').id; joy = bids.find((o) => o.name === 'Joy Child Academy').id;
  assert.equal((await status(joy, 'Reviewing')).status, 200); assert.equal((await get(joy)).proposalId, null);                                       // no proposal number or folders yet
  assert.deepEqual((await call('GET', '/api/opportunities?tab=bids', null, est)).body.groups.flatMap((g) => g.rows.map((o) => o.name)).includes('Joy Child Academy'), false);
  assert.ok((await call('GET', '/api/opportunities?tab=proposals', null, est)).body.rows.some((o) => o.id === joy && o.statusLabel === 'Reviewing'));
  const prefix = 'P' + today.slice(5, 7) + today.slice(8, 10);
  const a = await status(wing, 'Accepted'); assert.equal(a.status, 200); assert.equal(a.body.proposalId, prefix + '1'); assert.equal(a.body.folderPlan.folders.length, 5); assert.match(a.body.folderPlan.root, new RegExp(`^ByOther/${today.slice(0, 4)}/CW Hayes Construction/${prefix}1_Wingstop`));
  assert.equal((await status(wing, 'Accepted')).status, 400); assert.equal((await status(wing, 'New')).status, 409); assert.equal((await status(wing, 'Reviewing')).status, 409);   // accepted work cannot go back
  assert.equal((await status(aldi, 'Accepted', { estimatorId: '00000000-0000-0000-0000-000000000000' })).status, 400);
  assert.equal((await status(aldi, 'Accepted', {}, owner)).body.proposalId, prefix + '2');
  assert.equal((await status(joy, 'Accepted')).body.proposalId, prefix + '3');                                                                         // Reviewing -> Accepted assigns the number then
  // an undated lead cannot be accepted until it has a date
  const undated = (await q(`INSERT INTO opportunities(name,gc_name,city,source_key,status) VALUES ('Undated','GC X','Orlando','undated','New') RETURNING id`))[0].id;
  assert.equal((await status(undated, 'Accepted')).status, 400); assert.equal((await status(undated, 'Accepted', { due: shift(today, 3) })).status, 200);
  const fresh = await mk({ name: 'Declinable', gc: 'Other GC' });
  assert.equal((await status(fresh, 'Declined')).status, 400); assert.equal((await status(fresh, 'Declined', { reason: 'Because' })).status, 400); assert.equal((await status(fresh, 'Declined', { reason: 'Too far / outside our area', note: 'Two hours away' })).status, 200);
  const d = await get(fresh); assert.deepEqual([d.status, d.declinedReason], ['Declined', 'Too far / outside our area']); assert.match(d.notes.map((n) => n.body).join(' | '), /Status changed New → Declined by est\. Reason: Too far \/ outside our area\./); assert.ok(d.notes.some((n) => n.kind === 'User' && n.body === 'Two hours away'));
  assert.equal((await call('GET', '/api/opportunities?tab=bids', null, est)).body.groups.flatMap((g) => g.rows).some((o) => o.id === fresh), false);   // declined leaves the list...
  assert.deepEqual((await call('GET', '/api/opportunities?tab=bids&q=Declinable', null, est)).body.groups.flatMap((g) => g.rows.map((o) => o.statusLabel)), ['Declined']);   // ...but search still finds it
  assert.equal((await status(fresh, 'New')).status, 200); assert.equal((await status(wing, 'Declined', { reason: 'Too far / outside our area' })).status, 409);
  assert.equal((await status(wing, 'Started')).status, 200); assert.equal((await status(wing, 'Started')).status, 400);
  assert.equal((await status(wing, 'Submitted')).status, 400); assert.match((await status(wing, 'Submitted')).body.error, /Upload the proposal PDF/);                // submitting has its own step
  assert.equal((await status(wing, 'Awarded')).status, 409);                                                                                        // nothing submitted yet
  assert.equal((await status(aldi, 'Decided Not To Submit')).status, 400); assert.equal((await status(aldi, 'Decided Not To Submit', { reason: 'Scope not a fit' })).status, 200);
  assert.deepEqual((await call('GET', '/api/opportunities?tab=proposals', null, est)).body.counts, { Active: 3, Reviewing: 0, Accepted: 2, Started: 1, Submitted: 0, 'Decided Not To Submit': 1, All: 4 });
  assert.ok((await call('GET', '/api/opportunities?tab=proposals&filter=Decided Not To Submit', null, est)).body.rows.some((o) => o.id === aldi));
  assert.equal((await status(aldi, 'Accepted')).status, 200);                                                                                       // reopened from Decided Not To Submit; keeps its number
  assert.equal((await get(aldi)).proposalId, prefix + '2');
});

test('submitting needs the proposal PDF: it is read, the trades are checked by a person, and the PDF joins the submittal folder', async () => {
  assert.equal((await call('POST', `/api/opportunities/${wing}/submissions`, { date: today, method: 'Email', prices: [{ tradeId: tDemo, amount: 1 }] }, est)).status, 400);     // no PDF
  assert.equal((await upload(wing, Buffer.from('not a pdf'), 'x.pdf')).status, 400); assert.equal((await upload(wing, mkPdf(), 'proposal.docx')).status, 400); assert.equal((await upload(wing, mkPdf(), 'p.pdf', 'Proposal', asst)).status, 403);
  aiReply = { trades: [{ trade: 'Demolition', amount: 25000 }, { trade: 'Framing and Drywall', amount: 132000.5 }, { trade: 'Mystery work', amount: 500 }], total: 160000, warnings: ['Alternate #1 excluded'] };
  const up = (await upload(wing)).body; assert.deepEqual(up.parsed.trades.map((t) => [t.trade, t.tradeId ? 'matched' : 'unmatched', t.amount]), [['Demolition', 'matched', 25000], ['Framing and Drywall', 'matched', 132000.5], ['Mystery work', 'unmatched', 500]]);
  assert.equal(up.parsed.total, 157500.5); assert.ok(up.parsed.warnings.some((w) => /add up to 157500.50 but the printed total is 160000.00/.test(w))); assert.ok(up.parsed.warnings.includes('Alternate #1 excluded'));
  assert.equal((await q('SELECT count(*)::int n FROM opportunity_trades WHERE opportunity_id=$1', [wing]))[0].n, 0);                                                    // nothing is posted until a person confirms
  const send = (b) => call('POST', `/api/opportunities/${wing}/submissions`, { fileId: up.fileId, date: today, method: 'Email', prices: [{ tradeId: tDemo, amount: 25000 }, { tradeId: tDry, amount: 132000.5 }], ...b }, est);
  assert.equal((await send({ date: shift(today, 1) })).status, 400); assert.equal((await send({ method: 'Carrier pigeon' })).status, 400); assert.equal((await send({ prices: [{ tradeId: tDemo, amount: 0 }] })).status, 400); assert.equal((await send({ prices: [{ tradeId: tDemo, amount: 1 }, { tradeId: tDemo, amount: 2 }] })).status, 400);
  assert.equal((await send({ fileId: '00000000-0000-0000-0000-000000000000' })).status, 400);
  const s = await send({}); assert.deepEqual([s.status, s.body.version, s.body.price], [200, 1, 157000.5]); assert.equal((await send({})).status, 409);
  assert.equal((await upload(wing, mkPdf(), 'Draft2.pdf')).status, 200);                                                                                     // a second upload that is never submitted
  const o = await get(wing); assert.deepEqual([o.status, o.progress, o.countdown, o.total, o.tradePrices.map((p) => p.name), o.followup.stage, o.followup.status], ['Submitted', 'Done', 'Submitted', 157000.5, ['Demolition', 'Framing & Drywall'], 'First email', 'Active']);
  assert.deepEqual(o.files.map((f) => [f.kind, f.name]), [['Proposal', 'Proposal.pdf'], ['Proposal', 'Draft2.pdf']]); assert.match(o.notes.map((n) => n.body).join(' | '), /Bid version 1 sent .* \(Email\), 157000\.50 across 2 trades\. Follow-up case opened\./);
  const f = await fetch(`${base}/api/opportunity-files/${o.files[0].id}`, { headers: { cookie: asst } }); assert.equal(f.status, 200); assert.equal(f.headers.get('content-type'), 'application/pdf'); assert.equal((await f.arrayBuffer()).byteLength, mkPdf().length);  // anyone on the team can open it
  assert.equal((await fetch(`${base}/api/opportunity-files/${o.files[0].id}`, { headers: { cookie: pm } })).status, 403);
  assert.equal((await call('DELETE', `/api/opportunities/${wing}/files/${o.files[0].id}`, null, est)).status, 409);                                                       // a submitted mkPdf() is kept for the record
  assert.equal((await call('DELETE', `/api/opportunities/${wing}/files/${o.files[1].id}`, null, est)).status, 200);                                                        // the unused upload can go
  const extra = await upload(wing, Buffer.from('DOCX'), 'notes.txt', 'Submittal'); assert.equal(extra.status, 200); assert.equal((await get(wing)).files.length, 2);        // other files sit in the same folder list
  const sub = (await call('GET', '/api/opportunities?tab=submittals', null, est)).body.rows; assert.ok(sub.some((r) => r.id === wing && r.calendarDate === today));
});

test('AI is optional: without it the PDF is still saved and the trades are entered by hand', async () => {
  const id = await mk({ name: 'Manual proposal', gc: 'Manual GC' }); await status(id, 'Accepted'); ai.setFetch(async () => ({ ok: false, status: 500, json: async () => ({}) }));
  const up = (await upload(id)).body; assert.deepEqual([up.parsed, /could not read/.test(up.aiError)], [null, true]); ai.setFetch(claude);
  const r = await call('POST', `/api/opportunities/${id}/submissions`, { fileId: up.fileId, date: today, method: 'via BuildingConnected', prices: [{ tradeId: tPaint, amount: 4000 }] }, est); assert.equal(r.status, 200);
});

test('Follow Ups: 7 / 3 / 2 / 4 / 2 business days from the real dates, logged by a person, with the rules enforced', async () => {
  const id = await mk({ name: 'Follow me', gc: 'Follow GC', due: shift(today, 3) }); await status(id, 'Accepted'); const s = await submit(id); assert.equal(s.status, 200);
  const S = '2026-09-01', sid = (await q('SELECT id FROM submissions WHERE opportunity_id=$1', [id]))[0].id;     // submitted Tue Sep 1: first email is due Thu Sep 10 (7 business days)
  await q(`UPDATE submissions SET submitted_date=$2 WHERE id=$1`, [sid, S]); await q(`UPDATE opportunities SET start_date=$2 WHERE id=$1`, [id, '2026-08-01']);
  const log = (b, who = est) => call('POST', `/api/opportunities/${id}/followup/log`, b, who); const plan = async () => (await call('GET', `/api/opportunities/${id}/followup`, null, est)).body;
  let p = await plan(); assert.deepEqual([p.steps[0].due, p.stage, p.version], ['2026-09-10', 'First email', 1]);
  assert.match(p.drafts.email1.subject, /^Proposal follow-up \| Follow me \| P/); assert.match(p.drafts.email1.body, /^Hi Dana,/); assert.deepEqual(p.drafts.missing, []); assert.match(p.drafts.email1.body, /407-555-0100/); assert.match(p.drafts.email1.body, /1200 13th St, St Cloud, FL 34769/);
  assert.equal((await log({ kind: 'Call 1', date: '2026-09-15', outcome: 'No Answer' })).status, 400);                                                // the first email comes first
  assert.equal((await log({ kind: 'First Email Sent', date: shift(today, 1) })).status, 400); assert.equal((await log({ kind: 'First Email Sent', date: '2026-08-30' })).status, 400); assert.equal((await log({ kind: 'First Email Sent', date: '2026-09-10' }, asst)).status, 403);
  assert.equal((await log({ kind: 'First Email Sent', date: '2026-09-10' })).status, 200); assert.equal((await log({ kind: 'First Email Sent', date: '2026-09-11' })).status, 409);
  p = await plan(); assert.deepEqual([p.stage, p.steps[1].due], ['Call 1', '2026-09-15']);                                                               // 3 business days after the email was really sent
  assert.equal((await log({ kind: 'Call 1', date: '2026-09-15' })).status, 400);                                                                        // a call needs an outcome
  assert.equal((await log({ kind: 'Call 1', date: '2026-09-15', outcome: 'Answered' })).status, 400);                                                  // an answered call needs what was said
  assert.equal((await log({ kind: 'Call 1', date: '2026-09-15', outcome: 'No Answer' })).status, 200);
  const early = await log({ kind: 'Call 2', date: '2026-09-16', outcome: 'Voicemail Left' }); assert.equal(early.status, 400); assert.match(early.body.error, /at least two business days after Call 1 \(2026-09-17/);
  assert.equal((await log({ kind: 'Final Email Sent', date: '2026-09-23' })).status, 400);                                                              // both calls before the final email
  assert.equal((await log({ kind: 'Call 2', date: '2026-09-17', outcome: 'Voicemail Left' })).status, 200);
  p = await plan(); assert.deepEqual([p.stage, p.steps[3].due, p.steps[4].due], ['Final email', '2026-09-23', '2026-09-25']);
  await call('POST', `/api/opportunities/${id}/followup/pause`, { note: 'Waiting on a call back' }, est); assert.equal((await log({ kind: 'Final Email Sent', date: '2026-09-23' })).status, 409);   // paused: no outreach
  assert.equal((await call('POST', `/api/opportunities/${id}/followup/resume`, {}, est)).status, 400); assert.equal((await call('POST', `/api/opportunities/${id}/followup/resume`, { nextCheck: shift(today, -1) }, est)).status, 400);
  const day = addBusinessDays(shift(today, 6), 1); assert.equal((await call('POST', `/api/opportunities/${id}/followup/resume`, { nextCheck: day }, est)).status, 200);
  assert.equal((await log({ kind: 'Final Email Sent', date: '2026-09-23' })).status, 200);
  const closed = await fu.closeDueCases(); assert.equal(closed >= 1, true);                                                                              // 2 business days passed, no reply: closed as No Response
  p = await plan(); assert.equal(p.status, 'Closed / No Response'); assert.equal((await get(id)).status, 'Submitted');                                      // no response is not a loss
  assert.match((await get(id)).notes.map((n) => n.body).join(' | '), /closed as No Response: both emails sent, both calls completed/);
  assert.equal((await log({ kind: 'Reply Received', date: today, note: 'They called back' })).status, 200); assert.equal((await plan()).status, 'Replied / Action Needed');   // a late reply reopens it for a human, with no automatic restart
  const r = (await call('GET', '/api/followups?filter=Action Needed', null, est)).body; assert.ok(r.rows.some((x) => x.id === id)); assert.ok(r.counts['Action Needed'] >= 1);
});

test('what the GC said: awaiting award, selected, not selected', async () => {
  const mkSubmitted = async (name) => { const id = await mk({ name, gc: 'Answer GC', due: shift(today, 3) }); await status(id, 'Accepted'); await submit(id); return id; };
  const a = await mkSubmitted('Pending job'); const c = (id, b) => call('POST', `/api/opportunities/${id}/followup/classify`, b, est);
  assert.equal((await c(a, { response: 'Awaiting GC Award' })).status, 400); assert.equal((await c(a, { response: 'Awaiting GC Award', nextCheck: shift(today, -2) })).status, 400);
  const next = addBusinessDays(today, 5); assert.equal((await c(a, { response: 'Awaiting GC Award', nextCheck: next })).status, 200); const fa = (await call('GET', `/api/opportunities/${a}/followup`, null, est)).body; assert.deepEqual([fa.status, fa.nextCheck, fa.due], ['Awaiting GC Award', next, next]);
  assert.equal((await get(a)).status, 'Submitted');                                                                                                      // pending stays pending, not lost
  const sel = await mkSubmitted('Selected job'); assert.equal((await c(sel, { response: 'Selected' })).status, 200);
  assert.equal((await call('GET', `/api/opportunities/${sel}/followup`, null, est)).body.status, 'Selected / Awaiting Contract'); assert.equal((await q(`SELECT count(*)::int n FROM todos WHERE title LIKE 'Get the issued contract: Selected job%'`))[0].n, 1);
  assert.equal((await get(sel)).projectId, null);                                                                                                        // never a project from an email alone
  const lost = await mkSubmitted('Lost job'); assert.equal((await c(lost, { response: 'Not Selected' })).status, 400); assert.equal((await c(lost, { response: 'Not Selected', reason: 'Price too high' })).status, 200);
  const lo = await get(lost); assert.deepEqual([lo.status, lo.result, lo.lostReason, lo.followup.status], ['Not Awarded', 'Lost', 'Price too high', 'Not Selected / Not Won']);
  assert.equal((await c(lost, { response: 'Selected' })).status, 409); assert.equal((await c(lost, { response: 'Banana' })).status, 409);
});

test('post-submission results: Not Awarded needs a reason; No Communication From GC; reopening for revision makes a new bid version', async () => {
  const id = await mk({ name: 'Result job', gc: 'Result GC', due: shift(today, 3) }); await status(id, 'Accepted'); await submit(id);
  assert.equal((await status(id, 'Not Awarded')).status, 400); assert.equal((await status(id, 'Not Awarded', { reason: 'Price too high' })).status, 200); assert.equal((await status(id, 'No Communication')).status, 409);
  assert.equal((await status(id, 'Submitted')).status, 200); assert.equal((await status(id, 'No Communication')).status, 200); const n = await get(id); assert.deepEqual([n.statusLabel, n.result, n.followup.status], ['No Communication From GC', 'Pending', 'Closed / No Response']);
  assert.equal((await status(id, 'Submitted')).status, 200); assert.equal((await get(id)).followup.status, 'Active');
  assert.equal((await status(id, 'Started')).status, 200); assert.match((await get(id)).notes[0].body, /next proposal PDF will be bid version 2; earlier versions are kept/);   // revision
  assert.equal((await submit(id, { prices: [{ tradeId: tPaint, amount: 3500 }] })).body.version, 2);
  const r = await get(id); assert.deepEqual([r.submissions.map((s) => s.version), r.total, r.lastSubmission.price], [[1, 2], 3500, 3500]); assert.equal(r.submissions[0].trades.length, 2);   // version 1 and its trades are kept
  const cases = await q(`SELECT status FROM followup_cases WHERE opportunity_id=$1 ORDER BY created_at`, [id]); assert.deepEqual(cases.map((c) => c.status), ['Superseded', 'Active']);                // the new version starts its own cycle, the old one is cancelled
  // voiding the newest submission is recoverable and needs a reason; the earlier version becomes valid again
  const s2 = r.submissions[1].id; assert.equal((await call('POST', `/api/opportunities/${id}/submissions/${s2}/void`, {}, est)).status, 400); assert.equal((await call('POST', `/api/opportunities/${id}/submissions/${s2}/void`, { reason: 'Wrong PDF' }, est)).status, 200);
  const v = await get(id); assert.deepEqual([v.lastSubmission.version, v.total, v.status], [1, 157000.5, 'Submitted']); assert.equal(v.files.length, 2);                                                  // the mkPdf() is not deleted
  assert.equal((await call('PUT', `/api/opportunities/${id}/submissions/${v.lastSubmission.id}`, { date: shift(today, 2), method: 'PlanHub' }, est)).status, 400);
  assert.equal((await call('PUT', `/api/opportunities/${id}/submissions/${v.lastSubmission.id}`, { method: 'PlanHub', note: 'Sent through PlanHub' }, est)).status, 200); assert.match((await get(id)).notes[0].body, /Submission v1 corrected by est: method Email → PlanHub/);
});

test('awarding builds the project in Job Costing with everything gathered; it cannot be awarded twice', async () => {
  assert.equal((await status(aldi, 'Awarded')).status, 409);                                                                                              // never submitted
  const r = await status(wing, 'Awarded'); assert.equal(r.status, 200);
  const p = (await call('GET', `/api/projects/${r.body.projectId}`, null, owner)).body;
  assert.deepEqual([p.project.name, p.project.gc, p.project.client, p.project.address, p.project.proposalId, p.totals.contract, p.trades.map((t) => t.name)], ['Wingstop - St Cloud', 'CW Hayes Construction', 'Wingstop Restaurants', '1200 13th St, St Cloud, FL 34769', (await get(wing)).proposalId, 157000.5, ['Demolition', 'Framing & Drywall']]);
  assert.deepEqual(p.project.addr, { street: '1200 13th St', city: 'St Cloud', state: 'FL', zip: '34769', verified: true });   // the lead's green-checked address carries over as separate fields
  const o = (await call('GET', `/api/projects/${r.body.projectId}/origin`, null, owner)).body;
  assert.deepEqual([o.client, o.gc, o.contact, o.email, o.sourceType, o.type, o.estimator, o.submissions.length, o.submissions[0].trades.length, o.files.length > 0, o.notes.length > 3], ['Wingstop Restaurants', 'CW Hayes Construction', 'Dana Hayes', 'dana@cwhayes.example', 'PlanHub', 'Restaurant', 'est', 1, 2, true, true]);
  assert.equal((await call('GET', `/api/projects/${r.body.projectId}/origin`, null, pm)).status, 403);                                                      // a PM sees only assigned projects
  assert.equal((await status(wing, 'Awarded')).status, 400);  assert.equal((await call('DELETE', `/api/opportunities/${wing}`, null, est)).status, 404);   // no opportunity is ever deleted
  assert.equal((await call('GET', `/api/ntos?year=${today.slice(0, 4)}`, null, owner)).body[0].project, 'Wingstop - St Cloud');
  const w = await get(wing); assert.deepEqual([w.status, w.result, w.followup.status], ['Awarded', 'Awarded', 'Closed / Awarded']); assert.equal(w.projectId, r.body.projectId);
  assert.equal((await status(wing, 'Submitted')).status, 409); assert.equal((await call('PUT', `/api/opportunities/${wing}/trade-prices`, { prices: [{ tradeId: tDemo, amount: 1 }] }, est)).status, 409);
});

test('opportunities can be linked from messages and to-dos', async () => {
  const t = await call('POST', '/api/threads', { subject: 'Aldi bid', body: 'Look at this', memberIds: [], links: [{ kind: 'opportunity', id: aldi }] }, est); assert.equal(t.status, 200);
  const th = (await call('GET', `/api/threads/${t.body.id}`, null, est)).body; assert.deepEqual([th.messages[0].links[0].label, th.messages[0].links[0].route], ['Aldi - Orlando, FL', `#/estimating/${aldi}`]);
  assert.deepEqual((await call('GET', '/api/search/records?kind=opportunity&q=aldi', null, est)).body.map((r) => r.label), ['Aldi - Orlando, FL']);
});

test('insights: win rates, loss and decline reasons, realized margin vs target, expected awards (only once there is enough history)', async () => {
  const before = (await call('GET', '/api/estimating/insights', null, est)).body; assert.equal(before.enough, false);
  const bid = async (name, gc, price, result, reason) => {
    const id = await mk({ name, gc }); await status(id, 'Accepted'); assert.equal((await submit(id, { prices: [{ tradeId: tPaint, amount: price }] })).status, 200);
    if (result) { const r = await status(id, result, { reason }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.projectId; } return id;
  };
  const p1 = await bid('Job A', 'GC One', 10000, 'Awarded'); await bid('Job B', 'GC One', 12000, 'Awarded'); await bid('Job C', 'GC Two', 9000, 'Not Awarded', 'Price too high'); await bid('Job D', 'GC Two', 8000, 'Not Awarded', 'Price too high'); await bid('Job E', 'GC Three', 7000, 'Not Awarded', 'GC chose another subcontractor');
  await bid('Job F', 'GC Three', 20000, null);                                                                                                           // still waiting on a decision
  const sup = (await call('POST', '/api/admin/suppliers', { name: 'Supply Co' }, owner)).body.id; const pt = (await call('GET', `/api/projects/${p1}`, null, owner)).body.trades[0].id;
  assert.equal((await call('POST', '/api/supplier-invoices', { supplierId: sup, reference: 'X1', total: 9000, allocations: [{ projectId: p1, projectTradeId: pt, amount: 9000 }] }, owner)).status, 200);
  const i = (await call('GET', '/api/estimating/insights', null, est)).body;
  assert.equal(i.enough, true); assert.deepEqual([i.overall.won - before.overall.won, i.overall.lost - before.overall.lost], [2, 3]);
  assert.ok(i.lossReasons.some((r) => r.reason === 'Price too high' && r.n === 3)); assert.deepEqual(i.declineReasons, [{ reason: 'Auto-declined: past its bid date', n: 1 }]);
  assert.deepEqual(i.byGc.find((g) => g.name === 'GC Two'), { name: 'GC Two', bids: 2, won: 0, lost: 2, winRate: 0, avgPrice: 8500 });
  const m = i.margins.find((x) => x.trade === 'Paint'); assert.deepEqual([m.margin, m.gap], [10, 10]); assert.match(m.suggestion, /raise Paint pricing about 10 points/);
  assert.equal(i.pipeline.open >= 1, true);
  assert.equal((await call('PUT', '/api/settings/estimating', { targetMargin: 5 }, est)).status, 403); assert.equal((await call('PUT', '/api/settings/estimating', { targetMargin: 5 }, owner)).status, 200);
  assert.equal((await call('GET', '/api/estimating/insights', null, est)).body.margins.find((x) => x.trade === 'Paint').suggestion, 'On target');
});

test('an opportunity can never be deleted; BuildingConnected status is honest about needing credentials', async () => {
  const id = await mk({ name: 'Temp lead', gc: 'Temp GC' });
  assert.equal((await call('PUT', `/api/opportunities/${id}`, { status: 'Awarded' }, est)).status, 400);
  assert.equal((await call('DELETE', `/api/opportunities/${id}`, null, est)).status, 404); assert.equal((await call('GET', `/api/opportunities/${id}`, null, est)).status, 200);
  const c = (await call('GET', '/api/estimating/connection', null, est)).body.buildingConnected; assert.equal(c.connected, false); assert.match(c.note, /CSV/);
});
