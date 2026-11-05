// Field time clock. Same look and same form components as the office app (ui.js).
import { h, notice, guard, field } from '/ui.js';
import { makeClockUi } from '/clockui.js';
const $app = document.getElementById('app');
const state = { employee: null, home: null };
async function api(method, path, body) {
  const res = await fetch('/api' + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path === '/clock/home') { state.employee = null; return null; }
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}
const frame = (...kids) => h('div', {}, h('header', { class: 'top' }, h('img', { class: 'logo', src: '/logo.png', alt: 'ByOther Construction' }), h('nav'), h('a', { href: '/', style: 'font-size:13px;margin-right:.8rem' }, 'Office Platform'), state.employee ? h('button', { class: 'small', onclick: async () => { await api('POST', '/logout', {}); state.employee = null; load(); } }, 'Sign out') : ''), h('div', { class: 'clockwrap' }, kids));

async function loginView() {
  const roster = await api('GET', '/clock/roster'); const err = h('div');
  const who = h('select', {}, h('option', { value: '' }, 'Choose your name…'), roster.map((e) => h('option', { value: e.id }, e.name)));
  const pin = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', placeholder: 'PIN', maxlength: 8 });
  const tabBar = h('div', { class: 'tabs' }, [['clock', 'Clock'], ['week', 'My Week']].map(([k, l]) => h('a', { class: ui.getTab() === k ? 'on' : '', href: '#', onclick: (e) => { e.preventDefault(); ui.setTab(k); load(); } }, l)));
  return frame(h('h1', {}, 'Time Clock'), tabBar, ui.getTab() === 'week' ? h('p', { class: 'sub' }, 'Please select a name and enter your PIN to proceed.') : h('p', { class: 'sub' }, 'Select your name and enter your PIN to clock in and see your week.'), h('form', { class: 'card', onsubmit: guard(err, async (e) => { e.preventDefault(); const r = await api('POST', '/clock/login', { employeeId: who.value, pin: pin.value }); state.employee = r.employee; load(); }) },
    field('Name', who), h('div', { style: 'margin-top:.8rem' }, field('PIN', pin)), err, h('button', { class: 'primary bigbtn', style: 'margin-top:1rem', type: 'submit' }, 'Sign in')),
    roster.length ? '' : h('p', { class: 'muted' }, 'No employees are set up yet. The office adds them in Admin > Lists.'));
}

const ui = makeClockUi({ api, base: '/clock', reload: () => load() });
async function homeView() {
  const home = await api('GET', '/clock/home'); if (!home) return loginView();
  return frame(h('h1', {}, `Hi, ${home.employee.name.split(' ')[0]}`), ...ui.body(home));
}
async function load() { try { $app.replaceChildren(state.employee ? await homeView() : await homeOrLogin()); } catch (e) { $app.replaceChildren(frame(h('div', { class: 'err' }, e.message))); } }
async function homeOrLogin() { const home = await api('GET', '/clock/home'); if (home) { state.employee = home.employee; return homeView(); } return loginView(); }
load();
