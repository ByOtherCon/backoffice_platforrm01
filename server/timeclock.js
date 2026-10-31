import crypto from 'node:crypto';
import { q, tx } from './db.js';
import { bad, money, text, dateStr, HttpError } from './http.js';
import { hashPassword, verifyPassword } from './auth.js';
import { allocateLabor, weekPay, weekStart } from '../src/lib/payroll.ts';

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
const roundHours = (h, minutes) => (minutes ? r2(Math.round(h / (minutes / 60)) * (minutes / 60)) : r2(h));
const miles = (a, b, c, d) => { const R = 3958.8, rad = (x) => (x * Math.PI) / 180, dl = rad(c - a), dg = rad(d - b); const x = Math.sin(dl / 2) ** 2 + Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(dg / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };

// ------------------------------------------------------------------ PIN sign-in
export const roster = () => q('SELECT id, name FROM employees WHERE active AND pin_hash IS NOT NULL ORDER BY name');
export async function setPin(employeeId, pin) {
  if (!/^\d{4,8}$/.test(String(pin || ''))) throw bad('A PIN is 4 to 8 digits.');
  const r = await q('UPDATE employees SET pin_hash=$2, pin_failed=0, pin_locked_until=NULL WHERE id=$1 RETURNING id', [employeeId, await hashPassword(String(pin))]);
  if (!r.length) throw new HttpError(404, 'Employee not found.');
}
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
export async function rebuildLabor(t, employeeId, anyDate) {
  const ws = weekStart(anyDate), we = new Date(ws + 'T00:00:00Z'); we.setUTCDate(we.getUTCDate() + 6);
  const wsEnd = we.toISOString().slice(0, 10);
  const [emp] = await t('SELECT pay_type, hourly_rate FROM employees WHERE id=$1', [employeeId]);
  const entries = await t(`SELECT te.id, te.work_date, te.project_id, te.total_hours FROM time_entries te WHERE te.employee_id=$1 AND te.status='complete' AND te.work_date BETWEEN $2 AND $3`, [employeeId, ws, wsEnd]);
  const lines = entries.length ? await t('SELECT entry_id, project_trade_id, hours FROM time_entry_lines WHERE entry_id = ANY($1::uuid[]) ORDER BY seq', [entries.map((e) => e.id)]) : [];
  const settings = await getSettings();
  const clock = entries.map((e) => ({ id: e.id, employeeId, date: e.work_date, projectId: e.project_id, totalHours: Number(e.total_hours), status: 'complete',
    lines: lines.filter((l) => l.entry_id === e.id).map((l) => ({ trade: l.project_trade_id ?? '', hours: Number(l.hours) })) }));
  const rows = allocateLabor(clock, { [employeeId]: { payType: emp.pay_type, rate: Number(emp.hourly_rate) } }, payCfg(settings));
  await t(`DELETE FROM labor_entries WHERE employee_id=$1 AND source='Time clock' AND work_date BETWEEN $2 AND $3`, [employeeId, ws, wsEnd]);
  for (const r of rows) await t(`INSERT INTO labor_entries(project_id,project_trade_id,employee_id,work_date,hours,rate,pay,source,import_key) VALUES ($1,$2,$3,$4,$5,$6,$7,'Time clock',$8)`,
    [r.projectId, r.trade || null, employeeId, r.date, r.hours, Number(emp.hourly_rate), r.pay, r.importKey]);
}

// ------------------------------------------------------------------ employee clock
export async function clockHome(employeeId) {
  const [emp] = await q('SELECT id, name, pay_type, hourly_rate FROM employees WHERE id=$1', [employeeId]);
  const [open] = await q(`SELECT te.*, p.name AS project, t.name AS trade FROM time_entries te JOIN projects p ON p.id=te.project_id LEFT JOIN project_trades pt ON pt.id=te.primary_trade_id LEFT JOIN trades t ON t.id=pt.trade_id WHERE te.employee_id=$1 AND te.status='open'`, [employeeId]);
  const projects = await q(`SELECT p.id, p.name, p.address, p.geofence_required FROM projects p WHERE p.active ORDER BY p.name`);
  const trades = projects.length ? await q(`SELECT pt.id, pt.project_id, t.name FROM project_trades pt JOIN trades t ON t.id=pt.trade_id WHERE pt.project_id = ANY($1::uuid[]) ORDER BY t.sort, t.name`, [projects.map((p) => p.id)]) : [];
  const ws = weekStart(easternDate(new Date()));
  const week = await q(`SELECT te.id, te.work_date, te.total_hours, te.status, p.name AS project FROM time_entries te JOIN projects p ON p.id=te.project_id WHERE te.employee_id=$1 AND te.work_date >= $2 ORDER BY te.clock_in DESC`, [employeeId, ws]);
  const s = await getSettings();
  const done = week.filter((w) => w.status === 'complete').map((w) => ({ date: w.work_date, totalHours: Number(w.total_hours) }));
  const wp = weekPay({ payType: emp.pay_type, rate: Number(emp.hourly_rate) }, payCfg(s), done);
  return {
    employee: { id: emp.id, name: emp.name }, open: open ? { id: open.id, project: open.project, trade: open.trade, projectId: open.project_id, since: open.clock_in, primaryTradeId: open.primary_trade_id } : null,
    projects: projects.map((p) => ({ id: p.id, name: p.name, address: p.address, trades: trades.filter((t) => t.project_id === p.id).map((t) => ({ id: t.id, name: t.name })) })),
    week: week.map((w) => ({ id: w.id, date: w.work_date, hours: Number(w.total_hours), status: w.status, project: w.project })),
    weekTotals: { hours: r2(wp.total), regular: r2(wp.reg), overtime: r2(wp.ot), estPay: emp.hourly_rate ? wp.pay : null },
    settings: { lunchMinutes: s.lunchMinutes, lunchAfterHours: s.lunchAfterHours },
  };
}
export async function clockIn(employeeId, b) {
  const s = await getSettings(); const now = new Date();
  return tx(async (t) => {
    const [p] = await t('SELECT * FROM projects WHERE id=$1 AND active', [b.projectId]);
    if (!p) throw bad('Choose an active project.');
    if (b.projectTradeId && !(await t('SELECT 1 FROM project_trades WHERE id=$1 AND project_id=$2', [b.projectTradeId, p.id])).length) throw bad('That trade is not on this project.');
    if (p.geofence_required && p.lat != null) {
      const g = b.gps; if (!g || !Number.isFinite(g.lat) || !Number.isFinite(g.lng)) throw new HttpError(403, 'This jobsite requires your location. Allow location access and try again.');
      const d = miles(Number(p.lat), Number(p.lng), g.lat, g.lng);
      if (d > Number(p.geofence_miles)) throw new HttpError(403, `You are ${d.toFixed(1)} miles from this jobsite. Clock in on site.`);
    }
    const [dup] = await t(`SELECT 1 FROM time_entries WHERE employee_id=$1 AND status='open'`, [employeeId]);
    if (dup) throw new HttpError(409, 'You are already clocked in. Clock out first.');
    const [h, m] = s.dayStart.split(':').map(Number); const late = easternHM(now) > h * 60 + m + s.lateGraceMinutes;
    const gps = b.gps && Number.isFinite(b.gps.lat) && Number.isFinite(b.gps.lng) ? { lat: b.gps.lat, lng: b.gps.lng, accuracy: Number(b.gps.accuracy) || null } : null;
    const [e] = await t(`INSERT INTO time_entries(employee_id,project_id,primary_trade_id,work_date,clock_in,late_in,gps_in) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [employeeId, p.id, b.projectTradeId || null, easternDate(now), now, late, gps]);
    return { id: e.id };
  });
}
async function normalizeLines(t, projectId, lines, total, fallbackTrade) {
  let ls = Array.isArray(lines) && lines.length ? lines : [{ projectTradeId: fallbackTrade || null, hours: total }];
  ls = ls.map((l) => ({ projectTradeId: l.projectTradeId || null, hours: money(l.hours, 'Hours') })).filter((l) => l.hours > 0);
  for (const l of ls) if (l.projectTradeId && !(await t('SELECT 1 FROM project_trades WHERE id=$1 AND project_id=$2', [l.projectTradeId, projectId])).length) throw bad('A trade is not on this project.');
  const sum = r2(ls.reduce((n, l) => n + l.hours, 0));
  if (Math.abs(sum - total) > 0.01) throw bad(`Trade hours add up to ${sum.toFixed(2)} but the day totals ${total.toFixed(2)}. Assign every hour to a trade.`);
  return ls;
}
export async function clockOut(employeeId, b) {
  const s = await getSettings(); const now = new Date();
  return tx(async (t) => {
    const [e] = await t(`SELECT * FROM time_entries WHERE employee_id=$1 AND status='open' FOR UPDATE`, [employeeId]);
    if (!e) throw new HttpError(409, 'You are not clocked in.');
    const gross = roundHours((now - new Date(e.clock_in)) / 3600000, s.roundMinutes);
    const lunch = s.lunchMinutes && gross >= s.lunchAfterHours ? s.lunchMinutes / 60 : 0;
    const total = r2(Math.max(0, gross - lunch));
    if (total <= 0) throw bad('That shift is under a minute. Ask the office to remove it.');
    if (total > 24) throw bad('That shift is over 24 hours. Ask the office to correct it.');
    const lines = await normalizeLines(t, e.project_id, b.lines, total, e.primary_trade_id);
    await t(`UPDATE time_entries SET clock_out=$2, gross_hours=$3, lunch_hours=$4, total_hours=$5, injured=$6, injury_note=$7, notes=$8, status='complete' WHERE id=$1`,
      [e.id, now, gross, lunch, total, !!b.injured, b.injured ? text(b.injuryNote, 'Injury note', { max: 1000, required: false }) || null : null, text(b.notes, 'Notes', { max: 1000, required: false }) || null]);
    for (const l of lines) await t('INSERT INTO time_entry_lines(entry_id,project_trade_id,hours) VALUES ($1,$2,$3)', [e.id, l.projectTradeId, l.hours]);
    await rebuildLabor(t, employeeId, e.work_date);
    return { totalHours: total };
  });
}
export async function manualEntry(employeeId, b) {
  const date = dateStr(b.date, 'Date', true); if (date > easternDate(new Date())) throw bad('The date cannot be in the future.');
  const hours = money(b.hours, 'Hours'); if (!(hours > 0 && hours <= 16)) throw bad('Hours must be between 0 and 16.');
  return tx(async (t) => {
    const [p] = await t('SELECT id FROM projects WHERE id=$1 AND active', [b.projectId]); if (!p) throw bad('Choose an active project.');
    const lines = await normalizeLines(t, p.id, b.lines, hours, b.projectTradeId);
    const [e] = await t(`INSERT INTO time_entries(employee_id,project_id,primary_trade_id,work_date,clock_in,clock_out,gross_hours,total_hours,status,method,notes) VALUES ($1,$2,$3,$4,$5,$5,$6,$6,'complete','Manual',$7) RETURNING id`,
      [employeeId, p.id, b.projectTradeId || null, date, new Date(date + 'T12:00:00Z'), hours, text(b.notes, 'Notes', { max: 1000, required: false }) || null]);
    for (const l of lines) await t('INSERT INTO time_entry_lines(entry_id,project_trade_id,hours) VALUES ($1,$2,$3)', [e.id, l.projectTradeId, l.hours]);
    await rebuildLabor(t, employeeId, date); return { id: e.id };
  });
}

// ------------------------------------------------------------------ office view and corrections
export const activeNow = () => q(`SELECT te.id, te.clock_in, te.late_in, e.name AS employee, p.name AS project, p.id AS project_id, t.name AS trade
  FROM time_entries te JOIN employees e ON e.id=te.employee_id JOIN projects p ON p.id=te.project_id LEFT JOIN project_trades pt ON pt.id=te.primary_trade_id LEFT JOIN trades t ON t.id=pt.trade_id WHERE te.status='open' ORDER BY te.clock_in`);
export async function listEntries({ from, to, employeeId, projectId } = {}) {
  const w = [], v = [];
  if (from) { v.push(dateStr(from, 'From')); w.push(`te.work_date >= $${v.length}`); }
  if (to) { v.push(dateStr(to, 'To')); w.push(`te.work_date <= $${v.length}`); }
  if (employeeId) { v.push(employeeId); w.push(`te.employee_id = $${v.length}`); }
  if (projectId) { v.push(projectId); w.push(`te.project_id = $${v.length}`); }
  const rows = await q(`SELECT te.*, e.name AS employee, p.name AS project FROM time_entries te JOIN employees e ON e.id=te.employee_id JOIN projects p ON p.id=te.project_id ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY te.work_date DESC, te.clock_in DESC LIMIT 1000`, v);
  const lines = rows.length ? await q(`SELECT l.entry_id, l.project_trade_id, l.hours, t.name AS trade FROM time_entry_lines l LEFT JOIN project_trades pt ON pt.id=l.project_trade_id LEFT JOIN trades t ON t.id=pt.trade_id WHERE l.entry_id = ANY($1::uuid[])`, [rows.map((r) => r.id)]) : [];
  return rows.map((r) => ({ id: r.id, employeeId: r.employee_id, employee: r.employee, projectId: r.project_id, project: r.project, date: r.work_date, clockIn: r.clock_in, clockOut: r.clock_out, grossHours: Number(r.gross_hours), lunchHours: Number(r.lunch_hours), totalHours: Number(r.total_hours),
    status: r.status, method: r.method, lateIn: r.late_in, injured: r.injured, injuryNote: r.injury_note, notes: r.notes, modified: !!r.modified_at,
    lines: lines.filter((l) => l.entry_id === r.id).map((l) => ({ projectTradeId: l.project_trade_id, trade: l.trade, hours: Number(l.hours) })) }));
}
export async function editEntry(id, b, userId) {
  return tx(async (t) => {
    const [e] = await t('SELECT * FROM time_entries WHERE id=$1 FOR UPDATE', [id]); if (!e) throw new HttpError(404, 'Entry not found.');
    const s = await getSettings();
    const projectId = b.projectId ?? e.project_id;
    if (b.projectId && !(await t('SELECT 1 FROM projects WHERE id=$1', [b.projectId])).length) throw bad('Project not found.');
    let cin = b.clockIn ? new Date(b.clockIn) : new Date(e.clock_in), cout = b.clockOut ? new Date(b.clockOut) : e.clock_out ? new Date(e.clock_out) : null;
    if (Number.isNaN(cin.getTime()) || (cout && Number.isNaN(cout.getTime()))) throw bad('Enter valid times.');
    let gross = Number(e.gross_hours), lunch = b.lunchHours !== undefined ? money(b.lunchHours, 'Lunch hours') : Number(e.lunch_hours), total = Number(e.total_hours);
    if (e.method === 'Manual' && b.totalHours !== undefined) { total = money(b.totalHours, 'Hours'); gross = total + lunch; }
    else if (cout) { if (cout <= cin) throw bad('Clock-out must be after clock-in.'); gross = roundHours((cout - cin) / 3600000, s.roundMinutes); total = r2(Math.max(0, gross - lunch)); }
    if (e.status === 'complete' && !(total > 0 && total <= 24)) throw bad('Total hours must be between 0 and 24.');
    const workDate = e.method === 'Manual' ? (b.date ? dateStr(b.date, 'Date', true) : e.work_date) : easternDate(cin);
    await t(`UPDATE time_entries SET project_id=$2, clock_in=$3, clock_out=$4, gross_hours=$5, lunch_hours=$6, total_hours=$7, work_date=$8, notes=$9, injured=$10, injury_note=$11, modified_by=$12, modified_at=now() WHERE id=$1`,
      [id, projectId, cin, cout, gross, lunch, total, workDate, b.notes !== undefined ? text(b.notes, 'Notes', { max: 1000, required: false }) || null : e.notes, b.injured !== undefined ? !!b.injured : e.injured, b.injuryNote !== undefined ? text(b.injuryNote, 'Injury note', { max: 1000, required: false }) || null : e.injury_note, userId]);
    if (e.status === 'complete') {
      const lines = await normalizeLines(t, projectId, b.lines && b.lines.length ? b.lines : (await t('SELECT project_trade_id AS "projectTradeId", hours FROM time_entry_lines WHERE entry_id=$1 ORDER BY seq', [id])).map((l) => ({ ...l, hours: Number(l.hours) })), total, null);
      await t('DELETE FROM time_entry_lines WHERE entry_id=$1', [id]);
      for (const l of lines) await t('INSERT INTO time_entry_lines(entry_id,project_trade_id,hours) VALUES ($1,$2,$3)', [id, l.projectTradeId, l.hours]);
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
