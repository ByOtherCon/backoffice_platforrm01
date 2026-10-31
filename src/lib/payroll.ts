// Pay rules ported from the byOther time clock (app.jsx weekPay), plus allocation of
// each week's pay across projects and trades so labor flows into job costing.
import { toCents, toDollars } from './costing.ts';

export type PayCfg = { otEnabled: boolean; otAfter: number; otMult: number; dailyFullDayHours: number };
export type Emp = { payType: 'hourly' | 'daily'; rate: number };
export type ClockLine = { trade: string; hours: number };
export type ClockEntry = {
  id: string; employeeId: string; date: string; // YYYY-MM-DD
  projectId: string; totalHours: number; lines: ClockLine[]; status: 'complete' | 'open';
};

export const weekStart = (date: string): string => {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // Monday
  return d.toISOString().slice(0, 10);
};

// Pay for one employee-week. Hourly: overtime after otAfter hours/week at otMult.
// Daily: a full day's rate once the day reaches dailyFullDayHours, otherwise half.
export function weekPay(emp: Emp, cfg: PayCfg, entries: Pick<ClockEntry, 'date' | 'totalHours'>[]) {
  const total = entries.reduce((s, e) => s + e.totalHours, 0);
  if (!emp.rate) return { total, reg: total, ot: 0, pay: 0 };
  if (emp.payType === 'daily') {
    const byDate = new Map<string, number>();
    for (const e of entries) byDate.set(e.date, (byDate.get(e.date) ?? 0) + e.totalHours);
    let pay = 0;
    for (const h of byDate.values()) pay += h >= cfg.dailyFullDayHours ? emp.rate : emp.rate * 0.5;
    return { total, reg: total, ot: 0, pay: toDollars(toCents(pay)) };
  }
  const ot = cfg.otEnabled ? Math.max(0, total - cfg.otAfter) : 0;
  const reg = total - ot;
  return { total, reg, ot, pay: toDollars(toCents(reg * emp.rate + ot * emp.rate * cfg.otMult)) };
}

export type LaborRow = {
  importKey: string; entryId: string; employeeId: string; date: string;
  projectId: string; trade: string; hours: number; pay: number;
};

// Turn completed clock entries into labor rows. Each week's total pay is spread over its
// trade lines in proportion to hours; cents are distributed so the rows add up exactly.
export function allocateLabor(
  entries: ClockEntry[], employees: Record<string, Emp>, cfg: PayCfg,
): LaborRow[] {
  const done = entries.filter(e => e.status === 'complete');
  const groups = new Map<string, ClockEntry[]>();
  for (const e of done) {
    const k = `${e.employeeId}|${weekStart(e.date)}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(e);
  }
  const rows: LaborRow[] = [];
  for (const [key, list] of groups) {
    const emp = employees[key.split('|')[0]];
    if (!emp) continue;
    const pay = toCents(weekPay(emp, cfg, list).pay);
    const parts: (Omit<LaborRow, 'pay'> & { w: number })[] = [];
    for (const e of list) {
      const lines = e.lines.length ? e.lines : [{ trade: '', hours: e.totalHours }];
      lines.forEach((l, i) => parts.push({
        importKey: `${e.id}:${i}`, entryId: e.id, employeeId: e.employeeId, date: e.date,
        projectId: e.projectId, trade: l.trade, hours: l.hours, w: l.hours,
      }));
    }
    const totalW = parts.reduce((s, p) => s + p.w, 0);
    if (totalW <= 0) continue;
    // largest-remainder split of `pay` cents
    const exact = parts.map(p => (pay * p.w) / totalW);
    const base = exact.map(Math.floor);
    let left = pay - base.reduce((s, c) => s + c, 0);
    exact.map((x, i) => [x - base[i], i] as const).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (left-- > 0) base[i]++; });
    parts.forEach((p, i) => { const { w, ...rest } = p; rows.push({ ...rest, pay: toDollars(base[i]) }); });
  }
  return rows;
}
