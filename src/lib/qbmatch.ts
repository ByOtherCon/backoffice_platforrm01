// Pure rules for reading a QuickBooks invoice: which project it probably belongs to, which trade each line is, and how retainage shows.
import { matchTrade, type TradeRef } from './contracts.ts';
import { toCents, toDollars } from './costing.ts';

const norm = (s: string) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
export interface ProjectRef { id: string; name: string; gc: string; refCode: string | null; proposalId: string | null }
export interface QbInvoiceIn { docNumber?: string | null; customerName?: string | null; memo?: string | null; lines: { description?: string | null; itemName?: string | null }[] }
// Best guess, with the reason, or null. A remembered customer match is decided by the caller before this runs.
export function suggestProject(inv: QbInvoiceIn, projects: ProjectRef[]): { projectId: string; how: string; confident: boolean } | null {
  const hay = [inv.docNumber, inv.customerName, inv.memo, ...inv.lines.map((l) => l.description)].filter(Boolean).join(' ');
  const codes = [...new Set((hay.match(/\b[CP]\d{4,6}\b/gi) || []).map((c) => c.toUpperCase()))];
  for (const c of codes) { const p = projects.find((x) => (x.refCode || '').toUpperCase() === c || (x.proposalId || '').toUpperCase() === c); if (p) return { projectId: p.id, how: `contract code ${c}`, confident: true }; }
  const parts = String(inv.customerName || '').split(':').map((x) => x.trim()).filter(Boolean), job = norm(parts.at(-1) || '');
  if (job.length >= 4) {
    const hits = projects.filter((p) => { const n = norm(p.name); return n === job || (n.length >= 6 && (job.includes(n) || n.includes(job))); });
    const byGc = parts.length > 1 ? hits.filter((p) => norm(p.gc) === norm(parts[0]) || norm(p.gc).includes(norm(parts[0])) || norm(parts[0]).includes(norm(p.gc))) : hits;
    const pick = byGc.length === 1 ? byGc : hits.length === 1 ? hits : [];
    if (pick.length === 1) return { projectId: pick[0].id, how: `customer "${inv.customerName}"`, confident: parts.length > 1 && byGc.length === 1 };   // "GC:Job" naming that fits exactly one project is strong; a bare job name is only a hint
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
// How one invoice line is assigned: to one trade, spread across every trade of the project (by contract amount), or split by hand.
export type Assign = string | { spread: true } | { split: { projectTradeId: string; amount: number }[] } | null;
// Groups billable lines by trade. Retainage lines are spread across the trades in proportion to what each billed; with no
// retainage line, the project's default percent applies. Lines with no assignment are reported, not guessed. `weights` is each
// trade's contract amount, used when a line is spread over the whole project.
export function splitByTrade(lines: QbLine[], assignOf: (i: number) => Assign, defaultRetainagePct: number, overrideRetainage?: number | null, weights: Map<string, number> = new Map()): { splits: Split[]; unassigned: number[]; badSplit: number[] } {
  const sums = new Map<string, number>(); const unassigned: number[] = [], badSplit: number[] = []; let held = 0;
  const add = (t: string, c: number) => sums.set(t, (sums.get(t) ?? 0) + c);
  lines.forEach((l, i) => {
    if (l.retainage) { held += toCents(-l.amount); return; }
    const a = assignOf(i); if (!a) { unassigned.push(i); return; }
    if (typeof a === 'string') { add(a, toCents(l.amount)); return; }
    if ('spread' in a) {
      const ids = [...weights.keys()]; if (!ids.length) { unassigned.push(i); return; }
      const parts = spreadPayment(l.amount, ids.map((id) => weights.get(id) || 0)); ids.forEach((id, k) => add(id, toCents(parts[k]))); return;
    }
    const total = a.split.reduce((n, x) => n + toCents(x.amount), 0);
    if (!a.split.length || total !== toCents(l.amount)) { badSplit.push(i); return; }
    for (const x of a.split) add(x.projectTradeId, toCents(x.amount));
  });
  const total = [...sums.values()].reduce((a, b) => a + b, 0);
  const explicit = overrideRetainage != null ? toCents(overrideRetainage) : held > 0 ? held : null;
  const entries = [...sums].filter(([, c]) => c !== 0); let left = explicit ?? 0;
  const splits = entries.map(([t, c], k) => { let r: number; if (explicit == null) r = Math.round(c * defaultRetainagePct / 100); else if (k === entries.length - 1) r = left; else { r = Math.round(explicit * c / (total || 1)); left -= r; } return { projectTradeId: t, amount: toDollars(c), retainage: toDollars(Math.max(0, Math.min(r, c))) }; });
  return { splits, unassigned, badSplit };
}
// Spreads a payment across the trade rows of one invoice in proportion to what each billed, to the cent.
export function spreadPayment(amount: number, weights: number[]): number[] {
  const total = weights.reduce((a, b) => a + b, 0), c = toCents(amount); let left = c;
  return weights.map((w, i) => { const part = i === weights.length - 1 ? left : Math.round(c * w / (total || 1)); left -= part; return toDollars(part); });
}
// ---- costs (bills, checks, expenses, card charges)
export interface QbCostLine { description: string; account: string; item: string; amount: number; customerId: string | null; customerName: string | null }
// Expense lines in order. A line with no amount is skipped; a credit (negative) line is kept so it can be refused with a reason.
export function readCostLines(raw: any[]): QbCostLine[] {
  const out: QbCostLine[] = [];
  for (const l of raw || []) {
    if (l.DetailType !== 'AccountBasedExpenseLineDetail' && l.DetailType !== 'ItemBasedExpenseLineDetail') continue; if (!Number.isFinite(Number(l.Amount))) continue;
    const d = l.AccountBasedExpenseLineDetail || l.ItemBasedExpenseLineDetail || {};
    out.push({ description: String(l.Description || '').slice(0, 300), account: String(d.AccountRef?.name || '').slice(0, 120), item: String(d.ItemRef?.name || '').slice(0, 120), amount: Math.round(Number(l.Amount) * 100) / 100, customerId: d.CustomerRef?.value ? String(d.CustomerRef.value) : null, customerName: d.CustomerRef?.name ? String(d.CustomerRef.name).slice(0, 200) : null });
  }
  return out;
}
// A vendor is remembered by its QuickBooks id (or, with no id, by its name).
export const vendorKey = (id: string | null | undefined, name: string | null | undefined) => (id ? 'id:' + id : 'name:' + norm(name || ''));
export const OVERHEAD_CATEGORIES = ['Tools', 'Insurance', 'Vehicles & fuel', 'Office', 'Software', 'Other'];
// A first guess at a company-overhead category from the account and vendor names; null when nothing fits.
export function guessOverhead(account: string | null, vendor: string | null): string | null {
  const t = norm(`${account || ''} ${vendor || ''}`);
  if (/\b(insurance|geico|progressive|state farm|liability|workers comp)\b/.test(t)) return 'Insurance';
  if (/\b(fuel|gas|gasoline|shell|wawa|racetrac|sunoco|auto|vehicle|truck|tolls?|sunpass)\b/.test(t)) return 'Vehicles & fuel';
  if (/\b(software|subscription|saas|quickbooks|microsoft|google workspace|adobe|zoom)\b/.test(t)) return 'Software';
  if (/\b(office|staples|postage|printing|phone|internet|utilities)\b/.test(t)) return 'Office';
  if (/\b(tools?|equipment rental|harbor freight)\b/.test(t)) return 'Tools';
  return null;
}
// Vendors that are almost never a project cost: taxes, payroll, insurance, loans, banks. Only a hint; nothing is hidden by it.
export const looksNonProject = (vendor: string | null, account: string | null = '') => /\b(irs|eftps|internal revenue|department of revenue|dept of revenue|payroll|gusto|adp|paychex|insurance|geico|progressive|state farm|loan|interest|bank|owner|draw|transfer|credit card payment|sales tax|income tax)\b/.test(norm(`${vendor || ''} ${account || ''}`));
export { matchTrade };
export type { TradeRef };
