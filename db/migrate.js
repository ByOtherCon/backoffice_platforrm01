// Applies each db/NNN_*.sql exactly once, in order, and remembers which ones ran (table schema_migrations).
// Safe to run on every deploy.  Usage: DATABASE_URL=... node db/migrate.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const dbFiles = () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  return fs.readdirSync(dir).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort().map((f) => path.join(dir, f));
};
export async function applyAll(pool) {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await pool.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name)); const ran = [];
  for (const f of dbFiles()) {
    const name = path.basename(f); if (done.has(name)) continue;
    const c = await pool.connect();
    try { await c.query('BEGIN'); await c.query(fs.readFileSync(f, 'utf8')); await c.query('INSERT INTO schema_migrations(name) VALUES ($1)', [name]); await c.query('COMMIT'); ran.push(name); }
    catch (e) { await c.query('ROLLBACK'); throw new Error(`Migration ${name} failed: ${e.message}`); } finally { c.release(); }
  }
  return ran;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { pool } = await import('../server/db.js');
  const ran = await applyAll(pool); console.log(ran.length ? `Applied: ${ran.join(', ')}` : 'Database is up to date.'); await pool.end();
}
