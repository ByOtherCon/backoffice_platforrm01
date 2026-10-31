// Creates the first Admin and the default trade list. Run once:
//   DATABASE_URL=... ADMIN_EMAIL=you@byother.net ADMIN_PASSWORD='long password' node scripts/seed.js
import { q, pool } from '../server/db.js';
import { hashPassword, MIN_PASSWORD } from '../server/auth.js';
const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
if (!ADMIN_EMAIL || !ADMIN_PASSWORD || ADMIN_PASSWORD.length < MIN_PASSWORD) { console.error(`Set ADMIN_EMAIL and ADMIN_PASSWORD (min ${MIN_PASSWORD} chars).`); process.exit(1); }
const trades = ['Demolition', 'Framing & Drywall', 'ACT', 'Concrete Cutting', 'Carpentry', 'Painting', 'Plumbing'];
for (const [i, name] of trades.entries()) await q('INSERT INTO trades(name,sort) VALUES ($1,$2) ON CONFLICT (name) DO NOTHING', [name, i]);
await q(`INSERT INTO app_users(email,name,role,password_hash) VALUES ($1,'Owner','Super Admin',$2) ON CONFLICT (email) DO NOTHING`, [ADMIN_EMAIL.toLowerCase(), await hashPassword(ADMIN_PASSWORD)]);
console.log('Seeded trades and admin user.'); await pool.end();
