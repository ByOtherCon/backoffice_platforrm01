// Going live with QuickBooks: removes everything that came from the Intuit SANDBOX (test) company, so only real figures are left.
// It only runs while the connection is a sandbox one or QuickBooks is disconnected, so it can never wipe data read from a live company.
import { q, tx } from './db.js';
import { HttpError } from './http.js';
import * as QB from './quickbooks.js';

const COUNTS = {
  invoices: `SELECT count(*)::int n FROM client_invoices WHERE qb_invoice_id IS NOT NULL`,
  payments: `SELECT count(*)::int n FROM client_payments WHERE qb_payment_id IS NOT NULL OR client_invoice_id IN (SELECT id FROM client_invoices WHERE qb_invoice_id IS NOT NULL)`,
  costs: `SELECT count(*)::int n FROM supplier_invoices WHERE qb_bill_id IS NOT NULL OR source='QuickBooks'`,
  waiting: `SELECT (SELECT count(*) FROM qb_invoices) + (SELECT count(*) FROM qb_costs)  AS n`,
};
export async function summary() {
  const st = await QB.status(), out = {};
  for (const [k, sql] of Object.entries(COUNTS)) out[k] = Number((await q(sql))[0].n);
  const allowed = !st.connected || st.connectedEnvironment === 'sandbox';
  return { ...out, leftover: await leftoverSummary(), total: out.invoices + out.payments + out.costs + out.waiting, allowed, why: allowed ? null : 'QuickBooks is connected to a live company. Disconnect it first; this tool only clears test data.' };
}
// Test rows left behind after connecting the real company: everything read from QuickBooks before the live connection was made.
async function leftoverSets() {
  const st = await QB.status(); if (!st.connected || st.connectedEnvironment === 'sandbox' || !st.connectedAt) return null;
  const inv = await q('SELECT qb_id, customer_id FROM qb_invoices WHERE synced_at < $1', [st.connectedAt]);
  const costs = await q('SELECT qb_type, qb_id, supplier_invoice_id FROM qb_costs WHERE synced_at < $1', [st.connectedAt]);
  return { inv, costs, cutoff: st.connectedAt };
}
export async function leftoverSummary() { const l = await leftoverSets(); return l ? { invoices: l.inv.length, costs: l.costs.length, total: l.inv.length + l.costs.length } : null; }
export async function clearLeftover(user, b) {
  const l = await leftoverSets(); if (!l) throw new HttpError(409, 'QuickBooks is not connected to a live company, so there are no leftover test rows to separate. Use Clear Test Data.');
  if (String(b?.confirm || '').trim().toLowerCase() !== 'clear') throw new HttpError(400, 'Type CLEAR to confirm.');
  const ids = l.inv.map((x) => x.qb_id), bills = l.costs.filter((c) => c.qb_type === 'Bill').map((c) => c.qb_id), sis = l.costs.map((c) => c.supplier_invoice_id).filter(Boolean), customers = [...new Set(l.inv.map((x) => x.customer_id).filter(Boolean))];
  await tx(async (t) => {
    await t('DELETE FROM client_invoices WHERE qb_invoice_id = ANY($1::text[])', [ids]);
    await t('DELETE FROM qb_payments WHERE invoice_qb_id = ANY($1::text[])', [ids]);
    await t('DELETE FROM qb_invoices WHERE qb_id = ANY($1::text[]) AND synced_at < $2', [ids, l.cutoff]);
    await t('DELETE FROM supplier_invoices WHERE id = ANY($1::uuid[]) OR qb_bill_id = ANY($2::text[])', [sis, bills]);
    await t('DELETE FROM qb_cost_payments WHERE bill_qb_id = ANY($1::text[])', [bills]);
    await t('DELETE FROM qb_costs WHERE synced_at < $1', [l.cutoff]);
    await t('DELETE FROM qb_customer_map WHERE qb_customer_id = ANY($1::text[]) AND qb_customer_id NOT IN (SELECT customer_id FROM qb_invoices WHERE customer_id IS NOT NULL)', [customers]);
    await t(`UPDATE app_settings SET value = value - 'since', updated_at=now() WHERE key IN ('qbo_sync')`);   // the next sync reads the live company again from the start date
    await t(`UPDATE app_settings SET value = value - 'since', updated_at=now() WHERE key='qbo_cost_sync'`);
  });
  console.log(`QuickBooks test rows separated by ${user.email}: ${l.inv.length} invoices, ${l.costs.length} costs.`);
  return { removed: { invoices: l.inv.length, costs: l.costs.length } };
}
export async function clearTestData(user, b) {
  const s = await summary(); if (!s.allowed) throw new HttpError(409, s.why);
  if (String(b?.confirm || '').trim().toLowerCase() !== 'clear') throw new HttpError(400, 'Type CLEAR to confirm.');
  await tx(async (t) => {
    await t('DELETE FROM qb_costs'); await t('DELETE FROM qb_cost_payments'); await t('DELETE FROM qb_vendor_rules');
    await t('DELETE FROM qb_payments'); await t('DELETE FROM qb_invoices'); await t('DELETE FROM qb_customer_map');
    await t('DELETE FROM client_invoices WHERE qb_invoice_id IS NOT NULL');                         // their payments go with them
    await t('DELETE FROM client_payments WHERE qb_payment_id IS NOT NULL');
    await t(`DELETE FROM supplier_invoices WHERE qb_bill_id IS NOT NULL OR source='QuickBooks'`);   // allocations and payments go with them
    await t('DELETE FROM sub_invoices WHERE qb_bill_id IS NOT NULL');
    // the next sync reads everything again from the chosen start date; the person's own choices (start date, automatic logging) stay
    await t(`UPDATE app_settings SET value = value - 'since' - 'lastRun' - 'added' - 'changed' - 'payments' - 'autoPaid' - 'auto' - 'needLook' - 'invoicesSeen', updated_at=now() WHERE key='qbo_sync'`);
    await t(`DELETE FROM app_settings WHERE key='qbo_cost_sync'`);
  });
  console.log(`QuickBooks test data cleared by ${user.email}: ${s.invoices} invoices, ${s.costs} costs, ${s.waiting} waiting rows.`);
  return { cleared: s, now: await summary() };
}
