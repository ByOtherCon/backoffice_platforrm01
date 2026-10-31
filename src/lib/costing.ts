// Job costing rules for By Other. Pure functions, no I/O.
// Inputs/outputs are dollars; all arithmetic is done in integer cents.

export const toCents = (d: number): number => Math.round((d + Number.EPSILON) * 100);
export const toDollars = (c: number): number => c / 100;

export type CO = { status: 'Pending' | 'Approved' | 'Rejected'; amount: number };
export type ClientInvoice = {
  amount: number;
  retainageHeld: number;
  payments: number; // regular payments received
  retainageReleased: number; // retainage released and collected
  dueDate?: string | null;
};
export type SubCommitment = {
  contract: number;
  invoiced: number;
  paid: number;
  hold: number; // fixed final-payment hold
  holdReleased: boolean;
};
export type SupplierCost = { amount: number; paid: number }; // allocated portion of a supplier invoice
export type LaborEntry = { hours: number; rate: number; pay?: number | null };

export type TradeInput = {
  original: number;
  cos: CO[];
  invoices: ClientInvoice[];
  subs: SubCommitment[];
  suppliers: SupplierCost[];
  labor: LaborEntry[];
};

const sum = <T>(a: T[], f: (x: T) => number): number => a.reduce((n, x) => n + toCents(f(x)), 0);
export const laborPay = (l: LaborEntry): number => (l.pay != null ? l.pay : toDollars(toCents(l.hours * l.rate)));

export type TradeStats = ReturnType<typeof tradeStats>;

export function tradeStats(t: TradeInput) {
  const approved = sum(t.cos.filter(c => c.status === 'Approved'), c => c.amount);
  const pending = sum(t.cos.filter(c => c.status === 'Pending'), c => c.amount);
  const rejected = sum(t.cos.filter(c => c.status === 'Rejected'), c => c.amount);
  const contract = toCents(t.original) + approved; // Original Contract + COs

  // Customer side
  const billed = sum(t.invoices, i => i.amount);
  const retHeld = sum(t.invoices, i => i.retainageHeld);
  const retReleased = sum(t.invoices, i => i.retainageReleased);
  const payments = sum(t.invoices, i => i.payments);
  const received = payments + retReleased;
  const retainageOutstanding = retHeld - retReleased;
  const totalOwed = billed - received; // includes retained amounts
  const currentlyDue = Math.max(0, billed - retHeld - payments); // collectable now
  const unbilled = contract - billed;

  // Vendor side
  const subInvoiced = sum(t.subs, s => s.invoiced);
  const subPaid = sum(t.subs, s => s.paid);
  const subContract = sum(t.subs, s => s.contract);
  const subRemaining = t.subs.reduce((n, s) => n + Math.max(0, toCents(s.contract) - toCents(s.invoiced)), 0);
  const subPayable = subInvoiced - subPaid;
  const subHeld = t.subs.reduce((n, s) => n + (s.holdReleased ? 0 : Math.min(toCents(s.hold), toCents(s.invoiced) - toCents(s.paid))), 0);
  const supplierCost = sum(t.suppliers, s => s.amount);
  const supplierPaid = sum(t.suppliers, s => s.paid);
  const supplierPayable = supplierCost - supplierPaid;
  const laborCost = sum(t.labor, laborPay);
  const hours = sum(t.labor, l => l.hours) / 100;

  const actualCost = subInvoiced + supplierCost + laborCost; // a payment never adds expense
  const projectedCost = actualCost + subRemaining; // cost to finish = unbilled sub commitment
  const projectedProfit = contract - projectedCost;
  const marginPct = contract > 0 ? Math.round((projectedProfit / contract) * 10000) / 100 : null;

  const d = toDollars;
  return {
    original: t.original, approvedCOs: d(approved), pendingCOs: d(pending), rejectedCOs: d(rejected), contract: d(contract),
    billed: d(billed), received: d(received), retainageOutstanding: d(retainageOutstanding), totalOwed: d(totalOwed),
    currentlyDue: d(currentlyDue), unbilled: d(unbilled),
    subContract: d(subContract), subInvoiced: d(subInvoiced), subPaid: d(subPaid), subRemaining: d(subRemaining),
    subPayable: d(subPayable), subHeld: d(subHeld), subAvailableToPay: d(subPayable - subHeld),
    supplierCost: d(supplierCost), supplierPaid: d(supplierPaid), supplierPayable: d(supplierPayable),
    laborCost: d(laborCost), hours,
    actualCost: d(actualCost), projectedCost: d(projectedCost), projectedProfit: d(projectedProfit), marginPct,
    totalPayable: d(subPayable + supplierPayable),
  };
}

// Project roll-up. Costs not tied to a trade ("unallocated") reduce project profit.
export function projectStats(trades: TradeInput[], unallocated?: Partial<Pick<TradeInput, 'subs' | 'suppliers' | 'labor'>>) {
  const rows = trades.map(tradeStats);
  const u = tradeStats({ original: 0, cos: [], invoices: [], subs: unallocated?.subs ?? [], suppliers: unallocated?.suppliers ?? [], labor: unallocated?.labor ?? [] });
  const add = (k: keyof TradeStats) => toDollars(rows.reduce((n, r) => n + toCents(r[k] as number), 0) + toCents(u[k] as number));
  const contract = toDollars(rows.reduce((n, r) => n + toCents(r.contract), 0));
  const projectedProfit = toDollars(rows.reduce((n, r) => n + toCents(r.projectedProfit), 0) + toCents(u.projectedProfit));
  return {
    contract, billed: add('billed'), received: add('received'), retainageOutstanding: add('retainageOutstanding'),
    totalOwed: add('totalOwed'), currentlyDue: add('currentlyDue'), unbilled: toDollars(rows.reduce((n, r) => n + toCents(r.unbilled), 0)),
    subPayable: add('subPayable'), supplierPayable: add('supplierPayable'), subHeld: add('subHeld'), totalPayable: add('totalPayable'),
    actualCost: add('actualCost'), projectedCost: add('projectedCost'), laborCost: add('laborCost'), hours: add('hours'),
    subInvoiced: add('subInvoiced'), supplierCost: add('supplierCost'), subRemaining: add('subRemaining'),
    projectedProfit, marginPct: contract > 0 ? Math.round((projectedProfit / contract) * 10000) / 100 : null,
    unallocatedCost: u.actualCost,
  };
}

export function aging(inv: { amount: number; paid: number; dueDate?: string | null }, asOf: string): string {
  if (toCents(inv.amount) - toCents(inv.paid) <= 0) return 'Paid';
  if (!inv.dueDate) return 'No Due Date';
  const days = Math.floor((Date.parse(asOf + 'T00:00:00Z') - Date.parse(inv.dueDate + 'T00:00:00Z')) / 86400000);
  return days > 0 ? `${days} Days Overdue` : days === 0 ? 'Due Today' : 'Not Due';
}

// Validation rules carried over from v43. Returns a list of problems (empty = OK).
export function validateTrade(t: TradeInput): string[] {
  const errs: string[] = [];
  const s = tradeStats(t);
  if (s.contract < 0) errs.push('Approved changes cannot make a trade contract negative.');
  if (s.billed > s.contract + 0.001) errs.push('Billed to date cannot exceed Original Contract + approved COs.');
  for (const i of t.invoices) {
    if (i.retainageHeld > i.amount + 0.001) errs.push('Retainage cannot exceed the invoice amount.');
    if (i.payments + i.retainageHeld > i.amount + 0.001) errs.push('Payments plus retainage cannot exceed the invoice amount.');
    if (i.retainageReleased > i.retainageHeld + 0.001) errs.push('Released retainage cannot exceed retainage held.');
  }
  for (const v of t.subs) {
    if (v.invoiced > v.contract + 0.001) errs.push('Subcontractor bills cannot exceed the subcontract amount. Update the contract first.');
    if (v.paid > v.invoiced + 0.001) errs.push('Payments cannot exceed subcontractor bills.');
  }
  for (const x of t.suppliers) if (x.paid > x.amount + 0.001) errs.push('Supplier paid cannot exceed the invoice total.');
  for (const l of t.labor) if (!(l.hours > 0 && l.hours <= 24)) errs.push('Hours must be greater than zero and at most 24 per entry.');
  return errs;
}

// Supplier invoice split: allocations must add up to the invoice total.
export function validateAllocations(total: number, allocations: number[]): string[] {
  const diff = toCents(total) - allocations.reduce((n, a) => n + toCents(a), 0);
  return diff === 0 ? [] : [`Allocations differ from the invoice total by ${toDollars(Math.abs(diff)).toFixed(2)}.`];
}
