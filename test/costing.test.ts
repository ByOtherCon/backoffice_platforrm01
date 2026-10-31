import test from 'node:test';
import assert from 'node:assert/strict';
import { tradeStats, projectStats, aging, validateTrade, validateAllocations, type TradeInput } from '../src/lib/costing.ts';

const blank = (o: Partial<TradeInput> = {}): TradeInput => ({ original: 0, cos: [], invoices: [], subs: [], suppliers: [], labor: [], ...o });

test('contract = original + approved COs only; pending/rejected tracked separately', () => {
  const s = tradeStats(blank({ original: 100000, cos: [
    { status: 'Approved', amount: 5000 }, { status: 'Pending', amount: 2000 }, { status: 'Rejected', amount: 1500 }, { status: 'Approved', amount: -500 }] }));
  assert.equal(s.contract, 104500);
  assert.equal(s.pendingCOs, 2000);
  assert.equal(s.rejectedCOs, 1500);
});

test('GC retainage: 10% held, currently due excludes retained amounts', () => {
  const s = tradeStats(blank({ original: 100000, invoices: [{ amount: 50000, retainageHeld: 5000, payments: 30000, retainageReleased: 0 }] }));
  assert.equal(s.billed, 50000);
  assert.equal(s.received, 30000);
  assert.equal(s.retainageOutstanding, 5000);
  assert.equal(s.totalOwed, 20000);
  assert.equal(s.currentlyDue, 15000);
  assert.equal(s.unbilled, 50000);
});

test('releasing retainage moves it into received', () => {
  const s = tradeStats(blank({ original: 100000, invoices: [{ amount: 50000, retainageHeld: 5000, payments: 45000, retainageReleased: 5000 }] }));
  assert.equal(s.retainageOutstanding, 0);
  assert.equal(s.received, 50000);
  assert.equal(s.totalOwed, 0);
});

test('vendor $10,000 bill with $1,000 completion hold (from the original chat)', () => {
  const sub = { contract: 10000, invoiced: 10000, paid: 0, hold: 1000, holdReleased: false };
  let s = tradeStats(blank({ original: 20000, subs: [sub] }));
  assert.equal(s.actualCost, 10000);
  assert.equal(s.subPayable, 10000);
  assert.equal(s.subAvailableToPay, 9000);
  assert.equal(s.subHeld, 1000);
  s = tradeStats(blank({ original: 20000, subs: [{ ...sub, paid: 9000 }] }));
  assert.equal(s.subPayable, 1000);        // remaining payable is the hold
  assert.equal(s.actualCost, 10000);       // paying does not add expense
  assert.equal(s.subAvailableToPay, 0);
  s = tradeStats(blank({ original: 20000, subs: [{ ...sub, paid: 9000, holdReleased: true }] }));
  assert.equal(s.subAvailableToPay, 1000);
});

test('projected profit counts cost to finish so unfinished trades do not look too profitable', () => {
  const s = tradeStats(blank({ original: 50000, subs: [{ contract: 30000, invoiced: 10000, paid: 10000, hold: 0, holdReleased: false }] }));
  assert.equal(s.actualCost, 10000);
  assert.equal(s.subRemaining, 20000);
  assert.equal(s.projectedCost, 30000);
  assert.equal(s.projectedProfit, 20000);
  assert.equal(s.marginPct, 40);
});

test('labor uses explicit pay when given, else hours x rate', () => {
  const s = tradeStats(blank({ original: 10000, labor: [{ hours: 8, rate: 40 }, { hours: 10, rate: 40, pay: 460 }] }));
  assert.equal(s.laborCost, 780);
  assert.equal(s.hours, 18);
});

test('supplier cost and payable are separate from expense', () => {
  const s = tradeStats(blank({ original: 10000, suppliers: [{ amount: 2500.5, paid: 1000 }] }));
  assert.equal(s.actualCost, 2500.5);
  assert.equal(s.supplierPayable, 1500.5);
});

test('no floating point drift', () => {
  const s = tradeStats(blank({ original: 0.3, cos: [{ status: 'Approved', amount: 0.1 }, { status: 'Approved', amount: 0.2 }] }));
  assert.equal(s.contract, 0.6);
});

test('project roll-up includes unallocated cost against profit', () => {
  const a = blank({ original: 40000, labor: [{ hours: 10, rate: 50 }] });
  const b = blank({ original: 60000, suppliers: [{ amount: 20000, paid: 0 }] });
  const p = projectStats([a, b], { labor: [{ hours: 4, rate: 50 }] });
  assert.equal(p.contract, 100000);
  assert.equal(p.actualCost, 20700);
  assert.equal(p.unallocatedCost, 200);
  assert.equal(p.projectedProfit, 79300);
  assert.equal(p.marginPct, 79.3);
});

test('aging buckets', () => {
  assert.equal(aging({ amount: 100, paid: 100, dueDate: '2026-01-01' }, '2026-02-01'), 'Paid');
  assert.equal(aging({ amount: 100, paid: 0 }, '2026-02-01'), 'No Due Date');
  assert.equal(aging({ amount: 100, paid: 0, dueDate: '2026-01-22' }, '2026-02-01'), '10 Days Overdue');
  assert.equal(aging({ amount: 100, paid: 0, dueDate: '2026-02-01' }, '2026-02-01'), 'Due Today');
  assert.equal(aging({ amount: 100, paid: 0, dueDate: '2026-02-10' }, '2026-02-01'), 'Not Due');
});

test('validation catches over-billing, over-paying and bad hours', () => {
  const bad = blank({ original: 1000,
    invoices: [{ amount: 1500, retainageHeld: 2000, payments: 0, retainageReleased: 0 }],
    subs: [{ contract: 100, invoiced: 150, paid: 200, hold: 0, holdReleased: false }],
    suppliers: [{ amount: 10, paid: 20 }], labor: [{ hours: 30, rate: 10 }] });
  const errs = validateTrade(bad);
  assert.ok(errs.some(e => e.includes('Billed to date')));
  assert.ok(errs.some(e => e.includes('Retainage cannot exceed')));
  assert.ok(errs.some(e => e.includes('exceed the subcontract')));
  assert.ok(errs.some(e => e.includes('Payments cannot exceed')));
  assert.ok(errs.some(e => e.includes('Supplier paid')));
  assert.ok(errs.some(e => e.includes('Hours must be')));
  assert.deepEqual(validateTrade(blank({ original: 1000 })), []);
});

test('supplier invoice allocations must equal the total', () => {
  assert.deepEqual(validateAllocations(1000, [600, 400]), []);
  assert.equal(validateAllocations(1000, [600, 300]).length, 1);
});
