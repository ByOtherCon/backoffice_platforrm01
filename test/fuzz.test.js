// Garbage in, clean error out: every write route is sent odd bodies (wrong types, huge numbers, long text, broken JSON, hidden zero bytes in the address)
// and must answer with a normal error, never crash (500).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
const { pool, q } = await import('../server/db.js');
const { server, _routes } = await import('../server/index.js');
const { hashPassword } = await import('../server/auth.js');
let base, cookie, p, pt, o, s, c, tr;
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  await q(`INSERT INTO app_users(email,name,role,password_hash) VALUES ('owner@x.net','Owner','Super Admin',$1)`, [await hashPassword('correct horse battery')]);
  const [g] = await q(`INSERT INTO gcs(name) VALUES ('GC') RETURNING id`); [tr] = await q(`INSERT INTO trades(name,sort) VALUES ('Framing',1) RETURNING id`);
  [p] = await q(`INSERT INTO projects(name,gc_id,client,address) VALUES ('Job',$1,'C','1 A St') RETURNING id`, [g.id]);
  [pt] = await q('INSERT INTO project_trades(project_id,trade_id,original_amount) VALUES ($1,$2,5000) RETURNING id', [p.id, tr.id]);
  [o] = await q(`INSERT INTO opportunities(name,gc_name,city,due_date,status,source_key,project_id) VALUES ('Lead','GC','Orlando',current_date+5,'New','k',$1) RETURNING id`, [p.id]);
  [s] = await q(`INSERT INTO subcontractors(name,verified_override) VALUES ('Rivera',true) RETURNING id`);
  [c] = await q('INSERT INTO sub_commitments(project_id,project_trade_id,subcontractor_id,contract_amount) VALUES ($1,$2,$3,1000) RETURNING id', [p.id, pt.id, s.id]);
  await q(`INSERT INTO employees(name,phone) VALUES ('Emp','4075550100')`);
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
  cookie = (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@x.net', password: 'correct horse battery' }) })).headers.get('set-cookie').split(';')[0];
});
after(async () => { server.close(); await pool.end(); });
test('no route crashes on odd input', async () => {
const FAKE = '00000000-0000-0000-0000-000000000000';
const bodies = ['{}', JSON.stringify({ amount: 'abc', date: 'not-a-date', name: null, id: 123, projectId: 'x', tradeId: [], lines: 'x', email: {}, pin: [] }), '[]', JSON.stringify({ amount: 1e308, name: 'x'.repeat(50000), number: 'y'.repeat(50000) }), '{"__proto__":{"polluted":1},"constructor":{"prototype":{"x":1}}}', JSON.stringify({ amount: -1, date: '2026-02-30', lines: [{}], allocations: [null], prices: {}, tradeIds: 'x', rows: [1], ids: 'x', keys: {}, addr: 5, addr2: [] }), 'not json', JSON.stringify({ projectId: p.id, tradeId: tr.id, projectTradeId: pt.id, subcontractorId: s.id, contractAmount: '1e999', amount: '12abc', total: null, reference: {}, supplierName: [], category: {} })];
const idFor = (pattern, name, i) => { if (name === 'id' && pattern.startsWith('/api/projects/')) return p.id; if (name === 'id' && pattern.startsWith('/api/opportunities/')) return o.id; if (name === 'cid' && pattern.includes('commitments')) return c.id; if (name === 'tid' || (name === 'id' && pattern.startsWith('/api/admin/'))) return name === 'tid' ? pt.id : s.id; return FAKE; };
const bad = [];
for (const r of _routes) {
  if (/logout|clear-test-data|\/api\/me\/password|quickbooks\/connect/.test(r.pattern)) continue;
  const path = r.pattern.replace(/:([a-z]+)/gi, (_, n) => idFor(r.pattern, n));
  for (const b of (r.method === 'GET' || r.method === 'DELETE' ? [null] : bodies)) {
    const init = { method: r.method, headers: { cookie } };
    if (b !== null) { init.headers['content-type'] = r.raw ? 'application/octet-stream' : 'application/json'; init.headers['x-file-name'] = 'a.pdf'; init.body = r.raw ? Buffer.from(b) : b; }
    let st; try { st = (await fetch(base + path + (r.method === 'GET' ? '?q=%27;--&from=zzz&to=zzz&status=%00&tab=zz&year=abc&days=x&all=1' : ''), init)).status; } catch (e) { st = 'ERR ' + e.message; }
    if (st === 500 || String(st).startsWith('ERR')) bad.push(`${st} ${r.method} ${r.pattern}  body=${b === null ? '-' : String(b).slice(0, 60)}`);
  }
}
assert.deepEqual([...new Set(bad)], [], 'These routes crashed on odd input:\n' + [...new Set(bad)].join('\n'));

});
