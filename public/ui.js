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

export const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(titled(tag, attrs, typeof kid === 'string' ? kid : kid))));
  return el;
};

export const usd = (n) => (n == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n));

export const pct = (n) => (n == null ? '—' : n.toFixed(1) + '%');

export const cls = (n) => (n < 0 ? 'neg' : '');

export const notice = (box, msg, kind = 'err') => { box.replaceChildren(msg ? h('div', { class: kind }, msg) : ''); };

export const guard = (box, fn) => async (...a) => { try { notice(box, ''); await fn(...a); } catch (e) { notice(box, e.message); } };

export function modal(title, content) {
  const bg = h('div', { class: 'modal-bg', onclick: (e) => { if (e.target === bg) bg.remove(); } }, h('div', { class: 'modal' }, h('div', { class: 'row spread' }, h('h2', {}, title), h('button', { class: 'small', onclick: () => bg.remove() }, 'Close')), content));
  document.body.append(bg); return bg;
}

export const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export const field = (label, input, cls2 = '') => h('div', { class: cls2 }, h('label', {}, label), input);

export function formModal(title, fields, onSave, saveLabel = 'Save') {
  const err = h('div');
  const bg = modal(title, h('form', { onsubmit: guard(err, async (e) => { e.preventDefault(); await onSave(); bg.remove(); }) },
    h('div', { class: 'form' }, fields), err, h('div', { class: 'row', style: 'margin-top:1rem;justify-content:flex-end' }, h('button', { class: 'primary', type: 'submit' }, saveLabel))));
  return bg;
}

export const num = (v = '', extra = {}) => h('input', { type: 'number', step: '0.01', min: '0', value: v, ...extra });
