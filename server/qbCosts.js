// QuickBooks costs -> Job Costing. Sync pulls bills, checks, expenses and card charges into a review list (nothing touches costing yet).
// A person says where each one goes (a trade, the whole project, or company overhead) and only then does it become a vendor invoice,
// through the same rules as entering a receipt by hand. Non-project vendors (IRS, insurance...) can be hidden, and the choice is remembered.
// QuickBooks does not give outside apps the bank-feed "for review" list: only what is already recorded (bills, checks, expenses, charges).
import { q, tx } from './db.js';
import { bad, HttpError } from './http.js';
import * as QB from './quickbooks.js';
import { pages, getSettings } from './qbImport.js';
import { createReceipt } from './receipts.js';
import { assertValid } from './projectApi.js';
import { suggestProject, readCostLines, vendorKey, guessOverhead, looksNonProject, matchTrade, OVERHEAD_CATEGORIES } from '../src/lib/qbmatch.ts';
import { toCents, toDollars } from '../src/lib/costing.ts';

const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);
const KINDS = { Check: 'Check', Cash: 'Expense', CreditCard: 'Credit Card' };
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export const CATEGORIES = OVERHEAD_CATEGORIES;

// Pulls what changed since the last sync (everything dated from the start date the first time). Safe to run as often as wanted.
let syncing = null;
export function sync() { return (syncing ||= doSync().finally(() => { syncing = null; })); }
async function doSync() {
  const [st] = await q(`SELECT value FROM app_settings WHERE key='qbo_cost_sync'`), cfg = await getSettings(), started = new Date().toISOString();
  const since = st?.value?.since && st.value.startDate === cfg.startDate ? new Date(Date.parse(st.value.since) - 5 * 60000).toISOString() : null;
  const [bills, purchases, billPays] = await Promise.all([pages('Bill', since, cfg.startDate), pages('Purchase', since, cfg.startDate), pages('BillPayment', since, cfg.startDate)]);
  const projects = await q(`SELECT p.id, p.name, g.name AS gc, p.ref_code AS "refCode", p.proposal_id AS "proposalId" FROM projects p JOIN gcs g ON g.id=p.gc_id`);
  const customers = new Map((await q('SELECT qb_customer_id, project_id FROM qb_customer_map')).map((m) => [m.qb_customer_id, m.project_id]));
  const rules = new Map((await q('SELECT * FROM qb_vendor_rules')).map((r) => [r.vendor_key, r]));
  let added = 0, changed = 0, hidden = 0, payments = 0;
  const one = async (qbType, x) => {
    const total = Math.round(Number(x.TotalAmt) * 100) / 100; if (!Number.isFinite(total)) return;
    const ref = qbType === 'Bill' ? x.VendorRef : x.EntityRef, vId = ref?.value ? String(ref.value) : null, vName = ref?.name ? String(ref.name).slice(0, 200) : null, key = vendorKey(vId, vName);
    const kind = qbType === 'Bill' ? 'Bill' : KINDS[x.PaymentType] || 'Expense', lines = readCostLines(x.Line), memo = [x.PrivateNote, x.Memo].filter(Boolean).join(' ').slice(0, 500) || null;
    const rule = rules.get(key); let sug = null;
    for (const l of lines) { const pid = l.customerId && customers.get(l.customerId); if (pid) { sug = { projectId: pid, how: 'the customer on the line (remembered)' }; break; } }
    if (!sug) { const m = suggestProject({ docNumber: x.DocNumber, customerName: lines.find((l) => l.customerName)?.customerName, memo, lines }, projects); if (m) sug = { projectId: m.projectId, how: m.how }; }
    if (!sug && rule?.project_id) sug = { projectId: rule.project_id, how: 'remembered for this vendor' };
    const over = rule?.overhead_category || (sug ? null : guessOverhead(lines.find((l) => l.account)?.account || x.AccountRef?.name || null, vName));
    const vals = [qbType, String(x.Id), kind, x.DocNumber ?? null, date(x.TxnDate), total, qbType === 'Bill' && x.Balance != null ? Number(x.Balance) : null, key, vId, vName, x.AccountRef?.name ?? null, memo, JSON.stringify(lines), x.MetaData?.LastUpdatedTime ?? null, sug?.projectId ?? null, over, sug?.how ?? (rule?.overhead_category ? 'remembered for this vendor' : over ? 'the account / vendor name' : null)];
    const [cur] = await q('SELECT id, status, imported_total FROM qb_costs WHERE qb_type=$1 AND qb_id=$2', [qbType, String(x.Id)]);
    if (!cur) {
      const hide = !!rule?.hide, credit = x.Credit === true;
      await q(`INSERT INTO qb_costs(qb_type,qb_id,kind,doc_number,txn_date,total,balance,vendor_key,vendor_id,vendor_name,account,memo,lines,qb_updated,suggested_project_id,suggested_overhead,suggested_by,status,rule_id,message)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`, [...vals, hide ? 'Hidden' : credit ? 'Ignored' : 'New', hide ? rule.id : null, credit ? 'A refund or credit from the vendor. Enter it by hand if it should reduce a project cost.' : hide ? 'Hidden: not a project cost (remembered for this vendor).' : null]);
      if (hide) { hidden++; await q('UPDATE qb_vendor_rules SET hits=hits+1 WHERE id=$1', [rule.id]); } else added++;
    } else if (cur.status === 'Imported' || cur.status === 'Changed') {
      const moved = Math.abs(Number(cur.imported_total) - total) > 0.005;   // already in Job Costing: never rewritten behind anyone's back
      await q(`UPDATE qb_costs SET balance=$2, qb_updated=$3, synced_at=now(), status=$4, message=$5 WHERE id=$1`, [cur.id, vals[6], vals[13], moved ? 'Changed' : 'Imported', moved ? `The total in QuickBooks changed from ${Number(cur.imported_total).toFixed(2)} to ${total.toFixed(2)} after it was imported. Check it in Costs.` : null]); if (moved) changed++;
    } else await q(`UPDATE qb_costs SET kind=$1, doc_number=$2, txn_date=$3, total=$4, balance=$5, vendor_key=$6, vendor_id=$7, vendor_name=$8, account=$9, memo=$10, lines=$11, qb_updated=$12, suggested_project_id=$13, suggested_overhead=$14, suggested_by=$15, synced_at=now() WHERE id=$16`, [...vals.slice(2), cur.id]);
  };
  for (const b of bills) await one('Bill', b); for (const p of purchases) await one('Purchase', p);
  for (const p of billPays) for (const ln of p.Line || []) for (const lt of ln.LinkedTxn || []) {
    if (lt.TxnType !== 'Bill') continue; const amt = Math.round(Number(ln.Amount) * 100) / 100, d = date(p.TxnDate); if (!(amt > 0) || !d) continue;
    const r = await q(`INSERT INTO qb_cost_payments(qb_id,bill_qb_id,paid_date,amount) VALUES ($1,$2,$3,$4) ON CONFLICT (qb_id, bill_qb_id) DO UPDATE SET paid_date=$3, amount=$4 WHERE qb_cost_payments.imported = false RETURNING id`, [String(p.Id), String(lt.TxnId), d, amt]);
    if (r.length) payments++;
  }
  let autoPaid = 0; for (const c of await q(`SELECT id FROM qb_costs WHERE qb_type='Bill' AND status IN ('Imported','Changed')`)) { try { autoPaid += await importPayments(c.id); } catch { /* shown on the cost; the rest carry on */ } }
  await q(`INSERT INTO app_settings(key,value) VALUES ('qbo_cost_sync',$1) ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=now()`, [{ since: started, startDate: cfg.startDate, at: started, added, hidden, changed, payments, autoPaid, seen: bills.length + purchases.length }]);
  return { added, hidden, changed, payments, autoPaid, seen: bills.length + purchases.length };
}
export async function lastSync() { const [r] = await q(`SELECT value FROM app_settings WHERE key='qbo_cost_sync'`); return r?.value ?? null; }
export async function counts() {
  const { startDate } = await getSettings();
  const r = await q(`SELECT status, count(*) FILTER (WHERE status <> 'New' OR txn_date IS NULL OR txn_date >= $1)::int n FROM qb_costs GROUP BY 1`, [startDate]);
  return Object.fromEntries(r.filter((x) => x.n).map((x) => [x.status, x.n]));
}

const shape = (r, ctx) => ({ id: r.id, qbType: r.qb_type, kind: r.kind, number: r.doc_number, date: r.txn_date, total: Number(r.total), balance: r.balance === null ? null : Number(r.balance), vendor: r.vendor_name, vendorKey: r.vendor_key, account: r.account, memo: r.memo, lines: r.lines,
  status: r.status, message: r.message, suggestedProjectId: r.suggested_project_id, suggestedProject: r.suggested_name ?? null, suggestedOverhead: r.suggested_overhead, suggestedBy: r.suggested_by, invoiceId: r.supplier_invoice_id, importedAt: r.imported_at,
  looksNonProject: looksNonProject(r.vendor_name, r.account), isSubcontractor: !!ctx?.subs?.has(norm(r.vendor_name)) });
const subsSet = async () => new Set((await q('SELECT name FROM subcontractors')).map((s) => norm(s.name)));
export async function list(status = 'New', search = '') {
  if (!['New', 'Changed', 'Imported', 'Ignored', 'All'].includes(status)) throw bad('Unknown status.');
  const { startDate } = await getSettings(), params = [], where = [`c.status <> 'Hidden'`];
  if (status !== 'All') { params.push(status); where.push(`c.status=$${params.length}`); }
  if (status === 'New') { params.push(startDate); where.push(`(c.txn_date IS NULL OR c.txn_date >= $${params.length})`); }
  if (search.trim()) { params.push('%' + search.trim().toLowerCase().replace(/[%_]/g, '') + '%'); where.push(`(lower(coalesce(c.vendor_name,'')) LIKE $${params.length} OR lower(coalesce(c.doc_number,'')) LIKE $${params.length} OR lower(coalesce(c.memo,'')) LIKE $${params.length} OR lower(coalesce(c.account,'')) LIKE $${params.length} OR lower(c.lines::text) LIKE $${params.length})`); }
  const rows = await q(`SELECT c.*, p.name AS suggested_name FROM qb_costs c LEFT JOIN projects p ON p.id=c.suggested_project_id WHERE ${where.join(' AND ')} ORDER BY c.txn_date DESC NULLS LAST, c.doc_number LIMIT 500`, params);
  const ctx = { subs: await subsSet() }; return rows.map((r) => shape(r, ctx));
}

// ---- hiding what is not a project cost, with a searchable list, and remembering the choice by vendor
export async function hide(id, { learn = false } = {}) {
  return tx(async (t) => {
    const [c] = await t('SELECT * FROM qb_costs WHERE id=$1 FOR UPDATE', [id]); if (!c) throw new HttpError(404, 'Not found.');
    if (c.status !== 'New' && c.status !== 'Ignored') throw new HttpError(409, 'That one is already in Job Costing, so it cannot be hidden.');
    let ruleId = null, n = 1;
    if (learn) {
      const [r] = await t(`INSERT INTO qb_vendor_rules(vendor_key,vendor_name,hide) VALUES ($1,$2,true) ON CONFLICT (vendor_key) DO UPDATE SET hide=true RETURNING id`, [c.vendor_key, c.vendor_name]); ruleId = r.id;
      const more = await t(`UPDATE qb_costs SET status='Hidden', rule_id=$2, message='Hidden: not a project cost (remembered for this vendor).' WHERE vendor_key=$1 AND status IN ('New','Ignored') RETURNING id`, [c.vendor_key, ruleId]); n = more.length;
      await t('UPDATE qb_vendor_rules SET hits=hits+$2 WHERE id=$1', [ruleId, n]);
    } else await t(`UPDATE qb_costs SET status='Hidden', message='Hidden: not a project cost.' WHERE id=$1`, [id]);
    return { hidden: n, vendor: c.vendor_name, remembered: !!learn };
  });
}
export async function unhide(id) { const r = await q(`UPDATE qb_costs SET status='New', rule_id=NULL, message=NULL WHERE id=$1 AND status='Hidden' RETURNING id`, [id]); if (!r.length) throw new HttpError(409, 'That one is not hidden.'); }
// The list of hidden things: remembered vendors and single hidden transactions, both searchable.
export async function hiddenList(search = '') {
  const term = '%' + search.trim().toLowerCase().replace(/[%_]/g, '') + '%', has = !!search.trim();
  const rules = await q(`SELECT r.id, r.vendor_name, r.hits, r.created_at, (SELECT count(*)::int FROM qb_costs c WHERE c.rule_id=r.id AND c.status='Hidden') AS hidden, (SELECT COALESCE(sum(total),0)::float8 FROM qb_costs c WHERE c.rule_id=r.id AND c.status='Hidden') AS amount
      FROM qb_vendor_rules r WHERE r.hide ${has ? 'AND lower(coalesce(r.vendor_name,\'\')) LIKE $1' : ''} ORDER BY lower(r.vendor_name)`, has ? [term] : []);
  const items = await q(`SELECT id, kind, doc_number, txn_date, total, vendor_name, account, memo, rule_id FROM qb_costs WHERE status='Hidden' ${has ? 'AND (lower(coalesce(vendor_name,\'\')) LIKE $1 OR lower(coalesce(memo,\'\')) LIKE $1 OR lower(coalesce(doc_number,\'\')) LIKE $1 OR lower(coalesce(account,\'\')) LIKE $1 OR lower(lines::text) LIKE $1)' : ''} ORDER BY txn_date DESC NULLS LAST LIMIT 300`, has ? [term] : []);
  return { vendors: rules.map((r) => ({ id: r.id, vendor: r.vendor_name, hits: r.hits, hidden: r.hidden, amount: r.amount, since: r.created_at })), items: items.map((r) => ({ id: r.id, kind: r.kind, number: r.doc_number, date: r.txn_date, total: Number(r.total), vendor: r.vendor_name, account: r.account, memo: r.memo, byRule: !!r.rule_id })) };
}
// Forget a hidden vendor: its transactions come back to the review list.
export async function removeRule(id) {
  return tx(async (t) => { const [r] = await t('DELETE FROM qb_vendor_rules WHERE id=$1 RETURNING id', [id]); if (!r) throw new HttpError(404, 'Not found.');
    const back = await t(`UPDATE qb_costs SET status='New', rule_id=NULL, message=NULL WHERE rule_id=$1 AND status='Hidden' RETURNING id`, [id]); return { restored: back.length }; });
}
export async function ignore(id, on = true) {
  const r = await q(`UPDATE qb_costs SET status=$2, message=CASE WHEN $2='Ignored' THEN message ELSE NULL END WHERE id=$1 AND status IN ${on ? "('New')" : "('Ignored')"} RETURNING id`, [id, on ? 'Ignored' : 'New']); if (!r.length) throw new HttpError(409, 'That one is not in the right state for this.');
}

// What the review screen needs for one cost and one project: the trades, and a first guess of the trade for each line.
export async function prepare(id, projectId) {
  const [c] = await q('SELECT * FROM qb_costs WHERE id=$1', [id]); if (!c) throw new HttpError(404, 'Not found.');
  const out = { categories: CATEGORIES, suppliers: (await q('SELECT id, name FROM suppliers WHERE NOT archived ORDER BY name')).map((s) => ({ id: s.id, name: s.name })), rule: (await q('SELECT supplier_id, project_id, overhead_category FROM qb_vendor_rules WHERE vendor_key=$1', [c.vendor_key]))[0] ?? null, project: null, guess: c.lines.map(() => null) };
  const [sup] = await q('SELECT id FROM suppliers WHERE lower(name)=lower($1) LIMIT 1', [c.vendor_name || '']); out.supplierGuess = out.rule?.supplier_id || sup?.id || null;
  if (projectId) {
    const [p] = await q('SELECT id, name FROM projects WHERE id=$1', [projectId]); if (!p) throw new HttpError(404, 'Project not found.');
    const trades = await q(`SELECT pt.id, pt.trade_id, t.name FROM project_trades pt JOIN trades t ON t.id=pt.trade_id WHERE pt.project_id=$1 ORDER BY t.sort, t.name`, [projectId]);
    out.project = { id: p.id, name: p.name, trades: trades.map((x) => ({ id: x.id, name: x.name })) };
    out.guess = c.lines.map((l) => { const t = matchTrade(trades.map((x) => ({ id: x.trade_id, name: x.name })), l.description, l.account, l.item); return t ? trades.find((x) => x.trade_id === t)?.id ?? null : null; });
  }
  return out;
}

// Creates the vendor invoice: lines go to a trade, to the whole project, or to company overhead. All or nothing, and the costing rules still hold.
export async function importCost(user, id, b) {
  return tx(async (t) => {
    const [c] = await t('SELECT * FROM qb_costs WHERE id=$1 FOR UPDATE', [id]); if (!c) throw new HttpError(404, 'Not found.');
    if (c.status === 'Imported' || c.status === 'Changed') throw new HttpError(409, 'This one was already imported.'); if (c.status === 'Hidden') throw new HttpError(409, 'This one is hidden. Unhide it first.');
    if (norm(c.vendor_name) && (await t('SELECT 1 FROM subcontractors WHERE lower(regexp_replace(name,\'[^A-Za-z0-9]+\',\' \',\'g\'))=$1', [norm(c.vendor_name)])).length)
      throw bad(`${c.vendor_name} is a subcontractor. Subcontractor bills go through the project's Costs tab (so payment approvals and compliance checks apply), not this import. Choose Ignore for this one.`);
    const lines = c.lines; if (!lines.length) throw bad('This has no expense lines to import.');
    if (lines.some((l) => !(l.amount > 0))) throw bad('A line is a credit or has no amount. Enter this one by hand in Receipts & Supplier Invoices.');
    const sum = lines.reduce((n, l) => n + toCents(l.amount), 0), diff = toCents(c.total) - sum;
    if (diff < 0) throw bad(`The lines add up to more than the total (${toDollars(sum).toFixed(2)} against ${Number(c.total).toFixed(2)}). Enter this one by hand.`);
    const mode = b.mode === 'overhead' ? 'overhead' : 'project'; let projectId = null, category = null;
    if (mode === 'overhead') { category = String(b.overheadCategory || ''); if (!CATEGORIES.includes(category)) throw bad('Choose the overhead category.'); }
    else { projectId = b.projectId; if (!projectId) throw bad('Choose the project (or company overhead).'); if (!(await t('SELECT 1 FROM projects WHERE id=$1', [projectId])).length) throw bad('Project not found.'); }
    const own = projectId ? new Set((await t('SELECT id FROM project_trades WHERE project_id=$1', [projectId])).map((x) => x.id)) : new Set(), assign = Array.isArray(b.lines) ? b.lines : [];
    const rl = lines.map((l, i) => { const a = assign.find((x) => Number(x.index) === i), ptId = mode === 'project' && a?.projectTradeId ? a.projectTradeId : null; if (ptId && !own.has(ptId)) throw bad('A line is set to a trade that is not on that project.');
      return { description: l.description || l.item || l.account || 'QuickBooks line', amount: l.amount, ...(mode === 'overhead' ? { overheadCategory: category } : { projectId, projectTradeId: ptId }), itemKind: null }; });
    const existing = (await t('SELECT id FROM supplier_invoices WHERE qb_bill_id=$1', [c.qb_type + ':' + c.qb_id]))[0];
    let invoiceId = existing?.id, supplierId = b.supplierId || null;
    if (!existing) {
      if (!supplierId && !String(b.supplierName || c.vendor_name || '').trim()) throw bad('Choose the vendor.');
      let ref = String(c.doc_number || `QB-${c.qb_type[0]}${c.qb_id}`).slice(0, 80);
      const sid = supplierId || (await t('SELECT id FROM suppliers WHERE lower(name)=lower($1)', [String(b.supplierName || c.vendor_name).trim()]))[0]?.id; if (sid && (await t('SELECT 1 FROM supplier_invoices WHERE supplier_id=$1 AND reference=$2', [sid, ref])).length) ref = `${ref}-QB${c.qb_id}`.slice(0, 80);
      const paidNow = c.qb_type === 'Purchase', paidAmount = paidNow ? Number(c.total) : Math.max(0, Number(c.total) - Number(c.balance ?? c.total));
      const r = await createReceipt(user, { supplierId: supplierId || undefined, supplierName: supplierId ? undefined : String(b.supplierName || c.vendor_name).trim(), reference: ref, date: c.txn_date, lines: rl, tax: diff > 0 ? toDollars(diff) : 0, total: Number(c.total), source: 'QuickBooks', qbRef: c.qb_type + ':' + c.qb_id,
        paid: paidAmount > 0.004 && c.qb_type === 'Purchase', paidDate: c.txn_date, paidAmount }, t);
      invoiceId = r.id; const [sinv] = await t('SELECT supplier_id FROM supplier_invoices WHERE id=$1', [invoiceId]); supplierId = sinv.supplier_id;
    } else supplierId = (await t('SELECT supplier_id FROM supplier_invoices WHERE id=$1', [invoiceId]))[0].supplier_id;
    await t(`UPDATE qb_costs SET status='Imported', supplier_invoice_id=$2, imported_at=now(), imported_total=$3, message=NULL WHERE id=$1`, [id, invoiceId, c.total]);
    if (b.remember !== false) {   // learn the vendor: its Job Costing vendor, and where its costs usually go
      await t(`INSERT INTO qb_vendor_rules(vendor_key,vendor_name,hide,project_id,overhead_category,supplier_id) VALUES ($1,$2,false,$3,$4,$5)
               ON CONFLICT (vendor_key) DO UPDATE SET hide=false, project_id=$3, overhead_category=$4, supplier_id=$5`, [c.vendor_key, c.vendor_name, projectId, category, supplierId]);
      for (const l of lines) if (l.customerId && projectId) await t(`INSERT INTO qb_customer_map(qb_customer_id,customer_name,project_id) VALUES ($1,$2,$3) ON CONFLICT (qb_customer_id) DO UPDATE SET project_id=$3, customer_name=$2`, [l.customerId, l.customerName, projectId]);
    }
    if (c.qb_type === 'Bill') await applyPayments(t, c.qb_id, invoiceId);
    if (projectId) await assertValid(t, projectId);
    return { invoiceId, projectId, overhead: category };
  });
}
async function applyPayments(t, billQbId, invoiceId) {
  let n = 0;
  for (const p of await t(`SELECT * FROM qb_cost_payments WHERE bill_qb_id=$1 AND NOT imported ORDER BY paid_date FOR UPDATE`, [billQbId])) {
    const [inv] = await t('SELECT total, COALESCE((SELECT SUM(amount) FROM supplier_payments WHERE supplier_invoice_id=$1),0) paid FROM supplier_invoices WHERE id=$1', [invoiceId]);
    const room = toCents(inv.total) - toCents(inv.paid), amt = Math.min(room, toCents(p.amount)); if (amt > 0) await t('INSERT INTO supplier_payments(supplier_invoice_id,paid_date,amount,qb_payment_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [invoiceId, p.paid_date, toDollars(amt), `${p.qb_id}:${billQbId}`]);
    await t('UPDATE qb_cost_payments SET imported=true WHERE id=$1', [p.id]); n++;
  }
  return n;
}
// Payments made in QuickBooks after the bill was imported are added automatically (a payment is a fact, not a judgement).
async function importPayments(costId) {
  return tx(async (t) => {
    const [c] = await t('SELECT qb_id, supplier_invoice_id FROM qb_costs WHERE id=$1', [costId]); if (!c?.supplier_invoice_id) return 0;
    const projects = await t('SELECT DISTINCT project_id FROM supplier_allocations WHERE supplier_invoice_id=$1 AND project_id IS NOT NULL', [c.supplier_invoice_id]);
    const n = await applyPayments(t, c.qb_id, c.supplier_invoice_id); if (n) for (const p of projects) await assertValid(t, p.project_id); return n;
  });
}
