import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
const { pool, q } = await import('../server/db.js');
const { server } = await import('../server/index.js');
const { hashPassword } = await import('../server/auth.js');
const cp = await import('../server/compliance.js');
const { todayEastern, shift } = await import('../src/lib/estimating.ts');

let base, owner, sub, asst, pm, pid, demo, vendorId, bill, com;
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  const h = await hashPassword('correct horse battery');
  for (const [e, r] of [['owner@x.net', 'Super Admin'], ['sub@x.net', 'Sub Admin'], ['asst@x.net', 'Exec Assistant'], ['pm@x.net', 'Project Manager']]) await q('INSERT INTO app_users(email,name,role,password_hash) VALUES ($1,$1,$2,$3)', [e, r, h]);
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });
async function call(method, path, body, cookie) {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text(); return { status: res.status, body: t ? JSON.parse(t) : null, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
const login = async (email) => (await call('POST', '/api/login', { email, password: 'correct horse battery' })).cookie;
const doc = (category, extra = {}) => call('POST', `/api/admin/subcontractors/${vendorId}/documents`, { category, url: 'https://example.com/d.pdf', ...extra }, asst);
const pay = (cookie, amount) => call('POST', `/api/projects/${pid}/sub-bills/${bill}/payments`, { date: '2026-10-30', amount }, cookie);
const request = (cookie, amount) => call('POST', `/api/projects/${pid}/sub-bills/${bill}/payment-requests`, { amount, note: 'progress' }, cookie);

test('setup: project, a vendor with a $10,000 bill and no paperwork', async () => {
  owner = await login('owner@x.net'); sub = await login('sub@x.net'); asst = await login('asst@x.net'); pm = await login('pm@x.net');
  const t1 = (await call('POST', '/api/admin/trades', { name: 'Demolition' }, asst)).body.id; const gc = (await call('POST', '/api/admin/gcs', { name: 'GC' }, asst)).body.id;
  pid = (await call('POST', '/api/projects', { name: 'Site A', gcId: gc, client: 'C', address: 'A', trades: [{ tradeId: t1, amount: 50000 }] }, asst)).body.id;
  demo = (await call('GET', `/api/projects/${pid}`, null, asst)).body.trades[0].id;
  vendorId = (await call('POST', '/api/admin/subcontractors', { name: 'Atlas Interiors', email: 'atlas@example.com' }, asst)).body.id;
  await q(`UPDATE subcontractors SET address='1 Main St', city='Orlando', state='FL', zip='32801', address_verified=true WHERE id=$1`, [vendorId]); assert.equal((await call('POST', `/api/admin/subcontractors/${vendorId}/confirm-address`, {}, asst)).status, 200);   // a verified address that a person compared with the documents
  com = (await call('POST', `/api/projects/${pid}/commitments`, { projectTradeId: demo, subcontractorId: vendorId, contractAmount: 10000 }, asst)).body.id;
  bill = (await call('POST', `/api/projects/${pid}/commitments/${com}/bills`, { number: 'A-1', date: '2026-10-10', amount: 10000 }, asst)).body.id;
});

test('a vendor with no W-9 or insurance cannot be paid, by any route', async () => {
  const r = await pay(sub, 100); assert.equal(r.status, 409); assert.match(r.body.error, /No W-9/); assert.match(r.body.error, /certificate of insurance/);
  assert.equal((await request(asst, 100)).status, 409);
  const v = (await call('GET', '/api/compliance/vendors', null, asst)).body.find((x) => x.id === vendorId);
  assert.deepEqual([v.status, v.canPay], ['Missing', false]);
});

test('W-9 alone, then an expired COI, still block payment; a current COI unlocks it', async () => {
  assert.equal((await doc('W-9')).status, 200); assert.equal((await pay(sub, 100)).status, 409);
  assert.equal((await doc('COI')).status, 400);                                                    // COI needs an expiration date
  assert.equal((await doc('COI', { expiresOn: '2026-10-01' })).status, 200);
  const r = await pay(sub, 100); assert.equal(r.status, 409); assert.match(r.body.error, /expired 2026-10-01/);
  assert.equal((await call('POST', `/api/admin/subcontractors/${vendorId}/documents`, { category: 'COI', url: 'http://not-secure.example', expiresOn: '2027-01-01' }, asst)).status, 400);
  assert.equal((await doc('COI', { expiresOn: '2099-06-30' })).status, 200);
  assert.equal((await pay(sub, 100)).status, 200);                                                 // current COI: approver can pay directly
});

test('an exemption can replace the COI, and clearing documents blocks payment again', async () => {
  await call('DELETE', `/api/admin/subcontractors/${vendorId}/documents/COI`, null, asst);
  assert.equal((await pay(sub, 100)).status, 409);
  assert.equal((await doc('Exemption')).status, 200); assert.equal((await pay(sub, 100)).status, 200);
  await call('DELETE', `/api/admin/subcontractors/${vendorId}/documents/W-9`, null, asst);
  assert.equal((await pay(sub, 100)).status, 409);
  assert.equal((await doc('W-9')).status, 200); assert.equal((await doc('COI', { expiresOn: '2099-06-30' })).status, 200);
  await call('DELETE', `/api/admin/subcontractors/${vendorId}/documents/Exemption`, null, asst); // back to W-9 + COI only
});

test('checks and balances: the assistant requests, a different approver approves, then it is paid', async () => {
  assert.equal((await pay(asst, 100)).status, 403);                                                // Exec Assistant cannot pay directly
  assert.equal((await request(pm, 100)).status, 403);                                              // PM cannot request
  assert.equal((await request(asst, 99999)).status, 400);                                          // more than is owed
  const r = await request(asst, 2500); assert.equal(r.status, 200);
  assert.equal((await call('POST', `/api/payment-requests/${r.body.id}/approve`, {}, asst)).status, 403); // assistant cannot approve
  assert.equal((await call('POST', `/api/payment-requests/${r.body.id}/pay`, { date: '2026-10-30' }, asst)).status, 400); // not approved yet
  const note = (await call('GET', '/api/notifications', null, sub)).body; assert.ok(note.some((n) => n.title.includes('needs approval')));
  assert.equal((await call('POST', `/api/payment-requests/${r.body.id}/approve`, {}, sub)).status, 200);
  assert.ok((await call('GET', '/api/notifications', null, asst)).body.some((n) => n.title.includes('approved')));
  assert.equal((await call('POST', `/api/payment-requests/${r.body.id}/pay`, { date: '2026-10-30', reference: 'CHK 1042' }, asst)).status, 200);
  assert.equal((await call('POST', `/api/payment-requests/${r.body.id}/pay`, { date: '2026-10-30' }, asst)).status, 400); // no double pay
  const list = (await call('GET', '/api/payment-requests', null, asst)).body; assert.deepEqual([list[0].status, list[0].reference], ['Paid', 'CHK 1042']);
  const costs = (await call('GET', `/api/projects/${pid}/costs`, null, asst)).body.vendors[0]; assert.equal(costs.paid, 2700);
});

test('an approver cannot approve their own request, but the Super Admin can', async () => {
  const r = await request(sub, 1000); assert.equal(r.status, 200);
  assert.equal((await call('POST', `/api/payment-requests/${r.body.id}/approve`, {}, sub)).status, 403);
  assert.equal((await call('POST', `/api/payment-requests/${r.body.id}/approve`, {}, owner)).status, 200);
  const r2 = await request(owner, 500);
  assert.equal((await call('POST', `/api/payment-requests/${r2.body.id}/approve`, {}, owner)).status, 200);
  assert.equal((await call('POST', `/api/payment-requests/${r2.body.id}/reject`, { reason: 'x' }, asst)).status, 403);
});

test('requests reserve the amount; rejecting needs a reason; cancelling frees it', async () => {
  const before = (await call('GET', `/api/projects/${pid}/costs`, null, asst)).body.vendors[0];
  const avail = before.availableToPay - 1500; // 1000 + 500 are approved but unpaid
  assert.equal((await request(asst, avail + 1)).status, 400);
  const r = await request(asst, avail); assert.equal(r.status, 200);
  assert.equal((await call('POST', `/api/payment-requests/${r.body.id}/reject`, {}, sub)).status, 400);
  assert.equal((await call('POST', `/api/payment-requests/${r.body.id}/reject`, { reason: 'Waiting on lien waiver' }, sub)).status, 200);
  assert.equal((await call('GET', '/api/payment-requests?status=Rejected', null, asst)).body[0].rejectReason, 'Waiting on lien waiver');
  const r3 = await request(asst, 10); assert.equal((await call('DELETE', `/api/payment-requests/${r3.body.id}`, null, asst)).status, 200);
});

test('insurance that lapses after approval blocks the payment', async () => {
  const approved = (await call('GET', '/api/payment-requests?status=Approved', null, asst)).body[0];
  await q(`UPDATE documents SET expires_on='2026-01-01' WHERE category='COI'`);
  const r = await call('POST', `/api/payment-requests/${approved.id}/pay`, { date: '2026-10-30' }, asst); assert.equal(r.status, 409); assert.match(r.body.error, /cannot be paid/);
  await q(`UPDATE documents SET expires_on='2099-06-30' WHERE category='COI'`);
  assert.equal((await call('POST', `/api/payment-requests/${approved.id}/pay`, { date: '2026-10-30' }, asst)).status, 200);
});

test('expiry scan: alerts the team and queues a vendor email only while the vendor is on an active project; no duplicates', async () => {
  await q(`UPDATE documents SET expires_on='2026-11-10' WHERE category='COI'`);
  let r = await cp.scan('2026-10-31'); assert.equal(r.emails, 1); assert.ok(r.notified >= 3);
  const note = (await call('GET', '/api/notifications', null, owner)).body.find((n) => n.kind === 'compliance'); assert.match(note.title, /Atlas Interiors: insurance expires in 10 days/);
  const out = (await call('GET', '/api/outbox', null, asst)).body; assert.equal(out.connected, false); assert.equal(out.emails[0].to_email, 'atlas@example.com'); assert.equal(out.emails[0].status, 'Queued');
  r = await cp.scan('2026-10-31'); assert.deepEqual(r, { notified: 0, emails: 0 });                    // same day again: nothing new
  r = await cp.scan('2026-11-05'); assert.equal(r.emails, 1);                                           // 5 days left: the 7-day reminder is its own stage
});

test('after it lapses the vendor is flagged weekly, and nothing is sent once they are off every active project', async () => {
  await q(`UPDATE documents SET expires_on='2026-10-01' WHERE category='COI'`);
  let r = await cp.scan('2026-11-05'); assert.equal(r.emails, 1); assert.ok(r.notified >= 3);
  assert.deepEqual(await cp.scan('2026-11-06'), { notified: 0, emails: 0 });                           // same week
  r = await cp.scan('2026-11-13'); assert.equal(r.emails, 1);                                           // next week
  assert.ok((await call('GET', '/api/notifications', null, owner)).body.some((n) => /insurance has lapsed/.test(n.title)));
  await q(`UPDATE projects SET active=false`);
  assert.deepEqual(await cp.scan('2026-11-20'), { notified: 0, emails: 0 });
  await q(`UPDATE projects SET active=true`);
});

test('email outbox: sends through the configured transport, records failures, and can retry', async () => {
  assert.equal((await call('POST', '/api/outbox/send', {}, asst)).status, 403);
  assert.deepEqual(await cp.sendQueued(), { sent: 0, failed: 0, connected: false });
  cp.setTransport(nodemailer.createTransport({ jsonTransport: true }));
  const r = await call('POST', '/api/outbox/send', {}, sub); assert.equal(r.status, 200); assert.ok(r.body.sent >= 3);
  assert.ok((await call('GET', '/api/outbox', null, asst)).body.emails.every((e) => e.status === 'Sent'));
  await cp.queueEmail({ to: 'x@example.com', subject: 's', body: 'b', dedupe: 'fail-1' });
  cp.setTransport({ sendMail: async () => { throw new Error('smtp down'); } });
  assert.equal((await cp.sendQueued()).failed, 1);
  const failed = (await call('GET', '/api/outbox', null, asst)).body.emails.find((e) => e.status === 'Failed'); assert.match(failed.error, /smtp down/);
  assert.equal((await call('POST', `/api/outbox/${failed.id}/retry`, {}, sub)).status, 200);
  cp.setTransport(nodemailer.createTransport({ jsonTransport: true })); assert.equal((await cp.sendQueued()).sent, 1);
});

test('notices to owner: 45-day deadline, validation, year view with rollover, reminders', async () => {
  let n = (await call('GET', '/api/ntos?year=2026', null, asst)).body; assert.equal(n.length, 1);
  assert.deepEqual([n[0].project, n[0].status, n[0].due, n[0].rolledOver], ['Site A', 'Needed', null, false]);
  assert.equal((await call('PUT', `/api/projects/${pid}/nto`, { firstFurnished: '2026-10-01' }, pm)).status, 403);
  assert.equal((await call('PUT', `/api/projects/${pid}/nto`, { firstFurnished: '2026-10-01' }, asst)).status, 200);
  n = (await call('GET', '/api/ntos?year=2026', null, asst)).body[0]; assert.deepEqual([n.due, n.firstFurnishedSet], ['2026-11-15', true]);
  assert.equal((await call('PUT', `/api/projects/${pid}/nto`, { status: 'Sent' }, asst)).status, 400);                      // needs a sent date
  assert.equal((await call('PUT', `/api/projects/${pid}/nto`, { documentUrl: 'http://x.example' }, asst)).status, 400);
  assert.equal((await call('PUT', `/api/projects/${pid}/nto`, { firstFurnished: '2026-02-30' }, asst)).status, 400);
  // reminder when the deadline is close, then a rollover into the next year while still unsent
  const rel = (n) => shift(todayEastern(), n);   // calendar days from the Eastern today, like the app (never n x 24 hours: a clock change would move the day)
  await call('PUT', `/api/projects/${pid}/nto`, { firstFurnished: rel(-41) }, asst);   // 45-day deadline is 4 days away
  assert.ok((await cp.scanNtos(rel(0))) >= 3);
  assert.ok((await call('GET', '/api/notifications', null, owner)).body.some((x) => /Notice to Owner due in 4 days/.test(x.title)));
  await call('PUT', `/api/projects/${pid}/nto`, { year: 2025 }, asst);
  assert.deepEqual((await call('GET', '/api/ntos?year=2026', null, asst)).body.map((x) => [x.project, x.rolledOver, x.year]), [['Site A', true, 2025]]);
  assert.equal((await call('GET', '/api/ntos?year=2025', null, asst)).body.length, 1);
  await call('PUT', `/api/projects/${pid}/nto`, { status: 'Sent', sentDate: '2026-10-05', method: 'Certified mail', recipient: 'Owner LLC' }, asst);
  assert.equal((await call('GET', '/api/ntos?year=2026', null, asst)).body.length, 0);                                       // sent notices do not roll over
  assert.equal((await call('GET', '/api/ntos?year=2025', null, asst)).body[0].status, 'Sent');
  // first-furnished falls back to the first clocked day when not set by hand
  await call('PUT', `/api/projects/${pid}/nto`, { status: 'Needed', firstFurnished: null, year: 2026 }, asst);
  const e = (await q(`INSERT INTO employees(name,hourly_rate) VALUES ('Z',10) RETURNING id`))[0].id;
  await q(`INSERT INTO time_entries(employee_id,project_id,work_date,clock_in,clock_out,gross_hours,total_hours,status,method) VALUES ($1,$2,'2026-10-12','2026-10-12 12:00+00','2026-10-12 20:00+00',8,8,'complete','Manual')`, [e, pid]);
  n = (await call('GET', '/api/ntos?year=2026', null, asst)).body[0]; assert.deepEqual([n.firstFurnished, n.firstFurnishedSet, n.due], ['2026-10-12', false, '2026-11-26']);
});
