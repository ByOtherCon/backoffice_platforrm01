import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
const { pool, q } = await import('../server/db.js');
const { server } = await import('../server/index.js');
const { hashPassword } = await import('../server/auth.js');
const { todayEastern, shift } = await import('../src/lib/estimating.ts');

let base, owner, est, pm, ids = {};
const call = async (method, path, body, cookie) => { const r = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); let b = null; try { b = t ? JSON.parse(t) : null; } catch { b = t; } return { status: r.status, body: b }; };
const login = async (email) => (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct horse battery' }) })).headers.get('set-cookie').split(';')[0];
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  const h = await hashPassword('correct horse battery');
  for (const [e, r] of [['owner@x.net', 'Super Admin'], ['est@x.net', 'Estimator'], ['pm@x.net', 'Project Manager'], ['third@x.net', 'Exec Assistant']]) { const [u] = await q('INSERT INTO app_users(email,name,role,password_hash) VALUES ($1,$2,$3,$4) RETURNING id', [e, e.split('@')[0], r, h]); ids[e.split('@')[0]] = u.id; }
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
  owner = await login('owner@x.net'); est = await login('est@x.net'); pm = await login('pm@x.net');
});
after(async () => { server.close(); await pool.end(); });
const mk = async (b, who = owner) => { const r = await call('POST', '/api/todos', b, who); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.id; };
const get = async (id, who = owner) => (await call('GET', '/api/todos?all=1', null, who)).body.find((t) => t.id === id);
const log = async (id, who = owner) => (await call('GET', `/api/todos/${id}/comments`, null, who)).body;

test('the start date is today unless one is chosen; an already-overdue to-do starts on its due date', async () => {
  const today = todayEastern();
  assert.equal((await get(await mk({ title: 'No dates' }))).startDate, today);
  assert.equal((await get(await mk({ title: 'Blank start', startDate: '' }))).startDate, today);
  assert.equal((await get(await mk({ title: 'Due later', dueDate: shift(today, 5) }))).startDate, today);
  assert.equal((await get(await mk({ title: 'Already late', dueDate: shift(today, -3) }))).startDate, shift(today, -3));
  assert.equal((await get(await mk({ title: 'Chosen', startDate: shift(today, 2), dueDate: shift(today, 9) }))).startDate, shift(today, 2));
});
test('priority levels: Low, Normal, High, Urgent; urgent first in the list; anything else is refused', async () => {
  assert.equal((await call('POST', '/api/todos', { title: 'x', priority: 'Whenever' }, owner)).status, 400);
  await q('DELETE FROM todos'); const [a, b, c, d] = [await mk({ title: 'Low one', priority: 'Low' }), await mk({ title: 'Plain' }), await mk({ title: 'Urgent one', priority: 'Urgent' }), await mk({ title: 'High one', priority: 'High' })];
  assert.deepEqual((await call('GET', '/api/todos?all=1&status=Open', null, owner)).body.map((t) => [t.title, t.priority]), [['Urgent one', 'Urgent'], ['High one', 'High'], ['Plain', 'Normal'], ['Low one', 'Low']]);
  assert.equal((await call('PUT', `/api/todos/${a}`, { priority: 'High' }, owner)).status, 200); assert.equal((await get(a)).priority, 'High'); assert.equal((await call('PUT', `/api/todos/${a}`, { priority: 'Huge' }, owner)).status, 400);
});
test('a notes log writes itself (added, assigned, priority, due date, done) and people add comments', async () => {
  const id = await mk({ title: 'Call the GC', assignedToId: ids.est, priority: 'High' });
  await call('PUT', `/api/todos/${id}`, { priority: 'Urgent', dueDate: todayEastern() }, owner); await call('PUT', `/api/todos/${id}`, { status: 'Done' }, est); await call('PUT', `/api/todos/${id}`, { status: 'Open' }, est);
  assert.equal((await call('POST', `/api/todos/${id}/comments`, { body: 'Left a voicemail' }, est)).status, 200); assert.equal((await call('POST', `/api/todos/${id}/comments`, { body: '' }, est)).status, 400);
  const l = await log(id); const text = l.map((x) => x.body);
  assert.match(text[0], /^Added by owner and assigned to est\./); assert.ok(text.some((t) => /Priority changed from High to Urgent by owner/.test(t))); assert.ok(text.some((t) => /Due date set to \d{4}-\d{2}-\d{2} by owner/.test(t))); assert.ok(text.some((t) => /Marked done by est/.test(t))); assert.ok(text.some((t) => /Reopened by est/.test(t)));
  const c = l.find((x) => x.body === 'Left a voicemail'); assert.deepEqual([c.kind, c.who], ['Comment', 'est']); assert.equal(l[0].kind, 'System');
  const note = (await call('GET', '/api/notifications', null, owner)).body.find((n) => /commented on a to-do/.test(n.title)); assert.ok(note);   // the other person is told
  assert.equal((await call('PUT', `/api/todos/${id}`, { assignedToId: ids.pm }, owner)).status, 200); assert.ok((await log(id)).some((x) => /Assigned to pm by owner/.test(x.body)));
});
test('who can open a to-do: the one it is assigned to, who added it, an admin, or someone in its conversation', async () => {
  const id = await mk({ title: 'Private-ish', assignedToId: ids.est });
  assert.equal((await call('GET', `/api/todos/${id}/comments`, null, est)).status, 200); assert.equal((await call('GET', `/api/todos/${id}/comments`, null, pm)).status, 403); assert.equal((await call('POST', `/api/todos/${id}/comments`, { body: 'hi' }, pm)).status, 403);
  const r = await call('POST', `/api/todos/${id}/send`, { userIds: [ids.pm], body: 'Can you help?' }, est); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await call('GET', `/api/todos/${id}/comments`, null, pm)).status, 200);   // now they are in the conversation
});
test('send as message: a conversation is made with the to-do details, attached to the to-do, and the other person is alerted', async () => {
  await q('DELETE FROM threads');   // earlier tests left conversations behind
  const id = await mk({ title: 'Order the stud', assignedToId: ids.owner, priority: 'High', dueDate: shift(todayEastern(), 3), notes: 'Metal, 3-5/8' });
  assert.equal((await call('POST', `/api/todos/${id}/send`, { userIds: [] }, owner)).status, 400);
  const r = (await call('POST', `/api/todos/${id}/send`, { userIds: [ids.est, ids.pm], body: 'Please look' }, owner)).body; const th = (await call('GET', `/api/threads/${r.threadId}`, null, est)).body;
  assert.equal(th.subject, 'To-do: Order the stud'); assert.match(th.messages[0].body, /Please look\n\nTo-do: Order the stud\nPriority: High\. Due \d{4}-\d{2}-\d{2}\.\nMetal, 3-5\/8/); assert.deepEqual(th.members.map((m) => m.name).sort(), ['est', 'owner', 'pm']);
  assert.equal((await get(id)).threadId, r.threadId); assert.ok((await log(id)).some((x) => /Sent to .* as a message by owner/.test(x.body)));
  assert.equal((await call('GET', '/api/messages/badge', null, pm)).body.unread, 1);
});
test('the Messages bubble counts unread messages plus to-dos that are new, due today or overdue; opening things clears it', async () => {
  await q('DELETE FROM todos'); await q('DELETE FROM threads'); const today = todayEastern();
  assert.deepEqual((await call('GET', '/api/messages/badge', null, est)).body, { unread: 0, newTodos: 0, dueToday: 0, overdue: 0, total: 0 });
  await mk({ title: 'New for you', assignedToId: ids.est });                                               // new to them
  await mk({ title: 'Due today', assignedToId: ids.est, dueDate: today }, est);                           // theirs, due today (and not new: they added it)
  await mk({ title: 'Late', assignedToId: ids.est, dueDate: shift(today, -2) }, est);                     // overdue
  await mk({ title: 'Later', assignedToId: ids.est, dueDate: shift(today, 4) }, est);                    // nothing to say
  await mk({ title: 'Not mine', assignedToId: ids.pm, dueDate: today });
  const done = await mk({ title: 'Finished', assignedToId: ids.est, dueDate: today }, est); await call('PUT', `/api/todos/${done}`, { status: 'Done' }, est);
  assert.deepEqual((await call('GET', '/api/messages/badge', null, est)).body, { unread: 0, newTodos: 1, dueToday: 1, overdue: 1, total: 3 });
  await call('POST', '/api/threads', { subject: 'Hello', body: 'ping', memberIds: [ids.est] }, owner); assert.equal((await call('GET', '/api/messages/badge', null, est)).body.total, 4);
  await call('POST', '/api/todos/seen', {}, est); assert.deepEqual((await call('GET', '/api/messages/badge', null, est)).body, { unread: 1, newTodos: 0, dueToday: 1, overdue: 1, total: 3 });   // seen is not the same as done
  const th = (await call('GET', '/api/threads', null, est)).body[0]; await call('GET', `/api/threads/${th.id}`, null, est); assert.equal((await call('GET', '/api/messages/badge', null, est)).body.total, 2);
  assert.equal((await call('GET', '/api/messages/badge')).status, 401);
});
