// Simple, explainable forecasting from what has actually been billed. Needs real history before it speaks.
export type Month = { month: string; revenue: number };   // 'YYYY-MM'
const r2 = (n: number) => Math.round(n * 100) / 100;
export const monthKey = (d: string) => d.slice(0, 7);
export function addMonths(m: string, n: number): string { const [y, mo] = m.split('-').map(Number); const t = y * 12 + (mo - 1) + n; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`; }
// Average of the last `window` COMPLETED months (the current month is still filling in). Needs at least `min` months with billing.
export function monthlyPace(history: Month[], currentMonth: string, window = 3, min = 2) {
  const done = history.filter((h) => h.month < currentMonth && h.revenue > 0).sort((a, b) => a.month.localeCompare(b.month)).slice(-window);
  return done.length >= min ? r2(done.reduce((n, h) => n + h.revenue, 0) / done.length) : null;
}
// Revenue billed so far in a period plus pace x months still to come (current month counts as a partial month: pace minus what is already billed, never below zero).
export function projectPeriod(history: Month[], currentMonth: string, months: string[]) {
  const pace = monthlyPace(history, currentMonth);
  const billed = r2(months.reduce((n, m) => n + (history.find((h) => h.month === m)?.revenue ?? 0), 0));
  if (pace === null) return { pace, billed, projected: null as number | null };
  let projected = billed;
  for (const m of months) {
    if (m > currentMonth) projected += pace;
    else if (m === currentMonth) projected += Math.max(0, pace - (history.find((h) => h.month === m)?.revenue ?? 0));
  }
  return { pace, billed, projected: r2(projected) };
}
export const quarterMonths = (year: number, q: number) => [0, 1, 2].map((i) => `${year}-${String((q - 1) * 3 + i + 1).padStart(2, '0')}`);
export const yearMonths = (year: number) => Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
