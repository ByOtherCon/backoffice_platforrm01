import test from 'node:test';
import assert from 'node:assert/strict';
import { splitCents } from '../src/lib/split.ts';
import { allocateOverhead, policyWindow } from '../src/lib/overhead.ts';

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

test('a policy year runs from its policy date, and only contracts logged in it share the cost', () => {
  assert.deepEqual(policyWindow('2025-07-01', '2026-11-01'), { from: '2026-07-01', to: '2027-07-01' });
  assert.deepEqual(policyWindow('2025-07-01', '2026-03-15'), { from: '2025-07-01', to: '2026-07-01' });       // not renewed yet this year
  assert.deepEqual(policyWindow('2027-01-01', '2026-11-01'), { from: '2027-01-01', to: '2028-01-01' });       // a policy that starts later
  const win = policyWindow('2026-07-01', '2026-11-01'); const items = [{ name: 'GL insurance', kind: 'fixed_annual' as const, value: 30000, window: win }];
  const one = allocateOverhead(items, [{ id: 'a', revenue: 100000, logged: '2026-08-10' }, { id: 'old', revenue: 900000, logged: '2026-02-01' }]);
  assert.deepEqual([one.byProject.a, one.byProject.old], [30000, 0]); assert.equal(one.lines[0].effectivePct, 30);      // one contract carries all of it: 30%
  const more = allocateOverhead(items, [{ id: 'a', revenue: 100000, logged: '2026-08-10' }, { id: 'b', revenue: 400000, logged: '2026-09-01' }, { id: 'c', revenue: 500000, logged: '2026-10-01', active: false }]);
  assert.deepEqual([more.byProject.a, more.byProject.b, more.byProject.c], [3000, 12000, 15000]); assert.equal(more.lines[0].effectivePct, 3); assert.equal(more.lines[0].contracts, 3);   // more revenue, lower effect: 3%
  // without a policy date only active contracts share it, as before
  assert.equal(allocateOverhead([{ name: 'x', kind: 'fixed_annual', value: 100 }], [{ id: 'a', revenue: 1, active: true }, { id: 'b', revenue: 1, active: false }]).byProject.b, 0);
  assert.equal(allocateOverhead([{ name: 'Insurance', kind: 'percent_of_revenue', value: 2.5, window: win }], [{ id: 'a', revenue: 100000, logged: '2026-09-01' }, { id: 'z', revenue: 100000, logged: '2025-09-01' }]).total, 2500);
});
