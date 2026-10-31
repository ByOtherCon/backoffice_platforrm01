// Vendor payments: request -> approve -> pay. The requester cannot approve their own request (the Super Admin may).
import { q, tx } from './db.js';
import { bad, money, text, dateStr, HttpError } from './http.js';
import { APPROVERS, MANAGE } from './auth.js';
import { assertCanPay, notifyRoles, notifyUser } from './compliance.js';
import { recordSubPayment } from './billingApi.js';
import { toCents } from '../src/lib/costing.ts';

const r2 = (n) => Math.round(n * 100) / 100;
const SQL = `SELECT pr.*, p.name AS project, s.id AS subcontractor_id, s.name AS vendor, si.number AS bill, si.amount AS bill_amount, t.name AS trade,
    rq.name AS requested_by_name, rq.email AS requested_by_email, dc.name AS decided_by_name
  FROM payment_requests pr JOIN projects p ON p.id=pr.project_id JOIN sub_invoices si ON si.id=pr.sub_invoice_id JOIN sub_commitments sc ON sc.id=si.commitment_id JOIN subcontractors s ON s.id=sc.subcontractor_id
  LEFT JOIN project_trades pt ON pt.id=sc.project_trade_id LEFT JOIN trades t ON t.id=pt.trade_id JOIN app_users rq ON rq.id=pr.requested_by LEFT JOIN app_users dc ON dc.id=pr.decided_by`;
const shape = (r) => ({ id: r.id, projectId: r.project_id, project: r.project, vendor: r.vendor, trade: r.trade, bill: r.bill, billAmount: r.bill_amount, amount: r.amount, note: r.note, status: r.status,
  requestedBy: r.requested_by_name || r.requested_by_email, requestedById: r.requested_by, requestedAt: r.requested_at, decidedBy: r.decided_by_name, decidedAt: r.decided_at, rejectReason: r.reject_reason, paidDate: r.paid_date, reference: r.reference });
export async function listRequests({ status, projectId } = {}) {
  const w = [], v = [];
  if (status) { v.push(status); w.push(`pr.status=$${v.length}`); }
  if (projectId) { v.push(projectId); w.push(`pr.project_id=$${v.length}`); }
  return (await q(`${SQL} ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY (pr.status='Requested') DESC, (pr.status='Approved') DESC, pr.requested_at DESC LIMIT 300`, v)).map(shape);
}
export async function requestPayment(user, projectId, billId, b) {
  const amount = money(b.amount, 'Amount'); if (!(amount > 0)) throw bad('Amount must be greater than zero.');
  const id = await tx(async (t) => {
    const [bill] = await t(`SELECT si.id, si.amount, sc.subcontractor_id, sc.hold_amount, sc.hold_released,
        COALESCE((SELECT SUM(si2.amount) FROM sub_invoices si2 WHERE si2.commitment_id=sc.id),0) invoiced,
        COALESCE((SELECT SUM(sp.amount) FROM sub_payments sp JOIN sub_invoices si3 ON si3.id=sp.sub_invoice_id WHERE si3.commitment_id=sc.id),0) paid_all,
        COALESCE((SELECT SUM(amount) FROM sub_payments WHERE sub_invoice_id=si.id),0) paid_bill,
        COALESCE((SELECT SUM(pr.amount) FROM payment_requests pr WHERE pr.sub_invoice_id=si.id AND pr.status IN ('Requested','Approved')),0) reserved
      FROM sub_invoices si JOIN sub_commitments sc ON sc.id=si.commitment_id WHERE si.id=$1 AND sc.project_id=$2`, [billId, projectId]);
    if (!bill) throw new HttpError(404, 'Bill not found.');
    await assertCanPay(t, bill.subcontractor_id);
    const open = r2(Number(bill.invoiced) - Number(bill.paid_all));
    const available = r2(open - (bill.hold_released ? 0 : Math.min(Number(bill.hold_amount), open)));
    const left = r2(Math.min(Number(bill.amount) - Number(bill.paid_bill), available) - Number(bill.reserved));
    if (amount > left + 0.001) throw bad(`Only ${Math.max(0, left).toFixed(2)} can be requested (the rest is paid, already requested, or held).`);
    const [r] = await t(`INSERT INTO payment_requests(project_id,sub_invoice_id,amount,note,requested_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [projectId, billId, amount, text(b.note, 'Note', { max: 500, required: false }) || null, user.id]);
    return r.id;
  });
  await notifyRoles(APPROVERS, { kind: 'approval', title: 'Vendor payment needs approval', body: `${user.name || user.email} requested ${amount.toFixed(2)}.`, link: '#/compliance', dedupe: `req:${id}` });
  return { id };
}
const load = async (t, id) => { const [r] = await t('SELECT * FROM payment_requests WHERE id=$1 FOR UPDATE', [id]); if (!r) throw new HttpError(404, 'Request not found.'); return r; };
const subOf = async (t, billId) => (await t('SELECT sc.subcontractor_id FROM sub_invoices si JOIN sub_commitments sc ON sc.id=si.commitment_id WHERE si.id=$1', [billId]))[0].subcontractor_id;
export async function approve(user, id) {
  const r = await tx(async (t) => {
    const r = await load(t, id); if (r.status !== 'Requested') throw bad(`This request is already ${r.status.toLowerCase()}.`);
    if (r.requested_by === user.id && user.role !== 'Super Admin') throw new HttpError(403, 'A different approver is needed. You cannot approve your own request.');
    await assertCanPay(t, await subOf(t, r.sub_invoice_id));
    await t(`UPDATE payment_requests SET status='Approved', decided_by=$2, decided_at=now() WHERE id=$1`, [id, user.id]); return r;
  });
  await notifyUser(r.requested_by, { kind: 'approval', title: 'Your vendor payment was approved', body: 'Ready to pay.', link: '#/compliance', dedupe: `app:${id}` });
}
export async function reject(user, id, reason) {
  const r = await tx(async (t) => {
    const r = await load(t, id); if (!['Requested', 'Approved'].includes(r.status)) throw bad(`This request is already ${r.status.toLowerCase()}.`);
    if (r.requested_by === user.id && user.role !== 'Super Admin') throw new HttpError(403, 'A different approver is needed.');
    await t(`UPDATE payment_requests SET status='Rejected', decided_by=$2, decided_at=now(), reject_reason=$3 WHERE id=$1`, [id, user.id, text(reason, 'Reason', { max: 500 })]); return r;
  });
  await notifyUser(r.requested_by, { kind: 'approval', title: 'Your vendor payment was declined', body: String(reason).slice(0, 200), link: '#/compliance', dedupe: `rej:${id}` });
}
export async function pay(user, id, b) {
  return tx(async (t) => {
    const r = await load(t, id); if (r.status !== 'Approved') throw bad(r.status === 'Paid' ? 'This request is already paid.' : 'Only an approved request can be paid.');
    const payId = await recordSubPayment(t, r.project_id, r.sub_invoice_id, Number(r.amount), dateStr(b.date, 'Payment date', true));
    await t(`UPDATE payment_requests SET status='Paid', paid_date=$2, reference=$3, sub_payment_id=$4 WHERE id=$1`, [id, b.date, text(b.reference, 'Check / reference #', { max: 100, required: false }) || null, payId]);
  });
}
export async function cancel(user, id) {
  return tx(async (t) => {
    const r = await load(t, id); if (!['Requested', 'Approved'].includes(r.status)) throw bad(`This request is already ${r.status.toLowerCase()}.`);
    if (r.requested_by !== user.id && !APPROVERS.includes(user.role)) throw new HttpError(403, 'Only the requester or an approver can cancel.');
    await t('DELETE FROM payment_requests WHERE id=$1', [id]);
  });
}
