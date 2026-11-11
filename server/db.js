import pg from 'pg';
pg.types.setTypeParser(1700, (v) => parseFloat(v)); // numeric -> number (cents math happens in costing.ts)
pg.types.setTypeParser(1082, (v) => v);              // date -> 'YYYY-MM-DD'
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
export const q = (text, params = []) => pool.query(text, params).then((r) => r.rows);
export async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn((text, params = []) => c.query(text, params).then((r) => r.rows));
    await c.query('COMMIT');
    return out;
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

// Money rules (never pay more than is owed, never bill past the contract) are checked by reading the totals first and writing after, so two people
// working on the same project at the same moment could both pass. Each money-changing transaction takes this lock first, so they take turns.
// Ids are locked in a fixed order so two projects locked together can never wait on each other.
export async function lockProjects(t, ids) {
  const u = [...new Set((ids || []).filter(Boolean))].sort(); if (!u.length) return;
  await t('SELECT id FROM projects WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [u]);
}
