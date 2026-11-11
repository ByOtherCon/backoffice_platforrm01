// The dashboard: a grid of widgets (like phone widgets). Each can be small, medium, large or full width, shows more or less detail, and
// can be moved, hidden or added back in Edit mode. The to-do list and messages can be moved but never removed. Everything is inserted with
// textContent (never innerHTML). Data comes from /api/dashboard/widgets, which only includes cards this person is allowed to see.
import { h, usd, pct, cls, guard, notice } from '/ui.js';
let C;
export const init = (c) => { C = c; };
const api = (...a) => C.api(...a);
const render = () => C.render();
const state = new Proxy({}, { get: (_, k) => C.state[k], set: (_, k, v) => { C.state[k] = v; return true; } });
const SVGNS = 'http://www.w3.org/2000/svg';

const TITLES = { estimating: 'Estimating', presence: 'Time Clock: Who Is In', costing: 'Costing At A Glance', chart: 'Billed Vs. Cost', receivables: 'Owed To Us (Aging)', payables: 'We Owe', projects: 'Projects', forecast: 'Forecast', compliance: 'Compliance & Approvals', overhead: 'Company Overhead', todos: 'My To-Dos', messages: 'Messages' };
const SIZES = [['S', 'Small'], ['M', 'Medium'], ['L', 'Large'], ['XL', 'Full Width']];
const DETAILS = [['compact', 'Compact'], ['standard', 'Standard'], ['full', 'Full']];

// ---------------------------------------------------------------- sizes: a card never gets smaller than its content needs
// A wide table is awkward in a small card, so the more columns a level of detail shows, the wider the card must be.
const ORDER = ['S', 'M', 'L', 'XL'];
const MIN = { projects: { compact: 'M', standard: 'L', full: 'XL' }, chart: { compact: 'M', standard: 'M', full: 'L' }, payables: { full: 'M' }, receivables: { full: 'M' }, todos: { full: 'M' }, messages: { full: 'M' }, costing: { full: 'M' }, estimating: { standard: 'M', full: 'M' }, compliance: { standard: 'M', full: 'M' } };
const minSize = (id, detail) => MIN[id]?.[detail] || 'S';
const effSize = (w) => ORDER[Math.max(ORDER.indexOf(w.size || 'M'), ORDER.indexOf(minSize(w.id, w.detail || 'standard')))];

// ---------------------------------------------------------------- state
let data = null, layout = [], period = 'month', editing = false, saveTimer = null, dragId = null, root = null;
function mergeLayout(d) {
  const allowed = d.widgets, saved = d.prefs?.widgets, defs = d.defaults || [];
  const defOf = (id) => defs.find((w) => w.id === id) || { id, visible: false, size: 'M', detail: 'standard' };
  let list;
  if (saved?.length) {
    list = saved.filter((w) => allowed.includes(w.id)).map((w) => ({ ...defOf(w.id), ...w }));
    for (const id of allowed) if (!list.some((w) => w.id === id)) list.push({ ...defOf(id), visible: false });   // a card added to the system later waits in the tray
  } else list = defs.map((w) => ({ ...w }));
  for (const id of d.locked || []) { const w = list.find((x) => x.id === id); if (w) w.visible = true; }
  return list;
}
const persist = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api('PUT', '/prefs/dashboard', { widgets: layout.map(({ id, visible, size, detail }) => ({ id, visible, size, detail })), period }).catch((e) => { const box = root?.querySelector('.dash-err'); if (box) notice(box, e.message); }), 350);
};
const isLocked = (id) => (data.locked || []).includes(id);

// ---------------------------------------------------------------- small pieces
const kpi = (l, v, tone = '', href) => h(href ? 'a' : 'div', { class: 'kpi ' + tone, href, style: href ? 'text-decoration:none;color:inherit;display:block' : null }, h('div', { class: 'l' }, l), h('div', { class: 'v' }, v));
const kgrid = (size, items) => h('div', { class: 'kgrid kg-' + size }, items);
const th = (t, n) => h('th', { class: n ? 'n' : '' }, t);
const empty = (t) => h('p', { class: 'muted', style: 'margin:.2rem 0' }, t);
const more = (href, label) => h('p', { style: 'margin:.7rem 0 0;font-size:13px' }, h('a', { href }, label));
const toggle = (cur, set, opts) => h('div', { class: 'row', style: 'gap:.3rem' }, opts.map(([m, l]) => h('button', { class: 'small' + (cur === m ? ' primary' : ''), onclick: () => { set(m); render(); } }, l)));

function barChart(series, mode, tall) {
  const rows = mode === 'quarter' ? Object.values(series.reduce((m, x) => { const [y, mo] = x.month.split('-'); const k = `${y} Q${Math.ceil(Number(mo) / 3)}`; (m[k] ||= { label: k, revenue: 0, cost: 0 }); m[k].revenue += x.revenue; m[k].cost += x.cost; return m; }, {})) : series.map((x) => ({ label: new Date(x.month + '-15').toLocaleDateString(undefined, { month: 'short' }), revenue: x.revenue, cost: x.cost }));
  const W = 560, H = tall ? 240 : 170, pad = { l: 8, r: 8, t: 12, b: 26 }, max = Math.max(1, ...rows.flatMap((r) => [r.revenue, r.cost])), bw = (W - pad.l - pad.r) / rows.length;
  const svg = document.createElementNS(SVGNS, 'svg'); svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('width', '100%'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Billed versus cost by ' + mode);
  const el = (n, a, t) => { const e = document.createElementNS(SVGNS, n); for (const [k, v] of Object.entries(a)) e.setAttribute(k, v); if (t) e.textContent = t; return e; };
  svg.append(el('line', { x1: pad.l, x2: W - pad.r, y1: H - pad.b, y2: H - pad.b, stroke: '#e2e5ec' }));
  rows.forEach((r, i) => { const x = pad.l + i * bw, h1 = ((H - pad.t - pad.b) * r.revenue) / max, h2 = ((H - pad.t - pad.b) * r.cost) / max;
    const b1 = el('rect', { x: x + bw * 0.12, y: H - pad.b - h1, width: bw * 0.36, height: Math.max(0, h1), fill: '#1B1462', rx: 2 }); b1.append(el('title', {}, `${r.label}: billed ${usd(r.revenue)}`));
    const b2 = el('rect', { x: x + bw * 0.52, y: H - pad.b - h2, width: bw * 0.36, height: Math.max(0, h2), fill: '#b6bac6', rx: 2 }); b2.append(el('title', {}, `${r.label}: cost ${usd(r.cost)}`));
    svg.append(b1, b2, el('text', { x: x + bw / 2, y: H - 9, 'text-anchor': 'middle', 'font-size': 10.5, fill: '#7b8294' }, r.label)); });
  return svg;
}

// ---------------------------------------------------------------- each widget: body only, by size and level of detail
// A renderer returns { body, actions } or null when there is nothing to show for this person.
const RENDER = {
  estimating: (d, { size, detail }) => {
    const e = d.estimating; if (!e) return null;
    const all = [kpi('Open leads', e.openLeads, '', '#/estimating/bids'), kpi('Working now', e.working, '', '#/estimating/proposals'), kpi('Follow-ups due', e.awaitingFollowUp, e.awaitingFollowUp ? 'warn' : '', '#/estimating/submissions'), kpi('Submitted this month', e.submitted, '', '#/estimating/submissions'), kpi('Interested', e.interested, e.interested ? 'good' : ''), kpi('Win rate', e.winRate == null ? '—' : e.winRate + '%', '', '#/estimating/insights'), kpi('Expected awards', e.expectedAwards == null ? '—' : usd(e.expectedAwards), 'good', '#/estimating/insights')];
    return { body: kgrid(size, detail === 'compact' ? all.slice(0, 3) : all) };
  },
  presence: (d, { size, detail }) => {
    const p = d.presence; if (!p) return null;
    if (detail === 'compact') return { body: h('div', {}, kpi('Clocked in now', p.active.length, p.active.length ? 'good' : ''), h('p', { class: 'muted', style: 'margin:.4rem 0 0;font-size:13px' }, `${p.weekHours.toFixed(1)} hours this week`)) };
    return { body: h('div', {}, p.active.length ? p.active.map((a) => h('div', { style: 'padding:.3rem 0;border-bottom:1px solid var(--line)' }, h('span', { class: 'dot' }), h('strong', {}, a.employee), ` · ${a.project}${a.trade ? ' / ' + a.trade : ''}`, h('span', { class: 'muted', style: 'margin-left:.5rem;font-size:13px' }, 'since ' + new Date(a.since).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })), a.late ? h('span', { class: 'pill Pending', style: 'margin-left:.4rem' }, 'Late') : '')) : empty('No one is clocked in right now.'), h('p', { class: 'muted', style: 'margin-top:.6rem' }, `${p.weekHours.toFixed(1)} hours logged this week.`)) };
  },
  costing: (d, { size, detail }) => {
    const c = d.costing; if (!c) return null;
    const all = [kpi('Active projects', c.activeProjects), kpi('Contract value', usd(c.contract)), kpi('Billed', usd(c.billed)), kpi('Received', usd(c.received)), kpi('Owed by GCs', usd(c.totalOwed), 'warn'), kpi('Due now', usd(c.currentlyDue), c.currentlyDue > 0 ? 'warn' : ''), kpi('Retainage held', usd(c.retainageOutstanding)), kpi('Payables', usd(c.totalPayable)), kpi('Projected profit', usd(c.projectedProfit), c.projectedProfit < 0 ? 'bad' : 'good'), kpi('Margin', pct(c.marginPct))];
    return { body: kgrid(size, detail === 'compact' ? [all[1], all[2], all[3], all[4]] : all) };
  },
  chart: (d, { size, detail }) => {
    if (!d.series) return null; const mode = state.chartMode || 'month';
    return { actions: detail === 'compact' ? null : toggle(mode, (m) => { state.chartMode = m; }, [['month', 'Monthly'], ['quarter', 'Quarterly']]),
      body: h('div', {}, barChart(d.series, mode, detail === 'full' || size === 'XL'), detail === 'compact' ? '' : h('div', { class: 'row', style: 'gap:1rem;margin-top:.3rem;font-size:13px' }, h('span', {}, h('span', { class: 'dot', style: 'background:#1B1462' }), 'Billed'), h('span', {}, h('span', { class: 'dot', style: 'background:#b6bac6' }), 'Job cost (subcontractors, vendors, labor)'), h('span', { class: 'muted', style: 'margin-left:auto' }, `Profit, last 12 months: ${usd(d.series.reduce((n, x) => n + x.profit, 0))}`))) };
  },
  receivables: (d, { detail }) => {
    if (!d.receivables) return null; const tot = d.receivables.reduce((n, r) => n + r.amount, 0), worst = [...d.receivables].filter((r) => r.bucket !== 'Not due' && r.bucket !== 'No due date' && r.amount > 0).pop();
    if (detail === 'compact') return { body: h('div', {}, kpi('Collectable now', usd(tot), 'warn'), worst ? h('p', { class: 'muted', style: 'margin:.4rem 0 0;font-size:13px' }, `Oldest: ${worst.bucket} ${usd(worst.amount)}`) : '') };
    return { body: h('div', {}, h('table', {}, h('tbody', {}, d.receivables.map((r) => h('tr', {}, h('td', {}, r.bucket), detail === 'full' ? h('td', { style: 'width:45%' }, h('div', { class: 'bar' }, h('i', { style: `width:${tot ? Math.round((r.amount / tot) * 100) : 0}%` }))) : '', h('td', { class: 'n' }, usd(r.amount)))))), h('p', { class: 'muted' }, `Collectable now (retainage excluded): ${usd(tot)}`)) };
  },
  payables: (d, { detail }) => {
    if (!d.payables) return null; const rows = d.payables.top.slice(0, detail === 'full' ? 15 : 5);
    if (detail === 'compact') return { body: kpi('Total owed', usd(d.payables.total)) };
    return { body: h('div', {}, kpi('Total owed', usd(d.payables.total)), rows.length ? h('table', { style: 'margin-top:.6rem' }, h('tbody', {}, rows.map((r) => h('tr', {}, h('td', {}, r.name), h('td', { class: 'muted' }, r.kind), h('td', { class: 'n' }, usd(r.owed)))))) : empty('Nothing owed.')) };
  },
  projects: (d, { size, detail }) => {
    if (!d.projects) return null; const rows = d.projects.slice(0, detail === 'compact' ? 5 : detail === 'standard' ? 10 : 60);
    if (!rows.length) return { body: empty('No active projects.') };
    const cols = detail === 'compact' ? ['Project', 'Margin'] : detail === 'standard' ? ['Project', 'GC', 'Contract', 'Billed', 'Margin'] : ['Project', 'GC', 'Contract', 'Billed', 'Due now', 'Projected profit', 'Margin'];
    const cell = { Project: (p) => h('td', {}, p.name), GC: (p) => h('td', {}, p.gc), Contract: (p) => h('td', { class: 'n' }, usd(p.contract)), Billed: (p) => h('td', { class: 'n' }, usd(p.billed)), 'Due now': (p) => h('td', { class: 'n' }, usd(p.currentlyDue)), 'Projected profit': (p) => h('td', { class: 'n ' + cls(p.projectedProfit) }, usd(p.projectedProfit)), Margin: (p) => h('td', { class: 'n ' + cls(p.projectedProfit) }, pct(p.marginPct)) };
    return { body: h('div', {}, h('div', { class: 'tscroll' }, h('table', { style: size === 'XL' || detail === 'full' ? 'min-width:640px' : '' }, h('thead', {}, h('tr', {}, cols.map((c) => th(c, !['Project', 'GC'].includes(c))))), h('tbody', {}, rows.map((p) => h('tr', { class: 'link', onclick: () => (location.hash = '#/projects/' + p.id) }, cols.map((c) => cell[c](p))))))), d.projects.length > rows.length ? more('#/projects', `All ${d.projects.length} projects`) : more('#/projects', 'Open Projects')) };
  },
  forecast: (d, { size, detail }) => {
    if (!d.forecast) return null; const per = state.fcPeriod || 'quarter', f = d.forecast[per];
    return { actions: detail === 'compact' ? null : toggle(per, (m) => { state.fcPeriod = m; }, [['month', 'Month'], ['quarter', 'Quarter'], ['year', 'Year']]),
      body: f.projected == null ? empty('Not enough billing history yet. This turns on after two completed months of invoices.') : h('div', {}, kgrid(size, detail === 'compact' ? [kpi('Projected', usd(f.projected), 'good')] : [kpi('Billed so far', usd(f.billed)), kpi('Monthly pace', usd(f.pace)), kpi('Projected', usd(f.projected), 'good'), kpi('Left to bill on contracts', usd(d.forecast.backlog))]), detail === 'full' ? h('p', { class: 'muted', style: 'font-size:13px;margin-top:.6rem' }, d.forecast.note) : '') };
  },
  compliance: (d, { size, detail }) => {
    const c = d.compliance; if (!c) return null;
    const all = [kpi('Subcontractors blocked', c.vendorsBlocked.length, c.vendorsBlocked.length ? 'bad' : '', '#/compliance'), kpi('Insurance expiring', c.vendorsExpiring.length, c.vendorsExpiring.length ? 'warn' : '', '#/compliance'), kpi('Payments to approve', c.approvalsWaiting, c.approvalsWaiting ? 'warn' : '', '#/compliance'), kpi('Approved, unpaid', c.readyToPay, '', '#/compliance'), kpi('NTOs needed', c.ntoNeeded, c.ntoNeeded ? 'warn' : '', '#/compliance'), kpi('NTOs overdue', c.ntoOverdue, c.ntoOverdue ? 'bad' : '', '#/compliance')];
    return { body: h('div', {}, kgrid(size, detail === 'compact' ? [all[0], all[2], all[5]] : all), detail !== 'compact' && c.vendorsBlocked.length ? h('p', { class: 'muted', style: 'margin-top:.6rem' }, 'Cannot be paid: ' + c.vendorsBlocked.join(', ')) : '') };
  },
  overhead: (d, { size, detail }) => {
    const o = d.overhead; if (!o) return null;
    return { body: h('div', {}, kgrid(size, detail === 'compact' ? [kpi('Profit after overhead', usd(o.profitAfterOverhead), o.profitAfterOverhead < 0 ? 'bad' : 'good')] : [kpi('Overhead allocated', usd(o.total)), kpi('Profit after overhead', usd(o.profitAfterOverhead), o.profitAfterOverhead < 0 ? 'bad' : 'good')]), detail === 'full' ? h('p', { class: 'muted', style: 'margin-top:.5rem' }, o.lines.map((l) => `${l.name} ${usd(l.total)}`).join(' · ') || 'Add overhead items in Admin.') : '') };
  },
  todos: (d, { detail }) => {
    if (!d.todos) return null; const n = detail === 'compact' ? 4 : detail === 'standard' ? 8 : 25, rows = d.todos.slice(0, n), err = h('div');
    const pri = (t) => (t.priority && t.priority !== 'Normal' ? h('span', { class: 'pill ' + (t.priority === 'Urgent' ? 'Rejected' : t.priority === 'High' ? 'Pending' : ''), style: 'margin-left:.4rem' }, t.priority) : '');
    const add = detail === 'full' ? (() => { const f = h('input', { placeholder: 'Add a to-do for yourself…', style: 'flex:1' }); return h('form', { class: 'row', style: 'margin-bottom:.5rem', onsubmit: guard(err, async (e) => { e.preventDefault(); if (!f.value.trim()) return; await api('POST', '/todos', { title: f.value }); render(); }) }, f, h('button', { class: 'small primary', type: 'submit' }, 'Add')); })() : '';
    return { body: h('div', {}, add, err, rows.length ? rows.map((t) => h('div', { style: 'padding:.3rem 0;border-bottom:1px solid var(--line)' }, h('input', { type: 'checkbox', onchange: guard(err, async () => { await api('PUT', '/todos/' + t.id, { status: 'Done' }); render(); }) }), ' ', t.title, pri(t), t.isNew ? h('span', { class: 'pill Pending', style: 'margin-left:.4rem' }, 'New') : '', t.dueDate ? h('span', { class: 'muted', style: 'margin-left:.5rem;font-size:13px' }, 'due ' + t.dueDate) : '', t.overdue ? h('span', { class: 'pill Expired', style: 'margin-left:.4rem' }, 'Overdue') : '', detail === 'full' && t.notes ? h('div', { class: 'muted', style: 'font-size:13px;margin-left:1.4rem' }, t.notes) : '')) : empty('You are all caught up.'),
      d.todos.length > rows.length ? h('p', { class: 'muted', style: 'font-size:13px;margin:.4rem 0 0' }, `${d.todos.length - rows.length} more`) : '', more('#/messages/todos', 'Open The Full To-Do List')) };
  },
  messages: (d, { detail }) => {
    const m = d.messages; if (!m) return null; const n = detail === 'compact' ? 3 : detail === 'standard' ? 5 : 10, rows = m.items.slice(0, n);
    return { actions: m.unread ? h('span', { class: 'bubble hot', style: 'display:inline-block' }, m.unread) : null,
      body: h('div', {}, rows.length ? rows.map((t) => h('a', { href: '#/messages/' + t.id, style: 'display:block;padding:.4rem 0;border-bottom:1px solid var(--line);text-decoration:none;color:inherit' }, h('div', { style: 'font-weight:' + (t.unread ? '700' : '400') }, t.subject, t.unread ? h('span', { class: 'pill Pending', style: 'margin-left:.4rem' }, t.unread) : ''), detail === 'compact' ? '' : h('div', { class: 'muted', style: 'font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis' }, `${t.from || ''}: ${t.preview || ''}`))) : empty('No conversations yet.'), more('#/messages', 'Open Messages')) };
  },
};

// ---------------------------------------------------------------- layout editing
const visible = () => layout.filter((w) => w.visible);
function move(id, delta) {
  const vis = visible(), i = vis.findIndex((w) => w.id === id), j = i + delta; if (i < 0 || j < 0 || j >= vis.length) return;
  const a = layout.indexOf(vis[i]), b = layout.indexOf(vis[j]); [layout[a], layout[b]] = [layout[b], layout[a]]; persist(); draw();
}
function dropOn(targetId) {
  if (!dragId || dragId === targetId) return;
  const from = layout.findIndex((w) => w.id === dragId); const [m] = layout.splice(from, 1); const to = layout.findIndex((w) => w.id === targetId);
  layout.splice(from < to ? to + 1 : to, 0, m); dragId = null; persist(); draw();
}
const set = (w, k, v) => { w[k] = v; w.size = effSize(w); persist(); draw(); };   // asking for more detail widens the card if it needs it

function controls(w) {
  const seg = (items, cur, pick, min) => h('div', { class: 'seg' }, items.map(([v, l]) => { const tooSmall = min && ORDER.indexOf(v) < ORDER.indexOf(min); return h('button', { type: 'button', class: v === cur ? 'on' : '', disabled: tooSmall ? true : null, title: tooSmall ? 'Too small for this much detail' : l, onclick: () => pick(v) }, v.length <= 2 ? v : l); }));
  return h('div', { class: 'wedit' },
    h('div', { class: 'row', style: 'gap:.3rem' }, h('button', { class: 'small', type: 'button', title: 'Move earlier', onclick: () => move(w.id, -1) }, '‹'), h('button', { class: 'small', type: 'button', title: 'Move later', onclick: () => move(w.id, 1) }, '›'),
      h('span', { class: 'muted', style: 'font-size:12px' }, 'or drag')), seg(SIZES, effSize(w), (v) => set(w, 'size', v), minSize(w.id, w.detail)), seg(DETAILS, w.detail, (v) => set(w, 'detail', v)),
    isLocked(w.id) ? h('span', { class: 'pill', title: 'The to-do list and messages can be moved and resized but not removed.' }, 'Always shown') : h('button', { class: 'small danger', type: 'button', title: 'Take off the dashboard', onclick: () => set(w, 'visible', false) }, 'Remove'));
}
function widgetEl(w) {
  const size = effSize(w), r = RENDER[w.id]?.(data, { size, detail: w.detail }); if (!r) return null;
  const el = h('section', { class: `wcard w-${size}`, 'data-id': w.id, draggable: editing ? 'true' : null },
    h('div', { class: 'whead' }, h('h2', {}, TITLES[w.id]), r.actions || ''), editing ? controls(w) : '', h('div', { class: 'wbody d-' + w.detail }, r.body));
  if (editing) {
    el.addEventListener('dragstart', (e) => { dragId = w.id; el.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', w.id); });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('over'); });
    el.addEventListener('dragleave', () => el.classList.remove('over'));
    el.addEventListener('drop', (e) => { e.preventDefault(); dropOn(w.id); });
  }
  return el;
}
function tray() {
  const hidden = layout.filter((w) => !w.visible && RENDER[w.id]);
  return h('div', { class: 'wtray' }, h('h3', { style: 'margin:0 0 .5rem' }, 'Add To Your Dashboard'),
    hidden.length ? h('div', { class: 'row', style: 'flex-wrap:wrap;gap:.5rem' }, hidden.map((w) => h('button', { class: 'wtile', onclick: () => { w.visible = true; persist(); draw(); } }, h('strong', {}, TITLES[w.id]), h('span', { class: 'muted' }, '+ Add')))) : h('p', { class: 'muted', style: 'margin:0' }, 'Everything available to you is already on your dashboard.'),
    h('div', { class: 'row', style: 'margin-top:.8rem' }, h('button', { onclick: () => { if (confirm('Go back to the starting layout for your job? Your own sizes and order will be replaced.')) { layout = (data.defaults || []).map((w) => ({ ...w })); persist(); draw(); } } }, 'Reset To My Job\'s Layout')));
}
// On a phone: the four numbers worth a glance, as big tiles above the cards (hidden on a wide screen, where the cards already show them).
function glance() {
  const t = [], c = data.costing, e = data.estimating, td = data.todos, pr = data.presence, cp = data.compliance;
  if (c) t.push(['Owed To Us', usd(c.currentlyDue), c.currentlyDue ? 'warn' : '', '#/projects'], ['Billed', usd(c.billed), '', '#/projects']);
  if (e) t.push(['Follow-Ups Due', e.awaitingFollowUp, e.awaitingFollowUp ? 'warn' : '', '#/estimating'], ['Open Leads', e.openLeads, '', '#/estimating']);
  if (td) t.push(['My To-Dos', td.length, '', '#/messages']);
  if (pr) t.push(['Clocked In', pr.active.length, pr.active.length ? 'good' : '', '#/timepay']);
  if (cp) t.push(['Subs Blocked', cp.vendorsBlocked.length, cp.vendorsBlocked.length ? 'bad' : 'good', '#/compliance']);
  return t.length ? h('div', { class: 'glance' }, t.slice(0, 4).map(([l, v, c2, href]) => h('a', { class: 'gtile ' + c2, href }, h('span', { class: 'l' }, l), h('span', { class: 'v' }, String(v))))) : '';
}
function draw() {
  const hr = new Date().getHours(), greet = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening', name = C.state.user.name && !C.state.user.name.includes('@') ? ', ' + C.state.user.name.split(' ')[0] : '';
  const cards = visible().map(widgetEl).filter(Boolean);
  root.replaceChildren(
    h('div', { class: 'row spread dash-top' }, h('h1', {}, greet + name), h('button', { class: editing ? 'primary' : '', onclick: () => { editing = !editing; draw(); } }, editing ? 'Done' : 'Edit Dashboard')),
    editing ? '' : glance(),
    h('div', { class: 'dash-err' }), editing ? h('p', { class: 'muted', style: 'margin:-.4rem 0 .8rem' }, 'Drag a card, or use the arrows, to move it. Pick a size and how much detail it shows. Changes save as you go and are only for you.') : '',
    cards.length ? h('div', { class: 'dash' + (editing ? ' editing' : '') }, cards) : h('div', { class: 'card soon' }, 'Nothing is turned on. Use Edit Dashboard to add cards.'), editing ? tray() : '');
}

export async function dashboardView() {
  data = await api('GET', '/dashboard/widgets'); layout = mergeLayout(data); period = data.prefs?.period || 'month'; root = h('div'); draw();
  return C.shell('dashboard', [root]);
}
