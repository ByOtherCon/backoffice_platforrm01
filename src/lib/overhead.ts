// Company overhead spread over projects. Percent items follow each project's revenue; fixed items are
// shared by revenue weight. Revenue is the project's contract value or billed-to-date (a setting).
import { splitCents } from './split.ts';
import { toCents, toDollars } from './costing.ts';
export type Item = { name: string; kind: 'percent_of_revenue' | 'fixed_annual'; value: number; window?: { from: string; to: string } | null };
export type Proj = { id: string; revenue: number; logged?: string | null; active?: boolean };
// A policy runs one year from its policy date and renews on the same date. Returns the year that contains `today`: [from, to).
export function policyWindow(policyDate: string, today: string) {
  const [y, m, d] = policyDate.split('-').map(Number), pad = (n: number) => String(n).padStart(2, '0'), at = (yr: number) => `${yr}-${pad(m)}-${pad(d)}`;
  let year = policyDate > today ? y : Number(today.slice(0, 4)); if (policyDate <= today && at(year) > today) year -= 1;
  return { from: at(year), to: at(year + 1) };
}
// With a policy year, every contract logged in it counts (closed ones too); without one, the active contracts do.
const inWindow = (p: Proj, w?: { from: string; to: string } | null) => (w ? !!p.logged && p.logged >= w.from && p.logged < w.to : p.active !== false);
export function allocateOverhead(items: Item[], projects: Proj[], yearFraction = 1) {
  const per = new Map<string, number>(projects.map((p) => [p.id, 0]));
  const lines: { name: string; total: number; effectivePct: number | null; contracts: number; byProject: Record<string, number> }[] = [];
  for (const it of items) {
    // Only the contracts inside the item's policy year share it, so the more contracts and revenue in the year, the smaller each one's share.
    const weights = projects.map((p) => (inWindow(p, it.window) ? Math.max(0, p.revenue) : 0));
    const totalRev = weights.reduce((n, w) => n + w, 0);
    let cents: number[];
    if (it.kind === 'percent_of_revenue') cents = projects.map((p, i) => Math.round((toCents(weights[i]) * it.value) / 100));
    else cents = totalRev > 0 ? splitCents(Math.round(toCents(it.value) * yearFraction), weights) : projects.map(() => 0);
    const byProject: Record<string, number> = {};
    projects.forEach((p, i) => { per.set(p.id, (per.get(p.id) ?? 0) + cents[i]); byProject[p.id] = toDollars(cents[i]); });
    const total = toDollars(cents.reduce((n, c) => n + c, 0));
    lines.push({ name: it.name, total, effectivePct: totalRev > 0 ? Math.round((total / totalRev) * 10000) / 100 : null, contracts: weights.filter((w) => w > 0).length, byProject });
  }
  return { byProject: Object.fromEntries([...per].map(([k, v]) => [k, toDollars(v)])), lines, total: toDollars([...per.values()].reduce((n, c) => n + c, 0)) };
}
