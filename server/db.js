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
