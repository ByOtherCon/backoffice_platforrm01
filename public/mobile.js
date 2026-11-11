// The phone layout: a bottom tab bar with a "More" sheet, and tables that turn into tappable cards.
// Nothing here changes what the app does; on a wide screen none of it shows.
import { h, modal } from './ui.js';

const NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  dashboard: ['M3 3h7v7H3z', 'M14 3h7v7h-7z', 'M14 14h7v7h-7z', 'M3 14h7v7H3z'],
  projects: ['M20 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z', 'M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16'],
  estimating: ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6', 'M16 13H8', 'M16 17H8'],
  messages: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'],
  reports: ['M18 20V10', 'M12 20V4', 'M6 20v-6'],
  quickbooks: ['M12 1v22', 'M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6'],
  compliance: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', 'M9 12l2 2 4-4'],
  timepay: ['M12 2a10 10 0 1 0 0 20 10 10 0 1 0 0-20z', 'M12 6v6l4 2'],
  timeclock: ['M12 2a10 10 0 1 0 0 20 10 10 0 1 0 0-20z', 'M12 6v6l4 2'],
  admin: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z'],
  more: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
};
export const icon = (name, size = 22) => {
  const s = document.createElementNS(NS, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', size); s.setAttribute('height', size); s.setAttribute('aria-hidden', 'true');
  for (const d of ICONS[name] || ICONS.more) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); p.setAttribute('fill', 'none'); p.setAttribute('stroke', 'currentColor'); p.setAttribute('stroke-width', name === 'more' ? '3' : '1.8'); p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round'); s.append(p); }
  return s;
};

// The four most used places sit on the bar; everything else (and the account buttons) is behind More.
// nav: [[id, label], ...] in the order the desktop menu shows them. extras: { alerts, password, signOut } handlers.
export function phoneTabs(nav, active, extras) {
  const prefer = ['dashboard', 'projects', 'estimating', 'messages'], main = prefer.map((id) => nav.find((n) => n[0] === id)).filter(Boolean);
  for (const n of nav) if (main.length < 4 && !main.includes(n)) main.push(n);
  const rest = nav.filter((n) => !main.includes(n));
  const sheet = () => { const bg = modal('More', h('div', { class: 'more-list' },
    rest.map(([id, label]) => h('a', { href: '#/' + id, class: active === id ? 'on' : '', onclick: () => bg.remove() }, icon(id, 22), h('span', {}, label))),
    h('div', { class: 'more-acct' }, h('button', { onclick: () => { bg.remove(); extras.alerts(); } }, 'Alerts'), h('button', { onclick: () => { bg.remove(); extras.password(); } }, 'Change Password'), h('button', { class: 'danger', onclick: extras.signOut }, 'Sign Out')))); };
  return h('nav', { class: 'tabbar', 'aria-label': 'Main' },
    main.map(([id, label]) => h('a', { href: '#/' + id, class: active === id ? 'on' : '' }, icon(id), h('span', {}, label), id === 'messages' ? h('i', { class: 'bubble msg-b', style: 'display:none' }) : '')),
    h('button', { type: 'button', class: 'tab-more' + (rest.some((n) => n[0] === active) ? ' on' : ''), onclick: sheet }, icon('more'), h('span', {}, 'More')));
}

// Tables become cards on a phone: each cell is labelled with its column heading so it reads as "Label  Value". The CSS does the layout;
// this only writes the labels (and notes which tables can be stacked). Runs whenever the page changes.
const textOf = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();
export function labelTables(root = document) {
  for (const t of root.querySelectorAll('table')) {
    if (t.classList.contains('nostack') || t.classList.contains('minitable')) continue;
    const head = t.tHead?.rows?.[t.tHead.rows.length - 1]; if (!head || head.cells.length < 2) continue;
    const labels = []; for (const c of head.cells) { const n = Math.max(1, c.colSpan || 1); for (let i = 0; i < n; i++) labels.push(textOf(c)); }
    // a cell that spans several columns has no single heading
    for (const body of [...t.tBodies, ...(t.tFoot ? [t.tFoot] : [])]) for (const r of body.rows) { let i = 0; for (const c of r.cells) { c.setAttribute('data-label', (c.colSpan || 1) > 1 ? '' : labels[i] || ''); i += Math.max(1, c.colSpan || 1); } }
    t.classList.add('m-stack');
  }
}
export function installMobile() {
  let timer = 0; const run = () => { clearTimeout(timer); timer = setTimeout(() => labelTables(document.querySelector('main') || document), 60); };
  new MutationObserver(run).observe(document.body, { childList: true, subtree: true }); run();
}
