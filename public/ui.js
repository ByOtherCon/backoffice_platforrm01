// Shared UI kit: every screen (office app and field clock) builds forms, modals and messages from these.

// App rule: the first letter of each word is a capital in buttons, headings, tabs, table headers and labels
// ("Receipts & Supplier Invoices"), including words like "and". Sentences (long text) are left alone.
export const titleCase = (text) => {
  const s = String(text); const words = s.trim().split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 7 || (/[.!?]\s*$/.test(s.trim()) && words.length > 3)) return s;   // a sentence, not a title
  const BRAND = '\u0001';   // the company name is "by Other" and stays that way
  return s.replace(/\bby Other\b/g, BRAND).replace(/(^|[\s(\[\/\-\u2013\u2014+])([a-z][^\s)\]\/\-]*)/g, (m, pre, word) => (/[0-9@:]|^https?/.test(word) ? m : pre + word[0].toUpperCase() + word.slice(1))).replaceAll(BRAND, 'by Other');   // codes, emails, links and times are left as they are
};
const TITLED = new Set(['button', 'th', 'label', 'h1', 'h2', 'h3', 'h4', 'summary', 'legend']);
const titled = (tag, attrs, kid) => typeof kid === 'string' && (TITLED.has(tag) || (tag === 'a' && String(attrs?.href || '').startsWith('#/'))) ? titleCase(kid) : kid;

// A small trash can for the "Delete" / "Remove" buttons that sit in table rows: it takes far less room than the word.
const trashIcon = () => { const NS = 'http://www.w3.org/2000/svg', s = document.createElementNS(NS, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', '16'); s.setAttribute('height', '16'); s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(NS, 'path'); p.setAttribute('d', 'M3 6h18M8 6V4h8v2m-9 0l1 14h8l1-14M10 10v7M14 10v7'); p.setAttribute('fill', 'none'); p.setAttribute('stroke', 'currentColor'); p.setAttribute('stroke-width', '2'); p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round'); s.append(p); return s; };
export const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if ((k === 'href' || k === 'src' || k === 'action' || k === 'formaction') && /^\s*(javascript|vbscript|data):/i.test(String(v))) continue;   // never a script link, whatever the data says
    else el.setAttribute(k, v === true ? '' : v);
  }
  const only = kids.flat(Infinity).filter((x) => x != null && x !== false);
  if (tag === 'button' && /\bdanger\b/.test(attrs?.class || '') && only.length === 1 && typeof only[0] === 'string' && /^(delete|remove)$/i.test(only[0].trim())) {
    el.classList.add('icon'); if (!el.title) el.title = only[0].trim(); el.setAttribute('aria-label', only[0].trim()); el.append(trashIcon()); return el;
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(titled(tag, attrs, typeof kid === 'string' ? kid : kid))));
  return el;
};

export const usd = (n) => (n == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n));

export const pct = (n) => (n == null ? '—' : n.toFixed(1) + '%');

export const cls = (n) => (n < 0 ? 'neg' : '');

export const notice = (box, msg, kind = 'err') => { box.replaceChildren(msg ? h('div', { class: kind }, msg) : ''); };

// A second click while the first is still working is ignored (a double click on a folder button must open one picker, not two).
export const oneAtATime = (fn) => { let busy = false; return async (...a) => { if (busy) return; busy = true; try { return await fn(...a); } finally { busy = false; } }; };
// The browser's folder picker complains in a few cases that are not the person's fault; say what to do instead.
export const folderError = (e) => (e?.name === 'AbortError' ? new Error('No folder was chosen.') : /user gesture|already active/i.test(e?.message || '') ? new Error('Press the button once and choose the folder in the window that opens.') : e);
export const guard = (box, fn) => async (...a) => { try { notice(box, ''); await fn(...a); } catch (e) { notice(box, e.message); } };

// A snapshot of everything typed or chosen in a window, to tell whether anything was entered.
const formState = (root) => [...root.querySelectorAll('input, select, textarea')].map((el) => (el.type === 'file' ? [...(el.files || [])].map((f) => f.name + f.size).join(',') : el.type === 'checkbox' || el.type === 'radio' ? String(el.checked) : el.value)).join('\u0001');
// mode: 'info' closes on a click outside; 'new' (a record being added) closes on a click outside, but asks first when something was entered;
// 'edit' (data that already exists) only closes with Close, Cancel or Save, so a stray click never loses the changes.
export function modal(title, content, opts = {}) {
  const mode = opts.mode ?? (isNewForm(title) ? 'new' : content?.querySelector?.('form') ? 'edit' : 'info');
  let downOnBackdrop = false, start = '';
  const box = h('div', { class: 'modal' }, h('div', { class: 'row spread' }, h('h2', {}, title), h('button', { class: 'small', type: 'button', onclick: () => bg.remove() }, 'Close')), content);
  const bg = h('div', { class: 'modal-bg', onmousedown: (e) => { downOnBackdrop = e.target === bg; }, onclick: (e) => {
    const real = e.target === bg && downOnBackdrop; downOnBackdrop = false;   // a drag that began inside the window (selecting text) never counts
    if (!real || mode === 'edit') return;
    if (mode === 'new' && formState(box) !== start && !confirm('Close without saving what you entered?')) return;
    bg.remove();
  } }, box);
  document.body.append(bg); start = formState(box); return bg;
}

export const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export const field = (label, input, cls2 = '') => h('div', { class: cls2 }, h('label', {}, label), input);

// New records (a title starting with Add, New, Enter, Vendor invoice, Review or Import) can be dismissed by clicking outside, after a check when something was typed.
// Everything else, every form for data that already exists, has to be saved, cancelled or closed on purpose.
function isNewForm(title) { return /^(add|new|enter|vendor invoice|review receipt|import|change order from a document)\b/i.test(String(title).trim()); }
export function formModal(title, fields, onSave, saveLabel = 'Save') {
  const err = h('div'); let saving = false;   // a second press of Save while the first is still working does nothing, so nothing is entered twice
  const bg = modal(title, h('form', { onsubmit: guard(err, async (e) => { e.preventDefault(); if (saving) return; saving = true; const b = e.target.querySelector('button[type=submit]'); if (b) b.disabled = true; try { await onSave(); bg.remove(); } finally { saving = false; if (b) b.disabled = false; } }) },
    h('div', { class: 'form' }, fields), err, h('div', { class: 'row', style: 'margin-top:1rem;justify-content:flex-end;gap:.5rem' }, h('button', { type: 'button', onclick: () => bg.remove() }, 'Cancel'), h('button', { class: 'primary', type: 'submit' }, saveLabel))), { mode: isNewForm(title) ? 'new' : 'edit' });
  return bg;
}

export const num = (v = '', extra = {}) => h('input', { type: 'number', step: '0.01', min: '0', value: v, ...extra });
