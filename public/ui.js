// Shared UI kit: every screen (office app and field clock) builds forms, modals and messages from these.
export const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
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
