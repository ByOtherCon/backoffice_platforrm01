import crypto from 'node:crypto';
import { q, tx, lockProjects } from './db.js';
import { bad, money, text, dateStr, HttpError } from './http.js';
import { assertValid } from './projectApi.js';
import { readReceipt } from './ai.js';
import { saveFile } from './documents.js';
import { resolveSupplier } from './vendors.js';
import { toCents, toDollars } from '../src/lib/costing.ts';
import { setSupplierPayments } from './billingApi.js';
import { splitCents } from '../src/lib/split.ts';

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
// Guess which active project a receipt belongs to from the job name / PO / address printed on it.
export function matchProject(hint, projects) {
  const h = norm(hint); if (!h) return null;
  const scored = projects.map((p) => {
    const words = norm(p.name).split(' ').filter((w) => w.length > 2 && !['the', 'and', 'inc', 'llc'].includes(w));
    const hit = words.filter((w) => h.includes(w)).length;
    return { id: p.id, score: words.length ? hit / words.length : 0 };
  }).filter((x) => x.score >= 0.6).sort((a, b) => b.score - a.score);
  return scored.length && (scored.length === 1 || scored[0].score > scored[1].score) ? scored[0].id : null;
}
export async function parseUpload(user, bytes, filename) {
  const f = await saveFile(bytes, filename);
  const [d] = await q(`INSERT INTO documents(category,name,storage_key,mime,size,created_by,sha256) VALUES ('Receipt',$1,$2,$3,$4,$5,$6) RETURNING id`, [filename, f.key, f.mime, f.size, user.id, f.sha256]);
  const out = { documentId: d.id, parsed: null, aiError: null, suggestedProjectId: null, supplierId: null };
  try {
    out.parsed = await readReceipt(user.id, bytes, f.mime);
    const projects = await q('SELECT id, name FROM projects WHERE active');
    out.suggestedProjectId = matchProject(out.parsed.jobHint, projects);
    if (out.parsed.merchant) { const [s] = await q('SELECT id FROM suppliers WHERE NOT one_time AND (lower(name)=lower($1) OR lower($1) LIKE lower(name)||\'%\' OR lower(name) LIKE lower($1)||\'%\') ORDER BY length(name) LIMIT 1', [out.parsed.merchant.trim()]); out.supplierId = s?.id ?? null; }
  } catch (e) { if (!(e instanceof HttpError)) throw e; out.aiError = e.message; }
  return out;
}
// `outer`: an open transaction to run inside (the QuickBooks cost import does its other writes in the same one).
// The lines of a receipt or vendor invoice, checked, with the tax shared across them (or, with taxIncluded, already in their amounts).
function readLines(b) {
  if (!Array.isArray(b.lines) || !b.lines.length) throw bad('Add at least one line.');
  const lines = b.lines.map((l) => {
    const amount = money(l.amount, 'Line amount'); if (!(amount > 0)) throw bad('Each line must be more than zero.');
    if (!!l.projectId === !!l.overheadCategory) throw bad('Assign every line to a project, or to company overhead.');
    if (l.itemKind && !['Materials', 'Tools', 'Equipment', 'Other'].includes(l.itemKind)) throw bad('Choose Materials, Tools, Equipment or Other.');
    return { amount, projectId: l.projectId || null, projectTradeId: l.projectTradeId || null, overhead: l.overheadCategory ? text(l.overheadCategory, 'Overhead category', { max: 80 }) : null, kind: l.itemKind || null, description: text(l.description, 'Description', { max: 300, required: false }) || null };
  });
  const tax = b.tax === undefined || b.tax === '' || b.tax === null ? 0 : money(b.tax, 'Tax');
  const taxShare = tax > 0 && !b.taxIncluded ? splitCents(toCents(tax), lines.map((l) => l.amount)) : lines.map(() => 0);
  const alloc = lines.map((l, i) => ({ ...l, amount: toDollars(toCents(l.amount) + taxShare[i]) }));
  const total = toDollars(alloc.reduce((n, a) => n + toCents(a.amount), 0));
  if (b.total !== undefined && b.total !== null && b.total !== '' && Math.abs(money(b.total, 'Total') - total) > 0.01) throw bad(`The lines plus tax come to ${total.toFixed(2)}, not ${Number(b.total).toFixed(2)}.`);
  return { alloc, total, tax };
}
async function checkTargets(t, alloc) {
  for (const a of alloc) if (a.projectId) {
    if (!(await t('SELECT 1 FROM projects WHERE id=$1', [a.projectId])).length) throw bad('A project was not found.');
    if (a.projectTradeId && !(await t('SELECT 1 FROM project_trades WHERE id=$1 AND project_id=$2', [a.projectTradeId, a.projectId])).length) throw bad('A trade is not on that project.');
  }
}
export async function createReceipt(user, b, outer = null) {
  const { alloc, total, tax } = readLines(b), date = dateStr(b.date, 'Date', true);
  return (outer ? (fn) => fn(outer) : tx)(async (t) => {
    await lockProjects(t, alloc.map((a) => a.projectId));
    const supplierId = await resolveSupplier(t, { supplierId: b.supplierId, supplierName: b.supplierName, saveVendor: b.saveVendor });
    await checkTargets(t, alloc);
    const ref = text(b.reference, 'Receipt / invoice #', { max: 80, required: false }) || `NO-NUMBER-${crypto.randomUUID().slice(0, 8)}`;
    if (b.documentId && !(await t('SELECT 1 FROM documents WHERE id=$1', [b.documentId])).length) throw bad('Document not found.');
    let inv;
    try { [inv] = await t('INSERT INTO supplier_invoices(supplier_id,reference,invoice_date,total,tax,document_id,source,qb_bill_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id', [supplierId, ref, date, total, tax, b.documentId || null, ['AI', 'QuickBooks'].includes(b.source) ? b.source : 'Manual', b.qbRef || null]); }
    catch (e) { throw e.code === '23505' ? new HttpError(409, 'That supplier already has an invoice with this number.') : e; }
    for (const a of alloc) await t('INSERT INTO supplier_allocations(supplier_invoice_id,project_id,project_trade_id,overhead_category,amount,description,item_kind) VALUES ($1,$2,$3,$4,$5,$6,$7)', [inv.id, a.projectId, a.projectTradeId, a.overhead, a.amount, a.description, a.kind]);
    if (b.paid) await t('INSERT INTO supplier_payments(supplier_invoice_id,paid_date,amount) VALUES ($1,$2,$3)', [inv.id, dateStr(b.paidDate, 'Paid date') || date, b.paidAmount != null ? Math.min(total, money(b.paidAmount, 'Paid amount')) : total]);
    for (const pid of new Set(alloc.map((a) => a.projectId).filter(Boolean))) await assertValid(t, pid);
    return { id: inv.id, total };
  });
}
export const listReceipts = () => q(`SELECT si.id, si.reference, si.invoice_date, si.total, si.tax, si.source, s.name AS supplier, si.document_id,
    COALESCE((SELECT SUM(amount) FROM supplier_payments WHERE supplier_invoice_id=si.id),0) AS paid,
    (SELECT count(*)::int FROM shipments WHERE supplier_invoice_id=si.id) AS shipments, (SELECT count(*)::int FROM shipments WHERE supplier_invoice_id=si.id AND delivered_at IS NOT NULL) AS shipments_delivered,
    (SELECT json_agg(json_build_object('description', sa.description, 'amount', sa.amount, 'kind', sa.item_kind, 'project', p.name, 'trade', t.name, 'overhead', sa.overhead_category) ORDER BY sa.seq)
       FROM supplier_allocations sa LEFT JOIN projects p ON p.id=sa.project_id LEFT JOIN project_trades pt ON pt.id=sa.project_trade_id LEFT JOIN trades t ON t.id=pt.trade_id WHERE sa.supplier_invoice_id=si.id) AS lines
  FROM supplier_invoices si JOIN suppliers s ON s.id=si.supplier_id ORDER BY si.invoice_date DESC NULLS LAST, si.reference LIMIT 200`);

// ------------------------------------------------------------------ editing a vendor invoice or receipt in place
// One vendor invoice or receipt as the edit form needs it: its lines with the amounts as saved (tax already in them).
export async function getSupplierInvoice(id) {
  const [i] = await q(`SELECT si.*, s.name AS supplier, COALESCE((SELECT SUM(amount) FROM supplier_payments WHERE supplier_invoice_id=si.id),0) AS paid FROM supplier_invoices si JOIN suppliers s ON s.id=si.supplier_id WHERE si.id=$1`, [id]);
  if (!i) throw new HttpError(404, 'Vendor invoice not found.');
  const lines = await q(`SELECT sa.description, sa.amount, sa.item_kind, sa.project_id, p.name AS project, sa.project_trade_id, t.name AS trade, sa.overhead_category FROM supplier_allocations sa LEFT JOIN projects p ON p.id=sa.project_id LEFT JOIN project_trades pt ON pt.id=sa.project_trade_id LEFT JOIN trades t ON t.id=pt.trade_id WHERE sa.supplier_invoice_id=$1 ORDER BY sa.seq`, [id]);
  return { id: i.id, supplierId: i.supplier_id, supplier: i.supplier, reference: String(i.reference).startsWith('NO-NUMBER') ? '' : i.reference, date: i.invoice_date instanceof Date ? i.invoice_date.toISOString().slice(0, 10) : i.invoice_date, total: Number(i.total), tax: Number(i.tax || 0), description: i.description || '', paid: Number(i.paid), source: i.source,
    payments: (await q('SELECT id, paid_date, amount FROM supplier_payments WHERE supplier_invoice_id=$1 ORDER BY paid_date', [id])).map((p) => ({ id: p.id, date: p.paid_date instanceof Date ? p.paid_date.toISOString().slice(0, 10) : p.paid_date, amount: Number(p.amount) })),
    lines: lines.map((l) => ({ description: l.description || '', amount: Number(l.amount), kind: l.item_kind || 'Materials', projectId: l.project_id, project: l.project, projectTradeId: l.project_trade_id, trade: l.trade, overhead: l.overhead_category })) };
}
// Saves the edited invoice: vendor, number, date, description, and its lines (projects, trades, overhead, amounts). Payments stay as
// they are, so the new total cannot be less than what has been paid. Every project it was on, or is on now, is checked again.
export async function updateSupplierInvoice(id, b) {
  const { alloc, total, tax } = readLines({ ...b, taxIncluded: true }), date = dateStr(b.date, 'Date', true);
  return tx(async (t) => {
    const [cur] = await t('SELECT * FROM supplier_invoices WHERE id=$1 FOR UPDATE', [id]); if (!cur) throw new HttpError(404, 'Vendor invoice not found.');
    const before = (await t('SELECT DISTINCT project_id FROM supplier_allocations WHERE supplier_invoice_id=$1 AND project_id IS NOT NULL', [id])).map((r) => r.project_id);
    const all = [...new Set([...before, ...alloc.map((a) => a.projectId).filter(Boolean)])];
    await lockProjects(t, all); await checkTargets(t, alloc);
    const [{ paid }] = await t('SELECT COALESCE(SUM(amount),0) AS paid FROM supplier_payments WHERE supplier_invoice_id=$1', [id]);
    if (!Array.isArray(b.payments) && toCents(total) < toCents(Number(paid))) throw bad(`$${Number(paid).toFixed(2)} has already been paid on this invoice, more than the new total of $${total.toFixed(2)}. Change the payment first.`);
    const supplierId = b.supplierId || b.supplierName ? await resolveSupplier(t, { supplierId: b.supplierId, supplierName: b.supplierName, saveVendor: b.saveVendor }) : cur.supplier_id;
    const ref = text(b.reference, 'Receipt / invoice #', { max: 80, required: false }) || (String(cur.reference).startsWith('NO-NUMBER') ? cur.reference : `NO-NUMBER-${crypto.randomUUID().slice(0, 8)}`);
    try { await t('UPDATE supplier_invoices SET supplier_id=$2, reference=$3, invoice_date=$4, total=$5, tax=$6, description=$7 WHERE id=$1', [id, supplierId, ref, date, total, tax, text(b.description, 'Description', { max: 500, required: false }) || null]); }
    catch (e) { throw e.code === '23505' ? new HttpError(409, 'That vendor already has an invoice with this number.') : e; }
    await t('DELETE FROM supplier_allocations WHERE supplier_invoice_id=$1', [id]);
    for (const a of alloc) await t('INSERT INTO supplier_allocations(supplier_invoice_id,project_id,project_trade_id,overhead_category,amount,description,item_kind) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, a.projectId, a.projectTradeId, a.overhead, a.amount, a.description, a.kind]);
    if (Array.isArray(b.payments)) await setSupplierPayments(t, id, b.payments);
    for (const pid of all) await assertValid(t, pid);
    return { id, total };
  });
}
