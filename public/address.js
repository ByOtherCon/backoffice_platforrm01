// The one address box used by every form (project, vendor, subcontractor, the estimating form): street, city, state, ZIP.
// It checks itself against the address service and shows a green check; "Change" reopens the fields.
// kind: 'project' = Florida only (state fixed), 'gc' and 'other' = any state. Everything is inserted with textContent (never innerHTML).
import { h, notice, field } from '/ui.js';

// Street, city, state, ZIP. It checks itself: when street and city are filled in (or on opening an unchecked address) the address is
// verified, the fields fold into one line, and a green check shows next to the heading. "Change" reopens the fields.
export function addressBlock(api, { kind, init, label, readonly = false }) {
  const f = { street: h('input', { placeholder: '123 Main St', autocomplete: 'off', disabled: readonly || null }), city: h('input', { placeholder: 'City', autocomplete: 'off', disabled: readonly || null }), state: h('input', { maxlength: 2, placeholder: 'FL', style: 'text-transform:uppercase', disabled: readonly || kind === 'project' ? true : null }), zip: h('input', { maxlength: 10, inputmode: 'numeric', placeholder: '32801', disabled: readonly || null }) };
  let token = null, verified = false, method = '', busy = false, okSnap = ''; const msg = h('div'), box = h('div', { class: 'addr' }), tick = h('span', { style: 'color:var(--green);font-weight:700;margin-left:.45rem' }), head = h('label', {}, label, tick);
  const read = () => ({ street: f.street.value.trim(), city: f.city.value.trim(), state: (kind === 'project' ? 'FL' : f.state.value).trim().toUpperCase(), zip: f.zip.value.trim() });
  const line = () => { const v = read(); return [v.street, v.city, [v.state, v.zip].filter(Boolean).join(' ')].filter(Boolean).join(', '); };
  const empty = () => { const v = read(); return !v.street && !v.city && !v.zip; };
  function set(a, tok = null) { f.street.value = a?.street || ''; f.city.value = a?.city || ''; f.state.value = kind === 'project' ? 'FL' : a?.state || (kind === 'other' ? 'FL' : ''); f.zip.value = a?.zip || ''; verified = !!(a?.verified && a?.street); token = verified ? tok : null; method = ''; okSnap = verified ? JSON.stringify(read()) : ''; draw(); }
  async function verify(silent) {
    if (busy) return; busy = true; notice(msg, '');
    try {
      const r = await api('POST', '/address/verify', { ...read(), kind });
      if (r.verified) { Object.entries(r.address).forEach(([k, v]) => (f[k].value = v)); token = r.token; verified = true; method = r.method; okSnap = JSON.stringify(read()); draw(); }
      else if (r.noMatch) { notice(msg, r.errors[0]); if (r.token) msg.append(h('button', { type: 'button', class: 'small', style: 'margin-top:.3rem', onclick: () => { Object.entries(r.address).forEach(([k, v]) => (f[k].value = v)); token = r.token; verified = true; method = 'format'; okSnap = JSON.stringify(read()); draw(); } }, 'Use as entered')); }
      else if (!silent) notice(msg, (r.errors || ['That address could not be verified.']).join(' '));
    } catch (e) { if (!silent) notice(msg, e.message); } finally { busy = false; }
  }
  function draw() {
    tick.textContent = verified ? '✓' : ''; tick.title = verified ? (method === 'format' ? 'Address looks complete' : 'Address verified') : '';
    if (verified) box.replaceChildren(h('div', { class: 'addr-ok' }, h('span', { class: 'tick' }, '✓'), h('span', {}, line()), readonly ? '' : h('button', { type: 'button', class: 'small', onclick: () => { verified = false; token = null; draw(); } }, 'Change')));
    else box.replaceChildren(h('div', { class: 'form' }, field('Street', f.street, 'wide'), field('City', f.city), field('State', f.state), field('ZIP', f.zip), readonly ? '' : h('div', {}, h('button', { type: 'button', onclick: () => verify(false) }, 'Verify address'))), msg);
  }
  const auto = () => { const v = read(); if (!readonly && !verified && v.street && v.city) verify(true); };
  for (const k of ['street', 'city', 'state', 'zip']) f[k].addEventListener('change', () => { if (verified && JSON.stringify(read()) === okSnap) return; verified = false; token = null; auto(); });   // a change event from a box that was just replaced changes nothing
  const snap = () => JSON.stringify(read()); let first = '';
  set(init); first = snap(); if (!verified) setTimeout(auto, 0);
  if (readonly && empty()) box.replaceChildren(h('span', { class: 'muted' }, '—'));
  const get = () => ({ ...read(), ...(token ? { token } : {}) });
  // What a form sends: nothing when the address was not touched, an empty address to clear it, otherwise the checked address.
  const payload = () => {
    if (readonly || snap() === first) return {};
    if (empty()) return { addr: {} };
    if (!verified) throw new Error('Press "Verify address" on the address (or clear it) before saving.');
    return { addr: get() };
  };
  return { el: box, head, set: (a, t) => { set(a, t); first = snap(); }, verifyNow: () => verify(true), empty, ok: () => verified, get, payload };
}
