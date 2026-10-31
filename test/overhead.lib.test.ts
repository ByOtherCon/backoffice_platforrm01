import test from 'node:test';
import assert from 'node:assert/strict';
import { splitCents } from '../src/lib/split.ts';
import { allocateOverhead } from '../src/lib/overhead.ts';

test('splitCents never loses or invents a cent', () => {
  const r = splitCents(10000, [1, 1, 1]); assert.equal(r.reduce((n, c) => n + c, 0), 10000); assert.deepEqual(r, [3334, 3333, 3333]);
  assert.deepEqual(splitCents(1, [5, 3]), [1, 0]);
  assert.throws(() => splitCents(100, [0, 0]));
});
test('percent-of-revenue overhead follows each project (2.5% insurance)', () => {
  const r = allocateOverhead([{ name: 'Insurance', kind: 'percent_of_revenue', value: 2.5 }], [{ id: 'a', revenue: 100000 }, { id: 'b', revenue: 60000 }]);
  assert.deepEqual([r.byProject.a, r.byProject.b, r.total], [2500, 1500, 4000]);
});
test('fixed annual overhead is shared by revenue weight and adds up exactly', () => {
  const r = allocateOverhead([{ name: 'Office', kind: 'fixed_annual', value: 25000 }], [{ id: 'a', revenue: 100000 }, { id: 'b', revenue: 50000 }, { id: 'c', revenue: 50000 }]);
  assert.deepEqual([r.byProject.a, r.byProject.b, r.byProject.c], [12500, 6250, 6250]); assert.equal(r.total, 25000);
  const odd = allocateOverhead([{ name: 'x', kind: 'fixed_annual', value: 100 }], [{ id: 'a', revenue: 1 }, { id: 'b', revenue: 1 }, { id: 'c', revenue: 1 }]);
  assert.equal(odd.total, 100);
  assert.equal(allocateOverhead([{ name: 'x', kind: 'fixed_annual', value: 100 }], [{ id: 'a', revenue: 0 }]).total, 0);   // no revenue, nothing to spread over
  assert.equal(allocateOverhead([{ name: 'x', kind: 'fixed_annual', value: 1200 }], [{ id: 'a', revenue: 5 }], 0.25).total, 300); // a quarter of the year
});
