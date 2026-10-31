import { q as defaultQ } from './db.js';
import { toCents, toDollars, tradeStats, projectStats } from '../src/lib/costing.ts';

const blankInput = (original = 0) => ({ original, cos: [], invoices: [], subs: [], suppliers: [], labor: [] });

// Run queries one after another (a transaction client cannot overlap queries).
const all = async (_q, jobs) => { const out = []; for (const j of jobs) out.push(await j()); return out; };

// Gather every cost/billing record for the given projects and shape it for costing.ts.
export async function loadInputs(projectIds, q = defaultQ) {
  const ids = projectIds;
  const [pts, cos, inv, subs, sups, labor] = await all(q, [
    () => q(`SELECT pt.id, pt.project_id, pt.trade_id, t.name, pt.original_amount FROM project_trades pt JOIN trades t ON t.id=pt.trade_id
       WHERE pt.project_id = ANY($1::uuid[]) ORDER BY t.sort, t.name`, [ids]),
    () => q('SELECT project_id, project_trade_id, status, amount FROM change_orders WHERE project_id = ANY($1::uuid[])', [ids]),
    () => q(`SELECT ci.project_id, ci.project_trade_id, ci.amount, ci.retainage_held, ci.due_date,
         COALESCE(SUM(p.amount) FILTER (WHERE p.kind='Payment'),0) payments,
         COALESCE(SUM(p.amount) FILTER (WHERE p.kind='Retainage Release'),0) released
       FROM client_invoices ci LEFT JOIN client_payments p ON p.client_invoice_id=ci.id
       WHERE ci.project_id = ANY($1::uuid[]) GROUP BY ci.id`, [ids]),
    () => q(`SELECT sc.project_id, sc.project_trade_id, sc.contract_amount, sc.hold_amount, sc.hold_released,
         COALESCE((SELECT SUM(si.amount) FROM sub_invoices si WHERE si.commitment_id=sc.id),0) invoiced,
         COALESCE((SELECT SUM(sp.amount) FROM sub_payments sp JOIN sub_invoices si ON si.id=sp.sub_invoice_id WHERE si.commitment_id=sc.id),0) paid
       FROM sub_commitments sc WHERE sc.project_id = ANY($1::uuid[])`, [ids]),
    () => q(`SELECT sa.project_id, sa.project_trade_id, sa.amount, si.total,
         COALESCE((SELECT SUM(amount) FROM supplier_payments WHERE supplier_invoice_id=si.id),0) paid_total
       FROM supplier_allocations sa JOIN supplier_invoices si ON si.id=sa.supplier_invoice_id WHERE sa.project_id = ANY($1::uuid[])`, [ids]),
    () => q('SELECT project_id, project_trade_id, hours, rate, pay FROM labor_entries WHERE project_id = ANY($1::uuid[])', [ids]),
  ]);
  const out = new Map(ids.map((id) => [id, { trades: [], unallocated: { subs: [], suppliers: [], labor: [] } }]));
  const byPt = new Map();
  for (const p of pts) {
    const entry = { ptId: p.id, tradeId: p.trade_id, name: p.name, input: blankInput(p.original_amount) };
    byPt.set(p.id, entry); out.get(p.project_id).trades.push(entry);
  }
  const into = (r, key, item) => {
    if (r.project_trade_id) byPt.get(r.project_trade_id)?.input[key].push(item);
    else if (key !== 'cos' && key !== 'invoices') out.get(r.project_id).unallocated[key].push(item);
  };
  for (const r of cos) into(r, 'cos', { status: r.status, amount: r.amount });
  for (const r of inv) into(r, 'invoices', { amount: r.amount, retainageHeld: r.retainage_held, payments: r.payments, retainageReleased: r.released, dueDate: r.due_date });
  for (const r of subs) into(r, 'subs', { contract: r.contract_amount, invoiced: r.invoiced, paid: r.paid, hold: r.hold_amount, holdReleased: r.hold_released });
  for (const r of sups) {
    const paid = r.total > 0 ? toDollars(Math.round((toCents(r.amount) * toCents(r.paid_total)) / toCents(r.total))) : 0;
    into(r, 'suppliers', { amount: r.amount, paid });
  }
  for (const r of labor) into(r, 'labor', { hours: r.hours, rate: r.rate, pay: r.pay });
  return out;
}

export function summarize(loaded) {
  const trades = loaded.trades.map((t) => ({ id: t.ptId, tradeId: t.tradeId, name: t.name, ...tradeStats(t.input) }));
  const project = projectStats(loaded.trades.map((t) => t.input), loaded.unallocated);
  return { trades, project };
}
