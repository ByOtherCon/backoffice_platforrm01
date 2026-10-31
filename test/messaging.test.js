import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
const { pool, q } = await import('../server/db.js');
const { server } = await import('../server/index.js');
const { hashPassword } = await import('../server/auth.js');

let base, owner, juliana, silvia, pm, pid, ids = {}, thread;
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  const h = await hashPassword('correct horse battery');
  for (const [e, r, t] of [['owner@x.net', 'Super Admin', null], ['juliana@x.net', 'Sub Admin', 'Estimator'], ['silvia@x.net', 'Sub Admin', 'Exec Assistant'], ['pm@x.net', 'Project Manager', null], ['gone@x.net', 'Estimator', null]])
    ids[e] = (await q('INSERT INTO app_users(email,name,title,role,password_hash,active) VALUES ($1,$1,$2,$3,$4,$5) RETURNING id', [e, t, r, h, e !== 'gone@x.net']))[0].id;
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });
async function call(method, path, body, cookie) {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text(); return { status: res.status, body: t ? JSON.parse(t) : null };
}
const login = async (email) => { const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct horse battery' }) }); return r.headers.get('set-cookie').split(';')[0]; };

test('setup and team directory (inactive users and field employees are not listed)', async () => {
  owner = await login('owner@x.net'); juliana = await login('juliana@x.net'); silvia = await login('silvia@x.net'); pm = await login('pm@x.net');
  const t1 = (await call('POST', '/api/admin/trades', { name: 'Demolition' }, owner)).body.id, gc = (await call('POST', '/api/admin/gcs', { name: 'GC' }, owner)).body.id;
  pid = (await call('POST', '/api/projects', { name: 'Wingstop - St Cloud', gcId: gc, client: 'C', address: 'A', trades: [{ tradeId: t1, amount: 1000 }] }, owner)).body.id;
  const dir = (await call('GET', '/api/team/directory', null, silvia)).body; assert.deepEqual(dir.map((u) => u.email).sort(), ['juliana@x.net', 'owner@x.net', 'pm@x.net', 'silvia@x.net']);
  assert.equal((await call('GET', '/api/team/directory')).status, 401);
  const e = (await call('POST', '/api/admin/employees', { name: 'Field Guy' }, owner)).body; await call('PUT', `/api/admin/employees/${e.id}/pin`, { pin: '1234' }, owner);
  const r = await fetch(base + '/api/clock/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ employeeId: e.id, pin: '1234' }) }); const field = r.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('GET', '/api/threads', null, field)).status, 403); assert.equal((await call('GET', '/api/todos', null, field)).status, 403);
});

test('start a conversation linked to a project; the other person is alerted and sees it unread', async () => {
  assert.equal((await call('POST', '/api/threads', { subject: 'Wingstop bid', body: 'x', memberIds: [ids['gone@x.net']] }, owner)).status, 400);            // inactive user
  assert.equal((await call('POST', '/api/threads', { subject: 'Wingstop bid', body: 'x', memberIds: [ids['juliana@x.net']], links: [{ kind: 'project', id: '00000000-0000-0000-0000-000000000000' }] }, owner)).status, 400);
  assert.equal((await call('POST', '/api/threads', { subject: 'Wingstop bid', body: 'x', memberIds: [ids['juliana@x.net']], links: [{ kind: 'secrets', id: pid }] }, owner)).status, 400);
  assert.equal((await call('POST', '/api/threads', { subject: '', body: 'x', memberIds: [] }, owner)).status, 400);
  const r = await call('POST', '/api/threads', { subject: 'Wingstop bid', body: 'Can you price demo today?', memberIds: [ids['juliana@x.net']], links: [{ kind: 'project', id: pid }] }, owner); assert.equal(r.status, 200); thread = r.body.id;
  const n = (await call('GET', '/api/notifications', null, juliana)).body.find((x) => x.kind === 'message'); assert.match(n.title, /owner@x.net: Wingstop bid/); assert.equal(n.link, `#/messages/${thread}`);
  const list = (await call('GET', '/api/threads', null, juliana)).body; assert.deepEqual([list.length, list[0].unread, list[0].last_body], [1, 1, 'Can you price demo today?']);
  assert.equal((await call('GET', '/api/threads', null, owner)).body[0].unread, 0);
  assert.equal((await call('GET', '/api/threads', null, silvia)).body.length, 0);                                                                              // not a member
  assert.equal((await call('GET', `/api/threads/${thread}`, null, silvia)).status, 404);
});

test('reading shows the linked record and clears unread; replies alert the others', async () => {
  const t = (await call('GET', `/api/threads/${thread}`, null, juliana)).body;
  assert.deepEqual([t.messages.length, t.messages[0].links[0].label, t.messages[0].links[0].route, t.members.length], [1, 'Wingstop - St Cloud', `#/projects/${pid}`, 2]);
  assert.equal((await call('GET', '/api/threads', null, juliana)).body[0].unread, 0);
  assert.equal((await call('POST', `/api/threads/${thread}/messages`, { body: 'On it', links: [] }, juliana)).status, 200);
  assert.equal((await call('POST', `/api/threads/${thread}/messages`, { body: '' }, juliana)).status, 400);
  assert.equal((await call('POST', `/api/threads/${thread}/messages`, { body: 'hi' }, silvia)).status, 404);
  assert.equal((await call('GET', '/api/threads', null, owner)).body[0].unread, 1);
  assert.ok((await call('GET', '/api/notifications', null, owner)).body.some((n) => /juliana@x.net/.test(n.title)));
});

test('adding a person gives them the whole history', async () => {
  assert.equal((await call('POST', `/api/threads/${thread}/members`, { userId: ids['gone@x.net'] }, owner)).status, 400);
  assert.equal((await call('POST', `/api/threads/${thread}/members`, { userId: ids['silvia@x.net'] }, owner)).status, 200);
  assert.equal((await call('GET', `/api/threads/${thread}`, null, silvia)).body.messages.length, 2);
});

let todo;
test('to-dos: anyone can add one, with a timeline, assign it to anyone, and link it to a record', async () => {
  assert.equal((await call('POST', '/api/todos', { title: 'x', startDate: '2026-11-05', dueDate: '2026-11-01' }, owner)).status, 400);           // due before start
  assert.equal((await call('POST', '/api/todos', { title: 'x', dueDate: '2026-02-30' }, owner)).status, 400);
  assert.equal((await call('POST', '/api/todos', { title: 'x', assignedToId: ids['gone@x.net'] }, owner)).status, 400);
  const r = await call('POST', '/api/todos', { title: 'Send Wingstop proposal', notes: 'Use the new template', startDate: '2026-11-02', dueDate: '2026-11-06', assignedToId: ids['juliana@x.net'], links: [{ kind: 'project', id: pid }], threadId: thread }, owner); assert.equal(r.status, 200); todo = r.body.id;
  assert.ok((await call('GET', '/api/notifications', null, juliana)).body.some((n) => n.kind === 'todo' && /New to-do from owner@x.net/.test(n.title)));
  const mine = (await call('GET', '/api/todos?assignedTo=me', null, juliana)).body; assert.deepEqual([mine.length, mine[0].title, mine[0].links[0].label, mine[0].assignedTo, mine[0].createdBy], [1, 'Send Wingstop proposal', 'Wingstop - St Cloud', 'juliana@x.net', 'owner@x.net']);
  assert.equal((await call('GET', '/api/todos', null, silvia)).body.length, 0);                                                                  // default list is yours: assigned to or created by you
  const own = await call('POST', '/api/todos', { title: 'Call GC' }, silvia); assert.equal(own.status, 200);
  assert.equal((await call('GET', '/api/todos', null, silvia)).body[0].assignedTo, 'silvia@x.net');                                              // defaults to the person who added it
});

test('to-dos: complete, reopen, overdue flag, attached-to-record view, conversation view', async () => {
  await call('POST', '/api/todos', { title: 'Old thing', dueDate: '2020-01-01' }, owner);
  const all = (await call('GET', '/api/todos?all=1&status=Open', null, owner)).body; assert.equal(all.find((t) => t.title === 'Old thing').overdue, true); assert.equal(all.find((t) => t.id === todo).overdue, false);
  assert.equal((await call('PUT', `/api/todos/${todo}`, { status: 'Done' }, juliana)).status, 200);
  const done = (await call('GET', '/api/todos?assignedTo=me&status=Done', null, juliana)).body[0]; assert.deepEqual([done.status, !!done.doneAt, done.overdue], ['Done', true, false]);
  assert.equal((await call('PUT', `/api/todos/${todo}`, { status: 'Maybe' }, juliana)).status, 400);
  assert.equal((await call('PUT', `/api/todos/${todo}`, { status: 'Open' }, juliana)).status, 200);
  assert.equal((await call('PUT', `/api/todos/${todo}`, { assignedToId: ids['silvia@x.net'], dueDate: '2026-11-10' }, owner)).status, 200);
  assert.ok((await call('GET', '/api/notifications', null, silvia)).body.some((n) => /assigned to you/.test(n.title)));
  const att = (await call('GET', `/api/records/project/${pid}/attached`, null, pm)).body; assert.deepEqual([att.todos.map((t) => t.title), att.threads.map((t) => t.subject)], [['Send Wingstop proposal'], ['Wingstop bid']]);
  assert.equal((await call('GET', `/api/threads/${thread}`, null, owner)).body.todos[0].title, 'Send Wingstop proposal');
  assert.equal((await call('GET', `/api/records/project/${pid}/attached`)).status, 401);
});

test('deleting a to-do: its creator or an admin only', async () => {
  const t = (await call('POST', '/api/todos', { title: 'Temp', assignedToId: ids['pm@x.net'] }, silvia)).body.id;
  assert.equal((await call('DELETE', `/api/todos/${t}`, null, pm)).status, 403);
  assert.equal((await call('DELETE', `/api/todos/${t}`, null, silvia)).status, 200);
  assert.equal((await call('DELETE', `/api/todos/${todo}`, null, juliana)).status, 200);                                                          // Sub Admin
  assert.equal((await call('DELETE', `/api/todos/${todo}`, null, juliana)).status, 404);
  assert.equal((await q('SELECT COUNT(*)::int n FROM record_links WHERE owner_kind=$1 AND owner_id=$2', ['todo', todo]))[0].n, 0);
});

test('record search for the link picker; documents marked Employee ID are never linkable', async () => {
  assert.deepEqual((await call('GET', '/api/search/records?kind=project&q=wing', null, pm)).body.map((r) => r.label), ['Wingstop - St Cloud']);
  assert.equal((await call('GET', '/api/search/records?kind=bogus&q=x', null, pm)).status, 400);
  const d = (await q(`INSERT INTO documents(category,name,url) VALUES ('Employee ID','Passport','https://example.com/p.pdf') RETURNING id`))[0].id;
  assert.equal((await call('POST', '/api/threads', { subject: 's', body: 'b', links: [{ kind: 'document', id: d }] }, owner)).status, 400);
  assert.deepEqual((await call('GET', '/api/search/records?kind=document&q=pass', null, owner)).body, []);
});
