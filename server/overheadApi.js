import { q } from './db.js';
import { bad, money, text, dateStr, HttpError } from './http.js';
import { listProjects } from './projectApi.js';
import { allocateOverhead, policyWindow } from '../src/lib/overhead.ts';
import { todayEastern } from '../src/lib/estimating.ts';

const parse = (b, creating) => {
  const v = {};
  if (creating || b.name !== undefined) v.name = text(b.name, 'Name', { max: 120 });
  if (creating || b.kind !== undefined) { if (!['percent_of_revenue', 'fixed_annual'].includes(b.kind)) throw bad('Choose percent of revenue or a fixed annual amount.'); v.kind = b.kind; }
  if (creating || b.value !== undefined) { const n = Number(b.value); if (!Number.isFinite(n) || n < 0 || n > 1e9) throw bad('Enter a valid value.'); v.value = n; }
  if (b.policyDate !== undefined) v.policy_date = dateStr(b.policyDate, 'Policy date');
  if (b.active !== undefined) v.active = !!b.active;
  if (b.notes !== undefined) v.notes = text(b.notes, 'Notes', { max: 500, required: false }) || null;
  return v;
};
export async function overview(user) {
  const items = await q('SELECT * FROM overhead_items ORDER BY name');
  const [st] = await q(`SELECT value FROM app_settings WHERE key='overhead'`); const basis = st?.value?.basis === 'billed' ? 'billed' : 'contract';
  const logged = new Map((await q('SELECT id, logged_date FROM projects')).map((r) => [r.id, r.logged_date])), today = todayEastern();
  const all = await listProjects(user, true), projects = all.filter((p) => p.active || items.some((i) => i.active && i.policy_date));
  const alloc = allocateOverhead(items.filter((i) => i.active).map((i) => ({ name: i.name, kind: i.kind, value: Number(i.value), window: i.policy_date ? policyWindow(i.policy_date, today) : null })), projects.map((p) => ({ id: p.id, active: p.active, logged: logged.get(p.id) ?? null, revenue: basis === 'billed' ? p.billed : p.contract })));
  const spend = await q(`SELECT overhead_category AS category, SUM(amount)::float AS amount FROM supplier_allocations WHERE overhead_category IS NOT NULL AND extract(year from (SELECT invoice_date FROM supplier_invoices WHERE id=supplier_invoice_id)) = extract(year from current_date) GROUP BY 1 ORDER BY 1`);
  return { items, basis, allocation: { total: alloc.total, lines: alloc.lines.map((l) => ({ name: l.name, total: l.total, effectivePct: l.effectivePct, contracts: l.contracts })), byProject: projects.map((p) => ({ id: p.id, name: p.name, gc: p.gc, revenue: basis === 'billed' ? p.billed : p.contract, overhead: alloc.byProject[p.id], projectedProfit: p.projectedProfit, profitAfterOverhead: Math.round((p.projectedProfit - alloc.byProject[p.id]) * 100) / 100 })) }, actualSpendThisYear: spend };
}
export const create = async (b) => { const v = parse(b, true), k = Object.keys(v); return (await q(`INSERT INTO overhead_items(${k.join(',')}) VALUES (${k.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING *`, k.map((x) => v[x])))[0]; };
export async function update(id, b) { const v = parse(b, false), k = Object.keys(v); if (!k.length) throw bad('Nothing to save.'); const r = await q(`UPDATE overhead_items SET ${k.map((x, i) => `${x}=$${i + 2}`).join(',')} WHERE id=$1 RETURNING *`, [id, ...k.map((x) => v[x])]); if (!r.length) throw new HttpError(404, 'Not found.'); return r[0]; }
export const remove = (id) => q('DELETE FROM overhead_items WHERE id=$1', [id]);
export async function saveBasis(basis) { if (!['contract', 'billed'].includes(basis)) throw bad('Choose contract value or billed to date.'); await q(`INSERT INTO app_settings(key,value) VALUES ('overhead',$1) ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=now()`, [{ basis }]); }
export async function saveAiCap(cap) { const n = Number(cap); if (!Number.isInteger(n) || n < 0 || n > 1e10) throw bad('Enter a whole number of tokens.'); await q(`INSERT INTO app_settings(key,value) VALUES ('ai',$1) ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=now()`, [{ monthlyTokenCap: n }]); }
