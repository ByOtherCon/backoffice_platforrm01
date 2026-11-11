// The Projects page: a small summary for the year (active and inactive projects, money, notices to owner), the alerts and deadlines
// that need a person, and one row per project for the editable list.
import { q } from './db.js';
import { listProjects } from './projectApi.js';
import { ntosFor } from './compliance.js';
import { todayEastern, shift } from '../src/lib/estimating.ts';
import { addrLine } from '../src/lib/workflow.ts';

const money = (n) => (n == null ? '$0' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n));
const sev = { high: 0, medium: 1, info: 2 };
export async function projectsHome(user, manageAll, yearArg) {
  const today = todayEastern(), thisYear = Number(today.slice(0, 4));
  const all = await listProjects(user, manageAll); const ids = all.map((p) => p.id);
  const meta = ids.length ? await q(`SELECT p.id, p.start_date, p.logged_date, p.address, p.city, p.state, p.zip, p.contract_document_id, p.proposal_id, p.ref_code,
      EXTRACT(YEAR FROM COALESCE(p.start_date, p.logged_date))::int AS year FROM projects p WHERE p.id = ANY($1::uuid[])`, [ids]) : [];
  const by = new Map(meta.map((m) => [m.id, m]));
  const years = [...new Set([thisYear, ...meta.map((m) => m.year).filter(Boolean)])].sort((a, b) => b - a);
  const year = years.includes(Number(yearArg)) ? Number(yearArg) : thisYear;
  const ntos = new Map((await ntosFor(ids)).map((n) => [n.projectId, n]));
  const pending = ids.length ? new Map((await q(`SELECT project_id, count(*)::int AS n, COALESCE(sum(amount),0)::float8 AS amt FROM change_orders WHERE status='Pending' AND project_id = ANY($1::uuid[]) GROUP BY project_id`, [ids])).map((r) => [r.project_id, r])) : new Map();
  const sched = ids.length ? await q(`SELECT s.project_id, s.label, s.expected_date::text AS d, s.amount::float8 AS amount FROM invoice_schedule s WHERE s.project_id = ANY($1::uuid[]) AND s.status='Tentative' AND s.expected_date IS NOT NULL AND s.expected_date <= $2::date ORDER BY s.expected_date`, [ids, shift(today, 14)]) : [];

  const rows = all.map((p) => { const m = by.get(p.id) || {}, n = ntos.get(p.id);
    return { id: p.id, name: p.name, gc: p.gc, client: p.client, address: addrLine({ street: m.address, city: m.city, state: m.state, zip: m.zip }), active: p.active, year: m.year ?? null, startDate: m.start_date ? String(m.start_date.toISOString?.().slice(0, 10) ?? m.start_date).slice(0, 10) : null, proposalId: p.proposalId ?? null, refCode: m.ref_code ?? null,
      contract: p.contract, billed: p.billed, currentlyDue: p.currentlyDue, projectedProfit: p.projectedProfit, hasContractFile: !!m.contract_document_id,
      nto: n ? { status: n.status, firstFurnished: n.firstFurnished, due: n.due, daysLeft: n.daysLeft, overdue: n.overdue, sentDate: n.sentDate } : null }; });
  const inYear = rows.filter((r) => r.year === year), active = inYear.filter((r) => r.active), inactive = inYear.filter((r) => !r.active);
  const sum = (list, k) => Math.round(list.reduce((n, r) => n + Math.round((r[k] ?? 0) * 100), 0)) / 100;
  const openNtos = rows.filter((r) => r.active && r.nto?.status === 'Needed');

  const alerts = [], link = (id, tab = '') => `#/projects/${id}${tab ? '/' + tab : ''}`;
  for (const r of rows.filter((x) => x.active)) {
    if (r.nto?.status === 'Needed' && r.nto.daysLeft != null) {
      if (r.nto.overdue) alerts.push({ severity: 'high', kind: 'nto', title: `Notice To Owner Overdue: ${r.name}`, detail: `Deadline was ${r.nto.due}.`, date: r.nto.due, link: link(r.id, 'docs'), projectId: r.id });
      else if (r.nto.daysLeft <= 10) alerts.push({ severity: 'medium', kind: 'nto', title: `Notice To Owner Due In ${r.nto.daysLeft} Day${r.nto.daysLeft === 1 ? '' : 's'}: ${r.name}`, detail: `Deadline ${r.nto.due}.`, date: r.nto.due, link: link(r.id, 'docs'), projectId: r.id });
    }
    if (r.currentlyDue > 0) alerts.push({ severity: 'info', kind: 'billing', title: `Client Owes Us: ${r.name}`, detail: `${money(r.currentlyDue)} is billed and not yet paid.`, link: link(r.id, 'billing'), projectId: r.id });
    const pc = pending.get(r.id); if (pc) alerts.push({ severity: 'info', kind: 'co', title: `Pending Change Orders: ${r.name}`, detail: `${pc.n} waiting for approval (${money(pc.amt)}).`, link: link(r.id, 'cos'), projectId: r.id });
    if (!r.hasContractFile) alerts.push({ severity: 'info', kind: 'contract', title: `No Contract File: ${r.name}`, detail: 'Add the signed contract on the Contract tab.', link: link(r.id, 'contract'), projectId: r.id });
    if (r.startDate && r.startDate >= today && r.startDate <= shift(today, 14)) alerts.push({ severity: 'info', kind: 'start', title: `Starts ${r.startDate}: ${r.name}`, detail: 'Starting within two weeks.', date: r.startDate, link: link(r.id), projectId: r.id });
  }
  for (const s of sched) { const r = rows.find((x) => x.id === s.project_id); if (!r || !r.active) continue; const late = s.d < today;
    alerts.push({ severity: late ? 'medium' : 'info', kind: 'schedule', title: `${late ? 'Invoice Past Its Expected Date' : 'Invoice Expected Soon'}: ${r.name}`, detail: `${s.label}${s.amount != null ? ' · ' + money(s.amount) : ''} · expected ${s.d}`, date: s.d, link: link(r.id, 'contract'), projectId: r.id }); }
  alerts.sort((a, b) => sev[a.severity] - sev[b.severity] || String(a.date || '9').localeCompare(String(b.date || '9')));
  return { year, years,
    summary: { active: active.length, inactive: inactive.length, contractActive: sum(active, 'contract'), billedActive: sum(active, 'billed'), dueNowActive: sum(active, 'currentlyDue'), profitActive: sum(active, 'projectedProfit'),
      ntoNeeded: openNtos.length, ntoOverdue: openNtos.filter((r) => r.nto.overdue).length, ntoSent: rows.filter((r) => r.year === year && r.nto?.status === 'Sent').length },
    alerts: alerts.slice(0, 40), alertCount: alerts.length, rows: rows.filter((r) => r.active || r.year === year) };
}
