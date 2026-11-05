// QuickBooks invoices and payments -> Job Costing. Sync pulls them into a review list (nothing touches billing yet); a person confirms the
// project and trades; import then creates the billing records through the same rules as entering them by hand.
import { q, tx } from './db.js';
import { bad, money, HttpError } from './http.js';
import * as QB from './quickbooks.js';
import { assertValid } from './projectApi.js';
import { suggestProject, readLines, splitByTrade, spreadPayment, matchTrade } from '../src/lib/qbmatch.ts';
import { toCents, toDollars } from '../src/lib/costing.ts';

const STATE = 'qbo_sync';
const getState = async () => (await q(`SELECT value FROM app_settings WHERE key=$1`, [STATE]))[0]?.value ?? {};
const putState = (v) => q(`INSERT INTO app_settings(key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=now()`, [STATE, v]);
const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);
const lit = (iso) => String(iso).replace(/[^0-9T:.+\-Z]/g, '');   // only ever our own timestamp goes into a query

async function pages(entity, since) {
  const out = []; const where = since ? ` where MetaData.LastUpdatedTime >= '${lit(since)}'` : '';
  for (let start = 1; start < 5000; start += 100) {
    const r = await QB.query(`select * from ${entity}${where} orderby MetaData.LastUpdatedTime startposition ${start} maxresults 100`);
    const rows = r?.QueryResponse?.[entity] ?? []; out.push(...rows); if (rows.length < 100) break;
  }
  return out;
}
const projectsForMatching = async () => (await q(`SELECT p.id, p.name, g.name AS gc, p.ref_code AS "refCode", p.proposal_id AS "proposalId" FROM projects p JOIN gcs g ON g.id=p.gc_id`));

// Pulls what changed since the last sync (everything the first time). Safe to run as often as wanted.
let syncing = null;
export function sync() { return (syncing ||= doSync().finally(() => { syncing = null; })); }
async function doSync() {
  const st = await getState(), started = new Date().toISOString(), since = st.since ? new Date(Date.parse(st.since) - 5 * 60000).toISOString() : null;   // a small overlap so nothing slips between runs
  const [invoices, payments] = await Promise.all([pages('Invoice', since), pages('Payment', since)]);
  const projects = await projectsForMatching(); let added = 0, changed = 0, paymentsNew = 0, autoPaid = 0;
  const maps = new Map((await q('SELECT qb_customer_id, project_id FROM qb_customer_map')).map((m) => [m.qb_customer_id, m.project_id]));
  for (const inv of invoices) {
    const lines = readLines(inv.Line), total = Math.round(Number(inv.TotalAmt) * 100) / 100; if (!Number.isFinite(total)) continue;
    const memo = [inv.PrivateNote, inv.CustomerMemo?.value].filter(Boolean).join(' ').slice(0, 500) || null;
    const sug = maps.get(inv.CustomerRef?.value) ? { projectId: maps.get(inv.CustomerRef.value), how: 'remembered for this QuickBooks customer' } : suggestProject({ docNumber: inv.DocNumber, customerName: inv.CustomerRef?.name, memo, lines }, projects);
    const [cur] = await q('SELECT id, status, imported_total FROM qb_invoices WHERE qb_id=$1', [String(inv.Id)]);
    const vals = [String(inv.Id), inv.DocNumber ?? null, date(inv.TxnDate), date(inv.DueDate), total, inv.Balance != null ? Number(inv.Balance) : null, inv.CustomerRef?.value ?? null, inv.CustomerRef?.name ?? null, memo, JSON.stringify(lines), inv.MetaData?.LastUpdatedTime ?? null, sug?.projectId ?? null, sug?.how ?? null];
    if (!cur) { await q(`INSERT INTO qb_invoices(qb_id,doc_number,txn_date,due_date,total,balance,customer_id,customer_name,memo,lines,qb_updated,suggested_project_id,suggested_by,project_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$12)`, vals); added++; }
    else if (cur.status === 'Imported' || cur.status === 'Changed') {
      // already in Job Costing: never rewritten behind anyone's back; a changed total is flagged for a person to look at
      const moved = Math.abs(Number(cur.imported_total) - total) > 0.005;
      await q(`UPDATE qb_invoices SET balance=$2, qb_updated=$3, synced_at=now(), status=$4, message=$5 WHERE id=$1`, [cur.id, vals[5], vals[10], moved ? 'Changed' : 'Imported', moved ? `The total in QuickBooks is now ${total.toFixed(2)}; it was ${Number(cur.imported_total).toFixed(2)} when imported. Job Costing was not changed.` : null]); if (moved) changed++;
    } else await q(`UPDATE qb_invoices SET doc_number=$2,txn_date=$3,due_date=$4,total=$5,balance=$6,customer_id=$7,customer_name=$8,memo=$9,lines=$10,qb_updated=$11,suggested_project_id=$12,suggested_by=$13,synced_at=now(), project_id=COALESCE(project_id,$12) WHERE id=$1`, [cur.id, ...vals.slice(1)]);
  }
  for (const p of payments) {
    for (const ln of p.Line || []) for (const lt of ln.LinkedTxn || []) {
      if (lt.TxnType !== 'Invoice') continue; const amt = Math.round(Number(ln.Amount) * 100) / 100, d = date(p.TxnDate); if (!(amt > 0) || !d) continue;
      const r = await q(`INSERT INTO qb_payments(qb_id,invoice_qb_id,paid_date,amount) VALUES ($1,$2,$3,$4) ON CONFLICT (qb_id, invoice_qb_id) DO UPDATE SET paid_date=$3, amount=$4 WHERE qb_payments.imported = false RETURNING id`, [String(p.Id), String(lt.TxnId), d, amt]); paymentsNew += r.length;
    }
  }
  for (const inv of await q(`SELECT id FROM qb_invoices WHERE status IN ('Imported','Changed')`)) { try { autoPaid += await importPayments(inv.id); } catch { /* shown on the invoice; the rest carry on */ } }
  await putState({ since: started, lastRun: started, added, changed, payments: paymentsNew, autoPaid, invoicesSeen: invoices.length, paymentsSeen: payments.length });
  return { added, changed, payments: paymentsNew, autoPaid, invoicesSeen: invoices.length };
}

export async function lastSync() { const s = await getState(); return s.lastRun ? { at: s.lastRun, added: s.added, changed: s.changed, payments: s.payments, autoPaid: s.autoPaid, invoicesSeen: s.invoicesSeen } : null; }
export async function counts() { const r = await q(`SELECT status, count(*)::int n FROM qb_invoices GROUP BY 1`); return Object.fromEntries(r.map((x) => [x.status, x.n])); }

export async function list(status = 'New') {
  if (!['New', 'Imported', 'Ignored', 'Changed', 'All'].includes(status)) throw bad('Unknown status.');
  const rows = await q(`SELECT i.*, p.name AS project_name, s.name AS suggested_name FROM qb_invoices i LEFT JOIN projects p ON p.id=i.project_id LEFT JOIN projects s ON s.id=i.suggested_project_id ${status === 'All' ? '' : 'WHERE i.status=$1'} ORDER BY i.txn_date DESC NULLS LAST, i.doc_number LIMIT 300`, status === 'All' ? [] : [status]);
  const pays = rows.length ? await q('SELECT * FROM qb_payments WHERE invoice_qb_id = ANY($1::text[]) ORDER BY paid_date', [rows.map((r) => r.qb_id)]) : [];
  return rows.map((r) => ({ id: r.id, qbId: r.qb_id, number: r.doc_number, date: r.txn_date, dueDate: r.due_date, total: Number(r.total), balance: r.balance === null ? null : Number(r.balance), customer: r.customer_name, memo: r.memo, lines: r.lines, status: r.status, message: r.message,
    projectId: r.project_id, project: r.project_name, suggestedProjectId: r.suggested_project_id, suggestedBy: r.suggested_by, importedAt: r.imported_at,
    payments: pays.filter((p) => p.invoice_qb_id === r.qb_id).map((p) => ({ id: p.qb_id, date: p.paid_date, amount: Number(p.amount), imported: p.imported })) }));
}

// Project data the review screen needs: its trades and default retainage.
export async function projectInfo(projectId) {
  const [p] = await q('SELECT id, name, retainage_pct FROM projects WHERE id=$1', [projectId]); if (!p) throw new HttpError(404, 'Project not found.');
  const trades = await q('SELECT pt.id, t.name, pt.original_amount::float8 AS contract FROM project_trades pt JOIN trades t ON t.id=pt.trade_id WHERE pt.project_id=$1 ORDER BY t.sort, t.name', [projectId]);
  return { id: p.id, name: p.name, retainagePct: Number(p.retainage_pct), trades };
}
// A first guess of the trade for each line, for the review screen.
export async function guessTrades(invoiceId, projectId) {
  const [inv] = await q('SELECT lines FROM qb_invoices WHERE id=$1', [invoiceId]); if (!inv) throw new HttpError(404, 'Invoice not found.');
  const info = await projectInfo(projectId);
  const trades = (await q('SELECT t.id, t.name FROM trades t JOIN project_trades pt ON pt.trade_id=t.id WHERE pt.project_id=$1', [projectId]));
  const byTradeId = new Map((await q('SELECT id, trade_id FROM project_trades WHERE project_id=$1', [projectId])).map((x) => [x.trade_id, x.id]));
  const guess = inv.lines.map((l) => { const t = l.retainage ? null : matchTrade(trades, l.itemName, l.description) ?? (info.trades.length === 1 ? trades[0]?.id : null); return t ? byTradeId.get(t) ?? null : null; });
  return { project: info, guess };
}

export async function setProject(invoiceId, projectId) {
  if (projectId) await projectInfo(projectId);
  const r = await q(`UPDATE qb_invoices SET project_id=$2 WHERE id=$1 AND status IN ('New','Ignored') RETURNING id`, [invoiceId, projectId || null]); if (!r.length) throw new HttpError(409, 'That invoice is already imported or was not found.');
}
export async function ignore(invoiceId, on = true) {
  const r = await q(`UPDATE qb_invoices SET status=$2 WHERE id=$1 AND status IN ${on ? "('New')" : "('Ignored')"} RETURNING id`, [invoiceId, on ? 'Ignored' : 'New']); if (!r.length) throw new HttpError(409, 'That invoice cannot be changed.');
}

// Creates the billing: one invoice row per trade, payments spread across them. All or nothing, and the billing rules must still hold.
export async function importInvoice(invoiceId, b) {
  const res = await tx(async (t) => {
    const [inv] = await t('SELECT * FROM qb_invoices WHERE id=$1 FOR UPDATE', [invoiceId]); if (!inv) throw new HttpError(404, 'Invoice not found.');
    if (inv.status === 'Imported' || inv.status === 'Changed') throw new HttpError(409, 'This invoice was already imported.');
    const projectId = b.projectId || inv.project_id; if (!projectId) throw bad('Choose the project first.');
    const [proj] = await t('SELECT id, retainage_pct FROM projects WHERE id=$1', [projectId]); if (!proj) throw bad('Project not found.');
    const lines = inv.lines, ptIds = new Set((await t('SELECT id FROM project_trades WHERE project_id=$1', [projectId])).map((x) => x.id));
    const assign = Array.isArray(b.lines) ? b.lines : []; const tradeOf = (i) => { const a = assign.find((x) => Number(x.index) === i)?.projectTradeId; if (a && !ptIds.has(a)) throw bad('A line is set to a trade that is not on that project.'); return a || null; };
    const override = b.retainageHeld === undefined || b.retainageHeld === '' || b.retainageHeld === null ? null : money(b.retainageHeld, 'Retainage held');
    const { splits, unassigned } = splitByTrade(lines, tradeOf, Number(proj.retainage_pct), override);
    if (unassigned.length) throw bad(`Choose a trade for: ${unassigned.slice(0, 3).map((i) => lines[i].description || lines[i].itemName || 'line ' + (i + 1)).join('; ')}${unassigned.length > 3 ? '…' : ''}`);
    if (!splits.length) throw bad('There is nothing to bill on this invoice.');
    const number = String(inv.doc_number || 'QB-' + inv.qb_id).slice(0, 60), d = inv.txn_date || new Date().toISOString().slice(0, 10), due = inv.due_date && inv.due_date >= d ? inv.due_date : null;
    const rowIds = [];
    for (const s of splits) {
      if (!(s.amount > 0)) throw bad('A trade on this invoice nets to zero or less. Check the lines.');
      const [row] = await t(`INSERT INTO client_invoices(project_id,project_trade_id,number,invoice_date,due_date,amount,retainage_held,qb_invoice_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [projectId, s.projectTradeId, number, d, due, s.amount, s.retainage, inv.qb_id]); rowIds.push({ id: row.id, amount: s.amount });
    }
    await t(`UPDATE qb_invoices SET status='Imported', project_id=$2, imported_at=now(), imported_total=$3, message=NULL WHERE id=$1`, [invoiceId, projectId, inv.total]);
    if (inv.customer_id) await t(`INSERT INTO qb_customer_map(qb_customer_id,customer_name,project_id) VALUES ($1,$2,$3) ON CONFLICT (qb_customer_id) DO UPDATE SET project_id=$3, customer_name=$2`, [inv.customer_id, inv.customer_name, projectId]);
    // the contract's schedule: a tentative line for exactly this amount is now invoiced
    const [sch] = await t(`SELECT id FROM invoice_schedule WHERE project_id=$1 AND status='Tentative' AND amount IS NOT NULL AND abs(amount-$2)<0.005 ORDER BY seq LIMIT 1`, [projectId, inv.total]);
    if (sch) await t(`UPDATE invoice_schedule SET status='Invoiced', client_invoice_id=$2 WHERE id=$1`, [sch.id, rowIds[0].id]);
    await applyPayments(t, inv.qb_id, rowIds);
    await assertValid(t, projectId);   // billed cannot pass the contract; payments cannot pass the invoice
    return { projectId, invoices: rowIds.length, scheduled: !!sch };
  });
  return res;
}
async function applyPayments(t, qbInvoiceId, rowIds) {
  let n = 0;
  for (const p of await t(`SELECT * FROM qb_payments WHERE invoice_qb_id=$1 AND NOT imported ORDER BY paid_date FOR UPDATE`, [qbInvoiceId])) {
    const parts = spreadPayment(Number(p.amount), rowIds.map((r) => Number(r.amount)));
    for (let i = 0; i < rowIds.length; i++) if (parts[i] > 0) await t(`INSERT INTO client_payments(client_invoice_id,paid_date,amount,kind,qb_payment_id) VALUES ($1,$2,$3,'Payment',$4) ON CONFLICT DO NOTHING`, [rowIds[i].id, p.paid_date, parts[i], p.qb_id]);
    await t('UPDATE qb_payments SET imported=true WHERE id=$1', [p.id]); n++;
  }
  return n;
}
// Payments that show up later for an invoice already imported are added automatically (a payment is a fact, not a judgement).
async function importPayments(invoiceId) {
  return tx(async (t) => {
    const [inv] = await t('SELECT qb_id, project_id FROM qb_invoices WHERE id=$1', [invoiceId]);
    const rows = await t(`SELECT ci.id, ci.amount::float8 AS amount FROM client_invoices ci WHERE ci.qb_invoice_id=$1 AND ci.project_id=$2 ORDER BY ci.id`, [inv.qb_id, inv.project_id]); if (!rows.length) return 0;
    const n = await applyPayments(t, inv.qb_id, rows); if (n) await assertValid(t, inv.project_id); return n;
  });
}
