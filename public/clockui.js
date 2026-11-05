// The clock screens, shared by the field time clock page (PIN sign-in) and the Time Clock inside the platform (a login linked to an
// employee). Only where the requests go differs: `base` is /clock for the PIN page and /me/clock inside the platform.
// Two tabs: Clock (clock in, finish the day with its trades) and My Week (this week, last week, two weeks back; change a recent day).
import { h, notice, guard, formModal, modal, field, todayStr } from '/ui.js';
const hrs = (n) => (Math.round(n * 100) / 100).toFixed(2);
const usd = (n) => (n == null ? '' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const day = (d) => new Date(String(d).slice(0, 10) + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const hm12 = (t) => { if (!t) return ''; const [H, M] = t.split(':').map(Number); return `${((H + 11) % 12) + 1}:${String(M).padStart(2, '0')} ${H < 12 ? 'AM' : 'PM'}`; };
const position = () => new Promise((res) => { if (!navigator.geolocation) return res(null); navigator.geolocation.getCurrentPosition((p) => res({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }), () => res(null), { enableHighAccuracy: true, timeout: 8000 }); });
const plain = { style: 'text-transform:none;letter-spacing:0;font-size:15px;font-weight:400;display:flex;gap:.5rem;align-items:flex-start' };
const INJURY = 'Check this box if you were injured, or became injured, while at work today. If you leave it unchecked, you confirm that you did not arrive hurt, were not hurt or injured at any point during the day, and are not hurt or injured as you sign out.';
let tab = 'clock';   // remembered while the page stays open

export function makeClockUi({ api, base, reload }) {
  const load = reload;
  // Hours in half-hour steps, short enough to tap: 0.5 up to the length of the day.
  const hoursSelect = (max, value) => { const top = Math.max(1, Math.min(24, Math.ceil(max * 2) / 2)); const s = h('select', { class: 'hrsel' }, Array.from({ length: top * 2 }, (_, i) => h('option', { value: (i + 1) / 2 }, ((i + 1) / 2).toString()))); s.value = String(Math.min(top, value || 1)); return s; };
  // Trades for the day, chosen at day's end. Each row is a trade and its hours; the last row simply takes the rest of the day.
  function tradeRows({ options, key, getTotal, initial = [] }) {
    const box = h('div'), left = h('div', { class: 'muted', style: 'font-size:13px;margin:.3rem 0' }); const rows = [];
    const drawLeft = () => { const t = getTotal(); left.textContent = t ? `${rows.length > 1 ? 'The last trade takes the rest of the ' : 'All '}${hrs(t)} hours ${rows.length > 1 ? '' : 'go to this trade.'}`.trim() : ''; };
    const add = (pre) => {
      const sel = h('select', { class: 'tradesel' }, h('option', { value: '' }, 'Choose the trade…'), options.map((t) => h('option', { value: t.id }, t.name))); if (pre?.id) sel.value = pre.id;
      const hrsSel = hoursSelect(getTotal() || 12, pre?.hours || Math.max(0.5, Math.floor((getTotal() / 2) * 2) / 2)), lastLbl = h('span', { class: 'muted rest' }, 'the rest');
      const row = h('div', { class: 'trade-row2' }, sel, hrsSel, lastLbl, h('button', { class: 'small', type: 'button', onclick: () => { if (rows.length > 1) { rows.splice(rows.indexOf(row), 1); row.remove(); mark(); } } }, 'Remove')); row._sel = sel; row._hrs = hrsSel; row._rest = lastLbl; rows.push(row); box.append(row); mark();
    };
    function mark() { rows.forEach((r, i) => { const last = i === rows.length - 1; r._hrs.style.display = last ? 'none' : ''; r._rest.style.display = last ? '' : 'none'; r._rest.textContent = rows.length === 1 ? 'all hours' : 'the rest'; }); drawLeft(); }
    (initial.length ? initial : [{}]).forEach(add);
    return { el: h('div', {}, box, h('button', { class: 'small', type: 'button', onclick: () => add() }, '+ Another trade'), left), refresh: mark,
      get: () => rows.map((r, i) => ({ [key]: r._sel.value, hours: i === rows.length - 1 ? 'rest' : Number(r._hrs.value) })), check: () => { if (rows.some((r) => !r._sel.value)) throw new Error('Choose a trade for every row.'); } };
  }
  // The injury box and notes that end every day.
  const dayEndFields = (init = {}) => {
    const inj = h('input', { type: 'checkbox', style: 'margin-top:.2rem' }), note = h('input', { placeholder: 'What happened?', value: init.injuryNote || '' }), notes = h('textarea', { rows: 2, placeholder: 'Anything the office should know about today', value: init.notes || '' }); inj.checked = !!init.injured;
    const noteBox = h('div', { style: inj.checked ? '' : 'display:none' }, field('Tell us what happened', note)); inj.onchange = () => { noteBox.style.display = inj.checked ? '' : 'none'; };
    return { el: [h('label', plain, inj, h('span', {}, INJURY)), noteBox, field('Notes For The Day', notes)], get: () => ({ injured: inj.checked, injuryNote: inj.checked ? note.value : '', notes: notes.value }) };
  };
  // Choosing where: a project, or Other with its name and where it is.
  function sitePicker(home) {
    const proj = h('select', {}, h('option', { value: '' }, 'Choose the jobsite…'), home.projects.map((p) => h('option', { value: p.id }, p.name)), h('option', { value: '__other' }, 'Other (not on the list)…'));
    const name = h('input', { placeholder: 'Jobsite name' }), where = h('input', { placeholder: 'Street, city' }), box = h('div', { style: 'display:none;margin-top:.5rem' }, h('div', { class: 'form' }, field('Jobsite Name', name), field('Where Is It?', where)));
    proj.onchange = () => { box.style.display = proj.value === '__other' ? '' : 'none'; };
    return { el: h('div', {}, proj, box), get: () => { if (!proj.value) throw new Error('Choose the jobsite.'); return proj.value === '__other' ? { other: { name: name.value, address: where.value } } : { projectId: proj.value }; }, isOther: () => proj.value === '__other', projectId: () => (proj.value && proj.value !== '__other' ? proj.value : null) };
  }

  function clockInCard(home) {
    const err = h('div'), site = sitePicker(home);
    return h('div', { class: 'card' }, h('h2', {}, 'Clock In'), field('Where Are You Working?', site.el), err, h('p', { class: 'muted', style: 'font-size:13px' }, 'You choose your trades at the end of the day, when you clock out.'),
      h('button', { class: 'primary bigbtn', style: 'margin-top:.6rem', onclick: guard(err, async () => { const where = site.get(); const gps = await position(); await api('POST', `${base}/in`, { ...where, gps }); load(); }) }, 'Clock In'));
  }
  // Finishing a day: the time (only when an old day was left open), the trades with hours, the injury question and notes.
  function finishDayModal(home, o) {
    const stale = o.stale, proj = home.projects.find((p) => p.id === o.projectId);
    const options = o.other ? home.allTrades : (proj?.trades || []), key = o.other ? 'tradeId' : 'projectTradeId';
    const out = h('input', { type: 'time', value: '16:00' }); const total = () => (stale ? Math.max(0, (new Date(`${o.workDate}T${out.value || '00:00'}:00`) - new Date(`${o.workDate}T00:00:00`)) / 3600000 - (new Date(o.since) - new Date(`${o.workDate}T00:00:00`)) / 3600000) : Math.max(0.5, (Date.now() - new Date(o.since)) / 3600000));
    const rows = tradeRows({ options, key, getTotal: () => Math.round(total() * 100) / 100 }); out.onchange = () => rows.refresh(); const end = dayEndFields();
    formModal(stale ? `Finish ${day(o.workDate)}` : 'Finish Your Day', [stale ? h('p', { class: 'err wide' }, `You did not clock out on ${day(o.workDate)} (${o.project}). Enter when you stopped and your trades. You cannot clock in again until this is done.`) : '', stale ? field('What Time Did You Stop?', out, 'wide') : '',
      field('Your Trades Today', rows.el, 'wide'), h('div', { class: 'wide' }, end.el)],
    async () => { rows.check(); const gps = await position(); await api('POST', `${base}/out`, { lines: rows.get(), ...(stale ? { outTime: out.value } : {}), ...end.get(), gps }); load(); }, 'Finish And Clock Out');
  }
  function clockedInCard(home) {
    const o = home.open, t = h('div', { class: 'timer' }), err = h('div');
    if (o.stale) return h('div', { class: 'card' }, h('h2', {}, 'Finish Your Last Day'), h('p', { class: 'err' }, `You clocked in on ${day(o.workDate)} at ${o.project} and never clocked out. Finish that day before you do anything else.`), h('button', { class: 'primary bigbtn', onclick: () => finishDayModal(home, o) }, `Finish ${day(o.workDate)}`));
    const tick = () => { const s = Math.max(0, Math.floor((Date.now() - new Date(o.since)) / 1000)); t.textContent = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':'); };
    tick(); const iv = setInterval(() => (t.isConnected ? tick() : clearInterval(iv)), 1000);
    return h('div', { class: 'card' }, h('h2', {}, 'You Are Clocked In'), h('p', { class: 'muted' }, o.project), t, err, h('button', { class: 'primary bigbtn', onclick: () => finishDayModal(home, o) }, 'Clock Out'));
  }
  // A whole day entered after the fact, with as many trades as the day had.
  function manualCard(home) {
    return h('button', { onclick: () => {
      const date = h('input', { type: 'date', value: todayStr(), max: todayStr() }), site = sitePicker(home), notes = h('input'); let rows = null; const holder = h('div'), total = h('input', { type: 'number', step: '0.5', min: '0.5', max: '16', placeholder: 'Total hours' });
      const setRows = () => { rows = tradeRows({ options: site.isOther() ? home.allTrades : (home.projects.find((p) => p.id === site.projectId())?.trades || []), key: site.isOther() ? 'tradeId' : 'projectTradeId', getTotal: () => Number(total.value) || 0 }); holder.replaceChildren(rows.el); };
      site.el.querySelector('select').addEventListener('change', setRows); total.oninput = () => rows && rows.refresh(); setRows(); const end = dayEndFields();
      formModal('Add A Day I Forgot To Clock', [field('Date', date), field('Jobsite', site.el), field('Total Hours For The Day', total), field('Trades', holder, 'wide'), h('div', { class: 'wide' }, end.el)],
        async () => { const where = site.get(); if (!(Number(total.value) > 0)) throw new Error('Enter the total hours for the day.'); rows.check(); await api('POST', `${base}/manual`, { date: date.value, ...where, hours: Number(total.value), lines: rows.get(), ...end.get() }); load(); }, 'Add The Day');
    } }, 'Forgot To Clock? Add A Day');
  }
  const linesText = (e) => (e.lines || []).map((l) => `${l.trade || 'No trade'} ${hrs(l.hours)}h`).join(', ');
  // Changing a recent day (today or yesterday), or asking the office to change an older one.
  function editDay(home, e, wk) {
    const old = !e.editable, err = h('div');
    if (old) {
      const msg = h('textarea', { rows: 3, placeholder: 'What should it say? For example: I worked 6 hours at Site A, not 8.' }), tot = h('input', { type: 'number', step: '0.5', min: '0.5', max: '16', placeholder: 'Correct total hours (optional)' });
      formModal(`Ask The Office To Change ${day(e.date)}`, [h('p', { class: 'muted wide' }, 'You can change today and yesterday yourself. Older days are checked by the office first.'), field('What Needs To Change?', msg, 'wide'), field('Correct Hours', tot)], async () => { await api('POST', `${base}/entries/${e.id}/request`, { message: msg.value, proposal: tot.value ? { totalHours: Number(tot.value) } : {} }); load(); }, 'Send To The Office'); return;
    }
    const proj = home.projects.find((p) => p.name === e.site), options = e.other ? home.allTrades : (proj?.trades || []), key = e.other ? 'tradeId' : 'projectTradeId';
    const inT = h('input', { type: 'time', value: e.inTime || '' }), outT = h('input', { type: 'time', value: e.outTime || '' }), tot = h('input', { type: 'number', step: '0.5', min: '0.5', max: '16', value: e.hours });
    const clocked = e.method === 'Clock'; const total = () => (clocked ? Math.max(0.5, ((new Date(`2000-01-01T${outT.value || '00:00'}:00`) - new Date(`2000-01-01T${inT.value || '00:00'}:00`)) / 3600000)) : Number(tot.value) || e.hours);
    const rows = tradeRows({ options, key, getTotal: total, initial: (e.lines || []).map((l) => ({ id: key === 'tradeId' ? l.tradeId : l.projectTradeId, hours: l.hours })) }); inT.onchange = outT.onchange = tot.oninput = () => rows.refresh();
    const end = dayEndFields({ injured: e.injured, notes: e.notes });
    formModal(`Change ${day(e.date)}: ${e.site}`, [...(clocked ? [field('Started', inT), field('Stopped', outT)] : [field('Total Hours', tot)]), field('Trades', rows.el, 'wide'), h('div', { class: 'wide' }, end.el)],
      async () => { rows.check(); await api('PUT', `${base}/entries/${e.id}`, { lines: rows.get(), ...(clocked ? { inTime: inT.value, outTime: outT.value } : { totalHours: Number(tot.value) }), ...end.get() }); load(); }, 'Save Changes');
  }
  const entryRow = (home, e, wk) => h('tr', {}, h('td', {}, day(e.date)), h('td', { style: 'white-space:normal' }, e.site, h('div', { class: 'muted', style: 'font-size:12px' }, e.status === 'open' ? 'Still clocked in' : linesText(e) || 'No trades')),
    h('td', { class: 'n' }, e.status === 'open' ? 'open' : hrs(e.hours)), h('td', { style: 'white-space:nowrap' }, e.request === 'Pending' ? h('span', { class: 'pill Pending' }, 'Change Requested') : e.status === 'complete' ? h('button', { class: 'small', onclick: () => editDay(home, e, wk) }, e.editable ? 'Change' : 'Ask To Change') : ''));
  // This week and the two before it: hours, overtime and pay for the signed-in person only.
  function weekCard(home, wk, i) {
    const title = i === 0 ? 'This Week' : i === 1 ? 'Last Week' : 'Two Weeks Ago', range = `${day(wk.start)} to ${day(wk.end)}`;
    return h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', {}, title), h('span', { class: 'muted', style: 'font-size:13px' }, range)),
      h('div', { class: 'grid kpis' }, h('div', { class: 'kpi' }, h('div', { class: 'l' }, 'Hours'), h('div', { class: 'v' }, hrs(wk.hours))), h('div', { class: 'kpi' }, h('div', { class: 'l' }, 'Overtime'), h('div', { class: 'v' }, hrs(wk.overtime))), wk.pay != null ? h('div', { class: 'kpi' }, h('div', { class: 'l' }, 'Pay'), h('div', { class: 'v' }, usd(wk.pay))) : ''),
      wk.entries.length ? h('table', { style: 'margin-top:.8rem' }, h('tbody', {}, wk.entries.map((e) => entryRow(home, e, wk)))) : h('p', { class: 'muted' }, 'No time this week.'));
  }
  const tabs = (home) => h('div', { class: 'tabs' }, [['clock', 'Clock'], ['week', 'My Week']].map(([k, l]) => h('a', { class: tab === k ? 'on' : '', href: '#', onclick: (e) => { e.preventDefault(); tab = k; load(); } }, l)));
  return { tabs: (home) => tabs(home), body: (home) => [tabs(home), ...(tab === 'week' ? home.weeks.map((wk, i) => weekCard(home, wk, i)) : [home.open ? clockedInCard(home) : clockInCard(home), home.open ? '' : manualCard(home), weekSummary(home)])],
    setTab: (k) => { tab = k; }, getTab: () => tab };
  function weekSummary(home) { const w = home.weeks[0]; return h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', {}, 'This Week So Far'), h('a', { href: '#', onclick: (e) => { e.preventDefault(); tab = 'week'; load(); } }, 'See My Week')), h('div', { class: 'grid kpis' }, h('div', { class: 'kpi' }, h('div', { class: 'l' }, 'Hours'), h('div', { class: 'v' }, hrs(w.hours))), w.pay != null ? h('div', { class: 'kpi' }, h('div', { class: 'l' }, 'Pay'), h('div', { class: 'v' }, usd(w.pay))) : '')); }
}
