// Pure rules for reading a signed contract or work order: matching its lines to our trades, comparing with what the proposal
// carried into the project, and drafting the tentative invoice schedule.
import { toCents, toDollars } from './costing.ts';

const key = (s: string) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// Words a contract uses that mean one of our trades.
const SYNONYMS: [string, string[]][] = [
  ['demo', ['demo', 'demolition', 'selective demolition']],
  ['framing', ['framing', 'metal stud', 'studs', 'light gauge']],
  ['drywall', ['drywall', 'gypsum', 'gyp', 'sheetrock', 'board', 'taping', 'finishing']],
  ['act', ['act', 'acoustical', 'ceiling tile', 'ceilings', 'grid']],
  ['paint', ['paint', 'painting', 'coating', 'wallcovering']],
  ['carpent', ['carpentry', 'millwork', 'blocking', 'finish carpentry', 'trim']],
  ['insulation', ['insulation']],
];
export interface TradeRef { id: string; name: string }
// Best trade for a contract line: the AI's own hint first, then the line's words. Null when nothing fits clearly.
export function matchTrade(trades: TradeRef[], ...texts: (string | null | undefined)[]): string | null {
  const hay = texts.filter(Boolean).map((t) => String(t).toLowerCase()).join(' | ');
  if (!hay) return null;
  const exact = trades.find((t) => texts.some((x) => x && key(x) === key(t.name))); if (exact) return exact.id;
  const named = trades.find((t) => key(t.name).length >= 3 && hay.replace(/[^a-z0-9| ]/g, '').includes(t.name.toLowerCase().replace(/[^a-z0-9 ]/g, '')));
  if (named) return named.id;
  for (const [stem, words] of SYNONYMS) {
    const t = trades.find((x) => x.name.toLowerCase().includes(stem));
    if (t && words.some((w) => new RegExp(`\\b${w}\\b`).test(hay))) return t.id;
  }
  return null;
}

export interface ContractLine { tradeId: string | null; amount: number | null; include: boolean }
export interface Compare { tradeId: string; name: string; current: number | null; contract: number; state: 'new' | 'same' | 'changed' }
// What applying this contract would do to the project's trades. Trades on the project that the contract does not mention are
// listed separately and left alone.
export function compareToProject(lines: ContractLine[], project: { tradeId: string; name: string; original: number }[], names: Map<string, string>) {
  const sums = new Map<string, number>();
  for (const l of lines) if (l.include && l.tradeId && l.amount != null) sums.set(l.tradeId, (sums.get(l.tradeId) ?? 0) + toCents(l.amount));
  const rows: Compare[] = [...sums].map(([tradeId, cents]) => {
    const cur = project.find((p) => p.tradeId === tradeId); const contract = toDollars(cents);
    return { tradeId, name: names.get(tradeId) ?? cur?.name ?? 'Trade', current: cur ? cur.original : null, contract, state: !cur ? 'new' : Math.abs(cur.original - contract) < 0.005 ? 'same' : 'changed' };
  });
  const notInContract = project.filter((p) => !sums.has(p.tradeId));
  return { rows, notInContract, total: toDollars([...sums.values()].reduce((a, b) => a + b, 0)) };
}

export interface ScheduleIn { label: string; basis?: string | null; percent?: number | null; amount?: number | null; dueDate?: string | null; note?: string | null }
export interface ScheduleRow { label: string; basis: string | null; percent: number | null; amount: number | null; expectedDate: string | null; note: string | null }
// The schedule is drafted from what the contract states. A percent becomes dollars from the contract total. When the contract bills
// by monthly progress, one open-ended line says so (the dollars follow the work). A retainage release line is added when retainage
// is held and the contract did not already list one.
export function buildSchedule(entries: ScheduleIn[], { total, retainagePct, monthly }: { total: number | null; retainagePct: number | null; monthly: boolean }): ScheduleRow[] {
  const rows: ScheduleRow[] = [];
  for (const e of entries) {
    const label = String(e.label || '').trim().slice(0, 200); if (!label) continue;
    const percent = Number.isFinite(e.percent as number) ? Number(e.percent) : null;
    let amount = Number.isFinite(e.amount as number) ? Number(e.amount) : null;
    if (amount == null && percent != null && total != null) amount = toDollars(Math.round(toCents(total) * percent / 100));
    const date = /^\d{4}-\d{2}-\d{2}$/.test(e.dueDate || '') ? e.dueDate! : null;
    rows.push({ label, basis: e.basis ? String(e.basis).slice(0, 80) : null, percent, amount: amount != null ? Math.round(amount * 100) / 100 : null, expectedDate: date, note: e.note ? String(e.note).slice(0, 300) : null });
  }
  if (!rows.length && monthly) rows.push({ label: 'Monthly progress billing', basis: 'Progress', percent: null, amount: null, expectedDate: null, note: 'Bill for work completed each period; the amount follows the work.' });
  if (retainagePct && retainagePct > 0 && !rows.some((r) => /retain/i.test(r.label))) {
    rows.push({ label: 'Retainage release', basis: 'Retainage', percent: retainagePct, amount: total != null ? toDollars(Math.round(toCents(total) * retainagePct / 100)) : null, expectedDate: null, note: `${retainagePct}% held until the contract says it is released.` });
  }
  return rows;
}
