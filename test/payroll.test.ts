import test from 'node:test';
import assert from 'node:assert/strict';
import { weekPay, weekStart, allocateLabor, type PayCfg, type ClockEntry } from '../src/lib/payroll.ts';

const cfg: PayCfg = { otEnabled: true, otAfter: 40, otMult: 1.5, dailyFullDayHours: 6 };
const e = (id: string, date: string, hours: number, lines: { trade: string; hours: number }[], project = 'p1'): ClockEntry =>
  ({ id, employeeId: 'a', date, projectId: project, totalHours: hours, lines, status: 'complete' });

test('weeks run Monday to Sunday', () => {
  assert.equal(weekStart('2026-10-26'), '2026-10-26'); // Monday
  assert.equal(weekStart('2026-11-01'), '2026-10-26'); // Sunday
  assert.equal(weekStart('2026-11-02'), '2026-11-02');
});

test('hourly overtime after 40 hours at 1.5x', () => {
  const w = weekPay({ payType: 'hourly', rate: 20 }, cfg, [{ date: '2026-10-26', totalHours: 45 }]);
  assert.deepEqual([w.reg, w.ot, w.pay], [40, 5, 800 + 150]);
});

test('overtime can be turned off', () => {
  const w = weekPay({ payType: 'hourly', rate: 20 }, { ...cfg, otEnabled: false }, [{ date: '2026-10-26', totalHours: 45 }]);
  assert.equal(w.pay, 900);
});

test('daily pay: full rate at 6+ hours, half rate under', () => {
  const w = weekPay({ payType: 'daily', rate: 200 }, cfg, [
    { date: '2026-10-26', totalHours: 8 }, { date: '2026-10-27', totalHours: 4 }, { date: '2026-10-27', totalHours: 1 }]);
  assert.equal(w.pay, 200 + 100); // Tue totals 5h => half
});

test('labor allocation splits pay over trade lines and sums exactly', () => {
  const entries = [e('1', '2026-10-26', 8, [{ trade: 'Demolition', hours: 3 }, { trade: 'Painting', hours: 5 }])];
  const rows = allocateLabor(entries, { a: { payType: 'hourly', rate: 33.33 } }, cfg);
  assert.equal(rows.length, 2);
  assert.equal(rows.reduce((s, r) => Math.round((s + r.pay) * 100) / 100, 0), 266.64);
  assert.equal(rows[0].pay + rows[1].pay, 266.64);
  assert.deepEqual(rows.map(r => r.importKey), ['1:0', '1:1']);
});

test('overtime cost is shared across projects in the week', () => {
  const entries = [
    e('1', '2026-10-26', 30, [{ trade: 'Demolition', hours: 30 }], 'p1'),
    e('2', '2026-10-28', 20, [{ trade: 'Painting', hours: 20 }], 'p2'),
  ];
  const rows = allocateLabor(entries, { a: { payType: 'hourly', rate: 20 } }, cfg);
  const total = rows.reduce((s, r) => s + r.pay, 0);
  assert.equal(Math.round(total * 100) / 100, 40 * 20 + 10 * 30); // 1100
  assert.equal(rows.find(r => r.projectId === 'p1')!.pay, 660);   // 30/50 of 1100
  assert.equal(rows.find(r => r.projectId === 'p2')!.pay, 440);
});

test('open shifts are not costed; missing trade lines fall back to the whole entry', () => {
  const open: ClockEntry = { ...e('3', '2026-10-26', 8, []), status: 'open' };
  const noLines = e('4', '2026-10-27', 8, []);
  const rows = allocateLabor([open, noLines], { a: { payType: 'hourly', rate: 10 } }, cfg);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].trade, '');
  assert.equal(rows[0].pay, 80);
});
