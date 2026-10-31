import { q } from './db.js';
import { bad, money, text, HttpError } from './http.js';
import { hashPassword, MIN_PASSWORD } from './auth.js';

const bool = (v, l) => { if (typeof v !== 'boolean') throw bad(`${l} must be true or false.`); return v; };
const oneOf = (list) => (v, l) => { if (!list.includes(v)) throw bad(`Choose a valid ${l}.`); return v; };
const optText = (max) => (v, l) => text(v, l, { max, required: false }) || null;
export const KINDS = {
  trades: { table: 'trades', order: 'sort, name', cols: { name: (v) => text(v, 'Name', { max: 100 }), sort: (v) => { const n = Number(v); if (!Number.isInteger(n)) throw bad('Sort must be a whole number.'); return n; }, archived: (v) => bool(v, 'Archived') }, required: ['name'] },
  gcs: { table: 'gcs', order: 'name', cols: { name: (v) => text(v, 'Name', { max: 200 }), archived: (v) => bool(v, 'Archived') }, required: ['name'] },
  subcontractors: { table: 'subcontractors', order: 'name', cols: { name: (v) => text(v, 'Name', { max: 200 }), email: optText(200), phone: optText(50), address: optText(300), archived: (v) => bool(v, 'Archived') }, required: ['name'] },
  suppliers: { table: 'suppliers', order: 'name', cols: { name: (v) => text(v, 'Name', { max: 200 }), provider_type: oneOf(['Supplier', 'Equipment Provider', 'Vendor']), credit_limit: (v) => money(v, 'Credit limit'), email: optText(200), phone: optText(50), address: optText(300), archived: (v) => bool(v, 'Archived') }, required: ['name'] },
  employees: { table: 'employees', order: 'name', cols: { name: (v) => text(v, 'Name', { max: 200 }), position: (v) => (v ? oneOf(['Skilled Labor', 'Carpenter', 'Carpenter Helper', 'Foreman', 'Supervisor'])(v, 'position') : null), hourly_rate: (v) => money(v, 'Rate'), pay_type: oneOf(['hourly', 'daily']), phone: optText(50), email: optText(200), active: (v) => bool(v, 'Active') }, required: ['name'] },
};
function parse(kind, body, creating) {
  const cfg = KINDS[kind]; const out = {};
  for (const [k, fn] of Object.entries(cfg.cols)) if (body[k] !== undefined) out[k] = fn(body[k], k);
  if (creating) for (const r of cfg.required) if (out[r] === undefined) throw bad(`${r} is required.`);
  if (!Object.keys(out).length) throw bad('Nothing to save.');
  return out;
}
const dbError = (e) => {
  if (e.code === '23505') return new HttpError(409, 'A record with that name already exists.');
  if (e.code === '23503') return new HttpError(409, 'This record is used elsewhere. Archive it instead of deleting.');
  return e;
};
const strip = (r) => { if ('pin_hash' in r) { r.has_pin = !!r.pin_hash; delete r.pin_hash; delete r.pin_failed; delete r.pin_locked_until; } return r; };
export const list = async (kind) => (await q(`SELECT * FROM ${KINDS[kind].table} ORDER BY ${KINDS[kind].order}`)).map(strip);
export async function create(kind, body) {
  const v = parse(kind, body, true), keys = Object.keys(v);
  try { return strip((await q(`INSERT INTO ${KINDS[kind].table} (${keys.join(',')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING *`, keys.map((k) => v[k])))[0]); } catch (e) { throw dbError(e); }
}
export async function update(kind, id, body) {
  const v = parse(kind, body, false), keys = Object.keys(v);
  try {
    const r = await q(`UPDATE ${KINDS[kind].table} SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(',')} WHERE id=$1 RETURNING *`, [id, ...keys.map((k) => v[k])]);
    if (!r.length) throw new HttpError(404, 'Not found.');
    return strip(r[0]);
  } catch (e) { throw dbError(e); }
}
export async function remove(kind, id) {
  try { await q(`DELETE FROM ${KINDS[kind].table} WHERE id=$1`, [id]); } catch (e) { throw dbError(e); }
}

// ---- users (Admin only) ----
export const ROLES = ['Super Admin', 'Sub Admin', 'Exec Assistant', 'Estimator', 'Project Manager', 'Employee'];
const ASSIGNABLE = ROLES.filter((r) => r !== 'Super Admin'); // there is exactly one Super Admin, set when the system is seeded
export const listUsers = () => q('SELECT id,email,name,title,role,active,employee_id FROM app_users ORDER BY email');
export async function createUser(b) {
  const email = text(b.email, 'Email', { max: 200 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Enter a valid email.');
  if (!ASSIGNABLE.includes(b.role)) throw bad('Choose a valid role. There is only one Super Admin.');
  if (String(b.password || '').length < MIN_PASSWORD) throw bad(`Password must be at least ${MIN_PASSWORD} characters.`);
  try {
    const [u] = await q('INSERT INTO app_users(email,name,title,role,password_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id,email,name,title,role,active', [email, text(b.name, 'Name', { required: false }), text(b.title, 'Title', { max: 80, required: false }) || null, b.role, await hashPassword(b.password)]);
    return u;
  } catch (e) { throw dbError(e); }
}
export async function updateUser(id, b, actingId) {
  const sets = [], vals = [id];
  const add = (c, v) => { vals.push(v); sets.push(`${c}=$${vals.length}`); };
  if (b.name !== undefined) add('name', text(b.name, 'Name', { required: false }));
  if (b.title !== undefined) add('title', text(b.title, 'Title', { max: 80, required: false }) || null);
  const [cur] = await q('SELECT role FROM app_users WHERE id=$1', [id]);
  if (!cur) throw new HttpError(404, 'Not found.');
  if (b.role !== undefined) { if (!ASSIGNABLE.includes(b.role)) throw bad('Choose a valid role. There is only one Super Admin.'); add('role', b.role); }
  if (b.active !== undefined) { bool(b.active, 'Active'); add('active', b.active); }
  if (b.password !== undefined) { if (String(b.password).length < MIN_PASSWORD) throw bad(`Password must be at least ${MIN_PASSWORD} characters.`); add('password_hash', await hashPassword(b.password)); }
  if (!sets.length) throw bad('Nothing to save.');
  if (cur.role === 'Super Admin' && (b.active === false || b.role !== undefined)) throw bad('The Super Admin cannot be demoted or deactivated.');
  const r = await q(`UPDATE app_users SET ${sets.join(',')} WHERE id=$1 RETURNING id,email,name,title,role,active`, vals);
  if (!r.length) throw new HttpError(404, 'Not found.');
  if (b.active === false || b.password !== undefined) await q('DELETE FROM sessions WHERE user_id=$1', [id]);
  return r[0];
}
