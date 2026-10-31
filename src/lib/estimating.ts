// Estimating rules carried over from the v43 system, as pure functions.
export const todayEastern = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
const day = (s: string) => new Date(s + 'T12:00:00Z');
const iso = (d: Date) => d.toISOString().slice(0, 10);
export const shift = (s: string, n: number) => { const d = day(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
export const weekOf = (s: string) => (s ? shift(s, -((day(s).getUTCDay() + 6) % 7)) : '');
export const isWeekend = (s: string) => [0, 6].includes(day(s).getUTCDay());
export function businessDays(from: string, to: string): number {
  let n = 0; const dir = from <= to ? 1 : -1;
  for (let d = from; d !== to; ) { d = shift(d, dir); if (!isWeekend(d)) n += dir; }
  return n;
}
export function addBusinessDays(s: string, n: number): string { let d = s; while (n > 0) { d = shift(d, 1); if (!isWeekend(d)) n--; } return d; }
export function countdown(due: string | null, submitted: boolean, today = todayEastern()): string {
  if (submitted) return 'Submitted'; if (!due) return 'Due Date Needed';
  const n = businessDays(today, due);
  return due < today ? `Overdue · ${Math.abs(n)} Business Days` : due === today ? 'Due Today' : `${n} Business Days Left`;
}
// Leads two or more days past their bid date drop out of the inbox.
export const expiredLead = (due: string | null, today = todayEastern()) => !!due && due <= shift(today, -2);
// Inbox grouping: forward weeks start next Monday; a Monday deadline closes the prior week.
export function groupFor(due: string | null, today = todayEastern()): string {
  if (!due) return 'No Bid Due Date Provided';
  if (due < today) return 'Missed / Past Due';
  const wd = day(today).getUTCDay(), next = shift(today, wd === 1 ? 7 : (8 - wd) % 7);
  if (due < next) return 'Due This Week — Too Tight To Bid';
  const monday = shift(due, -((day(due).getUTCDay() + 6) % 7));
  return 'Week Of ' + (due === monday && due !== next ? shift(monday, -7) : monday);
}
// P + MMDD + running number for that day, e.g. P10281, P10282
export function nextProposalId(existing: (string | null)[], date = todayEastern()): string {
  const prefix = 'P' + date.slice(5, 7) + date.slice(8, 10);
  const used = existing.filter((v): v is string => !!v && v.startsWith(prefix)).map((v) => Number(v.slice(prefix.length))).filter(Number.isInteger);
  return prefix + (Math.max(0, ...used) + 1);
}
export const FOLDERS = ['01. DL', '02. Proposal', '03. Change Orders', '04. Documents', '05. Material & Equipment Specs', '06. Billing'];
export const cleanName = (v: string) => { const s = String(v || '').normalize('NFKC').replace(/[\x00-\x1f<>:"/\\|?*]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '').slice(0, 90); return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s) ? '_' + s : s; };
export function folderPlan(o: { proposalId?: string | null; name: string; city?: string | null; gc: string; year: number }) {
  const project = [o.proposalId, o.name, o.city].filter(Boolean).map((x) => cleanName(x as string)).join('_');
  return { root: ['ByOther', o.year, cleanName(o.gc), project].join('/'), folders: FOLDERS };
}

// Follow-up after a proposal is sent: first email, then a call or message, then a final email. Any reply marks the lead interested.
export type Comm = { kind: string; date: string; cycle?: string | null };
export function followupPlan(sub: { id: string; date: string } | null, comms: Comm[], opts: { paused?: boolean; result?: string } = {}) {
  if (!sub) return { stage: 'Awaiting Submission', due: null as string | null };
  if (opts.paused || ['Awarded', 'Lost'].includes(opts.result || '')) return { stage: 'Paused', due: null };
  const log = comms.filter((c) => !c.cycle || c.cycle === sub.id);
  if (log.some((c) => c.kind === 'Reply Received')) return { stage: 'Interested', due: null };
  const first = log.find((c) => c.kind === 'First Email Sent');
  if (!first) return { stage: 'First Email', due: addBusinessDays(sub.date, 2) };
  const call = log.find((c) => c.kind === 'Call / Message' && c.date >= first.date);
  if (!call) return { stage: 'Call / Message', due: addBusinessDays(first.date, 3) };
  if (!log.some((c) => c.kind === 'Final Email Sent')) return { stage: 'Final Email', due: addBusinessDays(call.date, 5) };
  return { stage: 'Sequence Complete', due: null };
}

// ---- lead import (BuildingConnected exports, pasted or uploaded as CSV)
export function parseCsv(textIn: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], cell = '', q = false;
  const s = textIn.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some((x) => x.trim() !== '')) rows.push(row); row = []; }
    else cell += c;
  }
  row.push(cell); if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}
const HEADERS: Record<string, string[]> = {
  name: ['project', 'project name', 'opportunity', 'name', 'bid name'], gc: ['gc', 'company', 'general contractor', 'client', 'contractor', 'invited by'],
  city: ['city'], state: ['state'], address: ['address', 'project address', 'location'], due: ['bid due', 'due', 'due date', 'bid date', 'bids due', 'deadline'],
  contact: ['contact', 'contact name', 'bid contact', 'estimator'], email: ['email', 'contact email'], phone: ['phone', 'contact phone'], link: ['link', 'url', 'invitation', 'invitation link', 'bid link'], type: ['type', 'project type', 'category'], tier: ['tier', 'region'],
};
export function normalizeDate(v: string): string | null {
  const s = String(v || '').trim(); if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return ok(m[1], m[2], m[3]);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/); if (m) return ok(m[3].length === 2 ? '20' + m[3] : m[3], m[1].padStart(2, '0'), m[2].padStart(2, '0'));
  const d = new Date(s); return Number.isNaN(d.getTime()) ? null : iso(d);
  function ok(y: string, mo: string, da: string) { const x = `${y}-${mo}-${da}`; return Number.isNaN(day(x).getTime()) || iso(day(x)) !== x ? null : x; }
}
export function mapLeadRows(table: string[][]) {
  if (table.length < 2) return { rows: [] as Record<string, string>[], missing: ['a header row and at least one lead'] };
  const head = table[0].map((h) => h.trim().toLowerCase()); const idx: Record<string, number> = {};
  for (const [k, names] of Object.entries(HEADERS)) { const i = head.findIndex((h) => names.includes(h)); if (i >= 0) idx[k] = i; }
  const missing = ['name', 'gc'].filter((k) => idx[k] === undefined);
  const rows = table.slice(1).map((r) => Object.fromEntries(Object.entries(idx).map(([k, i]) => [k, (r[i] ?? '').trim()])));
  return { rows, missing };
}
export const leadKey = (gc: string, name: string, due: string | null) => [gc, name, due ?? ''].map((x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, '')).join('|');
