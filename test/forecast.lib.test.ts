import test from 'node:test';
import assert from 'node:assert/strict';
import { monthlyPace, projectPeriod, quarterMonths, yearMonths, addMonths } from '../src/lib/forecast.ts';
const hist = [{ month: '2026-06', revenue: 90000 }, { month: '2026-07', revenue: 120000 }, { month: '2026-08', revenue: 60000 }, { month: '2026-09', revenue: 150000 }, { month: '2026-10', revenue: 30000 }];
test('pace averages the last three completed months and ignores the month in progress', () => { assert.equal(monthlyPace(hist, '2026-10'), 110000); });
test('no forecast without enough history', () => { assert.equal(monthlyPace([{ month: '2026-09', revenue: 5 }], '2026-10'), null); assert.equal(projectPeriod([], '2026-10', yearMonths(2026)).projected, null); });
test('quarter projection = billed so far + pace for the rest', () => {
  const r = projectPeriod(hist, '2026-10', quarterMonths(2026, 4)); assert.deepEqual([r.pace, r.billed, r.projected], [110000, 30000, 30000 + 80000 + 110000 + 110000]);
});
test('year projection', () => { const r = projectPeriod(hist, '2026-10', yearMonths(2026)); assert.equal(r.billed, 450000); assert.equal(r.projected, 450000 + 80000 + 110000 * 2); });
test('month math', () => { assert.equal(addMonths('2026-11', 2), '2027-01'); assert.equal(addMonths('2026-01', -1), '2025-12'); assert.deepEqual(quarterMonths(2026, 1), ['2026-01', '2026-02', '2026-03']); });
