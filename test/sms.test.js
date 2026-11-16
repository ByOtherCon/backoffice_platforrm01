import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
process.env.PUBLIC_URL = 'https://desk.example.com';
for (const k of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM', 'TWILIO_MESSAGING_SERVICE_SID']) delete process.env[k];
const { pool, q } = await import('../server/db.js');
const { server } = await import('../server/index.js');
const { hashPassword } = await import('../server/auth.js');
const sms = await import('../server/sms.js');
const { todayEastern, shift } = await import('../src/lib/estimating.ts');
const today = todayEastern();

let base, owner, est, estId, sent = [], answer = null;
sms.setSmsFetch(async (url, init) => { const f = new URLSearchParams(init.body); sent.push({ url, to: f.get('To'), from: f.get('From'), body: f.get('Body'), auth: init.headers.authorization }); const a = answer; answer = null; return a ?? { ok: true, status: 201, json: async () => ({ sid: 'SM' + sent.length }) }; });
const call = async (method, path, body, cookie) => { const r = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); let b = null; try { b = t ? JSON.parse(t) : null; } catch { b = t; } return { status: r.status, body: b }; };
const login = async (email) => (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct horse battery' }) })).headers.get('set-cookie').split(';')[0];
const on = () => Object.assign(process.env, { TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM: '+14075550100' });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  const h = await hashPassword('correct horse battery');
  await q(`INSERT INTO app_users(email,name,role,password_hash,phone) VALUES ('owner@x.net','Benny','Super Admin',$1,NULL), ('est@x.net','Juliana Ruiz','Estimator',$1,'(407) 555-0150'), ('est2@x.net','No Phone','Estimator',$1,NULL)`, [h]);
  estId = (await q(`SELECT id FROM app_users WHERE email='est@x.net'`))[0].id;
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`; owner = await login('owner@x.net'); est = await login('est@x.net');
});
after(async () => { server.close(); await pool.end(); });

test('numbers are read the way people type them, and only 10-digit U.S. numbers count', () => {
  assert.deepEqual(['(407) 555-0150', '407.555.0150', '+1 407 555 0150', '14075550150', '555-0150', '', null, '1234567890', '+44 20 7946 0958'].map(sms.usNumber), ['+14075550150', '+14075550150', '+14075550150', '+14075550150', null, null, null, null, null]);
});

test('until Twilio is on the server nothing is sent, and Admin says what is missing', async () => {
  const s = (await call('GET', '/api/sms/status', null, owner)).body; assert.deepEqual([s.configured, s.needs], [false, ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM']]); assert.deepEqual(s.settings, { followups: true, followupsAt: '08:30', clock: true, clockAt: '19:00' });
  assert.equal((await call('POST', '/api/sms/test', { to: '4075550150' }, owner)).status, 503); assert.deepEqual(await sms.tick(), { ran: [] }); assert.equal(sent.length, 0);
  assert.equal((await call('GET', '/api/sms/status', null, est)).status, 403); assert.equal((await call('PUT', '/api/sms/settings', { clock: false }, est)).status, 403);
});

test('a test text goes out through Twilio and is logged; a refusal is explained', async () => {
  on();
  assert.equal((await call('POST', '/api/sms/test', { to: 'call me' }, owner)).status, 400);
  const ok = await call('POST', '/api/sms/test', { to: '(407) 555-0199' }, owner); assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([sent[0].to, sent[0].from], ['+14075550199', '+14075550100']); assert.match(sent[0].url, /Accounts\/ACtest\/Messages\.json$/); assert.equal(sent[0].auth, 'Basic ' + Buffer.from('ACtest:tok').toString('base64')); assert.match(sent[0].body, /test text sent by Benny/);
  answer = { ok: false, status: 400, json: async () => ({ code: 21610, message: 'Attempt to send to unsubscribed recipient' }) };
  const stop = await call('POST', '/api/sms/test', { to: '4075550199' }, owner); assert.equal(stop.status, 502); assert.match(stop.body.error, /replied STOP/);
  const s = (await call('GET', '/api/sms/status', null, owner)).body; assert.equal(s.configured, true); assert.deepEqual(s.recent.map((r) => [r.kind, r.status, r.to]), [['Test', 'Failed', '+•••••••0199'], ['Test', 'Sent', '+•••••••0199']]);
});

test('follow-ups that are due: each estimator with a phone gets one text a day; the still-clocked-in reminder goes to the crew once a day', async () => {
  sent = [];
  // two submitted bids whose first follow-up is overdue, both Juliana's; one for the estimator with no phone
  const mk = async (name, estimator) => { const [o] = await q(`INSERT INTO opportunities(name,gc_name,city,due_date,status,accepted_date,source_key,estimator_id,proposal_id) VALUES ($1,'Text GC','Orlando',$2,'Submitted',$2,$1,$3,$4) RETURNING id`, [name, shift(today, -20), estimator, 'P' + Math.floor(Math.random() * 1e6)]);
    const [s] = await q(`INSERT INTO submissions(opportunity_id,version,submitted_date,method,price,trades) VALUES ($1,1,$2,'Email',1000,'[]') RETURNING id`, [o.id, shift(today, -15)]);
    await q(`INSERT INTO followup_cases(opportunity_id,submission_id,status,next_check) VALUES ($1,$2,'Active',$3)`, [o.id, s.id, shift(today, -3)]); return o.id; };
  await mk('Text Job One', estId); await mk('Text Job Two', estId); await mk('Text Job Three', (await q(`SELECT id FROM app_users WHERE email='est2@x.net'`))[0].id);
  assert.deepEqual(await sms.followupAlerts(), { sent: 1 }); assert.equal(sent.length, 1); assert.equal(sent[0].to, '+14075550150');
  assert.match(sent[0].body, /^byOther: 2 follow-ups are due today or overdue: Text Job (One|Two) \(Text GC\); Text Job (One|Two) \(Text GC\)\. https:\/\/desk\.example\.com\/#\/estimating\/followups$/);
  assert.deepEqual(await sms.followupAlerts(), { sent: 0 }); assert.equal(sent.length, 1);   // not twice in a day
  // the crew
  const [gc] = await q(`INSERT INTO gcs(name) VALUES ('Clock GC') RETURNING id`), [p] = await q(`INSERT INTO projects(name,gc_id,client,address) VALUES ('Clock Job',$1,'Client','1 Clock St') RETURNING id`, [gc.id]);
  const [e1] = await q(`INSERT INTO employees(name,phone) VALUES ('Luis Vega','407-555-0111') RETURNING id`), [e2] = await q(`INSERT INTO employees(name,phone) VALUES ('Out Already','407-555-0122') RETURNING id`), [e3] = await q(`INSERT INTO employees(name) VALUES ('No Number') RETURNING id`);
  await q(`INSERT INTO time_entries(employee_id,project_id,work_date,clock_in,status) VALUES ($1,$3,$4, now() - interval '9 hours','open'), ($2,$3,$4, now() - interval '9 hours','open')`, [e1.id, e3.id, p.id, today]);
  await q(`INSERT INTO time_entries(employee_id,project_id,work_date,clock_in,clock_out,status) VALUES ($1,$2,$3, now() - interval '9 hours', now() - interval '1 hour','complete')`, [e2.id, p.id, today]);
  assert.deepEqual(await sms.clockAlerts(), { sent: 1 }); assert.equal(sent[1].to, '+14075550111'); assert.match(sent[1].body, /^byOther: Luis, your time clock is still running at Clock Job since \d{1,2}:\d\d [AP]M\. Clock out here: https:\/\/desk\.example\.com\/clock/);
  assert.deepEqual(await sms.clockAlerts(), { sent: 0 });
  // switched off in Admin: nothing goes
  assert.equal((await call('PUT', '/api/sms/settings', { clock: false, followupsAt: '07:45' }, owner)).status, 200); assert.equal((await call('PUT', '/api/sms/settings', { clockAt: '7pm' }, owner)).status, 400);
  await q(`DELETE FROM sms_log`); assert.deepEqual(await sms.clockAlerts(), { sent: 0 }); assert.deepEqual((await sms.getSettings()), { followups: true, followupsAt: '07:45', clock: false, clockAt: '19:00' });
});

test('the schedule runs each alert once a day after its time, follow-ups on weekdays only', async () => {
  await q(`DELETE FROM sms_log`); await q(`DELETE FROM app_settings WHERE key='sms_runs'`); await call('PUT', '/api/sms/settings', { clock: true, clockAt: '19:00', followupsAt: '08:30' }, owner); sent = [];
  const at = (iso) => new Date(iso);   // 2026-11-16 is a Monday; Eastern is UTC-5 in November
  assert.deepEqual((await sms.tick(at('2026-11-16T13:00:00Z'))).ran, []);                 // 8:00 AM: too early
  assert.deepEqual((await sms.tick(at('2026-11-16T13:31:00Z'))).ran, ['followups']);      // 8:31 AM
  assert.deepEqual((await sms.tick(at('2026-11-16T15:00:00Z'))).ran, []);                 // already ran today
  assert.deepEqual((await sms.tick(at('2026-11-17T00:05:00Z'))).ran, ['clock']);          // 7:05 PM Monday
  assert.deepEqual((await sms.tick(at('2026-11-21T14:00:00Z'))).ran, []);                 // Saturday morning: no follow-up texts
  assert.deepEqual((await sms.tick(at('2026-11-22T00:30:00Z'))).ran, ['clock']);          // Saturday evening: the clock reminder still runs
});
