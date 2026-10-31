// First start on a fresh database: create the Super Admin and the starter trades from ADMIN_EMAIL / ADMIN_PASSWORD.
// After the first sign-in, delete ADMIN_PASSWORD from the host's settings. It is only ever used when there are no users.
import { q } from './db.js';
import { hashPassword, MIN_PASSWORD } from './auth.js';
export const STARTER_TRADES = ['Demolition', 'Framing & Drywall', 'ACT', 'Concrete Cutting', 'Carpentry', 'Painting', 'Plumbing'];
export async function bootstrapOwner(env = process.env) {
  const [{ n }] = await q('SELECT count(*)::int n FROM app_users'); if (n > 0) return { created: false, reason: 'users exist' };
  const email = String(env.ADMIN_EMAIL || '').trim().toLowerCase(), pw = String(env.ADMIN_PASSWORD || '');
  if (!email || pw.length < MIN_PASSWORD) return { created: false, reason: `Set ADMIN_EMAIL and ADMIN_PASSWORD (at least ${MIN_PASSWORD} characters) to create the owner login.` };
  for (const [i, name] of STARTER_TRADES.entries()) await q('INSERT INTO trades(name,sort) VALUES ($1,$2) ON CONFLICT (name) DO NOTHING', [name, i]);
  await q(`INSERT INTO app_users(email,name,role,password_hash) VALUES ($1,'Owner','Super Admin',$2)`, [email, await hashPassword(pw)]);
  return { created: true, email };
}
