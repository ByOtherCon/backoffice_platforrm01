import { q } from './db.js';
import { bad, HttpError } from './http.js';
import { MANAGE, APPROVERS } from './auth.js';
import { dashboard as portfolio, listProjects } from './projectApi.js';
import * as es from './estimating.js';
import * as tc from './timeclock.js';
import * as cp from './compliance.js';
import * as oh from './overheadApi.js';
import { listTodos } from './messaging.js';
import { monthKey, addMonths, projectPeriod, quarterMonths, yearMonths } from '../src/lib/forecast.ts';
import { todayEastern } from '../src/lib/estimating.ts';

export const WIDGETS = ['estimating', 'presence', 'costing', 'chart', 'receivables', 'payables', 'projects', 'forecast', 'compliance', 'overhead', 'todos'];
const r2 = (n) => Math.round(n * 100) / 100;
const can = { estimating: [...MANAGE, 'Estimator'], presence: [...MANAGE, 'Project Manager'], costing: [...MANAGE, 'Project Manager'], chart: MANAGE, receivables: MANAGE, payables: MANAGE, projects: [...MANAGE, 'Project Manager'], forecast: MANAGE, compliance: MANAGE, overhead: APPROVERS, todos: [...MANAGE, 'Estimator', 'Project Manager'] };
export const allowedWidgets = (role) => WIDGETS.filter((w) => can[w].includes(role));

export async function getPrefs(user, key) { const [r] = await q('SELECT value FROM user_prefs WHERE user_id=$1 AND key=$2', [user.id, key]); return r?.value ?? null; }
export async function savePrefs(user, key, value) {
  if (!['dashboard', 'reports'].includes(key)) throw new HttpError(404, 'Not found.');
  if (key === 'reports') {
    if (!Array.isArray(value?.views) || value.views.length > 50 || value.views.some((v) => typeof v?.name !== 'string' || !v.name.trim() || v.name.length > 100 || typeof v.config !== 'object' || typeof v.config?.source !== 'string')) throw bad('Saved reports need a name and a report.');
    value = { views: value.views.map((v) => ({ name: v.name.trim(), config: v.config })) };
  }
  if (JSON.stringify(value ?? null).length > 20000) throw bad('That layout is too large.');
  if (key === 'dashboard') {
    const ok = allowedWidgets(user.role);
    if (!Array.isArray(value?.widgets) || value.widgets.length > 20 || value.widgets.some((w) => typeof w.id !== 'string' || !ok.includes(w.id) || typeof w.visible !== 'boolean')) throw bad('Choose widgets you have access to.');
    if (new Set(value.widgets.map((w) => w.id)).size !== value.widgets.length) throw bad('Each widget can appear once.');
    if (value.period && !['month', 'quarter', 'year'].includes(value.period)) throw bad('Choose month, quarter or year.');
    value = { widgets: value.widgets.map(({ id, visible }) => ({ id, visible })), period: value.period || 'month' };
  }
  await q('INSERT INTO user_prefs(user_id,key,value) VALUES ($1,$2,$3) ON CONFLICT (user_id,key) DO UPDATE SET value=$3, updated_at=now()', [user.id, key, value]);
  return value;
}

// The database clock is UTC, a day ahead of Florida in the evening, so SQL asks for the Eastern date explicitly.
const ET_TODAY = "(now() AT TIME ZONE 'America/New_York')::date";
async function series() {
  const m = (col) => `to_char(${col},'YYYY-MM')`, since = `date_trunc('month', ${ET_TODAY}) - interval '11 months'`;
  const [rev, sub, sup, lab] = await Promise.all([
    q(`SELECT ${m('invoice_date')} AS m, SUM(amount)::float AS v FROM client_invoices WHERE invoice_date >= ${since} GROUP BY 1`),
    q(`SELECT ${m(`COALESCE(invoice_date, ${ET_TODAY})`)} AS m, SUM(amount)::float AS v FROM sub_invoices WHERE COALESCE(invoice_date, ${ET_TODAY}) >= ${since} GROUP BY 1`),
    q(`SELECT ${m(`COALESCE(si.invoice_date, ${ET_TODAY})`)} AS m, SUM(sa.amount)::float AS v FROM supplier_allocations sa JOIN supplier_invoices si ON si.id=sa.supplier_invoice_id WHERE sa.project_id IS NOT NULL AND COALESCE(si.invoice_date, ${ET_TODAY}) >= ${since} GROUP BY 1`),
    q(`SELECT ${m('work_date')} AS m, SUM(COALESCE(pay, hours*rate))::float AS v FROM labor_entries WHERE work_date >= ${since} GROUP BY 1`)]);
  const today = todayEastern(), cur = monthKey(today), months = Array.from({ length: 12 }, (_, i) => addMonths(cur, i - 11));
  const get = (rows, k) => rows.find((r) => r.m === k)?.v ?? 0;
  return months.map((k) => { const revenue = r2(get(rev, k)), cost = r2(get(sub, k) + get(sup, k) + get(lab, k)); return { month: k, revenue, cost, profit: r2(revenue - cost) }; });
}
function aging(rows, today) {
  const b = { 'Not due': 0, '1-30 days': 0, '31-60 days': 0, '61+ days': 0, 'No due date': 0 };
  for (const r of rows) { const owed = r2(r.amount - r.retainage_held - r.payments); if (owed <= 0.001) continue; const d = r.due_date ? Math.round((Date.parse(today) - Date.parse(r.due_date)) / 864e5) : null;
    b[d === null ? 'No due date' : d <= 0 ? 'Not due' : d <= 30 ? '1-30 days' : d <= 60 ? '31-60 days' : '61+ days'] += owed; }
  return Object.entries(b).map(([bucket, amount]) => ({ bucket, amount: r2(amount) }));
}

export async function widgetData(user, { period = 'month' } = {}) {
  const ok = new Set(allowedWidgets(user.role)), out = { role: user.role, widgets: [...ok] }, today = todayEastern(), cur = monthKey(today), year = Number(today.slice(0, 4)), mgr = MANAGE.includes(user.role);
  const jobs = [];
  if (ok.has('estimating')) jobs.push((async () => { const l = await es.list({ tab: 'proposals' }); const i = await es.insights(); out.estimating = { ...l.stats, winRate: i.overall.winRate, pipelineOpen: i.pipeline.open, pipelineValue: i.pipeline.value, expectedAwards: i.pipeline.expected, enough: i.enough }; })());
  if (ok.has('presence')) jobs.push((async () => { const [act, wk] = await Promise.all([tc.activeNow(), q(`SELECT COALESCE(SUM(total_hours),0)::float AS hours FROM time_entries WHERE status='complete' AND work_date >= date_trunc('week', ${ET_TODAY})`)]); out.presence = { active: act.map((a) => ({ employee: a.employee, project: a.project, trade: a.trade, since: a.clock_in, late: a.late_in })), weekHours: wk[0].hours }; })());
  if (ok.has('costing') || ok.has('projects')) jobs.push((async () => { const [d, ps] = await Promise.all([portfolio(user, mgr), listProjects(user, mgr)]); if (ok.has('costing')) out.costing = d;
    out.projects = ps.filter((p) => p.active).sort((a, b) => b.contract - a.contract).slice(0, 12).map((p) => ({ id: p.id, name: p.name, gc: p.gc, contract: p.contract, billed: p.billed, currentlyDue: p.currentlyDue, projectedProfit: p.projectedProfit, marginPct: p.marginPct })); })());
  if (ok.has('chart') || ok.has('forecast')) jobs.push((async () => {
    const s = await series(); out.series = s;
    if (ok.has('forecast')) { const hist = s.map((x) => ({ month: x.month, revenue: x.revenue })); const qn = Math.floor((Number(cur.slice(5)) - 1) / 3) + 1;
      const [back] = await q(`SELECT COALESCE(SUM(GREATEST(contract - billed, 0)),0)::float AS v FROM (SELECT p.id, (SELECT COALESCE(SUM(original_amount),0) FROM project_trades WHERE project_id=p.id) + (SELECT COALESCE(SUM(amount),0) FROM change_orders WHERE project_id=p.id AND status='Approved') AS contract, (SELECT COALESCE(SUM(amount),0) FROM client_invoices WHERE project_id=p.id) AS billed FROM projects p WHERE p.active) x`);
      out.forecast = { month: projectPeriod(hist, cur, [cur]), quarter: projectPeriod(hist, cur, quarterMonths(year, qn)), year: projectPeriod(hist, cur, yearMonths(year)), backlog: r2(back.v), note: 'Based on what has been billed: the average of the last three completed months, carried forward. It needs two months of billing before it shows a number.' }; }
  })());
  if (ok.has('receivables') || ok.has('payables')) jobs.push((async () => {
    if (ok.has('receivables')) { const rows = await q(`SELECT ci.amount::float, ci.retainage_held::float, ci.due_date, COALESCE((SELECT SUM(amount) FROM client_payments WHERE client_invoice_id=ci.id AND kind='Payment'),0)::float AS payments FROM client_invoices ci JOIN projects p ON p.id=ci.project_id WHERE p.active`); out.receivables = aging(rows, today); }
    if (ok.has('payables')) { const [subs, sups] = await Promise.all([
      q(`SELECT s.name, SUM(si.amount - COALESCE((SELECT SUM(amount) FROM sub_payments WHERE sub_invoice_id=si.id),0))::float AS owed FROM sub_invoices si JOIN sub_commitments sc ON sc.id=si.commitment_id JOIN subcontractors s ON s.id=sc.subcontractor_id GROUP BY s.name`),
      q(`SELECT s.name, SUM(si.total - COALESCE((SELECT SUM(amount) FROM supplier_payments WHERE supplier_invoice_id=si.id),0))::float AS owed FROM supplier_invoices si JOIN suppliers s ON s.id=si.supplier_id GROUP BY s.name`)]);
      const all = [...subs.map((r) => ({ ...r, kind: 'Vendor' })), ...sups.map((r) => ({ ...r, kind: 'Supplier' }))].filter((r) => r.owed > 0.001).sort((a, b) => b.owed - a.owed);
      out.payables = { total: r2(all.reduce((n, r) => n + r.owed, 0)), top: all.slice(0, 6).map((r) => ({ name: r.name, kind: r.kind, owed: r2(r.owed) })) }; }
  })());
  if (ok.has('compliance')) jobs.push((async () => { const [v, a, n] = await Promise.all([cp.vendorCompliance(), q(`SELECT COUNT(*) FILTER (WHERE status='Requested')::int AS requested, COUNT(*) FILTER (WHERE status='Approved')::int AS approved FROM payment_requests`), cp.listNtos(year)]);
    const live = v.filter((x) => !x.archived && x.activeProjects.length); out.compliance = { vendorsBlocked: live.filter((x) => !x.canPay).map((x) => x.name), vendorsExpiring: live.filter((x) => x.status === 'Expiring').map((x) => ({ name: x.name, daysLeft: x.daysLeft })), approvalsWaiting: a[0].requested, readyToPay: a[0].approved, ntoNeeded: n.filter((x) => x.status === 'Needed').length, ntoOverdue: n.filter((x) => x.overdue).length }; })());
  if (ok.has('overhead')) jobs.push((async () => { const o = await oh.overview(user); out.overhead = { total: o.allocation.total, basis: o.basis, lines: o.allocation.lines, profitAfterOverhead: r2(o.allocation.byProject.reduce((n, p) => n + p.profitAfterOverhead, 0)), actualSpendThisYear: o.actualSpendThisYear }; })());
  if (ok.has('todos')) jobs.push((async () => { out.todos = (await listTodos(user, { assignedTo: 'me', status: 'Open' })).slice(0, 10); })());
  await Promise.all(jobs); out.period = period; return out;
}
