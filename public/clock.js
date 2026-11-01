// Field time clock. Same look and same form components as the office app (ui.js).
import { h, usd, notice, guard, modal, formModal, field, todayStr, num } from '/ui.js';
const $app = document.getElementById('app');
const state = { employee: null, home: null };
async function api(method, path, body) {
  const res = await fetch('/api' + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path === '/clock/home') { state.employee = null; return null; }
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}
const hrs = (n) => (Math.round(n * 100) / 100).toFixed(2);
const position = () => new Promise((res) => { if (!navigator.geolocation) return res(null); navigator.geolocation.getCurrentPosition((p) => res({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }), () => res(null), { enableHighAccuracy: true, timeout: 8000 }); });
const frame = (...kids) => h('div', {}, h('header', { class: 'top' }, h('img', { class: 'logo', src: '/logo.png', alt: 'ByOther Construction' }), h('nav'), state.employee ? h('button', { class: 'small', onclick: async () => { await api('POST', '/logout', {}); state.employee = null; load(); } }, 'Sign out') : ''), h('div', { class: 'clockwrap' }, kids));

async function loginView() {
  const roster = await api('GET', '/clock/roster'); const err = h('div');
  const who = h('select', {}, h('option', { value: '' }, 'Choose your name…'), roster.map((e) => h('option', { value: e.id }, e.name)));
  const pin = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', placeholder: 'PIN', maxlength: 8 });
  return frame(h('h1', {}, 'Time clock'), h('form', { class: 'card', onsubmit: guard(err, async (e) => { e.preventDefault(); const r = await api('POST', '/clock/login', { employeeId: who.value, pin: pin.value }); state.employee = r.employee; load(); }) },
    field('Name', who), h('div', { style: 'margin-top:.8rem' }, field('PIN', pin)), err, h('button', { class: 'primary bigbtn', style: 'margin-top:1rem', type: 'submit' }, 'Sign in')),
    roster.length ? '' : h('p', { class: 'muted' }, 'No one has a PIN yet. The office sets it in Admin > Employees.'));
}

function clockInCard(home) {
  const err = h('div'); const proj = h('select', {}, h('option', { value: '' }, 'Choose active project…'), home.projects.map((p) => h('option', { value: p.id }, p.name)));
  const trade = h('select', { disabled: true }, h('option', { value: '' }, 'Choose project first'));
  proj.onchange = () => { const p = home.projects.find((x) => x.id === proj.value); trade.replaceChildren(h('option', { value: '' }, p ? 'Choose trade…' : 'Choose project first'), ...(p ? p.trades.map((t) => h('option', { value: t.id }, t.name)) : [])); trade.disabled = !p; };
  return h('div', { class: 'card' }, h('h2', {}, 'Clock in'), field('Active project', proj), h('div', { style: 'margin-top:.7rem' }, field('Trade', trade)), err,
    h('button', { class: 'primary bigbtn', style: 'margin-top:1rem', onclick: guard(err, async () => { if (!proj.value || !trade.value) throw new Error('Choose a project and a trade.'); const gps = await position(); await api('POST', '/clock/in', { projectId: proj.value, projectTradeId: trade.value, gps }); load(); }) }, 'Clock in'));
}
function clockedInCard(home) {
  const o = home.open; const t = h('div', { class: 'timer' }); const err = h('div');
  const tick = () => { const s = Math.max(0, Math.floor((Date.now() - new Date(o.since)) / 1000)); t.textContent = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':'); };
  tick(); const iv = setInterval(() => (t.isConnected ? tick() : clearInterval(iv)), 1000);
  const out = () => {
    const proj = home.projects.find((p) => p.id === o.projectId); const lines = h('div'); const split = h('input', { type: 'checkbox' }); const box = h('div', { style: 'display:none' });
    const addLine = () => { const sel = h('select', {}, (proj?.trades || []).map((x) => h('option', { value: x.id }, x.name))), amt = num('', { placeholder: 'Hours' }); const row = h('div', { class: 'trade-row' }, sel, amt, h('button', { class: 'small', type: 'button', onclick: () => row.remove() }, 'Remove')); row._get = () => ({ projectTradeId: sel.value, hours: amt.value }); lines.append(row); };
    split.onchange = () => { box.style.display = split.checked ? 'block' : 'none'; if (split.checked && !lines.children.length) { addLine(); addLine(); } };
    box.append(lines, h('button', { class: 'small', type: 'button', onclick: addLine }, '+ Another trade'));
    const inj = h('input', { type: 'checkbox' }), injNote = h('input', { placeholder: 'What happened?' }), notes = h('textarea', { rows: 2, placeholder: 'Anything the office should know' });
    formModal('Clock out', [field(`All hours go to ${o.trade || 'the project'}`, h('label', { style: 'text-transform:none;letter-spacing:0;font-size:15px;font-weight:400' }, split, ' Split my hours across trades'), 'wide'), field('', box, 'wide'),
      field('', h('label', { style: 'text-transform:none;letter-spacing:0;font-size:15px;font-weight:400' }, inj, ' I was injured today'), 'wide'), field('If injured', injNote, 'wide'), field('Notes', notes, 'wide')],
    async () => { const ls = split.checked ? [...lines.children].map((r) => r._get()) : undefined; await api('POST', '/clock/out', { lines: ls, injured: inj.checked, injuryNote: injNote.value, notes: notes.value }); load(); }, 'Clock out');
  };
  return h('div', { class: 'card' }, h('h2', {}, 'You are clocked in'), h('p', { class: 'muted' }, `${o.project} · ${o.trade || 'No trade'}`), t, err, h('button', { class: 'primary bigbtn', onclick: out }, 'Clock out'));
}
function manualCard(home) {
  return h('button', { onclick: () => {
    const proj = h('select', {}, home.projects.map((p) => h('option', { value: p.id }, p.name))); const trade = h('select'); const fill = () => { const p = home.projects.find((x) => x.id === proj.value); trade.replaceChildren(...(p ? p.trades.map((t) => h('option', { value: t.id }, t.name)) : [])); }; proj.onchange = fill; fill();
    const date = h('input', { type: 'date', value: todayStr(), max: todayStr() }), hours = num('', { max: '16' }), notes = h('input');
    formModal('Add time I forgot to clock', [field('Date', date), field('Project', proj), field('Trade', trade), field('Hours', hours), field('Notes', notes, 'wide')], async () => { await api('POST', '/clock/manual', { date: date.value, projectId: proj.value, projectTradeId: trade.value, hours: hours.value, notes: notes.value }); load(); }, 'Add time');
  } }, 'Forgot to clock? Add time');
}
async function homeView() {
  const home = await api('GET', '/clock/home'); if (!home) return loginView();
  const w = home.weekTotals;
  return frame(h('h1', {}, `Hi, ${home.employee.name.split(' ')[0]}`), home.open ? clockedInCard(home) : clockInCard(home),
    h('div', { class: 'card' }, h('h2', {}, 'This week'), h('div', { class: 'grid kpis' }, h('div', { class: 'kpi' }, h('div', { class: 'l' }, 'Hours'), h('div', { class: 'v' }, hrs(w.hours))), h('div', { class: 'kpi' }, h('div', { class: 'l' }, 'Overtime'), h('div', { class: 'v' }, hrs(w.overtime)))),
      home.week.length ? h('table', { style: 'margin-top:.8rem' }, h('tbody', {}, home.week.map((e) => h('tr', {}, h('td', {}, e.date), h('td', {}, e.project), h('td', { class: 'n' }, e.status === 'open' ? 'open' : hrs(e.hours))))) ) : h('p', { class: 'muted' }, 'No time yet this week.')),
    home.open ? '' : manualCard(home));
}
async function load() { try { $app.replaceChildren(state.employee ? await homeView() : await homeOrLogin()); } catch (e) { $app.replaceChildren(frame(h('div', { class: 'err' }, e.message))); } }
async function homeOrLogin() { const home = await api('GET', '/clock/home'); if (home) { state.employee = home.employee; return homeView(); } return loginView(); }
load();
