// Pure rules for reading a QuickBooks invoice: which project it probably belongs to, which trade each line is, and how retainage shows.
import { matchTrade, type TradeRef } from './contracts.ts';
import { toCents, toDollars } from './costing.ts';

const norm = (s: string) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
export interface ProjectRef { id: string; name: string; gc: string; refCode: string | null; proposalId: string | null }
export interface QbInvoiceIn { docNumber?: string | null; customerName?: string | null; memo?: string | null; lines: { description?: string | null; itemName?: string | null }[] }
// Best guess, with the reason, or null. A remembered customer match is decided by the caller before this runs.
export function suggestProject(inv: QbInvoiceIn, projects: ProjectRef[]): { projectId: string; how: string } | null {
  const hay = [inv.docNumber, inv.customerName, inv.memo, ...inv.lines.map((l) => l.description)].filter(Boolean).join(' ');
  const codes = [...new Set((hay.match(/\b[CP]\d{4,6}\b/gi) || []).map((c) => c.toUpperCase()))];
  for (const c of codes) { const p = projects.find((x) => (x.refCode || '').toUpperCase() === c || (x.proposalId || '').toUpperCase() === c); if (p) return { projectId: p.id, how: `contract code ${c}` }; }
  const parts = String(inv.customerName || '').split(':').map((x) => x.trim()).filter(Boolean), job = norm(parts.at(-1) || '');
  if (job.length >= 4) {
    const hits = projects.filter((p) => { const n = norm(p.name); return n === job || (n.length >= 6 && (job.includes(n) || n.includes(job))); });
    const byGc = parts.length > 1 ? hits.filter((p) => norm(p.gc) === norm(parts[0]) || norm(p.gc).includes(norm(parts[0])) || norm(parts[0]).includes(norm(p.gc))) : hits;
    const pick = byGc.length === 1 ? byGc : hits.length === 1 ? hits : [];
    if (pick.length === 1) return { projectId: pick[0].id, how: `customer "${inv.customerName}"` };
  }
  return null;
}
export interface QbLine { description: string; itemName: string; amount: number; retainage: boolean }
// Sales lines in order. A negative line that says retainage is retainage held back, not a discount.
export function readLines(raw: any[]): QbLine[] {
  const out: QbLine[] = [];
  for (const l of raw || []) {
    if (l.DetailType !== 'SalesItemLineDetail' && l.DetailType !== 'DiscountLineDetail' && l.DetailType !== 'DescriptionOnly') continue;
    if (l.DetailType === 'DescriptionOnly' || !Number.isFinite(Number(l.Amount))) continue;
    const description = String(l.Description || '').slice(0, 300), itemName = String(l.SalesItemLineDetail?.ItemRef?.name || '').slice(0, 120), amount = Math.round(Number(l.Amount) * 100) / 100;
    out.push({ description, itemName, amount: l.DetailType === 'DiscountLineDetail' ? -Math.abs(amount) : amount, retainage: /retain/i.test(`${description} ${itemName}`) && amount < 0 });
  }
  return out;
}
export interface Split { projectTradeId: string; amount: number; retainage: number }
// Groups billable lines by trade. Retainage lines are spread across the trades in proportion to what each billed; with no
// retainage line, the project's default percent applies. Lines with no trade are reported, not guessed.
export function splitByTrade(lines: QbLine[], tradeOf: (i: number) => string | null, defaultRetainagePct: number, overrideRetainage?: number | null): { splits: Split[]; unassigned: number[] } {
  const sums = new Map<string, number>(); const unassigned: number[] = []; let held = 0;
  lines.forEach((l, i) => { if (l.retainage) { held += toCents(-l.amount); return; } const t = tradeOf(i); if (!t) { unassigned.push(i); return; } sums.set(t, (sums.get(t) ?? 0) + toCents(l.amount)); });
  const total = [...sums.values()].reduce((a, b) => a + b, 0);
  const explicit = overrideRetainage != null ? toCents(overrideRetainage) : held > 0 ? held : null;
  const entries = [...sums]; let left = explicit ?? 0;
  const splits = entries.map(([t, c], k) => { let r: number; if (explicit == null) r = Math.round(c * defaultRetainagePct / 100); else if (k === entries.length - 1) r = left; else { r = Math.round(explicit * c / (total || 1)); left -= r; } return { projectTradeId: t, amount: toDollars(c), retainage: toDollars(Math.max(0, Math.min(r, c))) }; });
  return { splits, unassigned };
}
// Spreads a payment across the trade rows of one invoice in proportion to what each billed, to the cent.
export function spreadPayment(amount: number, weights: number[]): number[] {
  const total = weights.reduce((a, b) => a + b, 0), c = toCents(amount); let left = c;
  return weights.map((w, i) => { const part = i === weights.length - 1 ? left : Math.round(c * w / (total || 1)); left -= part; return toDollars(part); });
}
export { matchTrade };
export type { TradeRef };
