// byOther Project Desk front end. All data is inserted with textContent (never innerHTML).
import { h, usd, pct, cls, notice, guard, modal, formModal, field, todayStr, num } from '/ui.js';
import * as estimating from '/estimating.js';
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
  const nav = [['dashboard', 'Dashboard']]; if (isManager() || state.user.role === 'Estimator') nav.push(['estimating', 'Estimating']); nav.push(['projects', 'Projects'], ['messages', 'Messages'], ['reports', 'Reports']);
  if (isManager()) nav.push(['receipts', 'Receipts'], ['compliance', 'Compliance'], ['admin', 'Admin']);
  return h('div', {},
    h('header', { class: 'top' },
      h('a', { href: '#/dashboard' }, h('img', { class: 'logo', src: '/logo.png', alt: 'ByOther Construction' })),
      h('nav', {}, nav.map(([id, label]) => h('a', { href: '#/' + id, class: active === id ? 'on' : '' }, label))),
      h('button', { class: 'small', id: 'bell', onclick: openNotifications, title: 'Notifications' }, 'Alerts'),
      h('span', { class: 'who' }, `${state.user.name || state.user.email} · ${state.user.role}`),
      h('button', { class: 'small', onclick: async () => { await api('POST', '/logout', {}); state.user = null; render(); } }, 'Sign out')),
    h('main', {}, content));
}

function loginView() {
  const err = h('div'); const email = h('input', { type: 'email', autocomplete: 'username', required: true }); const pw = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const form = h('form', { onsubmit: guard(err, async (e) => { e.preventDefault(); const r = await api('POST', '/login', { email: email.value, password: pw.value }); state.user = r.user; location.hash = '#/dashboard'; await boot(); }) },
    h('img', { src: '/logo.png', alt: 'ByOther Construction' }), h('div', { class: 'card' },
      h('div', {}, h('label', {}, 'Company email'), email), h('div', { style: 'margin-top:.8rem' }, h('label', {}, 'Password'), pw), err,
      h('button', { class: 'primary', style: 'width:100%;margin-top:.8rem', type: 'submit' }, 'Sign in')));
  return h('div', { class: 'login' }, form);
}

// ------------------------------------------------------------------ dashboard
const WIDGET_TITLES = { estimating: 'Estimating', presence: 'Time clock: who is in', costing: 'Costing at a glance', chart: 'Billed vs. cost', receivables: 'Owed to us (aging)', payables: 'We owe', projects: 'Projects', forecast: 'Forecast', compliance: 'Compliance & approvals', overhead: 'Company overhead', todos: 'My to-dos' };
function barChart(series, mode) {
  const rows = mode === 'quarter' ? Object.values(series.reduce((m, x) => { const [y, mo] = x.month.split('-'); const k = `${y} Q${Math.ceil(Number(mo) / 3)}`; (m[k] ||= { label: k, revenue: 0, cost: 0 }); m[k].revenue += x.revenue; m[k].cost += x.cost; return m; }, {})) : series.map((x) => ({ label: new Date(x.month + '-15').toLocaleDateString(undefined, { month: 'short' }), revenue: x.revenue, cost: x.cost }));
  const W = 560, H = 210, pad = { l: 8, r: 8, t: 12, b: 26 }, max = Math.max(1, ...rows.flatMap((r) => [r.revenue, r.cost])), bw = (W - pad.l - pad.r) / rows.length;
  const svg = document.createElementNS(SVGNS, 'svg'); svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('width', '100%'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Billed versus cost by ' + mode);
  const el = (n, a, t) => { const e = document.createElementNS(SVGNS, n); for (const [k, v] of Object.entries(a)) e.setAttribute(k, v); if (t) e.textContent = t; return e; };
  svg.append(el('line', { x1: pad.l, x2: W - pad.r, y1: H - pad.b, y2: H - pad.b, stroke: '#e2e5ec' }));
  rows.forEach((r, i) => { const x = pad.l + i * bw, h1 = ((H - pad.t - pad.b) * r.revenue) / max, h2 = ((H - pad.t - pad.b) * r.cost) / max;
    const b1 = el('rect', { x: x + bw * 0.12, y: H - pad.b - h1, width: bw * 0.36, height: Math.max(0, h1), fill: '#1B1462', rx: 2 }); b1.append(el('title', {}, `${r.label}: billed ${usd(r.revenue)}`));
    const b2 = el('rect', { x: x + bw * 0.52, y: H - pad.b - h2, width: bw * 0.36, height: Math.max(0, h2), fill: '#b6bac6', rx: 2 }); b2.append(el('title', {}, `${r.label}: cost ${usd(r.cost)}`));
    svg.append(b1, b2, el('text', { x: x + bw / 2, y: H - 9, 'text-anchor': 'middle', 'font-size': 10.5, fill: '#7b8294' }, r.label)); });
  return svg;
}
function widgetCard(id, d, err) {
  const kpi = (l, v, tone = '', href) => h(href ? 'a' : 'div', { class: 'kpi ' + tone, href, style: href ? 'text-decoration:none;color:inherit;display:block' : null }, h('div', { class: 'l' }, l), h('div', { class: 'v' }, v));
  const card = (...kids) => h('div', { class: 'card' }, h('h2', {}, WIDGET_TITLES[id]), ...kids); const th = (t, n) => h('th', { class: n ? 'n' : '' }, t);
  if (id === 'estimating' && d.estimating) { const e = d.estimating; return card(h('div', { class: 'grid kpis', style: 'grid-template-columns:repeat(auto-fit,minmax(130px,1fr))' }, kpi('Open leads', e.openLeads, '', '#/estimating/bids'), kpi('Working now', e.working, '', '#/estimating/proposals'), kpi('Submitted this month', e.submitted, '', '#/estimating/submissions'), kpi('Follow-ups due', e.awaitingFollowUp, e.awaitingFollowUp ? 'warn' : '', '#/estimating/submissions'), kpi('Interested', e.interested, e.interested ? 'good' : ''), kpi('Win rate', e.winRate == null ? '—' : e.winRate + '%', '', '#/estimating/insights'), kpi('Expected awards', e.expectedAwards == null ? '—' : usd(e.expectedAwards), 'good', '#/estimating/insights'))); }
  if (id === 'presence' && d.presence) { const p = d.presence; return card(p.active.length ? p.active.map((a) => h('div', { style: 'padding:.3rem 0;border-bottom:1px solid var(--line)' }, h('span', { class: 'dot' }), h('strong', {}, a.employee), ` · ${a.project}${a.trade ? ' / ' + a.trade : ''}`, h('span', { class: 'muted', style: 'margin-left:.5rem;font-size:13px' }, 'since ' + new Date(a.since).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })), a.late ? h('span', { class: 'pill Pending', style: 'margin-left:.4rem' }, 'Late') : '')) : h('p', { class: 'muted' }, 'No one is clocked in right now.'), h('p', { class: 'muted', style: 'margin-top:.6rem' }, `${p.weekHours.toFixed(1)} hours logged this week.`)); }
  if (id === 'costing' && d.costing) { const c = d.costing; return card(h('div', { class: 'grid kpis', style: 'grid-template-columns:repeat(auto-fit,minmax(130px,1fr))' }, kpi('Active projects', c.activeProjects), kpi('Contract value', usd(c.contract)), kpi('Billed', usd(c.billed)), kpi('Received', usd(c.received)), kpi('Owed by GCs', usd(c.totalOwed), 'warn'), kpi('Due now', usd(c.currentlyDue), c.currentlyDue > 0 ? 'warn' : ''), kpi('Retainage held', usd(c.retainageOutstanding)), kpi('Payables', usd(c.totalPayable)), kpi('Projected profit', usd(c.projectedProfit), c.projectedProfit < 0 ? 'bad' : 'good'), kpi('Margin', pct(c.marginPct)))); }
  if (id === 'chart' && d.series) { const mode = state.chartMode || 'month'; const t = (m, l) => h('button', { class: 'small' + (mode === m ? ' primary' : ''), onclick: () => { state.chartMode = m; render(); } }, l);
    return h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', {}, WIDGET_TITLES.chart), h('div', { class: 'row', style: 'gap:.3rem' }, t('month', 'Monthly'), t('quarter', 'Quarterly'))), barChart(d.series, mode), h('div', { class: 'row', style: 'gap:1rem;margin-top:.3rem;font-size:13px' }, h('span', {}, h('span', { class: 'dot', style: 'background:#1B1462' }), 'Billed'), h('span', {}, h('span', { class: 'dot', style: 'background:#b6bac6' }), 'Job cost (subcontractors, vendors, labor)'), h('span', { class: 'muted', style: 'margin-left:auto' }, `Profit, last 12 months: ${usd(d.series.reduce((n, x) => n + x.profit, 0))}`))); }
  if (id === 'receivables' && d.receivables) { const tot = d.receivables.reduce((n, r) => n + r.amount, 0); return card(h('table', {}, h('tbody', {}, d.receivables.map((r) => h('tr', {}, h('td', {}, r.bucket), h('td', { class: 'n' }, usd(r.amount)))))), h('p', { class: 'muted' }, `Collectable now (retainage excluded): ${usd(tot)}`)); }
  if (id === 'payables' && d.payables) return card(h('div', { class: 'kpi', style: 'margin-bottom:.6rem' }, h('div', { class: 'l' }, 'Total owed'), h('div', { class: 'v' }, usd(d.payables.total))), d.payables.top.length ? h('table', {}, h('tbody', {}, d.payables.top.map((r) => h('tr', {}, h('td', {}, r.name), h('td', { class: 'muted' }, r.kind), h('td', { class: 'n' }, usd(r.owed)))))) : h('p', { class: 'muted' }, 'Nothing owed.'));
  if (id === 'projects' && d.projects) return card(d.projects.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, th('Project'), th('GC'), th('Contract', 1), th('Billed', 1), th('Margin', 1))), h('tbody', {}, d.projects.map((p) => h('tr', { class: 'link', onclick: () => (location.hash = '#/projects/' + p.id) }, h('td', {}, p.name), h('td', {}, p.gc), h('td', { class: 'n' }, usd(p.contract)), h('td', { class: 'n' }, usd(p.billed)), h('td', { class: 'n ' + cls(p.projectedProfit) }, pct(p.marginPct)))))) ) : h('p', { class: 'muted' }, 'No active projects.'));
  if (id === 'forecast' && d.forecast) { const per = state.fcPeriod || 'quarter', f = d.forecast[per]; const t = (m, l) => h('button', { class: 'small' + (per === m ? ' primary' : ''), onclick: () => { state.fcPeriod = m; render(); } }, l);
    return h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', {}, WIDGET_TITLES.forecast), h('div', { class: 'row', style: 'gap:.3rem' }, t('month', 'Month'), t('quarter', 'Quarter'), t('year', 'Year'))), f.projected == null ? h('p', { class: 'muted' }, 'Not enough billing history yet. This turns on after two completed months of invoices.') : h('div', { class: 'grid kpis', style: 'grid-template-columns:repeat(auto-fit,minmax(130px,1fr))' }, kpi('Billed so far', usd(f.billed)), kpi('Monthly pace', usd(f.pace)), kpi('Projected', usd(f.projected), 'good'), kpi('Left to bill on contracts', usd(d.forecast.backlog))), h('p', { class: 'muted', style: 'font-size:13px;margin-top:.6rem' }, d.forecast.note)); }
  if (id === 'compliance' && d.compliance) { const c = d.compliance; return card(h('div', { class: 'grid kpis', style: 'grid-template-columns:repeat(auto-fit,minmax(130px,1fr))' }, kpi('Subcontractors blocked', c.vendorsBlocked.length, c.vendorsBlocked.length ? 'bad' : '', '#/compliance'), kpi('Insurance expiring', c.vendorsExpiring.length, c.vendorsExpiring.length ? 'warn' : '', '#/compliance'), kpi('Payments to approve', c.approvalsWaiting, c.approvalsWaiting ? 'warn' : '', '#/compliance'), kpi('Approved, unpaid', c.readyToPay, '', '#/compliance'), kpi('NTOs needed', c.ntoNeeded, c.ntoNeeded ? 'warn' : '', '#/compliance'), kpi('NTOs overdue', c.ntoOverdue, c.ntoOverdue ? 'bad' : '', '#/compliance')), c.vendorsBlocked.length ? h('p', { class: 'muted', style: 'margin-top:.6rem' }, 'Cannot be paid: ' + c.vendorsBlocked.join(', ')) : ''); }
  if (id === 'overhead' && d.overhead) { const o = d.overhead; return card(h('div', { class: 'grid kpis', style: 'grid-template-columns:repeat(auto-fit,minmax(130px,1fr))' }, kpi('Overhead allocated', usd(o.total)), kpi('Profit after overhead', usd(o.profitAfterOverhead), o.profitAfterOverhead < 0 ? 'bad' : 'good')), h('p', { class: 'muted', style: 'margin-top:.5rem' }, o.lines.map((l) => `${l.name} ${usd(l.total)}`).join(' · ') || 'Add overhead items in Admin.')); }
  if (id === 'todos' && d.todos) return card(d.todos.length ? d.todos.map((t) => h('div', { style: 'padding:.3rem 0;border-bottom:1px solid var(--line)' }, h('input', { type: 'checkbox', onchange: guard(err, async () => { await api('PUT', '/todos/' + t.id, { status: 'Done' }); render(); }) }), ' ', t.title, t.dueDate ? h('span', { class: 'muted', style: 'margin-left:.5rem;font-size:13px' }, 'due ' + t.dueDate) : '', t.overdue ? h('span', { class: 'pill Expired', style: 'margin-left:.4rem' }, 'Overdue') : '')) : h('p', { class: 'muted' }, 'You are all caught up.'), h('p', { style: 'margin-top:.6rem' }, h('a', { href: '#/messages/todos' }, 'Open the full to-do list')));
  return null;
}
function customizeDashboard(d, current, save) {
  const order = [...current]; const list = h('div'); const draw = () => list.replaceChildren(...order.map((w, i) => h('div', { class: 'row', style: 'padding:.3rem 0;border-bottom:1px solid var(--line)' }, h('input', { type: 'checkbox', checked: w.visible ? true : null, onchange: (e) => (w.visible = e.target.checked) }), h('span', { style: 'flex:1' }, WIDGET_TITLES[w.id]), h('button', { class: 'small', type: 'button', disabled: i === 0 ? true : null, onclick: () => { [order[i - 1], order[i]] = [order[i], order[i - 1]]; draw(); } }, '↑'), h('button', { class: 'small', type: 'button', disabled: i === order.length - 1 ? true : null, onclick: () => { [order[i + 1], order[i]] = [order[i], order[i + 1]]; draw(); } }, '↓')))); draw();
  formModal('Customize your dashboard', [h('div', { class: 'wide' }, h('p', { class: 'muted' }, 'Choose what shows and in what order. This is saved for you only.'), list)], async () => { await save(order); }, 'Save layout');
}
async function dashboardView() {
  const d = await api('GET', '/dashboard/widgets'); const err = h('div'); const allowed = d.widgets; const saved = d.prefs?.widgets || [];
  const layout = [...saved.filter((w) => allowed.includes(w.id)), ...allowed.filter((id) => !saved.some((w) => w.id === id)).map((id) => ({ id, visible: !['overhead'].includes(id) }))];
  const hr = new Date().getHours(), greet = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
  const cards = layout.filter((w) => w.visible).map((w) => widgetCard(w.id, d, err)).filter(Boolean);
  return shell('dashboard', [h('div', { class: 'row spread' }, h('h1', {}, `${greet}${state.user.name && !state.user.name.includes('@') ? ', ' + state.user.name.split(' ')[0] : ''}`), h('button', { onclick: () => customizeDashboard(d, layout, async (order) => { await api('PUT', '/prefs/dashboard', { widgets: order.map((w) => ({ id: w.id, visible: w.visible })), period: 'month' }); render(); }) }, 'Customize')), err,
    cards.length ? h('div', { class: 'widgets' }, cards) : h('div', { class: 'card soon' }, 'Nothing is turned on. Use Customize to choose what to show.')]);
}

// ------------------------------------------------------------------ projects
async function projectsView() {
  const rows = await api('GET', '/projects');
  const canAdd = isManager();
  const body = rows.length ? h('div', { class: 'scroll' }, h('table', {},
    h('thead', {}, h('tr', {}, ['Project', 'GC', 'Contract', 'Billed', 'Due now', 'Projected profit', 'Margin'].map((t, i) => h('th', { class: i > 1 ? 'n' : '' }, t)))),
    h('tbody', {}, rows.map((r) => h('tr', { class: 'link', onclick: () => (location.hash = '#/projects/' + r.id) },
      h('td', {}, r.name, r.active ? '' : h('span', { class: 'pill', style: 'margin-left:.5rem' }, 'Inactive')), h('td', {}, r.gc),
      h('td', { class: 'n' }, usd(r.contract)), h('td', { class: 'n' }, usd(r.billed)), h('td', { class: 'n' }, usd(r.currentlyDue)),
      h('td', { class: 'n ' + cls(r.projectedProfit) }, usd(r.projectedProfit)), h('td', { class: 'n' }, pct(r.marginPct))))))) : h('p', { class: 'muted' }, 'No projects yet.');
  return shell('projects', [h('div', { class: 'row spread' }, h('h1', {}, 'Projects'), canAdd && h('button', { class: 'primary', onclick: newProjectModal }, '+ New project')), h('div', { class: 'card' }, body)]);
}


async function newProjectModal() {
  const err = h('div');
  const f = { name: h('input'), gc: h('select', {}, h('option', { value: '' }, 'Choose GC…'), state.gcs.filter((g) => !g.archived).map((g) => h('option', { value: g.id }, g.name))), client: h('input'), address: h('input'), ret: h('input', { type: 'number', value: '10', min: '0', max: '100', step: '0.5' }), link: h('input', { type: 'url', placeholder: 'https://… (OneDrive link to the signed contract)' }) };
  const tradeRows = h('div'); const addRow = () => {
    const sel = h('select', {}, h('option', { value: '' }, 'Trade…'), state.trades.filter((t) => !t.archived).map((t) => h('option', { value: t.id }, t.name)));
    const amt = h('input', { type: 'number', min: '0', step: '0.01', placeholder: 'Contract amount' });
    const row = h('div', { class: 'trade-row' }, sel, amt, h('button', { class: 'small', type: 'button', onclick: () => row.remove() }, 'Remove')); row._get = () => ({ tradeId: sel.value, amount: amt.value }); tradeRows.append(row);
  };
  addRow();
  const bg = modal('New project', h('form', { onsubmit: guard(err, async (e) => {
    e.preventDefault();
    const trades = [...tradeRows.children].map((r) => r._get()).filter((t) => t.tradeId || t.amount);
    const r = await api('POST', '/projects', { name: f.name.value, gcId: f.gc.value, client: f.client.value, address: f.address.value, retainagePct: f.ret.value, contractUrl: f.link.value, trades });
    bg.remove(); location.hash = '#/projects/' + r.id;
  }) }, h('div', { class: 'form' },
    h('div', {}, h('label', {}, 'Project name'), f.name), h('div', {}, h('label', {}, 'GC'), f.gc), h('div', {}, h('label', {}, 'Client'), f.client), h('div', {}, h('label', {}, 'Project address'), f.address),
    h('div', {}, h('label', {}, 'GC retainage %'), f.ret), h('div', { class: 'wide' }, h('label', {}, 'Contract link'), f.link),
    h('div', { class: 'wide' }, h('label', {}, 'Trades and contract amounts'), tradeRows, h('button', { type: 'button', class: 'small', onclick: addRow }, '+ Add trade'))),
    err, h('div', { class: 'row', style: 'margin-top:1rem;justify-content:flex-end' }, h('button', { class: 'primary', type: 'submit' }, 'Create project'))));
}

const TABS = [['trades', 'Trade Overview'], ['cos', 'Change Orders'], ['billing', 'Progress Billing'], ['costs', 'Costs & Payables'], ['labor', 'Labor'], ['docs', 'Documents'], ['origin', 'Bid History']];
async function projectView(id, tab = 'trades') {
  const p = await api('GET', '/projects/' + id);
  const canEdit = isManager();
  const reload = () => render();
  let content;
  if (tab === 'trades') content = tradeOverview(p, canEdit, reload);
  else if (tab === 'cos') content = changeOrders(p, reload);
  else if (tab === 'billing') content = await billingTab(p, canEdit, reload);
  else if (tab === 'costs') content = await costsTab(p, canEdit, reload);
  else if (tab === 'labor') content = await laborTab(p, canEdit, reload);
  else if (tab === 'docs') content = await docsTab(p, canEdit, reload);
  else if (tab === 'origin') content = await estimating.originCard(id);
  else content = h('div', { class: 'card soon' }, h('h2', {}, TABS.find((t) => t[0] === tab)[1]), h('p', {}, 'Coming in the next build step.'));
  return shell('projects', [
    h('p', {}, h('a', { href: '#/projects' }, '← All projects')),
    h('h1', {}, p.project.name), h('p', { class: 'muted' }, `${p.project.gc} · ${p.project.client} · ${p.project.address}`, p.project.contractUrl ? [' · ', h('a', { href: p.project.contractUrl, target: '_blank', rel: 'noopener' }, 'Contract')] : ''),
    h('div', { class: 'grid kpis', style: 'margin-bottom:1rem' },
      h('div', { class: 'kpi' }, h('div', { class: 'l' }, 'Original contract + COs'), h('div', { class: 'v' }, usd(p.totals.contract))),
      h('div', { class: 'kpi' }, h('div', { class: 'l' }, 'Billed'), h('div', { class: 'v' }, usd(p.totals.billed))),
      h('div', { class: 'kpi warn' }, h('div', { class: 'l' }, 'Due now'), h('div', { class: 'v' }, usd(p.totals.currentlyDue))),
      h('div', { class: 'kpi ' + (p.totals.projectedProfit < 0 ? 'bad' : 'good') }, h('div', { class: 'l' }, 'Projected profit'), h('div', { class: 'v' }, usd(p.totals.projectedProfit)))),
    h('div', { class: 'tabs' }, TABS.map(([t, label]) => h('a', { class: t === tab ? 'on' : '', href: `#/projects/${id}/${t}` }, label))),
    content]);
}

function tradeOverview(p, canEdit, reload) {
  const err = h('div');
  const th = (t, n) => h('th', { class: n ? 'n' : '' }, t);
  const editAmount = (t) => h('span', { class: canEdit ? 'edit' : '', title: canEdit ? 'Click to edit' : '', onclick: canEdit ? guard(err, async () => {
    const v = prompt(`Original contract amount for ${t.name}`, t.original); if (v === null) return;
    await api('PUT', `/projects/${p.project.id}/trades/${t.id}`, { amount: v }); reload();
  }) : null }, usd(t.original));
  const sum = (k) => Math.round(p.trades.reduce((n, t) => n + Math.round(t[k] * 100), 0)) / 100;
  const used = new Set(p.trades.map((t) => t.tradeId));
  const avail = state.trades.filter((t) => !t.archived && !used.has(t.id));
  const sel = h('select', {}, h('option', { value: '' }, 'Add trade…'), avail.map((t) => h('option', { value: t.id }, t.name))); const amt = h('input', { type: 'number', min: '0', step: '0.01', placeholder: 'Contract amount' });
  return h('div', { class: 'card' }, h('h2', {}, 'Trade performance'), err,
    h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, th('Trade'), th('Original contract', 1), th('Approved COs', 1), th('Original contract + COs', 1), th('Billed', 1), th('Retainage', 1), th('Received', 1), th('Due now', 1), th('Actual cost', 1), th('Projected profit', 1), th('Margin', 1), canEdit && th(''))),
      h('tbody', {}, p.trades.map((t) => h('tr', {}, h('td', {}, t.name), h('td', { class: 'n' }, editAmount(t)), h('td', { class: 'n' }, usd(t.approvedCOs)), h('td', { class: 'n' }, usd(t.contract)), h('td', { class: 'n' }, usd(t.billed)), h('td', { class: 'n' }, usd(t.retainageOutstanding)), h('td', { class: 'n' }, usd(t.received)), h('td', { class: 'n' }, usd(t.currentlyDue)), h('td', { class: 'n' }, usd(t.actualCost)), h('td', { class: 'n ' + cls(t.projectedProfit) }, usd(t.projectedProfit)), h('td', { class: 'n' }, pct(t.marginPct)),
        canEdit && h('td', {}, h('button', { class: 'small danger', onclick: guard(err, async () => { if (confirm(`Remove ${t.name} from this project?`)) { await api('DELETE', `/projects/${p.project.id}/trades/${t.id}`); reload(); } }) }, 'Remove'))))),
      h('tfoot', {}, h('tr', { class: 'total' }, h('td', {}, 'Project'), h('td', { class: 'n' }, usd(sum('original'))), h('td', { class: 'n' }, usd(sum('approvedCOs'))), h('td', { class: 'n' }, usd(p.totals.contract)), h('td', { class: 'n' }, usd(p.totals.billed)), h('td', { class: 'n' }, usd(p.totals.retainageOutstanding)), h('td', { class: 'n' }, usd(p.totals.received)), h('td', { class: 'n' }, usd(p.totals.currentlyDue)), h('td', { class: 'n' }, usd(p.totals.actualCost)), h('td', { class: 'n ' + cls(p.totals.projectedProfit) }, usd(p.totals.projectedProfit)), h('td', { class: 'n' }, pct(p.totals.marginPct)), canEdit && h('td'))))),
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
  return h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', {}, 'Change orders'), h('button', { class: 'primary', onclick: () => edit(null) }, '+ Add change order')), err,
    p.changeOrders.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['CO #', 'Description', 'Trade', 'Approved date', 'Status'].map((t) => h('th', {}, t)), h('th', { class: 'n' }, 'Revenue change'), h('th'))),
      h('tbody', {}, p.changeOrders.map((c) => h('tr', {}, h('td', {}, c.number), h('td', { style: 'white-space:normal' }, c.description), h('td', {}, c.trade), h('td', {}, c.approvedDate || '—'), h('td', {}, h('span', { class: 'pill ' + c.status }, c.status)), h('td', { class: 'n ' + cls(c.amount) }, usd(c.amount)),
        h('td', {}, h('button', { class: 'small', onclick: () => edit(c) }, 'Edit'), ' ', h('button', { class: 'small danger', onclick: guard(err, async () => { if (confirm(`Delete ${c.number}?`)) { await api('DELETE', `/projects/${p.project.id}/change-orders/${c.id}`); reload(); } }) }, 'Delete'))))),
      h('tfoot', {}, h('tr', { class: 'total' }, h('td', { colspan: 5 }, 'Approved total (updates Trade Overview)'), h('td', { class: 'n' }, usd(p.coTotals.approved)), h('td')), h('tr', {}, h('td', { colspan: 5, class: 'muted' }, 'Pending (not yet in contract)'), h('td', { class: 'n muted' }, usd(p.coTotals.pending)), h('td'))))) : h('p', { class: 'muted' }, 'No change orders yet.'));
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
async function billingTab(p, canEdit, reload) {
  const inv = await api('GET', `/projects/${p.project.id}/billing`); const err = h('div'); const base = `/projects/${p.project.id}`;
  const T = p.totals;
  const slices = [{ label: 'Received', value: T.received, color: '#15803d' }, { label: 'Due now', value: T.currentlyDue, color: '#b45309' }, { label: 'Retainage held', value: T.retainageOutstanding, color: '#6366f1' }, { label: 'Unbilled', value: Math.max(0, T.unbilled), color: '#cbd5e1' }];
  const th = (t, n) => h('th', { class: n ? 'n' : '' }, t);
  const sov = h('div', { class: 'card' }, h('h2', {}, 'Schedule of values'), h('div', { class: 'scroll' }, h('table', {},
    h('thead', {}, h('tr', {}, th('Trade'), th('Contract (orig + COs)', 1), th('Billed to date', 1), th('% billed', 1), th('Retainage held', 1), th('Received', 1), th('Due now', 1), th('Balance to finish', 1))),
    h('tbody', {}, p.trades.map((t) => h('tr', {}, h('td', {}, t.name), h('td', { class: 'n' }, usd(t.contract)), h('td', { class: 'n' }, usd(t.billed)), h('td', { class: 'n' }, t.contract > 0 ? pct((t.billed / t.contract) * 100) : '—'), h('td', { class: 'n' }, usd(t.retainageOutstanding)), h('td', { class: 'n' }, usd(t.received)), h('td', { class: 'n' }, usd(t.currentlyDue)), h('td', { class: 'n' }, usd(t.unbilled))))),
    h('tfoot', {}, h('tr', { class: 'total' }, h('td', {}, 'Project'), h('td', { class: 'n' }, usd(T.contract)), h('td', { class: 'n' }, usd(T.billed)), h('td', { class: 'n' }, T.contract > 0 ? pct((T.billed / T.contract) * 100) : '—'), h('td', { class: 'n' }, usd(T.retainageOutstanding)), h('td', { class: 'n' }, usd(T.received)), h('td', { class: 'n' }, usd(T.currentlyDue)), h('td', { class: 'n' }, usd(T.unbilled)))))),
    h('div', { class: 'row', style: 'gap:2rem;margin-top:1.2rem;align-items:center' }, pie(slices), h('div', { style: 'min-width:260px' }, h('h2', {}, 'Where the contract stands'), legend(slices))));

  const newInvoice = () => {
    const f = { trade: tradeSelect(p), number: h('input'), date: h('input', { type: 'date', value: todayStr() }), due: h('input', { type: 'date' }), amount: num(), ret: num('', { placeholder: `Blank = ${p.project.retainagePct}% default` }) };
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
  return h('div', {}, sov, list);
}

// ------------------------------------------------------------------ costs & payables
async function costsTab(p, canEdit, reload) {
  const c = await api('GET', `/projects/${p.project.id}/costs`); const err = h('div'); const base = `/projects/${p.project.id}`;
  const th = (t, n) => h('th', { class: n ? 'n' : '' }, t);
  const run = (fn) => guard(err, async () => { await fn(); reload(); });

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
  const vendors = h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', {}, '1. Subcontractors'), canEdit && h('button', { class: 'primary', onclick: guard(err, addVendor) }, '+ Add subcontractor')),
    c.vendors.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, th('Trade'), th('Subcontractor'), th('Subcontract', 1), th('Billed', 1), th('Paid', 1), th('Balance', 1), th('Held', 1), th('Available to pay', 1), th('Remaining', 1), canEdit && th(''))),
      h('tbody', {}, c.vendors.map((v) => h('tr', {}, h('td', {}, v.trade || 'Project-level'), h('td', {}, v.vendor, v.compliance && v.compliance.canPay === false ? h('span', { class: 'pill Expired', style: 'margin-left:.5rem', title: (v.compliance.reasons || []).join('; ') }, 'Cannot pay') : v.compliance?.status === 'Expiring' ? h('span', { class: 'pill Expiring', style: 'margin-left:.5rem' }, 'Insurance expiring') : '', v.holdReason ? h('div', { class: 'muted', style: 'font-size:12px' }, `Hold: ${v.holdReason}${v.holdReleased ? ' (released)' : ''}`) : ''), h('td', { class: 'n' }, usd(v.contract)), h('td', { class: 'n' }, usd(v.invoiced)), h('td', { class: 'n' }, usd(v.paid)), h('td', { class: 'n' }, usd(v.balance)), h('td', { class: 'n' }, usd(v.held)), h('td', { class: 'n' }, usd(v.availableToPay)), h('td', { class: 'n' }, usd(v.remaining)),
        canEdit && h('td', {}, h('button', { class: 'small', onclick: () => addBill(v) }, '+ Bill'), ' ', h('button', { class: 'small', onclick: () => payVendor(v, false) }, 'Request payment'), ' ', ['Super Admin', 'Sub Admin'].includes(state.user.role) && h('button', { class: 'small', onclick: () => payVendor(v, true) }, 'Pay now'), ' ', v.holdAmount > 0 && h('button', { class: 'small', onclick: run(() => api('PUT', `${base}/commitments/${v.id}`, { holdReleased: !v.holdReleased })) }, v.holdReleased ? 'Re-hold' : 'Release hold'), ' ', h('button', { class: 'small', onclick: () => editVendor(v) }, 'Edit'), ' ',
          h('button', { class: 'small danger', onclick: guard(err, async () => { if (confirm(`Remove ${v.vendor} and all its bills from this project?`)) { await api('DELETE', `${base}/commitments/${v.id}`); reload(); } }) }, 'Remove'))))))) : h('p', { class: 'muted' }, 'No subcontractors on this project yet. They are created in Admin (with a W-9 and COI or exemption), then added here.'));

  const addSupplier = async () => {
    const sups = (await api('GET', '/admin/suppliers')).filter((s) => !s.archived);
    const lines = h('div'); const addLine = () => { const sel = tradeSelect(p, { project: true }), amt = num('', { placeholder: 'Amount' }); const row = h('div', { class: 'trade-row' }, sel, amt, h('button', { class: 'small', type: 'button', onclick: () => row.remove() }, 'Remove')); row._get = () => ({ projectId: p.project.id, projectTradeId: sel.value || null, amount: amt.value }); lines.append(row); }; addLine();
    const f = { sup: h('select', {}, h('option', { value: '' }, 'Choose vendor…'), sups.map((s) => h('option', { value: s.id }, s.name))), ref: h('input'), date: h('input', { type: 'date', value: todayStr() }), total: num() };
    formModal('Vendor invoice', [field('Vendor (from Admin)', f.sup), field('Invoice #', f.ref), field('Invoice date', f.date), field('Invoice total', f.total), field('Allocate to trades (must add up to the total)', h('div', {}, lines, h('button', { class: 'small', type: 'button', onclick: addLine }, '+ Split to another trade')), 'wide')],
      async () => { await api('POST', '/supplier-invoices', { supplierId: f.sup.value, reference: f.ref.value, date: f.date.value, total: f.total.value, allocations: [...lines.children].map((r) => r._get()) }); reload(); }, 'Add invoice');
  };
  const paySupplier = (s) => {
    const f = { date: h('input', { type: 'date', value: todayStr() }), amount: num('', { placeholder: `Invoice total ${usd(s.invoiceTotal)}` }) };
    formModal(`Pay ${s.supplier} · ${s.reference}`, [field('Payment date', f.date), field('Amount paid (whole invoice)', f.amount)], async () => { await api('POST', `/supplier-invoices/${s.invoiceId}/payments`, { date: f.date.value, amount: f.amount.value }); reload(); }, 'Record payment');
  };
  const suppliers = h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', {}, '2. Vendors (materials, lodging, equipment, purchases)'), canEdit && h('button', { class: 'primary', onclick: guard(err, addSupplier) }, '+ Vendor invoice')),
    c.suppliers.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, th('Trade'), th('Vendor'), th('Invoice'), th('Date'), th('Allocated', 1), th('Paid', 1), th('Balance', 1), canEdit && th(''))),
      h('tbody', {}, c.suppliers.map((s) => h('tr', {}, h('td', {}, s.trade || 'Project-level'), h('td', {}, s.supplier), h('td', {}, s.reference), h('td', {}, s.date || '—'), h('td', { class: 'n' }, usd(s.amount)), h('td', { class: 'n' }, usd(s.paid)), h('td', { class: 'n' }, usd(s.balance)),
        canEdit && h('td', {}, h('button', { class: 'small', onclick: () => paySupplier(s) }, 'Pay'), ' ', h('button', { class: 'small danger', onclick: guard(err, async () => { if (confirm(`Delete invoice ${s.reference} (all of its allocations, on every project)?`)) { await api('DELETE', `/supplier-invoices/${s.invoiceId}`); reload(); } }) }, 'Delete'))))))) : h('p', { class: 'muted' }, 'No vendor invoices yet.'));

  const labor = h('div', { class: 'card' }, h('h2', {}, '3. Labor (1099 crew, from the time clock)'), h('p', { class: 'muted' }, 'Hours and pay come from the time clock.'),
    c.labor.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, th('Trade'), th('Employee'), th('Hours', 1), th('Pay', 1))), h('tbody', {}, c.labor.map((l) => h('tr', {}, h('td', {}, l.trade || 'Project-level'), h('td', {}, l.employee), h('td', { class: 'n' }, l.hours.toFixed(2)), h('td', { class: 'n' }, l.pay == null ? '—' : usd(l.pay))))))) : h('p', { class: 'muted' }, 'No labor posted yet.'));

  const T = p.totals;
  const tally = h('div', { class: 'card' }, h('h2', {}, 'Cost by trade'), h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, th('Trade'), th('Subcontractors', 1), th('Vendors', 1), th('Labor', 1), th('Actual cost', 1), th('Still to bill (subcontractors)', 1), th('Payable', 1), th('Contract', 1), th('Projected profit', 1))),
    h('tbody', {}, p.trades.map((t) => h('tr', {}, h('td', {}, t.name), h('td', { class: 'n' }, usd(t.subInvoiced)), h('td', { class: 'n' }, usd(t.supplierCost)), h('td', { class: 'n' }, usd(t.laborCost)), h('td', { class: 'n' }, usd(t.actualCost)), h('td', { class: 'n' }, usd(t.subRemaining)), h('td', { class: 'n' }, usd(t.totalPayable)), h('td', { class: 'n' }, usd(t.contract)), h('td', { class: 'n ' + cls(t.projectedProfit) }, usd(t.projectedProfit))))),
    h('tfoot', {}, h('tr', { class: 'total' }, h('td', {}, 'Whole project (incl. project-level costs)'), h('td', { class: 'n' }, usd(T.subInvoiced)), h('td', { class: 'n' }, usd(T.supplierCost)), h('td', { class: 'n' }, usd(T.laborCost)), h('td', { class: 'n' }, usd(T.actualCost)), h('td', { class: 'n' }, usd(T.subRemaining)), h('td', { class: 'n' }, usd(T.totalPayable)), h('td', { class: 'n' }, usd(T.contract)), h('td', { class: 'n ' + cls(T.projectedProfit) }, usd(T.projectedProfit)))))));
  return h('div', {}, err, vendors, suppliers, labor, tally);
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
      h('div', { class: 'row', style: 'margin-top:.8rem' }, h('button', { onclick: () => navigator.geolocation?.getCurrentPosition((g) => { f.lat.value = g.coords.latitude.toFixed(6); f.lng.value = g.coords.longitude.toFixed(6); }, () => notice(e2, 'Could not read your location.')) }, 'Use my current location'),
        h('button', { class: 'primary', onclick: guard(e2, async () => { await api('PUT', base, { lat: f.lat.value, lng: f.lng.value, geofenceMiles: f.miles.value, geofenceRequired: f.req.checked }); notice(e2, 'Saved.', 'ok'); }) }, 'Save location')));
  }
  return h('div', {}, labCard, loc);
}

async function bidFeedCard() {
  const f = await api('GET', '/bids/status'); const regions = await api('GET', '/regions'); const err = h('div'); const can = ['Super Admin', 'Sub Admin'].includes(state.user.role);
  const label = h('input', { value: f.label || '', placeholder: 'Optional, e.g. Building Connected', disabled: !can ? true : null });
  const region = (r) => { const c = h('input', { value: r?.city ?? '', disabled: r ? true : null }), t = h('select', {}, [1, 2, 3, 4].map((n) => h('option', { value: n }, `Tier ${n}`))); if (r) t.value = r.tier; formModal(r ? `Edit ${r.city}` : 'Add a city', [field('City', c), field('Region tier', t)], async () => { await api('PUT', '/regions', { city: c.value, tier: t.value }); render(); }); };
  return h('div', { class: 'card' }, h('h2', {}, 'Bid invitations from Gmail'), err,
    f.connected ? h('p', { class: 'ok' }, `Connected to ${f.email}. Read-only: it can read mail, never send or change it.`) : h('p', { class: f.googleSetUp ? 'muted' : 'err' }, f.googleSetUp ? 'Not connected yet. Press Connect and sign in with the Gmail account that receives the BuildingConnected invitations.' : 'Google is not set up on the server yet (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET). See the setup steps.'),
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
    await projectDocs(p, canEdit, reload));
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
  const docCell = (v, cat) => { const d = v.docs[cat]; return d ? h('span', {}, d.url ? h('a', { href: d.url, target: '_blank', rel: 'noopener' }, 'On file') : 'On file', d.expires ? ` · ${d.expires}` : '', ' ', h('button', { class: 'small danger', title: 'Remove', onclick: act(() => api('DELETE', `/admin/subcontractors/${v.id}/documents/${encodeURIComponent(cat)}`)) }, '×')) : h('span', { class: 'muted' }, '—'); };
  parts.push(h('div', { class: 'card' }, h('h2', {}, 'Subcontractor W-9 and insurance'), vendors.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, th('Subcontractor'), th('Status'), th('W-9'), th('COI'), th('Exemption'), th('Active on'), th(''))),
    h('tbody', {}, vendors.filter((v) => !v.archived).map((v) => h('tr', {}, h('td', {}, v.name), h('td', {}, h('span', { class: 'pill ' + v.status, title: v.reasons.join('; ') }, v.status), v.daysLeft != null && v.status !== 'Valid' ? h('span', { class: 'muted', style: 'margin-left:.4rem;font-size:12px' }, `${v.daysLeft} days`) : ''), h('td', {}, docCell(v, 'W-9')), h('td', {}, docCell(v, 'COI')), h('td', {}, docCell(v, 'Exemption')), h('td', { style: 'white-space:normal' }, v.activeProjects.join(', ') || '—'), h('td', {}, h('button', { class: 'small', onclick: () => docForm(v) }, 'Add / update')))))) ) : h('p', { class: 'muted' }, 'No subcontractors yet. Add them in Admin.')));

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
    docs.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, th('Type'), th('Name'), th('Added'), th('By'), th(''))), h('tbody', {}, docs.map((d) => h('tr', {}, h('td', {}, d.category), h('td', {}, d.has_file ? h('a', { href: `/api/documents/${d.id}/file`, target: '_blank', rel: 'noopener' }, d.name) : h('a', { href: d.url, target: '_blank', rel: 'noopener' }, d.name)), h('td', {}, new Date(d.created_at).toLocaleDateString()), h('td', {}, d.uploaded_by || ''),
      h('td', {}, d.has_file && hasFolderAccess() ? [h('button', { class: 'small', title: 'Save a copy into a folder on this computer', onclick: guard(err, async () => notice(err, 'Saved to ' + (await saveDocToFolder(d)), 'ok')) }, 'Save to my folder'), ' '] : '', canEdit ? h('button', { class: 'small danger', onclick: guard(err, async () => { if (confirm(`Delete ${d.name}?`)) { await api('DELETE', `/documents/${d.id}`); reload(); } }) }, 'Delete') : ''))))) ) : h('p', { class: 'muted' }, 'No documents yet. Add the signed contract, proposals, approved change orders, invoices and plans here.'));
}

const CATS_OVERHEAD = ['Tools', 'Insurance', 'Vehicles & fuel', 'Office', 'Software', 'Other'];
function receiptReview(res, opts, done) {
  const parsed = res.parsed || { merchant: '', number: '', date: todayStr(), tax: 0, paid: false, lines: [{ description: '', amount: '', kind: 'Materials' }], warnings: [] };
  const sup = h('select', {}, h('option', { value: '' }, 'Type a new vendor →'), opts.suppliers.map((s) => h('option', { value: s.id }, s.name))); if (res.supplierId) sup.value = res.supplierId;
  const newSup = h('input', { value: res.supplierId ? '' : parsed.merchant || '', placeholder: 'New vendor name' });
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
    field('Vendor', sup), field('…or new vendor', newSup), field('Receipt / invoice #', f.ref), field('Date', f.date), field('Tax', f.tax), field('', h('label', { style: 'text-transform:none;letter-spacing:0;font-size:15px;font-weight:400' }, f.paid, ' Paid at purchase')),
    field('Lines: what it was, and where it goes (tax is shared across the lines)', h('div', {}, lines, h('button', { class: 'small', type: 'button', onclick: () => addLine({}) }, '+ Add line')), 'wide')],
  async () => { await api('POST', '/receipts', { supplierId: sup.value || undefined, supplierName: newSup.value, reference: f.ref.value, date: f.date.value, tax: f.tax.value, paid: f.paid.checked, documentId: res.documentId, source: res.parsed ? 'AI' : 'Manual', total: parsed.total ?? undefined, lines: [...lines.children].map((r) => r._get()) }); done(); }, 'Save receipt');
}
async function receiptsView() {
  const [list, opts, use] = await Promise.all([api('GET', '/receipts'), Promise.all([api('GET', '/trade-options'), api('GET', '/admin/suppliers')]).then(([projects, suppliers]) => ({ projects, suppliers: suppliers.filter((s) => !s.archived) })), api('GET', '/ai/usage')]);
  const err = h('div'); const file = h('input', { type: 'file', accept: '.pdf,.png,.jpg,.jpeg', style: 'display:none', onchange: guard(err, async () => { const f = file.files[0]; if (!f) return; notice(err, 'Reading the receipt…', 'ok'); const res = await uploadFile('/receipts/parse', f); notice(err, ''); receiptReview(res, opts, render); file.value = ''; }) });
  const th = (t, n) => h('th', { class: n ? 'n' : '' }, t);
  return shell('receipts', [h('div', { class: 'row spread' }, h('h1', {}, 'Receipts & supplier invoices'), h('div', { class: 'row' }, file, h('button', { class: 'primary', onclick: () => file.click() }, 'Upload receipt or invoice'), h('button', { onclick: () => receiptReview({ parsed: null }, opts, render) }, 'Enter by hand'))),
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
  const tabs = h('div', { class: 'tabs' }, h('a', { class: tab === 'conv' ? 'on' : '', href: '#/messages' }, 'Conversations'), h('a', { class: tab === 'todos' ? 'on' : '', href: '#/messages/todos' }, 'To-do list'));
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
async function todoForm(todo, threadId, done) {
  const dir = await api('GET', '/team/directory');
  const f = { title: h('input', { value: todo?.title ?? '' }), notes: h('textarea', { rows: 2 }), start: h('input', { type: 'date', value: todo?.startDate ?? '' }), due: h('input', { type: 'date', value: todo?.dueDate ?? '' }), who: h('select', {}, dir.map((u) => h('option', { value: u.id }, u.name || u.email))) };
  f.notes.value = todo?.notes ?? ''; f.who.value = todo?.assignedToId || state.user.id; const lp = linkPicker([]);
  formModal(todo ? 'Edit to-do' : 'Add a to-do', [field('What needs doing', f.title, 'wide'), field('Notes', f.notes, 'wide'), field('Start', f.start), field('Due', f.due), field('Assign to', f.who), field('Attach records', lp.el, 'wide')],
    async () => { const b = { title: f.title.value, notes: f.notes.value, startDate: f.start.value || null, dueDate: f.due.value || null, assignedToId: f.who.value, links: lp.get() }; if (todo) await api('PUT', '/todos/' + todo.id, b); else await api('POST', '/todos', { ...b, threadId }); done(); }, todo ? 'Save' : 'Add to-do');
}
async function todosPanel(err) {
  const view = state.todoView || { who: 'me', status: 'Open' };
  const rows = await api('GET', `/todos?status=${view.status}${view.who === 'me' ? '&assignedTo=me' : '&all=1'}`);
  const set = (k, v) => { state.todoView = { ...view, [k]: v }; render(); };
  const who = h('select', { onchange: (e) => set('who', e.target.value) }, [['me', 'Mine'], ['all', 'Everyone']].map(([v, l]) => h('option', { value: v }, l))); who.value = view.who;
  const status = h('select', { onchange: (e) => set('status', e.target.value) }, ['Open', 'Done'].map((v) => h('option', { value: v }, v))); status.value = view.status;
  return h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('div', { class: 'row' }, who, status), h('button', { class: 'primary', onclick: () => todoForm(null, null, render) }, '+ Add to-do')),
    rows.length ? h('div', { class: 'scroll', style: 'margin-top:.6rem' }, h('table', {}, h('thead', {}, h('tr', {}, ['', 'To-do', 'Attached', 'Assigned to', 'Starts', 'Due', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, rows.map((t) => h('tr', {}, h('td', {}, h('input', { type: 'checkbox', checked: t.status === 'Done' ? true : null, onchange: guard(err, async (e) => { await api('PUT', '/todos/' + t.id, { status: e.target.checked ? 'Done' : 'Open' }); render(); }) })), h('td', { style: 'white-space:normal' }, t.title, t.notes ? h('div', { class: 'muted', style: 'font-size:13px' }, t.notes) : ''), h('td', { style: 'white-space:normal' }, linkChips(t.links)), h('td', {}, t.assignedTo || '—'), h('td', {}, t.startDate || '—'),
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
estimating.init({ api, state, render, shell, uploadFile, hasFolderAccess, createProposalFolders, folderNote, isSuper, canEstimate: () => ['Super Admin', 'Sub Admin', 'Estimator'].includes(state.user.role) });
const estimatingView = estimating.estimatingView;

// ------------------------------------------------------------------ admin
// Admin master records. Every section uses the same add/edit form as the rest of the app.
const POSITIONS = ['', 'Skilled Labor', 'Carpenter', 'Carpenter Helper', 'Foreman', 'Supervisor'];
const SECTIONS = [
  { kind: 'trades', title: 'Trades', one: 'trade', fields: [['name', 'Name', 'text'], ['sort', 'Order', 'number']], archive: 'archived' },
  { kind: 'gcs', title: 'GCs', one: 'GC', fields: [['name', 'Name', 'text']], archive: 'archived' },
  { kind: 'subcontractors', title: 'Subcontractors (labor, vetted)', one: 'subcontractor', fields: [['name', 'Name', 'text'], ['email', 'Email', 'email'], ['phone', 'Phone', 'text'], ['address', 'Address', 'text']], archive: 'archived' },
  { kind: 'suppliers', title: 'Vendors (materials, lodging, equipment, purchases)', one: 'vendor', fields: [['name', 'Name', 'text'], ['provider_type', 'Type', ['Materials', 'Hotel / Lodging', 'Equipment', 'Other purchase']], ['credit_limit', 'Credit limit', 'number'], ['email', 'Email', 'email'], ['phone', 'Phone', 'text'], ['address', 'Address', 'text']], archive: 'archived' },
  { kind: 'employees', title: 'Employees (1099 crew, time clock)', one: 'employee', fields: [['name', 'Name', 'text'], ['position', 'Position', POSITIONS], ['pay_type', 'Pay type', ['hourly', 'daily']], ['hourly_rate', 'Rate ($/hr or $/day)', 'number'], ['phone', 'Phone', 'text'], ['email', 'Email', 'email']], archive: 'active', invert: true, extra: (r, err) => [h('button', { class: 'small', onclick: () => pinForm(r) }, r.has_pin ? 'Reset PIN' : 'Set PIN')] },
];
const visibleFields = (sec) => sec.fields.filter(([k]) => !(sec.kind === 'employees' && ['pay_type', 'hourly_rate'].includes(k) && !isSuper()));
const tableCols = (sec) => visibleFields(sec).filter(([k]) => !['address', 'credit_limit', 'phone', 'email', 'pay_type'].includes(k) || (sec.kind !== 'employees' && ['phone', 'email', 'credit_limit'].includes(k)));
function pinForm(emp) { const pin = h('input', { type: 'password', inputmode: 'numeric', maxlength: 8, autocomplete: 'new-password', placeholder: '4 to 8 digits' }); formModal(`Time clock PIN for ${emp.name}`, [field('PIN', pin, 'wide'), h('p', { class: 'muted wide' }, 'The employee uses this on the time clock page. Setting a new PIN also clears any lockout.')], async () => { await api('PUT', `/admin/employees/${emp.id}/pin`, { pin: pin.value }); render(); }, 'Save PIN'); }
function recordForm(sec, rec, done) {
  const inputs = Object.fromEntries(visibleFields(sec).map(([k, , t]) => {
    const el = Array.isArray(t) ? h('select', {}, t.map((o) => h('option', { value: o }, o || '—'))) : h('input', { type: t === 'number' ? 'number' : t === 'email' ? 'email' : 'text', step: t === 'number' ? '0.01' : null });
    if (rec && rec[k] != null) el.value = rec[k];
    return [k, el];
  }));
  const pin = sec.kind === 'employees' && !rec ? h('input', { type: 'password', inputmode: 'numeric', maxlength: 8, autocomplete: 'new-password', placeholder: '4 to 8 digits (optional now)' }) : null;
  formModal(rec ? `Edit ${rec.name}` : `Add ${sec.one}`, [...visibleFields(sec).map(([k, l]) => field(l, inputs[k])), pin ? field('Time clock PIN', pin) : ''], async () => {
    const body = {}; for (const [k, , t] of visibleFields(sec)) { const v = inputs[k].value; if (t === 'number') { if (v !== '') body[k] = Number(v); } else if (v !== '' || rec) body[k] = v; }
    const saved = await api(rec ? 'PUT' : 'POST', `/admin/${sec.kind}${rec ? '/' + rec.id : ''}`, body);
    if (pin && pin.value) await api('PUT', `/admin/employees/${saved.id}/pin`, { pin: pin.value }); done();
  }, rec ? 'Save' : 'Add');
}
async function adminSection(sec) {
  const rows = await api('GET', '/admin/' + sec.kind); const err = h('div'); const cols = tableCols(sec);
  const isOff = (r) => (sec.invert ? r[sec.archive] === false : r[sec.archive] === true);
  const flag = (r) => (sec.invert ? !r[sec.archive] : !r[sec.archive]);
  return h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', {}, sec.title), h('button', { class: 'primary', onclick: () => recordForm(sec, null, render) }, `+ Add ${sec.one}`)), err,
    rows.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, cols.map(([, l]) => h('th', {}, l)), h('th'))),
      h('tbody', {}, rows.map((r) => h('tr', { class: isOff(r) ? 'muted' : '' }, cols.map(([k]) => h('td', {}, r[k] ?? '')), h('td', {},
        h('button', { class: 'small', onclick: () => recordForm(sec, r, render) }, 'Edit'), ' ', sec.extra ? [sec.extra(r, err), ' '] : '',
        h('button', { class: 'small', onclick: guard(err, async () => { await api('PUT', `/admin/${sec.kind}/${r.id}`, { [sec.archive]: flag(r) }); render(); }) }, sec.invert ? (r[sec.archive] ? 'Deactivate' : 'Activate') : (r[sec.archive] ? 'Restore' : 'Archive')), ' ',
        h('button', { class: 'small danger', onclick: guard(err, async () => { if (confirm(`Delete ${r.name}?`)) { await api('DELETE', `/admin/${sec.kind}/${r.id}`); render(); } }) }, 'Delete'))))))) : h('p', { class: 'muted' }, `No ${sec.title.toLowerCase()} yet.`));
}
const ROLE_LIST = ['Sub Admin', 'Exec Assistant', 'Estimator', 'Project Manager']; // Super Admin is the owner only
async function usersSection() {
  const rows = await api('GET', '/admin/users'); const err = h('div');
  const userForm = (u) => {
    const f = { email: h('input', { type: 'email', value: u?.email ?? '', disabled: !!u }), name: h('input', { value: u?.name ?? '' }), title: h('input', { value: u?.title ?? '', placeholder: 'Estimator, Exec Assistant…' }), phone: h('input', { type: 'tel', value: u?.phone ?? '', placeholder: 'Used in follow-up emails' }), role: h('select', {}, ROLE_LIST.map((r) => h('option', { value: r }, r))), pw: h('input', { type: 'password', autocomplete: 'new-password', placeholder: u ? 'Leave blank to keep' : 'Min 10 characters' }) };
    if (u) f.role.value = u.role;
    formModal(u ? `Edit ${u.email}` : 'Add user', [field('Company email', f.email), field('Name', f.name), field('Title', f.title), field('Phone', f.phone), field('Access level', f.role), field(u ? 'New password' : 'Password', f.pw)], async () => {
      if (u) { const body = { name: f.name.value, title: f.title.value, phone: f.phone.value, role: f.role.value }; if (f.pw.value) body.password = f.pw.value; await api('PUT', '/admin/users/' + u.id, body); }
      else await api('POST', '/admin/users', { email: f.email.value, name: f.name.value, title: f.title.value, phone: f.phone.value, role: f.role.value, password: f.pw.value });
      render();
    }, u ? 'Save' : 'Add user');
  };
  return h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', {}, 'Users & access'), h('button', { class: 'primary', onclick: () => userForm(null) }, '+ Add user')), err,
    h('p', { class: 'muted' }, 'Super Admin: owner only. Sub Admin and Exec Assistant manage records and money. Estimators work the estimating funnel. Project Managers see assigned projects.'),
    h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['Email', 'Name', 'Title', 'Access', 'Active'].map((t) => h('th', {}, t)), h('th'))),
      h('tbody', {}, rows.map((u) => h('tr', { class: u.active ? '' : 'muted' }, h('td', {}, u.email), h('td', {}, u.name), h('td', {}, u.title || ''), h('td', {}, u.role), h('td', {}, u.active ? 'Yes' : 'No'),
        h('td', {}, u.role === 'Super Admin' ? h('span', { class: 'muted' }, 'Owner') : [h('button', { class: 'small', onclick: () => userForm(u) }, 'Edit'), ' ', h('button', { class: 'small', onclick: guard(err, async () => { await api('PUT', '/admin/users/' + u.id, { active: !u.active }); render(); }) }, u.active ? 'Deactivate' : 'Activate')])))))));
}
async function adminView() {
  const parts = [];
  for (const s of SECTIONS) parts.push(await adminSection(s));
  if (['Super Admin', 'Sub Admin'].includes(state.user.role)) parts.push(await bidFeedCard());
  parts.push(await clockSettingsCard());
  if (['Super Admin', 'Sub Admin'].includes(state.user.role)) parts.push(await overheadCard());
  parts.push(await aiCard()); if (isSuper()) parts.push(await aiReportCard());
  if (isSuper()) parts.push(await usersSection());
  return shell('admin', [h('h1', {}, 'Admin'), h('p', { class: 'sub' }, 'Create vendors, suppliers, employees, trades and GCs here. Projects pick from these lists. Archive instead of delete once a record has history.'), ...parts]);
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
    const view = page === 'estimating' ? await estimatingView(id, tab) : page === 'messages' ? await messagesView(id) : page === 'admin' ? await adminView() : page === 'receipts' ? await receiptsView() : page === 'compliance' ? await complianceView() : page === 'projects' ? (id ? await projectView(id, tab) : await projectsView()) : page === 'reports' ? await reportsView() : await dashboardView();
    if (token === rendering) { $app.replaceChildren(view); updateBell(); }
  } catch (e) { if (token === rendering && state.user) $app.replaceChildren(shell(page, h('div', { class: 'err' }, e.message))); }
}
addEventListener('hashchange', render);
boot();
