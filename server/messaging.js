import { q, tx } from './db.js';
import { bad, text, dateStr, HttpError } from './http.js';
import { notifyUser } from './compliance.js';

export const STAFF = ['Super Admin', 'Sub Admin', 'Exec Assistant', 'Estimator', 'Project Manager'];
// What a message or to-do can point at. `label` is shown to the user; `route` is where it opens.
export const LINKABLE = {
  project: { sql: 'SELECT name AS label FROM projects WHERE id=$1', route: (id) => `#/projects/${id}` },
  document: { sql: `SELECT name AS label FROM documents WHERE id=$1 AND category <> 'Employee ID'`, route: (id) => `/api/documents/${id}/file` },
  vendor: { sql: 'SELECT name AS label FROM subcontractors WHERE id=$1', route: () => '#/compliance' },
  supplier: { sql: 'SELECT name AS label FROM suppliers WHERE id=$1', route: () => '#/admin' },
  receipt: { sql: `SELECT s.name || ' ' || si.reference AS label FROM supplier_invoices si JOIN suppliers s ON s.id=si.supplier_id WHERE si.id=$1`, route: () => '#/receipts' },
  payment_request: { sql: `SELECT s.name || ' payment ' || pr.amount AS label FROM payment_requests pr JOIN sub_invoices si ON si.id=pr.sub_invoice_id JOIN sub_commitments sc ON sc.id=si.commitment_id JOIN subcontractors s ON s.id=sc.subcontractor_id WHERE pr.id=$1`, route: () => '#/compliance' },
};
export const registerLinkable = (kind, spec) => { LINKABLE[kind] = spec; };
const routeFor = (kind, id) => LINKABLE[kind]?.route(id) ?? null;

async function resolveLinks(t, links) {
  if (!Array.isArray(links)) return [];
  if (links.length > 10) throw bad('Link up to 10 records.');
  const out = [];
  for (const l of links) {
    const spec = LINKABLE[l?.kind]; if (!spec) throw bad('That kind of record cannot be linked.');
    if (!/^[0-9a-f-]{36}$/i.test(String(l.id))) throw bad('A linked record was not found.');
    const [r] = await t(spec.sql, [l.id]); if (!r) throw bad('A linked record was not found.');
    out.push({ kind: l.kind, id: l.id, label: r.label });
  }
  return out;
}
const saveLinks = async (t, ownerKind, ownerId, links) => { for (const l of links) await t('INSERT INTO record_links(owner_kind,owner_id,kind,record_id,label) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [ownerKind, ownerId, l.kind, l.id, l.label]); };
const linksOf = async (ownerKind, ids) => ids.length ? (await q('SELECT owner_id, kind, record_id, label FROM record_links WHERE owner_kind=$1 AND owner_id = ANY($2::uuid[])', [ownerKind, ids])).map((l) => ({ ownerId: l.owner_id, kind: l.kind, id: l.record_id, label: l.label, route: routeFor(l.kind, l.record_id) })) : [];

export const directory = () => q(`SELECT id, name, email, title, role FROM app_users WHERE active AND role = ANY($1::text[]) ORDER BY name`, [STAFF]);
export async function searchRecords(kind, term) {
  const t = `%${String(term || '').trim().replace(/[%_]/g, '')}%`;
  const sql = { project: `SELECT id, name AS label FROM projects WHERE name ILIKE $1 ORDER BY name LIMIT 15`, vendor: `SELECT id, name AS label FROM subcontractors WHERE name ILIKE $1 ORDER BY name LIMIT 15`, supplier: `SELECT id, name AS label FROM suppliers WHERE name ILIKE $1 ORDER BY name LIMIT 15`,
    document: `SELECT id, name AS label FROM documents WHERE name ILIKE $1 AND category <> 'Employee ID' ORDER BY created_at DESC LIMIT 15`, receipt: `SELECT si.id, s.name || ' ' || si.reference AS label FROM supplier_invoices si JOIN suppliers s ON s.id=si.supplier_id WHERE s.name || ' ' || si.reference ILIKE $1 ORDER BY si.invoice_date DESC NULLS LAST LIMIT 15`,
    opportunity: `SELECT id, name AS label FROM opportunities WHERE name ILIKE $1 ORDER BY due_date DESC NULLS LAST LIMIT 15` }[kind];
  if (!sql || !LINKABLE[kind]) throw bad('Choose what to search for.');
  return (await q(sql, [t])).map((r) => ({ kind, id: r.id, label: r.label }));
}

// ------------------------------------------------------------------ conversations
const member = async (t, threadId, userId) => { if (!(await t('SELECT 1 FROM thread_members WHERE thread_id=$1 AND user_id=$2', [threadId, userId])).length) throw new HttpError(404, 'Conversation not found.'); };
export const listThreads = (userId) => q(`SELECT th.id, th.subject, th.updated_at,
    (SELECT body FROM messages WHERE thread_id=th.id ORDER BY created_at DESC LIMIT 1) AS last_body,
    (SELECT u.name FROM messages m JOIN app_users u ON u.id=m.sender_id WHERE m.thread_id=th.id ORDER BY m.created_at DESC LIMIT 1) AS last_from,
    (SELECT COUNT(*)::int FROM messages m WHERE m.thread_id=th.id AND m.sender_id <> $1 AND (tm.last_read_at IS NULL OR m.created_at > tm.last_read_at)) AS unread,
    (SELECT json_agg(u.name ORDER BY u.name) FROM thread_members x JOIN app_users u ON u.id=x.user_id WHERE x.thread_id=th.id) AS members
  FROM threads th JOIN thread_members tm ON tm.thread_id=th.id AND tm.user_id=$1 ORDER BY th.updated_at DESC LIMIT 100`, [userId]);
export async function createThread(user, b) {
  const subject = text(b.subject, 'Subject', { max: 200 }), body = text(b.body, 'Message', { max: 5000 });
  const ids = [...new Set([user.id, ...(Array.isArray(b.memberIds) ? b.memberIds : [])])];
  const r = await tx(async (t) => {
    const ok = await t('SELECT id FROM app_users WHERE id = ANY($1::uuid[]) AND active AND role = ANY($2::text[])', [ids, STAFF]);
    if (ok.length !== ids.length) throw bad('Choose people from the team list.');
    const links = await resolveLinks(t, b.links);
    const [th] = await t('INSERT INTO threads(subject,created_by) VALUES ($1,$2) RETURNING id', [subject, user.id]);
    for (const id of ids) await t('INSERT INTO thread_members(thread_id,user_id,last_read_at) VALUES ($1,$2,$3)', [th.id, id, id === user.id ? new Date() : null]);
    const [m] = await t('INSERT INTO messages(thread_id,sender_id,body) VALUES ($1,$2,$3) RETURNING id', [th.id, user.id, body]); await saveLinks(t, 'message', m.id, links);
    return { id: th.id, messageId: m.id, ids };
  });
  for (const id of r.ids.filter((x) => x !== user.id)) await notifyUser(id, { kind: 'message', title: `${user.name || user.email}: ${subject}`, body: body.slice(0, 140), link: `#/messages/${r.id}`, dedupe: `msg:${r.messageId}` });
  return { id: r.id };
}
export async function getThread(user, id) {
  const [th] = await q('SELECT id, subject, created_by FROM threads WHERE id=$1', [id]); if (!th) throw new HttpError(404, 'Conversation not found.');
  await member(q, id, user.id);
  const msgs = await q('SELECT m.id, m.body, m.created_at, m.sender_id, u.name AS sender FROM messages m JOIN app_users u ON u.id=m.sender_id WHERE m.thread_id=$1 ORDER BY m.created_at', [id]);
  const links = await linksOf('message', msgs.map((m) => m.id));
  const members = await q('SELECT u.id, u.name, u.title FROM thread_members tm JOIN app_users u ON u.id=tm.user_id WHERE tm.thread_id=$1 ORDER BY u.name', [id]);
  const todos = await listTodos(user, { threadId: id });
  await q('UPDATE thread_members SET last_read_at=now() WHERE thread_id=$1 AND user_id=$2', [id, user.id]);
  return { ...th, members, todos, messages: msgs.map((m) => ({ id: m.id, body: m.body, at: m.created_at, from: m.sender, mine: m.sender_id === user.id, links: links.filter((l) => l.ownerId === m.id) })) };
}
export async function reply(user, id, b) {
  const body = text(b.body, 'Message', { max: 5000 });
  const r = await tx(async (t) => {
    await member(t, id, user.id); const links = await resolveLinks(t, b.links);
    const [m] = await t('INSERT INTO messages(thread_id,sender_id,body) VALUES ($1,$2,$3) RETURNING id', [id, user.id, body]); await saveLinks(t, 'message', m.id, links);
    await t('UPDATE threads SET updated_at=now() WHERE id=$1', [id]); await t('UPDATE thread_members SET last_read_at=now() WHERE thread_id=$1 AND user_id=$2', [id, user.id]);
    return { mid: m.id, subject: (await t('SELECT subject FROM threads WHERE id=$1', [id]))[0].subject, others: (await t('SELECT user_id FROM thread_members WHERE thread_id=$1 AND user_id <> $2', [id, user.id])).map((x) => x.user_id) };
  });
  for (const u of r.others) await notifyUser(u, { kind: 'message', title: `${user.name || user.email}: ${r.subject}`, body: body.slice(0, 140), link: `#/messages/${id}`, dedupe: `msg:${r.mid}` });
  return { id: r.mid };
}
export async function addMember(user, id, userId) {
  await tx(async (t) => { await member(t, id, user.id); if (!(await t('SELECT 1 FROM app_users WHERE id=$1 AND active AND role = ANY($2::text[])', [userId, STAFF])).length) throw bad('Choose someone from the team list.'); await t('INSERT INTO thread_members(thread_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, userId]); });
}

// ------------------------------------------------------------------ to-dos
const todoShape = (r, links) => ({ id: r.id, title: r.title, notes: r.notes, startDate: r.start_date, dueDate: r.due_date, status: r.status, createdBy: r.created_by_name, createdById: r.created_by, assignedTo: r.assigned_to_name, assignedToId: r.assigned_to, threadId: r.thread_id, doneAt: r.done_at,
  overdue: r.status === 'Open' && !!r.due_date && r.due_date < new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date()), links: links.filter((l) => l.ownerId === r.id) });
export async function listTodos(user, { assignedTo, status, threadId, linkedKind, linkedId, all } = {}) {
  const w = [], v = [];
  if (status) { v.push(status); w.push(`t.status=$${v.length}`); }
  if (threadId) { v.push(threadId); w.push(`t.thread_id=$${v.length}`); }
  if (assignedTo === 'me') { v.push(user.id); w.push(`t.assigned_to=$${v.length}`); } else if (assignedTo) { v.push(assignedTo); w.push(`t.assigned_to=$${v.length}`); }
  if (linkedKind && linkedId) { v.push(linkedKind, linkedId); w.push(`EXISTS (SELECT 1 FROM record_links rl WHERE rl.owner_kind='todo' AND rl.owner_id=t.id AND rl.kind=$${v.length - 1} AND rl.record_id=$${v.length})`); }
  if (!all && !assignedTo && !threadId && !linkedKind) { v.push(user.id); w.push(`(t.assigned_to=$${v.length} OR t.created_by=$${v.length})`); }
  const rows = await q(`SELECT t.*, c.name AS created_by_name, a.name AS assigned_to_name FROM todos t JOIN app_users c ON c.id=t.created_by LEFT JOIN app_users a ON a.id=t.assigned_to ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY (t.status='Done'), t.due_date NULLS LAST, t.created_at DESC LIMIT 500`, v);
  const links = await linksOf('todo', rows.map((r) => r.id));
  return rows.map((r) => todoShape(r, links));
}
const todoFields = (b, creating) => {
  const v = {};
  if (creating || b.title !== undefined) v.title = text(b.title, 'To-do', { max: 300 });
  if (b.notes !== undefined) v.notes = text(b.notes, 'Notes', { max: 2000, required: false }) || null;
  if (b.startDate !== undefined) v.start_date = dateStr(b.startDate, 'Start date');
  if (b.dueDate !== undefined) v.due_date = dateStr(b.dueDate, 'Due date');
  if (b.assignedToId !== undefined) v.assigned_to = b.assignedToId || null;
  return v;
};
export async function createTodo(user, b) {
  const v = todoFields(b, true); if (v.assigned_to === undefined) v.assigned_to = user.id;
  const r = await tx(async (t) => {
    if (v.assigned_to && !(await t('SELECT 1 FROM app_users WHERE id=$1 AND active AND role = ANY($2::text[])', [v.assigned_to, STAFF])).length) throw bad('Choose someone from the team list.');
    if (b.threadId && !(await t('SELECT 1 FROM thread_members WHERE thread_id=$1 AND user_id=$2', [b.threadId, user.id])).length) throw bad('Conversation not found.');
    const links = await resolveLinks(t, b.links);
    const [row] = await t('INSERT INTO todos(title,notes,start_date,due_date,assigned_to,created_by,thread_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id', [v.title, v.notes ?? null, v.start_date ?? null, v.due_date ?? null, v.assigned_to, user.id, b.threadId || null]);
    await saveLinks(t, 'todo', row.id, links); return row.id;
  }).catch((e) => { throw e.code === '23514' ? bad('The due date cannot be before the start date.') : e; });
  if (v.assigned_to && v.assigned_to !== user.id) await notifyUser(v.assigned_to, { kind: 'todo', title: `New to-do from ${user.name || user.email}`, body: v.title, link: '#/messages/todos', dedupe: `todo:${r}` });
  return { id: r };
}
export async function updateTodo(user, id, b) {
  const v = todoFields(b, false);
  if (b.status !== undefined) { if (!['Open', 'Done'].includes(b.status)) throw bad('Choose Open or Done.'); v.status = b.status; v.done_at = b.status === 'Done' ? new Date() : null; v.done_by = b.status === 'Done' ? user.id : null; }
  const keys = Object.keys(v); if (!keys.length && !b.links) throw bad('Nothing to save.');
  await tx(async (t) => {
    const [cur] = await t('SELECT * FROM todos WHERE id=$1 FOR UPDATE', [id]); if (!cur) throw new HttpError(404, 'To-do not found.');
    if (v.assigned_to && !(await t('SELECT 1 FROM app_users WHERE id=$1 AND active AND role = ANY($2::text[])', [v.assigned_to, STAFF])).length) throw bad('Choose someone from the team list.');
    if (keys.length) await t(`UPDATE todos SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(',')} WHERE id=$1`, [id, ...keys.map((k) => v[k])]);
    if (b.links) await saveLinks(t, 'todo', id, await resolveLinks(t, b.links));
  }).catch((e) => { throw e.code === '23514' ? bad('The due date cannot be before the start date.') : e; });
  if (v.assigned_to && v.assigned_to !== user.id) await notifyUser(v.assigned_to, { kind: 'todo', title: `To-do assigned to you by ${user.name || user.email}`, link: '#/messages/todos', dedupe: `todo:${id}:${v.assigned_to}` });
}
export async function deleteTodo(user, id) {
  const [t] = await q('SELECT created_by FROM todos WHERE id=$1', [id]); if (!t) throw new HttpError(404, 'To-do not found.');
  if (t.created_by !== user.id && !['Super Admin', 'Sub Admin'].includes(user.role)) throw new HttpError(403, 'Only the person who added it, or an admin, can delete a to-do.');
  await q('DELETE FROM record_links WHERE owner_kind=$1 AND owner_id=$2', ['todo', id]); await q('DELETE FROM todos WHERE id=$1', [id]);
}
export const unlink = (ownerKind, ownerId, linkKind, recordId) => q('DELETE FROM record_links WHERE owner_kind=$1 AND owner_id=$2 AND kind=$3 AND record_id=$4', [ownerKind, ownerId, linkKind, recordId]);
// What is attached to a record: to-dos and messages that point at it (shown on the record's own page).
export async function forRecord(kind, id) {
  const todos = await listTodos({ id: null }, { linkedKind: kind, linkedId: id });
  const msgs = await q(`SELECT DISTINCT th.id, th.subject, th.updated_at FROM record_links rl JOIN messages m ON rl.owner_kind='message' AND rl.owner_id=m.id JOIN threads th ON th.id=m.thread_id WHERE rl.kind=$1 AND rl.record_id=$2 ORDER BY th.updated_at DESC LIMIT 20`, [kind, id]);
  return { todos, threads: msgs };
}
