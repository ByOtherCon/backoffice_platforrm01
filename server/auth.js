import crypto from 'node:crypto';
import { q } from './db.js';
import { HttpError, parseCookies } from './http.js';

const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? rej(e) : res(k))));
export const MIN_PASSWORD = 10;
export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${(await scrypt(pw, salt)).toString('base64')}`;
}
export async function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [kind, s, h] = stored.split('$');
  if (kind !== 'scrypt') return false;
  const got = await scrypt(pw, Buffer.from(s, 'base64'));
  const want = Buffer.from(h, 'base64');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const SESSION_DAYS = 14;
export const COOKIE = 'bo_session';

export async function login(email, password) {
  email = String(email || '').trim().toLowerCase();
  const [{ n }] = await q(`SELECT count(*)::int n FROM login_attempts WHERE email=$1 AND NOT success AND attempted_at > now() - interval '15 minutes'`, [email]);
  if (n >= 5) throw new HttpError(429, 'Too many failed attempts. Try again in 15 minutes.');
  const [user] = await q('SELECT * FROM app_users WHERE email=$1 AND active', [email]);
  const ok = user ? await verifyPassword(String(password || ''), user.password_hash) : (await scrypt('x', Buffer.alloc(16)), false);
  await q('INSERT INTO login_attempts(email, success) VALUES ($1,$2)', [email, ok]);
  if (!ok) throw new HttpError(401, 'Email or password is incorrect.');
  const token = crypto.randomBytes(32).toString('base64url');
  await q(`INSERT INTO sessions(token_hash,user_id,expires_at) VALUES ($1,$2, now() + ($3 || ' days')::interval)`, [sha(token), user.id, String(SESSION_DAYS)]);
  return { token, user: publicUser(user) };
}
export const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role });
export async function userFromRequest(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const [r] = await q(`SELECT s.user_id, s.employee_id, u.email, u.name, u.role, u.active AS user_active, e.name AS emp_name, e.active AS emp_active
                       FROM sessions s LEFT JOIN app_users u ON u.id=s.user_id LEFT JOIN employees e ON e.id=s.employee_id
                       WHERE s.token_hash=$1 AND s.expires_at>now()`, [sha(token)]);
  if (!r) return null;
  if (r.employee_id) return r.emp_active ? { id: null, employeeId: r.employee_id, email: null, name: r.emp_name, role: 'Employee', token } : null;
  return r.user_active ? { id: r.user_id, email: r.email, name: r.name, role: r.role, token } : null;
}
export const logout = (token) => q('DELETE FROM sessions WHERE token_hash=$1', [sha(token)]);
export const sessionCookie = (token, secure) => `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`;
export const clearCookie = (secure) => `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;

// Access tiers. MANAGE = enters money and master records. APPROVERS = approve vendor payments. SUPER = the owner only.
export const SUPER = ['Super Admin'];
export const APPROVERS = ['Super Admin', 'Sub Admin'];
export const MANAGE = ['Super Admin', 'Sub Admin', 'Exec Assistant'];
export const requireRole = (user, roles) => { if (!user) throw new HttpError(401, 'Sign in required.'); if (!roles.includes(user.role)) throw new HttpError(403, 'Your role does not permit this.'); };
export async function requireProject(user, projectId) {
  if (!user) throw new HttpError(401, 'Sign in required.');
  if (MANAGE.includes(user.role)) return;
  if (user.role === 'Project Manager') {
    const r = await q('SELECT 1 FROM project_members WHERE project_id=$1 AND user_id=$2', [projectId, user.id]);
    if (r.length) return;
  }
  throw new HttpError(403, 'You do not have access to this project.');
}
