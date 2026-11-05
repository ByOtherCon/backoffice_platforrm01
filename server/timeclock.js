import crypto from 'node:crypto';
import { q, tx } from './db.js';
import { bad, money, text, dateStr, HttpError } from './http.js';
import { hashPassword, verifyPassword } from './auth.js';
import { allocateLabor, weekPay, weekStart } from '../src/lib/payroll.ts';
import { todayEastern, shift } from '../src/lib/estimating.ts';
import { notifyRoles } from './compliance.js';
import { MANAGE } from './auth.js';

export const DEFAULTS = { otEnabled: true, otAfter: 40, otMult: 1.5, dailyFullDayHours: 6, lunchMinutes: 0, lunchAfterHours: 6, dayStart: '07:00', lateGraceMinutes: 5, roundMinutes: 0, geofenceMiles: 3 };
export async function getSettings() {
  const [r] = await q(`SELECT value FROM app_settings WHERE key='timeclock'`);
  return { ...DEFAULTS, ...(r?.value ?? {}) };
}
export async function saveSettings(b) {
  const cur = await getSettings(), n = { ...cur };
  const num = (k, lo, hi) => { if (b[k] !== undefined) { const v = Number(b[k]); if (!Number.isFinite(v) || v < lo || v > hi) throw bad(`${k} must be between ${lo} and ${hi}.`); n[k] = v; } };
  num('otAfter', 0, 168); num('otMult', 1, 3); num('dailyFullDayHours', 1, 24); num('lunchMinutes', 0, 180); num('lunchAfterHours', 0, 24); num('lateGraceMinutes', 0, 120); num('roundMinutes', 0, 60); num('geofenceMiles', 0.05, 100);
  if (b.otEnabled !== undefined) n.otEnabled = !!b.otEnabled;
  if (b.dayStart !== undefined) { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(b.dayStart)) throw bad('Day start must look like 07:00.'); n.dayStart = b.dayStart; }
  await q(`INSERT INTO app_settings(key,value) VALUES ('timeclock',$1) ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=now()`, [n]);
  return n;
}
const payCfg = (s) => ({ otEnabled: s.otEnabled, otAfter: s.otAfter, otMult: s.otMult, dailyFullDayHours: s.dailyFullDayHours });
const easternDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
const easternHM = (d) => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' }).formatToParts(d).map((x) => [x.type, x.value])); return (Number(p.hour) % 24) * 60 + Number(p.minute); };
const r2 = (n) => Math.round(n * 100) / 100;
// A wall-clock time on a date in Eastern time ("2026-11-04", "17:30") as a real moment.
export function easternToDate(dateStr, hm) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr)), t = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(hm)); if (!m || !t) return null;
  for (const off of [4, 5]) { const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(t[1]) + off, Number(t[2]))); if (easternDate(d) === dateStr && easternHM(d) === Number(t[1]) * 60 + Number(t[2])) return d; }
  return null;
}
const roundHours = (h, minutes) => (minutes ? r2(Math.round(h / (minutes / 60)) * (minutes / 60)) : r2(h));
const miles = (a, b, c, d) => { const R = 3958.8, rad = (x) => (x * Math.PI) / 180, dl = rad(c - a), dg = rad(d - b); const x = Math.sin(dl / 2) ** 2 + Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(dg / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };

// ------------------------------------------------------------------ PIN sign-in
export const roster = () => q('SELECT id, name FROM employees WHERE active AND pin_hash IS NOT NULL ORDER BY name');
export async function setPin(employeeId, pin) {
  if (!/^\d{4,8}$/.test(String(pin || ''))) throw bad('A PIN is 4 to 8 digits.');
  const r = await q('UPDATE employees SET pin_hash=$2, pin_default=false, pin_failed=0, pin_locked_until=NULL WHERE id=$1 RETURNING id', [employeeId, await hashPassword(String(pin))]);
  if (!r.length) throw new HttpError(404, 'Employee not found.');
}
// Until the office sets one, a PIN is the last 4 digits of the employee's phone number, or 0000 when there is no number.
export const defaultPin = (phone) => { const d = String(phone || '').replace(/\D/g, ''); return d.length >= 4 ? d.slice(-4) : '0000'; };
export async function applyDefaultPin(employeeId, { force = false } = {}) {
  const [e] = await q('SELECT id, phone, pin_hash, pin_default FROM employees WHERE id=$1', [employeeId]); if (!e) throw new HttpError(404, 'Employee not found.');
  if (!force && e.pin_hash && !e.pin_default) return false;   // someone chose a PIN: never replaced by the automatic one
  await q('UPDATE employees SET pin_hash=$2, pin_default=true, pin_failed=0, pin_locked_until=NULL WHERE id=$1', [e.id, await hashPassword(defaultPin(e.phone))]); return true;
}
export async function ensureDefaultPins() { let n = 0; for (const e of await q('SELECT id FROM employees WHERE pin_hash IS NULL')) if (await applyDefaultPin(e.id)) n++; return n; }
export async function clockLogin(employeeId, pin) {
  const [e] = /^[0-9a-f-]{36}$/i.test(String(employeeId)) ? await q('SELECT * FROM employees WHERE id=$1 AND active', [employeeId]) : [];
  if (!e || !e.pin_hash) throw new HttpError(401, 'That name or PIN is not right.');
  if (e.pin_locked_until && new Date(e.pin_locked_until) > new Date()) throw new HttpError(429, 'Too many wrong PINs. Ask the office to reset it, or try again in 15 minutes.');
  if (!(await verifyPassword(String(pin || ''), e.pin_hash))) {
    const failed = e.pin_failed + 1;
    await q(`UPDATE employees SET pin_failed=$2, pin_locked_until=CASE WHEN $2>=5 THEN now()+interval '15 minutes' ELSE NULL END WHERE id=$1`, [e.id, failed >= 5 ? 5 : failed]);
    throw new HttpError(401, 'That name or PIN is not right.');
  }
  await q('UPDATE employees SET pin_failed=0, pin_locked_until=NULL WHERE id=$1', [e.id]);
  const token = crypto.randomBytes(32).toString('base64url');
  await q(`INSERT INTO sessions(token_hash,employee_id,expires_at) VALUES ($1,$2, now() + interval '14 hours')`, [crypto.createHash('sha256').update(token).digest('hex'), e.id]);
  return { token, employee: { id: e.id, name: e.name } };
}

// ------------------------------------------------------------------ labor posting
// Whenever time entries change, rebuild that employee's labor rows for the week so cost always follows the clock.
// A day at an "Other" jobsite counts toward the week's pay (and overtime) but has no project, so its labor row carries the site name only.
export async function rebuildLabor(t, employeeId, anyDate) {
  const ws = weekStart(anyDate), we = new Date(ws + 'T00:00:00Z'); we.setUTCDate(we.getUTCDate() + 6);
  const wsEnd = we.toISOString().slice(0, 10);
  const [emp] = await t('SELECT pay_type, hourly_rate FROM employees WHERE id=$1', [employeeId]);
  const entries = await t(`SELECT te.id, te.work_date, te.project_id, te.other_name, te.total_hours FROM time_entries te WHERE te.employee_id=$1 AND te.status='complete' AND te.work_date BETWEEN $2 AND $3`, [employeeId, ws, wsEnd]);
  const lines = entries.length ? await t('SELECT l.entry_id, l.project_trade_id, COALESCE(l.trade_id, (SELECT pt.trade_id FROM project_trades pt WHERE pt.id=l.project_trade_id)) AS trade_id, l.hours FROM time_entry_lines l WHERE l.entry_id = ANY($1::uuid[]) ORDER BY l.seq', [entries.map((e) => e.id)]) : [];
  const settings = await getSettings(), other = new Map(entries.map((e) => [e.id, e.other_name]));
  const clock = entries.map((e) => ({ id: e.id, employeeId, date: e.work_date, projectId: e.project_id, totalHours: Number(e.total_hours), status: 'complete',
    lines: lines.filter((l) => l.entry_id === e.id).map((l) => ({ trade: l.project_trade_id ?? (l.trade_id ? 'g:' + l.trade_id : ''), hours: Number(l.hours) })) }));
  const rows = allocateLabor(clock, { [employeeId]: { payType: emp.pay_type, rate: Number(emp.hourly_rate) } }, payCfg(settings));
  await t(`DELETE FROM labor_entries WHERE employee_id=$1 AND source='Time clock' AND work_date BETWEEN $2 AND $3`, [employeeId, ws, wsEnd]);
  const tradeOf = new Map((await t('SELECT id, trade_id FROM project_trades WHERE id = ANY($1::uuid[])', [[...new Set(rows.map((r) => r.trade).filter((x) => x && !x.startsWith('g:')))]])).map((x) => [x.id, x.trade_id]));
  for (const r of rows) { const g = r.trade.startsWith('g:'), ptId = r.trade && !g ? r.trade : null;
    await t(`INSERT INTO labor_entries(project_id,project_trade_id,trade_id,other_name,employee_id,work_date,hours,rate,pay,source,import_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Time clock',$10)`,
      [r.projectId || null, ptId, g ? r.trade.slice(2) : ptId ? tradeOf.get(ptId) ?? null : null, r.projectId ? null : other.get(r.entryId) ?? null, employeeId, r.date, r.hours, Number(emp.hourly_rate), r.pay, r.importKey]); }
}

// ------------------------------------------------------------------ employee clock
const SITE = `COALESCE(p.name, 'Other: ' || te.other_name)`;
const hmStr = (d) => (d ? new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }).format(new Date(d)) : null);
const editableFrom = () => shift(todayEastern(), -1);   // an employee can change today and yesterday; older days go to the office
const tradeNames = async (t, ids) => new Map((ids.length ? await t('SELECT id, name FROM trades WHERE id = ANY($1::uuid[])', [ids]) : []).map((x) => [x.id, x.name]));
export async function clockHome(employeeId) {
  const [emp] = await q('SELECT id, name, pay_type, hourly_rate FROM employees WHERE id=$1', [employeeId]);
  const [open] = await q(`SELECT te.*, ${SITE} AS project, t.name AS trade FROM time_entries te LEFT JOIN projects p ON p.id=te.project_id LEFT JOIN project_trades pt ON pt.id=te.primary_trade_id LEFT JOIN trades t ON t.id=pt.trade_id WHERE te.employee_id=$1 AND te.status='open'`, [employeeId]);
  const projects = await q(`SELECT p.id, p.name, p.address, p.city, p.state, p.zip, p.geofence_required FROM projects p WHERE p.active ORDER BY p.name`);
  const trades = projects.length ? await q(`SELECT pt.id, pt.project_id, t.name FROM project_trades pt JOIN trades t ON t.id=pt.trade_id WHERE pt.project_id = ANY($1::uuid[]) ORDER BY t.sort, t.name`, [projects.map((p) => p.id)]) : [];
  const allTrades = await q('SELECT id, name FROM trades WHERE NOT archived ORDER BY sort, name');
  const today = todayEastern(), ws = weekStart(today), from = shift(ws, -14);
  const rows = await q(`SELECT te.id, te.work_date, te.total_hours, te.status, te.method, te.injured, te.notes, te.project_id, te.other_name, te.other_address, te.clock_in, te.clock_out, ${SITE} AS project FROM time_entries te LEFT JOIN projects p ON p.id=te.project_id WHERE te.employee_id=$1 AND te.work_date >= $2 ORDER BY te.work_date DESC, te.clock_in DESC`, [employeeId, from]);
  const lines = rows.length ? await q(`SELECT l.entry_id, l.project_trade_id, l.trade_id, l.hours, COALESCE(t.name, t2.name) AS trade FROM time_entry_lines l LEFT JOIN project_trades pt ON pt.id=l.project_trade_id LEFT JOIN trades t ON t.id=pt.trade_id LEFT JOIN trades t2 ON t2.id=l.trade_id WHERE l.entry_id = ANY($1::uuid[]) ORDER BY l.seq`, [rows.map((r) => r.id)]) : [];
  const asks = rows.length ? await q(`SELECT entry_id, status FROM time_corrections WHERE entry_id = ANY($1::uuid[]) ORDER BY created_at`, [rows.map((r) => r.id)]) : [];
  const s = await getSettings(), cfg = payCfg(s), person = { payType: emp.pay_type, rate: Number(emp.hourly_rate) }, edFrom = editableFrom();
  // three Monday-to-Sunday weeks: this one and the two before it. Each person sees only their own hours and pay.
  const weeks = [0, 1, 2].map((k) => {
    const start = shift(ws, -7 * k), end = shift(start, 6), mine = rows.filter((r) => r.work_date >= start && r.work_date <= end);
    const wp = weekPay(person, cfg, mine.filter((r) => r.status === 'complete').map((r) => ({ date: r.work_date, totalHours: Number(r.total_hours) })));
    return { start, end, hours: r2(wp.total), regular: r2(wp.reg), overtime: r2(wp.ot), pay: person.rate ? r2(wp.pay) : null,
      entries: mine.map((r) => ({ id: r.id, date: r.work_date, site: r.project, other: !r.project_id, status: r.status, method: r.method, hours: Number(r.total_hours), injured: r.injured, notes: r.notes, inTime: r.method === 'Clock' ? hmStr(r.clock_in) : null, outTime: r.method === 'Clock' ? hmStr(r.clock_out) : null, otherAddress: r.other_address, editable: r.status === 'complete' && r.work_date >= edFrom,
        request: asks.filter((a) => a.entry_id === r.id).at(-1)?.status ?? null, lines: lines.filter((l) => l.entry_id === r.id).map((l) => ({ projectTradeId: l.project_trade_id, tradeId: l.trade_id, trade: l.trade, hours: Number(l.hours) })) })) };
  });
  const wp = weeks[0];
  return {
    employee: { id: emp.id, name: emp.name }, today,
    open: open ? { id: open.id, project: open.project, trade: open.trade, projectId: open.project_id, other: !open.project_id, since: open.clock_in, workDate: open.work_date, stale: open.work_date < today, primaryTradeId: open.primary_trade_id } : null,
    projects: projects.map((p) => ({ id: p.id, name: p.name, address: [p.address, p.city, [p.state, p.zip].filter(Boolean).join(' ')].filter(Boolean).join(', '), trades: trades.filter((t) => t.project_id === p.id).map((t) => ({ id: t.id, name: t.name })) })),
    allTrades: allTrades.map((t) => ({ id: t.id, name: t.name })), weeks,
    week: rows.filter((r) => r.work_date >= ws).map((w) => ({ id: w.id, date: w.work_date, hours: Number(w.total_hours), status: w.status, project: w.project })),
    weekTotals: { hours: wp.hours, regular: wp.regular, overtime: wp.overtime, pay: wp.pay },
    settings: { lunchMinutes: s.lunchMinutes, lunchAfterHours: s.lunchAfterHours },
  };
}
const siteFrom = (b) => {   // a project, or a one-off "Other" jobsite with a name and where it is
  if (b.other) { const name = text(b.other.name, 'Jobsite name', { max: 120 }), address = text(b.other.address, 'Jobsite location', { max: 300 }); if (name.length < 2) throw bad('Enter the jobsite name.'); if (address.length < 5) throw bad('Enter where the jobsite is (street and city).'); return { other: { name, address } }; }
  return { projectId: b.projectId };
};
const mustFinishOldDay = async (t, employeeId) => { const [o] = await t(`SELECT work_date FROM time_entries WHERE employee_id=$1 AND status='open' AND work_date < $2`, [employeeId, todayEastern()]); if (o) throw new HttpError(409, `You did not clock out on ${o.work_date}. Finish that day first (enter the time you stopped and your trades), then you can continue.`); };
export async function clockIn(employeeId, b) {
  const s = await getSettings(); const now = new Date(); const site = siteFrom(b);
  return tx(async (t) => {
    await mustFinishOldDay(t, employeeId);
    let p = null;
    if (!site.other) {
      [p] = await t('SELECT * FROM projects WHERE id=$1 AND active', [site.projectId]);
      if (!p) throw bad('Choose an active project, or Other.');
      if (b.projectTradeId && !(await t('SELECT 1 FROM project_trades WHERE id=$1 AND project_id=$2', [b.projectTradeId, p.id])).length) throw bad('That trade is not on this project.');
      if (p.geofence_required && p.lat != null) {
        const g = b.gps; if (!g || !Number.isFinite(g.lat) || !Number.isFinite(g.lng)) throw new HttpError(403, 'This jobsite requires your location. Allow location access and try again.');
        const d = miles(Number(p.lat), Number(p.lng), g.lat, g.lng);
        if (d > Number(p.geofence_miles)) throw new HttpError(403, `You are ${d.toFixed(1)} miles from this jobsite. Clock in on site.`);
      }
    }
    const [dup] = await t(`SELECT 1 FROM time_entries WHERE employee_id=$1 AND status='open'`, [employeeId]);
    if (dup) throw new HttpError(409, 'You are already clocked in. Clock out first.');
    const [h, m] = s.dayStart.split(':').map(Number); const late = easternHM(now) > h * 60 + m + s.lateGraceMinutes;
    const gps = b.gps && Number.isFinite(b.gps.lat) && Number.isFinite(b.gps.lng) ? { lat: b.gps.lat, lng: b.gps.lng, accuracy: Number(b.gps.accuracy) || null } : null;
    const [e] = await t(`INSERT INTO time_entries(employee_id,project_id,other_name,other_address,primary_trade_id,work_date,clock_in,late_in,gps_in) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [employeeId, p?.id ?? null, site.other?.name ?? null, site.other?.address ?? null, b.projectTradeId || null, easternDate(now), now, late, gps]);
    return { id: e.id };
  });
}
// Trade hours for a day, chosen at day's end. A project's lines are that project's trades; an "Other" site's lines are from the trade list.
// `need`: an employee must name at least one trade (the office may leave a day project-level).
async function normalizeLines(t, projectId, lines, total, fallbackTrade, { need = false } = {}) {
  let ls = Array.isArray(lines) && lines.length ? lines : fallbackTrade ? [{ projectTradeId: fallbackTrade, hours: total }] : need ? null : [{ projectTradeId: null, hours: total }];
  if (!ls) throw bad('Choose the trade or trades you worked today and the hours for each.');
  const rest = ls.filter((l) => l.hours === 'rest'); if (rest.length > 1) throw bad('Only one trade can take the rest of the day.');
  if (rest.length) { const others = r2(ls.filter((l) => l.hours !== 'rest').reduce((n, l) => n + money(l.hours, 'Hours'), 0)), left = r2(total - others); if (left <= 0) throw bad('Those trade hours add up to more than the day. Lower them.'); rest[0].hours = left; }   // the last trade takes whatever is left of the day
  ls = ls.map((l) => ({ projectTradeId: l.projectTradeId || null, tradeId: l.tradeId || null, hours: money(l.hours, 'Hours') })).filter((l) => l.hours > 0);
  if (!ls.length) throw bad('Add the hours for each trade.');
  for (const l of ls) {
    if (projectId) { if (l.projectTradeId && !(await t('SELECT 1 FROM project_trades WHERE id=$1 AND project_id=$2', [l.projectTradeId, projectId])).length) throw bad('A trade is not on this project.'); l.tradeId = null; }
    else { l.projectTradeId = null; if (need && !l.tradeId) throw bad('Choose a trade for each line.'); if (l.tradeId && !(await t('SELECT 1 FROM trades WHERE id=$1 AND NOT archived', [l.tradeId])).length) throw bad('Choose a trade from the list.'); }
    if (need && projectId && !l.projectTradeId) throw bad('Choose a trade for each line.');
  }
  const sum = r2(ls.reduce((n, l) => n + l.hours, 0));
  if (Math.abs(sum - total) > 0.01) throw bad(`Trade hours add up to ${sum.toFixed(2)} but the day totals ${total.toFixed(2)}. Assign every hour to a trade.`);
  return ls;
}
const insertLines = async (t, entryId, lines) => { for (const l of lines) await t('INSERT INTO time_entry_lines(entry_id,project_trade_id,trade_id,hours) VALUES ($1,$2,COALESCE($3, (SELECT trade_id FROM project_trades WHERE id=$2)),$4)', [entryId, l.projectTradeId, l.tradeId, l.hours]); };
export async function clockOut(employeeId, b) {
  const s = await getSettings(); let now = new Date();
  return tx(async (t) => {
    const [e] = await t(`SELECT * FROM time_entries WHERE employee_id=$1 AND status='open' FOR UPDATE`, [employeeId]);
    if (!e) throw new HttpError(409, 'You are not clocked in.');
    if (e.work_date < todayEastern()) {   // a day that was never closed: the employee says when they stopped
      if (!b.outTime) throw bad(`You did not clock out on ${e.work_date}. Enter the time you stopped.`);
      const at = easternToDate(e.work_date, b.outTime); if (!at) throw bad('Enter the time you stopped, like 4:30 PM.');
      if (at <= new Date(e.clock_in)) throw bad('The time you stopped must be after you clocked in.'); now = at;
    }
    const gross = roundHours((now - new Date(e.clock_in)) / 3600000, s.roundMinutes);
    const lunch = s.lunchMinutes && gross >= s.lunchAfterHours ? s.lunchMinutes / 60 : 0;
    const total = r2(Math.max(0, gross - lunch));
    if (total <= 0) throw bad('That shift is under a minute. Ask the office to remove it.');
    if (total > 24) throw bad('That shift is over 24 hours. Ask the office to correct it.');
    const lines = await normalizeLines(t, e.project_id, b.lines, total, e.primary_trade_id, { need: true });
    const gps = b.gps && Number.isFinite(b.gps.lat) && Number.isFinite(b.gps.lng) ? { lat: b.gps.lat, lng: b.gps.lng, accuracy: Number(b.gps.accuracy) || null } : null;
    await t(`UPDATE time_entries SET clock_out=$2, gross_hours=$3, lunch_hours=$4, total_hours=$5, injured=$6, injury_note=$7, notes=$8, gps_out=$9, status='complete' WHERE id=$1`,
      [e.id, now, gross, lunch, total, !!b.injured, b.injured ? text(b.injuryNote, 'Injury note', { max: 1000, required: false }) || null : null, text(b.notes, 'Notes', { max: 1000, required: false }) || null, gps]);
    await insertLines(t, e.id, lines);
    await rebuildLabor(t, employeeId, e.work_date);
    return { totalHours: total };
  });
}
// A day entered after the fact. An employee adds their own (never a future day, never while an old day is still open); the office can add one for anyone.
export async function manualEntry(employeeId, b, { office = false, userId = null } = {}) {
  const date = dateStr(b.date, 'Date', true); if (date > easternDate(new Date())) throw bad('The date cannot be in the future.');
  const hours = money(b.hours, 'Hours'); if (!(hours > 0 && hours <= 16)) throw bad('Hours must be between 0 and 16.');
  const site = siteFrom(b);
  return tx(async (t) => {
    if (!office) await mustFinishOldDay(t, employeeId);
    if (!(await t('SELECT 1 FROM employees WHERE id=$1 AND active', [employeeId])).length) throw bad('Employee not found.');
    let pid = null; if (!site.other) { const [p] = await t('SELECT id FROM projects WHERE id=$1 AND active', [site.projectId]); if (!p) throw bad('Choose an active project, or Other.'); pid = p.id; }
    const lines = await normalizeLines(t, pid, b.lines, hours, b.projectTradeId, { need: !office });
    const [e] = await t(`INSERT INTO time_entries(employee_id,project_id,other_name,other_address,primary_trade_id,work_date,clock_in,clock_out,gross_hours,total_hours,status,method,notes,injured,injury_note,modified_by,modified_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$8,'complete','Manual',$9,$10,$11,$12,$13) RETURNING id`,
      [employeeId, pid, site.other?.name ?? null, site.other?.address ?? null, b.projectTradeId || null, date, new Date(date + 'T12:00:00Z'), hours, text(b.notes, 'Notes', { max: 1000, required: false }) || null, !!b.injured, b.injured ? text(b.injuryNote, 'Injury note', { max: 1000, required: false }) || null : null, office ? userId : null, office ? new Date() : null]);
    await insertLines(t, e.id, lines);
    await rebuildLabor(t, employeeId, date); return { id: e.id };
  });
}

// ------------------------------------------------------------------ office view and corrections
export const activeNow = () => q(`SELECT te.id, te.clock_in, te.late_in, te.work_date, e.name AS employee, ${SITE} AS project, p.id AS project_id, t.name AS trade
  FROM time_entries te JOIN employees e ON e.id=te.employee_id LEFT JOIN projects p ON p.id=te.project_id LEFT JOIN project_trades pt ON pt.id=te.primary_trade_id LEFT JOIN trades t ON t.id=pt.trade_id WHERE te.status='open' ORDER BY te.clock_in`);
export async function listEntries({ from, to, employeeId, projectId, other } = {}) {
  const w = [], v = [];
  if (from) { v.push(dateStr(from, 'From')); w.push(`te.work_date >= $${v.length}`); }
  if (to) { v.push(dateStr(to, 'To')); w.push(`te.work_date <= $${v.length}`); }
  if (employeeId) { v.push(employeeId); w.push(`te.employee_id = $${v.length}`); }
  if (projectId) { v.push(projectId); w.push(`te.project_id = $${v.length}`); }
  if (other) w.push('te.project_id IS NULL');
  const rows = await q(`SELECT te.*, e.name AS employee, ${SITE} AS project FROM time_entries te JOIN employees e ON e.id=te.employee_id LEFT JOIN projects p ON p.id=te.project_id ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY te.work_date DESC, te.clock_in DESC LIMIT 2000`, v);
  const lines = rows.length ? await q(`SELECT l.entry_id, l.project_trade_id, l.trade_id, l.hours, COALESCE(t.name, t2.name) AS trade FROM time_entry_lines l LEFT JOIN project_trades pt ON pt.id=l.project_trade_id LEFT JOIN trades t ON t.id=pt.trade_id LEFT JOIN trades t2 ON t2.id=l.trade_id WHERE l.entry_id = ANY($1::uuid[]) ORDER BY l.seq`, [rows.map((r) => r.id)]) : [];
  return rows.map((r) => ({ id: r.id, employeeId: r.employee_id, employee: r.employee, projectId: r.project_id, project: r.project, other: !r.project_id, otherAddress: r.other_address, date: r.work_date, clockIn: r.clock_in, clockOut: r.clock_out, grossHours: Number(r.gross_hours), lunchHours: Number(r.lunch_hours), totalHours: Number(r.total_hours),
    status: r.status, method: r.method, lateIn: r.late_in, injured: r.injured, injuryNote: r.injury_note, notes: r.notes, modified: !!r.modified_at,
    lines: lines.filter((l) => l.entry_id === r.id).map((l) => ({ projectTradeId: l.project_trade_id, tradeId: l.trade_id, trade: l.trade, hours: Number(l.hours) })) }));
}
export async function editEntry(id, b, userId) {
  return tx(async (t) => {
    const [e] = await t('SELECT * FROM time_entries WHERE id=$1 FOR UPDATE', [id]); if (!e) throw new HttpError(404, 'Entry not found.');
    const s = await getSettings();
    const projectId = b.projectId !== undefined ? b.projectId || null : e.project_id;
    if (b.projectId && !(await t('SELECT 1 FROM projects WHERE id=$1', [b.projectId])).length) throw bad('Project not found.');
    if (!projectId && !e.other_name) throw bad('Choose the project.');
    let cin = b.clockIn ? new Date(b.clockIn) : new Date(e.clock_in), cout = b.clockOut ? new Date(b.clockOut) : e.clock_out ? new Date(e.clock_out) : null;
    if (Number.isNaN(cin.getTime()) || (cout && Number.isNaN(cout.getTime()))) throw bad('Enter valid times.');
    let gross = Number(e.gross_hours), lunch = b.lunchHours !== undefined ? money(b.lunchHours, 'Lunch hours') : Number(e.lunch_hours), total = Number(e.total_hours);
    if (e.method === 'Manual' && b.totalHours !== undefined) { total = money(b.totalHours, 'Hours'); gross = total + lunch; }
    else if (cout) { if (cout <= cin) throw bad('Clock-out must be after clock-in.'); gross = roundHours((cout - cin) / 3600000, s.roundMinutes); total = r2(Math.max(0, gross - lunch)); }
    if (e.status === 'complete' && !(total > 0 && total <= 24)) throw bad('Total hours must be between 0 and 24.');
    const workDate = e.method === 'Manual' ? (b.date ? dateStr(b.date, 'Date', true) : e.work_date) : easternDate(cin);
    await t(`UPDATE time_entries SET project_id=$2, clock_in=$3, clock_out=$4, gross_hours=$5, lunch_hours=$6, total_hours=$7, work_date=$8, notes=$9, injured=$10, injury_note=$11, modified_by=$12, modified_at=now() WHERE id=$1`,
      [id, projectId, cin, cout, gross, lunch, total, workDate, b.notes !== undefined ? text(b.notes, 'Notes', { max: 1000, required: false }) || null : e.notes, b.injured !== undefined ? !!b.injured : e.injured, b.injuryNote !== undefined ? text(b.injuryNote, 'Injury note', { max: 1000, required: false }) || null : e.injury_note, userId || null]);
    if (e.status === 'complete') {
      const keep = (await t('SELECT project_trade_id AS "projectTradeId", trade_id AS "tradeId", hours FROM time_entry_lines WHERE entry_id=$1 ORDER BY seq', [id])).map((l) => ({ projectTradeId: l.projectTradeId, tradeId: l.tradeId, hours: Number(l.hours) }));
      const lines = await normalizeLines(t, projectId, b.lines && b.lines.length ? b.lines : keep, total, null, { need: false });   // kept lines must still add up to the day (a changed total means the trades are entered again)
      await t('DELETE FROM time_entry_lines WHERE entry_id=$1', [id]); await insertLines(t, id, lines);
    }
    await rebuildLabor(t, e.employee_id, e.work_date); if (workDate !== e.work_date) await rebuildLabor(t, e.employee_id, workDate);
  });
}
export async function deleteEntry(id) {
  return tx(async (t) => {
    const [e] = await t('DELETE FROM time_entries WHERE id=$1 RETURNING employee_id, work_date', [id]); if (!e) throw new HttpError(404, 'Entry not found.');
    await rebuildLabor(t, e.employee_id, e.work_date);
  });
}
// Recalculate every labor row from the clock (use after changing an employee's rate or overtime rules).
export async function recalcAll() {
  return tx(async (t) => {
    const rows = await t(`SELECT DISTINCT employee_id, work_date FROM time_entries WHERE status='complete'`);
    const seen = new Set();
    for (const r of rows) { const k = r.employee_id + weekStart(r.work_date); if (!seen.has(k)) { seen.add(k); await rebuildLabor(t, r.employee_id, r.work_date); } }
    return { weeks: seen.size };
  });
}

// ------------------------------------------------------------------ an employee changing a recent day, or asking the office to change an older one
const mine = async (employeeId, id) => { const [e] = await q('SELECT * FROM time_entries WHERE id=$1 AND employee_id=$2', [id, employeeId]); if (!e) throw new HttpError(404, 'Entry not found.'); return e; };
// What an edit may carry: the trades and hours, notes, the injury box, the times (a clocked day) or the hours (a typed day), and the project.
function editBody(e, b) {
  const out = {};
  if (Array.isArray(b.lines)) out.lines = b.lines.map((l) => ({ projectTradeId: l.projectTradeId || null, tradeId: l.tradeId || null, hours: l.hours }));
  if (b.notes !== undefined) out.notes = b.notes;
  if (b.injured !== undefined) { out.injured = !!b.injured; out.injuryNote = b.injured ? b.injuryNote : null; }
  if (b.projectId !== undefined && e.project_id) out.projectId = b.projectId;
  if (b.totalHours !== undefined && e.method === 'Manual') out.totalHours = b.totalHours;
  if (e.method === 'Clock') {
    if (b.inTime) { const d = easternToDate(e.work_date, b.inTime); if (!d) throw bad('Enter the time you started, like 7:00 AM.'); out.clockIn = d.toISOString(); }
    if (b.outTime) { const d = easternToDate(e.work_date, b.outTime); if (!d) throw bad('Enter the time you stopped, like 4:30 PM.'); out.clockOut = d.toISOString(); }
  }
  return out;
}
export async function employeeEdit(employeeId, id, b) {
  const e = await mine(employeeId, id); if (e.status !== 'complete') throw bad('Clock out first.');
  if (e.work_date < editableFrom()) throw new HttpError(403, 'You can change today and yesterday yourself. For an older day, send the office a change request.');
  await editEntry(id, editBody(e, b), null);
}
export async function requestChange(employeeId, id, b) {
  const e = await mine(employeeId, id); if (e.status !== 'complete') throw bad('Clock out first.');
  if (e.work_date >= editableFrom()) throw bad('You can change that day yourself.');
  const message = text(b.message, 'What needs to change', { max: 1000 });
  if ((await q(`SELECT 1 FROM time_corrections WHERE entry_id=$1 AND status='Pending'`, [id])).length) throw new HttpError(409, 'You already asked for a change to that day. The office will get to it.');
  const proposal = editBody(e, b.proposal || {});
  const [emp] = await q('SELECT name FROM employees WHERE id=$1', [employeeId]);
  const [c] = await q('INSERT INTO time_corrections(entry_id,employee_id,message,proposal) VALUES ($1,$2,$3,$4) RETURNING id', [id, employeeId, message, proposal]);
  await notifyRoles(MANAGE, { kind: 'time', title: `Time change request: ${emp.name}, ${e.work_date}`, body: message, link: '#/timepay', dedupe: 'tc:' + c.id }).catch(() => {});
  return { id: c.id };
}
export async function listCorrections(status = 'Pending') {
  if (!['Pending', 'Applied', 'Declined', 'All'].includes(status)) throw bad('Unknown status.');
  const rows = await q(`SELECT c.*, e.name AS employee, te.work_date, te.total_hours, ${SITE} AS site FROM time_corrections c JOIN employees e ON e.id=c.employee_id JOIN time_entries te ON te.id=c.entry_id LEFT JOIN projects p ON p.id=te.project_id ${status === 'All' ? '' : 'WHERE c.status=$1'} ORDER BY c.created_at DESC LIMIT 200`, status === 'All' ? [] : [status]);
  return rows.map((r) => ({ id: r.id, entryId: r.entry_id, employee: r.employee, date: r.work_date, site: r.site, hours: Number(r.total_hours), message: r.message, proposal: r.proposal, status: r.status, at: r.created_at, note: r.decision_note }));
}
export async function decideCorrection(userId, id, apply, note) {
  const [c] = await q(`SELECT * FROM time_corrections WHERE id=$1`, [id]); if (!c) throw new HttpError(404, 'Request not found.'); if (c.status !== 'Pending') throw new HttpError(409, 'That request was already decided.');
  if (apply) await editEntry(c.entry_id, c.proposal || {}, userId);   // an invalid change is refused with its reason and the request stays open
  await q(`UPDATE time_corrections SET status=$2, decided_by=$3, decided_at=now(), decision_note=$4 WHERE id=$1`, [id, apply ? 'Applied' : 'Declined', userId, text(note, 'Note', { max: 500, required: false }) || null]);
}

// ------------------------------------------------------------------ the office's weekly tally (Monday to Sunday) and all-time project / trade totals
// Pay and rates are for the Super Admin only; everyone else gets hours.
export async function summary({ start, scope = 'week', showPay = false } = {}) {
  const today = todayEastern(), ws = weekStart(start ? dateStr(start, 'Week') : today), we = shift(ws, 6), s = await getSettings(), cfg = payCfg(s);
  const from = scope === 'all' ? '1900-01-01' : ws, to = scope === 'all' ? '2999-12-31' : we;
  const entries = await q(`SELECT te.employee_id, te.work_date, te.total_hours, te.injured, te.project_id, te.status FROM time_entries te WHERE te.work_date BETWEEN $1 AND $2`, [ws, we]);
  const emps = await q('SELECT id, name, pay_type, hourly_rate, active FROM employees ORDER BY name');
  const people = emps.map((e) => { const mine = entries.filter((x) => x.employee_id === e.id), done = mine.filter((x) => x.status === 'complete');
    const wp = weekPay({ payType: e.pay_type, rate: Number(e.hourly_rate) }, cfg, done.map((x) => ({ date: x.work_date, totalHours: Number(x.total_hours) })));
    return { id: e.id, name: e.name, active: e.active, hours: r2(wp.total), regular: r2(wp.reg), overtime: r2(wp.ot), days: new Set(done.map((x) => x.work_date)).size, otherHours: r2(done.filter((x) => !x.project_id).reduce((n, x) => n + Number(x.total_hours), 0)), open: mine.filter((x) => x.status === 'open').length, injuries: mine.filter((x) => x.injured).length,
      payType: showPay ? e.pay_type : null, rate: showPay ? Number(e.hourly_rate) : null, pay: showPay ? r2(wp.pay) : null }; }).filter((x) => x.hours || x.open || x.active);
  const sites = await q(`SELECT COALESCE(p.name, 'Other: ' || l.other_name) AS site, p.id AS project_id, t.name AS trade, SUM(l.hours)::float8 AS hours, SUM(COALESCE(l.pay, ROUND(l.hours*l.rate,2)))::float8 AS cost, count(DISTINCT l.employee_id)::int AS people
    FROM labor_entries l LEFT JOIN projects p ON p.id=l.project_id LEFT JOIN trades t ON t.id=l.trade_id WHERE l.source='Time clock' AND l.work_date BETWEEN $1 AND $2 GROUP BY 1, 2, 3 ORDER BY 1, 3`, [from, to]);
  return { scope, start: ws, end: we, today, people, totals: { hours: r2(people.reduce((n, x) => n + x.hours, 0)), pay: showPay ? r2(people.reduce((n, x) => n + (x.pay || 0), 0)) : null },
    sites: sites.map((r) => ({ site: r.site, projectId: r.project_id, trade: r.trade || 'No trade', hours: r2(r.hours), cost: showPay ? r2(r.cost) : null, people: r.people })) };
}
