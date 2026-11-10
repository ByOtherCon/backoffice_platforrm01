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
  return { ...out, total: out.invoices + out.payments + out.costs + out.waiting, allowed, why: allowed ? null : 'QuickBooks is connected to a live company. Disconnect it first; this tool only clears test data.' };
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
