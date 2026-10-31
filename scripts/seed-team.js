// Creates the owner's team with one-time passwords (printed once; change on first sign-in).
//   DATABASE_URL=... node --experimental-strip-types scripts/seed-team.js
import crypto from 'node:crypto';
import { q, pool } from '../server/db.js';
import { hashPassword } from '../server/auth.js';
const team = [
  { email: 'juliana@byother.net', name: 'Juliana', title: 'Estimator', role: 'Sub Admin' },
  { email: 'silvia@byother.net', name: 'Silvia', title: 'Exec Assistant', role: 'Sub Admin' },
];
for (const t of team) {
  const pw = crypto.randomBytes(9).toString('base64url');
  const r = await q(`INSERT INTO app_users(email,name,title,role,password_hash) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (email) DO NOTHING RETURNING id`, [t.email, t.name, t.title, t.role, await hashPassword(pw)]);
  console.log(r.length ? `${t.email}  one-time password: ${pw}` : `${t.email}  already exists`);
}
await pool.end();
