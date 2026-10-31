// Company overhead spread over projects. Percent items follow each project's revenue; fixed items are
// shared by revenue weight. Revenue is the project's contract value or billed-to-date (a setting).
import { splitCents } from './split.ts';
import { toCents, toDollars } from './costing.ts';
export type Item = { name: string; kind: 'percent_of_revenue' | 'fixed_annual'; value: number };
export type Proj = { id: string; revenue: number };
export function allocateOverhead(items: Item[], projects: Proj[], yearFraction = 1) {
  const per = new Map<string, number>(projects.map((p) => [p.id, 0]));
  const lines: { name: string; total: number; byProject: Record<string, number> }[] = [];
  const weights = projects.map((p) => Math.max(0, p.revenue));
  const totalRev = weights.reduce((n, w) => n + w, 0);
  for (const it of items) {
    let cents: number[];
    if (it.kind === 'percent_of_revenue') cents = projects.map((p) => Math.round((toCents(Math.max(0, p.revenue)) * it.value) / 100));
    else cents = totalRev > 0 ? splitCents(Math.round(toCents(it.value) * yearFraction), weights) : projects.map(() => 0);
    const byProject: Record<string, number> = {};
    projects.forEach((p, i) => { per.set(p.id, (per.get(p.id) ?? 0) + cents[i]); byProject[p.id] = toDollars(cents[i]); });
    lines.push({ name: it.name, total: toDollars(cents.reduce((n, c) => n + c, 0)), byProject });
  }
  return { byProject: Object.fromEntries([...per].map(([k, v]) => [k, toDollars(v)])), lines, total: toDollars([...per.values()].reduce((n, c) => n + c, 0)) };
}
