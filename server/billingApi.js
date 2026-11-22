import { q, tx, lockProjects } from './db.js';
import { bad, money, text, dateStr, HttpError } from './http.js';
import { assertValid } from './projectApi.js';
import { resolveSupplier } from './vendors.js';
import { assertCanPay, vendorCompliance } from './compliance.js';
import { aging, toCents, toDollars, retainageOn, tradeStats } from '../src/lib/costing.ts';
import { spreadPayment } from '../src/lib/qbmatch.ts';
import { loadInputs } from './projects.js';

const dbError = (e) => {
  if (e.code === '23505') return new HttpError(409, 'That number is already used here.');
  if (e.code === '23503') return new HttpError(409, 'This record is used elsewhere.');
  return e;
};
const r2 = (n) => Math.round(n * 100) / 100;
const run = (fn) => tx(fn).catch((e) => { throw dbError(e); });
const ownsTrade = async (t, projectId, ptId) => {
  if (!ptId) throw bad('Choose a trade.');
  if (!(await t('SELECT 1 FROM project_trades WHERE id=$1 AND project_id=$2', [ptId, projectId])).length) throw bad('That trade is not on this project.');
};
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());

// ------------------------------------------------------------------ progress billing (customer side)
export async function getBilling(projectId) {
  const inv = await q(`SELECT ci.*, t.name AS trade FROM client_invoices ci JOIN project_trades pt ON pt.id=ci.project_trade_id JOIN trades t ON t.id=pt.trade_id
                       WHERE ci.project_id=$1 ORDER BY ci.invoice_date DESC, ci.number`, [projectId]);
  const pay = inv.length ? await q('SELECT * FROM client_payments WHERE client_invoice_id = ANY($1::uuid[]) ORDER BY paid_date, id', [inv.map((i) => i.id)]) : [];
  const asOf = today();
  return inv.map((i) => {
    const mine = pay.filter((p) => p.client_invoice_id === i.id);
    const payments = r2(mine.filter((p) => p.kind === 'Payment').reduce((n, p) => n + p.amount, 0));
    const released = r2(mine.filter((p) => p.kind === 'Retainage Release').reduce((n, p) => n + p.amount, 0));
    const collected = r2(payments + released);
    return {
      id: i.id, number: i.number, projectTradeId: i.project_trade_id, trade: i.trade, date: i.invoice_date, dueDate: i.due_date, amount: i.amount, retainageHeld: i.retainage_held,
      // the invoice as it was sent (what will be paid), what is still owed on it, and whether it is the invoice for retainage held back earlier
      payable: r2(i.amount - i.retainage_held), owed: r2(Math.max(0, i.amount - i.retainage_held - payments)), retainageInvoice: i.is_retainage, fromQuickBooks: !!i.qb_invoice_id,
      retainageOutstanding: r2(i.retainage_held - released), collected, outstanding: r2(i.amount - collected), aging: aging({ amount: i.amount - i.retainage_held, paid: payments, dueDate: i.due_date }, asOf),
      payments: mine.map((p) => ({ id: p.id, date: p.paid_date, amount: p.amount, kind: p.kind })),
    };
  });
}
// An invoice is entered the way it was sent: `payable` is its total, which is what will be paid. The retainage the GC holds back is logged
// beside it (from the project's percent unless one is given) and is never taken off the invoice. Stored as work billed (invoice + retainage)
// with the retainage part noted. `amount` (work billed, retainage inside it) is still accepted for older callers.
export async function addInvoice(projectId, b) {
  if (b.retainageInvoice) return addRetainageInvoice(projectId, b);
  const number = text(b.number, 'Invoice #', { max: 60 }), net = b.payable !== undefined, entered = money(net ? b.payable : b.amount, 'Invoice amount');
  if (!(entered > 0)) throw bad('Invoice amount must be greater than zero.');
  const date = dateStr(b.date, 'Invoice date', true), due = dateStr(b.dueDate, 'Due date');
  if (due && due < date) throw bad('Due date cannot precede the invoice date.');
  return run(async (t) => {
    await lockProjects(t, [projectId]);
    await ownsTrade(t, projectId, b.projectTradeId);
    const [{ retainage_pct }] = await t('SELECT retainage_pct FROM projects WHERE id=$1', [projectId]);
    const blank = b.retainageHeld === undefined || b.retainageHeld === '' || b.retainageHeld === null;
    const held = net && b.retainageHeld === undefined ? retainageOn(entered, Number(retainage_pct)) : blank ? 0 : money(b.retainageHeld, 'Retainage');
    const amount = net ? r2(entered + held) : entered;
    if (held > amount) throw bad('Retainage cannot exceed the invoice amount.');
    const [row] = await t('INSERT INTO client_invoices(project_id,project_trade_id,number,invoice_date,due_date,amount,retainage_held,net_basis) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id', [projectId, b.projectTradeId, number, date, due, amount, held, net]);
    await assertValid(t, projectId); return { id: row.id };
  });
}
// The trades a retainage invoice is shared over: by the retainage each one still has held back, or by contract amount when none was logged.
export async function retainageWeights(t, projectId) {
  const loaded = (await loadInputs([projectId], t)).get(projectId), rows = (loaded?.trades ?? []).map((r) => ({ ptId: r.ptId, st: tradeStats(r.input) }));
  const any = rows.some((r) => r.st.retainageOutstanding > 0);
  return rows.map((r) => ({ ptId: r.ptId, weight: any ? Math.max(0, r.st.retainageOutstanding) : r.st.contract })).filter((x) => x.weight > 0);
}
// The invoice for retainage held back earlier. It is not new work: it uses up the retainage logged on the project and is owed until paid.
// It is one invoice for the whole project, kept as one row per trade so each trade's numbers stay right.
export async function addRetainageInvoice(projectId, b) {
  const number = text(b.number, 'Invoice #', { max: 60 }), amount = money(b.payable !== undefined ? b.payable : b.amount, 'Invoice amount');
  if (!(amount > 0)) throw bad('Invoice amount must be greater than zero.');
  const date = dateStr(b.date, 'Invoice date', true), due = dateStr(b.dueDate, 'Due date');
  if (due && due < date) throw bad('Due date cannot precede the invoice date.');
  return run(async (t) => {
    await lockProjects(t, [projectId]);
    const w = await retainageWeights(t, projectId); if (!w.length) throw bad('Add the project trades first.');
    const parts = spreadPayment(amount, w.map((x) => x.weight)), ids = [];
    for (let i = 0; i < w.length; i++) if (parts[i] > 0) ids.push((await t('INSERT INTO client_invoices(project_id,project_trade_id,number,invoice_date,due_date,amount,retainage_held,is_retainage,net_basis) VALUES ($1,$2,$3,$4,$5,$6,0,true,true) RETURNING id', [projectId, w[i].ptId, number, date, due, parts[i]]))[0].id);
    await assertValid(t, projectId); return { id: ids[0], rows: ids.length };
  });
}
// ---- bringing a project's invoices in line with "the invoice is what gets paid; retainage is logged on top of it"
// For every progress invoice: what it asks for, and the retainage that should be logged for it at the project's percent. Invoices that came
// from QuickBooks with their own retainage line are already right and are left alone. Nothing is changed here; `retainageApply` does that.
export async function retainageCheck(projectId, t = q) {
  const [p] = await t('SELECT retainage_pct FROM projects WHERE id=$1', [projectId]); if (!p) throw new HttpError(404, 'Project not found.');
  const pct = Number(p.retainage_pct);
  const rows = await t(`SELECT ci.id, ci.number, ci.invoice_date, ci.amount, ci.retainage_held, ci.net_basis, ci.qb_invoice_id, tr.name AS trade, qi.imported_total, qi.total AS qb_total, qi.lines AS qb_lines,
      COALESCE((SELECT SUM(amount) FROM client_payments WHERE client_invoice_id=ci.id AND kind='Retainage Release'),0) AS released
    FROM client_invoices ci LEFT JOIN project_trades pt ON pt.id=ci.project_trade_id LEFT JOIN trades tr ON tr.id=pt.trade_id LEFT JOIN qb_invoices qi ON qi.qb_id=ci.qb_invoice_id
    WHERE ci.project_id=$1 AND NOT ci.is_retainage ORDER BY ci.invoice_date, ci.number, tr.name`, [projectId]);
  const groups = new Map(); for (const r of rows) if (r.qb_invoice_id) { const g = groups.get(r.qb_invoice_id) ?? groups.set(r.qb_invoice_id, { gross: 0, net: 0 }).get(r.qb_invoice_id); g.gross += toCents(Number(r.amount)); g.net += toCents(Number(r.amount)) - toCents(Number(r.retainage_held)); }
  const out = [], unclear = [], settle = [];
  for (const r of rows) {
    const amount = Number(r.amount), held = Number(r.retainage_held), base = { id: r.id, number: r.number, trade: r.trade, date: r.invoice_date, owedNow: r2(amount - held), loggedNow: held };
    if (r.qb_invoice_id && Array.isArray(r.qb_lines) && r.qb_lines.some((l) => l.retainage)) continue;   // QuickBooks shows the retainage on the invoice itself
    let payable, note = '';
    if (r.net_basis) payable = r2(amount - held);
    else if (!(held > 0)) payable = amount;
    else if (r.qb_invoice_id) {
      const g = groups.get(r.qb_invoice_id), total = toCents(Number(r.imported_total ?? r.qb_total ?? NaN));
      if (Math.abs(g.gross - total) <= 2) { payable = amount; note = 'The retainage was taken off the QuickBooks invoice. The full invoice is owed.'; }
      else if (Math.abs(g.net - total) <= 2) payable = r2(amount - held);
      else { unclear.push({ ...base, note: 'This no longer adds up to the QuickBooks invoice, so it is left as it is. Check it by hand.' }); continue; }
    } else { payable = amount; note = 'Entered by hand: the invoice amount is treated as what gets paid.'; }
    const logged = retainageOn(payable, pct);
    if (Number(r.released) > logged + 0.005) { unclear.push({ ...base, note: `Retainage of ${Number(r.released).toFixed(2)} was already recorded as received on this invoice, more than would be logged. Left as it is.` }); continue; }
    const after = { ...base, owedAfter: payable, loggedAfter: logged, workBilledAfter: r2(payable + logged), note };
    if (Math.abs(r2(payable + logged) - amount) > 0.005 || Math.abs(logged - held) > 0.005) out.push(after); else if (!r.net_basis) settle.push(r.id);
  }
  const tot = (k) => r2(out.reduce((n, x) => n + x[k], 0));
  return { pct, rows: out, unclear, settle, totals: { owedNow: tot('owedNow'), owedAfter: tot('owedAfter'), loggedNow: tot('loggedNow'), loggedAfter: tot('loggedAfter') } };
}
// Makes the changes `retainageCheck` lists, all or nothing. The billing rules must still hold afterwards.
export async function retainageApply(projectId) {
  return run(async (t) => {
    await lockProjects(t, [projectId]);
    const c = await retainageCheck(projectId, t);
    for (const r of c.rows) await t('UPDATE client_invoices SET amount=$2, retainage_held=$3, net_basis=true WHERE id=$1 AND project_id=$4', [r.id, r.workBilledAfter, r.loggedAfter, projectId]);
    if (c.settle.length) await t('UPDATE client_invoices SET net_basis=true WHERE id = ANY($1::uuid[]) AND project_id=$2', [c.settle, projectId]);
    try { await assertValid(t, projectId); }
    catch (e) { throw e instanceof HttpError && e.status === 400 ? bad(`Not changed. ${e.message} The retainage logged counts as work billed, so each trade's contract has to cover its invoices plus the retainage. Check the trade's contract amount, or the project's retainage percent.`) : e; }
    return { changed: c.rows.length, unclear: c.unclear.length };
  });
}
export async function updateInvoice(projectId, id, b) {
  return run(async (t) => {
    await lockProjects(t, [projectId]);
    const [cur] = await t('SELECT * FROM client_invoices WHERE id=$1 AND project_id=$2', [id, projectId]);
    if (!cur) throw new HttpError(404, 'Invoice not found.');
    const v = {};
    if (b.number !== undefined) v.number = text(b.number, 'Invoice #', { max: 60 });
    if (b.amount !== undefined) { v.amount = money(b.amount, 'Invoice amount'); if (!(v.amount > 0)) throw bad('Invoice amount must be greater than zero.'); }
    if (b.retainageHeld !== undefined) v.retainage_held = cur.is_retainage || b.retainageHeld === '' || b.retainageHeld === null ? 0 : money(b.retainageHeld, 'Retainage');
    // entered the way it was sent: the invoice total stays what will be paid, and the retainage logged sits on top of it
    if (b.payable !== undefined) { const pay = money(b.payable, 'Invoice amount'); if (!(pay > 0)) throw bad('Invoice amount must be greater than zero.'); v.amount = r2(pay + (v.retainage_held ?? Number(cur.retainage_held))); v.net_basis = true; }
    else if (b.retainageHeld !== undefined && b.amount === undefined && cur.net_basis) v.amount = r2(Number(cur.amount) - Number(cur.retainage_held) + v.retainage_held);
    if (b.date !== undefined) v.invoice_date = dateStr(b.date, 'Invoice date', true);
    if (b.dueDate !== undefined) v.due_date = dateStr(b.dueDate, 'Due date');
    if (b.projectTradeId !== undefined) { await ownsTrade(t, projectId, b.projectTradeId); v.project_trade_id = b.projectTradeId; }
    const m = { ...cur, ...v };
    if (m.retainage_held > m.amount) throw bad('Retainage cannot exceed the invoice amount.');
    if (m.due_date && m.due_date < m.invoice_date) throw bad('Due date cannot precede the invoice date.');
    const keys = Object.keys(v); if (!keys.length) throw bad('Nothing to save.');
    await t(`UPDATE client_invoices SET ${keys.map((k, i) => `${k}=$${i + 3}`).join(',')} WHERE id=$1 AND project_id=$2`, [id, projectId, ...keys.map((k) => v[k])]);
    await assertValid(t, projectId);
  });
}
export const deleteInvoice = (projectId, id) => run(async (t) => {
  await lockProjects(t, [projectId]);
  if (!(await t('DELETE FROM client_invoices WHERE id=$1 AND project_id=$2 RETURNING id', [id, projectId])).length) throw new HttpError(404, 'Invoice not found.');
  await assertValid(t, projectId);
});
export async function addClientPayment(projectId, invoiceId, b) {
  const amount = money(b.amount, 'Amount'); if (!(amount > 0)) throw bad('Amount must be greater than zero.');
  const kind = b.kind === 'Retainage Release' ? 'Retainage Release' : 'Payment', date = dateStr(b.date, 'Payment date', true);
  return run(async (t) => {
    await lockProjects(t, [projectId]);
    if (!(await t('SELECT 1 FROM client_invoices WHERE id=$1 AND project_id=$2', [invoiceId, projectId])).length) throw new HttpError(404, 'Invoice not found.');
    await t('INSERT INTO client_payments(client_invoice_id,paid_date,amount,kind) VALUES ($1,$2,$3,$4)', [invoiceId, date, amount, kind]);
    await assertValid(t, projectId);
  });
}
export const deleteClientPayment = (projectId, invoiceId, payId) => run(async (t) => {
  await lockProjects(t, [projectId]);
  if (!(await t(`DELETE FROM client_payments WHERE id=$1 AND client_invoice_id=$2 AND client_invoice_id IN (SELECT id FROM client_invoices WHERE project_id=$3) RETURNING id`, [payId, invoiceId, projectId])).length) throw new HttpError(404, 'Payment not found.');
  await assertValid(t, projectId);
});

// ------------------------------------------------------------------ vendors = subcontractors
export async function getCosts(projectId, { rates = false } = {}) {
  const subs = await q(`SELECT sc.*, s.name AS vendor, s.contact_name, s.phone AS contact_phone, t.name AS trade FROM sub_commitments sc JOIN subcontractors s ON s.id=sc.subcontractor_id
                        LEFT JOIN project_trades pt ON pt.id=sc.project_trade_id LEFT JOIN trades t ON t.id=pt.trade_id WHERE sc.project_id=$1 ORDER BY t.name NULLS LAST, s.name`, [projectId]);
  const bills = subs.length ? await q('SELECT * FROM sub_invoices WHERE commitment_id = ANY($1::uuid[]) ORDER BY invoice_date, number', [subs.map((s) => s.id)]) : [];
  const spay = bills.length ? await q('SELECT * FROM sub_payments WHERE sub_invoice_id = ANY($1::uuid[]) ORDER BY paid_date', [bills.map((b) => b.id)]) : [];
  const comp = new Map((await vendorCompliance()).map((v) => [v.id, v]));
  const vendors = subs.map((s) => {
    const mine = bills.filter((b) => b.commitment_id === s.id).map((b) => {
      const payments = spay.filter((p) => p.sub_invoice_id === b.id);
      return { id: b.id, number: b.number, date: b.invoice_date, amount: b.amount, noInvoice: !!b.no_invoice, memo: b.memo ?? null, paid: r2(payments.reduce((n, p) => n + p.amount, 0)), payments: payments.map((p) => ({ id: p.id, date: p.paid_date, amount: p.amount, method: p.method ?? null, memo: p.memo ?? null })) };
    });
    const invoiced = r2(mine.reduce((n, b) => n + b.amount, 0)), paid = r2(mine.reduce((n, b) => n + b.paid, 0));
    const held = s.hold_released ? 0 : Math.min(s.hold_amount, r2(invoiced - paid));
    return { id: s.id, vendor: s.vendor, contact: s.contact_name ?? null, contactPhone: s.contact_phone ?? null, subcontractorId: s.subcontractor_id, trade: s.trade, projectTradeId: s.project_trade_id, contract: s.contract_amount, invoiced, paid, balance: r2(invoiced - paid),
      remaining: Math.max(0, r2(s.contract_amount - invoiced)), scope: s.scope ?? null, holdAmount: s.hold_amount, holdReason: s.hold_reason, holdReleased: s.hold_released, held, availableToPay: r2(invoiced - paid - held), materialsIncluded: s.materials_included, bills: mine, compliance: { status: comp.get(s.subcontractor_id)?.status, canPay: comp.get(s.subcontractor_id)?.canPay, verified: !!comp.get(s.subcontractor_id)?.verified, reasons: comp.get(s.subcontractor_id)?.blockers ?? [] } };
  });
  const sup = await q(`SELECT sa.id AS alloc_id, sa.amount, sa.project_trade_id, t.name AS trade, si.id AS invoice_id, si.reference, si.description, si.invoice_date, si.total, s.name AS supplier,
                         COALESCE((SELECT SUM(amount) FROM supplier_payments WHERE supplier_invoice_id=si.id),0) paid_total
                       FROM supplier_allocations sa JOIN supplier_invoices si ON si.id=sa.supplier_invoice_id JOIN suppliers s ON s.id=si.supplier_id
                       LEFT JOIN project_trades pt ON pt.id=sa.project_trade_id LEFT JOIN trades t ON t.id=pt.trade_id
                       WHERE sa.project_id=$1 ORDER BY t.name NULLS LAST, si.invoice_date, si.reference`, [projectId]);
  const suppliers = sup.map((r) => {
    const paid = r.total > 0 ? toDollars(Math.round((toCents(r.amount) * toCents(r.paid_total)) / toCents(r.total))) : 0;
    return { allocId: r.alloc_id, invoiceId: r.invoice_id, supplier: r.supplier, reference: r.reference, description: r.description, date: r.invoice_date, trade: r.trade, projectTradeId: r.project_trade_id, amount: r.amount, paid, balance: r2(r.amount - paid), invoiceTotal: r.total };
  });
  const lab = await q(`SELECT t.name AS trade, e.name AS employee, SUM(l.hours) hours, SUM(COALESCE(l.pay, ROUND(l.hours*l.rate,2))) pay FROM labor_entries l JOIN employees e ON e.id=l.employee_id
                       LEFT JOIN project_trades pt ON pt.id=l.project_trade_id LEFT JOIN trades t ON t.id=pt.trade_id WHERE l.project_id=$1 GROUP BY t.name, e.name ORDER BY t.name NULLS LAST, e.name`, [projectId]);
  // Per-employee pay would give away a pay rate, so only the Super Admin gets it. Everyone else sees hours and the cost by trade.
  const byTrade = [...lab.reduce((m, l) => m.set(l.trade, (m.get(l.trade) ?? 0) + Number(l.pay)), new Map())].map(([trade, pay]) => ({ trade, pay: r2(pay) }));
  return { vendors, suppliers, labor: lab.map((l) => ({ trade: l.trade, employee: l.employee, hours: Number(l.hours), pay: rates ? Number(l.pay) : null })), laborByTrade: byTrade };
}
export async function addCommitment(projectId, b) {
  const contract = money(b.contractAmount, 'Subcontract amount'), hold = b.holdAmount === undefined || b.holdAmount === '' ? 0 : money(b.holdAmount, 'Final-payment hold');
  if (!b.subcontractorId) throw bad('Choose a vendor.');
  return run(async (t) => {
    await lockProjects(t, [projectId]);
    if (b.projectTradeId) await ownsTrade(t, projectId, b.projectTradeId);
    const [r] = await t(`INSERT INTO sub_commitments(project_id,project_trade_id,subcontractor_id,contract_amount,hold_amount,hold_reason,materials_included,scope) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [projectId, b.projectTradeId || null, b.subcontractorId, contract, hold, text(b.holdReason, 'Hold reason', { max: 200, required: false }) || null, !!b.materialsIncluded, text(b.scope, 'Scope', { max: 300, required: false }) || null]);
    if (hold > contract) throw bad('The hold cannot exceed the subcontract amount.');
    await assertValid(t, projectId); return { id: r.id };
  });
}
export async function updateCommitment(projectId, id, b) {
  return run(async (t) => {
    await lockProjects(t, [projectId]);
    const [cur] = await t('SELECT * FROM sub_commitments WHERE id=$1 AND project_id=$2', [id, projectId]);
    if (!cur) throw new HttpError(404, 'Subcontract not found.');
    const v = {};
    if (b.contractAmount !== undefined) v.contract_amount = money(b.contractAmount, 'Subcontract amount');
    if (b.holdAmount !== undefined) v.hold_amount = money(b.holdAmount, 'Final-payment hold');
    if (b.holdReason !== undefined) v.hold_reason = text(b.holdReason, 'Hold reason', { max: 200, required: false }) || null;
    if (b.scope !== undefined) v.scope = text(b.scope, 'Scope', { max: 300, required: false }) || null;
    if (b.holdReleased !== undefined) { if (typeof b.holdReleased !== 'boolean') throw bad('holdReleased must be true or false.'); v.hold_released = b.holdReleased; }
    if (b.materialsIncluded !== undefined) v.materials_included = !!b.materialsIncluded;
    if (b.projectTradeId !== undefined) { if (b.projectTradeId) await ownsTrade(t, projectId, b.projectTradeId); v.project_trade_id = b.projectTradeId || null; }
    const m = { ...cur, ...v }; if (m.hold_amount > m.contract_amount) throw bad('The hold cannot exceed the subcontract amount.');
    const keys = Object.keys(v); if (!keys.length) throw bad('Nothing to save.');
    await t(`UPDATE sub_commitments SET ${keys.map((k, i) => `${k}=$${i + 3}`).join(',')} WHERE id=$1 AND project_id=$2`, [id, projectId, ...keys.map((k) => v[k])]);
    await assertValid(t, projectId);
  });
}
export const deleteCommitment = (projectId, id) => run(async (t) => {
  await lockProjects(t, [projectId]);
  if (!(await t('DELETE FROM sub_commitments WHERE id=$1 AND project_id=$2 RETURNING id', [id, projectId])).length) throw new HttpError(404, 'Subcontract not found.');
  await assertValid(t, projectId);
});
export async function addSubBill(projectId, commitmentId, b) {
  const amount = money(b.amount, 'Bill amount'); if (!(amount > 0)) throw bad('Bill amount must be greater than zero.');
  return run(async (t) => {
    await lockProjects(t, [projectId]);
    if (!(await t('SELECT 1 FROM sub_commitments WHERE id=$1 AND project_id=$2', [commitmentId, projectId])).length) throw new HttpError(404, 'Subcontract not found.');
    const [r] = await t('INSERT INTO sub_invoices(commitment_id,number,invoice_date,amount) VALUES ($1,$2,$3,$4) RETURNING id', [commitmentId, text(b.number, 'Bill #', { max: 60 }), dateStr(b.date, 'Bill date'), amount]);
    await assertValid(t, projectId); return { id: r.id };
  });
}
export const deleteSubBill = (projectId, commitmentId, id) => run(async (t) => {
  await lockProjects(t, [projectId]);
  if (!(await t(`DELETE FROM sub_invoices WHERE id=$1 AND commitment_id=$2 AND commitment_id IN (SELECT id FROM sub_commitments WHERE project_id=$3) RETURNING id`, [id, commitmentId, projectId])).length) throw new HttpError(404, 'Bill not found.');
  await assertValid(t, projectId);
});
// Records a vendor payment inside a transaction. Compliance (W-9 + valid insurance) and the held final payment are enforced here,
// so every path that pays a vendor (direct entry by an approver, or an approved request) obeys the same rules.
export async function recordSubPayment(t, projectId, billId, amount, date, how = {}) {
  await lockProjects(t, [projectId]);   // take turns with anyone else paying or billing on this project
  const [bill] = await t(`SELECT si.amount, si.id, sc.subcontractor_id, sc.hold_amount, sc.hold_released,
      COALESCE((SELECT SUM(si2.amount) FROM sub_invoices si2 WHERE si2.commitment_id=sc.id),0) invoiced,
      COALESCE((SELECT SUM(sp.amount) FROM sub_payments sp JOIN sub_invoices si3 ON si3.id=sp.sub_invoice_id WHERE si3.commitment_id=sc.id),0) paid_all,
      COALESCE((SELECT SUM(amount) FROM sub_payments WHERE sub_invoice_id=si.id),0) paid_bill
    FROM sub_invoices si JOIN sub_commitments sc ON sc.id=si.commitment_id WHERE si.id=$1 AND sc.project_id=$2`, [billId, projectId]);
  if (!bill) throw new HttpError(404, 'Bill not found.');
  const bypass = await assertCanPay(t, bill.subcontractor_id, undefined, { allowUnverified: !!how.allowUnverified });
  if (bypass) how = { ...how, memo: [how.memo, `Paid while unverified (${bypass.blockers.join('; ')}); the Super Admin chose to proceed.`].filter(Boolean).join(' | ') };
  if (toCents(bill.paid_bill) + toCents(amount) > toCents(bill.amount)) throw bad('That is more than is left on this bill.');
  const open = r2(Number(bill.invoiced) - Number(bill.paid_all));
  const available = r2(open - (bill.hold_released ? 0 : Math.min(Number(bill.hold_amount), open)));
  if (amount > available + 0.001) throw bad(`Only ${available.toFixed(2)} is available to pay. The rest is held until the hold is released.`);
  const [pay] = await t('INSERT INTO sub_payments(sub_invoice_id,paid_date,amount,method,memo) VALUES ($1,$2,$3,$4,$5) RETURNING id', [billId, date, amount, how.method ?? null, how.memo ?? null]);
  await assertValid(t, projectId);
  return pay.id;
}
// A payment with no invoice behind it: cash, Zelle, a check written on the spot, or a credit where no money moved. The person says how and why, and it
// is kept as a bill marked "no invoice" so the subcontract, what is owed and the 1099 totals all stay right.
export const NO_INVOICE_METHODS = ['Cash', 'Zelle', 'Check', 'Card', 'Credit / Offset (no money paid)', 'Other'];
export function readNoInvoice(b) {
  const amount = money(b.amount, 'Amount'); if (!(amount > 0)) throw bad('Amount must be greater than zero.');
  const method = String(b.method || ''); if (!NO_INVOICE_METHODS.includes(method)) throw bad('Choose how it was paid.');
  const memo = text(b.explanation, 'Explanation', { max: 500 });   // required: why there is no invoice
  return { amount, method, memo, date: dateStr(b.date, 'Payment date', true) };
}
export async function makeNoInvoiceBill(t, commitmentId, { amount, date, memo, method }) {
  const [n] = await t(`SELECT count(*)::int AS n FROM sub_invoices WHERE commitment_id=$1 AND no_invoice`, [commitmentId]);
  const [r] = await t('INSERT INTO sub_invoices(commitment_id,number,invoice_date,amount,no_invoice,memo) VALUES ($1,$2,$3,$4,true,$5) RETURNING id', [commitmentId, `NO-INV-${n.n + 1}`, date, amount, `${method}: ${memo}`]);
  return r.id;
}
export async function addPaymentWithoutInvoice(projectId, commitmentId, b, opts = {}) {
  const p = readNoInvoice(b);
  return run(async (t) => {
    await lockProjects(t, [projectId]);
    if (!(await t('SELECT 1 FROM sub_commitments WHERE id=$1 AND project_id=$2 FOR UPDATE', [commitmentId, projectId])).length) throw new HttpError(404, 'Subcontract not found.');
    const billId = await makeNoInvoiceBill(t, commitmentId, p);
    await recordSubPayment(t, projectId, billId, p.amount, p.date, { method: p.method, memo: p.memo, allowUnverified: opts.allowUnverified });   // the same rules as any payment: paperwork on file, the held final payment, the contract amount
    return { id: billId };
  });
}
export async function addSubPayment(projectId, billId, b, opts = {}) {
  const amount = money(b.amount, 'Amount'); if (!(amount > 0)) throw bad('Amount must be greater than zero.');
  return run((t) => recordSubPayment(t, projectId, billId, amount, dateStr(b.date, 'Payment date', true), { allowUnverified: opts.allowUnverified }).then((id) => ({ id })));
}
export const deleteSubPayment = (projectId, payId) => run(async (t) => {
  await lockProjects(t, [projectId]);
  if (!(await t(`DELETE FROM sub_payments WHERE id=$1 AND sub_invoice_id IN (SELECT si.id FROM sub_invoices si JOIN sub_commitments sc ON sc.id=si.commitment_id WHERE sc.project_id=$2) RETURNING id`, [payId, projectId])).length) throw new HttpError(404, 'Payment not found.');
  await assertValid(t, projectId);
});

// ------------------------------------------------------------------ suppliers (one invoice split across projects/trades)
export async function addSupplierInvoice(b) {
  const total = money(b.total, 'Invoice total'); if (!(total > 0)) throw bad('Invoice total must be greater than zero.');
  if (!b.supplierId && !String(b.supplierName || '').trim()) throw bad('Choose a vendor, or type a new one.');
  if (!Array.isArray(b.allocations) || !b.allocations.length) throw bad('Allocate the invoice to at least one project.');
  const allocs = b.allocations.map((a) => { if (!a.projectId) throw bad('Choose a project for each allocation.'); const amt = money(a.amount, 'Allocation amount'); if (!(amt > 0)) throw bad('Allocation amounts must be greater than zero.'); return { projectId: a.projectId, projectTradeId: a.projectTradeId || null, amount: amt }; });
  const diff = toCents(total) - allocs.reduce((n, a) => n + toCents(a.amount), 0);
  if (diff !== 0) throw bad(`Allocations differ from the invoice total by ${toDollars(Math.abs(diff)).toFixed(2)}.`);
  return run(async (t) => {
    await lockProjects(t, allocs.map((x) => x.projectId));
    const supplierId = await resolveSupplier(t, { supplierId: b.supplierId, supplierName: b.supplierName, saveVendor: b.saveVendor });
    const [inv] = await t('INSERT INTO supplier_invoices(supplier_id,reference,invoice_date,total,description) VALUES ($1,$2,$3,$4,$5) RETURNING id', [supplierId, text(b.reference, 'Invoice reference', { max: 80 }), dateStr(b.date, 'Invoice date'), total, text(b.description, 'Description', { max: 500, required: false }) || null]);
    if (b.paid) await t('INSERT INTO supplier_payments(supplier_invoice_id,paid_date,amount) VALUES ($1,$2,$3)', [inv.id, dateStr(b.paidDate, 'Paid date', true), total]);   // already paid (a website purchase, a card charge): recorded as paid when it is added
    for (const a of allocs) {
      if (a.projectTradeId) await ownsTrade(t, a.projectId, a.projectTradeId);
      await t('INSERT INTO supplier_allocations(supplier_invoice_id,project_id,project_trade_id,amount) VALUES ($1,$2,$3,$4)', [inv.id, a.projectId, a.projectTradeId, a.amount]);
    }
    for (const pid of new Set(allocs.map((a) => a.projectId))) await assertValid(t, pid);
    return { id: inv.id };
  });
}
export const deleteSupplierInvoice = (id) => run(async (t) => {
  const projects = await t('SELECT DISTINCT project_id FROM supplier_allocations WHERE supplier_invoice_id=$1 AND project_id IS NOT NULL', [id]);
  await lockProjects(t, projects.map((x) => x.project_id));
  if (!(await t('DELETE FROM supplier_invoices WHERE id=$1 RETURNING id', [id])).length) throw new HttpError(404, 'Invoice not found.');
  for (const p of projects) await assertValid(t, p.project_id);
});
export async function addSupplierPayment(invoiceId, b) {
  const amount = money(b.amount, 'Amount'); if (!(amount > 0)) throw bad('Amount must be greater than zero.');
  return run(async (t) => {
    await lockProjects(t, (await t('SELECT DISTINCT project_id FROM supplier_allocations WHERE supplier_invoice_id=$1 AND project_id IS NOT NULL', [invoiceId])).map((x) => x.project_id));
    await t('SELECT id FROM supplier_invoices WHERE id=$1 FOR UPDATE', [invoiceId]);
    const [inv] = await t('SELECT total, COALESCE((SELECT SUM(amount) FROM supplier_payments WHERE supplier_invoice_id=si.id),0) paid FROM supplier_invoices si WHERE id=$1', [invoiceId]);
    if (!inv) throw new HttpError(404, 'Invoice not found.');
    if (toCents(inv.paid) + toCents(amount) > toCents(inv.total)) throw bad('Payments cannot exceed the invoice total.');
    await t('INSERT INTO supplier_payments(supplier_invoice_id,paid_date,amount) VALUES ($1,$2,$3)', [invoiceId, dateStr(b.date, 'Payment date', true), amount]);
    for (const p of await t('SELECT DISTINCT project_id FROM supplier_allocations WHERE supplier_invoice_id=$1 AND project_id IS NOT NULL', [invoiceId])) await assertValid(t, p.project_id);
  });
}

// ------------------------------------------------------------------ billing notes
// Notes on the Progress Billing tab. Anyone who can see the project's billing can add one; a note can be changed or removed by the
// person who wrote it, or by an admin.
const ADMINS = ['Super Admin', 'Sub Admin', 'Exec Assistant'];
export async function billingNotes(projectId, user) {
  const rows = await q(`SELECT n.id, n.body, n.created_at, n.updated_at, n.user_id, u.name, u.email FROM project_billing_notes n LEFT JOIN app_users u ON u.id=n.user_id WHERE n.project_id=$1 ORDER BY n.created_at DESC`, [projectId]);
  return rows.map((r) => ({ id: r.id, body: r.body, at: r.created_at, editedAt: r.updated_at, by: r.name || r.email || 'Someone', mine: r.user_id === user.id, canChange: r.user_id === user.id || ADMINS.includes(user.role) }));
}
export async function addBillingNote(projectId, user, b) {
  const body = text(b?.body, 'Note', { max: 5000 });
  const [r] = await q('INSERT INTO project_billing_notes(project_id,user_id,body) VALUES ($1,$2,$3) RETURNING id', [projectId, user.id, body]);
  return { id: r.id };
}
const noteFor = async (projectId, user, id) => {
  const [n] = await q('SELECT user_id FROM project_billing_notes WHERE id=$1 AND project_id=$2', [id, projectId]); if (!n) throw new HttpError(404, 'Note not found.');
  if (n.user_id !== user.id && !ADMINS.includes(user.role)) throw new HttpError(403, 'Only the person who wrote this note, or an admin, can change it.');
};
export async function updateBillingNote(projectId, user, id, b) {
  await noteFor(projectId, user, id); const body = text(b?.body, 'Note', { max: 5000 });
  await q('UPDATE project_billing_notes SET body=$2, updated_at=now() WHERE id=$1', [id, body]); return { ok: true };
}
export async function deleteBillingNote(projectId, user, id) { await noteFor(projectId, user, id); await q('DELETE FROM project_billing_notes WHERE id=$1', [id]); return { ok: true }; }
