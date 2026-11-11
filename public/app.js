// by Other Desk Platform front end. All data is inserted with textContent (never innerHTML).
import { h, usd, pct, cls, notice, guard, oneAtATime, folderError, modal, formModal, field, todayStr, num } from '/ui.js';
import * as estimating from '/estimating.js';
import { addressBlock } from '/address.js';
import { pickFromSharePoint } from '/spPicker.js';
import { makeClockUi } from '/clockui.js';
import * as dashboardUi from '/dashboard.js';
const $app = document.getElementById('app');
const state = { user: null, trades: [], gcs: [] };
const MANAGERS = ['Super Admin', 'Sub Admin', 'Exec Assistant'];
const isManager = () => MANAGERS.includes(state.user?.role);
const isSuper = () => state.user?.role === 'Super Admin';


async function api(method, path, body) {
  const res = await fetch('/api' + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') { state.user = null; render(); throw new Error('Please sign in again.'); }
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

// ------------------------------------------------------------------ shell
function shell(active, content) {
  const areas = state.user.areas || [], has = (a) => areas.includes(a), nav = [['dashboard', 'Dashboard']];
  if (has('estimating')) nav.push(['estimating', 'Estimating']); if (has('projects') || has('costs')) nav.push(['projects', 'Projects']); nav.push(['messages', 'Messages']); if (has('reports')) nav.push(['reports', 'Reports']);
  if (has('billing')) nav.push(['quickbooks', 'QuickBooks']); if (has('compliance')) nav.push(['compliance', 'Compliance']);
  if (has('projects') && isManager()) nav.push(['timepay', 'Time & Pay']);
  if (state.user.clock) nav.push(['timeclock', 'Time Clock']);
  if (isSuper() || state.user.role === 'Sub Admin' || has('lists')) nav.push(['admin', 'Admin']);
  return h('div', {},
    h('header', { class: 'top' },
      h('a', { href: '#/dashboard' }, h('img', { class: 'logo', src: '/logo.png', alt: 'ByOther Construction' })),
      h('nav', {}, nav.map(([id, label]) => h('a', { href: '#/' + id, class: active === id ? 'on' : '' }, label, id === 'messages' ? h('span', { class: 'bubble', id: 'msg-bubble', style: 'display:none' }) : ''))),
      h('button', { class: 'small', id: 'bell', onclick: openNotifications, title: 'Notifications' }, 'Alerts'),
      h('span', { class: 'who' }, `${state.user.name || state.user.email} · ${state.user.role}`),
      h('button', { class: 'small', onclick: changePasswordForm, title: 'Change your password' }, 'Password'),
      h('button', { class: 'small', onclick: async () => { await api('POST', '/logout', {}); state.user = null; render(); } }, 'Sign out')),
    h('main', {}, content));
}

function changePasswordForm() {
  const cur = h('input', { type: 'password', autocomplete: 'current-password' }), n1 = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'At least 10 characters' }), n2 = h('input', { type: 'password', autocomplete: 'new-password' });
  formModal('Change your password', [field('Current password', cur), field('New password', n1), field('Type the new password again', n2)], async () => {
    if (n1.value !== n2.value) throw new Error('The two new passwords do not match.');
    await api('POST', '/me/password', { current: cur.value, next: n1.value }); alert('Your password was changed. Any other devices signed in as you were signed out.');
  }, 'Change password');
}
function forgotForm(prefill) {
  const email = h('input', { type: 'email', value: prefill || '', autocomplete: 'username' });
  formModal('Forgot your password?', [h('p', { class: 'muted' }, 'Enter your company email. If it belongs to an account, we email a link to choose a new password. The link works once and expires in 60 minutes.'), field('Company email', email)], async () => {
    const r = await api('POST', '/password/forgot', { email: email.value }); alert(r.message);
  }, 'Email me a link');
}
function resetView(token) {
  const err = h('div'), n1 = h('input', { type: 'password', autocomplete: 'new-password', required: true, placeholder: 'At least 10 characters' }), n2 = h('input', { type: 'password', autocomplete: 'new-password', required: true }), who = h('p', { class: 'muted' }, 'Checking your link…');
  api('GET', '/password/reset/' + encodeURIComponent(token)).then((r) => { who.textContent = 'Choose a new password for ' + r.email + '.'; }).catch((e) => { who.replaceChildren(); notice(err, e.message); });
  const done = () => { history.replaceState(null, '', '/'); render(); };
  return h('div', { class: 'login' }, h('form', { onsubmit: guard(err, async (e) => { e.preventDefault(); if (n1.value !== n2.value) throw new Error('The two passwords do not match.'); await api('POST', '/password/reset', { token, password: n1.value }); alert('Password changed. Sign in with the new one.'); done(); }) },
    h('img', { src: '/logo.png', alt: 'ByOther Construction' }), h('div', { class: 'card' }, who, h('div', {}, h('label', {}, 'New password'), n1), h('div', { style: 'margin-top:.8rem' }, h('label', {}, 'Type it again'), n2), err,
      h('button', { class: 'primary', style: 'width:100%;margin-top:.8rem', type: 'submit' }, 'Save new password'), h('button', { type: 'button', class: 'small', style: 'margin-top:.6rem', onclick: done }, 'Back to sign in'))));
}
let loginMsg = null, chose = false;
// The first screen: pick the platform (office) or the time clock (field crews, PIN). A link to a page, a reset link or a sign-in message goes straight to the form.
function chooserView() {
  const tile = (title, text, props) => h(props.href ? 'a' : 'button', { ...props, class: 'tile' }, h('strong', {}, title), h('span', { class: 'muted' }, text));
  return h('div', { class: 'login' }, h('img', { src: '/logo.png', alt: 'ByOther Construction' }), h('p', { style: 'text-align:center;font-size:1.25rem;font-weight:300;color:var(--navy);margin:.4rem 0 1rem' }, 'by Other Desk Platform'),
    h('div', { class: 'card' }, h('p', { class: 'muted', style: 'margin-top:0;text-align:center' }, 'Where to?'),
      tile('Office Platform', 'Estimating, projects, billing and reports. Sign in with Google or a password.', { onclick: () => { chose = true; render(); } }),
      tile('Time Clock', 'Clock in and out of a job with your name and PIN.', { href: '/clock' })));
}
function loginView() {
  const direct = chose || loginMsg || new URLSearchParams(location.search).has('login_error') || new URLSearchParams(location.search).has('reset') || (location.hash.length > 2 && location.hash !== '#/dashboard');
  if (!direct) return chooserView();
  const resetToken = new URLSearchParams(location.search).get('reset'); if (resetToken) return resetView(resetToken);
  const err = h('div'); const email = h('input', { type: 'email', autocomplete: 'username', required: true }); const pw = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const form = h('form', { onsubmit: guard(err, async (e) => { e.preventDefault(); const r = await api('POST', '/login', { email: email.value, password: pw.value }); state.user = r.user; location.hash = '#/dashboard'; await boot(); }) },
    h('img', { src: '/logo.png', alt: 'ByOther Construction' }), h('p', { style: 'text-align:center;font-size:1.25rem;font-weight:300;color:var(--navy);margin:.4rem 0 1rem' }, 'by Other Desk Platform'), h('div', { class: 'card' },
      h('div', {}, h('label', {}, 'Company email'), email), h('div', { style: 'margin-top:.8rem' }, h('label', {}, 'Password'), pw), err,
      h('button', { class: 'primary', style: 'width:100%;margin-top:.8rem', type: 'submit' }, 'Sign in'),
      h('button', { type: 'button', class: 'small', style: 'margin-top:.6rem', onclick: () => forgotForm(email.value) }, 'Forgot password?')));
  const why = new URLSearchParams(location.search).get('login_error'); if (why) { loginMsg = why; history.replaceState(null, '', '/'); }   // the page is drawn twice at start, so the message is kept
  if (loginMsg) notice(err, loginMsg);
  api('GET', '/auth/options').then((o) => { if (o.google) form.querySelector('.card').append(h('div', { style: 'margin-top:1rem;border-top:1px solid var(--line);padding-top:.9rem' }, h('a', { class: 'gbtn', href: '/api/auth/google/start' }, 'Sign in with Google'), h('p', { class: 'muted', style: 'font-size:12px;text-align:center;margin:.5rem 0 0' }, `Use your @${o.domain} account.`))); }).catch(() => {});
  return h('div', { class: 'login' }, form);
}

// ------------------------------------------------------------------ dashboard
// The dashboard lives in /dashboard.js (widget grid, sizes, detail levels, Edit mode).
async function dashboardView() { return dashboardUi.dashboardView(); }

// ------------------------------------------------------------------ projects
// Projects and Receipts & Supplier Invoices live together: costs belong to projects.
const projectsTabs = (active) => h('div', { class: 'tabs' }, state.user.areas?.includes('projects') ? h('a', { class: active === 'projects' ? 'on' : '', href: '#/projects' }, 'Projects') : '', state.user.areas?.includes('costs') ? h('a', { class: active === 'receipts' ? 'on' : '', href: '#/projects/receipts' }, 'Receipts & Supplier Invoices') : '');
let projectsYear = null, projectsInactive = false, projectsFind = '';
async function projectsView() {
  const d = await api('GET', '/projects/home' + (projectsYear ? '?year=' + projectsYear : '')); projectsYear = d.year;
  const canAdd = isManager(), err = h('div'), sm = d.summary, money0 = (n) => usd(n).replace(/\.00$/, '');
  const tile = (label, value, note, tone = '') => h('div', { class: 'kpi ' + tone }, h('div', { class: 'l' }, label), h('div', { class: 'v' }, value), note ? h('div', { class: 'muted', style: 'font-size:12px' }, note) : '');
  const yearSel = h('select', { onchange: () => { projectsYear = Number(yearSel.value); render(); } }, d.years.map((y) => h('option', { value: y }, y))); yearSel.value = d.year;
  const summary = h('div', { class: 'grid kpis', style: 'margin-bottom:1rem' },
    tile(`Active In ${d.year}`, sm.active, `${sm.inactive} inactive`), tile('Active Contract Value', money0(sm.contractActive), `${money0(sm.billedActive)} billed`),
    tile('Owed To Us Now', money0(sm.dueNowActive), 'billed to GCs, not yet paid', sm.dueNowActive > 0 ? 'warn' : ''), tile('Projected Profit', money0(sm.profitActive), 'active projects', sm.profitActive < 0 ? 'bad' : 'good'),
    tile('Notices To Owner', `${sm.ntoNeeded} needed`, sm.ntoOverdue ? `${sm.ntoOverdue} overdue · ${sm.ntoSent} sent` : `${sm.ntoSent} sent`, sm.ntoOverdue ? 'bad' : ''));
  // alerts and deadlines: the serious ones first; the rest open on request
  let showAll = false; const alertBox = h('div'), dot = { high: '#c0392b', medium: '#d68910', info: '#8a8fa3' };
  const drawAlerts = () => { const list = showAll ? d.alerts : d.alerts.slice(0, 6); alertBox.replaceChildren(list.length ? h('div', {}, list.map((a) => h('div', { style: 'display:flex;gap:.6rem;align-items:baseline;padding:.3rem 0;border-bottom:1px solid var(--line)' }, h('span', { style: `width:.6rem;height:.6rem;border-radius:50%;background:${dot[a.severity]};flex:none;position:relative;top:1px`, title: a.severity }), h('div', { style: 'flex:1;min-width:0' }, h('a', { href: a.link }, a.title), h('div', { class: 'muted', style: 'font-size:13px' }, a.detail))))) : h('p', { class: 'muted' }, 'Nothing needs attention right now.'),
    d.alerts.length > 6 ? h('button', { class: 'small', style: 'margin-top:.5rem', onclick: () => { showAll = !showAll; drawAlerts(); } }, showAll ? 'Show Fewer' : `Show All ${d.alertCount}`) : ''); };
  drawAlerts();
  // the editable list
  const find = h('input', { type: 'search', placeholder: 'Find a project…', value: projectsFind, style: 'max-width:15rem', oninput: () => { projectsFind = find.value; draw(); } });
  const inactiveBox = h('input', { type: 'checkbox', onchange: () => { projectsInactive = inactiveBox.checked; draw(); } }); inactiveBox.checked = projectsInactive;
  const ntoCell = (r) => {
    if (!r.nto) return h('td', {}, '—'); const cell = h('td', { style: 'white-space:normal;min-width:11rem' });
    const send = (body) => guard(err, async () => { await api('PUT', `/projects/${r.id}/nto`, body); render(); });
    const sel = h('select', { disabled: canAdd ? null : true, onchange: () => { if (sel.value === 'Sent') { const dt = h('input', { type: 'date', value: todayStr() }); cell.replaceChildren(h('div', { class: 'row', style: 'gap:.3rem' }, dt, h('button', { class: 'small primary', onclick: send({ status: 'Sent', sentDate: dt.value }) }, 'Save'), h('button', { class: 'small', onclick: () => render() }, 'Cancel'))); } else send({ status: sel.value })(); } }, ['Needed', 'Sent', 'Not Required'].map((x) => h('option', { value: x }, x))); sel.value = r.nto.status;
    cell.append(sel, r.nto.status === 'Sent' && r.nto.sentDate ? h('div', { class: 'muted', style: 'font-size:12px' }, 'Sent ' + String(r.nto.sentDate).slice(0, 10)) : '', r.nto.status === 'Needed' && r.nto.due ? h('div', { class: r.nto.overdue ? 'neg' : 'muted', style: 'font-size:12px' }, r.nto.overdue ? `Overdue (was due ${r.nto.due})` : `Due ${r.nto.due} (${r.nto.daysLeft} days)`) : '', r.nto.status === 'Needed' && !r.nto.due ? h('div', { class: 'muted', style: 'font-size:12px' }, 'Due 45 days after work starts') : '');
    return cell;
  };
  const table = h('div', { class: 'scroll' }), count = h('span', { class: 'muted' });
  const codeOf = (r) => r.refCode || (r.proposalId ? 'C' + String(r.proposalId).slice(1) : '');   // a project carries its contract code (C), the lead's proposal code (P) is history
  function draw() {
    const t = projectsFind.trim().toLowerCase(); const rows = d.rows.filter((r) => (projectsInactive || r.active) && (!t || [r.name, r.gc, r.client, r.address, r.proposalId, r.refCode].some((v) => String(v || '').toLowerCase().includes(t))));
    count.textContent = `${rows.length} shown`;
    table.replaceChildren(rows.length ? h('table', {}, h('thead', {}, h('tr', {}, [['Project', ''], ['Start', 'lo2'], ['Notice To Owner', '']].map(([x, c]) => h('th', { class: c }, x)), [['Contract', ''], ['Billed', 'lo2'], ['Owed To Us', '']].map(([x, c]) => h('th', { class: 'n ' + c }, x)), h('th', {}, 'Active'))),
      h('tbody', {}, rows.map((r) => h('tr', { class: r.active ? '' : 'muted' },
        h('td', { style: 'white-space:normal;min-width:14rem' }, h('a', { href: '#/projects/' + r.id }, r.name), codeOf(r) ? h('div', { class: 'muted', style: 'font-size:12px' }, codeOf(r)) : '', r.gc ? h('div', { class: 'muted', style: 'font-size:13px' }, r.gc) : '', r.address ? h('div', { class: 'muted', style: 'font-size:13px' }, r.address) : ''),
        h('td', { class: 'lo2' }, canAdd ? h('input', { type: 'date', value: r.startDate || '', style: 'width:9.5rem', onchange: (e) => guard(err, async () => { await api('PUT', `/projects/${r.id}`, { startDate: e.target.value || null }); render(); })() }) : (r.startDate || '—')),
        ntoCell(r), h('td', { class: 'n' }, usd(r.contract)), h('td', { class: 'n lo2' }, usd(r.billed)), h('td', { class: 'n' }, usd(r.currentlyDue)),
        h('td', {}, h('input', { type: 'checkbox', checked: r.active, disabled: canAdd ? null : true, title: r.active ? 'Active: untick to close the project' : 'Inactive: tick to reopen', onchange: (e) => { const on = e.target.checked; if (!on && !confirm(`Mark ${r.name} inactive? It leaves the active list; nothing is deleted.`)) { e.target.checked = true; return; } guard(err, async () => { await api('PUT', `/projects/${r.id}`, { active: on }); render(); })(); } }))))))
      : h('p', { class: 'muted' }, projectsInactive ? 'No projects match.' : 'No active projects match.'));
  }
  draw();
  return shell('projects', [h('div', { class: 'row spread' }, h('h1', {}, 'Projects'), h('div', { class: 'row', style: 'gap:.6rem' }, h('label', { style: 'margin:0' }, 'Year'), yearSel, canAdd && h('button', { class: 'primary', onclick: newProjectModal }, '+ New project'))), projectsTabs('projects'), summary,
    h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', {}, `Alerts & Deadlines${d.alertCount ? ` (${d.alertCount})` : ''}`)), alertBox),
    h('div', { class: 'card' }, h('div', { class: 'row spread', style: 'flex-wrap:wrap;gap:.6rem' }, h('h2', {}, 'Projects'), h('div', { class: 'row', style: 'gap:.8rem;flex-wrap:wrap' }, find, h('label', { style: 'display:flex;gap:.35rem;align-items:center;margin:0;text-transform:none;letter-spacing:0;font-weight:400;font-size:14px' }, inactiveBox, 'Show Inactive'), count)), err, table)]);
}


// Edit a project's name, client, retainage and address (the same checked address box as everywhere else).
function editProjectForm(pr) {
  const f = { name: h('input', { value: pr.name }), client: h('input', { value: pr.client }), ret: h('input', { type: 'number', min: '0', max: '100', step: '0.5', value: pr.retainagePct }) };
  const addr = addressBlock(api, { kind: 'project', init: pr.addr, label: 'Project address (Florida)' });
  formModal(`Edit ${pr.name}`, [field('Project name', f.name), field('Client', f.client), field('GC retainage %', f.ret), h('div', { class: 'wide' }, addr.head, addr.el)],
    async () => { await api('PUT', `/projects/${pr.id}`, { name: f.name.value, client: f.client.value, retainagePct: f.ret.value, ...addr.payload() }); render(); }, 'Save');
}
async function newProjectModal() {
  const err = h('div'), note = h('div');
  const f = { name: h('input'), gc: h('select', {}, h('option', { value: '' }, 'Choose GC…'), state.gcs.filter((g) => !g.archived).map((g) => h('option', { value: g.id }, g.name))), client: h('input'), ret: h('input', { type: 'number', value: '10', min: '0', max: '100', step: '0.5' }) };
  const addr = addressBlock(api, { kind: 'project', init: null, label: 'Project address (Florida)' });
  const tradeRows = h('div'); const addRow = (tradeId = '', amount = '', hint = '') => {
    const sel = h('select', { class: tradeId || !hint ? '' : 'needs' }, h('option', { value: '' }, 'Trade…'), state.trades.filter((t) => !t.archived).map((t) => h('option', { value: t.id }, t.name)));
    const amt = h('input', { type: 'number', min: '0', step: '0.01', placeholder: 'Contract amount', value: amount });
    sel.value = tradeId; const row = h('div', { class: 'trade-row' }, sel, amt, hint ? h('span', { class: 'muted', style: 'font-size:12px;align-self:center' }, hint) : '', h('button', { class: 'small', type: 'button', onclick: () => row.remove() }, 'Remove')); row._get = () => ({ tradeId: sel.value, amount: amt.value }); tradeRows.append(row);
  };
  addRow();
  // Start from a document: the AI reads a proposal or signed contract and fills this form in. Nothing is saved until Create.
  let doc = null;   // { file } for an upload from this computer, or { itemId, name } for a SharePoint file; kind is Proposal / Contract / Work order
  const docBox = h('div'), pick = h('input', { type: 'file', accept: '.pdf,.png,.jpg,.jpeg', style: 'display:none' });
  const drawDoc = () => docBox.replaceChildren(doc ? h('div', { class: 'row', style: 'gap:.5rem' }, h('span', {}, '📄 ' + doc.name), h('span', { class: 'muted' }, `(kept as the project's ${doc.kind.toLowerCase()} file)`), h('button', { type: 'button', class: 'small', onclick: () => { doc = null; drawDoc(); } }, 'Remove')) : '');
  const fill = (d, source) => {
    doc = { ...source, kind: ['Proposal', 'Contract', 'Work order'].includes(d.documentType) ? d.documentType : 'Contract' }; drawDoc();
    if (d.name) f.name.value = d.name; if (d.gcId) f.gc.value = d.gcId; if (d.client) f.client.value = d.client; if (d.retainagePct != null) f.ret.value = d.retainagePct;
    addr.set(d.addr && d.addr.street ? { ...d.addr, verified: false } : null); if (d.addr?.street && d.addr?.city) addr.verifyNow?.();
    tradeRows.replaceChildren(); (d.lines.length ? d.lines : [{}]).forEach((l) => addRow(l.tradeId || '', l.amount ?? '', l.tradeId ? '' : (l.description || '').slice(0, 40))); if (!d.lines.length) addRow();
    notice(note, ''); if (d.warnings?.length) note.replaceChildren(h('div', { class: 'err' }, h('ul', { style: 'margin:0;padding-left:1.1rem' }, d.warnings.map((w) => h('li', {}, w)))));
    else note.replaceChildren(h('div', { class: 'ok' }, 'Read from the document. Check every field, then create the project.'));
  };
  pick.onchange = guard(note, async () => { const file = pick.files[0]; pick.value = ''; if (!file) return; notice(note, 'Reading the document with AI. This can take a minute…', 'ok'); const d = await uploadFile('/projects/draft', file); fill(d, { file, name: file.name }); });
  const spBtn = h('button', { type: 'button', class: 'small', style: 'display:none', onclick: guard(note, async () => { const it = await pickFromSharePoint(api); if (!it) return; notice(note, 'Reading the document with AI. This can take a minute…', 'ok'); const d = await api('POST', '/projects/draft-sharepoint', { itemId: it.id }); fill(d, { itemId: it.id, name: it.name }); }) }, 'Choose From SharePoint');
  api('GET', '/sharepoint/status').then((s) => { if (s.configured) spBtn.style.display = ''; }).catch(() => {});
  const bg = modal('New project', h('form', { onsubmit: guard(err, async (e) => {
    e.preventDefault();
    const trades = [...tradeRows.children].map((r) => r._get()).filter((t) => t.tradeId || t.amount);
    const r = await api('POST', '/projects', { name: f.name.value, gcId: f.gc.value, client: f.client.value, addr: (() => { if (!addr.ok()) throw new Error('Enter the project address and press "Verify address" (green check) first.'); return addr.get(); })(), retainagePct: f.ret.value, trades });
    let kept = '';
    if (doc) { try { if (doc.file) await uploadFile(`/projects/${r.id}/contract-file?kind=${encodeURIComponent(doc.kind)}`, doc.file); else await api('POST', `/projects/${r.id}/contract-file-sharepoint`, { itemId: doc.itemId, kind: doc.kind }); } catch (x) { kept = x.message; } }
    bg.remove(); location.hash = '#/projects/' + r.id; if (kept) setTimeout(() => alert('The project was created, but the document could not be kept: ' + kept + ' Add it on the Contract tab.'), 300);
  }) }, h('div', { class: 'card', style: 'background:var(--navy-soft);margin-bottom:.8rem' }, h('label', {}, 'Start From A Document (Optional)'), h('div', { class: 'row', style: 'flex-wrap:wrap;gap:.5rem' }, pick, h('button', { type: 'button', class: 'small', onclick: () => pick.click() }, 'Upload Proposal Or Signed Contract'), spBtn),
    h('p', { class: 'muted', style: 'font-size:13px;margin:.3rem 0 0' }, 'AI fills in the name, GC, client, address, retainage and each trade with its amount. You check everything before anything is saved, and the document is kept as the project\'s contract file. Or skip this and type it all in.'), docBox, note),
    h('div', { class: 'form' },
    h('div', {}, h('label', {}, 'Project name'), f.name), h('div', {}, h('label', {}, 'GC'), f.gc), h('div', {}, h('label', {}, 'Client'), f.client), h('div', { class: 'wide' }, addr.head, addr.el),
    h('div', {}, h('label', {}, 'GC retainage %'), f.ret),
    h('div', { class: 'wide' }, h('label', {}, 'Trades and contract amounts'), tradeRows, h('button', { type: 'button', class: 'small', onclick: () => addRow() }, '+ Add trade'))),
    err, h('div', { class: 'row', style: 'margin-top:1rem;justify-content:flex-end' }, h('button', { class: 'primary', type: 'submit' }, 'Create project'))));
}

const TABS = [['trades', 'Trade Overview'], ['contract', 'Contract'], ['cos', 'Change Orders'], ['billing', 'Progress Billing'], ['costs', 'Costs & Payables'], ['labor', 'Labor'], ['docs', 'Documents'], ['origin', 'Bid History']];
async function projectView(id, tab = 'trades') {
  const p = await api('GET', '/projects/' + id);
  const canEdit = isManager();
  const reload = () => render();
  let content;
  if (tab === 'trades') content = tradeOverview(p, canEdit, reload);
  else if (tab === 'contract') content = await contractTab(p, canEdit, reload);
  else if (tab === 'cos') content = changeOrders(p, reload);
  else if (tab === 'billing') content = await billingTab(p, canEdit, reload);
  else if (tab === 'costs') content = await costsTab(p, canEdit, reload);
  else if (tab === 'labor') content = await laborTab(p, canEdit, reload);
  else if (tab === 'docs') content = await docsTab(p, canEdit, reload);
  else if (tab === 'origin') content = await estimating.originCard(id);
  else content = h('div', { class: 'card soon' }, h('h2', {}, TABS.find((t) => t[0] === tab)[1]), h('p', {}, 'Coming in the next build step.'));
  return shell('projects', [
    h('p', {}, h('a', { href: '#/projects' }, '← All projects'), canEdit ? [' ', h('button', { class: 'small', onclick: () => editProjectForm(p.project) }, 'Edit Project')] : ''),
    h('h1', {}, p.project.name, p.project.refCode ? h('span', { class: 'pill Approved', style: 'margin-left:.7rem;font-size:14px', title: 'Contract reference code: use it on every document' }, p.project.refCode) : ''), p.project.folderUrl || canEdit ? h('div', { style: 'margin:.2rem 0 .5rem' }, estimating.folderButtons({ id: p.project.id, name: p.project.name, folderUrl: p.project.folderUrl, spPath: p.project.spPath }, canEdit, 'project', true)) : '', h('p', { class: 'muted' }, `${p.project.gc} · ${p.project.client} · ${p.project.address}`, p.project.contractUrl ? [' · ', h('a', { href: p.project.contractUrl, target: '_blank', rel: 'noopener' }, 'Contract')] : ''),
    h('div', { class: 'grid kpis', style: 'margin-bottom:1rem' },
      h('div', { class: 'kpi' }, h('div', { class: 'l' }, 'Original contract + COs'), h('div', { class: 'v' }, usd(p.totals.contract))),
      h('div', { class: 'kpi' }, h('div', { class: 'l' }, 'Billed'), h('div', { class: 'v' }, usd(p.totals.billed))),
      h('div', { class: 'kpi warn' }, h('div', { class: 'l' }, 'Owed To Us Now'), h('div', { class: 'v' }, usd(p.totals.currentlyDue)), h('div', { class: 'muted', style: 'font-size:12px' }, 'billed, not yet paid')),
      h('div', { class: 'kpi ' + (p.totals.projectedProfit < 0 ? 'bad' : 'good') }, h('div', { class: 'l' }, 'Projected profit'), h('div', { class: 'v' }, usd(p.totals.projectedProfit)))),
    h('div', { class: 'tabs' }, TABS.map(([t, label]) => h('a', { class: t === tab ? 'on' : '', href: `#/projects/${id}/${t}` }, label))),
    content]);
}

// ------------------------------------------------------------------ contract / work order
async function contractTab(p, canEdit, reload) {
  const c = await api('GET', `/projects/${p.project.id}/contract`); const err = h('div'); const pid = p.project.id;
  const kind = h('select', {}, ['Contract', 'Work order'].map((k) => h('option', { value: k }, k))), file = h('input', { type: 'file', accept: '.pdf,.png,.jpg,.jpeg', style: 'display:none' });
  file.onchange = guard(err, async () => { const f = file.files[0]; if (!f) return; notice(err, 'Reading the document with AI. This can take a minute…', 'ok'); const r = await uploadFile(`/projects/${pid}/contract?kind=${encodeURIComponent(kind.value)}`, f); if (r.error) throw new Error('Saved, but not read: ' + r.error); reload(); });
  const dollars = (v) => (v == null ? '—' : usd(v));
  const cf = (await api('GET', `/projects/${pid}/contract-file`)).file, swap = h('input', { type: 'file', accept: '.pdf,.png,.jpg,.jpeg', style: 'display:none' });
  swap.onchange = guard(err, async () => { const f = swap.files[0]; swap.value = ''; if (!f) return; if (cf && !confirm(`Replace ${cf.name} with ${f.name}?`)) return; await uploadFile(`/projects/${pid}/contract-file?kind=Contract`, f); reload(); });
  const fileRow = h('div', { class: 'row', style: 'gap:.6rem;margin:.2rem 0 .6rem;flex-wrap:wrap' }, h('b', {}, 'Contract file: '), cf ? h('a', { href: cf.url, target: '_blank', rel: 'noopener' }, cf.name) : h('span', { class: 'muted' }, 'none kept yet'), cf?.spUrl ? h('a', { href: cf.spUrl, target: '_blank', rel: 'noopener', class: 'muted' }, '(in SharePoint)') : '',
    canEdit ? [swap, h('button', { class: 'small', onclick: () => swap.click() }, cf ? 'Replace File' : 'Add File'), cf ? h('button', { class: 'small danger', onclick: guard(err, async () => { if (confirm(`Remove ${cf.name}? The file is deleted from the platform. A copy already in SharePoint stays there.`)) { await api('DELETE', `/projects/${pid}/contract-file`); reload(); } }) }, 'Remove File') : ''] : '');
  const upload = canEdit ? h('div', { class: 'row' }, kind, file, h('button', { class: 'primary', onclick: () => file.click() }, c.review ? 'Upload a different one' : 'Upload and read'), h('span', { class: 'muted', style: 'font-size:13px' }, 'PDF or photo. The trades and amounts below do not change until you press Apply.')) : '';
  const head = h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', {}, 'Signed contract or work order')), err, fileRow, upload,
    c.applied ? h('p', { class: 'muted', style: 'margin-top:.6rem' }, `Applied: ${c.applied.kind} ${c.applied.contractNumber || ''} ${c.applied.contractDate ? '· dated ' + c.applied.contractDate : ''} · total ${dollars(c.applied.total)} · retainage ${c.applied.retainagePct ?? '—'}%${c.applied.netDays != null ? ' · net ' + c.applied.netDays + ' days' : ''}`, c.applied.documentId ? [' · ', h('a', { href: `/api/documents/${c.applied.documentId}/file`, target: '_blank', rel: 'noopener' }, 'Open the file')] : '')
      : h('p', { class: 'muted', style: 'margin-top:.6rem' }, c.review ? 'Not applied yet. Until it is, the trade figures from the proposal stay in use.' : 'No contract uploaded yet. The trade figures from the winning proposal are in use until a signed contract or work order is applied.'),
    c.applied?.paymentTerms ? h('p', { style: 'margin:.3rem 0 0' }, h('b', {}, 'Payment terms: '), c.applied.paymentTerms) : '');
  const parts = [head];
  if (c.review) {
    const r = c.review, rerr = h('div');
    const hd = { no: h('input', { value: r.contractNumber ?? '' }), date: h('input', { type: 'date', value: r.contractDate ?? '' }), total: num(r.total ?? ''), ret: num(r.retainagePct ?? ''), net: h('input', { type: 'number', min: '0', max: '365', step: '1', value: r.netDays ?? '' }), terms: h('textarea', { rows: 2 }, r.paymentTerms ?? '') };
    const doHead = guard(rerr, async () => { await api('PUT', `/contract-runs/${r.id}`, { contractNumber: hd.no.value, contractDate: hd.date.value, total: hd.total.value, retainagePct: hd.ret.value, netDays: hd.net.value, paymentTerms: hd.terms.value }); notice(rerr, 'Saved.', 'ok'); });
    const tradeSel = (l) => { const s = h('select', { disabled: !canEdit ? true : null, class: l.tradeId ? '' : 'needs' }, h('option', { value: '' }, 'Choose trade…'), c.trades.map((t) => h('option', { value: t.id }, t.name))); s.value = l.tradeId || ''; s.onchange = guard(rerr, async () => { await api('PUT', `/contract-lines/${l.id}`, { tradeId: s.value }); reload(); }); return s; };
    const lineRow = (l) => { const d = h('input', { value: l.description, style: 'width:100%;min-width:18rem' }), a = h('input', { type: 'number', step: '0.01', min: '0', value: l.amount ?? '', class: l.amount == null ? 'needs' : '', style: 'width:9rem' }), inc = h('input', { type: 'checkbox' }); inc.checked = l.include;
      d.onchange = guard(rerr, async () => { await api('PUT', `/contract-lines/${l.id}`, { description: d.value }); }); a.onchange = guard(rerr, async () => { await api('PUT', `/contract-lines/${l.id}`, { amount: a.value }); reload(); }); inc.onchange = guard(rerr, async () => { await api('PUT', `/contract-lines/${l.id}`, { include: inc.checked }); reload(); });
      return h('tr', { class: l.include ? '' : 'muted' }, h('td', {}, inc), h('td', {}, d), h('td', {}, tradeSel(l)), h('td', { class: 'n' }, a), canEdit && h('td', {}, h('button', { class: 'small danger', onclick: guard(rerr, async () => { await api('DELETE', `/contract-lines/${l.id}`); reload(); }) }, 'Remove'))); };
    const addLine = guard(rerr, async () => { await api('POST', `/contract-runs/${r.id}/lines`, { description: 'New line' }); reload(); });
    const cmp = r.compare, stateLabel = { new: 'New trade', same: 'Same as proposal', changed: 'Changed' };
    parts.push(h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', {}, `Review: ${r.kind} read by AI`), h('span', { class: 'muted', style: 'font-size:13px' }, `${r.by || ''} · ${new Date(r.createdAt).toLocaleString()}`)), rerr,
      (r.warnings || []).length ? h('div', { class: 'err' }, h('ul', { style: 'margin:0;padding-left:1.1rem' }, r.warnings.map((w) => h('li', {}, w)))) : '',
      h('div', { class: 'form' }, field('Contract / PO number', hd.no), field('Dated', hd.date), field('Total price', hd.total), field('Retainage %', hd.ret), field('Payment due (net days)', hd.net), field('Payment terms', hd.terms, 'wide')),
      canEdit && h('div', { class: 'row', style: 'margin:.5rem 0' }, h('button', { class: 'small', onclick: doHead }, 'Save these details')),
      h('h3', { style: 'margin:1rem 0 .3rem' }, 'Scope lines'), h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Use'), h('th', {}, 'Line as written'), h('th', {}, 'Trade'), h('th', { class: 'n' }, 'Price'), h('th'))), h('tbody', {}, r.lines.map(lineRow)))),
      canEdit && h('div', { class: 'row', style: 'margin-top:.5rem' }, h('button', { class: 'small', onclick: addLine }, '+ Add a line')),
      h('h3', { style: 'margin:1rem 0 .3rem' }, 'Compared with the proposal figures now on the project'),
      h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Trade'), h('th', { class: 'n' }, 'On project now'), h('th', { class: 'n' }, 'This contract'), h('th', {}, ''))), h('tbody', {}, cmp.rows.map((x) => h('tr', {}, h('td', {}, x.name), h('td', { class: 'n' }, dollars(x.current)), h('td', { class: 'n' }, usd(x.contract)), h('td', {}, h('span', { class: 'pill ' + (x.state === 'same' ? 'Approved' : x.state === 'new' ? 'Pending' : 'Expiring') }, stateLabel[x.state])))), cmp.notInContract.map((x) => h('tr', { class: 'muted' }, h('td', {}, x.name), h('td', { class: 'n' }, usd(x.original)), h('td', { class: 'n' }, '—'), h('td', {}, 'Not on this contract: kept as is')))),
        h('tfoot', {}, h('tr', { class: 'total' }, h('td', {}, 'Contract lines included'), h('td'), h('td', { class: 'n' }, usd(cmp.total)), h('td'))))),
      canEdit && h('div', { class: 'row', style: 'margin-top:1rem' }, h('button', { class: 'primary', onclick: guard(rerr, async () => { if (!confirm('Apply this contract? The project trades and amounts, and the retainage, will be set from it.')) return; const a = await api('POST', `/contract-runs/${r.id}/apply`, {}); alert(`Applied. ${a.created} trade${a.created === 1 ? '' : 's'} added, ${a.changed} changed, contract total ${usd(a.total)}.${a.notInContract.length ? ' Not on the contract and left as they were: ' + a.notInContract.join(', ') + '.' : ''}`); reload(); }) }, 'Apply to project'), h('button', { onclick: guard(rerr, async () => { if (confirm('Discard this reading? The uploaded file stays in Documents.')) { await api('DELETE', `/contract-runs/${r.id}`); reload(); } }) }, 'Discard'))));
  }
  // tentative invoice schedule (from the applied contract, or the one under review)
  const rows = c.review ? c.review.schedule : c.schedule, serr = h('div');
  if (rows.length || canEdit) parts.push(h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', {}, 'Tentative invoice schedule'), canEdit && h('button', { class: 'small', onclick: () => { const f = { label: h('input'), amount: num(''), date: h('input', { type: 'date' }) }; formModal('Add a billing line', [field('What is being billed', f.label), field('Amount', f.amount), field('Expected date', f.date)], async () => { await api('POST', `/projects/${pid}/invoice-schedule`, { label: f.label.value, amount: f.amount.value, expectedDate: f.date.value }); reload(); }, 'Add'); } }, '+ Add line')), serr,
    h('p', { class: 'muted', style: 'margin-top:0' }, c.review ? 'Drafted from the contract under review. It becomes the schedule when you apply it.' : 'What the contract says will be billed. Invoices are matched to these lines later; nothing is invoiced from here.'),
    rows.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['What', 'Basis', '%', 'Amount', 'Expected', 'Status'].map((t, i) => h('th', { class: i === 2 || i === 3 ? 'n' : '' }, t)), h('th'))),
      h('tbody', {}, rows.map((s) => { const amt = h('input', { type: 'number', step: '0.01', min: '0', value: s.amount ?? '', placeholder: 'by progress', style: 'width:9rem', disabled: s.status === 'Invoiced' || !canEdit ? true : null }), dt = h('input', { type: 'date', value: s.expectedDate ?? '', disabled: s.status === 'Invoiced' || !canEdit ? true : null });
        amt.onchange = guard(serr, async () => { await api('PUT', `/invoice-schedule/${s.id}`, { amount: amt.value }); reload(); }); dt.onchange = guard(serr, async () => { await api('PUT', `/invoice-schedule/${s.id}`, { expectedDate: dt.value }); reload(); });
        return h('tr', { class: s.status === 'Skipped' ? 'muted' : '' }, h('td', {}, s.label, s.note ? h('div', { class: 'muted', style: 'font-size:12px' }, s.note) : ''), h('td', {}, s.basis || ''), h('td', { class: 'n' }, s.percent != null ? s.percent + '%' : ''), h('td', { class: 'n' }, amt), h('td', {}, dt), h('td', {}, h('span', { class: 'pill ' + (s.status === 'Invoiced' ? 'Approved' : s.status === 'Skipped' ? '' : 'Pending') }, s.status === 'Invoiced' && s.invoiceNumber ? 'Invoiced #' + s.invoiceNumber : s.status)),
          canEdit && s.status !== 'Invoiced' && h('td', {}, h('button', { class: 'small', onclick: guard(serr, async () => { await api('PUT', `/invoice-schedule/${s.id}`, { status: s.status === 'Skipped' ? 'Tentative' : 'Skipped' }); reload(); }) }, s.status === 'Skipped' ? 'Restore' : 'Skip'), ' ', h('button', { class: 'small danger', onclick: guard(serr, async () => { await api('DELETE', `/invoice-schedule/${s.id}`); reload(); }) }, 'Remove'))); })))) : h('p', { class: 'muted' }, 'No billing lines yet. Upload and apply a contract to draft them.')));
  return h('div', {}, ...parts);
}

function tradeOverview(p, canEdit, reload) {
  const err = h('div');
  const th = (t, n, extra = '') => h('th', { class: (n ? 'n ' : '') + extra }, t);
  const editAmount = (t) => h('span', { class: canEdit ? 'edit' : '', title: canEdit ? 'Click to edit' : '', onclick: canEdit ? guard(err, async () => {
    const v = prompt(`Original contract amount for ${t.name}`, t.original); if (v === null) return;
    await api('PUT', `/projects/${p.project.id}/trades/${t.id}`, { amount: v }); reload();
  }) : null }, usd(t.original));
  const sum = (k) => Math.round(p.trades.reduce((n, t) => n + Math.round(t[k] * 100), 0)) / 100;
  const used = new Set(p.trades.map((t) => t.tradeId));
  const avail = state.trades.filter((t) => !t.archived && !used.has(t.id));
  const sel = h('select', {}, h('option', { value: '' }, 'Add trade…'), avail.map((t) => h('option', { value: t.id }, t.name))); const amt = h('input', { type: 'number', min: '0', step: '0.01', placeholder: 'Contract amount' });
  return h('div', { class: 'card' }, h('h2', {}, 'Trade performance'), err,
    h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, th('Trade'), th('Original Contract', 1), th('Approved COs', 1, 'lo'), th('Contract Total', 1), th('Billed', 1, 'lo3'), th('Retainage', 1, 'lo2'), th('Received', 1, 'lo3'), th('Owed To Us Now', 1), th('Actual Cost', 1, 'lo3'), th('Projected Profit', 1), canEdit && th(''))),
      h('tbody', {}, p.trades.map((t) => h('tr', {}, h('td', {}, t.name), h('td', { class: 'n' }, editAmount(t)), h('td', { class: 'n lo' }, usd(t.approvedCOs)), h('td', { class: 'n' }, usd(t.contract)), h('td', { class: 'n lo3' }, usd(t.billed)), h('td', { class: 'n lo2' }, usd(t.retainageOutstanding)), h('td', { class: 'n lo3' }, usd(t.received)), h('td', { class: 'n' }, usd(t.currentlyDue)), h('td', { class: 'n lo3' }, usd(t.actualCost)), h('td', { class: 'n ' + cls(t.projectedProfit) }, usd(t.projectedProfit)),
        canEdit && h('td', {}, h('button', { class: 'small danger', onclick: guard(err, async () => { if (confirm(`Remove ${t.name} from this project?`)) { await api('DELETE', `/projects/${p.project.id}/trades/${t.id}`); reload(); } }) }, 'Remove'))))),
      h('tfoot', {}, h('tr', { class: 'total' }, h('td', {}, 'Project'), h('td', { class: 'n' }, usd(sum('original'))), h('td', { class: 'n lo' }, usd(sum('approvedCOs'))), h('td', { class: 'n' }, usd(p.totals.contract)), h('td', { class: 'n lo3' }, usd(p.totals.billed)), h('td', { class: 'n lo2' }, usd(p.totals.retainageOutstanding)), h('td', { class: 'n lo3' }, usd(p.totals.received)), h('td', { class: 'n' }, usd(p.totals.currentlyDue)), h('td', { class: 'n lo3' }, usd(p.totals.actualCost)), h('td', { class: 'n ' + cls(p.totals.projectedProfit) }, usd(p.totals.projectedProfit)), canEdit && h('td'))))),
    canEdit && avail.length ? h('div', { class: 'row', style: 'margin-top:1rem' }, sel, amt, h('button', { onclick: guard(err, async () => { await api('POST', `/projects/${p.project.id}/trades`, { tradeId: sel.value, amount: amt.value }); reload(); }) }, 'Add')) : '',
    h('p', { class: 'muted', style: 'margin-top:.8rem' }, 'Projected profit = contract minus actual cost minus unbilled subcontract commitments. Only approved change orders change the contract.'));
}

function changeOrders(p, reload) {
  const err = h('div');
  const tradeOpts = () => p.trades.map((t) => h('option', { value: t.id }, t.name));
  const form = (co) => {
    const f = { number: h('input', { value: co?.number ?? '' }), desc: h('input', { value: co?.description ?? '' }), trade: h('select', {}, tradeOpts()), status: h('select', {}, ['Pending', 'Approved', 'Rejected'].map((s) => h('option', { value: s }, s))), date: h('input', { type: 'date', value: co?.approvedDate ?? '' }), amount: h('input', { type: 'number', step: '0.01', value: co?.amount ?? '' }) };
    if (co) { f.trade.value = co.projectTradeId; f.status.value = co.status; }
    return f;
  };
  const edit = (co) => {
    const f = form(co); const e2 = h('div');
    const bg = modal(co ? `Edit ${co.number}` : 'Add change order', h('form', { onsubmit: guard(e2, async (ev) => {
      ev.preventDefault();
      const body = { number: f.number.value, description: f.desc.value, projectTradeId: f.trade.value, status: f.status.value, approvedDate: f.date.value || null, amount: f.amount.value };
      await api(co ? 'PUT' : 'POST', `/projects/${p.project.id}/change-orders${co ? '/' + co.id : ''}`, body); bg.remove(); reload();
    }) }, h('div', { class: 'form' }, h('div', {}, h('label', {}, 'CO #'), f.number), h('div', {}, h('label', {}, 'Trade'), f.trade), h('div', { class: 'wide' }, h('label', {}, 'Description'), f.desc),
      h('div', {}, h('label', {}, 'Status'), f.status), h('div', {}, h('label', {}, 'Approved date'), f.date), h('div', {}, h('label', {}, 'Revenue change'), f.amount)), e2,
      h('div', { class: 'row', style: 'margin-top:1rem;justify-content:flex-end' }, h('button', { class: 'primary', type: 'submit' }, 'Save'))));
  };
  // From a document: AI reads the change order, a person checks it, then each trade gets its own change order.
  const fromDoc = () => {
    const pid = p.project.id, note = h('div'), body = h('div'), pick = h('input', { type: 'file', accept: '.pdf,.png,.jpg,.jpeg', style: 'display:none' }); let draft = null, added = false;
    const allTrades = state.trades.filter((t) => !t.archived), onProject = new Set(p.trades.map((t) => t.tradeId));
    const bg = modal('Change order from a document', h('div', { style: 'min-width:min(46rem,90vw)' }, h('div', { class: 'row', style: 'flex-wrap:wrap;gap:.5rem' }, pick, h('button', { type: 'button', class: 'small', onclick: () => pick.click() }, 'Upload Change Order PDF'), spBtn()), h('p', { class: 'muted', style: 'font-size:13px' }, 'AI reads it; you check it; then the amounts are added to the trades. The file is kept on the project.'), note, body));
    const discard = () => { if (draft && !added) api('DELETE', `/projects/${pid}/change-orders/draft/${draft.documentId}`).catch(() => {}); };
    new MutationObserver((_, ob) => { if (!document.body.contains(bg)) { ob.disconnect(); discard(); } }).observe(document.body, { childList: true });
    function spBtn() { const b = h('button', { type: 'button', class: 'small', style: 'display:none', onclick: guard(note, async () => { const it = await pickFromSharePoint(api, { title: 'Choose a change order from SharePoint' }); if (!it) return; read(() => api('POST', `/projects/${pid}/change-orders/read-sharepoint`, { itemId: it.id })); }) }, 'Choose From SharePoint'); api('GET', '/sharepoint/status').then((s) => { if (s.configured) b.style.display = ''; }).catch(() => {}); return b; }
    const read = async (get) => { discard(); notice(note, 'Reading the change order with AI. This can take a minute…', 'ok'); try { draft = await get(); } catch (e) { notice(note, e.message); return; } notice(note, ''); show(); };
    pick.onchange = () => { const f = pick.files[0]; pick.value = ''; if (f) read(() => uploadFile(`/projects/${pid}/change-orders/read`, f)); };
    function show() {
      const d = draft, e2 = h('div'); const f = { no: h('input', { value: d.number }), status: h('select', {}, ['Pending', 'Approved', 'Rejected'].map((x) => h('option', { value: x }, x))), date: h('input', { type: 'date', value: d.approvedDate || '' }), desc: h('input', { value: d.description || '' }) }; f.status.value = d.status;
      const rows = h('tbody'); const lineRow = (l) => {
        const sel = h('select', { class: l.tradeId ? '' : 'needs' }, h('option', { value: '' }, 'Choose trade…'), allTrades.map((t) => h('option', { value: t.id }, t.name))); sel.value = l.tradeId || '';
        const amt = h('input', { type: 'number', step: '0.01', value: l.amount ?? '', class: l.amount == null ? 'needs' : '', style: 'width:9rem' }), ds = h('input', { value: l.description || '', style: 'width:100%;min-width:14rem' });
        const hint = h('span', { class: 'muted', style: 'font-size:12px' }), upd = () => { hint.textContent = sel.value && !onProject.has(sel.value) ? 'new on this project' : ''; sel.classList.toggle('needs', !sel.value); }; sel.onchange = upd; upd();
        const tr = h('tr', {}, h('td', {}, ds), h('td', {}, sel, ' ', hint), h('td', { class: 'n' }, amt), h('td', {}, h('button', { type: 'button', class: 'small', onclick: () => tr.remove() }, 'Remove'))); tr._get = () => ({ tradeId: sel.value, description: ds.value, amount: amt.value }); rows.append(tr);
      };
      (d.lines.length ? d.lines : [{}]).forEach(lineRow);
      body.replaceChildren(h('p', { class: 'muted', style: 'margin:.3rem 0' }, `File kept: ${d.fileName}`),
        d.error ? h('div', { class: 'err' }, d.error) : '', d.warnings?.length ? h('div', { class: 'err' }, h('ul', { style: 'margin:0;padding-left:1.1rem' }, d.warnings.map((w) => h('li', {}, w)))) : '',
        h('div', { class: 'form' }, field('CO #', f.no), field('Status', f.status), field('Approved date', f.date), field('What changed', f.desc, 'wide')),
        h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Line'), h('th', {}, 'Trade'), h('th', { class: 'n' }, 'Revenue change'), h('th'))), rows)),
        h('button', { type: 'button', class: 'small', onclick: () => lineRow({}) }, '+ Add line'), e2,
        h('div', { class: 'row', style: 'margin-top:1rem;justify-content:flex-end' }, h('button', { type: 'button', class: 'primary', onclick: guard(e2, async () => {
          const lines = [...rows.children].map((r) => r._get()).filter((l) => l.tradeId || l.amount);
          await api('POST', `/projects/${pid}/change-orders/from-document`, { documentId: d.documentId, number: f.no.value, status: f.status.value, approvedDate: f.date.value || null, description: f.desc.value, lines }); added = true; bg.remove(); reload();
        }) }, 'Add To Trades')));
    }
  };
  const fileCell = (c) => { const pick = h('input', { type: 'file', accept: '.pdf,.png,.jpg,.jpeg', style: 'display:none', onchange: guard(err, async () => { const f = pick.files[0]; pick.value = ''; if (!f) return; await uploadFile(`/projects/${p.project.id}/change-orders/${c.id}/file`, f); reload(); }) });
    return h('td', { style: 'white-space:normal' }, c.documentId ? h('a', { href: `/api/documents/${c.documentId}/file`, target: '_blank', rel: 'noopener' }, c.documentName) : h('span', { class: 'muted' }, '—'), ' ', pick, h('button', { class: 'small', onclick: () => pick.click() }, c.documentId ? 'Replace' : 'Add File'),
      c.documentId ? [' ', h('button', { class: 'small danger', onclick: guard(err, async () => { if (confirm(`Remove ${c.documentName} from ${c.number}?`)) { await api('DELETE', `/projects/${p.project.id}/change-orders/${c.id}/file`); reload(); } }) }, 'Remove')] : ''); };
  return h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', {}, 'Change orders'), h('div', { class: 'row', style: 'gap:.5rem' }, h('button', { onclick: fromDoc }, 'From A Document'), h('button', { class: 'primary', onclick: () => edit(null) }, '+ Add change order'))), err,
    p.changeOrders.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['CO #', 'Description', 'Trade', 'Approved date', 'Status'].map((t) => h('th', {}, t)), h('th', { class: 'n' }, 'Revenue change'), h('th', {}, 'File'), h('th'))),
      h('tbody', {}, p.changeOrders.map((c) => h('tr', {}, h('td', {}, c.number), h('td', { style: 'white-space:normal' }, c.description), h('td', {}, c.trade), h('td', {}, c.approvedDate || '—'), h('td', {}, h('span', { class: 'pill ' + c.status }, c.status)), h('td', { class: 'n ' + cls(c.amount) }, usd(c.amount)), fileCell(c),
        h('td', {}, h('button', { class: 'small', onclick: () => edit(c) }, 'Edit'), ' ', h('button', { class: 'small danger', onclick: guard(err, async () => { if (confirm(`Delete ${c.number}?`)) { await api('DELETE', `/projects/${p.project.id}/change-orders/${c.id}`); reload(); } }) }, 'Delete'))))),
      h('tfoot', {}, h('tr', { class: 'total' }, h('td', { colspan: 5 }, 'Approved total (updates Trade Overview)'), h('td', { class: 'n' }, usd(p.coTotals.approved)), h('td'), h('td')), h('tr', {}, h('td', { colspan: 5, class: 'muted' }, 'Pending (not yet in contract)'), h('td', { class: 'n muted' }, usd(p.coTotals.pending)), h('td'), h('td'))))) : h('p', { class: 'muted' }, 'No change orders yet.'));
}


// ------------------------------------------------------------------ shared bits for billing and costs
const tradeSelect = (p, { project = false, value = '' } = {}) => { const s = h('select', {}, project ? h('option', { value: '' }, 'Project-level (no trade)') : '', p.trades.map((t) => h('option', { value: t.id }, t.name))); if (value) s.value = value; return s; };
const SVGNS = 'http://www.w3.org/2000/svg';
function pie(slices) {
  const total = slices.reduce((n, s) => n + Math.max(0, s.value), 0);
  const svg = document.createElementNS(SVGNS, 'svg'); svg.setAttribute('viewBox', '-1 -1 2 2'); svg.setAttribute('width', '190'); svg.setAttribute('height', '190'); svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Contract breakdown: ' + slices.map((s) => `${s.label} ${usd(s.value)}`).join(', '));
  if (total <= 0) { const c = document.createElementNS(SVGNS, 'circle'); c.setAttribute('r', '1'); c.setAttribute('fill', '#e2e8f0'); svg.append(c); return svg; }
  let a = -Math.PI / 2;
  for (const s of slices.filter((x) => x.value > 0)) {
    const f = s.value / total, b = a + f * 2 * Math.PI;
    if (f >= 0.9999) { const c = document.createElementNS(SVGNS, 'circle'); c.setAttribute('r', '1'); c.setAttribute('fill', s.color); svg.append(c); break; }
    const path = document.createElementNS(SVGNS, 'path');
    path.setAttribute('d', `M0 0 L${Math.cos(a)} ${Math.sin(a)} A1 1 0 ${f > 0.5 ? 1 : 0} 1 ${Math.cos(b)} ${Math.sin(b)} Z`); path.setAttribute('fill', s.color);
    const t = document.createElementNS(SVGNS, 'title'); t.textContent = `${s.label}: ${usd(s.value)} (${(f * 100).toFixed(1)}%)`; path.append(t); svg.append(path); a = b;
  }
  return svg;
}
const legend = (slices) => h('div', {}, slices.map((s) => h('div', { class: 'row', style: 'gap:.5rem;margin:.25rem 0' }, h('span', { style: `width:12px;height:12px;border-radius:3px;background:${s.color};display:inline-block` }), h('span', {}, s.label), h('strong', { style: 'margin-left:auto;padding-left:1.5rem' }, usd(s.value)))));

// ------------------------------------------------------------------ progress billing
// The whole job on one screen, like the owner's spreadsheet: each trade's original contract, the approved change orders and the new total on the left,
// then one column per invoice with the amount billed to each trade, colored by whether it has been paid. Totals run along the bottom and to the right.
function billingMatrix(p, inv, canEdit, openInvoice) {
  const today = todayStr(), cents = (n) => Math.round(Number(n || 0) * 100), money2 = (c) => usd(c / 100);
  const baseNo = (c) => { const suffix = ` - ${c.trade}`; return c.number.endsWith(suffix) ? c.number.slice(0, -suffix.length) : c.number; };
  const cos = new Map(); for (const c of p.changeOrders.filter((x) => x.status === 'Approved')) { const k = baseNo(c); const g = cos.get(k) || { no: k, date: c.approvedDate, desc: c.description, byTrade: new Map() }; g.byTrade.set(c.projectTradeId, (g.byTrade.get(c.projectTradeId) || 0) + cents(c.amount)); cos.set(k, g); }
  const coCols = [...cos.values()].sort((a, b) => a.no.localeCompare(b.no, undefined, { numeric: true }));
  const status = (i) => { const net = cents(i.amount) - cents(i.retainageHeld), paid = i.payments.filter((x) => x.kind === 'Payment').reduce((n, x) => n + cents(x.amount), 0); return { net, paid, st: net <= 0 || paid >= net ? 'Paid' : paid > 0 ? 'Partial' : i.dueDate && i.dueDate < today ? 'Overdue' : 'Unpaid' }; };
  const groups = new Map(); for (const i of inv) { const k = `${i.number}|${i.date}`; const g = groups.get(k) || { no: i.number, date: i.date, rows: [] }; g.rows.push(i); groups.set(k, g); }
  const cols = [...groups.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.no.localeCompare(b.no, undefined, { numeric: true }));
  for (const g of cols) { const sts = g.rows.map(status); g.owed = sts.reduce((n, x) => n + Math.max(0, x.net - x.paid), 0); g.total = g.rows.reduce((n, r) => n + cents(r.amount), 0); g.st = sts.every((x) => x.st === 'Paid') ? 'Paid' : sts.some((x) => x.st === 'Overdue') ? 'Overdue' : sts.some((x) => x.st === 'Partial' || x.st === 'Paid') ? 'Partial' : 'Unpaid'; }
  const mon = (d) => new Date(String(d).slice(0, 10) + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
  const tradeRow = (t) => { const tr = [h('td', { class: 'bm-name' }, t.name), h('td', { class: 'n' }, usd(t.original))];
    for (const c of coCols) { const v = c.byTrade.get(t.id); tr.push(h('td', { class: 'n' }, v ? money2(v) : '')); }
    tr.push(h('td', { class: 'n bm-tot' }, usd(t.contract)), h('td', { class: 'bm-gap' }));
    for (const g of cols) { const r = g.rows.find((x) => x.projectTradeId === t.id); if (!r) { tr.push(h('td', { class: 'n' })); continue; } const s2 = status(r);
      tr.push(h('td', { class: `n bm-${s2.st.toLowerCase()}${canEdit ? ' bm-click' : ''}`, title: `${s2.st}: invoiced ${usd(r.amount)}, retainage held ${usd(r.retainageHeld)}, payments received ${money2(s2.paid)}${r.dueDate ? ', due ' + r.dueDate : ''}`, onclick: canEdit ? () => openInvoice(r) : null }, usd(r.amount))); }
    tr.push(h('td', { class: 'bm-gap' }), h('td', { class: 'n bm-tot' }, usd(t.billed)), h('td', { class: 'n lo2' }, usd(t.retainageOutstanding)), h('td', { class: 'n lo2' }, usd(t.received)), h('td', { class: 'n lo3' }, usd(t.unbilled)), h('td', { class: 'n bm-owed' }, usd(t.currentlyDue)));
    return h('tr', {}, tr); };
  const T = p.totals, coSum = (c) => [...c.byTrade.values()].reduce((n, v) => n + v, 0);
  const totalRow = h('tr', { class: 'total' }, h('td', { class: 'bm-name' }, 'Project'), h('td', { class: 'n' }, usd(p.trades.reduce((n, t) => n + t.original, 0))), ...coCols.map((c) => h('td', { class: 'n' }, money2(coSum(c)))), h('td', { class: 'n bm-tot' }, usd(T.contract)), h('td', { class: 'bm-gap' }),
    ...cols.map((g) => h('td', { class: 'n' }, money2(g.total))), h('td', { class: 'bm-gap' }), h('td', { class: 'n bm-tot' }, usd(T.billed)), h('td', { class: 'n lo2' }, usd(T.retainageOutstanding)), h('td', { class: 'n lo2' }, usd(T.received)), h('td', { class: 'n lo3' }, usd(T.unbilled)), h('td', { class: 'n bm-owed' }, usd(T.currentlyDue)));
  const statusRow = h('tr', { class: 'bm-status' }, h('td', { class: 'bm-name' }, 'Paid?'), h('td'), ...coCols.map(() => h('td')), h('td'), h('td', { class: 'bm-gap' }), ...cols.map((g) => h('td', { class: 'n' }, h('span', { class: `bm-pill bm-${g.st.toLowerCase()}` }, g.st === 'Paid' ? 'Paid' : g.st === 'Partial' ? `Owed ${money2(g.owed)}` : g.st === 'Overdue' ? `Overdue ${money2(g.owed)}` : `Unpaid ${money2(g.owed)}`))), h('td', { class: 'bm-gap' }), h('td'), h('td', { class: 'lo2' }), h('td', { class: 'lo2' }), h('td', { class: 'lo3' }), h('td', { class: 'n bm-owed' }, usd(T.currentlyDue)));
  const head = h('thead', {}, h('tr', {}, h('th', { class: 'bm-name' }, 'Trade'), h('th', { class: 'n' }, 'Original Contract'), ...coCols.map((c) => h('th', { class: 'n', title: `${c.desc || ''}${c.date ? ' · approved ' + c.date : ''}` }, c.no)), h('th', { class: 'n' }, 'Contract Total'), h('th', { class: 'bm-gap' }),
    ...cols.map((g) => h('th', { class: 'n' }, h('div', {}, g.date ? mon(g.date) : ''), h('div', { class: 'bm-inv' }, '#' + g.no))), h('th', { class: 'bm-gap' }), h('th', { class: 'n' }, 'Billed To Date'), h('th', { class: 'n lo2' }, 'Retainage Held'), h('th', { class: 'n lo2' }, 'Received'), h('th', { class: 'n lo3' }, 'Left To Invoice'), h('th', { class: 'n' }, 'Owed To Us Now')));
  const legend = h('div', { class: 'row', style: 'gap:.9rem;flex-wrap:wrap;font-size:13px;margin:.2rem 0 .6rem' }, [['paid', 'Paid'], ['partial', 'Partly Paid'], ['unpaid', 'Unpaid, Not Due Yet'], ['overdue', 'Unpaid, Past Due']].map(([k, l]) => h('span', {}, h('span', { class: `bm-swatch bm-${k}` }), ' ' + l)));
  return h('div', { class: 'card' }, h('h2', {}, 'Billing Matrix'), h('p', { class: 'muted', style: 'margin:0 0 .3rem;font-size:13px' }, `Each trade's contract with approved change orders, then every invoice and what was billed to each trade.${canEdit ? ' Click an amount to open that invoice.' : ''} "Owed To Us Now" is billed, minus retainage held, minus payments received.`), legend,
    p.trades.length ? h('div', { class: 'scroll bm-wrap' }, h('table', { class: 'bm' }, head, h('tbody', {}, p.trades.map(tradeRow)), h('tfoot', {}, totalRow, statusRow))) : h('p', { class: 'muted' }, 'No trades on this project yet.'));
}
async function billingTab(p, canEdit, reload) {
  const inv = await api('GET', `/projects/${p.project.id}/billing`); const err = h('div'); const base = `/projects/${p.project.id}`;
  const T = p.totals;
  const slices = [{ label: 'Received', value: T.received, color: '#15803d' }, { label: 'Owed to us now', value: T.currentlyDue, color: '#b45309' }, { label: 'Retainage held', value: T.retainageOutstanding, color: '#6366f1' }, { label: 'Unbilled', value: Math.max(0, T.unbilled), color: '#cbd5e1' }];
  const th = (t, n) => h('th', { class: n ? 'n' : '' }, t);
  const sov = h('div', { class: 'card' }, h('h2', {}, 'Schedule of values'), h('div', { class: 'scroll' }, h('table', {},
    h('thead', {}, h('tr', {}, th('Trade'), th('Contract (orig + COs)', 1), th('Billed to date', 1), th('% billed', 1), th('Retainage held', 1), th('Received', 1), th('Owed To Us Now', 1), th('Balance to finish', 1))),
    h('tbody', {}, p.trades.map((t) => h('tr', {}, h('td', {}, t.name), h('td', { class: 'n' }, usd(t.contract)), h('td', { class: 'n' }, usd(t.billed)), h('td', { class: 'n' }, t.contract > 0 ? pct((t.billed / t.contract) * 100) : '—'), h('td', { class: 'n' }, usd(t.retainageOutstanding)), h('td', { class: 'n' }, usd(t.received)), h('td', { class: 'n' }, usd(t.currentlyDue)), h('td', { class: 'n' }, usd(t.unbilled))))),
    h('tfoot', {}, h('tr', { class: 'total' }, h('td', {}, 'Project'), h('td', { class: 'n' }, usd(T.contract)), h('td', { class: 'n' }, usd(T.billed)), h('td', { class: 'n' }, T.contract > 0 ? pct((T.billed / T.contract) * 100) : '—'), h('td', { class: 'n' }, usd(T.retainageOutstanding)), h('td', { class: 'n' }, usd(T.received)), h('td', { class: 'n' }, usd(T.currentlyDue)), h('td', { class: 'n' }, usd(T.unbilled)))))),
    h('div', { class: 'row', style: 'gap:2rem;margin-top:1.2rem;align-items:center' }, pie(slices), h('div', { style: 'min-width:260px' }, h('h2', {}, 'Where the contract stands'), legend(slices))));

  let qbSug = []; if (canEdit) { try { qbSug = await api('GET', `${base}/qb-suggestions`); } catch { /* QuickBooks is not connected, or this person may not match invoices */ } }
  const qbCard = qbSug.length ? h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', {}, `QuickBooks invoices that may belong here (${qbSug.length})`), h('a', { class: 'small', href: '#/quickbooks', style: 'text-decoration:none' }, 'Open the QuickBooks page')),
    h('p', { class: 'muted', style: 'margin-top:0' }, 'Waiting for someone to confirm. Nothing is billed until they are imported.'),
    h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['Invoice', 'Date', 'QuickBooks customer', 'Total', 'Why it matches'].map((t, i) => h('th', { class: i === 3 ? 'n' : '' }, t)))),
      h('tbody', {}, qbSug.map((x) => h('tr', {}, h('td', {}, x.number || ''), h('td', {}, x.date || ''), h('td', {}, x.customer || ''), h('td', { class: 'n' }, usd(x.total)), h('td', {}, x.why || '', x.message ? h('div', { class: 'muted', style: 'font-size:12px' }, x.message) : ''))))))) : '';
  const newInvoice = () => {
    const f = { trade: tradeSelect(p), number: h('input'), date: h('input', { type: 'date', value: todayStr() }), due: h('input', { type: 'date' }), amount: num(), ret: num('', { placeholder: 'Blank = none' }) };
    formModal('New invoice', [field('Trade', f.trade), field('Invoice #', f.number), field('Invoice date', f.date), field('Due date', f.due), field('Invoice amount', f.amount), field('Retainage withheld by GC', f.ret)],
      async () => { await api('POST', `${base}/invoices`, { projectTradeId: f.trade.value, number: f.number.value, date: f.date.value, dueDate: f.due.value || null, amount: f.amount.value, retainageHeld: f.ret.value }); reload(); }, 'Add invoice');
  };
  const editInvoice = (i) => {
    const f = { number: h('input', { value: i.number }), date: h('input', { type: 'date', value: i.date }), due: h('input', { type: 'date', value: i.dueDate || '' }), amount: num(i.amount), ret: num(i.retainageHeld) };
    formModal(`Edit ${i.number}`, [field('Invoice #', f.number), field('Invoice date', f.date), field('Due date', f.due), field('Invoice amount', f.amount), field('Retainage withheld by GC', f.ret)],
      async () => { await api('PUT', `${base}/invoices/${i.id}`, { number: f.number.value, date: f.date.value, dueDate: f.due.value || null, amount: f.amount.value, retainageHeld: f.ret.value }); reload(); });
  };
  const addPayment = (i, kind) => {
    const f = { date: h('input', { type: 'date', value: todayStr() }), amount: num() };
    formModal(kind === 'Payment' ? `Payment received · ${i.number}` : `Retainage released · ${i.number}`, [field('Date', f.date), field(kind === 'Payment' ? 'Amount received' : 'Amount released', f.amount)],
      async () => { await api('POST', `${base}/invoices/${i.id}/payments`, { date: f.date.value, amount: f.amount.value, kind }); reload(); }, 'Record');
  };
  const list = h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', {}, 'Invoices to the GC'), canEdit && h('button', { class: 'primary', onclick: newInvoice }, '+ New invoice')), err,
    inv.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['Invoice', 'Trade', 'Date', 'Due', 'Status'].map((t) => h('th', {}, t)), th('Amount', 1), th('Retainage', 1), th('Collected', 1), th('Outstanding', 1), canEdit && th(''))),
      h('tbody', {}, inv.map((i) => [h('tr', {}, h('td', {}, i.number), h('td', {}, i.trade), h('td', {}, i.date), h('td', {}, i.dueDate || '—'), h('td', {}, h('span', { class: 'pill' }, i.aging)), h('td', { class: 'n' }, usd(i.amount)), h('td', { class: 'n' }, usd(i.retainageOutstanding)), h('td', { class: 'n' }, usd(i.collected)), h('td', { class: 'n' }, usd(i.outstanding)),
        canEdit && h('td', {}, h('button', { class: 'small', onclick: () => addPayment(i, 'Payment') }, '+ Payment'), ' ', i.retainageOutstanding > 0 && h('button', { class: 'small', onclick: () => addPayment(i, 'Retainage Release') }, 'Release retainage'), ' ', h('button', { class: 'small', onclick: () => editInvoice(i) }, 'Edit'), ' ',
          h('button', { class: 'small danger', onclick: guard(err, async () => { if (confirm(`Delete invoice ${i.number} and its payments?`)) { await api('DELETE', `${base}/invoices/${i.id}`); reload(); } }) }, 'Delete'))),
        ...i.payments.map((pm) => h('tr', { class: 'muted' }, h('td', { colspan: 2, style: 'padding-left:1.5rem' }, pm.kind === 'Payment' ? '↳ Payment' : '↳ Retainage released'), h('td', {}, pm.date), h('td', { colspan: 5 }), h('td', { class: 'n' }, usd(pm.amount)),
          canEdit && h('td', {}, h('button', { class: 'small danger', onclick: guard(err, async () => { await api('DELETE', `${base}/invoices/${i.id}/payments/${pm.id}`); reload(); }) }, 'Remove'))))])))) : h('p', { class: 'muted' }, 'No invoices yet.'));
  return h('div', {}, qbCard, billingMatrix(p, inv, canEdit, editInvoice), sov, list);
}

// ------------------------------------------------------------------ costs & payables
async function costsTab(p, canEdit, reload) {
  const c = await api('GET', `/projects/${p.project.id}/costs`); const err = h('div'); const base = `/projects/${p.project.id}`;
  const th = (t, n, extra = '') => h('th', { class: ((n ? 'n ' : '') + extra).trim() }, t);
  const run = (fn) => guard(err, async () => { await fn(); reload(); });
  const toReceipts = state.user.areas?.includes('costs') ? h('p', { style: 'margin:.2rem 0 .8rem' }, h('a', { href: '#/projects/receipts' }, 'Receipts & Supplier Invoices'), h('span', { class: 'muted' }, '  (upload a receipt or invoice and split it across projects and trades)')) : '';

  const addVendor = async () => {
    const subs = (await api('GET', '/admin/subcontractors')).filter((s) => !s.archived);
    const f = { trade: tradeSelect(p, { project: true }), vendor: h('select', {}, h('option', { value: '' }, 'Choose subcontractor…'), subs.map((s) => h('option', { value: s.id }, s.name))), amount: num(), hold: num('', { placeholder: 'e.g. 500 or 1000' }), reason: h('input', { placeholder: 'Inspection, punch list…' }), mat: h('input', { type: 'checkbox' }) };
    formModal('Add subcontractor to this project', [field('Trade', f.trade), field('Subcontractor (from Admin)', f.vendor), field('Subcontract amount', f.amount), field('Final-payment hold', f.hold), field('Hold reason', f.reason), field('Materials included', f.mat)],
      async () => { await api('POST', `${base}/commitments`, { projectTradeId: f.trade.value || null, subcontractorId: f.vendor.value, contractAmount: f.amount.value, holdAmount: f.hold.value, holdReason: f.reason.value, materialsIncluded: f.mat.checked }); reload(); }, 'Add subcontractor');
  };
  const editVendor = (v) => {
    const f = { amount: num(v.contract), hold: num(v.holdAmount), reason: h('input', { value: v.holdReason || '' }) };
    formModal(`Edit ${v.vendor}`, [field('Subcontract amount', f.amount), field('Final-payment hold', f.hold), field('Hold reason', f.reason)],
      async () => { await api('PUT', `${base}/commitments/${v.id}`, { contractAmount: f.amount.value, holdAmount: f.hold.value, holdReason: f.reason.value }); reload(); });
  };
  const addBill = (v) => {
    const f = { number: h('input'), date: h('input', { type: 'date', value: todayStr() }), amount: num('', { placeholder: `Up to ${usd(v.remaining)} remaining` }) };
    formModal(`Bill from ${v.vendor}`, [field('Bill #', f.number), field('Bill date', f.date), field('Amount billed', f.amount)], async () => { await api('POST', `${base}/commitments/${v.id}/bills`, { number: f.number.value, date: f.date.value, amount: f.amount.value }); reload(); }, 'Add bill');
  };
  const payVendor = (v, direct) => {
    const open = v.bills.filter((b) => b.amount - b.paid > 0.001);
    if (!open.length) { notice(err, 'This subcontractor has no unpaid bills.'); return; }
    const f = { bill: h('select', {}, open.map((b) => h('option', { value: b.id }, `${b.number} · ${usd(b.amount - b.paid)} unpaid`))), date: h('input', { type: 'date', value: todayStr() }), amount: num('', { placeholder: `Up to ${usd(v.availableToPay)} available` }) };
    formModal(direct ? `Pay ${v.vendor}` : `Request payment to ${v.vendor}`, [field('Bill', f.bill), direct ? field('Payment date', f.date) : field('Note for the approver', f.date.cloneNode()), field('Amount', f.amount)], async () => { if (direct) await api('POST', `${base}/sub-bills/${f.bill.value}/payments`, { date: f.date.value, amount: f.amount.value }); else await api('POST', `${base}/sub-bills/${f.bill.value}/payment-requests`, { amount: f.amount.value }); reload(); }, direct ? 'Record payment' : 'Send for approval');
  };
  // One block per subcontractor: the summary numbers (invoiced to us, paid, what is owed on invoices, what is not invoiced yet, and the total still owed),
  // then every bill they have sent with its payment status, and the actions.
  const subBlock = (v) => {
    const owedTotal = Math.max(0, Math.round((v.contract - v.paid) * 100) / 100);
    const bills = v.bills.length ? h('table', { class: 'minitable' }, h('thead', {}, h('tr', {}, th('Bill #'), th('Bill Date'), th('Amount', 1), th('Paid', 1), th('Unpaid', 1), canEdit && th(''))),
      h('tbody', {}, v.bills.map((b) => h('tr', {}, h('td', {}, b.number), h('td', {}, b.date || '—'), h('td', { class: 'n' }, usd(b.amount)), h('td', { class: 'n' }, usd(b.paid)), h('td', { class: 'n' }, b.amount - b.paid > 0.001 ? usd(b.amount - b.paid) : h('span', { class: 'pill Valid' }, 'Paid')),
        canEdit && h('td', {}, h('button', { class: 'small danger', onclick: guard(err, async () => { if (confirm(`Delete bill ${b.number} (${usd(b.amount)})?`)) { await api('DELETE', `${base}/commitments/${v.id}/bills/${b.id}`); reload(); } }) }, 'Delete')))))) : h('div', { class: 'muted', style: 'font-size:13px' }, 'No bills from this subcontractor yet.');
    const actions = canEdit ? h('div', { class: 'row', style: 'gap:.4rem;flex-wrap:wrap;margin:.4rem 0' }, h('button', { class: 'small primary', onclick: () => addBill(v) }, '+ Bill'), h('button', { class: 'small', onclick: () => payVendor(v, false) }, 'Request Payment'), ['Super Admin', 'Sub Admin'].includes(state.user.role) && h('button', { class: 'small', onclick: () => payVendor(v, true) }, 'Pay Now'),
      v.holdAmount > 0 && h('button', { class: 'small', onclick: run(() => api('PUT', `${base}/commitments/${v.id}`, { holdReleased: !v.holdReleased })) }, v.holdReleased ? 'Re-hold' : 'Release Hold'), h('button', { class: 'small', onclick: () => editVendor(v) }, 'Edit'),
      h('button', { class: 'small danger', onclick: guard(err, async () => { if (confirm(`Remove ${v.vendor} and all its bills from this project?`)) { await api('DELETE', `${base}/commitments/${v.id}`); reload(); } }) }, 'Remove')) : '';
    return [h('tr', { class: 'sub-main' }, h('td', {}, v.trade || 'Project-level'), h('td', {}, h('strong', {}, v.vendor), v.compliance && v.compliance.canPay === false ? h('span', { class: 'pill Expired', style: 'margin-left:.5rem', title: (v.compliance.reasons || []).join('; ') }, 'Unverified: Cannot Pay') : v.compliance?.status === 'Expiring' ? h('span', { class: 'pill Expiring', style: 'margin-left:.5rem' }, 'Insurance expiring') : '',
        v.contact ? h('div', { class: 'muted', style: 'font-size:12px' }, 'Contact: ' + v.contact + (v.contactPhone ? ' · ' + v.contactPhone : '')) : '', v.holdReason ? h('div', { class: 'muted', style: 'font-size:12px' }, `Hold: ${v.holdReason}${v.holdReleased ? ' (released)' : ''}`) : ''),
      h('td', { class: 'n' }, usd(v.contract)), h('td', { class: 'n' }, usd(v.invoiced)), h('td', { class: 'n' }, usd(v.paid)), h('td', { class: 'n' }, usd(v.balance)), h('td', { class: 'n' }, usd(v.remaining)), h('td', { class: 'n bm-owed' }, usd(owedTotal)), h('td', { class: 'n lo' }, usd(v.held)), h('td', { class: 'n lo2' }, usd(v.availableToPay))),
      h('tr', { class: 'sub-bills' }, h('td'), h('td', { colspan: 9 }, actions, bills))];
  };
  const vendors = h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', {}, '1. Subcontractors'), canEdit && h('button', { class: 'primary', onclick: guard(err, addVendor) }, '+ Add subcontractor')),
    h('p', { class: 'muted', style: 'margin:0 0 .4rem;font-size:13px' }, '"Owed On Invoices" is billed to us and not paid yet. "Not Yet Invoiced" is the rest of their contract. "Total Still Owed" is both together: the contract minus what we have paid.'),
    c.vendors.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, th('Trade'), th('Subcontractor'), th('Subcontract', 1), th('Invoiced To Us', 1), th('Paid', 1), th('Owed On Invoices', 1), th('Not Yet Invoiced', 1), th('Total Still Owed', 1), th('Held', 1, 'lo'), th('Available To Pay', 1, 'lo2'))),
      h('tbody', {}, c.vendors.flatMap(subBlock)),
      h('tfoot', {}, h('tr', { class: 'total' }, h('td', {}, 'All Subcontractors'), h('td'), h('td', { class: 'n' }, usd(c.vendors.reduce((n, v) => n + v.contract, 0))), h('td', { class: 'n' }, usd(c.vendors.reduce((n, v) => n + v.invoiced, 0))), h('td', { class: 'n' }, usd(c.vendors.reduce((n, v) => n + v.paid, 0))), h('td', { class: 'n' }, usd(c.vendors.reduce((n, v) => n + v.balance, 0))), h('td', { class: 'n' }, usd(c.vendors.reduce((n, v) => n + v.remaining, 0))), h('td', { class: 'n bm-owed' }, usd(c.vendors.reduce((n, v) => n + Math.max(0, v.contract - v.paid), 0))), h('td', { class: 'lo' }), h('td', { class: 'lo2' }))))) : h('p', { class: 'muted' }, 'No subcontractors on this project yet. They are created in Admin (with a W-9 and COI or exemption), then added here.'));

  const addSupplier = async () => {
    const sups = (await api('GET', '/admin/suppliers')).filter((s) => !s.archived);
    const lines = h('div'); const addLine = () => { const sel = tradeSelect(p, { project: true }), amt = num('', { placeholder: 'Amount' }); const row = h('div', { class: 'trade-row' }, sel, amt, h('button', { class: 'small', type: 'button', onclick: () => row.remove() }, 'Remove')); row._get = () => ({ projectId: p.project.id, projectTradeId: sel.value || null, amount: amt.value }); lines.append(row); }; addLine();
    const paid = h('input', { type: 'checkbox' }), paidDate = h('input', { type: 'date', value: todayStr() }); paidDate.parentElement; const paidBox = h('div', { style: 'display:none' }, field('Date Paid', paidDate)); paid.onchange = () => { paidBox.style.display = paid.checked ? '' : 'none'; };
    const f = { sup: h('select', {}, h('option', { value: '' }, 'Choose vendor…'), sups.filter((s) => !s.one_time).map((s) => h('option', { value: s.id }, s.name))), newSup: h('input', { placeholder: 'Or type a new vendor' }), ref: h('input'), date: h('input', { type: 'date', value: todayStr() }), total: num(), desc: h('input', { placeholder: 'What was bought (for example: drywall screws and 2 boxes of mud)' }) };
    const keepVendor = vendorKeepChoice(f.sup, f.newSup);
    formModal('Vendor invoice', [field('Vendor (from Admin)', f.sup), field('…or a new vendor', f.newSup), keepVendor.el, field('Invoice #', f.ref), field('Invoice date', f.date), field('Invoice total', f.total), field('Description Of The Purchase', f.desc, 'wide'), h('label', { class: 'wide', style: 'text-transform:none;letter-spacing:0;font-weight:400;display:flex;gap:.5rem;align-items:center' }, paid, 'Already paid (a website purchase or card charge)'), h('div', { class: 'wide' }, paidBox), field('Allocate to trades (must add up to the total)', h('div', {}, lines, h('button', { class: 'small', type: 'button', onclick: addLine }, '+ Split to another trade')), 'wide')],
      async () => { await api('POST', '/supplier-invoices', { supplierId: f.sup.value || undefined, supplierName: f.newSup.value, saveVendor: keepVendor.save(), reference: f.ref.value, description: f.desc.value, paid: paid.checked, paidDate: paidDate.value, date: f.date.value, total: f.total.value, allocations: [...lines.children].map((r) => r._get()) }); reload(); }, 'Add invoice');
  };
  const paySupplier = (s) => {
    const f = { date: h('input', { type: 'date', value: todayStr() }), amount: num('', { placeholder: `Invoice total ${usd(s.invoiceTotal)}` }) };
    formModal(`Pay ${s.supplier} · ${s.reference}`, [field('Payment date', f.date), field('Amount paid (whole invoice)', f.amount)], async () => { await api('POST', `/supplier-invoices/${s.invoiceId}/payments`, { date: f.date.value, amount: f.amount.value }); reload(); }, 'Record payment');
  };
  const suppliers = h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', {}, '2. Vendors (materials, lodging, equipment, purchases)'), canEdit && h('button', { class: 'primary', onclick: guard(err, addSupplier) }, '+ Vendor invoice')),
    c.suppliers.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, th('Trade'), th('Vendor'), th('Invoice'), th('Date'), th('Allocated', 1), th('Paid', 1), th('Balance', 1), canEdit && th(''))),
      h('tbody', {}, c.suppliers.map((s) => h('tr', {}, h('td', {}, s.trade || 'Project-level'), h('td', {}, s.supplier), h('td', { style: 'white-space:normal' }, s.reference, s.description ? h('div', { class: 'muted', style: 'font-size:12px' }, s.description) : ''), h('td', {}, s.date || '—'), h('td', { class: 'n' }, usd(s.amount)), h('td', { class: 'n' }, usd(s.paid)), h('td', { class: 'n' }, usd(s.balance)),
        canEdit && h('td', {}, h('button', { class: 'small', onclick: () => paySupplier(s) }, 'Pay'), ' ', h('button', { class: 'small danger', onclick: guard(err, async () => { if (confirm(`Delete invoice ${s.reference} (all of its allocations, on every project)?`)) { await api('DELETE', `/supplier-invoices/${s.invoiceId}`); reload(); } }) }, 'Delete'))))))) : h('p', { class: 'muted' }, 'No vendor invoices yet.'));

  const labor = h('div', { class: 'card' }, h('h2', {}, '3. Labor (1099 crew, from the time clock)'), h('p', { class: 'muted' }, 'Hours and pay come from the time clock.'),
    c.labor.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, th('Trade'), th('Employee'), th('Hours', 1), th('Pay', 1))), h('tbody', {}, c.labor.map((l) => h('tr', {}, h('td', {}, l.trade || 'Project-level'), h('td', {}, l.employee), h('td', { class: 'n' }, l.hours.toFixed(2)), h('td', { class: 'n' }, l.pay == null ? '—' : usd(l.pay))))))) : h('p', { class: 'muted' }, 'No labor posted yet.'));

  // The whole cost picture by trade, at the top: what subcontractors are owed (their contract minus what we paid, invoiced or not), what vendors are owed
  // (invoices not paid), labor, and the totals.
  const T = p.totals, rd = (n) => Math.round(n * 100) / 100;
  const cols = ['subContract', 'subInvoiced', 'subPaid', 'supplierCost', 'supplierPaid', 'laborCost'];
  const rowsOf = p.trades.map((t) => ({ name: t.name, ...Object.fromEntries(cols.map((k) => [k, t[k] || 0])) }));
  const rest = Object.fromEntries(cols.map((k) => [k, rd((T[k] || 0) - rowsOf.reduce((n, r) => n + r[k], 0))]));   // costs not tied to a trade
  if (cols.some((k) => Math.abs(rest[k]) > 0.004)) rowsOf.push({ name: 'Project-level (no trade)', ...rest });
  const sumRow = (r) => ({ ...r, subOwed: Math.max(0, rd(r.subContract - r.subPaid)), vendOwed: rd(r.supplierCost - r.supplierPaid), committed: rd(r.subContract + r.supplierCost + r.laborCost), owed: rd(Math.max(0, r.subContract - r.subPaid) + (r.supplierCost - r.supplierPaid)) });
  const sumRows = rowsOf.map(sumRow), tot = sumRow(Object.fromEntries([['name', 'Whole Project'], ...cols.map((k) => [k, rd(rowsOf.reduce((n, r) => n + r[k], 0))])]));
  const sc = (r, tag = 'td') => [h(tag, {}, r.name), h(tag, { class: 'n' }, usd(r.subContract)), h(tag, { class: 'n lo' }, usd(r.subInvoiced)), h(tag, { class: 'n lo' }, usd(r.subPaid)), h(tag, { class: 'n bm-owed' }, usd(r.subOwed)), h(tag, { class: 'n' }, usd(r.supplierCost)), h(tag, { class: 'n lo' }, usd(r.supplierPaid)), h(tag, { class: 'n bm-owed' }, usd(r.vendOwed)), h(tag, { class: 'n' }, usd(r.laborCost)), h(tag, { class: 'n bm-tot' }, usd(r.committed)), h(tag, { class: 'n bm-owed' }, usd(r.owed))];
  const tally = h('div', { class: 'card' }, h('h2', {}, 'Cost Summary By Trade'),
    h('p', { class: 'muted', style: 'margin:0 0 .4rem;font-size:13px' }, '"Still Owed" for subcontractors is their whole contract minus what we have paid, whether or not they have invoiced us yet. For vendors it is invoices not paid yet. "Total Cost" counts the full subcontracts, vendor invoices and labor.'),
    h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', { class: 'grp' }, h('th'), h('th', { colspan: 4, class: 'n grp-l' }, 'Subcontractors'), h('th', { colspan: 3, class: 'n grp-l' }, 'Vendors'), h('th', { class: 'n grp-l' }, 'Labor'), h('th', { colspan: 2, class: 'n grp-l' }, 'Total')),
      h('tr', {}, th('Trade'), th('Contracts', 1), th('Invoiced', 1, 'lo'), th('Paid', 1, 'lo'), th('Still Owed', 1), th('Invoiced', 1), th('Paid', 1, 'lo'), th('Still Owed', 1), th('Cost', 1), th('Total Cost', 1), th('Total Still Owed', 1))),
      h('tbody', {}, sumRows.map((r) => h('tr', {}, sc(r)))), h('tfoot', {}, h('tr', { class: 'total' }, sc(tot))))));
  return h('div', {}, err, tally, toReceipts, vendors, suppliers, labor);
}


// ------------------------------------------------------------------ labor (from the time clock) and clock settings
const localInput = (iso) => { if (!iso) return ''; const d = new Date(iso), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
async function laborTab(p, canEdit, reload) {
  const base = `/projects/${p.project.id}`; const err = h('div'); const th = (t, n) => h('th', { class: n ? 'n' : '' }, t);
  const c = await api('GET', `${base}/costs`);
  const pay = new Map(c.laborByTrade.map((l) => [l.trade || '', l.pay]));
  let body;
  if (canEdit) {
    const entries = await api('GET', `/time/entries?projectId=${p.project.id}`);
    const edit = (e) => {
      const tradeOpts = (v) => { const s = h('select', {}, h('option', { value: '' }, 'Project-level'), p.trades.map((t) => h('option', { value: t.id }, t.name))); s.value = v || ''; return s; };
      const lines = h('div'); const add = (l) => { const sel = tradeOpts(l?.projectTradeId), amt = num(l?.hours ?? '', { placeholder: 'Hours' }); const row = h('div', { class: 'trade-row' }, sel, amt, h('button', { class: 'small', type: 'button', onclick: () => row.remove() }, 'Remove')); row._get = () => ({ projectTradeId: sel.value || null, hours: amt.value }); lines.append(row); };
      (e.lines.length ? e.lines : [{}]).forEach(add);
      const f = { cin: h('input', { type: 'datetime-local', value: localInput(e.clockIn) }), cout: h('input', { type: 'datetime-local', value: localInput(e.clockOut) }), hours: num(e.totalHours), date: h('input', { type: 'date', value: e.date }), lunch: num(e.lunchHours), notes: h('input', { value: e.notes || '' }) };
      const manual = e.method === 'Manual';
      formModal(`Edit time · ${e.employee} · ${e.date}`, [manual ? field('Date', f.date) : field('Clock in', f.cin), manual ? field('Hours', f.hours) : field('Clock out', f.cout), field('Lunch hours', f.lunch), field('Notes', f.notes),
        field('Hours by trade (must add up to the day)', h('div', {}, lines, h('button', { class: 'small', type: 'button', onclick: () => add() }, '+ Another trade')), 'wide')],
      async () => { const b = { lunchHours: f.lunch.value, notes: f.notes.value, lines: [...lines.children].map((r) => r._get()) }; if (manual) { b.totalHours = f.hours.value; b.date = f.date.value; } else { b.clockIn = new Date(f.cin.value).toISOString(); if (f.cout.value) b.clockOut = new Date(f.cout.value).toISOString(); } await api('PUT', `/time/entries/${e.id}`, b); reload(); });
    };
    body = entries.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, th('Date'), th('Employee'), th('Trades'), th('Source'), th('Hours', 1), th(''))),
      h('tbody', {}, entries.map((e) => h('tr', {}, h('td', {}, e.date), h('td', {}, e.employee), h('td', {}, e.lines.map((l) => `${l.trade || 'Project-level'} ${l.hours.toFixed(2)}h`).join(', ') || (e.status === 'open' ? 'Clocked in' : '—')),
        h('td', {}, e.method, e.lateIn ? h('span', { class: 'pill Pending', style: 'margin-left:.4rem' }, 'Late') : '', e.injured ? h('span', { class: 'pill Rejected', style: 'margin-left:.4rem' }, 'Injury') : '', e.modified ? h('span', { class: 'pill', style: 'margin-left:.4rem' }, 'Edited') : ''), h('td', { class: 'n' }, e.status === 'open' ? 'open' : e.totalHours.toFixed(2)),
        h('td', {}, e.status === 'complete' ? [h('button', { class: 'small', onclick: () => edit(e) }, 'Edit'), ' '] : '', h('button', { class: 'small danger', onclick: guard(err, async () => { if (confirm('Delete this time entry? Labor cost updates automatically.')) { await api('DELETE', `/time/entries/${e.id}`); reload(); } }) }, 'Delete'))))))) : h('p', { class: 'muted' }, 'No time has been clocked on this project yet.');
  } else body = c.labor.length ? h('table', {}, h('thead', {}, h('tr', {}, th('Trade'), th('Employee'), th('Hours', 1), th('Pay', 1))), h('tbody', {}, c.labor.map((l) => h('tr', {}, h('td', {}, l.trade || 'Project-level'), h('td', {}, l.employee), h('td', { class: 'n' }, l.hours.toFixed(2)), h('td', { class: 'n' }, l.pay == null ? '—' : usd(l.pay)))))) : h('p', { class: 'muted' }, 'No labor yet.');
  const sum = h('div', { class: 'grid kpis', style: 'margin-bottom:1rem' }, h('div', { class: 'kpi' }, h('div', { class: 'l' }, 'Labor cost'), h('div', { class: 'v' }, usd(p.totals.laborCost))), h('div', { class: 'kpi' }, h('div', { class: 'l' }, 'Hours'), h('div', { class: 'v' }, p.totals.hours.toFixed(1))));
  const labCard = h('div', { class: 'card' }, h('h2', {}, 'Labor from the time clock'), h('p', { class: 'muted' }, 'Crew clock in on the Time Clock page and pick this project and a trade. Hours and pay post here automatically, with overtime figured across the whole week. Fix a punch here and cost updates everywhere.'), err, sum, body,
    c.labor.length ? h('p', { class: 'muted', style: 'margin-top:.8rem' }, 'Labor cost by trade: ' + [...pay].map(([k, v]) => `${k || 'Project-level'} ${usd(v)}`).join(' · ')) : '');
  let loc = '';
  if (canEdit) {
    const f = { lat: h('input', { type: 'number', step: 'any', value: p.project.lat ?? '' }), lng: h('input', { type: 'number', step: 'any', value: p.project.lng ?? '' }), miles: h('input', { type: 'number', step: '0.05', value: p.project.geofenceMiles }), req: h('input', { type: 'checkbox' }) };
    f.req.checked = p.project.geofenceRequired; const e2 = h('div');
    loc = h('div', { class: 'card' }, h('h2', {}, 'Jobsite location for the time clock'), h('p', { class: 'muted' }, 'Optional. When required, crew can only clock in within the radius of these coordinates.'),
      h('div', { class: 'form' }, field('Latitude', f.lat), field('Longitude', f.lng), field('Radius (miles)', f.miles), field('', h('label', { style: 'text-transform:none;letter-spacing:0;font-size:15px;font-weight:400' }, f.req, ' Require location to clock in'))), e2,
      h('div', { class: 'row', style: 'margin-top:.8rem' }, h('button', { onclick: guard(e2, async () => { const g = await api('POST', base + '/locate', { enable: true }); f.lat.value = g.lat; f.lng.value = g.lng; f.req.checked = true; notice(e2, 'Set from the project address, and clock-ins are now limited to the radius.', 'ok'); }) }, 'Set From Project Address'), h('button', { onclick: () => navigator.geolocation?.getCurrentPosition((g) => { f.lat.value = g.coords.latitude.toFixed(6); f.lng.value = g.coords.longitude.toFixed(6); }, () => notice(e2, 'Could not read your location.')) }, 'Use my current location'),
        h('button', { class: 'primary', onclick: guard(e2, async () => { await api('PUT', base, { lat: f.lat.value, lng: f.lng.value, geofenceMiles: f.miles.value, geofenceRequired: f.req.checked }); notice(e2, 'Saved.', 'ok'); }) }, 'Save location')));
  }
  return h('div', {}, labCard, loc);
}

async function bidFeedCard() {
  const f = await api('GET', '/bids/status'); const regions = await api('GET', '/regions'); const err = h('div'); const can = ['Super Admin', 'Sub Admin'].includes(state.user.role);
  const label = h('input', { value: f.label || '', placeholder: 'Optional, e.g. Building Connected', disabled: !can ? true : null });
  const region = (r) => { const c = h('input', { value: r?.city ?? '', disabled: r ? true : null }), t = h('select', {}, [1, 2, 3, 4].map((n) => h('option', { value: n }, `Tier ${n}`))); if (r) t.value = r.tier; formModal(r ? `Edit ${r.city}` : 'Add a city', [field('City', c), field('Region tier', t)], async () => { await api('PUT', '/regions', { city: c.value, tier: t.value }); render(); }); };
  return h('div', { class: 'card' }, h('h2', {}, 'Bid invitations from Gmail'), err,
    f.connected ? h('div', {}, h('p', { class: 'ok' }, `Connected to ${f.email}. It reads BuildingConnected invitations and sends password-reset emails. It never deletes or changes mail.`), f.canSend ? '' : h('p', { class: 'err' }, 'This connection was made before password-reset emails existed, so it cannot send yet. Press Disconnect, then Connect Gmail again and allow sending.')) : h('p', { class: f.googleSetUp ? 'muted' : 'err' }, f.googleSetUp ? 'Not connected yet. Press Connect and sign in with the Gmail account that receives the BuildingConnected invitations.' : 'Google is not set up on the server yet (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET). See the setup steps.'),
    h('div', { class: 'row' }, isSuper() ? (f.connected ? h('button', { onclick: guard(err, async () => { if (confirm('Disconnect Gmail? Leads already in the list stay.')) { await api('DELETE', '/gmail'); render(); } }) }, 'Disconnect') : h('button', { class: 'primary', disabled: !f.googleSetUp ? true : null, onclick: guard(err, async () => { location.href = (await api('GET', '/gmail/connect')).url; }) }, 'Connect Gmail')) : '', f.connected ? h('button', { onclick: guard(err, async () => { await api('POST', '/bids/refresh', {}); location.hash = '#/estimating/bids'; }) }, 'Refresh now') : ''),
    f.connected ? h('div', { class: 'row', style: 'margin-top:.8rem' }, h('label', { style: 'margin:0' }, 'Gmail label to read'), label, can && h('button', { class: 'small', onclick: guard(err, async () => { await api('PUT', '/bids/settings', { label: label.value }); notice(err, 'Saved. The next refresh uses it.', 'ok'); }) }, 'Save'), h('span', { class: 'muted', style: 'font-size:13px' }, 'Blank reads everything from buildingconnected.com.')) : '',
    f.runs.length ? h('div', { class: 'scroll', style: 'margin-top:.8rem' }, h('table', {}, h('thead', {}, h('tr', {}, ['When', 'How', 'Result', 'Emails read', 'New', 'Updated', 'Skipped (not FL)', 'Auto-declined'].map((t) => h('th', {}, t)))), h('tbody', {}, f.runs.map((r) => h('tr', {}, h('td', {}, new Date(r.started_at).toLocaleString()), h('td', {}, r.trigger), h('td', {}, h('span', { class: 'pill ' + (r.status === 'Done' ? 'Approved' : r.status === 'Error' ? 'Rejected' : 'Pending'), title: r.error || '' }, r.status)), h('td', {}, r.threads), h('td', {}, r.added), h('td', {}, r.updated), h('td', {}, r.skipped), h('td', {}, r.declined)))))) : '',
    h('div', { class: 'row spread', style: 'margin-top:1.2rem' }, h('h2', { style: 'margin:0' }, 'Region tiers (ranking)'), can && h('button', { class: 'small', onclick: () => region(null) }, '+ Add city')),
    h('p', { class: 'muted' }, 'Leads are ranked by tier, then shopping centers, then project type. Cities not listed here are Tier 3.'),
    regions.length ? h('table', {}, h('tbody', {}, regions.map((r) => h('tr', {}, h('td', {}, r.city), h('td', {}, 'Tier ' + r.tier), can && h('td', {}, h('button', { class: 'small', onclick: () => region(r) }, 'Change tier'), ' ', h('button', { class: 'small danger', onclick: guard(err, async () => { await api('DELETE', '/regions/' + encodeURIComponent(r.city)); render(); }) }, 'Remove')))))) : h('p', { class: 'muted' }, 'No cities yet.'));
}

async function clockSettingsCard() {
  const s = await api('GET', '/settings/timeclock'); const err = h('div'); const canSave = isSuper() || state.user.role === 'Sub Admin';
  const f = { ot: h('input', { type: 'checkbox' }), after: num(s.otAfter), mult: num(s.otMult), full: num(s.dailyFullDayHours), lunch: num(s.lunchMinutes), lunchAfter: num(s.lunchAfterHours), start: h('input', { type: 'time', value: s.dayStart }), grace: num(s.lateGraceMinutes), round: num(s.roundMinutes) }; f.ot.checked = s.otEnabled;
  return h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', {}, 'Time clock rules'), h('a', { href: '/clock', target: '_blank', rel: 'noopener' }, 'Open the time clock page ↗')), err,
    h('div', { class: 'form' }, field('', h('label', { style: 'text-transform:none;letter-spacing:0;font-size:15px;font-weight:400' }, f.ot, ' Pay overtime')), field('Overtime after (hours/week)', f.after), field('Overtime multiplier', f.mult), field('Daily-rate: full day at (hours)', f.full), field('Auto lunch (minutes, 0 = off)', f.lunch), field('Lunch applies after (hours)', f.lunchAfter), field('Workday starts', f.start), field('Late grace (minutes)', f.grace), field('Round hours to (minutes, 0 = exact)', f.round)),
    canSave ? h('div', { class: 'row', style: 'margin-top:.8rem' }, h('button', { class: 'primary', onclick: guard(err, async () => { await api('PUT', '/settings/timeclock', { otEnabled: f.ot.checked, otAfter: f.after.value, otMult: f.mult.value, dailyFullDayHours: f.full.value, lunchMinutes: f.lunch.value, lunchAfterHours: f.lunchAfter.value, dayStart: f.start.value, lateGraceMinutes: f.grace.value, roundMinutes: f.round.value }); notice(err, 'Saved. New punches use these rules.', 'ok'); }) }, 'Save rules'),
      h('button', { onclick: guard(err, async () => { if (confirm('Recalculate all labor cost from the clock using the current rules and rates?')) { const r = await api('POST', '/time/recalculate', {}); notice(err, `Recalculated ${r.weeks} employee-weeks.`, 'ok'); } }) }, 'Recalculate past labor')) : h('p', { class: 'muted' }, 'Only the Super Admin and Sub Admin can change pay rules.'));
}


// The number on the Messages tab: unread messages, plus to-dos that are new to you, due today or overdue.
async function updateMessagesBadge() {
  const el = document.getElementById('msg-bubble'); if (!el) return;
  try {
    const b = await api('GET', '/messages/badge'); state.badge = b;
    el.textContent = b.total > 99 ? '99+' : String(b.total); el.style.display = b.total ? 'inline-block' : 'none'; el.classList.toggle('hot', b.overdue > 0);
    el.title = [b.unread ? `${b.unread} unread message${b.unread === 1 ? '' : 's'}` : '', b.newTodos ? `${b.newTodos} new to-do${b.newTodos === 1 ? '' : 's'}` : '', b.dueToday ? `${b.dueToday} due today` : '', b.overdue ? `${b.overdue} overdue` : ''].filter(Boolean).join(' · ');
  } catch { el.style.display = 'none'; }
}
setInterval(() => { if (state.user) updateMessagesBadge(); }, 60000);

// ------------------------------------------------------------------ alerts bell
async function updateBell() {
  const el = document.getElementById('bell'); if (!el) return;
  try { const n = await api('GET', '/notifications'); const unread = n.filter((x) => !x.read_at).length; el.textContent = unread ? `Alerts (${unread})` : 'Alerts'; el.style.fontWeight = unread ? '700' : '600'; if (unread) el.style.borderColor = '#b36b00'; } catch { /* ignore */ }
}
async function openNotifications() {
  const n = await api('GET', '/notifications'); const err = h('div');
  const bg = modal('Alerts', h('div', {}, err, n.length ? n.map((x) => h('div', { style: 'padding:.6rem 0;border-bottom:1px solid var(--line);' + (x.read_at ? 'opacity:.6' : '') }, h('div', { style: 'font-weight:600;font-family:Calibri,Carlito,sans-serif' }, x.title), x.body ? h('div', { class: 'muted' }, x.body) : '', h('div', { class: 'row', style: 'gap:.8rem' }, h('span', { class: 'muted', style: 'font-size:12px' }, new Date(x.created_at).toLocaleString()), x.link ? h('a', { href: x.link, onclick: () => bg.remove() }, 'Open') : ''))) : h('p', { class: 'muted' }, 'Nothing new.'),
    n.some((x) => !x.read_at) ? h('div', { class: 'row', style: 'margin-top:1rem;justify-content:flex-end' }, h('button', { onclick: guard(err, async () => { await api('POST', '/notifications/read', { all: true }); bg.remove(); updateBell(); }) }, 'Mark all read')) : ''));
}

// ------------------------------------------------------------------ project documents tab: notice to owner (files and links come next)
async function docsTab(p, canEdit, reload) {
  const n = await api('GET', `/projects/${p.project.id}/nto`); const err = h('div');
  const edit = () => {
    const f = { status: h('select', {}, ['Needed', 'Sent', 'Not Required'].map((s) => h('option', { value: s }, s))), first: h('input', { type: 'date', value: n.firstFurnishedSet ? n.firstFurnished : '' }), sent: h('input', { type: 'date', value: n.sentDate || '' }), method: h('input', { value: n.method || '', placeholder: 'Certified mail, tracking #…' }), to: h('input', { value: n.recipient || '' }), url: h('input', { type: 'url', value: n.documentUrl || '', placeholder: 'https://… link to the notice' }), year: num(n.year, { step: '1', min: '2000' }), notes: h('input', { value: n.notes || '' }) };
    f.status.value = n.status;
    formModal('Notice to Owner', [field('Status', f.status), field('First furnished labor/materials', f.first), field('Date sent', f.sent), field('How sent', f.method), field('Sent to (owner)', f.to), field('Year', f.year), field('Document link', f.url, 'wide'), field('Notes', f.notes, 'wide')],
      async () => { await api('PUT', `/projects/${p.project.id}/nto`, { status: f.status.value, firstFurnished: f.first.value || null, sentDate: f.sent.value || null, method: f.method.value, recipient: f.to.value, documentUrl: f.url.value, year: f.year.value, notes: f.notes.value }); reload(); });
  };
  return h('div', {}, h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', {}, 'Notice to Owner'), canEdit && h('button', { class: 'primary', onclick: edit }, 'Update notice')), err,
    h('div', { class: 'grid kpis' }, h('div', { class: 'kpi ' + (n.overdue ? 'bad' : n.status === 'Needed' ? 'warn' : '') }, h('div', { class: 'l' }, 'Status'), h('div', { class: 'v' }, n.overdue ? 'Overdue' : n.status)),
      h('div', { class: 'kpi' }, h('div', { class: 'l' }, 'First furnished'), h('div', { class: 'v', style: 'font-size:1.2rem' }, n.firstFurnished || 'Not set')), h('div', { class: 'kpi' }, h('div', { class: 'l' }, 'Deadline (45 days)'), h('div', { class: 'v', style: 'font-size:1.2rem' }, n.due || '—')),
      h('div', { class: 'kpi' }, h('div', { class: 'l' }, 'Days left'), h('div', { class: 'v' }, n.status === 'Sent' ? 'Sent' : n.daysLeft ?? '—'))),
    n.status === 'Sent' ? h('p', { class: 'muted' }, `Sent ${n.sentDate}${n.method ? ' by ' + n.method : ''}${n.recipient ? ' to ' + n.recipient : ''}.`, n.documentUrl ? [' ', h('a', { href: n.documentUrl, target: '_blank', rel: 'noopener' }, 'View notice')] : '') : h('p', { class: 'muted' }, 'The deadline counts 45 days from the first day labor or materials were furnished. Confirm the rule for your situation with your attorney.')),
    await leadDocsCard(p), await projectDocs(p, canEdit, reload));
}
// Everything gathered while this job was a lead (plans, proposal, submittals), kept with the project so the whole job's paperwork is in one place.
async function leadDocsCard(p) {
  const id = p.project.id, lead = await api('GET', `/projects/${id}/lead-files`).catch(() => null); if (!lead) return '';
  const live = h('div'), KINDS = ['Plans', 'Proposal', 'Submittal', 'Other'];
  api('GET', `/projects/${id}/lead-folder-files`).then((r) => { const rows = [...(r.plans || []).map((x) => ['Plans', x]), ...(r.proposals || []).map((x) => ['Proposal', x])]; if (rows.length) live.replaceChildren(h('label', { style: 'margin-top:.6rem' }, 'In the job folder in SharePoint'), ...rows.map(([k, x]) => h('div', {}, h('a', { href: x.webUrl, target: '_blank', rel: 'noopener' }, x.name), ' ', h('span', { class: 'pill' }, k)))); }).catch(() => {});
  const link = (f) => h('a', { href: f.local === false ? f.spUrl || '#' : `/api/projects/${id}/lead-files/${f.id}`, target: '_blank', rel: 'noopener' }, f.name);
  return h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', {}, 'From the lead'), lead.folderUrl ? h('a', { href: lead.folderUrl, target: '_blank', rel: 'noopener', class: 'small' }, 'Open the job folder') : ''),
    h('p', { class: 'muted' }, `Files from estimating${lead.proposalId ? ` (proposal ${lead.proposalId})` : ''}. They stay with the job from the first bid to the finished project.`),
    lead.files.length ? h('table', {}, h('tbody', {}, KINDS.flatMap((k) => lead.files.filter((f) => f.kind === k).map((f) => h('tr', {}, h('td', {}, h('span', { class: 'pill' }, f.kind)), h('td', {}, link(f), f.local === false ? h('span', { class: 'muted', style: 'font-size:12px' }, '  (in SharePoint)') : ''), h('td', { class: 'muted' }, String(f.at).slice(0, 10))))))) : h('p', { class: 'muted' }, 'No files were added to the lead.'), live);
}

// ------------------------------------------------------------------ compliance page
async function complianceView() {
  const err = h('div'); const parts = [];
  const [reqs, vendors, ntos, outbox] = await Promise.all([api('GET', '/payment-requests'), api('GET', '/compliance/vendors'), api('GET', `/ntos?year=${state.ntoYear || new Date().getFullYear()}`), api('GET', '/outbox')]);
  const th = (t, n) => h('th', { class: n ? 'n' : '' }, t); const canApprove = ['Super Admin', 'Sub Admin'].includes(state.user.role);
  const act = (fn) => guard(err, async () => { await fn(); render(); });

  const payForm = (r) => { const f = { date: h('input', { type: 'date', value: todayStr() }), ref: h('input', { placeholder: 'Check or ACH #' }) }; formModal(`Record payment · ${r.vendor}`, [field('Payment date', f.date), field('Check / reference #', f.ref)], async () => { await api('POST', `/payment-requests/${r.id}/pay`, { date: f.date.value, reference: f.ref.value }); render(); }, 'Mark paid'); };
  const rejectForm = (r) => { const why = h('input'); formModal('Decline payment', [field('Reason', why, 'wide')], async () => { await api('POST', `/payment-requests/${r.id}/reject`, { reason: why.value }); render(); }, 'Decline'); };
  parts.push(h('div', { class: 'card' }, h('h2', {}, 'Subcontractor payment approvals'), h('p', { class: 'muted' }, 'A payment is requested, approved by someone other than the requester, then recorded as paid. Vendors without a W-9 and valid insurance are blocked at every step.'),
    reqs.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, th('Project'), th('Subcontractor'), th('Trade'), th('Bill'), th('Amount', 1), th('Requested by'), th('Status'), th(''))),
      h('tbody', {}, reqs.map((r) => h('tr', {}, h('td', {}, r.project), h('td', {}, r.vendor), h('td', {}, r.trade || '—'), h('td', {}, r.bill), h('td', { class: 'n' }, usd(r.amount)), h('td', {}, r.requestedBy), h('td', {}, h('span', { class: 'pill ' + r.status }, r.status), r.rejectReason ? h('div', { class: 'muted', style: 'font-size:12px;white-space:normal' }, r.rejectReason) : '', r.reference ? h('div', { class: 'muted', style: 'font-size:12px' }, r.reference) : ''),
        h('td', {}, r.status === 'Requested' && canApprove ? [h('button', { class: 'small', onclick: act(() => api('POST', `/payment-requests/${r.id}/approve`, {})) }, 'Approve'), ' ', h('button', { class: 'small danger', onclick: () => rejectForm(r) }, 'Decline'), ' '] : '', r.status === 'Approved' ? [h('button', { class: 'small primary', onclick: () => payForm(r) }, 'Record payment'), ' '] : '', ['Requested', 'Approved'].includes(r.status) ? h('button', { class: 'small', onclick: act(() => api('DELETE', `/payment-requests/${r.id}`)) }, 'Cancel') : '')))))) : h('p', { class: 'muted' }, 'No payment requests yet. Request a payment from a project\'s Costs & Payables tab.')));

  const docForm = (v) => {
    const f = { cat: h('select', {}, ['W-9', 'COI', 'Exemption'].map((c) => h('option', { value: c }, c === 'COI' ? 'COI (certificate of insurance)' : c === 'Exemption' ? 'Workers comp exemption' : c))), file: h('input', { type: 'file', accept: '.pdf,.png,.jpg,.jpeg' }), url: h('input', { type: 'url', placeholder: 'or paste a link (https://…)' }), exp: h('input', { type: 'date' }) };
    f.cat.onchange = () => { f.exp.required = f.cat.value === 'COI'; };
    formModal(`Documents · ${v.name}`, [field('Document', f.cat), field('File', f.file, 'wide'), field('Link', f.url, 'wide'), field('Expires', f.exp), h('p', { class: 'muted wide' }, 'A COI needs an expiration date. Adding a new one replaces the old one on file.')], async () => { if (f.file.files[0]) await uploadFile(`/documents/upload?category=${encodeURIComponent(f.cat.value)}&subcontractorId=${v.id}${f.exp.value ? '&expiresOn=' + f.exp.value : ''}`, f.file.files[0]); else await api('POST', `/admin/subcontractors/${v.id}/documents`, { category: f.cat.value, url: f.url.value, expiresOn: f.exp.value || null }); render(); }, 'Save document');
  };
  // Verified = a W-9 and unexpired insurance (or exemption) on file, or verified by the owner. Only a verified subcontractor can be paid.
  const verifyCell = (v) => h('td', { style: 'white-space:normal;min-width:12rem' }, h('span', { class: 'pill ' + (v.verified ? 'Valid' : 'Expired'), title: v.blockers.join('; ') }, v.verified ? 'Verified' : 'Unverified'), v.override ? h('div', { class: 'muted', style: 'font-size:12px' }, 'Verified by the owner') : '',
    v.verified ? '' : h('ul', { style: 'margin:.3rem 0 0;padding-left:1.1rem;font-size:12px' }, v.blockers.map((b) => h('li', {}, b))));
  const docCell = (v, cat) => { const d = v.docs[cat]; return d ? h('span', {}, d.url ? h('a', { href: d.url, target: '_blank', rel: 'noopener' }, 'On file') : 'On file', d.expires ? ` · ${d.expires}` : '', ' ', h('button', { class: 'small danger', title: 'Remove', onclick: act(() => api('DELETE', `/admin/subcontractors/${v.id}/documents/${encodeURIComponent(cat)}`)) }, '×')) : h('span', { class: 'muted' }, '—'); };
  parts.push(h('div', { class: 'card' }, h('h2', {}, 'Subcontractor W-9 and insurance'), vendors.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, th('Subcontractor'), th('Verified'), th('Status'), th('W-9'), th('COI'), th('Exemption'), th('Active on'), th(''))),
    h('tbody', {}, vendors.filter((v) => !v.archived).map((v) => h('tr', {}, h('td', {}, v.name, v.folderUrl ? h('div', {}, h('a', { href: v.folderUrl, target: '_blank', rel: 'noopener', style: 'font-size:12px' }, 'SharePoint Folder')) : ''), verifyCell(v), h('td', {}, h('span', { class: 'pill ' + v.status, title: v.reasons.join('; ') }, v.status), v.daysLeft != null && v.status !== 'Valid' ? h('span', { class: 'muted', style: 'margin-left:.4rem;font-size:12px' }, `${v.daysLeft} days`) : ''), h('td', {}, docCell(v, 'W-9')), h('td', {}, docCell(v, 'COI')), h('td', {}, docCell(v, 'Exemption')), h('td', { style: 'white-space:normal' }, v.activeProjects.join(', ') || '—'), h('td', {}, h('button', { class: 'small', onclick: () => docForm(v) }, 'Add / update')))))) ) : h('p', { class: 'muted' }, 'No subcontractors yet. Add them in Admin.')));

  // 1099 readiness: what each crew member and subcontractor was paid in a year, and whether the information for their 1099 is complete.
  const taxYear = state.taxYear || new Date().getFullYear(), tax = await api('GET', `/tax/1099?year=${taxYear}`), sup = isSuper();
  const taxSel = h('select', { onchange: (e) => { state.taxYear = Number(e.target.value); render(); } }, [taxYear + 1, taxYear, taxYear - 1, taxYear - 2, taxYear - 3].map((y) => h('option', { value: y }, y))); taxSel.value = taxYear;
  const taxLine = (a) => [a?.street, a?.city, [a?.state, a?.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const readyCount = tax.rows.filter((r) => r.over600 && !r.ready).length;
  parts.push(h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', {}, '1099 Information'), h('div', { class: 'row' }, h('label', { style: 'margin:0' }, 'Year'), taxSel, h('a', { class: 'small', href: `/api/tax/1099/export?year=${taxYear}` }, 'Export For Excel'))),
    h('p', { class: 'muted' }, `Everyone who is paid as a 1099 (crew and subcontractors) needs a verified address and a W-9 whose address matches. The tax number stays on the W-9 file. ${readyCount ? `${readyCount} paid $600 or more but ${readyCount === 1 ? 'is' : 'are'} not ready.` : 'Everyone paid $600 or more is ready.'}${sup ? '' : ' Crew pay is shown to the owner only.'}`),
    tax.rows.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['Payee', 'Type', 'Name On The W-9', 'Address On File'].map((t) => h('th', {}, t)), h('th', { class: 'n' }, 'Paid'), h('th', {}, '1099 Information'))),
      h('tbody', {}, tax.rows.map((r) => h('tr', {}, h('td', {}, r.name), h('td', {}, r.type), h('td', { style: 'white-space:normal' }, r.w9Name || h('span', { class: 'muted' }, '—'), r.nameNote ? h('div', { class: 'muted', style: 'font-size:12px' }, r.nameNote) : ''), h('td', { style: 'white-space:normal;min-width:14rem' }, r.addressLine || h('span', { class: 'muted' }, 'None'), r.w9Address ? h('div', { class: 'muted', style: 'font-size:12px' }, 'W-9: ' + taxLine(r.w9Address)) : ''),
        h('td', { class: 'n' }, r.paid == null ? h('span', { class: 'muted' }, '—') : usd(r.paid), r.over600 && r.paid != null ? '' : ''),
        h('td', { style: 'white-space:normal;min-width:14rem' }, h('span', { class: 'pill ' + (r.ready ? 'Valid' : 'Expired') }, r.ready ? 'Ready' : 'Not Ready'), r.ready ? '' : h('ul', { style: 'margin:.3rem 0 0;padding-left:1.1rem;font-size:12px' }, r.blockers.map((b) => h('li', {}, b))),
          r.addressChecked && r.w9 && ['Unread', 'Mismatch'].includes(r.addressMatch) ? h('button', { class: 'small', style: 'margin-top:.3rem', onclick: act(async () => { if (confirm(`Compare the address on the W-9 with ${r.addressLine}. Are they the same place?`)) await api('POST', `/admin/${r.type === 'Subcontractor' ? 'subcontractors' : 'employees'}/${r.id}/confirm-address`, {}); }) }, 'The W-9 Shows This Address') : '')))))) : h('p', { class: 'muted' }, 'Nobody was paid in that year.')));

  const ntoForm = (n) => { const f = { status: h('select', {}, ['Needed', 'Sent', 'Not Required'].map((s) => h('option', { value: s }, s))), first: h('input', { type: 'date', value: n.firstFurnishedSet ? n.firstFurnished : '' }), sent: h('input', { type: 'date', value: n.sentDate || '' }), method: h('input', { value: n.method || '' }) }; f.status.value = n.status;
    formModal(`Notice to Owner · ${n.project}`, [field('Status', f.status), field('First furnished', f.first), field('Date sent', f.sent), field('How sent', f.method)], async () => { await api('PUT', `/projects/${n.projectId}/nto`, { status: f.status.value, firstFurnished: f.first.value || null, sentDate: f.sent.value || null, method: f.method.value }); render(); }); };
  const yr = state.ntoYear || new Date().getFullYear(); const yearSel = h('select', { onchange: (e) => { state.ntoYear = Number(e.target.value); render(); } }, [yr + 1, yr, yr - 1, yr - 2].map((y) => h('option', { value: y }, y))); yearSel.value = yr;
  parts.push(h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', {}, 'Notices to Owner'), h('div', { class: 'row' }, h('label', { style: 'margin:0' }, 'Year'), yearSel)), h('p', { class: 'muted' }, 'Each year starts fresh. Projects still open with an unsent notice roll forward automatically.'),
    ntos.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, th('Project'), th('GC'), th('Year'), th('First furnished'), th('Deadline'), th('Days left', 1), th('Status'), th(''))),
      h('tbody', {}, ntos.map((n) => h('tr', {}, h('td', {}, n.project, n.rolledOver ? h('span', { class: 'pill', style: 'margin-left:.5rem' }, 'Rolled over') : ''), h('td', {}, n.gc), h('td', {}, n.year), h('td', {}, n.firstFurnished || h('span', { class: 'muted' }, 'Not set')), h('td', {}, n.due || '—'), h('td', { class: 'n ' + (n.overdue ? 'neg' : '') }, n.status === 'Sent' ? '' : n.daysLeft ?? '—'), h('td', {}, h('span', { class: 'pill ' + (n.overdue ? 'Expired' : n.status === 'Sent' ? 'Paid' : 'Pending') }, n.overdue ? 'Overdue' : n.status)), h('td', {}, h('button', { class: 'small', onclick: () => ntoForm(n) }, 'Update'))))))) : h('p', { class: 'muted' }, 'No notices for this year.')));

  parts.push(h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', {}, 'Email to subcontractors'), h('div', { class: 'row' }, h('button', { onclick: act(async () => { const r = await api('POST', '/compliance/scan', {}); notice(err, `Checked insurance and notices. ${r.notified} new alerts, ${r.emails} emails queued.`, 'ok'); }) }, 'Run expiry check now'), canApprove && h('button', { onclick: act(() => api('POST', '/outbox/send', {})) }, 'Send queued emails'))),
    outbox.connected ? '' : h('p', { class: 'err' }, 'Email is not connected yet. Insurance requests are queued here and will send as soon as a mail account (SMTP) is connected on the server.'),
    outbox.emails.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, th('To'), th('Subject'), th('Status'), th('When'), th(''))), h('tbody', {}, outbox.emails.map((m) => h('tr', {}, h('td', {}, m.to_email), h('td', {}, m.subject), h('td', {}, h('span', { class: 'pill ' + (m.status === 'Sent' ? 'Paid' : m.status === 'Failed' ? 'Expired' : 'Pending') }, m.status), m.error ? h('div', { class: 'muted', style: 'font-size:12px' }, m.error) : ''), h('td', {}, new Date(m.sent_at || m.created_at).toLocaleDateString()), h('td', {}, m.status === 'Failed' && canApprove ? h('button', { class: 'small', onclick: act(() => api('POST', `/outbox/${m.id}/retry`, {})) }, 'Retry') : '')))))) : h('p', { class: 'muted' }, 'Nothing queued.')));
  return shell('compliance', [h('h1', {}, 'Compliance & approvals'), err, ...parts]);
}


// ------------------------------------------------------------------ files, receipts, overhead, AI
async function uploadFile(path, file) {
  const res = await fetch('/api' + path, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) }, body: file });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Upload failed.');
  return data;
}
const DOC_CATS = ['Contract', 'Proposal', 'Approved CO', 'Client Invoice', 'Vendor Invoice', 'Receipt', 'Plans', 'Notice to Owner', 'Other'];
async function projectDocs(p, canEdit, reload) {
  const docs = await api('GET', `/documents?projectId=${p.project.id}`); const err = h('div');
  const add = () => {
    const f = { cat: h('select', {}, DOC_CATS.map((c) => h('option', { value: c }, c))), name: h('input', { placeholder: 'Optional' }), file: h('input', { type: 'file', accept: '.pdf,.png,.jpg,.jpeg,.docx,.xlsx,.csv,.txt' }), url: h('input', { type: 'url', placeholder: 'or paste a OneDrive / iCloud link (https://…)' }) };
    formModal('Add a document', [field('Type', f.cat), field('Name', f.name), field('File', f.file, 'wide'), field('Link', f.url, 'wide')], async () => {
      if (f.file.files[0]) await uploadFile(`/documents/upload?category=${encodeURIComponent(f.cat.value)}&projectId=${p.project.id}&name=${encodeURIComponent(f.name.value)}`, f.file.files[0]);
      else if (f.url.value) await api('POST', '/documents', { category: f.cat.value, name: f.name.value, url: f.url.value, projectId: p.project.id });
      else throw new Error('Choose a file or paste a link.');
      reload();
    }, 'Add');
  };
  const th = (t) => h('th', {}, t);
  return h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', {}, 'Project documents'), canEdit && h('button', { class: 'primary', onclick: add }, '+ Add document')), err,
    h('p', { class: 'muted', style: 'margin-top:0' }, 'Everything uploaded for this project is kept here for later review: its contract, change orders, receipts and invoices, plans, and the paperwork of its subcontractors. The same file is never saved twice.'),
    docs.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, th('Type'), th('Name'), th('Added'), th('By'), th(''))), h('tbody', {}, docs.map((d) => h('tr', {}, h('td', {}, d.category), h('td', {}, d.has_file ? h('a', { href: `/api/documents/${d.id}/file`, target: '_blank', rel: 'noopener' }, d.name) : h('a', { href: d.url, target: '_blank', rel: 'noopener' }, d.name)), h('td', {}, new Date(d.created_at).toLocaleDateString()), h('td', {}, d.uploaded_by || ''),
      h('td', {}, d.has_file && hasFolderAccess() ? [h('button', { class: 'small', title: 'Save a copy into a folder on this computer', onclick: guard(err, oneAtATime(async () => { try { notice(err, 'Saved to ' + (await saveDocToFolder(d)), 'ok'); } catch (e) { throw folderError(e); } })) }, 'Save to my folder'), ' '] : '', canEdit ? h('button', { class: 'small danger', onclick: guard(err, async () => { if (confirm(`Delete ${d.name}?`)) { await api('DELETE', `/documents/${d.id}`); reload(); } }) }, 'Delete') : ''))))) ) : h('p', { class: 'muted' }, 'No documents yet. Add the signed contract, proposals, approved change orders, invoices and plans here.'));
}

// For a vendor typed in new: keep it for next time, or treat the purchase as a one-time one (kept on the invoice, out of the vendor dropdowns).
function vendorKeepChoice(select, newName) {
  const keep = h('input', { type: 'radio', name: 'vk' + Math.random().toString(36).slice(2), checked: true }), once = h('input', { type: 'radio', name: keep.name });
  const lab = (inp, text) => h('label', { style: 'display:flex;gap:.5rem;align-items:center;text-transform:none;letter-spacing:0;font-weight:400;font-size:14px;margin:.15rem 0' }, inp, text);
  const el = h('div', { class: 'wide' }, lab(keep, 'Save this vendor for future purchases'), lab(once, 'One-time purchase (do not add it to the vendor list)'));
  const show = () => { el.style.display = select.value ? 'none' : ''; }; select.addEventListener('change', show); show();
  return { el, save: () => (select.value ? undefined : keep.checked) };
}
const CATS_OVERHEAD = ['Tools', 'Insurance', 'Vehicles & fuel', 'Office', 'Software', 'Other'];
function receiptReview(res, opts, done) {
  const parsed = res.parsed || { merchant: '', number: '', date: todayStr(), tax: 0, paid: false, lines: [{ description: '', amount: '', kind: 'Materials' }], warnings: [] };
  const sup = h('select', {}, h('option', { value: '' }, 'Type a new vendor →'), opts.suppliers.filter((s) => !s.one_time).map((s) => h('option', { value: s.id }, s.name))); if (res.supplierId) sup.value = res.supplierId;
  const newSup = h('input', { value: res.supplierId ? '' : parsed.merchant || '', placeholder: 'New vendor name' });
  const keepVendor = vendorKeepChoice(sup, newSup);
  const f = { ref: h('input', { value: parsed.number || '' }), date: h('input', { type: 'date', value: parsed.date || todayStr() }), tax: num(parsed.tax || 0), paid: h('input', { type: 'checkbox' }) }; f.paid.checked = !!parsed.paid;
  const lines = h('div'); const targets = () => [h('option', { value: '' }, 'Where does it go…'), ...opts.projects.map((p) => h('option', { value: 'p:' + p.id }, p.name)), ...CATS_OVERHEAD.map((c) => h('option', { value: 'o:' + c }, `Company overhead · ${c}`))];
  const addLine = (l) => {
    const desc = h('input', { value: l.description || '', placeholder: 'Item' }), amt = num(l.amount ?? '', { placeholder: 'Amount' }), kind = h('select', {}, ['Materials', 'Tools', 'Equipment', 'Other'].map((k) => h('option', { value: k }, k))), where = h('select', {}, targets()), trade = h('select', { disabled: true }, h('option', { value: '' }, 'Trade'));
    kind.value = l.kind || 'Materials'; if (res.suggestedProjectId) where.value = 'p:' + res.suggestedProjectId;
    const fill = () => { const pr = where.value.startsWith('p:') ? opts.projects.find((x) => x.id === where.value.slice(2)) : null; trade.replaceChildren(h('option', { value: '' }, pr ? 'Project-level' : 'Trade'), ...(pr ? pr.trades.map((t) => h('option', { value: t.id }, t.name)) : [])); trade.disabled = !pr; };
    where.onchange = fill; fill();
    const row = h('div', { style: 'display:grid;grid-template-columns:2fr 90px 110px 1.6fr 1.2fr auto;gap:.4rem;margin-bottom:.4rem' }, desc, amt, kind, where, trade, h('button', { class: 'small', type: 'button', onclick: () => row.remove() }, '×'));
    row._get = () => ({ description: desc.value, amount: amt.value, itemKind: kind.value, projectId: where.value.startsWith('p:') ? where.value.slice(2) : null, projectTradeId: trade.value || null, overheadCategory: where.value.startsWith('o:') ? where.value.slice(2) : null });
    lines.append(row);
  };
  parsed.lines.forEach(addLine);
  const warn = (parsed.warnings || []).concat(res.aiError ? [res.aiError] : []);
  formModal(res.parsed ? 'Review receipt' : 'Enter receipt', [
    ...(warn.length ? [h('div', { class: 'err wide' }, warn.map((w) => h('div', {}, w)))] : []),
    field('Vendor', sup), field('…or new vendor', newSup), keepVendor.el, field('Receipt / invoice #', f.ref), field('Date', f.date), field('Tax', f.tax), field('', h('label', { style: 'text-transform:none;letter-spacing:0;font-size:15px;font-weight:400' }, f.paid, ' Paid at purchase')),
    field('Lines: what it was, and where it goes (tax is shared across the lines)', h('div', {}, lines, h('button', { class: 'small', type: 'button', onclick: () => addLine({}) }, '+ Add line')), 'wide')],
  async () => { await api('POST', '/receipts', { supplierId: sup.value || undefined, supplierName: newSup.value, saveVendor: keepVendor.save(), reference: f.ref.value, date: f.date.value, tax: f.tax.value, paid: f.paid.checked, documentId: res.documentId, source: res.parsed ? 'AI' : 'Manual', total: parsed.total ?? undefined, lines: [...lines.children].map((r) => r._get()) }); done(); }, 'Save receipt');
}
async function receiptsView() {
  const [list, opts, use] = await Promise.all([api('GET', '/receipts'), Promise.all([api('GET', '/trade-options'), api('GET', '/admin/suppliers')]).then(([projects, suppliers]) => ({ projects, suppliers: suppliers.filter((s) => !s.archived) })), api('GET', '/ai/usage')]);
  const err = h('div'); const file = h('input', { type: 'file', accept: '.pdf,.png,.jpg,.jpeg', style: 'display:none', onchange: guard(err, async () => { const f = file.files[0]; if (!f) return; notice(err, 'Reading the receipt…', 'ok'); const res = await uploadFile('/receipts/parse', f); notice(err, ''); receiptReview(res, opts, render); file.value = ''; }) });
  const th = (t, n) => h('th', { class: n ? 'n' : '' }, t);
  return shell('projects', [h('div', { class: 'row spread' }, h('h1', {}, 'Receipts & Supplier Invoices'), h('div', { class: 'row' }, file, h('button', { class: 'primary', onclick: () => file.click() }, 'Upload receipt or invoice'), h('button', { onclick: () => receiptReview({ parsed: null }, opts, render) }, 'Enter by hand'))),
    projectsTabs('receipts'),
    h('p', { class: 'sub' }, use.connected ? 'Upload a Home Depot (or any) receipt or invoice. It is read for you, then you choose the project and trade for each line, or send tools to company overhead. Nothing posts until you save.' : 'AI reading is not connected yet, so receipts are entered by hand. Uploaded files are still saved.'), err,
    h('div', { class: 'card' }, list.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, th('Date'), th('Vendor'), th('Invoice #'), th('Where it went'), th('Total', 1), th('Paid', 1), th(''))),
      h('tbody', {}, list.map((r) => h('tr', {}, h('td', {}, r.invoice_date || '—'), h('td', {}, r.supplier, r.source === 'AI' ? h('span', { class: 'pill', style: 'margin-left:.4rem' }, 'Read by AI') : ''), h('td', {}, r.reference.startsWith('NO-NUMBER') ? '—' : r.reference),
        h('td', { style: 'white-space:normal' }, (r.lines || []).map((l) => `${l.description || l.kind || 'Item'} → ${l.overhead ? 'Overhead: ' + l.overhead : l.project + (l.trade ? ' / ' + l.trade : '')} ${usd(l.amount)}`).join('  ·  ')), h('td', { class: 'n' }, usd(r.total)), h('td', { class: 'n' }, usd(r.paid)),
        h('td', {}, r.document_id ? h('a', { href: `/api/documents/${r.document_id}/file`, target: '_blank', rel: 'noopener' }, 'Receipt') : '', ' ', h('button', { class: 'small danger', onclick: guard(err, async () => { if (confirm(`Delete ${r.supplier} ${r.reference}?`)) { await api('DELETE', `/supplier-invoices/${r.id}`); render(); } }) }, 'Delete'))))))) : h('p', { class: 'muted' }, 'No receipts yet.'))]);
}
async function overheadCard() {
  const o = await api('GET', '/overhead'); const err = h('div'); const th = (t, n) => h('th', { class: n ? 'n' : '' }, t); const sup = isSuper();
  const form = (it) => { const f = { name: h('input', { value: it?.name ?? '', placeholder: 'Insurance, office, software…' }), kind: h('select', {}, [['percent_of_revenue', 'Percent of revenue'], ['fixed_annual', 'Fixed amount per year']].map(([v, l]) => h('option', { value: v }, l))), value: num(it?.value ?? '', { step: '0.01' }), policy: h('input', { type: 'date', value: it?.policy_date ?? '' }) }; if (it) f.kind.value = it.kind;
    formModal(it ? `Edit ${it.name}` : 'Add overhead', [field('Name', f.name), field('How it is figured', f.kind), field('Percent (e.g. 2.5) or yearly $', f.value), field('Policy date (start / renewal)', f.policy), h('p', { class: 'muted wide' }, 'With a policy date, this cost is shared only by the contracts logged during that policy year, weighted by revenue. The more contracts and revenue in the year, the lower its effect on each one. Leave it blank to share across active projects.')], async () => { await api(it ? 'PUT' : 'POST', `/overhead${it ? '/' + it.id : ''}`, { name: f.name.value, kind: f.kind.value, value: f.value.value, policyDate: f.policy.value || null }); render(); }); };
  const basis = h('select', { disabled: !sup, onchange: guard(err, async (e) => { await api('PUT', '/settings/overhead', { basis: e.target.value }); render(); }) }, [['contract', 'Contract value'], ['billed', 'Billed to date']].map(([v, l]) => h('option', { value: v }, l))); basis.value = o.basis;
  return h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', {}, 'Company overhead'), sup && h('button', { class: 'primary', onclick: () => form(null) }, '+ Add overhead')), err,
    h('p', { class: 'muted' }, 'Overhead is spread across active projects by revenue so every project shows profit after its share. Set a percent (like insurance) or a yearly amount.'),
    o.items.length ? h('table', {}, h('thead', {}, h('tr', {}, th('Item'), th('Method'), th('Value', 1), th('Policy year'), th('Effect'), th('Counts'), sup && th(''))), h('tbody', {}, o.items.map((it) => h('tr', { class: it.active ? '' : 'muted' }, h('td', {}, it.name), h('td', {}, it.kind === 'percent_of_revenue' ? 'Percent of revenue' : 'Fixed per year'), h('td', { class: 'n' }, it.kind === 'percent_of_revenue' ? `${Number(it.value)}%` : usd(Number(it.value))), h('td', {}, it.policy_date ? `from ${it.policy_date}` : 'All active'), h('td', {}, (() => { const l = o.allocation.lines.find((x) => x.name === it.name); return l && l.effectivePct != null ? `${l.effectivePct}% over ${l.contracts} contract${l.contracts === 1 ? '' : 's'}` : '—'; })()), h('td', {}, it.active ? 'Yes' : 'Paused'),
      sup && h('td', {}, h('button', { class: 'small', onclick: () => form(it) }, 'Edit'), ' ', h('button', { class: 'small', onclick: guard(err, async () => { await api('PUT', `/overhead/${it.id}`, { active: !it.active }); render(); }) }, it.active ? 'Pause' : 'Resume'), ' ', h('button', { class: 'small danger', onclick: guard(err, async () => { if (confirm(`Delete ${it.name}?`)) { await api('DELETE', `/overhead/${it.id}`); render(); } }) }, 'Delete'))))) ) : h('p', { class: 'muted' }, 'No overhead items yet.'),
    h('div', { class: 'row', style: 'margin:1rem 0 .5rem' }, h('label', { style: 'margin:0' }, 'Spread by'), basis),
    o.allocation.byProject.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, th('Project'), th('GC'), th('Revenue', 1), th('Overhead share', 1), th('Profit', 1), th('After overhead', 1))), h('tbody', {}, o.allocation.byProject.map((r) => h('tr', {}, h('td', {}, r.name), h('td', {}, r.gc), h('td', { class: 'n' }, usd(r.revenue)), h('td', { class: 'n' }, usd(r.overhead)), h('td', { class: 'n ' + cls(r.projectedProfit) }, usd(r.projectedProfit)), h('td', { class: 'n ' + cls(r.profitAfterOverhead) }, usd(r.profitAfterOverhead))))),
      h('tfoot', {}, h('tr', { class: 'total' }, h('td', { colspan: 3 }, 'Total'), h('td', { class: 'n' }, usd(o.allocation.total)), h('td', {}), h('td', {}))))) : '',
    o.actualSpendThisYear.length ? h('p', { class: 'muted', style: 'margin-top:.8rem' }, 'Overhead actually bought this year (from receipts): ' + o.actualSpendThisYear.map((x) => `${x.category} ${usd(x.amount)}`).join(' · ')) : '');
}
async function aiCard() {
  const u = await api('GET', '/ai/usage'); const err = h('div'); const cap = num(u.cap, { step: '1000', disabled: !isSuper() });
  return h('div', { class: 'card' }, h('h2', {}, 'AI reading (receipts, invoices, plans)'), err,
    h('p', { class: u.connected ? 'ok' : 'err' }, u.connected ? 'Connected.' : 'Not connected. Add the ANTHROPIC_API_KEY on the server to turn on reading. Everything still works by hand.'),
    h('div', { class: 'grid kpis' }, h('div', { class: 'kpi' }, h('div', { class: 'l' }, 'Used this month'), h('div', { class: 'v' }, u.tokens.toLocaleString())), h('div', { class: 'kpi' }, h('div', { class: 'l' }, 'Documents read'), h('div', { class: 'v' }, u.calls))),
    h('div', { class: 'row', style: 'margin-top:.8rem' }, h('label', { style: 'margin:0' }, 'Monthly cap (tokens)'), cap, isSuper() && h('button', { onclick: guard(err, async () => { await api('PUT', '/settings/ai', { monthlyTokenCap: cap.value }); notice(err, 'Saved.', 'ok'); }) }, 'Save cap')));
}

// Super Admin: is the shared SharePoint folder connection working?
let qbFilter = 'New';
async function googleSigninCard() {
  const o = await api('GET', '/auth/options'), err = h('div'); const here = location.origin + '/api/auth/google/callback';
  const copy = (text) => h('button', { class: 'small', onclick: guard(err, async () => { await navigator.clipboard.writeText(text); notice(err, 'Copied. Paste it into the Google Cloud console exactly as it is.', 'ok'); }) }, 'Copy');
  return h('div', { class: 'card' }, h('h2', {}, 'Sign in with Google'), err,
    h('p', { class: 'muted' }, `People sign in with their @${o.domain} Google account instead of a password. They still need a login here (Admin → Company → Users & access) with their access chosen; Google only proves who they are. Passwords keep working as a backup.`),
    o.redirectUri ? h('div', {}, h('label', {}, 'Redirect address to add in the Google Cloud console'), h('div', { class: 'row' }, h('input', { readonly: true, value: o.redirectUri, style: 'flex:1;min-width:20rem', onfocus: (e) => e.target.select() }), copy(o.redirectUri)),
      o.redirectUri !== here ? h('p', { class: 'err' }, `This page is open at ${location.origin}, but the server will use ${new URL(o.redirectUri).origin}. Set PUBLIC_URL on Render to ${location.origin} and redeploy.`) : '',
      h('p', { class: 'muted', style: 'font-size:13px' }, 'Where: console.cloud.google.com → the project you made for Gmail → APIs & Services → Credentials → your OAuth client → Authorized redirect URIs → Add URI → Save.')) : h('p', { class: 'err' }, 'The server does not know its own address (PUBLIC_URL).'),
    h('p', { class: o.google ? 'ok' : 'err' }, o.google ? `Ready: the "Sign in with Google" button is on the sign-in page for @${o.domain} accounts.` : 'The Google keys are not on the server yet (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET).'));
}
// Going live: what to change at Intuit and on Render (only the owner can), then clearing the test figures read from the sandbox company.
function qboGoLive(s, err) {
  const t = s.testData || {}, sandbox = s.environment === 'sandbox', step = (n, body) => h('li', { style: 'margin:.35rem 0' }, body);
  const clear = () => formModal('Clear QuickBooks Test Data', [h('p', { class: 'wide' }, `This permanently removes everything that came from the QuickBooks test company: ${t.invoices} invoice${t.invoices === 1 ? '' : 's'} (with their ${t.payments} payment${t.payments === 1 ? '' : 's'}), ${t.costs} cost${t.costs === 1 ? '' : 's'}, and ${t.waiting} row${t.waiting === 1 ? '' : 's'} waiting for review. Projects, vendors, subcontractors and everything you typed in yourself stay.`), field('Type CLEAR to confirm', (clear.box = h('input', { autocomplete: 'off' })), 'wide')],
    async () => { await api('POST', '/quickbooks/clear-test-data', { confirm: clear.box.value }); render(); }, 'Clear Test Data');
  return h('details', { class: 'card', style: 'margin-top:.8rem', open: true }, h('summary', { style: 'cursor:pointer;font-weight:600' }, 'Go Live With Your Real Company'),
    h('ol', { style: 'padding-left:1.2rem' },
      step(1, ['At developer.intuit.com open your app, then ', h('b', {}, 'Production Settings'), ' (Intuit asks for the app details, your privacy and terms links, and a short questionnaire). When it is approved you get a ', h('b', {}, 'Production'), ' Client ID and Client Secret. Add the redirect address shown above under the ', h('b', {}, 'Production'), ' Redirect URIs.']),
      step(2, ['On Render, open the service, then ', h('b', {}, 'Environment'), '. Replace ', h('code', {}, 'QBO_CLIENT_ID'), ' and ', h('code', {}, 'QBO_CLIENT_SECRET'), ' with the Production values, ', h('b', {}, 'delete'), ' ', h('code', {}, 'QBO_ENVIRONMENT'), ' (or set it to ', h('code', {}, 'production'), '), and save. Render redeploys.']),
      step(3, ['Back here: press ', h('b', {}, 'Disconnect'), ' on the test connection, then ', h('b', {}, 'Clear test data'), ' below.']),
      step(4, ['Press ', h('b', {}, 'Connect QuickBooks'), ', sign in and choose your real company. Set the start date, and keep automatic logging off until you have looked over the first batch.'])),
    h('label', {}, 'What to type in Intuit\'s app form'), h('table', {}, h('tbody', {}, [['End-user license agreement URL', location.origin + '/terms'], ['Privacy policy URL', location.origin + '/privacy'], ['Host domain', location.host], ['Launch URL', location.origin + '/'], ['Disconnect URL', location.origin + '/#/quickbooks'], ['Connect / reconnect URL', location.origin + '/#/quickbooks']].map(([l, v]) => h('tr', {}, h('td', {}, l), h('td', {}, h('input', { readonly: true, value: v, style: 'width:100%;min-width:16rem', onfocus: (e) => e.target.select() })))))),
    h('p', { class: 'muted', style: 'font-size:13px' }, 'Where the app is hosted: United States. The server has no fixed IP address, so leave the IP box empty.'),
    t.leftover?.total ? h('div', { class: 'card', style: 'border-color:var(--red,#b42318)' }, h('p', {}, h('b', {}, `${t.leftover.invoices} invoices and ${t.leftover.costs} costs were read before you connected the real company.`), ' They are test rows from the sandbox. Removing them also removes anything imported from them, then the next sync reads only your real company.'),
      h('button', { class: 'danger', onclick: () => formModal('Remove Leftover Test Rows', [h('p', { class: 'wide' }, `This removes ${t.leftover.invoices} invoices and ${t.leftover.costs} costs that came from the test company, and anything imported from them. Rows read from your real company stay.`), field('Type CLEAR to confirm', (clear.box2 = h('input', { autocomplete: 'off' })), 'wide')], async () => { await api('POST', '/quickbooks/clear-leftover', { confirm: clear.box2.value }); render(); }, 'Remove Test Rows') }, 'Remove Leftover Test Rows')) : '',
    sandbox ? h('p', { class: 'muted', style: 'font-size:13px' }, 'The server is still on the sandbox, so everything here is test data.') : h('p', { class: 'ok', style: 'font-size:13px' }, 'The server is on your live QuickBooks keys.'),
    t.total ? h('div', { class: 'row' }, h('span', {}, `${t.invoices} invoices, ${t.costs} costs and ${t.waiting} waiting rows came from QuickBooks.`), t.allowed ? h('button', { class: 'danger', onclick: clear }, 'Clear Test Data') : h('span', { class: 'muted' }, t.why))
      : h('p', { class: 'muted', style: 'font-size:13px' }, 'No QuickBooks data is stored right now.'));
}
async function quickbooksCard() {
  const s = await api('GET', '/quickbooks/status'), err = h('div'); const live = s.connected && s.connectedEnvironment === s.environment; const rows = live ? await api('GET', '/quickbooks/invoices?status=' + qbFilter + (qbSearch ? '&search=' + encodeURIComponent(qbSearch) : '')) : []; const here = location.origin + '/api/quickbooks/callback';
  const copy = (text) => h('button', { class: 'small', onclick: guard(err, async () => { await navigator.clipboard.writeText(text); notice(err, 'Copied. Paste it into the Intuit developer site exactly as it is.', 'ok'); }) }, 'Copy');
  return h('div', { class: 'card' }, h('h2', {}, 'QuickBooks (invoices and expenses)'), err,
    h('p', { class: 'muted' }, 'Set up once at developer.intuit.com: create an app for "QuickBooks Online and Payments" with the accounting scope, and add the redirect address below to its Redirect URIs. Then add the app\'s Client ID and Client Secret on Render as QBO_CLIENT_ID and QBO_CLIENT_SECRET.'),
    s.redirectUri ? h('div', {}, h('label', {}, 'Redirect address to give Intuit'), h('div', { class: 'row' }, h('input', { readonly: true, value: s.redirectUri, style: 'flex:1;min-width:20rem', onfocus: (e) => e.target.select() }), copy(s.redirectUri)),
      s.redirectUri !== here ? h('p', { class: 'err' }, `This page is open at ${location.origin}, but the server will use ${new URL(s.redirectUri).origin}. Intuit must get the address you actually sign in with. If they differ, set PUBLIC_URL on Render to ${location.origin} and redeploy, then reload this page.`) : h('p', { class: 'ok' }, 'This matches the address you are using now.'))
      : h('p', { class: 'err' }, s.problem || 'The server does not know its own address.'),
    !s.configured ? h('p', { class: 'muted' }, 'Keys not added yet: ' + s.needs.join(', ') + '.')
      : s.connected ? h('div', {}, h('p', { class: 'muted', style: 'font-size:13px' }, s.environment === 'sandbox' ? 'Render setting QBO_ENVIRONMENT: ' + JSON.stringify(s.environmentSetting) + ' (sandbox / test company).' : 'Live QuickBooks. QBO_ENVIRONMENT is not set on Render, which is correct for a real company.'), h('p', { class: 'ok' }, `Talking to ${s.apiHost}. Connected to ${s.company || 'company ' + s.realmId} (${s.connectedEnvironment === 'sandbox' ? 'sandbox test company, not your real books' : 'live company'}). Connected ${new Date(s.connectedAt).toLocaleString()}.`),
          s.connectedEnvironment !== s.environment ? h('p', { class: 'err' }, `The server is set to ${s.environment} but this connection is ${s.connectedEnvironment}. Disconnect and connect again.`) : '',
          h('div', { class: 'row' }, h('button', { onclick: guard(err, async () => { if (confirm('Disconnect QuickBooks? Anything already imported stays.')) { await api('DELETE', '/quickbooks'); render(); } }) }, 'Disconnect')),
          live ? qboInvoices(s, rows, err) : '')
      : h('div', {}, h('p', { class: 'muted' }, `Keys found. The server is set to talk to Intuit's ${s.environment === 'sandbox' ? 'SANDBOX (test companies only)' : 'LIVE (real companies only)'} servers (${s.apiHost}). Press Connect, sign in to QuickBooks and choose the company.`), h('p', { class: 'muted', style: 'font-size:13px' }, s.environment === 'sandbox' ? 'Render setting QBO_ENVIRONMENT: ' + JSON.stringify(s.environmentSetting) + ' (sandbox / test company).' : 'Live QuickBooks. QBO_ENVIRONMENT is not set on Render, which is correct for a real company.'),
          h('div', { class: 'row' }, h('button', { class: 'primary', onclick: guard(err, async () => { location.href = (await api('GET', '/quickbooks/connect')).url; }) }, 'Connect QuickBooks'))),
    qboGoLive(s, err));
}
// QuickBooks invoices waiting for review, and the review screen. Importing only happens when a person presses Import (or when a match is
// strong enough and automatic logging is on).
let qbSearch = '';
function qboInvoices(s, rows, err) {
  const counts = s.counts || {}, last = s.lastSync, cfg = s.settings || {};
  const unmatched = rows.filter((r) => r.status === 'New' && !r.project && !r.suggestedProjectId).length;
  const sync = h('button', { class: 'primary', onclick: guard(err, async () => { notice(err, 'Reading QuickBooks…', 'ok'); const r = await api('POST', '/quickbooks/sync', {}); notice(err, `Done. ${r.added} new invoice${r.added === 1 ? '' : 's'}${r.auto ? `, ${r.auto} logged automatically` : ''}${r.needLook ? `, ${r.needLook} matched but need a look` : ''}, ${r.autoPaid} payment${r.autoPaid === 1 ? '' : 's'} added to imported invoices${r.changed ? ', ' + r.changed + ' changed in QuickBooks' : ''}.`, 'ok'); render(); }) }, 'Sync from QuickBooks');
  const pick = h('select', { onchange: () => { qbFilter = pick.value; render(); } }, ['New', 'Changed', 'Imported', 'Ignored', 'All'].map((k) => h('option', { value: k }, k + (counts[k] ? ` (${counts[k]})` : '')))); pick.value = qbFilter;
  const start = h('input', { type: 'date', value: cfg.startDate || '' }), auto = h('input', { type: 'checkbox' }); auto.checked = cfg.autoImport !== false;
  const saveCfg = guard(err, async () => { await api('PUT', '/quickbooks/settings', { startDate: start.value, autoImport: auto.checked }); notice(err, 'Saved. The next sync reads from that date.', 'ok'); render(); });
  const find = h('input', { type: 'search', placeholder: 'Search number, customer or memo…', value: qbSearch, style: 'min-width:22rem', onkeydown: (e) => { if (e.key === 'Enter') { qbSearch = find.value; render(); } } });
  const table = rows.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['Invoice', 'Date', 'QuickBooks customer', 'Total', 'Project', 'Status'].map((t, i) => h('th', { class: i === 3 ? 'n' : '' }, t)), h('th'))),
    h('tbody', {}, rows.map((r) => h('tr', {}, h('td', {}, r.number || r.qbId), h('td', {}, r.date || ''), h('td', {}, r.customer || ''), h('td', { class: 'n' }, usd(r.total)),
      h('td', {}, r.project || (r.suggestedProjectId ? h('span', { class: 'muted', title: r.suggestedBy || '' }, 'Suggested (' + (r.suggestedBy || 'match') + ')') : h('span', { class: 'muted' }, 'Not matched'))),
      h('td', {}, h('span', { class: 'pill ' + (r.status === 'Imported' ? 'Approved' : r.status === 'Changed' ? 'Rejected' : r.status === 'Ignored' ? '' : 'Pending'), title: r.message || '' }, r.status), r.message ? h('div', { class: r.status === 'New' ? 'err' : 'muted', style: 'font-size:12px;max-width:20rem;padding:.25rem .5rem;margin:.2rem 0 0' }, r.message) : ''),
      h('td', {}, r.status === 'New' ? [h('button', { class: 'small primary', onclick: () => qboReview(r) }, 'Review and import'), ' ', h('button', { class: 'small', onclick: guard(err, async () => { await api('POST', `/quickbooks/invoices/${r.id}/ignore`, {}); render(); }) }, 'Ignore')]
        : r.status === 'Ignored' ? h('button', { class: 'small', onclick: guard(err, async () => { await api('POST', `/quickbooks/invoices/${r.id}/restore`, {}); render(); }) }, 'Restore') : ''))))))
    : h('p', { class: 'muted' }, qbSearch ? 'No invoice matches that search.' : qbFilter === 'New' ? 'Nothing waiting. Press Sync from QuickBooks to look for new invoices.' : 'Nothing here.');
  return h('div', { style: 'margin-top:1.2rem;border-top:1px solid var(--line);padding-top:1rem' }, h('div', { class: 'row spread' }, h('h3', { style: 'margin:0' }, 'Client Invoices From QuickBooks (We Billed Them)'), h('div', { class: 'row' }, pick, sync)),
    h('p', { class: 'muted', style: 'font-size:13px' }, (last ? `Last read ${new Date(last.at).toLocaleString()} (${last.invoicesSeen} invoices looked at). ` : 'Not read yet. ') + 'It also checks by itself every hour.'),
    h('div', { class: 'row', style: 'margin:.4rem 0 .8rem' }, h('label', { style: 'margin:0' }, 'Read invoices dated from'), start, h('label', { style: 'margin:0;text-transform:none;letter-spacing:0;font-weight:400' }, auto, ' Log confident matches automatically'), h('button', { class: 'small', onclick: saveCfg }, 'Save')),
    h('div', { class: 'row', style: 'margin-bottom:.6rem' }, find, h('button', { class: 'small', onclick: () => { qbSearch = find.value; render(); } }, 'Search'), qbSearch ? h('button', { class: 'small', onclick: () => { qbSearch = ''; render(); } }, 'Clear') : '',
      qbFilter === 'New' && unmatched ? h('button', { class: 'small', onclick: guard(err, async () => { if (confirm(`Ignore the ${unmatched} invoice${unmatched === 1 ? '' : 's'} that no project was matched to? You can restore any of them from the Ignored list.`)) { const r = await api('POST', '/quickbooks/invoices/ignore-unmatched', {}); notice(err, `${r.ignored} ignored.`, 'ok'); render(); } }) }, `Ignore all not matched (${unmatched})`) : ''),
    table);
}
// Splits an amount over weights to the cent (the same rule the server uses).
const spreadCents = (amount, weights) => { const total = weights.reduce((a, b) => a + b, 0), c = Math.round(amount * 100); let left = c; return weights.map((w, i) => { const part = i === weights.length - 1 ? left : Math.round(c * w / (total || 1)); left -= part; return part / 100; }); };
async function qboReview(inv) {
  const projects = await api('GET', '/projects'); const err = h('div'), body = h('div');
  const proj = h('select', {}, h('option', { value: '' }, 'Choose the project…'), projects.map((p) => h('option', { value: p.id }, `${p.name} (${p.gc})`))); proj.value = inv.projectId || inv.suggestedProjectId || '';
  const ret = num(''); let info = null, ui = [];
  const draw = async () => {
    ui = []; if (!proj.value) { body.replaceChildren(h('p', { class: 'muted' }, 'Choose the project to match the lines to its trades.')); return; }
    const r = await api('GET', `/quickbooks/invoices/${inv.id}/prepare?projectId=${proj.value}`); info = r.project;
    const weights = info.trades.map((t) => t.contract);
    const rowsEl = inv.lines.map((l, i) => {
      if (l.retainage) return h('tr', {}, h('td', {}, l.description || l.itemName), h('td', { class: 'n' }, usd(l.amount)), h('td', { class: 'muted' }, 'Retainage held back'));
      const sel = h('select', { class: r.guess[i] ? '' : 'needs' }, h('option', { value: '' }, 'Choose trade…'), info.trades.map((t) => h('option', { value: t.id }, `${t.name} (room left ${usd(t.room)})`)), h('option', { value: '__spread' }, 'Entire project (spread by contract amount)'), h('option', { value: '__split' }, 'Split across trades by hand…')); sel.value = r.guess[i] || '';
      const inputs = info.trades.map((t) => ({ t, el: num('', { placeholder: '0.00', style: 'width:8rem' }) })), left = h('span', { class: 'muted', style: 'font-size:12px' }), box = h('div', { style: 'display:none;margin-top:.4rem' });
      const upd = () => { const sum = Math.round(inputs.reduce((n, x) => n + (Number(x.el.value) || 0) * 100, 0)); const diff = Math.round(l.amount * 100) - sum; left.textContent = diff === 0 ? 'Adds up to the line.' : `Still to assign: ${usd(diff / 100)}`; left.style.color = diff === 0 ? 'var(--green)' : 'var(--red)'; };
      inputs.forEach((x) => { x.el.oninput = upd; });
      box.append(...inputs.map((x) => h('div', { class: 'row', style: 'gap:.4rem;margin:.15rem 0' }, h('span', { style: 'min-width:9rem' }, x.t.name), x.el)), left);
      sel.onchange = () => { sel.classList.toggle('needs', !sel.value); box.style.display = sel.value === '__split' ? 'block' : 'none'; if (sel.value === '__split' && inputs.every((x) => !x.el.value)) { const parts = spreadCents(l.amount, weights); inputs.forEach((x, k) => { x.el.value = parts[k].toFixed(2); }); upd(); } };
      ui[i] = { sel, inputs };
      return h('tr', {}, h('td', {}, l.description || l.itemName || 'Line ' + (i + 1)), h('td', { class: 'n' }, usd(l.amount)), h('td', {}, sel, box));
    });
    body.replaceChildren(h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'On the QuickBooks invoice'), h('th', { class: 'n' }, 'Amount'), h('th', {}, 'Goes to'))), h('tbody', {}, rowsEl))),
      h('p', { class: 'muted', style: 'font-size:13px' }, info.trades.length ? `A line can go to one trade, to the entire project (shared across the trades by contract amount), or be split by hand. Retainage: leave the box blank for none (or the invoice's own retainage line, if it has one). Type an amount to hold some back.` : 'This project has no trades yet. Add them (or apply the contract) first.'));
  };
  proj.onchange = guard(err, draw); draw().catch((e) => notice(err, e.message));
  const pays = inv.payments.length ? h('p', { class: 'muted wide' }, `Payments already received in QuickBooks: ${inv.payments.map((p) => `${usd(p.amount)} on ${p.date}`).join(', ')}. They are added with the invoice.`) : '';
  formModal(`QuickBooks invoice ${inv.number || inv.qbId} · ${usd(inv.total)} · ${inv.date || ''}`, [h('p', { class: 'muted wide' }, `Customer in QuickBooks: ${inv.customer || '—'}${inv.suggestedBy ? ' · suggested from ' + inv.suggestedBy : ''}`), field('Project', proj, 'wide'), h('div', { class: 'wide' }, body), field('Retainage held (optional)', ret), pays, err],
    async () => {
      const lines = ui.map((u, i) => { if (!u) return null; const v = u.sel.value; if (!v) return null; if (v === '__spread') return { index: i, spread: true }; if (v === '__split') return { index: i, split: u.inputs.filter((x) => Number(x.el.value)).map((x) => ({ projectTradeId: x.t.id, amount: x.el.value })) }; return { index: i, projectTradeId: v }; }).filter(Boolean);
      await api('POST', `/quickbooks/invoices/${inv.id}/import`, { projectId: proj.value, lines, retainageHeld: ret.value }); render();
    }, 'Import');
}
// The invoice-matching page: for anyone given that area, without going through Admin.
// The time clock inside the platform, for a login linked to an employee. Same clock as the field page; hours land on the project and trade.
async function timeclockView() {
  const home = await api('GET', '/me/clock/home'); const ui = makeClockUi({ api, base: '/me/clock', reload: () => render() });
  return shell('timeclock', [h('h1', {}, 'Time Clock'), h('p', { class: 'sub' }, `${home.employee.name}: clock in to a project and trade. Your hours post to that project's labor.`), h('div', { style: 'max-width:560px' }, ...ui.body(home))]);
}
// ------------------------------------------------------------------ Time & Pay (the office's side of the time clock)
let tpTab = 'week', tpStart = null;
const hr2 = (n) => (Math.round(Number(n || 0) * 100) / 100).toFixed(2);
const shiftDay = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const dayLabel = (d) => new Date(String(d).slice(0, 10) + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
// Add a day for someone, or change one: who, where (project or Other), the date, the total, and trades with hours.
async function timeEntryForm(e, onDone) {
  const emps = (await api('GET', '/admin/employees')).filter((x) => x.active || (e && x.id === e.employeeId)), projects = (await api('GET', '/projects')).filter((p) => p.active || (e && p.id === e.projectId));
  const err = h('div'), clocked = e && e.method === 'Clock';
  const who = h('select', { disabled: e ? true : null }, emps.map((x) => h('option', { value: x.id }, x.name))); if (e) who.value = e.employeeId;
  const site = h('select', {}, projects.map((p) => h('option', { value: p.id }, p.name)), h('option', { value: '__other' }, 'Other jobsite…')); if (e) site.value = e.projectId || '__other'; if (e && e.other) site.disabled = true;
  const oName = h('input', { placeholder: 'Jobsite name', value: e?.other ? e.project.replace(/^Other: /, '') : '' }), oWhere = h('input', { placeholder: 'Street, city', value: e?.otherAddress || '' }), oBox = h('div', { class: 'form wide' }, field('Jobsite Name', oName), field('Where Is It?', oWhere));
  const date = h('input', { type: 'date', value: e?.date || todayStr(), max: todayStr(), disabled: clocked ? true : null }), hours = h('input', { type: 'number', step: '0.25', min: '0.25', max: '24', value: e?.totalHours ?? '' }), lunch = h('input', { type: 'number', step: '0.25', min: '0', value: e?.lunchHours ?? 0 });
  const cin = h('input', { type: 'datetime-local', value: clocked ? localInput(e.clockIn) : '' }), cout = h('input', { type: 'datetime-local', value: clocked && e.clockOut ? localInput(e.clockOut) : '' }), notes = h('input', { value: e?.notes || '' }), inj = h('input', { type: 'checkbox' }); inj.checked = !!e?.injured;
  const rowsBox = h('div'); let tradeOpts = [];
  const loadTrades = async () => { tradeOpts = site.value === '__other' ? state.trades.filter((t) => !t.archived).map((t) => ({ id: t.id, name: t.name, k: 'tradeId' })) : ((await api('GET', `/projects/${site.value}`)).trades || []).map((t) => ({ id: t.id, name: t.name, k: 'projectTradeId' })); };
  const addRow = (l) => { const sel = h('select', {}, h('option', { value: '' }, tradeOpts.length ? 'Choose the trade…' : 'No trades'), tradeOpts.map((t) => h('option', { value: t.id }, t.name))); sel.value = l ? (l.projectTradeId || l.tradeId || '') : ''; const amt = h('input', { type: 'number', step: '0.25', min: '0', value: l?.hours ?? '', placeholder: 'Hours (blank = the rest)', style: 'width:11rem' }); const row = h('div', { class: 'trade-row' }, sel, amt, h('button', { class: 'small', type: 'button', onclick: () => row.remove() }, 'Remove')); row._get = () => ({ [tradeOpts[0]?.k || 'projectTradeId']: sel.value || null, hours: amt.value === '' ? 'rest' : amt.value }); rowsBox.append(row); };
  const draw = async () => { oBox.style.display = site.value === '__other' ? '' : 'none'; await loadTrades(); rowsBox.replaceChildren(); (e && site.value === (e.projectId || '__other') ? e.lines : [null]).forEach((l) => addRow(l)); };
  site.onchange = guard(err, draw); await draw();
  formModal(e ? `Change ${e.employee} · ${dayLabel(e.date)}` : 'Add A Day For An Employee', [field('Employee', who), field('Jobsite', site), oBox, field('Date', date), ...(clocked ? [field('Clock In', cin), field('Clock Out', cout), field('Lunch (Hours)', lunch)] : [field('Total Hours', hours)]),
    field('Hours By Trade (the last trade can take the rest)', h('div', {}, rowsBox, h('button', { class: 'small', type: 'button', onclick: () => addRow() }, '+ Another Trade')), 'wide'), field('Notes', notes, 'wide'), h('label', { class: 'wide', style: 'text-transform:none;letter-spacing:0;font-weight:400;display:flex;gap:.5rem;align-items:center' }, inj, 'Injury reported for this day'), err],
  async () => {
    const lines = [...rowsBox.children].map((r) => r._get()).filter((l) => l.projectTradeId || l.tradeId);
    if (e) { const b = { notes: notes.value, injured: inj.checked, lines }; if (clocked) { b.clockIn = new Date(cin.value).toISOString(); if (cout.value) b.clockOut = new Date(cout.value).toISOString(); b.lunchHours = lunch.value; } else { b.totalHours = hours.value; b.date = date.value; } if (!e.other) b.projectId = site.value; await api('PUT', `/time/entries/${e.id}`, b); }
    else await api('POST', '/time/entries', { employeeId: who.value, date: date.value, hours: hours.value, notes: notes.value, injured: inj.checked, lines, ...(site.value === '__other' ? { other: { name: oName.value, address: oWhere.value } } : { projectId: site.value }) });
    onDone();
  }, e ? 'Save' : 'Add Day');
}
async function timePayView() {
  const err = h('div'), sup = isSuper(), canSave = isManager();
  const tabs = h('div', { class: 'tabs' }, [['week', 'Week'], ['all', 'All Time'], ['changes', 'Change Requests']].map(([k, l]) => h('a', { class: tpTab === k ? 'on' : '', href: '#/timepay', onclick: (ev) => { ev.preventDefault(); tpTab = k; render(); } }, l)));
  const sitesTable = (rows, title) => h('div', { class: 'card' }, h('h2', {}, title), rows.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Project / Site'), h('th', {}, 'Trade'), h('th', { class: 'n' }, 'People'), h('th', { class: 'n' }, 'Hours'), sup ? h('th', { class: 'n' }, 'Cost') : '')),
    h('tbody', {}, rows.map((r) => h('tr', {}, h('td', {}, r.projectId ? h('a', { href: `#/projects/${r.projectId}/labor` }, r.site) : r.site), h('td', {}, r.trade), h('td', { class: 'n' }, r.people), h('td', { class: 'n' }, hr2(r.hours)), sup ? h('td', { class: 'n' }, usd(r.cost)) : ''))),
    h('tfoot', {}, h('tr', { class: 'total' }, h('td', { colspan: 3 }, 'Total'), h('td', { class: 'n' }, hr2(rows.reduce((n, r) => n + r.hours, 0))), sup ? h('td', { class: 'n' }, usd(rows.reduce((n, r) => n + (r.cost || 0), 0))) : '')))) : h('p', { class: 'muted' }, 'No hours yet.'));
  let body;
  if (tpTab === 'changes') {
    const [pend, done] = await Promise.all([api('GET', '/time/corrections?status=Pending'), api('GET', '/time/corrections?status=All')]);
    const decide = (c, apply) => guard(err, async () => { const note = apply ? '' : prompt('Reason (optional)') || ''; await api('POST', `/time/corrections/${c.id}/${apply ? 'apply' : 'decline'}`, { note }); render(); });
    body = [h('div', { class: 'card' }, h('h2', {}, `Waiting For You (${pend.length})`), err, h('p', { class: 'muted' }, 'Employees change today and yesterday themselves. Older days come here. Applying a request makes the change and updates labor cost.'),
      pend.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['Employee', 'Day', 'Site', 'Hours Now', 'What They Asked'].map((t) => h('th', {}, t)), h('th'))), h('tbody', {}, pend.map((c) => h('tr', {}, h('td', {}, c.employee), h('td', {}, dayLabel(c.date)), h('td', {}, c.site), h('td', { class: 'n' }, hr2(c.hours)), h('td', { style: 'white-space:normal;max-width:24rem' }, c.message, c.proposal?.totalHours ? h('div', { class: 'muted', style: 'font-size:12px' }, `Suggested hours: ${c.proposal.totalHours}`) : ''),
        h('td', { style: 'white-space:nowrap' }, canSave ? [h('button', { class: 'small primary', onclick: decide(c, true) }, 'Apply'), ' ', h('button', { class: 'small', onclick: decide(c, false) }, 'Decline'), ' ', h('button', { class: 'small', onclick: guard(err, async () => { const all = await api('GET', `/time/entries?from=${c.date}&to=${c.date}`); const en = all.find((x) => x.id === c.entryId); if (en) await timeEntryForm(en, () => render()); }) }, 'Open Day')] : '')))))) : h('p', { class: 'muted' }, 'Nothing waiting.')),
      h('div', { class: 'card' }, h('h2', {}, 'Decided'), done.filter((c) => c.status !== 'Pending').length ? h('table', {}, h('tbody', {}, done.filter((c) => c.status !== 'Pending').slice(0, 30).map((c) => h('tr', {}, h('td', {}, c.employee), h('td', {}, dayLabel(c.date)), h('td', {}, h('span', { class: 'pill ' + (c.status === 'Applied' ? 'Approved' : 'Rejected') }, c.status)), h('td', { class: 'muted', style: 'white-space:normal' }, c.note || c.message))))) : h('p', { class: 'muted' }, 'None yet.'))];
  } else if (tpTab === 'all') {
    const d = await api('GET', '/time/summary?scope=all');
    body = [h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', {}, 'Every Project, All Time'), h('a', { class: 'small', href: '/api/time/export' }, 'Export Everything For Excel')), h('p', { class: 'muted' }, 'Hours stay on a project for as long as the project exists. Other (one-off) jobsites are listed under their own name.')), sitesTable(d.sites, 'Hours' + (sup ? ' And Cost' : '') + ' By Project And Trade')];
  } else {
    const d = await api('GET', '/time/summary?start=' + (tpStart || '')); tpStart = d.start; const week = await api('GET', `/time/entries?from=${d.start}&to=${d.end}`);
    const nav = h('div', { class: 'row', style: 'gap:.5rem;flex-wrap:wrap' }, h('button', { class: 'small', onclick: () => { tpStart = shiftDay(d.start, -7); render(); } }, '‹ Previous Week'), h('strong', {}, `${dayLabel(d.start)} to ${dayLabel(d.end)}`), h('button', { class: 'small', onclick: () => { tpStart = shiftDay(d.start, 7); render(); } }, 'Next Week ›'), h('button', { class: 'small', onclick: () => { tpStart = null; render(); } }, 'This Week'),
      h('a', { class: 'small', href: `/api/time/export?from=${d.start}&to=${d.end}`, style: 'margin-left:auto' }, 'Export This Week For Excel'));
    const people = h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', {}, 'Hours' + (sup ? ' And Pay' : '') + ' By Person'), canSave ? h('button', { class: 'small', onclick: () => timeEntryForm(null, () => render()) }, '+ Add A Day') : ''), err,
      d.people.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Employee'), h('th', { class: 'n' }, 'Days'), h('th', { class: 'n' }, 'Hours'), h('th', { class: 'n' }, 'Regular'), h('th', { class: 'n' }, 'Overtime'), h('th', { class: 'n' }, 'Other Sites'), sup ? h('th', { class: 'n' }, 'Rate') : '', sup ? h('th', { class: 'n' }, 'Pay') : '', h('th', {}, ''))),
        h('tbody', {}, d.people.map((p) => h('tr', { class: p.active ? '' : 'muted' }, h('td', {}, p.name), h('td', { class: 'n' }, p.days), h('td', { class: 'n' }, hr2(p.hours)), h('td', { class: 'n' }, hr2(p.regular)), h('td', { class: 'n' }, hr2(p.overtime)), h('td', { class: 'n' }, hr2(p.otherHours)), sup ? h('td', { class: 'n' }, p.payType === 'daily' ? `${usd(p.rate)}/day` : `${usd(p.rate)}/hr`) : '', sup ? h('td', { class: 'n' }, usd(p.pay)) : '',
          h('td', {}, p.open ? h('span', { class: 'pill Pending' }, 'Clocked In') : '', p.injuries ? h('span', { class: 'pill Rejected', style: 'margin-left:.3rem' }, 'Injury Reported') : '')))),
        h('tfoot', {}, h('tr', { class: 'total' }, h('td', {}, 'Week Total'), h('td'), h('td', { class: 'n' }, hr2(d.totals.hours)), h('td'), h('td'), h('td'), sup ? h('td') : '', sup ? h('td', { class: 'n' }, usd(d.totals.pay)) : '', h('td'))))) : h('p', { class: 'muted' }, 'No time this week.'),
      !sup ? h('p', { class: 'muted', style: 'font-size:13px' }, 'Pay and rates are shown to the owner only.') : '');
    const days = h('div', { class: 'card' }, h('h2', {}, 'Days This Week'), week.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['Day', 'Employee', 'Site', 'Trades'].map((t) => h('th', {}, t)), h('th', { class: 'n' }, 'Hours'), h('th'))),
      h('tbody', {}, week.map((e) => h('tr', {}, h('td', {}, dayLabel(e.date)), h('td', {}, e.employee), h('td', { style: 'white-space:normal' }, e.project, e.other ? h('div', { class: 'muted', style: 'font-size:12px' }, e.otherAddress || '') : ''), h('td', { style: 'white-space:normal' }, e.lines.map((l) => `${l.trade || 'No trade'} ${hr2(l.hours)}h`).join(', ') || (e.status === 'open' ? 'Clocked in' : '—')),
        h('td', { class: 'n' }, e.status === 'open' ? 'open' : hr2(e.totalHours), e.lateIn ? h('span', { class: 'pill Pending', style: 'margin-left:.3rem' }, 'Late') : '', e.injured ? h('span', { class: 'pill Rejected', style: 'margin-left:.3rem', title: e.injuryNote || '' }, 'Injury') : '', e.modified ? h('span', { class: 'pill', style: 'margin-left:.3rem' }, 'Edited') : ''),
        h('td', { style: 'white-space:nowrap' }, canSave && e.status === 'complete' ? [h('button', { class: 'small', onclick: guard(err, () => timeEntryForm(e, () => render())) }, 'Change'), ' '] : '', canSave ? h('button', { class: 'small danger', onclick: guard(err, async () => { if (confirm(`Delete ${e.employee}'s ${dayLabel(e.date)}? Labor cost updates automatically.`)) { await api('DELETE', `/time/entries/${e.id}`); render(); } }) }, 'Delete') : '')))))) : h('p', { class: 'muted' }, 'Nothing this week.'));
    body = [nav, people, sitesTable(d.sites, 'Hours' + (sup ? ' And Cost' : '') + ' By Project And Trade (This Week)'), days];
  }
  return shell('timepay', [h('h1', {}, 'Time & Pay'), tabs, h('p', { class: 'sub' }, 'Weeks run Monday to Sunday. Hours come from the time clock page; add or change a day for anyone here. Everything exports for Excel.'), ...body]);
}
let qbTab = 'invoices', qbCostFilter = 'New', qbCostSearch = '', qbHiddenSearch = '';
async function quickbooksView() {
  const s = await api('GET', '/quickbooks/review'), err = h('div'); const live = s.connected && s.connectedEnvironment === s.environment;
  let body;
  const tabs = h('div', { class: 'tabs' }, [['invoices', 'Client Invoices'], ['costs', 'Vendor Bills & Costs'], ['hidden', 'Hidden']].map(([k, l]) => h('a', { class: qbTab === k ? 'on' : '', href: '#/quickbooks', onclick: (e) => { e.preventDefault(); qbTab = k; render(); } }, l)));
  if (!live) body = h('div', { class: 'card' }, h('p', { class: s.connected ? 'err' : 'muted' }, s.connected ? 'QuickBooks was connected for a different environment than the server now uses. The owner needs to disconnect and connect again in Admin.' : 'QuickBooks is not connected yet. The owner connects it once in Admin → Connections.'), isSuper() ? h('a', { href: '#/admin/connections' }, 'Open the QuickBooks connection') : '');
  else {
    const head = h('p', { class: 'muted', style: 'margin-top:0' }, `Company: ${s.company || '—'}${s.connectedEnvironment === 'sandbox' ? ' (sandbox test company, not the real books)' : ''}`);
    if (qbTab === 'costs') body = h('div', { class: 'card' }, head, err, await qboCosts(err));
    else if (qbTab === 'hidden') body = h('div', { class: 'card' }, head, err, await qboHidden(err));
    else { const rows = await api('GET', '/quickbooks/invoices?status=' + qbFilter + (qbSearch ? '&search=' + encodeURIComponent(qbSearch) : '')); body = h('div', { class: 'card' }, head, err, qboInvoices(s, rows, err)); }
  }
  const sub = { invoices: 'Invoices YOU sent to GCs in QuickBooks. They owe you this money. Match each to a project and its trades so billing, retainage and payments received stay right. Confident matches log themselves; the rest are here for you.', costs: 'Bills, checks, expenses and card charges: money YOU owe vendors and subcontractors, or already paid out. Choose where each one goes: a trade, the whole project, or company overhead.', hidden: 'Vendors and transactions you hid because they are not project costs (taxes, insurance, payroll). Search them, and bring any back.' }[qbTab];
  return shell('quickbooks', [h('h1', {}, 'QuickBooks'), tabs, h('p', { class: 'sub' }, sub), body]);
}
// Costs from QuickBooks: each one is reviewed, then imported as a vendor invoice (or hidden when it is not a project cost).
async function qboCosts(err) {
  const [rows, st] = await Promise.all([api('GET', '/quickbooks/costs?status=' + qbCostFilter + (qbCostSearch ? '&search=' + encodeURIComponent(qbCostSearch) : '')), api('GET', '/quickbooks/costs/status')]);
  const counts = st.counts || {}, last = st.lastSync;
  const sync = h('button', { class: 'primary', onclick: guard(err, async () => { notice(err, 'Reading QuickBooks…', 'ok'); const r = await api('POST', '/quickbooks/costs/sync', {}); notice(err, `Done. ${r.added} new cost${r.added === 1 ? '' : 's'}${r.hidden ? `, ${r.hidden} hidden by what you taught it` : ''}${r.autoPaid ? `, ${r.autoPaid} payment${r.autoPaid === 1 ? '' : 's'} added` : ''}${r.changed ? `, ${r.changed} changed in QuickBooks` : ''}.`, 'ok'); render(); }) }, 'Sync Costs From QuickBooks');
  const pick = h('select', { onchange: () => { qbCostFilter = pick.value; render(); } }, ['New', 'Changed', 'Imported', 'Ignored', 'All'].map((k) => h('option', { value: k }, k + (counts[k] ? ` (${counts[k]})` : '')))); pick.value = qbCostFilter;
  const find = h('input', { type: 'search', placeholder: 'Search vendor, number, memo or account…', value: qbCostSearch, style: 'min-width:22rem', onkeydown: (e) => { if (e.key === 'Enter') { qbCostSearch = find.value; render(); } } });
  const hideAsk = (c) => { const bg = modal(`Hide ${c.vendor || 'this one'}?`, h('div', {}, h('p', {}, 'Use this for things that are not job costs, like taxes, insurance or loan payments. Hidden items leave this list and can be found again on the Hidden tab.'),
    h('div', { class: 'row', style: 'flex-wrap:wrap;gap:.5rem;margin-top:.8rem' }, h('button', { class: 'primary', onclick: guard(err, async () => { const r = await api('POST', `/quickbooks/costs/${c.id}/hide`, { learn: true }); bg.remove(); notice(err, `Hid ${r.hidden} from ${c.vendor || 'this vendor'}. Future ones from them are hidden automatically.`, 'ok'); render(); }) }, `Hide All From ${c.vendor || 'This Vendor'}, Now And Later`),
      h('button', { onclick: guard(err, async () => { await api('POST', `/quickbooks/costs/${c.id}/hide`, { learn: false }); bg.remove(); render(); }) }, 'Hide Just This One')))); };
  const table = rows.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['Date', 'Type', 'Vendor', 'What', 'Total', 'Goes To', 'Status'].map((t, i) => h('th', { class: i === 4 ? 'n' : '' }, t)), h('th'))),
    h('tbody', {}, rows.map((c) => h('tr', {}, h('td', {}, c.date || ''), h('td', {}, c.kind, c.number ? h('div', { class: 'muted', style: 'font-size:12px' }, '#' + c.number) : ''),
      h('td', { style: 'white-space:normal' }, c.vendor || '—', c.isSubcontractor ? h('div', { class: 'muted', style: 'font-size:12px' }, 'Subcontractor: enter on the project Costs tab') : c.looksNonProject && c.status === 'New' ? h('div', { class: 'muted', style: 'font-size:12px' }, 'Looks like a non-project cost') : ''),
      h('td', { style: 'white-space:normal;max-width:22rem' }, (c.lines || []).map((l) => l.description || l.item || l.account).filter(Boolean).slice(0, 2).join('; ') || c.memo || c.account || '', c.account ? h('div', { class: 'muted', style: 'font-size:12px' }, c.account) : ''),
      h('td', { class: 'n' }, usd(c.total), c.kind === 'Bill' && c.balance != null && c.balance < c.total ? h('div', { class: 'muted', style: 'font-size:12px' }, c.balance === 0 ? 'paid' : `${usd(c.total - c.balance)} paid`) : ''),
      h('td', {}, c.suggestedProject ? h('span', { class: 'muted', title: c.suggestedBy || '' }, c.suggestedProject) : c.suggestedOverhead ? h('span', { class: 'muted', title: c.suggestedBy || '' }, 'Overhead: ' + c.suggestedOverhead) : h('span', { class: 'muted' }, 'Not decided')),
      h('td', {}, h('span', { class: 'pill ' + (c.status === 'Imported' ? 'Approved' : c.status === 'Changed' ? 'Rejected' : c.status === 'Ignored' ? '' : 'Pending'), title: c.message || '' }, c.status), c.message ? h('div', { class: c.status === 'New' ? 'err' : 'muted', style: 'font-size:12px;white-space:normal;max-width:16rem' }, c.message) : ''),
      h('td', { style: 'white-space:nowrap' }, c.status === 'New' ? [h('button', { class: 'small primary', onclick: () => qboCostReview(c) }, 'Review And Import'), ' ', h('button', { class: 'small', onclick: () => hideAsk(c) }, 'Hide'), ' ', h('button', { class: 'small', onclick: guard(err, async () => { await api('POST', `/quickbooks/costs/${c.id}/ignore`, {}); render(); }) }, 'Ignore')]
        : c.status === 'Ignored' ? [h('button', { class: 'small', onclick: guard(err, async () => { await api('POST', `/quickbooks/costs/${c.id}/restore`, {}); render(); }) }, 'Restore'), ' ', h('button', { class: 'small', onclick: () => hideAsk(c) }, 'Hide')] : c.invoiceId ? h('a', { href: '#/projects/receipts' }, 'Open In Receipts') : ''))))))
    : h('p', { class: 'muted' }, qbCostSearch ? 'No cost matches that search.' : qbCostFilter === 'New' ? 'Nothing waiting. Press Sync Costs From QuickBooks to look for new bills, checks and expenses.' : 'Nothing here.');
  return h('div', {}, h('div', { class: 'row spread' }, h('h3', { style: 'margin:0' }, 'Vendor Bills And Costs From QuickBooks (We Owe Or Paid)'), h('div', { class: 'row' }, pick, sync)),
    h('p', { class: 'muted', style: 'font-size:13px' }, (last ? `Last read ${new Date(last.at).toLocaleString()} (${last.seen} looked at). ` : 'Not read yet. ') + 'It also checks by itself every hour, from the same start date as invoices. QuickBooks does not share the bank-feed list of transactions waiting for review, only what is already recorded as a bill, check, expense or card charge.'),
    h('div', { class: 'row', style: 'margin-bottom:.6rem' }, find, h('button', { class: 'small', onclick: () => { qbCostSearch = find.value; render(); } }, 'Search'), qbCostSearch ? h('button', { class: 'small', onclick: () => { qbCostSearch = ''; render(); } }, 'Clear') : ''), table);
}
// The hidden list: vendors that are always hidden (with what they hid), and every hidden transaction. Both are searchable.
async function qboHidden(err) {
  const r = await api('GET', '/quickbooks/costs/hidden' + (qbHiddenSearch ? '?search=' + encodeURIComponent(qbHiddenSearch) : ''));
  const find = h('input', { type: 'search', placeholder: 'Search vendor, memo or number…', value: qbHiddenSearch, style: 'min-width:22rem', onkeydown: (e) => { if (e.key === 'Enter') { qbHiddenSearch = find.value; render(); } } });
  const vendors = r.vendors.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Vendor'), h('th', { class: 'n' }, 'Hidden'), h('th', { class: 'n' }, 'Amount'), h('th'))),
    h('tbody', {}, r.vendors.map((v) => h('tr', {}, h('td', {}, v.vendor || '—'), h('td', { class: 'n' }, v.hidden), h('td', { class: 'n' }, usd(v.amount)), h('td', {}, h('button', { class: 'small', onclick: guard(err, async () => { if (confirm(`Stop hiding ${v.vendor}? Its ${v.hidden} hidden item${v.hidden === 1 ? '' : 's'} come back to the Costs list.`)) { await api('DELETE', `/quickbooks/costs/rules/${v.id}`); render(); } }) }, 'Stop Hiding Vendor'))))))) : h('p', { class: 'muted' }, qbHiddenSearch ? 'No hidden vendor matches.' : 'No vendors are hidden for good yet.');
  const items = r.items.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['Date', 'Type', 'Vendor', 'What'].map((t) => h('th', {}, t)), h('th', { class: 'n' }, 'Total'), h('th'))),
    h('tbody', {}, r.items.map((c) => h('tr', {}, h('td', {}, c.date || ''), h('td', {}, c.kind), h('td', {}, c.vendor || '—'), h('td', { style: 'white-space:normal' }, c.memo || c.account || ''), h('td', { class: 'n' }, usd(c.total)), h('td', {}, h('button', { class: 'small', onclick: guard(err, async () => { await api('POST', `/quickbooks/costs/${c.id}/unhide`, {}); render(); }) }, 'Unhide'))))))) : h('p', { class: 'muted' }, qbHiddenSearch ? 'No hidden item matches.' : 'Nothing is hidden.');
  return h('div', {}, h('div', { class: 'row', style: 'margin-bottom:.6rem' }, find, h('button', { class: 'small', onclick: () => { qbHiddenSearch = find.value; render(); } }, 'Search'), qbHiddenSearch ? h('button', { class: 'small', onclick: () => { qbHiddenSearch = ''; render(); } }, 'Clear') : ''),
    h('h3', { style: 'margin:.6rem 0 .3rem' }, 'Vendors Always Hidden'), vendors, h('h3', { style: 'margin:1rem 0 .3rem' }, 'Hidden Transactions'), items);
}
// Where one QuickBooks cost goes: a project (each line to a trade or the whole project), or company overhead.
async function qboCostReview(c) {
  const projects = await api('GET', '/projects'), err = h('div'), body = h('div');
  const mode = h('select', {}, h('option', { value: 'project' }, 'A Project'), h('option', { value: 'overhead' }, 'Company Overhead')); mode.value = c.suggestedProjectId || !c.suggestedOverhead ? 'project' : 'overhead';
  const proj = h('select', {}, h('option', { value: '' }, 'Choose the project…'), projects.filter((p) => p.active).map((p) => h('option', { value: p.id }, `${p.name} (${p.gc})`))); proj.value = c.suggestedProjectId || '';
  const cat = h('select', {}, ['Tools', 'Insurance', 'Vehicles & fuel', 'Office', 'Software', 'Other'].map((k) => h('option', { value: k }, k))); cat.value = c.suggestedOverhead || 'Other';
  const sup = h('select', {}), remember = h('input', { type: 'checkbox' }); remember.checked = true; let sels = [];
  const draw = async () => {
    const isOver = mode.value === 'overhead'; pw.parentElement.style.display = isOver ? 'none' : ''; cw.parentElement.style.display = isOver ? '' : 'none';
    const r = await api('GET', `/quickbooks/costs/${c.id}/prepare${!isOver && proj.value ? '?projectId=' + proj.value : ''}`);
    sup.replaceChildren(h('option', { value: '' }, `New vendor: ${c.vendor || 'type a name'}`), r.suppliers.map((x) => h('option', { value: x.id }, x.name))); if (!sup.dataset.set) { sup.value = r.supplierGuess || ''; sup.dataset.set = '1'; }
    sels = [];
    const rowsEl = c.lines.map((l, i) => { let el; if (isOver) el = h('span', { class: 'muted' }, 'Overhead: ' + cat.value); else if (!r.project) el = h('span', { class: 'muted' }, 'Choose the project first'); else { const s = h('select', {}, h('option', { value: '' }, 'Whole project'), r.project.trades.map((t) => h('option', { value: t.id }, t.name))); s.value = r.guess[i] || ''; sels[i] = s; el = s; }
      return h('tr', {}, h('td', {}, l.description || l.item || l.account || 'Line ' + (i + 1), l.account ? h('div', { class: 'muted', style: 'font-size:12px' }, l.account) : ''), h('td', { class: 'n' }, usd(l.amount)), h('td', {}, el)); });
    const extra = Math.round((c.total - c.lines.reduce((n, l) => n + l.amount, 0)) * 100) / 100;
    body.replaceChildren(h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'On The QuickBooks Entry'), h('th', { class: 'n' }, 'Amount'), h('th', {}, 'Goes To'))), h('tbody', {}, rowsEl))), extra > 0 ? h('p', { class: 'muted', style: 'font-size:13px' }, `${usd(extra)} of tax or fees is added across the lines.`) : '');
  };
  const pw = h('div', {}, proj), cw = h('div', {}, cat);
  mode.onchange = guard(err, draw); proj.onchange = guard(err, draw); cat.onchange = guard(err, draw);
  formModal(`QuickBooks ${c.kind.toLowerCase()} ${c.number ? '#' + c.number : ''} · ${c.vendor || ''} · ${usd(c.total)} · ${c.date || ''}`, [h('p', { class: 'muted wide' }, `${c.account ? 'Paid from / account: ' + c.account + ' · ' : ''}${c.suggestedBy ? 'Suggested from ' + c.suggestedBy : ''}${c.kind === 'Bill' ? ' · A bill is recorded unpaid; payments made in QuickBooks are added automatically.' : ' · Recorded as paid on the date written.'}`),
    field('Goes To', mode), h('div', {}, h('label', {}, 'Project'), pw), h('div', {}, h('label', {}, 'Overhead Category'), cw), field('Vendor In Job Costing', sup), h('div', { class: 'wide' }, body),
    h('label', { class: 'wide', style: 'display:flex;gap:.5rem;align-items:center;text-transform:none;letter-spacing:0;font-weight:400' }, remember, 'Remember this vendor (its Job Costing vendor and where its costs go) for next time'), err],
    async () => {
      const lines = c.lines.map((l, i) => ({ index: i, projectTradeId: sels[i]?.value || null }));
      await api('POST', `/quickbooks/costs/${c.id}/import`, { mode: mode.value, projectId: proj.value || null, overheadCategory: cat.value, lines, supplierId: sup.value || null, supplierName: sup.value ? undefined : c.vendor, remember: remember.checked }); render();
    }, 'Import');
  draw().catch((e) => notice(err, e.message));
}
async function sharepointCard() {
  const s = await api('GET', '/sharepoint/status?test=1'), err = h('div');
  return h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', {}, 'SharePoint (shared project folders)'), s.configured ? h('button', { class: 'small', onclick: () => render() }, 'Test connection') : ''), err,
    !s.configured ? h('div', {}, h('p', { class: 'err' }, 'Not connected yet.'), h('p', { class: 'muted' }, 'Add these settings on the server (Render → Environment): ' + (s.needs || []).join(', ') + '. Everything else keeps working; folders are created once it is connected.')) :
    s.connected ? h('div', {}, h('p', { class: 'ok' }, `Connected to ${s.siteUrl} · library "${s.library}"${s.root ? ' · folders under "' + s.root + '"' : ''}.`), s.webUrl ? h('p', {}, h('a', { href: s.webUrl, target: '_blank', rel: 'noopener' }, 'Open the library in SharePoint')) : '',
      h('p', { class: 'muted' }, 'Accepting an opportunity creates ByOther / year / GC / P-code folders with 01. DL, 02. Proposal, 03. Change Orders, 04. Documents and 05. Material & Equipment Specs. Awarding renames P to C. To work from File Explorer, press Sync on the library in SharePoint once on each PC.')) :
    h('div', {}, h('p', { class: 'err' }, 'Could not connect: ' + (s.error || 'unknown problem')), h('p', { class: 'muted' }, 'Check the four Microsoft settings on the server, that admin consent was granted for Sites.ReadWrite.All, and that the secret has not expired.')));
}

// Super Admin only: where the AI usage goes, by person, task and day.
async function aiReportCard() {
  const days = state.aiDays || 30, r = await api('GET', `/ai/report?days=${days}`), err = h('div'); const th = (t, n) => h('th', { class: n ? 'n' : '' }, t); const fmt = (n) => Number(n).toLocaleString(); const money = (v) => (v == null ? '—' : '$' + v.toFixed(2));
  const kpi = (l, v, sub2) => h('div', { class: 'kpi' }, h('div', { class: 'l' }, l), h('div', { class: 'v' }, v), sub2 ? h('div', { class: 'muted', style: 'font-size:12px' }, sub2) : '');
  const maxDay = Math.max(1, ...r.byDay.map((d) => d.tokens)), maxUser = Math.max(1, ...r.byUser.map((d) => d.tokens)), maxTask = Math.max(1, ...r.byTask.map((d) => d.tokens));
  const bar = (v, max, tone = 'var(--navy)') => h('div', { style: `background:#eef0f4;border-radius:6px;height:10px;min-width:120px` }, h('div', { style: `width:${Math.max(2, Math.round((v / max) * 100))}%;background:${tone};height:10px;border-radius:6px` }));
  const days2 = h('div', { class: 'seg' }, [7, 30, 90, 365].map((d) => h('button', { type: 'button', class: d === days ? 'on' : '', onclick: () => { state.aiDays = d; render(); } }, d === 365 ? '1 year' : d + ' days')));
  const inP = num(r.rates.inputPerM ?? '', { step: '0.01', placeholder: 'e.g. 3.00' }), outP = num(r.rates.outputPerM ?? '', { step: '0.01', placeholder: 'e.g. 15.00' });
  const table = (head, rows) => rows.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, head.map(([t, n]) => th(t, n)))), h('tbody', {}, rows))) : h('p', { class: 'muted' }, 'No AI use in this period.');
  return h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', {}, 'AI usage and spending'), days2), err,
    h('div', { class: 'grid kpis' }, kpi('AI calls', fmt(r.total.calls), `avg ${fmt(r.total.avgTokensPerCall)} tokens each`), kpi('Tokens in', fmt(r.total.input)), kpi('Tokens out', fmt(r.total.output)), kpi('Estimated cost', r.priced ? money(r.total.cost) : 'Set prices', r.priced ? 'from your prices below' : 'enter prices to see dollars'),
      kpi('This month vs cap', r.month.pctOfCap == null ? '—' : r.month.pctOfCap + '%', `${fmt(r.month.tokens)} of ${fmt(r.month.cap)} tokens`)),
    h('h3', { style: 'margin:1rem 0 .3rem' }, 'By person'), table([['Person'], ['Calls', 1], ['Tokens', 1], ['Est. cost', 1], ['']], r.byUser.map((u) => h('tr', {}, h('td', {}, u.who), h('td', { class: 'n' }, fmt(u.calls)), h('td', { class: 'n' }, fmt(u.tokens)), h('td', { class: 'n' }, money(u.cost)), h('td', {}, bar(u.tokens, maxUser))))),
    h('h3', { style: 'margin:1rem 0 .3rem' }, 'By task'), table([['Task'], ['Calls', 1], ['Tokens', 1], ['Avg per call', 1], ['Est. cost', 1], ['']], r.byTask.map((t) => h('tr', {}, h('td', {}, t.task), h('td', { class: 'n' }, fmt(t.calls)), h('td', { class: 'n' }, fmt(t.tokens)), h('td', { class: 'n' }, fmt(Math.round(t.tokens / Math.max(1, t.calls)))), h('td', { class: 'n' }, money(t.cost)), h('td', {}, bar(t.tokens, maxTask, '#5b6cc9'))))),
    h('h3', { style: 'margin:1rem 0 .3rem' }, 'Who does what'), table([['Person'], ['Task'], ['Calls', 1], ['Tokens', 1], ['Est. cost', 1]], r.byUserTask.map((x) => h('tr', {}, h('td', {}, x.who), h('td', {}, x.task), h('td', { class: 'n' }, fmt(x.calls)), h('td', { class: 'n' }, fmt(x.tokens)), h('td', { class: 'n' }, money(x.cost))))),
    h('h3', { style: 'margin:1rem 0 .3rem' }, 'By day'), r.byDay.length ? h('div', {}, r.byDay.map((d) => h('div', { class: 'row', style: 'gap:.6rem;margin:.15rem 0' }, h('span', { class: 'muted', style: 'width:84px;font-size:13px' }, d.day), h('div', { style: 'flex:1' }, bar(d.tokens, maxDay)), h('span', { style: 'width:150px;text-align:right;font-size:13px' }, `${fmt(d.tokens)} · ${d.calls} call${d.calls === 1 ? '' : 's'}`)))) : h('p', { class: 'muted' }, 'No AI use in this period.'),
    r.byMonth.length > 1 ? h('div', {}, h('h3', { style: 'margin:1rem 0 .3rem' }, 'By month'), table([['Month'], ['Calls', 1], ['Tokens', 1], ['Est. cost', 1]], r.byMonth.map((m) => h('tr', {}, h('td', {}, m.month), h('td', { class: 'n' }, fmt(m.calls)), h('td', { class: 'n' }, fmt(m.tokens)), h('td', { class: 'n' }, money(m.cost)))))) : '',
    h('h3', { style: 'margin:1rem 0 .3rem' }, 'Latest calls'), table([['When'], ['Person'], ['Task'], ['What it read'], ['In', 1], ['Out', 1], ['Est. cost', 1]], r.recent.map((c) => h('tr', {}, h('td', {}, new Date(c.at).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })), h('td', {}, c.who), h('td', {}, c.task), h('td', { class: 'muted' }, c.label || ''), h('td', { class: 'n' }, fmt(c.input)), h('td', { class: 'n' }, fmt(c.output)), h('td', { class: 'n' }, money(c.cost))))),
    h('div', { style: 'margin-top:1rem;border-top:1px solid var(--line);padding-top:.8rem' }, h('label', {}, 'Prices for the dollar estimate (US$ per million tokens)'), h('div', { class: 'row' }, h('label', { style: 'margin:0' }, 'Input'), inP, h('label', { style: 'margin:0' }, 'Output'), outP, h('button', { onclick: guard(err, async () => { await api('PUT', '/settings/ai', { inputPerM: inP.value, outputPerM: outP.value }); render(); }) }, 'Save prices')),
      h('p', { class: 'muted', style: 'font-size:13px' }, 'Take the two prices from Anthropic\'s pricing page for the model in use. These are estimates; your Anthropic Console bill is the real number. Failed calls are not counted. The full list can be exported from Reports → AI usage.')));
}


// ------------------------------------------------------------------ messages and to-dos
const LINK_KINDS = [['project', 'Project'], ['document', 'Document'], ['vendor', 'Subcontractor'], ['supplier', 'Vendor'], ['receipt', 'Receipt'], ['opportunity', 'Opportunity']];
// A small "attach a record" control: choose a kind, search, click a result. Used by messages and to-dos alike.
function linkPicker(initial = []) {
  const chosen = [...initial]; const chips = h('div', { class: 'row', style: 'gap:.4rem;margin-bottom:.4rem' }); const results = h('div');
  const kind = h('select', {}, LINK_KINDS.map(([v, l]) => h('option', { value: v }, l))); const term = h('input', { placeholder: 'Search to attach…' });
  const drawChips = () => chips.replaceChildren(...chosen.map((c, i) => h('span', { class: 'pill', style: 'cursor:pointer', title: 'Remove', onclick: () => { chosen.splice(i, 1); drawChips(); } }, `${c.label} ×`)));
  const search = async () => { try { const r = await api('GET', `/search/records?kind=${kind.value}&q=${encodeURIComponent(term.value)}`); results.replaceChildren(...r.map((x) => h('button', { type: 'button', class: 'small', style: 'margin:.15rem', onclick: () => { if (!chosen.some((c) => c.id === x.id && c.kind === x.kind)) chosen.push(x); drawChips(); } }, x.label)), r.length ? '' : h('span', { class: 'muted' }, 'No matches.')); } catch (e) { results.replaceChildren(h('span', { class: 'muted' }, e.message)); } };
  term.oninput = search; kind.onchange = search; drawChips();
  return { el: h('div', {}, chips, h('div', { class: 'row' }, kind, term), results), get: () => chosen.map((c) => ({ kind: c.kind, id: c.id })) };
}
const linkChips = (links) => (links || []).map((l) => h('a', { class: 'pill', style: 'margin-right:.3rem;text-decoration:none', href: l.route || '#', target: l.route && l.route.startsWith('/api') ? '_blank' : null }, l.label));
async function messagesView(id) {
  const tab = id === 'todos' ? 'todos' : 'conv'; const err = h('div');
  let b = { unread: 0, total: 0 }; try { b = await api('GET', '/messages/badge'); } catch { /* the tabs just show no numbers */ }
  const bub = (n, hot) => (n ? h('span', { class: 'bubble' + (hot ? ' hot' : ''), style: 'display:inline-block' }, n) : '');
  const tabs = h('div', { class: 'tabs' }, h('a', { class: tab === 'conv' ? 'on' : '', href: '#/messages' }, 'Conversations', bub(b.unread)), h('a', { class: tab === 'todos' ? 'on' : '', href: '#/messages/todos' }, 'To-Do List', bub(b.total - b.unread, b.overdue > 0)));
  return shell('messages', [h('h1', {}, 'Messages & to-dos'), tabs, err, tab === 'todos' ? await todosPanel(err) : await conversationsPanel(id, err)]);
}
async function conversationsPanel(openId, err) {
  const [threads, dir] = await Promise.all([api('GET', '/threads'), api('GET', '/team/directory')]); const others = dir.filter((u) => u.id !== state.user.id);
  const compose = () => {
    const subject = h('input'), body = h('textarea', { rows: 4 }), lp = linkPicker(); const boxes = others.map((u) => { const c = h('input', { type: 'checkbox' }); c._id = u.id; return [u, c]; });
    formModal('New message', [field('To', h('div', { class: 'row' }, boxes.map(([u, c]) => h('label', { style: 'text-transform:none;letter-spacing:0;font-size:15px;font-weight:400;margin:0' }, c, ` ${u.name || u.email}${u.title ? ' · ' + u.title : ''}`))), 'wide'), field('Subject', subject, 'wide'), field('Message', body, 'wide'), field('Attach records', lp.el, 'wide')],
      async () => { const r = await api('POST', '/threads', { subject: subject.value, body: body.value, memberIds: boxes.filter(([, c]) => c.checked).map(([, c]) => c._id), links: lp.get() }); location.hash = '#/messages/' + r.id; render(); }, 'Send');
  };
  const list = h('div', { class: 'card', style: 'padding:.4rem' }, threads.length ? threads.map((t) => h('a', { href: '#/messages/' + t.id, style: `display:block;padding:.6rem .7rem;border-radius:8px;text-decoration:none;color:inherit;${t.id === openId ? 'background:var(--navy-soft)' : ''}` },
    h('div', { style: 'font-weight:' + (t.unread ? '700' : '400') + ';font-family:Calibri,Carlito,sans-serif' }, t.subject, t.unread ? h('span', { class: 'pill Pending', style: 'margin-left:.4rem' }, t.unread) : ''), h('div', { class: 'muted', style: 'font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis' }, `${t.last_from}: ${t.last_body}`))) : h('p', { class: 'muted', style: 'padding:.6rem' }, 'No conversations yet.'));
  let pane = h('div', { class: 'card soon' }, 'Pick a conversation, or start a new one.');
  if (openId && openId !== 'todos') {
    const t = await api('GET', '/threads/' + openId); const body = h('textarea', { rows: 3, placeholder: 'Write a reply…' }); const lp = linkPicker();
    pane = h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', {}, t.subject), h('span', { class: 'muted' }, t.members.map((m) => m.name || '').join(', '))),
      t.messages.map((m) => h('div', { style: `margin:.6rem 0;padding:.6rem .8rem;border-radius:10px;background:${m.mine ? 'var(--navy-soft)' : '#f4f5f8'}` }, h('div', { class: 'muted', style: 'font-size:12px' }, `${m.from} · ${new Date(m.at).toLocaleString()}`), h('div', { style: 'white-space:pre-wrap' }, m.body), m.links.length ? h('div', { style: 'margin-top:.4rem' }, linkChips(m.links)) : '')),
      t.todos.length ? h('div', { style: 'margin:.8rem 0' }, h('label', {}, 'To-dos from this conversation'), t.todos.map((d) => h('div', {}, `${d.status === 'Done' ? '✓' : '○'} ${d.title}${d.dueDate ? ' · due ' + d.dueDate : ''}${d.assignedTo ? ' · ' + d.assignedTo : ''}`))) : '',
      h('div', { style: 'margin-top:1rem' }, body, h('div', { style: 'margin-top:.4rem' }, lp.el), h('div', { class: 'row', style: 'margin-top:.6rem;justify-content:space-between' }, h('button', { onclick: () => todoForm(null, openId, () => render()) }, '+ To-do from this conversation'), h('button', { class: 'primary', onclick: guard(err, async () => { await api('POST', `/threads/${openId}/messages`, { body: body.value, links: lp.get() }); render(); }) }, 'Send'))));
  }
  return h('div', {}, h('div', { class: 'row', style: 'margin-bottom:.8rem' }, h('button', { class: 'primary', onclick: compose }, '+ New message')), h('div', { style: 'display:grid;grid-template-columns:minmax(220px,300px) 1fr;gap:1rem;align-items:start' }, list, pane));
}
const PRIORITY_PILL = { Urgent: 'Rejected', High: 'Pending', Normal: '', Low: '' };
const priorityPill = (p) => (p && p !== 'Normal' ? h('span', { class: 'pill ' + (PRIORITY_PILL[p] || ''), style: 'margin-right:.4rem' }, p) : '');
async function todoForm(todo, threadId, done) {
  const dir = await api('GET', '/team/directory');
  const f = { title: h('input', { value: todo?.title ?? '' }), notes: h('textarea', { rows: 2 }), start: h('input', { type: 'date', value: todo?.startDate ?? todayStr() }), due: h('input', { type: 'date', value: todo?.dueDate ?? '' }), who: h('select', {}, dir.map((u) => h('option', { value: u.id }, u.name || u.email))),
    pri: h('select', {}, ['Low', 'Normal', 'High', 'Urgent'].map((v) => h('option', { value: v }, v))) };
  f.notes.value = todo?.notes ?? ''; f.who.value = todo?.assignedToId || state.user.id; f.pri.value = todo?.priority || 'Normal'; const lp = linkPicker([]);
  formModal(todo ? 'Edit To-Do' : 'Add a To-Do', [field('What needs doing', f.title, 'wide'), field('Notes', f.notes, 'wide'), field('Start', f.start), field('Due', f.due), field('Priority', f.pri), field('Assign to', f.who),
    h('div', { class: 'wide' }, h('label', {}, 'Attach Records (Optional)'), lp.el, h('p', { class: 'muted', style: 'font-size:12px;margin:.2rem 0 0' }, 'Leave this empty for a general to-do that is not about any one project or record.'))],
    async () => { const b = { title: f.title.value, notes: f.notes.value, startDate: f.start.value || null, dueDate: f.due.value || null, assignedToId: f.who.value, priority: f.pri.value, links: lp.get() }; if (todo) await api('PUT', '/todos/' + todo.id, b); else await api('POST', '/todos', { ...b, threadId }); done(); }, todo ? 'Save' : 'Add To-Do');
}
// One to-do opened: its details, the notes log with comments from different people, and sending it on as a message.
async function todoDetail(t, done) {
  const err = h('div'), logBox = h('div'), dir = await api('GET', '/team/directory');
  const draw = async () => { const rows = await api('GET', `/todos/${t.id}/comments`); logBox.replaceChildren(...(rows.length ? rows.map((c) => h('div', { style: `margin:.35rem 0;padding:.45rem .7rem;border-radius:8px;background:${c.kind === 'System' ? 'transparent' : 'var(--navy-soft)'}` }, h('div', { class: 'muted', style: 'font-size:12px' }, `${c.kind === 'System' ? 'Log' : c.who || 'Someone'} · ${new Date(c.at).toLocaleString()}`), h('div', { style: `white-space:pre-wrap;${c.kind === 'System' ? 'color:var(--muted);font-size:13px' : ''}` }, c.body))) : [h('p', { class: 'muted' }, 'Nothing logged yet.')])); };
  const text = h('textarea', { rows: 2, placeholder: 'Add a comment…' });
  const add = guard(err, async () => { if (!text.value.trim()) return; await api('POST', `/todos/${t.id}/comments`, { body: text.value }); text.value = ''; await draw(); });
  const sendOn = () => {
    const others = dir.filter((u) => u.id !== state.user.id), boxes = others.map((u) => { const c = h('input', { type: 'checkbox' }); c._id = u.id; return [u, c]; }), note = h('textarea', { rows: 2, placeholder: 'Optional note to go with it' });
    formModal('Send To-Do As A Message', [field('To', h('div', {}, boxes.map(([u, c]) => h('label', { style: 'display:block;text-transform:none;letter-spacing:0;font-size:15px;font-weight:400;margin:.15rem 0' }, c, ` ${u.name || u.email}${u.title ? ' · ' + u.title : ''}`))), 'wide'), field('Note', note, 'wide')],
      async () => { const r = await api('POST', `/todos/${t.id}/send`, { userIds: boxes.filter(([, c]) => c.checked).map(([, c]) => c._id), body: note.value }); location.hash = '#/messages/' + r.threadId; done(); }, 'Send');
  };
  const bg = modal(t.title, h('div', {}, err,
    h('div', { class: 'row', style: 'margin-bottom:.4rem' }, priorityPill(t.priority), h('span', { class: 'muted' }, `Assigned to ${t.assignedTo || '—'} · starts ${t.startDate || '—'} · due ${t.dueDate || '—'}${t.overdue ? ' · OVERDUE' : ''} · added by ${t.createdBy}`)),
    t.notes ? h('p', { style: 'white-space:pre-wrap' }, t.notes) : '', t.links.length ? h('div', { style: 'margin:.3rem 0' }, linkChips(t.links)) : '',
    h('h3', { style: 'margin:.9rem 0 .2rem' }, 'Notes And Comments'), logBox, text,
    h('div', { class: 'row', style: 'margin-top:.6rem;justify-content:space-between' }, h('div', { class: 'row' }, h('button', { onclick: () => { bg.remove(); todoForm(t, null, done); } }, 'Edit'), h('button', { onclick: sendOn }, 'Send As Message')), h('button', { class: 'primary', onclick: add }, 'Add Comment'))));
  draw().catch((e) => notice(err, e.message));
}
async function todosPanel(err) {
  const view = state.todoView || { who: 'me', status: 'Open' };
  const rows = await api('GET', `/todos?status=${view.status}${view.who === 'me' ? '&assignedTo=me' : '&all=1'}`);
  const set = (k, v) => { state.todoView = { ...view, [k]: v }; render(); };
  const who = h('select', { onchange: (e) => set('who', e.target.value) }, [['me', 'Mine'], ['all', 'Everyone']].map(([v, l]) => h('option', { value: v }, l))); who.value = view.who;
  const status = h('select', { onchange: (e) => set('status', e.target.value) }, ['Open', 'Done'].map((v) => h('option', { value: v }, v))); status.value = view.status;
  if (view.who === 'me' && view.status === 'Open' && rows.some((t) => t.isNew)) { await api('POST', '/todos/seen', {}).catch(() => {}); }   // opening the list is seeing what is new
  return h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('div', { class: 'row' }, who, status), h('button', { class: 'primary', onclick: () => todoForm(null, null, render) }, '+ Add To-Do')),
    rows.length ? h('div', { class: 'scroll', style: 'margin-top:.6rem' }, h('table', {}, h('thead', {}, h('tr', {}, ['', 'To-Do', 'Priority', 'Attached', 'Assigned To', 'Starts', 'Due', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, rows.map((t) => h('tr', {}, h('td', {}, h('input', { type: 'checkbox', checked: t.status === 'Done' ? true : null, onchange: guard(err, async (e) => { await api('PUT', '/todos/' + t.id, { status: e.target.checked ? 'Done' : 'Open' }); render(); }) })), h('td', { style: 'white-space:normal' }, h('a', { href: 'javascript:void(0)', style: 'text-decoration:none;color:inherit;font-weight:600', onclick: () => todoDetail(t, render) }, t.title), t.isNew ? h('span', { class: 'pill Pending', style: 'margin-left:.4rem' }, 'New') : '', t.notes ? h('div', { class: 'muted', style: 'font-size:13px' }, t.notes) : ''), h('td', {}, priorityPill(t.priority) || h('span', { class: 'muted' }, 'Normal')), h('td', { style: 'white-space:normal' }, t.links.length ? linkChips(t.links) : h('span', { class: 'muted' }, 'General')), h('td', {}, t.assignedTo || '—'), h('td', {}, t.startDate || '—'),
        h('td', {}, t.dueDate || '—', t.overdue ? h('span', { class: 'pill Expired', style: 'margin-left:.4rem' }, 'Overdue') : ''), h('td', {}, h('button', { class: 'small', onclick: () => todoForm(t, null, render) }, 'Edit'), ' ', h('button', { class: 'small danger', onclick: guard(err, async () => { if (confirm('Delete this to-do?')) { await api('DELETE', '/todos/' + t.id); render(); } }) }, 'Delete'))))))) : h('p', { class: 'muted', style: 'margin-top:.8rem' }, view.status === 'Open' ? 'Nothing open. Add a to-do for yourself or anyone on the team.' : 'Nothing completed yet.'));
}



// ------------------------------------------------------------------ local folders (browser File System Access API)
// A web page cannot read your drives on its own. In Chrome or Edge you pick a folder once (for example your synced
// OneDrive or iCloud Drive folder) and grant access; then this page can create folders and save files inside it.
const hasFolderAccess = () => typeof window.showDirectoryPicker === 'function';
async function pickFolder() { return window.showDirectoryPicker({ mode: 'readwrite', id: 'byother-root' }); }
async function makePath(root, path) { let d = root; for (const part of path.split('/').filter(Boolean)) d = await d.getDirectoryHandle(part, { create: true }); return d; }
async function writeFile(dir, name, blob) { const safe = name.replace(/[\\/:*?"<>|]/g, '_'); const fh = await dir.getFileHandle(safe, { create: true }); const w = await fh.createWritable(); await w.write(blob); await w.close(); return safe; }
async function createProposalFolders(plan) { const root = await pickFolder(); const base = await makePath(root, plan.root); for (const f of plan.folders) await makePath(base, f); return `${root.name}/${plan.root}`; }
async function saveDocToFolder(doc) { const root = await pickFolder(); const res = await fetch(`/api/documents/${doc.id}/file`); if (!res.ok) throw new Error('Could not download that file.'); return `${root.name}/${await writeFile(root, doc.name.includes('.') ? doc.name : doc.name + '.pdf', await res.blob())}`; }
const folderNote = () => (hasFolderAccess() ? '' : h('p', { class: 'muted', style: 'font-size:13px' }, 'Saving to a folder on your computer works in Chrome or Edge on a desktop. In this browser, use the download links instead.'));

// ------------------------------------------------------------------ estimating (its own file)
dashboardUi.init({ api, state, render, shell });
estimating.init({ api, state, render, shell, uploadFile, hasFolderAccess, createProposalFolders, folderNote, isSuper, canEstimate: () => ['Super Admin', 'Sub Admin', 'Estimator'].includes(state.user.role) });
const estimatingView = estimating.estimatingView;

// ------------------------------------------------------------------ admin
// Admin master records. Every section uses the same add/edit form as the rest of the app.
const POSITIONS = ['', 'Skilled Labor', 'Carpenter', 'Carpenter Helper', 'Foreman', 'Supervisor'];
const SECTIONS = [
  { kind: 'trades', title: 'Trades', one: 'trade', fields: [['name', 'Name', 'text'], ['sort', 'Order', 'number']], archive: 'archived' },
  { kind: 'gcs', title: 'GCs', one: 'GC', fields: [['name', 'Name', 'text'], ['contact_name', 'Contact Person', 'text'], ['email', 'Email', 'email'], ['phone', 'Phone', 'text'], ['address', 'Address', 'address']], archive: 'archived' },
  { kind: 'subcontractors', title: 'Subcontractors (labor, vetted)', one: 'subcontractor', fields: [['name', 'Name', 'text'], ['contact_name', 'Contact Person', 'text'], ['email', 'Email', 'email'], ['phone', 'Phone', 'text'], ['address', 'Address', 'address']], archive: 'archived', extra: (r, err) => (isSuper() && !r.verified ? [h('button', { class: 'small', title: 'Verify this subcontractor by hand so they can be paid', onclick: guard(err, async () => { if (confirm(`Verify ${r.name} without a complete, unexpired W-9 and insurance on file?\n\nOnly you can do this. They will be treated as verified and can be paid. You can take it back by editing them.`)) { await api('POST', `/admin/subcontractors/${r.id}/verify`, { override: true }); render(); } }) }, 'Verify')] : []) },
  { kind: 'suppliers', title: 'Vendors (materials, lodging, equipment, purchases)', one: 'vendor', fields: [['name', 'Name', 'text'], ['provider_type', 'Type', ['Materials', 'Hotel / Lodging', 'Equipment', 'Other purchase']], ['credit_limit', 'Credit limit', 'number'], ['website', 'Website', 'text'], ['email', 'Email', 'email'], ['phone', 'Phone', 'text'], ['address', 'Address', 'address']], archive: 'archived' },
  { kind: 'employees', title: 'Employees (1099 crew, time clock)', one: 'employee', fields: [['name', 'Name', 'text'], ['position', 'Position', POSITIONS], ['pay_type', 'Pay type', ['hourly', 'daily']], ['hourly_rate', 'Rate ($/hr or $/day)', 'number'], ['phone', 'Phone', 'text'], ['email', 'Email', 'email'], ['address', 'Address (for the 1099)', 'address']], archive: 'active', invert: true, extra: (r, err) => [h('button', { class: 'small', onclick: () => pinForm(r) }, r.pin_default ? 'PIN: Automatic' : 'Change PIN')] },
];
const visibleFields = (sec) => sec.fields.filter(([k]) => !(sec.kind === 'employees' && ['pay_type', 'hourly_rate'].includes(k) && !isSuper()));
const tableCols = (sec) => [...visibleFields(sec).filter(([k]) => !['address', 'credit_limit', 'phone', 'email', 'pay_type'].includes(k) || (sec.kind !== 'employees' && ['phone', 'email', 'credit_limit'].includes(k))), ...(sec.kind === 'subcontractors' ? [['_verified', 'Verification']] : []), ...(sec.kind === 'employees' ? [['_tax', '1099 Info']] : [])];
function pinForm(emp) {
  const pin = h('input', { type: 'password', inputmode: 'numeric', maxlength: 8, autocomplete: 'new-password', placeholder: '4 to 8 digits' }), err = h('div');
  formModal(`Time Clock PIN For ${emp.name}`, [h('p', { class: 'wide' }, emp.pin_default ? 'Right now this employee uses the automatic PIN: the last 4 digits of their phone number, or 0000 when there is no number.' : 'This employee has a PIN you chose.'), field('Choose A PIN', pin, 'wide'),
    h('div', { class: 'wide' }, h('button', { type: 'button', class: 'small', onclick: guard(err, async () => { await api('PUT', `/admin/employees/${emp.id}/pin`, { default: true }); render(); }) }, 'Use The Automatic PIN Instead'), err),
    h('p', { class: 'muted wide' }, 'The employee uses the PIN on the time clock page to clock in and to see their own hours and pay. Setting a PIN also clears any lockout.')], async () => { await api('PUT', `/admin/employees/${emp.id}/pin`, { pin: pin.value }); render(); }, 'Save PIN');
}
function recordForm(sec, rec, done) {
  const addr = visibleFields(sec).some(([, , t]) => t === 'address') ? addressBlock(api, { kind: 'other', init: rec ? { street: rec.address, city: rec.city, state: rec.state, zip: rec.zip, verified: rec.address_verified } : null, label: 'Address (optional)' }) : null;
  const inputs = Object.fromEntries(visibleFields(sec).filter(([, , t]) => t !== 'address').map(([k, , t]) => {
    const el = Array.isArray(t) ? h('select', {}, t.map((o) => h('option', { value: o }, o || '—'))) : h('input', { type: t === 'number' ? 'number' : t === 'email' ? 'email' : 'text', step: t === 'number' ? '0.01' : null });
    if (rec && rec[k] != null) el.value = rec[k];
    return [k, el];
  }));
  // A subcontractor's paperwork goes in right here: the W-9 and a certificate of insurance (with its expiry) or a workers' comp exemption.
  // Files are kept with the record and in its SharePoint folder; the address on the W-9 is compared with the verified address above.
  const docs = sec.kind === 'employees' ? (() => {   // a 1099 crew member's W-9: private to the owner and Sub Admin, and the address on it must match
    const have = rec?.w9, w9 = h('input', { type: 'file', accept: '.pdf,.png,.jpg,.jpeg' });
    return { employee: true, el: h('div', { class: 'wide', style: 'border-top:1px solid var(--line);margin-top:.4rem;padding-top:.6rem' }, h('label', {}, 'W-9 (Needed For The 1099)'), field('W-9 File', h('div', {}, w9, h('div', {}, have ? h('span', { class: 'ok', style: 'font-size:13px' }, 'W-9 on file. Choose a file to replace it.') : h('span', { class: 'muted', style: 'font-size:13px' }, 'No W-9 on file yet.')))), h('p', { class: 'muted', style: 'font-size:12px' }, 'It holds a tax number, so it stays private in the platform (not copied to SharePoint) and only the owner and Sub Admin can open it. The address you verify above must match the address on the W-9.')), w9 }; })() : sec.kind === 'subcontractors' ? (() => {
    const oerr = h('div'), have = rec?.docs || {}, w9 = h('input', { type: 'file', accept: '.pdf,.png,.jpg,.jpeg' }), kind = h('select', {}, h('option', { value: '' }, rec ? 'Leave as it is' : 'Add the insurance later'), h('option', { value: 'COI' }, 'Certificate Of Insurance (COI)'), h('option', { value: 'Exemption' }, 'Workers Comp Exemption')), file = h('input', { type: 'file', accept: '.pdf,.png,.jpg,.jpeg' }), exp = h('input', { type: 'date' });
    const status = (c, l) => (have[c] ? h('span', { class: 'ok', style: 'font-size:13px' }, `${l} on file${have[c].expires ? ' (expires ' + have[c].expires + ')' : ''}. Choose a file to replace it.`) : h('span', { class: 'muted', style: 'font-size:13px' }, `No ${l} on file yet.`));
    const overrideRow = isSuper() && rec?.override ? h('div', { class: 'wide' }, h('p', { class: 'muted', style: 'margin:.2rem 0' }, 'This subcontractor was verified by hand (an override), not by its documents.'), h('button', { type: 'button', class: 'small', onclick: guard(oerr, async () => { await api('POST', `/admin/subcontractors/${rec.id}/verify`, { override: false }); render(); }) }, 'Remove The Override')) : '';
    return { el: h('div', { class: 'wide', style: 'border-top:1px solid var(--line);margin-top:.4rem;padding-top:.6rem' }, overrideRow, h('label', {}, 'Documents (needed before this subcontractor can be paid)'), h('div', { class: 'form' }, field('W-9', h('div', {}, w9, h('div', {}, status('W-9', 'W-9')))), field('Insurance', kind), field('Insurance File', h('div', {}, file, h('div', {}, status('COI', 'Certificate'), ' ', status('Exemption', 'Exemption')))), field('Insurance Expires', exp)),
      h('p', { class: 'muted', style: 'font-size:12px' }, 'A W-9 and an insurance certificate that has not expired (or a workers comp exemption) make a subcontractor verified. The files are also saved in SharePoint under ByOther / Subcontractors / this company or person.'), oerr),
      w9, kind, file, exp }; })() : null;
  const pin = sec.kind === 'employees' && !rec ? h('input', { type: 'password', inputmode: 'numeric', maxlength: 8, autocomplete: 'new-password', placeholder: '4 to 8 digits (optional now)' }) : null;
  formModal(rec ? `Edit ${rec.name}` : `Add ${sec.one}`, [...visibleFields(sec).filter(([, , t]) => t !== 'address').map(([k, l]) => field(l, inputs[k])), addr ? h('div', { class: 'wide' }, addr.head, addr.el) : '', docs ? docs.el : '', pin ? field('Time clock PIN', pin) : ''], async () => {
    const body = {}; if (addr) Object.assign(body, addr.payload()); for (const [k, , t] of visibleFields(sec).filter(([, , t]) => t !== 'address')) { const v = inputs[k].value; if (t === 'number') { if (v !== '') body[k] = Number(v); } else if (v !== '' || rec) body[k] = v; }
    const saved = await api(rec ? 'PUT' : 'POST', `/admin/${sec.kind}${rec ? '/' + rec.id : ''}`, body);
    if (pin && pin.value) await api('PUT', `/admin/employees/${saved.id}/pin`, { pin: pin.value });
    if (docs) {
      const up = async (cat, f, extra = '') => { const r = await uploadFile(`/documents/upload?category=${encodeURIComponent(cat)}&subcontractorId=${saved.id}${extra}`, f); return r; };
      if (docs.employee) {
        const empUp = docs.w9.files[0] ? await uploadFile(`/documents/upload?category=W-9&employeeId=${saved.id}`, docs.w9.files[0]) : null; const e = (await api('GET', '/admin/employees')).find((x) => x.id === saved.id);
        if (e && (empUp || !e.tax_ready)) { done(); modal(e.tax_ready ? `${e.name}: 1099 Information Is Complete` : `${e.name}: 1099 Information Is Not Complete`, h('div', {}, e.tax_ready ? h('p', { class: 'ok' }, 'The address is verified and matches the W-9.') : [h('p', {}, 'Still needed:'), h('ul', {}, e.tax_blockers.map((b) => h('li', {}, b)))], e.name_note ? h('p', { class: 'muted' }, e.name_note) : '')); return; }
        done(); return;
      }
      if (docs.w9.files[0]) await up('W-9', docs.w9.files[0]);
      if (docs.kind.value) { if (!docs.file.files[0]) throw new Error('Choose the insurance file.'); if (docs.kind.value === 'COI' && !docs.exp.value) throw new Error('Enter when the certificate of insurance expires.'); await up(docs.kind.value, docs.file.files[0], docs.exp.value ? `&expiresOn=${docs.exp.value}` : ''); }
      const v = (await api('GET', '/compliance/vendors')).find((x) => x.id === saved.id);
      if (v) { done(); modal(v.verified ? `${v.name} Is Verified` : `${v.name} Is Not Verified Yet`, h('div', {}, v.verified ? h('p', { class: 'ok' }, 'The W-9 and insurance are on file. This subcontractor can be paid.') : [h('p', {}, 'They cannot be paid until:'), h('ul', {}, v.blockers.map((b) => h('li', {}, b)))], v.folderUrl ? h('p', {}, h('a', { href: v.folderUrl, target: '_blank', rel: 'noopener' }, 'Open Their SharePoint Folder')) : '')); return; }
    }
    done();
  }, rec ? 'Save' : 'Add');
}
let showOneTime = false;
async function adminSection(sec) {
  const all = await api('GET', '/admin/' + sec.kind), oneTime = sec.kind === 'suppliers' ? all.filter((r) => r.one_time) : [], rows = sec.kind === 'suppliers' && !showOneTime ? all.filter((r) => !r.one_time) : all; const err = h('div'); const cols = tableCols(sec);
  const isOff = (r) => (sec.invert ? r[sec.archive] === false : r[sec.archive] === true);
  const flag = (r) => (sec.invert ? !r[sec.archive] : !r[sec.archive]);
  return h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', {}, sec.title), h('button', { class: 'primary', onclick: () => recordForm(sec, null, render) }, `+ Add ${sec.one}`)), err,
    oneTime.length ? h('label', { style: 'display:flex;gap:.5rem;align-items:center;text-transform:none;letter-spacing:0;font-weight:400;font-size:14px' }, h('input', { type: 'checkbox', checked: showOneTime || null, onchange: (e) => { showOneTime = e.target.checked; render(); } }), `Show ${oneTime.length} one-time vendor${oneTime.length === 1 ? '' : 's'} (single purchases that were not saved to the list)`) : '',
    rows.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, cols.map(([, l]) => h('th', {}, l)), h('th'))),
      h('tbody', {}, rows.map((r) => h('tr', { class: isOff(r) ? 'muted' : '' }, cols.map(([k]) => (k === '_tax' ? h('td', { style: 'white-space:normal;min-width:13rem' }, h('span', { class: 'pill ' + (r.tax_ready ? 'Valid' : 'Expired'), title: (r.tax_blockers || []).join('; ') }, r.tax_ready ? 'Ready' : 'Not Ready'), r.tax_ready ? '' : h('div', { class: 'muted', style: 'font-size:12px' }, (r.tax_blockers || []).slice(0, 2).join('; ')), r.name_note ? h('div', { class: 'muted', style: 'font-size:12px' }, r.name_note) : '', r.address_verified && ['Unread', 'Mismatch'].includes(r.address_match) && r.w9 ? h('div', {}, h('button', { class: 'small', style: 'margin-top:.3rem', onclick: guard(err, async () => { if (confirm(`Compare the address on the W-9 with ${[r.address, r.city, [r.state, r.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')}. Are they the same place?`)) { await api('POST', `/admin/employees/${r.id}/confirm-address`, {}); render(); } }) }, 'The W-9 Shows This Address')) : '') : k === '_verified' ? h('td', { style: 'white-space:normal' }, h('span', { class: 'pill ' + (r.verified ? 'Valid' : 'Expired'), title: (r.blockers || []).join('; ') }, r.verified ? 'Verified' : 'Unverified'), r.verified ? '' : h('div', { class: 'muted', style: 'font-size:12px' }, (r.blockers || []).slice(0, 2).join('; ')), r.folder_url ? h('div', {}, h('a', { href: r.folder_url, target: '_blank', rel: 'noopener', style: 'font-size:12px' }, 'SharePoint Folder')) : '') : h('td', {}, r[k] ?? ''))), h('td', {},
        h('button', { class: 'small', onclick: () => recordForm(sec, r, render) }, 'Edit'), ' ', sec.extra ? [sec.extra(r, err), ' '] : '', r.one_time ? [h('button', { class: 'small', title: 'Add it to the vendor list so it can be chosen next time', onclick: guard(err, async () => { await api('PUT', `/admin/suppliers/${r.id}`, { one_time: false }); render(); }) }, 'Save As Vendor'), ' '] : '',
        h('button', { class: 'small', onclick: guard(err, async () => { await api('PUT', `/admin/${sec.kind}/${r.id}`, { [sec.archive]: flag(r) }); render(); }) }, sec.invert ? (r[sec.archive] ? 'Deactivate' : 'Activate') : (r[sec.archive] ? 'Restore' : 'Archive')), ' ',
        h('button', { class: 'small danger', onclick: guard(err, async () => { if (confirm(`Delete ${r.name}?`)) { await api('DELETE', `/admin/${sec.kind}/${r.id}`); render(); } }) }, 'Delete'))))))) : h('p', { class: 'muted' }, `No ${sec.title.toLowerCase()} yet.`));
}
const ROLE_LIST = ['Sub Admin', 'Exec Assistant', 'Estimator', 'Project Manager']; // Super Admin is the owner only
// Which parts of the system a person can use, and which dashboard cards they see. Untouched = what their role gives.
function accessEditor(u, roleSel, opt) {
  const box = (id, label, on) => { const c = h('input', { type: 'checkbox', value: id }); c.checked = on; return { id, c, el: h('label', { style: 'display:flex;gap:.5rem;align-items:center;margin:.15rem 0;text-transform:none;letter-spacing:0;font-weight:400;font-size:14px' }, c, label) }; };
  const roleAreas = () => opt.roleAreas[roleSel.value] || [];
  const customA = h('input', { type: 'checkbox' }), customW = h('input', { type: 'checkbox' }); customA.checked = !!u?.access?.areas; customW.checked = !!u?.access?.widgets;
  const areas = opt.areas.map((a) => box(a.id, a.label, (u?.access?.areas ?? roleAreas()).includes(a.id))), widgets = opt.widgets.map((w) => box(w.id, w.label, (u?.access?.widgets ?? opt.widgets.map((x) => x.id)).includes(w.id)));
  const sync = () => { areas.forEach((a) => { a.c.disabled = !customA.checked; if (!customA.checked) a.c.checked = roleAreas().includes(a.id); }); widgets.forEach((w) => { w.c.disabled = !customW.checked; if (!customW.checked) w.c.checked = true; }); };
  roleSel.addEventListener('change', sync); customA.onchange = sync; customW.onchange = sync; sync();
  const el = h('div', { class: 'wide', style: 'border-top:1px solid var(--line);margin-top:.5rem;padding-top:.6rem' },
    h('label', {}, 'Where this person can work'),
    h('label', { style: 'display:flex;gap:.5rem;align-items:center;text-transform:none;letter-spacing:0;font-weight:400;font-size:14px' }, customA, 'Choose by hand (otherwise the access level above decides)'), h('div', { style: 'margin:.3rem 0 .8rem 1.4rem' }, areas.map((a) => a.el)),
    h('label', {}, 'What shows on their dashboard'),
    h('label', { style: 'display:flex;gap:.5rem;align-items:center;text-transform:none;letter-spacing:0;font-weight:400;font-size:14px' }, customW, 'Choose the cards by hand (otherwise everything their access allows)'), h('div', { style: 'margin:.3rem 0 0 1.4rem' }, widgets.map((w) => w.el)),
    h('p', { class: 'muted', style: 'font-size:12px;margin-top:.5rem' }, 'Giving an area the access level does not normally have lets that person work in it as an office assistant would. Approving payments and the owner settings are never included.'));
  return { el, get: () => (customA.checked || customW.checked ? { areas: customA.checked ? areas.filter((a) => a.c.checked).map((a) => a.id) : null, widgets: customW.checked ? widgets.filter((w) => w.c.checked).map((w) => w.id) : null } : null) };
}
async function usersSection() {
  const rows = await api('GET', '/admin/users'); const err = h('div'); const opt = await api('GET', '/access/options'); const emps = (await api('GET', '/admin/employees')).filter((e) => e.active);
  const userForm = (u) => {
    const f = { email: h('input', { type: 'email', value: u?.email ?? '', disabled: !!u }), name: h('input', { value: u?.name ?? '' }), title: h('input', { value: u?.title ?? '', placeholder: 'Estimator, Exec Assistant…' }), phone: h('input', { type: 'tel', value: u?.phone ?? '', placeholder: 'Used in follow-up emails' }), role: h('select', {}, ROLE_LIST.map((r) => h('option', { value: r }, r))), pw: h('input', { type: 'password', autocomplete: 'new-password', placeholder: u ? 'Leave blank to keep' : 'Min 10 characters' }) };
    f.emp = h('select', {}, h('option', { value: '' }, 'Not linked (no time clock)'), emps.filter((e) => !rows.some((x) => x.employee_id === e.id && x.id !== u?.id)).map((e) => h('option', { value: e.id }, e.name))); f.emp.value = u?.employee_id || '';
    if (u) f.role.value = u.role;
    const owner = u?.role === 'Super Admin'; const acc = owner ? null : accessEditor(u, f.role, opt);
    formModal(u ? `Edit ${u.email}` : 'Add user', [field('Company email', f.email), field('Name', f.name), field('Title', f.title), field('Phone', f.phone), field('Time Clock (Link To An Employee)', f.emp), ...(owner ? [h('p', { class: 'muted' }, 'This is the owner account. Its access level stays Super Admin. Change your password with the Password button at the top.')] : [field('Access level', f.role), field(u ? 'New password' : 'Password', f.pw)]), ...(acc ? [acc.el] : [])], async () => {
      if (u) { const body = { name: f.name.value, title: f.title.value, phone: f.phone.value, employeeId: f.emp.value || null }; if (!owner) { body.role = f.role.value; body.access = acc.get(); if (f.pw.value) body.password = f.pw.value; } await api('PUT', '/admin/users/' + u.id, body); }
      else await api('POST', '/admin/users', { email: f.email.value, name: f.name.value, title: f.title.value, phone: f.phone.value, role: f.role.value, password: f.pw.value, access: acc.get(), employeeId: f.emp.value || null });
      render();
    }, u ? 'Save' : 'Add user');
  };
  return h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', {}, 'Users & access'), h('button', { class: 'primary', onclick: () => userForm(null) }, '+ Add user')), err,
    h('p', { class: 'muted' }, 'Super Admin: owner only. Sub Admin and Exec Assistant manage records and money. Estimators work the estimating funnel. Project Managers see assigned projects.'),
    h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['Email', 'Name', 'Title', 'Access', 'Areas', 'Active'].map((t) => h('th', {}, t)), h('th'))),
      h('tbody', {}, rows.map((u) => h('tr', { class: u.active ? '' : 'muted' }, h('td', {}, u.email), h('td', {}, u.name), h('td', {}, u.title || ''), h('td', {}, u.role), h('td', { class: 'muted', style: 'font-size:13px' }, (u.employee ? `Clock: ${u.employee} · ` : '') + (u.role === 'Super Admin' ? 'Everything' : u.access ? [u.access.areas ? `${u.access.areas.length} chosen` : 'Role default', u.access.widgets ? ` · ${u.access.widgets.length} dashboard cards` : ''] : 'Role default')), h('td', {}, u.active ? 'Yes' : 'No'),
        h('td', {}, u.role === 'Super Admin' ? [h('button', { class: 'small', onclick: () => userForm(u) }, 'Edit'), ' ', h('span', { class: 'muted' }, 'Owner')] : [h('button', { class: 'small', onclick: () => userForm(u) }, 'Edit'), ' ', h('button', { class: 'small', onclick: guard(err, async () => { await api('PUT', '/admin/users/' + u.id, { active: !u.active }); render(); }) }, u.active ? 'Deactivate' : 'Activate')])))))));
}
// Every Admin section folds away under its own title. Which ones are open is remembered in this browser only.
const ADMIN_OPEN_KEY = 'byother.admin.open';
const adminOpen = () => { try { return new Set(JSON.parse(localStorage.getItem(ADMIN_OPEN_KEY) || '[]')); } catch { return new Set(); } };
const saveAdminOpen = (set) => { try { localStorage.setItem(ADMIN_OPEN_KEY, JSON.stringify([...set])); } catch { /* private window: it just will not be remembered */ } };
function collapsible(card, open) {
  const heading = card.querySelector && card.querySelector('h2'); if (!heading) return card;
  const title = heading.textContent.trim(); heading.style.display = 'none';   // the fold's own title replaces it
  const d = h('details', { class: 'adm', 'data-title': title.toLowerCase() }, h('summary', {}, title), card); d.open = open.has(title);
  d.addEventListener('toggle', () => { const cur = adminOpen(); if (d.open) cur.add(title); else cur.delete(title); saveAdminOpen(cur); });
  return d;
}
// Admin is split into four tabs so each one is short, and only the open tab is loaded. The URL is #/admin/<tab>.
const ADMIN_GROUPS = [
  ['lists', 'Lists', 'Create vendors, subcontractors, employees, trades and GCs here. Projects pick from these lists. Archive instead of delete once a record has history.'],
  ['company', 'Company', 'People and access, time clock rules, and company overhead.'],
  ['connections', 'Connections', 'Gmail bid invitations, SharePoint folders and QuickBooks.'],
  ['ai', 'AI', 'The AI reading limits, and who has used how much.'],
];
async function adminCards(group) {
  const top = ['Super Admin', 'Sub Admin'].includes(state.user.role), parts = [];
  if (group === 'lists') for (const s of SECTIONS) parts.push(await adminSection(s));
  else if (group === 'company') { if (isSuper()) parts.push(await usersSection()); parts.push(await clockSettingsCard()); if (top) parts.push(await overheadCard()); }
  else if (group === 'connections') { if (isSuper()) parts.push(await googleSigninCard()); if (top) parts.push(await bidFeedCard()); if (isSuper()) { parts.push(await sharepointCard()); parts.push(await quickbooksCard()); } }
  else if (group === 'ai') { parts.push(await aiCard()); if (isSuper()) parts.push(await aiReportCard()); }
  return parts;
}
async function adminView(group) {
  const top = ['Super Admin', 'Sub Admin'].includes(state.user.role);
  const shown = ADMIN_GROUPS.filter(([g]) => g !== 'connections' || top);   // Connections is for the owner and Sub Admin
  const cur = shown.find(([g]) => g === group) || shown[0];
  const parts = await adminCards(cur[0]);
  const open = adminOpen(), folds = parts.map((c) => collapsible(c, open));
  const setAll = (on) => { const set = on ? new Set(folds.filter((f) => f.tagName === 'DETAILS').map((f) => f.querySelector('summary').textContent)) : new Set(); saveAdminOpen(set); folds.forEach((f) => { if (f.tagName === 'DETAILS') f.open = on; }); };
  const find = h('input', { type: 'search', placeholder: 'Find a section…', style: 'max-width:16rem', oninput: () => { const t = find.value.trim().toLowerCase(); folds.forEach((f) => { if (f.tagName === 'DETAILS') f.hidden = !!t && !f.dataset.title.includes(t); }); } });
  return shell('admin', [h('h1', {}, 'Admin'), h('div', { class: 'tabs' }, shown.map(([g, label]) => h('a', { class: g === cur[0] ? 'on' : '', href: '#/admin/' + g }, label))), h('p', { class: 'sub' }, cur[2]),
    folds.length > 1 ? h('div', { class: 'row', style: 'margin-bottom:.8rem' }, find, h('button', { class: 'small', onclick: () => setAll(true) }, 'Open all'), h('button', { class: 'small', onclick: () => setAll(false) }, 'Close all')) : '', ...folds]);
}

// ------------------------------------------------------------------ reports
const OPS_LABEL = [['eq', 'is'], ['neq', 'is not'], ['contains', 'contains'], ['gt', '>'], ['gte', '≥'], ['lt', '<'], ['lte', '≤'], ['empty', 'is empty'], ['notempty', 'is not empty']];
const fmtCell = (v, type) => (v == null || v === '' ? '' : type === 'money' ? usd(v) : type === 'bool' ? (v ? 'Yes' : 'No') : type === 'number' ? (Math.round(v * 100) / 100).toLocaleString() : String(v));
async function reportsView() {
  const { sources, presets } = await api('GET', '/reports/sources'); const saved = (await api('GET', '/prefs/reports')).views || []; const err = h('div');
  const cfg = state.report || (state.report = { source: sources[0].id, columns: null, filters: [], groupBy: '', measures: [], sort: { col: '', dir: 'desc' }, dateRange: { col: '', from: '', to: '' } });
  const src = sources.find((x) => x.id === cfg.source) || sources[0]; if (src.id !== cfg.source) cfg.source = src.id;
  const out = h('div'); const redraw = () => render();
  const srcSel = h('select', { onchange: (e) => { Object.assign(cfg, { source: e.target.value, columns: null, filters: [], groupBy: '', measures: [], sort: { col: '', dir: 'desc' }, dateRange: { col: '', from: '', to: '' } }); out.replaceChildren(); redraw(); } }, [...new Set(sources.map((x) => x.group))].map((g) => h('optgroup', { label: g }, sources.filter((x) => x.group === g).map((x) => h('option', { value: x.id }, x.label))))); srcSel.value = src.id;
  const loadCfg = (c) => { Object.assign(cfg, { source: c.source, columns: c.columns || null, filters: c.filters || [], groupBy: c.groupBy || '', measures: (c.measures || []).map((m) => (typeof m === 'string' ? m : m.col)), sort: c.sort || { col: '', dir: 'desc' }, dateRange: c.dateRange || { col: '', from: '', to: '' } }); redraw(); };
  const quick = h('select', { onchange: (e) => { const p = presets.find((x) => x.name === e.target.value); if (p) loadCfg(p); } }, h('option', { value: '' }, 'Quick reports…'), presets.map((p) => h('option', { value: p.name }, p.name)));
  const mine = h('select', { onchange: (e) => { const v = saved.find((x) => x.name === e.target.value); if (v) loadCfg(v.config); } }, h('option', { value: '' }, `My saved reports (${saved.length})…`), saved.map((v) => h('option', { value: v.name }, v.name)));
  const numCols = src.columns.filter((c) => ['money', 'number'].includes(c.type));
  const colBoxes = src.columns.map((c) => h('label', { style: 'text-transform:none;letter-spacing:0;font-size:14px;font-weight:400;display:inline-flex;gap:.3rem;margin:0 .8rem .3rem 0' }, h('input', { type: 'checkbox', checked: !cfg.columns || cfg.columns.includes(c.key) ? true : null, onchange: (e) => { const cur = cfg.columns || src.columns.map((x) => x.key); cfg.columns = e.target.checked ? src.columns.map((x) => x.key).filter((k) => cur.includes(k) || k === c.key) : cur.filter((k) => k !== c.key); } }), c.label));
  const meas = numCols.map((c) => h('label', { style: 'text-transform:none;letter-spacing:0;font-size:14px;font-weight:400;display:inline-flex;gap:.3rem;margin:0 .8rem .3rem 0' }, h('input', { type: 'checkbox', checked: cfg.measures.includes(c.key) ? true : null, onchange: (e) => { cfg.measures = e.target.checked ? [...cfg.measures, c.key] : cfg.measures.filter((k) => k !== c.key); } }), c.label));
  const grp = h('select', { onchange: (e) => (cfg.groupBy = e.target.value) }, h('option', { value: '' }, 'No grouping (list every row)'), src.columns.filter((c) => !['money'].includes(c.type)).map((c) => h('option', { value: c.key }, 'Group by ' + c.label))); grp.value = cfg.groupBy;
  const filterRows = h('div', {}, cfg.filters.map((f, i) => { const cs = h('select', { onchange: (e) => (f.col = e.target.value) }, src.columns.map((c) => h('option', { value: c.key }, c.label))), os = h('select', { onchange: (e) => (f.op = e.target.value) }, OPS_LABEL.map(([v, l]) => h('option', { value: v }, l))), vi = h('input', { value: f.value ?? '', placeholder: 'value', oninput: (e) => (f.value = e.target.value) }); cs.value = f.col; os.value = f.op; return h('div', { class: 'row', style: 'margin-bottom:.4rem' }, cs, os, vi, h('button', { class: 'small', onclick: () => { cfg.filters.splice(i, 1); redraw(); } }, '×')); }));
  const dateCols = src.columns.filter((c) => c.type === 'date'); const dr = dateCols.length ? h('div', { class: 'row' }, h('label', { style: 'margin:0' }, 'Dates'), h('select', { onchange: (e) => (cfg.dateRange.col = e.target.value) }, h('option', { value: '' }, 'Any'), dateCols.map((c) => h('option', { value: c.key }, c.label))), h('input', { type: 'date', value: cfg.dateRange.from, onchange: (e) => (cfg.dateRange.from = e.target.value) }), '→', h('input', { type: 'date', value: cfg.dateRange.to, onchange: (e) => (cfg.dateRange.to = e.target.value) })) : '';
  if (dr) dr.querySelector('select').value = cfg.dateRange.col;
  const sortSel = h('select', { onchange: (e) => (cfg.sort.col = e.target.value) }, h('option', { value: '' }, 'Sort: default'), src.columns.map((c) => h('option', { value: c.key }, 'Sort by ' + c.label))); sortSel.value = cfg.sort.col; const dirSel = h('select', { onchange: (e) => (cfg.sort.dir = e.target.value) }, [['desc', 'High to low'], ['asc', 'Low to high']].map(([v, l]) => h('option', { value: v }, l))); dirSel.value = cfg.sort.dir;
  const body = () => ({ source: cfg.source, columns: cfg.groupBy ? undefined : cfg.columns || undefined, filters: cfg.filters.filter((f) => f.col), groupBy: cfg.groupBy || undefined, measures: cfg.groupBy ? cfg.measures : undefined, sort: cfg.sort.col ? cfg.sort : undefined, dateRange: cfg.dateRange.col ? cfg.dateRange : undefined });
  const exec = guard(err, async () => { const r = await api('POST', '/reports/run', body()); state.reportResult = r; showResult(r); });
  function showResult(r) {
    const th = (c) => h('th', { class: ['money', 'number'].includes(c.type) ? 'n' : '' }, c.label);
    out.replaceChildren(h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', {}, `${r.title}${cfg.groupBy ? ' (grouped)' : ''} · ${r.total} row${r.total === 1 ? '' : 's'}${r.truncated ? ', showing the first ' + r.rows.length : ''}`), h('div', { class: 'row' }, h('button', { onclick: guard(err, async () => { const name = prompt('Name this report'); if (!name) return; const views = [...saved.filter((v) => v.name !== name), { name, config: body() }]; await api('PUT', '/prefs/reports', { views }); render(); }) }, 'Save this report'), h('button', { class: 'primary', onclick: guard(err, async () => { const res = await fetch('/api/reports/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body()) }); if (!res.ok) throw new Error((await res.json()).error || 'Export failed.'); const blob = await res.blob(); const a = h('a', { href: URL.createObjectURL(blob), download: (res.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'report.csv' }); document.body.append(a); a.click(); a.remove(); }) }, 'Export CSV'))),
      r.rows.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, r.columns.map(th))), h('tbody', {}, r.rows.map((row) => h('tr', {}, r.columns.map((c) => h('td', { class: ['money', 'number'].includes(c.type) ? 'n' : '' }, fmtCell(row[c.key], c.type)))))), Object.keys(r.totals).length ? h('tfoot', {}, h('tr', { class: 'total' }, r.columns.map((c, i) => h('td', { class: ['money', 'number'].includes(c.type) ? 'n' : '' }, i === 0 ? 'Totals' : r.totals[c.key] != null ? fmtCell(r.totals[c.key], c.type) : '')))) : '')) : h('p', { class: 'muted' }, 'No rows match.')));
  }
  if (state.reportResult && state.reportResult.source === cfg.source) showResult(state.reportResult);
  return shell('reports', [h('div', { class: 'row spread' }, h('h1', {}, 'Reports'), h('div', { class: 'row' }, quick, mine)), h('p', { class: 'sub' }, 'Every kind of record in the system can be reported on. Pick a source, choose what to show, filter, group and total, then export to Excel (CSV).'), err,
    h('div', { class: 'card' }, h('div', { class: 'form' }, field('Report on', srcSel), field('Group', grp), field('Order', h('div', { class: 'row' }, sortSel, dirSel))),
      cfg.groupBy ? h('div', { style: 'margin-top:.8rem' }, h('label', {}, 'Totals to show per group'), meas.length ? meas : h('span', { class: 'muted' }, 'This source has nothing to add up; rows will be counted.')) : h('div', { style: 'margin-top:.8rem' }, h('label', {}, 'Columns'), colBoxes),
      h('div', { style: 'margin-top:.8rem' }, h('label', {}, 'Filters'), filterRows, h('button', { class: 'small', onclick: () => { cfg.filters.push({ col: src.columns[0].key, op: 'contains', value: '' }); redraw(); } }, '+ Add filter')), dr ? h('div', { style: 'margin-top:.8rem' }, dr) : '',
      h('div', { class: 'row', style: 'margin-top:1rem' }, h('button', { class: 'primary', onclick: exec }, 'Run report'), h('button', { onclick: () => { state.report = null; state.reportResult = null; render(); } }, 'Start over'))), out]);
}

// ------------------------------------------------------------------ router
async function boot() {
  try { state.user = (await api('GET', '/me')).user; } catch { state.user = null; }
  if (state.user) { try { [state.trades, state.gcs] = await Promise.all([api('GET', '/admin/trades'), api('GET', '/admin/gcs')]); } catch { /* PM lacks nothing here; ignore */ } }
  render();
}
let rendering = 0;
async function render() {
  const token = ++rendering;
  if (!state.user) { $app.replaceChildren(loginView()); return; }
  const [, page = 'dashboard', id, tab] = location.hash.split('/');
  try {
    if (['admin'].includes(page) || (page === 'projects' && !id)) [state.trades, state.gcs] = await Promise.all([api('GET', '/admin/trades'), api('GET', '/admin/gcs')]).catch(() => [state.trades, state.gcs]);
    const view = page === 'estimating' ? await estimatingView(id, tab) : page === 'messages' ? await messagesView(id) : page === 'timeclock' ? await timeclockView() : page === 'timepay' ? await timePayView() : page === 'quickbooks' ? await quickbooksView() : page === 'admin' ? await adminView(id) : page === 'receipts' || (page === 'projects' && id === 'receipts') || (page === 'projects' && !id && !state.user.areas?.includes('projects') && state.user.areas?.includes('costs')) ? await receiptsView() : page === 'compliance' ? await complianceView() : page === 'projects' ? (id ? await projectView(id, tab) : await projectsView()) : page === 'reports' ? await reportsView() : await dashboardView();
    if (token === rendering) { $app.replaceChildren(view); updateBell(); updateMessagesBadge(); }
  } catch (e) { if (token === rendering && state.user) $app.replaceChildren(shell(page, h('div', { class: 'err' }, e.message))); }
}
addEventListener('hashchange', render);
boot();
