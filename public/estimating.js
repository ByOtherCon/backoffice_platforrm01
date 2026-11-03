// Estimating screens: Bid Opportunities, Proposal Tracker, Submittal Tracker, Follow Ups, Insights, and the one opportunity form
// that every tracker uses. Everything is inserted with textContent (never innerHTML).
import { h, usd, notice, guard, modal, formModal, field, todayStr, num } from '/ui.js';
let C;
export const init = (c) => { C = c; };
const api = (...a) => C.api(...a);
const render = () => C.render();
const uploadFile = (...a) => C.uploadFile(...a);
const state = new Proxy({}, { get: (_, k) => C.state[k], set: (_, k, v) => { C.state[k] = v; return true; } });
const canEstimate = () => C.canEstimate();

let OPTS = null;
const opts = async () => (OPTS ||= await api('GET', '/estimating/options'));
const sname = (s) => (s === 'No Communication' ? 'No Communication From GC' : s);
const TONE = { Reviewing: 'Pending', Accepted: 'Approved', Started: 'Approved', Submitted: 'Valid', Declined: 'Rejected', 'Decided Not To Submit': 'Rejected', Awarded: 'Approved', 'Not Awarded': 'Rejected', 'No Communication': 'Pending' };
const pill = (s) => h('span', { class: 'pill ' + (TONE[s] || '') }, sname(s));
const fmtDay = (d) => { if (!d) return '—'; const dt = new Date(String(d).slice(0, 10) + 'T12:00:00'); return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(dt.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) }); };
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const sub = (t) => h('div', { class: 'muted', style: 'font-size:13px' }, t);
const addrLine = (o) => [o.address, o.city, o.zip ? 'FL ' + o.zip : ''].filter(Boolean).join(', ');

// ---------------------------------------------------------------- pieces every form shares
const summary = (o) => h('div', { class: 'osum' }, h('strong', {}, o.name), o.proposalId ? h('span', {}, '· ' + o.proposalId) : '', h('span', { class: 'muted' }, [o.gc, addrLine(o), o.due ? 'Bid due ' + fmtDay(o.due) : 'No bid due date'].filter(Boolean).join(' · ')), pill(o.status));
const star = () => h('span', { class: 'req' }, ' *');
const lbl = (t, required) => h('span', {}, t, required ? star() : '');

// Street, city, state, ZIP. Press Verify: a match gets a green check and the fields fold away into one line. Change reopens them.
function addressBlock({ kind, init, optional }) {
  const f = { street: h('input', { placeholder: '123 Main St', autocomplete: 'off' }), city: h('input', { placeholder: 'City', autocomplete: 'off' }), state: h('input', { maxlength: 2, placeholder: 'FL', style: 'text-transform:uppercase', disabled: kind !== 'gc' ? true : null }), zip: h('input', { maxlength: 10, inputmode: 'numeric', placeholder: '32801' }) };
  let token = null, verified = false; const msg = h('div'), box = h('div');
  const read = () => ({ street: f.street.value.trim(), city: f.city.value.trim(), state: (kind === 'gc' ? f.state.value : 'FL').trim().toUpperCase(), zip: f.zip.value.trim() });
  const line = () => { const v = read(); return [v.street, v.city, [v.state, v.zip].filter(Boolean).join(' ')].filter(Boolean).join(', '); };
  const empty = () => { const v = read(); return !v.street && !v.city && !v.zip; };
  function set(a) { f.street.value = a?.street || ''; f.city.value = a?.city || ''; f.state.value = kind === 'gc' ? a?.state || '' : 'FL'; f.zip.value = a?.zip || ''; verified = !!(a?.verified && a?.street); token = null; draw(); }
  async function verify() {
    notice(msg, ''); const r = await api('POST', '/address/verify', { ...read(), kind });
    if (r.verified) { Object.entries(r.address).forEach(([k, v]) => (f[k].value = v)); token = r.token; verified = true; draw(); }
    else if (r.serviceDown) { notice(msg, r.message, 'ok'); msg.append(h('button', { type: 'button', class: 'small', style: 'margin-top:.3rem', onclick: () => { Object.entries(r.address).forEach(([k, v]) => (f[k].value = v)); token = r.token; verified = true; draw(); } }, 'Use as entered')); }
    else notice(msg, (r.errors || ['That address could not be verified.']).join(' '));
  }
  function draw() {
    if (verified) box.replaceChildren(h('div', { class: 'addr-ok' }, h('span', { class: 'tick' }, '✓'), h('span', {}, line()), h('button', { type: 'button', class: 'small', onclick: () => { verified = false; token = null; draw(); } }, 'Change')));
    else box.replaceChildren(h('div', { class: 'form' }, field('Street', f.street, 'wide'), field('City', f.city), field('State', f.state), field('ZIP', f.zip), h('div', {}, h('button', { type: 'button', onclick: guard(msg, verify) }, 'Verify address'))), msg);
  }
  set(init);
  return { el: box, set, empty, ok: () => verified, get: () => ({ ...read(), ...(token ? { token } : {}) }) };
}
function tradePicker(all, selected, canAdd) {
  const sel = new Set(selected), box = h('div', { class: 'chips' }), list = [...all];
  const draw = () => box.replaceChildren(...list.map((t) => h('button', { type: 'button', class: 'chip' + (sel.has(t.id) ? ' on' : ''), onclick: () => { sel.has(t.id) ? sel.delete(t.id) : sel.add(t.id); draw(); } }, (sel.has(t.id) ? '✓ ' : '+ ') + t.name)),
    canAdd ? h('button', { type: 'button', class: 'chip', onclick: async () => { const n = prompt('Name of the trade to add'); if (!n || !n.trim()) return; try { const r = await api('POST', '/admin/trades', { name: n.trim(), sort: list.length + 1 }); OPTS = null; list.push({ id: r.id, name: n.trim() }); sel.add(r.id); draw(); } catch (e) { alert(e.message); } } }, '+ New trade') : '');
  draw(); return { el: box, get: () => [...sel] };
}
function notesPanel(o, canWrite) {
  const box = h('div'), err = h('div'); const text = h('textarea', { rows: 2, placeholder: 'Add a note. Status changes and edits are logged here automatically.' });
  const draw = (notes) => box.replaceChildren(h('div', { class: 'notes' }, notes.length ? notes.map((n) => h('div', { class: 'note ' + n.kind }, h('div', {}, n.body), h('div', { class: 'meta' }, `${n.kind === 'System' ? 'System' : n.who || 'User'} · ${when(n.at)} ET`))) : h('p', { class: 'muted' }, 'No notes yet.')));
  draw(o.notes || []);
  const add = guard(err, async () => { if (!text.value.trim()) return; await api('POST', `/opportunities/${o.id}/notes`, { body: text.value }); text.value = ''; const fresh = await api('GET', '/opportunities/' + o.id); draw(fresh.notes); });
  return h('div', {}, h('label', {}, 'Notes'), box, canWrite ? h('div', {}, text, h('button', { type: 'button', class: 'small', style: 'margin-top:.3rem', onclick: add }, 'Add note')) : '', err);
}
function filesPanel(o, canWrite, err) {
  const file = h('input', { type: 'file', style: 'display:none', onchange: guard(err, async () => { const f = file.files[0]; if (!f) return; await uploadFile(`/opportunities/${o.id}/files?kind=Submittal`, f); file.value = ''; render(); }) });
  return h('div', {}, h('div', { class: 'row spread' }, h('label', {}, 'Submittal folder (all PDFs and files)'), canWrite ? h('span', {}, file, h('button', { type: 'button', class: 'small', onclick: () => file.click() }, '+ Add file')) : ''),
    o.files.length ? h('table', {}, h('tbody', {}, o.files.map((f) => h('tr', {}, h('td', {}, h('a', { href: '/api/opportunity-files/' + f.id, target: '_blank', rel: 'noopener' }, f.name)), h('td', {}, h('span', { class: 'pill' }, f.kind)), h('td', { class: 'muted' }, when(f.at)), h('td', {}, canWrite && !o.submissions.some((s) => s.fileId === f.id) ? h('button', { class: 'small danger', onclick: guard(err, async () => { if (confirm(`Remove ${f.name}?`)) { await api('DELETE', `/opportunities/${o.id}/files/${f.id}`); render(); } }) }, 'Remove') : ''))))) : h('p', { class: 'muted' }, 'No files yet. The proposal PDF is added when the bid is submitted.'),
    h('div', { style: 'margin-top:.5rem' }, h('label', {}, 'Shared folder'), folderButtons(o, canWrite, 'opportunity', OPTS?.sharepoint !== false)));
}

// ---------------------------------------------------------------- the shared folder: open it in SharePoint or in File Explorer
// A web page cannot open File Explorer by itself. So "Open in File Explorer" gives a small shortcut file that Windows opens in Explorer,
// pointing at the folder where the SharePoint library is synced on this PC (set once, remembered in this browser).
const SYNC_KEY = 'byother.syncRoot';
const syncRoot = () => { try { return localStorage.getItem(SYNC_KEY) || ''; } catch { return ''; } };
const setSyncRoot = (v) => { try { localStorage.setItem(SYNC_KEY, v); } catch { /* private window: asked again next time */ } };
function askSyncRoot() {
  const cur = syncRoot(), v = prompt('Where is the shared library on this PC?\n\nIn File Explorer, find the folder OneDrive made when you pressed Sync in SharePoint (for example C:\\Users\\Benny\\ByOther Projects - Documents) and paste its full path.', cur || '');
  if (v === null) return null; const t = v.trim().replace(/[\\/]+$/, ''); if (!t) return null; setSyncRoot(t); return t;
}
const localPath = (root, spPath) => root + '\\' + String(spPath).split('/').join('\\');
function openInExplorer(name, spPath) {
  const root = syncRoot() || askSyncRoot(); if (!root) return; const path = localPath(root, spPath);
  const url = 'file:///' + path.replace(/\\/g, '/').split('/').map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg))).join('/');
  const blob = new Blob([`[InternetShortcut]\r\nURL=${url}\r\n`], { type: 'application/octet-stream' }), a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = String(name).replace(/[\\/:*?"<>|]/g, ' ').slice(0, 80) + '.url'; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
// kind: 'opportunity' or 'project'. Shows what the record has: a SharePoint folder (open it), or a way to make one.
export function folderButtons(o, w, kind = 'opportunity', sharepointOn = true) {
  const err = h('div'), path = o.spPath;
  const where = path ? h('div', { style: 'margin:.2rem 0 .5rem' }, h('div', { class: 'muted', style: 'font-size:13px;word-break:break-all' }, 'In SharePoint: ' + path.split('/').join(' / ')),
    syncRoot() ? h('div', { class: 'muted', style: 'font-size:13px;word-break:break-all;user-select:all' }, 'On this PC: ' + localPath(syncRoot(), path)) : h('div', { class: 'muted', style: 'font-size:13px' }, 'Press "PC folder…" once to show where it is on this PC.')) : '';
  if (o.folderUrl) return h('div', {}, where, h('div', { class: 'row', style: 'flex-wrap:wrap;gap:.4rem' },
    h('a', { class: 'small', href: o.folderUrl, target: '_blank', rel: 'noopener' }, 'Open in SharePoint'),
    path ? h('button', { type: 'button', class: 'small', onclick: () => openInExplorer(o.name, path), title: 'Opens the folder in File Explorer (needs the library synced to this PC)' }, 'Open in File Explorer') : '',
    path ? h('button', { type: 'button', class: 'small', onclick: (e) => { const root = syncRoot() || askSyncRoot(); if (root) copy(localPath(root, path), e.target); } }, 'Copy path') : '',
    path ? h('button', { type: 'button', class: 'small', onclick: () => askSyncRoot(), title: syncRoot() ? 'Now: ' + syncRoot() : '' }, 'PC folder…') : ''), err);
  if (w && sharepointOn) return h('div', {}, h('button', { type: 'button', class: 'small', onclick: guard(err, async () => { await api('POST', `/${kind === 'project' ? 'projects' : 'opportunities'}/${o.id}/folder`, {}); render(); }) }, 'Create folder in SharePoint'), err);
  return h('span', { class: 'muted' }, sharepointOn ? 'No folder yet' : 'SharePoint is not connected yet');
}

// ---------------------------------------------------------------- the one opportunity form (New and Edit, from any tracker)
async function opportunityForm(o) {
  const op = await opts(), known = await api('GET', '/gcs/known'), isNew = !o, me = state.user;
  const full = o ? await api('GET', '/opportunities/' + o.id) : null; const canAddTrade = ['Super Admin', 'Sub Admin', 'Exec Assistant'].includes(me.role);
  const f = { name: h('input', { value: full?.name ?? '', required: true }), client: h('input', { value: full?.client ?? '', required: true }), gc: h('input', { value: full?.gc ?? '', required: true, list: 'gc-list', autocomplete: 'off' }),
    contact: h('input', { value: full?.contact ?? '' }), email: h('input', { type: 'email', value: full?.email ?? '' }), phone: h('input', { type: 'tel', value: full?.phone ?? '' }),
    source: h('select', { required: true }, h('option', { value: '' }, 'Choose…'), op.sources.map((s) => h('option', { value: s }, s))), link: h('input', { type: 'url', value: full?.link ?? '', placeholder: 'https://app.buildingconnected.com/…' }),
    est: h('select', { required: true }, h('option', { value: '' }, 'Choose…'), op.estimators.map((u) => h('option', { value: u.id }, u.name || u.email))),
    due: h('input', { type: 'date', value: full?.due ?? '', required: isNew || !!full?.due }), time: h('input', { type: 'time', value: full?.dueTime ?? '' }), start: h('input', { type: 'date', value: full?.plannedStart ?? '' }),
    mall: h('input', { type: 'checkbox', checked: full?.mall ? true : null }), note: h('textarea', { rows: 2, placeholder: 'Anything worth remembering' }) };
  f.source.value = full?.sourceType ?? ''; f.est.value = full?.estimatorId ?? (isNew && op.estimators.some((u) => u.id === me.id) ? me.id : '');
  let type = full?.type ?? ''; const typeBox = h('div', { class: 'seg' }); const drawType = () => typeBox.replaceChildren(...op.projectTypes.map((t) => h('button', { type: 'button', class: t === type ? 'on' : '', onclick: () => { type = t; drawType(); } }, t === 'Office / Medical / Other' ? 'Medical / Office' : t))); drawType();
  const gcb = addressBlock({ kind: 'gc', init: full?.gcAddr, optional: true }), proj = addressBlock({ kind: 'project', init: full ? { street: full.address, city: full.city, state: 'FL', zip: full.zip, verified: full.addrVerified } : null });
  const picker = tradePicker(op.trades, (full?.consideredTrades || []).map((t) => t.tradeId), canAddTrade); const linkLabel = h('label', {}, 'Invitation link');
  const sync = () => { linkLabel.replaceChildren('Invitation link', f.source.value === 'Building Connected' ? star() : ''); f.link.required = f.source.value === 'Building Connected'; }; f.source.onchange = sync; sync();
  const hint = h('div', { class: 'muted wide', style: 'font-size:13px' });
  f.gc.onchange = () => { const g = known.find((x) => x.name.toLowerCase() === f.gc.value.trim().toLowerCase()); if (!g) { hint.textContent = f.gc.value.trim() ? 'A new GC. It joins the list when you save.' : ''; return; } hint.textContent = 'A GC we already work with. Its details were filled in.';
    f.gc.value = g.name; if (gcb.empty() && g.addr) gcb.set(g.addr); if (!f.contact.value) f.contact.value = g.contact; if (!f.email.value) f.email.value = g.email; if (!f.phone.value) f.phone.value = g.phone; };
  const fields = [summaryOrBlank(full), h('datalist', { id: 'gc-list' }, known.map((g) => h('option', { value: g.name }))),
    field(lbl('Project name', true), f.name), field(lbl('Client name', true), f.client), field(lbl('GC name', true), f.gc), hint,
    h('div', { class: 'wide' }, h('label', {}, 'GC address (optional)'), gcb.el),
    h('div', { class: 'wide' }, h('label', {}, 'GC estimating contact')), field('Name', f.contact), field('Email', f.email), field('Phone', f.phone),
    h('div', { class: 'wide' }, h('label', {}, lbl('Project address (Florida)', true)), proj.el),
    field(lbl('Source', true), f.source), h('div', {}, linkLabel, f.link), field(lbl('Estimator', true), f.est),
    field(lbl('Bid due date', true), f.due), field('Bid due time (Eastern)', f.time), field('Planned project start (for follow-up timing)', f.start),
    h('div', { class: 'wide' }, h('label', {}, lbl('Project type', true)), typeBox, h('label', { style: 'text-transform:none;letter-spacing:0;font-size:15px;font-weight:400;margin-top:.5rem;display:block' }, f.mall, ' In a shopping center / mall')),
    h('div', { class: 'wide' }, h('label', {}, 'Trades being considered'), picker.el),
    isNew ? '' : h('div', { class: 'wide' }, h('label', {}, 'Shared folder'), folderButtons(full, canEstimate(), 'opportunity', op.sharepoint)),
    isNew ? h('div', { class: 'wide' }, h('label', {}, 'Note'), f.note, h('div', { class: 'muted', style: 'font-size:13px' }, 'A note with your name and the date and time is added automatically.')) : h('div', { class: 'wide' }, notesPanel(full, canEstimate()))];
  formModal(isNew ? 'New opportunity' : `Edit · ${full.name}`, fields.filter(Boolean), async () => {
    if (!type) throw new Error('Choose the project type.');
    if (!proj.ok()) throw new Error('Verify the project address first. Press Verify address until it shows the green check.');
    if (!gcb.empty() && !gcb.ok()) throw new Error('Verify the GC address, or clear its fields.');
    const body = { name: f.name.value, client: f.client.value, gc: f.gc.value, addr: proj.get(), gcAddr: gcb.empty() ? { street: '', city: '', state: '', zip: '' } : gcb.get(), contact: f.contact.value, email: f.email.value, phone: f.phone.value, sourceType: f.source.value, link: f.link.value, estimatorId: f.est.value || null, due: f.due.value || null, dueTime: f.time.value || null, plannedStart: f.start.value || null, type, mall: f.mall.checked, tradeIds: picker.get() };
    if (isNew) body.note = f.note.value; else delete body.note;
    await api(isNew ? 'POST' : 'PUT', '/opportunities' + (isNew ? '' : '/' + o.id), body); render();
  }, isNew ? 'Add opportunity' : 'Save changes');
}
const summaryOrBlank = (o) => (o ? summary(o) : null);

// ---------------------------------------------------------------- moving between statuses (same look for every move)
async function statusModal(o, to) {
  const op = await opts(); const reasons = { Declined: op.declineReasons, 'Decided Not To Submit': op.dntsReasons, 'Not Awarded': op.notAwardedReasons }[to];
  if (to === 'Submitted' && ['Accepted', 'Started'].includes(o.status)) return submitModal(o);
  const f = { reason: h('select', { required: true }, h('option', { value: '' }, 'Choose a reason…'), (reasons || []).map((r) => h('option', { value: r }, r))), est: h('select', {}, op.estimators.map((u) => h('option', { value: u.id }, u.name || u.email))), due: h('input', { type: 'date' }), note: h('textarea', { rows: 2, placeholder: 'Optional' }) };
  f.est.value = o.estimatorId || (op.estimators.some((u) => u.id === state.user.id) ? state.user.id : op.estimators[0]?.id);
  const WHAT = { Reviewing: 'It moves to the Proposal Tracker as Reviewing. No proposal number or folders are created yet.', Accepted: 'It gets the next proposal number, an estimator, and moves to the Proposal Tracker.', Started: 'Work on the estimate and proposal has started.', New: 'It goes back to Bid Opportunities.',
    Declined: 'It leaves Bid Opportunities and stays searchable.', Submitted: 'The result is cleared and follow-up resumes.', 'Decided Not To Submit': 'It leaves the Proposal and Submittal trackers and stays searchable.', Awarded: 'This creates the project in Job Costing with the lead, proposal and submittal details attached.', 'Not Awarded': 'The bid is recorded as not awarded and follow-up stops.',
    'No Communication': 'The GC never answered. Follow-up closes; the proposal and history are kept.' };
  const reopen = o.status === 'Submitted' && to === 'Started';
  const fields = [summary(o), h('p', { class: 'muted wide' }, reopen ? 'Reopen for revision: the next proposal PDF becomes a new bid version. Earlier versions are kept.' : WHAT[to] || ''),
    to === 'Accepted' ? field(lbl('Estimator', true), f.est) : '', to === 'Accepted' && !o.due ? field(lbl('Bid due date', true), f.due) : '', reasons ? field(lbl('Reason', true), f.reason, 'wide') : '', field('Note', f.note, 'wide')].filter(Boolean);
  formModal(`${reopen ? 'Reopen for revision' : sname(to)} · ${o.name}`, fields, async () => {
    const body = { status: to, note: f.note.value }; if (reasons) body.reason = f.reason.value; if (to === 'Accepted') { body.estimatorId = f.est.value; if (!o.due) body.due = f.due.value; }
    const r = await api('POST', `/opportunities/${o.id}/status`, body);
    if (r.projectId) { location.hash = '#/projects/' + r.projectId; return; }
    if (r.proposalId) { setTimeout(() => acceptedModal(o, r), 0); location.hash = '#/estimating/proposals'; }
    render();
  }, to === 'Awarded' ? 'Award and create project' : reopen ? 'Reopen' : 'Confirm');
}
function acceptedModal(o, r) {
  const msg = h('div');
  modal(`Accepted · ${r.proposalId}`, h('div', {}, h('p', {}, 'This is the standard folder tree for the proposal:'), h('pre', { class: 'draft' }, r.folderPlan.root + '\n' + r.folderPlan.folders.map((x) => '  ' + x).join('\n')),
    C.hasFolderAccess() ? h('button', { type: 'button', onclick: guard(msg, async () => { const where = await C.createProposalFolders(r.folderPlan); notice(msg, `Created in ${where}`, 'ok'); }) }, 'Create these folders on my computer…') : '', C.folderNote(), msg, h('p', { class: 'muted' }, 'Paste the OneDrive folder link on the opportunity (Edit) so it is one click away.')));
}

// ---------------------------------------------------------------- submitting: the proposal PDF is required, read, and checked by a person
async function submitModal(o) {
  const op = await opts(); let fileId = null, rows = (o.tradePrices || []).map((p) => ({ tradeId: p.tradeId, amount: p.amount, hint: '' }));
  const file = h('input', { type: 'file', accept: 'application/pdf,.pdf' }), info = h('div'), table = h('div'), total = h('strong');
  const f = { date: h('input', { type: 'date', value: todayStr(), max: todayStr() }), method: h('select', {}, op.methods.map((m) => h('option', { value: m }, m))), start: h('input', { type: 'date', value: o.plannedStart ?? '' }), note: h('textarea', { rows: 2, placeholder: 'Optional' }) };
  const sum = () => rows.reduce((n, r) => n + (Number(r.amount) || 0), 0);
  function redraw() {
    table.replaceChildren(h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Trade'), h('th', { class: 'n' }, 'Amount'), h('th', {}, ''))),
      h('tbody', {}, rows.map((r, i) => { const sel = h('select', { onchange: (e) => (r.tradeId = e.target.value) }, h('option', { value: '' }, 'Choose a trade…'), op.trades.map((t) => h('option', { value: t.id }, t.name))); sel.value = r.tradeId || '';
        return h('tr', {}, h('td', {}, sel, r.hint && !r.tradeId ? sub('From the PDF: ' + r.hint) : ''), h('td', { class: 'n' }, num(r.amount, { oninput: (e) => { r.amount = e.target.value; total.textContent = usd(sum()); } })), h('td', {}, h('button', { type: 'button', class: 'small danger', onclick: () => { rows.splice(i, 1); redraw(); } }, '×'))); }))),
      h('button', { type: 'button', class: 'small', style: 'margin-top:.4rem', onclick: () => { rows.push({ tradeId: '', amount: '', hint: '' }); redraw(); } }, '+ Add trade')); total.textContent = usd(sum());
  }
  file.onchange = guard(info, async () => {
    const pdf = file.files[0]; if (!pdf) return; fileId = null; notice(info, 'Uploading and reading the proposal…', 'ok');
    const r = await uploadFile(`/opportunities/${o.id}/files?kind=Proposal`, pdf); fileId = r.fileId;
    const copied = r.sharepoint ? ' It was also copied to the 02. Proposal folder in SharePoint.' : '';
    if (r.parsed) { rows = r.parsed.trades.map((t) => ({ tradeId: t.tradeId || '', amount: t.amount, hint: t.trade })); notice(info, `Read ${rows.length} trade${rows.length === 1 ? '' : 's'} from the PDF. Check every amount before saving.${copied}`, 'ok'); r.parsed.warnings.forEach((w) => info.append(h('div', { class: 'err' }, w))); }
    else { notice(info, r.aiError ? r.aiError : 'The PDF is saved. Enter the trades and amounts below.', r.aiError ? 'err' : 'ok'); }
    redraw();
  });
  redraw();
  formModal(`Submit proposal · ${o.name}`, [summary(o), h('div', { class: 'wide' }, h('label', {}, lbl('Proposal PDF', true)), file, info), h('div', { class: 'wide' }, h('label', {}, lbl('Trades and amounts', true)), table, h('div', { class: 'row', style: 'justify-content:space-between;margin-top:.4rem' }, h('span', { class: 'muted' }, 'Proposal total'), total)),
    field(lbl('Date submitted', true), f.date), field(lbl('How it was sent', true), f.method), field('Known project start (optional)', f.start), field('Note', f.note, 'wide')],
  async () => {
    if (!fileId) throw new Error('Upload the proposal PDF first.');
    if (rows.some((r) => !r.tradeId || !(Number(r.amount) > 0))) throw new Error('Every row needs a trade and an amount.');
    await api('POST', `/opportunities/${o.id}/submissions`, { fileId, date: f.date.value, method: f.method.value, plannedStart: f.start.value || null, noteText: f.note.value, prices: rows.map((r) => ({ tradeId: r.tradeId, amount: r.amount })) });
    location.hash = '#/estimating/submittals'; render();
  }, 'Record submission');
}

// A status control used in every table: it lists only the moves that are allowed from here and opens the matching form.
function statusSelect(o, w) {
  const moves = o.next.filter((s) => !(s === 'Submitted' && !['Accepted', 'Started'].includes(o.status))), choices = [o.status, ...moves];
  const label = (s) => (s === 'Awarded' ? 'Awarded — Create Project in JC' : s === 'Started' && o.status === 'Submitted' ? 'Reopen for revision' : s === 'New' && o.status === 'Declined' ? 'Reopen as New' : sname(s));
  const sel = h('select', { 'aria-label': 'Status', disabled: !w || !moves.length ? true : null, onchange: (e) => { const v = e.target.value; sel.value = o.status; if (v !== o.status) statusModal(o, v).catch((er) => alert(er.message)); } }, choices.map((s) => h('option', { value: s }, label(s))));
  sel.value = o.status; return sel;
}

// ---------------------------------------------------------------- the page
const TABS = [['bids', 'Bid Opportunities'], ['proposals', 'Proposal Tracker'], ['submittals', 'Submittal Tracker'], ['followups', 'Follow Ups'], ['insights', 'Insights']];
export async function estimatingView(arg, arg2) {
  const tab = TABS.some(([t]) => t === arg) ? arg : 'bids', detailId = arg && !TABS.some(([t]) => t === arg) ? arg : null, err = h('div'), w = canEstimate();
  const search = state.estSearch || '';
  const sbox = h('input', { placeholder: 'Find a project, GC, or proposal #', value: search, onchange: (e) => { state.estSearch = e.target.value; render(); } });
  const q = `q=${encodeURIComponent(search)}`;
  const data = tab === 'bids' ? await api('GET', `/opportunities?tab=bids&${q}${state.estAll ? '&all=1' : ''}`)
    : tab === 'proposals' ? await api('GET', `/opportunities?tab=proposals&${q}&filter=${encodeURIComponent(state.propFilter || 'Active')}`)
    : tab === 'submittals' ? await api('GET', `/opportunities?tab=submittals&${q}`) : null;
  const st = data?.stats || (await api('GET', '/opportunities?tab=proposals')).stats;
  const kpi = (l, v, tone = '') => h('div', { class: 'kpi ' + tone }, h('div', { class: 'l' }, l), h('div', { class: 'v' }, v));
  const head = h('div', { class: 'grid kpis', style: 'grid-template-columns:repeat(auto-fit,minmax(140px,1fr))' }, kpi('New opportunities', st.openLeads), kpi('Reviewing', st.reviewing), kpi('Accepted this month', st.accepted), kpi('Working now', st.working), kpi('Submitted this month', st.submitted), kpi('Follow-ups due', st.awaitingFollowUp, st.awaitingFollowUp ? 'warn' : ''), kpi('Awaiting award', st.interested, st.interested ? 'good' : ''));
  const tabs = h('div', { class: 'tabs', style: 'margin-top:1rem' }, TABS.map(([t, l]) => h('a', { class: t === tab ? 'on' : '', href: '#/estimating/' + t }, l)));
  let body;
  if (tab === 'bids') body = bidsPanel(data, err, w, await api('GET', '/bids/status'));
  else if (tab === 'proposals') body = proposalsPanel(data, err, w);
  else if (tab === 'submittals') body = submittalsPanel(data, err, w);
  else if (tab === 'followups') body = await followUpsPanel(err, w, arg === 'followups' ? arg2 : null);
  else body = await insightsTab(err);
  const detail = detailId ? await opportunityDetail(detailId, err, w) : '';
  return C.shell('estimating', [h('div', { class: 'row spread' }, h('h1', {}, 'Estimating'), h('div', { class: 'row' }, sbox, w && h('button', { onclick: importForm }, 'Import leads'), w && h('button', { class: 'primary', onclick: () => opportunityForm(null).catch((e) => alert(e.message)) }, '+ Opportunity'))),
    h('p', { class: 'sub' }, 'Florida bid invitations to proposals to awarded projects. Reviewing and Accepted work moves to the Proposal Tracker; an award builds the project in Job Costing.'), head, tabs, err, detail, body]);
}
async function importForm() {
  const conn = (await api('GET', '/estimating/connection')).buildingConnected; const csv = h('textarea', { rows: 8, placeholder: 'Paste the CSV here, or choose a file below. First row = headings (Project, GC / Company, City, State, Bid Due, …).' }), file = h('input', { type: 'file', accept: '.csv,text/csv' });
  file.onchange = async () => { if (file.files[0]) csv.value = await file.files[0].text(); };
  formModal('Import bid invitations', [h('p', { class: conn.connected ? 'ok wide' : 'muted wide' }, conn.note), field('CSV', csv, 'wide'), field('File', file, 'wide')],
    async () => { const r = await api('POST', '/opportunities/import', { csv: csv.value, source: 'BuildingConnected' }); if (r.added) render(); throw new Error(`Added ${r.added}, already had ${r.duplicates}, skipped ${r.skipped.length}.${r.skipped.length ? ' ' + r.skipped.slice(0, 4).join(' | ') : ''}`); }, 'Import');
}

// ---------------------------------------------------------------- Bid Opportunities
const BID_RULES = (r) => `One list of NEW opportunities, ordered by week, then closeness to Orlando, then shopping centers, then Retail, Restaurant, and Medical / Office. Weeks run Monday–Sunday: a bid due ON a Monday goes in the prior week. Undated leads stay visible. A New lead is declined ${r.declineNewDays} days after its bid due date, and the system notes it; leads with no date never expire. Search includes everything seen in the last 30 days, declined too; older ones must be added by hand. Reviewing and Accepted opportunities move to the Proposal Tracker.`;
function bidFeedBar(feed, err, w) {
  const bar = h('div', { class: 'card', style: 'padding:.7rem 1rem' }); const refresh = guard(err, async () => { await api('POST', '/bids/refresh', {}); render(); });
  if (!feed.connected) { bar.append(h('div', { class: 'row spread' }, h('span', {}, feed.googleSetUp ? 'Bid invitations are read from your BuildingConnected emails. The owner connects Gmail once in Admin.' : 'Bid invitations will be read from your BuildingConnected emails once Gmail is connected (see Admin).'), C.isSuper() ? h('a', { href: '#/admin' }, 'Open Admin') : '')); return bar; }
  const l = feed.last, ok = feed.lastGood;
  bar.append(h('div', { class: 'row spread' }, h('div', {}, feed.running ? h('strong', {}, 'Refreshing from Gmail…') : l?.status === 'Error' ? h('span', { class: 'neg' }, `Last refresh failed: ${l.error}`) : ok ? h('span', {}, 'Last refreshed ', h('strong', {}, when(ok.finished_at)), ` · ${ok.added} new, ${ok.updated} updated${ok.declined ? `, ${ok.declined} declined` : ''}${ok.skipped ? `, ${ok.skipped} outside Florida skipped` : ''}`) : 'Not refreshed yet.', h('span', { class: 'muted', style: 'margin-left:.6rem;font-size:13px' }, `Automatic at 8:00 AM and 1:00 PM · ${feed.email}`)), w ? h('button', { class: 'primary', disabled: feed.running ? true : null, onclick: refresh }, feed.running ? 'Refreshing…' : 'Refresh now') : ''));
  if (feed.running) setTimeout(() => { if (location.hash.startsWith('#/estimating')) render(); }, 2500);
  return bar;
}
const weekLabel = (n) => (n.startsWith('Week Of ') ? fmtDay(n.slice(8)) : n === 'Due This Week — Too Tight To Bid' ? 'This week — too tight to bid' : n === 'Missed / Past Due' ? 'Missed / past due' : n === 'No Bid Due Date Provided' ? 'No bid due date provided' : n);
const BID_COLS = [['week', 'Week Of'], ['project', 'Project / Location'], ['gc', 'General Contractors / Contact'], ['due', 'Bid Due'], ['status', 'Status'], ['invitation', 'Invitation'], ['onedrive', 'OneDrive Link']];
function inviteCell(o) {
  const inv = (o.invitations || []).filter((i) => i.link), list = inv.length ? inv : o.link ? [{ gc: o.gc, link: o.link }] : [];
  return h('td', { style: 'white-space:nowrap' }, list.length ? list.map((i) => h('div', {}, h('a', { href: i.link, target: '_blank', rel: 'noopener', title: `Open the ${i.gc} invitation on BuildingConnected` }, list.length > 1 ? `View · ${i.gc.split(/[ ,]/)[0]}` : 'View Invitation'))) : '—', o.emailLink ? h('div', {}, h('a', { href: o.emailLink, target: '_blank', rel: 'noopener', class: 'muted', style: 'font-size:13px' }, 'Email')) : '');
}
const contactBlock = (o) => { const nda = (o.invitations || []).some((i) => i.nda) && !o.email;
  return [h('strong', {}, o.gc), o.additionalGcs ? sub('Also: ' + o.additionalGcs) : '', o.contact ? sub(o.contact) : '', o.email ? h('div', {}, h('a', { href: 'mailto:' + o.email, style: 'font-size:13px' }, o.email)) : '', o.phone ? sub(o.phone) : '', nda ? h('div', { class: 'neg', style: 'font-size:13px' }, 'Contact is locked behind an NDA') : (!o.contact && !o.email && !o.phone ? sub('No contact on file') : '')]; };
const dueCell = (o) => h('td', {}, o.due ? [fmtDay(o.due), o.dueTime ? sub(`${o.dueTime} Eastern`) : sub(o.countdown)] : [h('strong', { class: 'neg', style: 'font-size:13px' }, 'NO BID DUE DATE PROVIDED'), (o.invitations || []).some((i) => i.nda) ? sub('May be locked behind an NDA') : '']);
function bidsPanel(data, err, w, feed) {
  const rows = data.groups.flatMap((g) => g.rows.map((o) => ({ ...o, week: g.name }))); rows.forEach((o, i) => (o.rank = i));
  const sort = state.bidSort || { key: 'week', dir: 1 };
  const keyOf = { week: (o) => o.rank, project: (o) => o.name.toLowerCase(), gc: (o) => o.gc.toLowerCase(), due: (o) => o.due || '9999', status: (o) => o.status, invitation: (o) => (o.link || (o.invitations || []).some((i) => i.link) ? 0 : 1), onedrive: (o) => (o.folderUrl ? 0 : 1) }[sort.key];
  rows.sort((a, b) => { const x = keyOf(a), y = keyOf(b); return (x < y ? -1 : x > y ? 1 : a.rank - b.rank) * sort.dir; });
  const head = BID_COLS.map(([k, l]) => h('th', {}, h('button', { class: 'sortbtn', onclick: () => { state.bidSort = { key: k, dir: sort.key === k ? -sort.dir : 1 }; render(); } }, l, h('span', { class: sort.key === k ? 'on' : '' }, sort.key === k ? (sort.dir === 1 ? ' ↑' : ' ↓') : ' ↕'))));
  const tip = BID_RULES(data.rules || { declineNewDays: 2 });
  return h('div', {}, bidFeedBar(feed, err, w),
    h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', {}, 'Bid Opportunities'), h('div', { class: 'row' }, h('label', { style: 'text-transform:none;letter-spacing:0;font-size:14px;font-weight:400;margin:0' }, h('input', { type: 'checkbox', checked: state.estAll ? true : null, onchange: (e) => { state.estAll = e.target.checked; render(); } }), ' Include declined (last 30 days)'), h('span', { class: 'info-tip', tabindex: '0', 'aria-label': tip, 'data-tip': tip }, 'i'))),
      rows.length ? h('div', { class: 'scroll' }, h('table', { class: 'biglist' }, h('thead', {}, h('tr', {}, ...head, h('th', {}, 'Actions'))),
        h('tbody', {}, rows.map((o) => h('tr', { class: o.status === 'Declined' ? 'muted' : '' },
          h('td', {}, h('div', {}, weekLabel(o.week)), sub(`Tier ${o.tier}`)),
          h('td', { style: 'white-space:normal;min-width:240px' }, h('strong', {}, o.name), o.client && o.client !== o.gc ? sub('Client: ' + o.client) : '', sub([addrLine(o), o.mall ? 'Shopping center' : '', o.type, o.sourceType].filter(Boolean).join(' · '))),
          h('td', { style: 'white-space:normal;min-width:200px' }, contactBlock(o)), dueCell(o),
          h('td', {}, statusSelect(o, w), o.autoDeclined ? sub('Auto-declined') : o.declinedReason ? sub(o.declinedReason) : ''),
          inviteCell(o), h('td', {}, o.folderUrl ? h('a', { href: o.folderUrl, target: '_blank', rel: 'noopener' }, 'Open folder') : h('span', { class: 'muted' }, '—')),
          h('td', {}, h('div', { class: 'stack' }, h('button', { class: 'small', onclick: () => (location.hash = '#/estimating/' + o.id) }, 'Open'), w ? h('button', { class: 'small', onclick: () => opportunityForm(o).catch((e) => alert(e.message)) }, 'Edit') : ''))))))) : h('p', { class: 'muted', style: 'padding:1rem 0' }, feed.connected ? 'No new opportunities. They appear after the next refresh (8:00 AM and 1:00 PM), or press Refresh now.' : 'No opportunities yet. Connect Gmail in Admin, or add one with + Opportunity.')));
}

// ---------------------------------------------------------------- Proposal Tracker
const tradeList = (o) => (o.tradePrices.length ? h('div', {}, o.tradePrices.map((p) => h('div', { style: 'font-size:13px;white-space:nowrap' }, `${p.name} ${usd(p.amount)}`)), h('strong', { style: 'font-size:13px' }, usd(o.total))) : o.consideredTrades.length ? sub('Considering: ' + o.consideredTrades.map((t) => t.name).join(', ')) : sub('—'));
function filterChips(list, current, counts, onPick) { return h('div', { class: 'filters' }, list.map((k) => h('button', { type: 'button', class: 'chip' + (k === current ? ' on' : ''), onclick: () => onPick(k) }, `${k === 'Decided Not To Submit' ? 'Decided Not To Submit' : k}${counts?.[k] != null ? ' ' + counts[k] : ''}`))); }
function folderModal(o) {
  const msg = h('div'); const fp = o.folderPlan;
  modal('Folder for this proposal', h('div', {}, o.folderUrl || OPTS?.sharepoint ? h('div', { style: 'margin-bottom:.8rem' }, folderButtons(o, canEstimate(), 'opportunity', OPTS?.sharepoint !== false)) : '', h('p', {}, 'The standard folder tree for the proposal:'), h('pre', { class: 'draft' }, fp.root + '\n' + fp.folders.map((x) => '  ' + x).join('\n')), C.hasFolderAccess() ? h('button', { type: 'button', onclick: guard(msg, async () => { const where = await C.createProposalFolders(fp); notice(msg, `Created in ${where}`, 'ok'); }) }, 'Create these folders on my computer…') : '', C.folderNote(), msg));
}
function proposalsPanel(data, err, w) {
  const open = (o) => (location.hash = '#/estimating/' + o.id);
  const filters = ['Active', 'Reviewing', 'Accepted', 'Started', 'Submitted', 'Decided Not To Submit', 'All'];
  return h('div', { class: 'card' }, h('h2', {}, 'Proposal Tracker'), filterChips(filters, data.filter, data.counts, (k) => { state.propFilter = k; render(); }),
    data.rows.length ? h('div', { class: 'scroll' }, h('table', { class: 'biglist' }, h('thead', {}, h('tr', {}, ['Proposal / Project', 'General Contractors', 'Estimator / Scope', 'Due', 'Status', 'Proposed Price By Trade', 'Invitation', 'Files', 'Actions'].map((t) => h('th', {}, t)))),
      h('tbody', {}, data.rows.map((o) => h('tr', {},
        h('td', { style: 'white-space:normal;min-width:220px' }, o.proposalId ? h('strong', {}, o.proposalId) : pill('Reviewing'), h('div', { class: 'edit', onclick: () => open(o) }, o.name), sub(addrLine(o))),
        h('td', { style: 'white-space:normal;min-width:180px' }, contactBlock(o)), h('td', { style: 'white-space:normal' }, o.estimator || '—', o.consideredTrades.length ? sub(o.consideredTrades.map((t) => t.name).join(', ')) : ''),
        h('td', {}, fmtDay(o.due), sub(o.countdown)), h('td', {}, statusSelect(o, w)), h('td', {}, tradeList(o)),
        inviteCell(o), h('td', {}, o.files.length ? h('a', { href: '#/estimating/' + o.id }, `${o.files.length} file${o.files.length === 1 ? '' : 's'}`) : '—', o.folderUrl ? h('div', {}, h('a', { href: o.folderUrl, target: '_blank', rel: 'noopener' }, 'SharePoint')) : ''),
        h('td', {}, h('div', { class: 'stack' }, w && ['Accepted', 'Started'].includes(o.status) ? h('button', { class: 'small primary', onclick: () => submitModal(o) }, 'Submit') : '', w ? h('button', { class: 'small', onclick: () => opportunityForm(o).catch((e) => alert(e.message)) }, 'Edit') : '', o.acceptedDate ? h('button', { class: 'small', onclick: async () => folderModal(await api('GET', '/opportunities/' + o.id)) }, 'Folder') : ''))))))) : h('p', { class: 'muted', style: 'padding:1rem 0' }, 'Nothing here yet. Mark a New opportunity Reviewing or Accepted from Bid Opportunities.'));
}

// ---------------------------------------------------------------- Submittal Tracker (list and calendar)
function submittalsPanel(data, err, w) {
  const view = state.subView || 'list', filter = state.subFilter || 'All';
  const FIL = { All: () => true, 'Not Submitted': (o) => ['Accepted', 'Started'].includes(o.status), Submitted: (o) => o.status === 'Submitted', Awarded: (o) => o.status === 'Awarded', 'Not Awarded': (o) => o.status === 'Not Awarded', 'No Communication': (o) => o.status === 'No Communication' };
  const rows = data.rows.filter(FIL[filter]), counts = Object.fromEntries(Object.entries(FIL).map(([k, f]) => [k, data.rows.filter(f).length]));
  const toggle = h('div', { class: 'seg' }, ['list', 'calendar'].map((v) => h('button', { type: 'button', class: v === view ? 'on' : '', onclick: () => { state.subView = v; render(); } }, v === 'list' ? 'List' : 'Calendar')));
  return h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', {}, 'Submittal Tracker'), toggle), filterChips(Object.keys(FIL), filter, counts, (k) => { state.subFilter = k; render(); }), view === 'calendar' ? calendar(rows) : submittalList(rows, w));
}
function submittalList(rows, w) {
  if (!rows.length) return h('p', { class: 'muted', style: 'padding:1rem 0' }, 'Nothing here. Accepted and Started work appears here until it is submitted.');
  return h('div', { class: 'scroll' }, h('table', { class: 'biglist' }, h('thead', {}, h('tr', {}, ['Proposal / Project', 'General Contractors', 'Due', 'Submitted', 'Price By Trade', 'Status', 'Proposal PDFs', 'Actions'].map((t) => h('th', {}, t)))),
    h('tbody', {}, rows.map((o) => { const s = o.lastSubmission; return h('tr', {}, h('td', { style: 'white-space:normal;min-width:200px' }, h('strong', {}, o.proposalId || ''), h('div', { class: 'edit', onclick: () => (location.hash = '#/estimating/' + o.id) }, o.name), sub(addrLine(o))),
      h('td', { style: 'white-space:normal' }, o.gc, o.contact ? sub(o.contact) : ''), h('td', {}, fmtDay(o.due)), h('td', {}, s ? [fmtDay(s.date), sub(`Version ${s.version} · ${s.method}`)] : h('span', { class: 'muted' }, 'Not yet')), h('td', {}, tradeList(o)), h('td', {}, statusSelect(o, w)),
      h('td', {}, o.files.filter((f) => f.kind !== 'Other').length ? o.files.filter((f) => f.kind !== 'Other').map((f) => h('div', {}, h('a', { href: '/api/opportunity-files/' + f.id, target: '_blank', rel: 'noopener', style: 'font-size:13px' }, f.name))) : h('span', { class: 'muted' }, 'No PDFs yet')),
      h('td', {}, h('div', { class: 'stack' }, w && ['Accepted', 'Started'].includes(o.status) ? h('button', { class: 'small primary', onclick: () => submitModal(o) }, 'Submit') : '', s ? h('button', { class: 'small', onclick: () => (location.hash = '#/estimating/followups/' + o.id) }, 'Follow up') : '', h('button', { class: 'small', onclick: () => (location.hash = '#/estimating/' + o.id) }, 'Open'))));
    }))));
}
function calendar(rows) {
  const month = state.subMonth || todayStr().slice(0, 7), [y, m] = month.split('-').map(Number), first = new Date(y, m - 1, 1), days = new Date(y, m, 0).getDate(), pad = (first.getDay() + 6) % 7, today = todayStr();
  const nav = (d) => { const x = new Date(y, m - 1 + d, 1); state.subMonth = `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`; render(); };
  const by = {}; for (const o of rows) if (o.calendarDate) (by[o.calendarDate] ||= []).push(o);
  const cells = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => h('div', { class: 'dow' }, d));
  for (let i = 0; i < pad; i++) cells.push(h('div', { class: 'day off' }));
  for (let d = 1; d <= days; d++) { const key = `${month}-${String(d).padStart(2, '0')}`; cells.push(h('div', { class: 'day' + (key === today ? ' today' : '') }, h('div', { class: 'muted' }, d), (by[key] || []).map((o) => h('button', { type: 'button', class: 'ev ' + (o.lastSubmission ? 'sub' : 'due'), title: o.lastSubmission ? `Submitted ${o.lastSubmission.date}; original due ${o.due || 'unknown'}` : 'Bid due', onclick: () => (location.hash = '#/estimating/' + o.id) }, h('strong', {}, o.lastSubmission ? `Submitted V${o.lastSubmission.version}` : 'Due'), h('div', {}, o.name), o.lastSubmission && o.due ? h('div', { class: 'muted' }, 'Due ' + fmtDay(o.due)) : '')))); }
  return h('div', {}, h('div', { class: 'row spread', style: 'margin-bottom:.6rem' }, h('button', { class: 'small', onclick: () => nav(-1) }, '← Previous'), h('strong', {}, first.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })), h('button', { class: 'small', onclick: () => nav(1) }, 'Next →')), h('div', { class: 'cal' }, cells),
    h('p', { class: 'muted', style: 'font-size:13px' }, 'Submitted bids sit on the day they were actually sent, with the original due date shown. Bids not yet sent sit on their due date.'));
}

// ---------------------------------------------------------------- one opportunity, everything gathered
async function opportunityDetail(id, err, w) {
  const o = await api('GET', '/opportunities/' + id), op = await opts();
  const row = (l, v) => h('div', {}, h('label', {}, l), h('div', {}, v || '—'));
  const gcA = o.gcAddr?.street ? [o.gcAddr.street, o.gcAddr.city, [o.gcAddr.state, o.gcAddr.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ') : '';
  return h('div', { class: 'card', style: 'border-color:var(--navy)' }, h('div', { class: 'row spread' }, h('h2', {}, `${o.proposalId ? o.proposalId + ' · ' : ''}${o.name}`), h('a', { href: '#/estimating/' + (['New', 'Declined'].includes(o.status) ? 'bids' : o.lastSubmission ? 'submittals' : 'proposals') }, 'Close')),
    h('div', { class: 'row', style: 'margin:.3rem 0 .8rem' }, statusSelect(o, w), w ? h('button', { class: 'small', onclick: () => opportunityForm(o).catch((e) => alert(e.message)) }, 'Edit') : '', o.lastSubmission ? h('a', { href: '#/estimating/followups/' + o.id }, 'Open follow-up') : '', o.projectId ? h('a', { href: '#/projects/' + o.projectId }, 'Open the project') : ''),
    h('div', { class: 'form' }, row('Client', o.client), row('GC', o.gc + (o.additionalGcs ? ' (also ' + o.additionalGcs + ')' : '')), row('GC address', gcA && h('span', {}, gcA, o.gcAddr.verified ? ' ✓' : '')), row('GC contact', [o.contact, o.email, o.phone].filter(Boolean).join(' · ')),
      row('Project address', addrLine(o) && h('span', {}, addrLine(o), o.addrVerified ? ' ✓' : '')), row('Source', o.sourceType), row('Invitation', o.link && h('a', { href: o.link, target: '_blank', rel: 'noopener' }, 'Open invitation')), row('Estimator', o.estimator),
      row('Bid due', o.due ? fmtDay(o.due) + (o.dueTime ? ' ' + o.dueTime + ' ET' : '') : 'No bid due date'), row('Project type', o.type + (o.mall ? ' · shopping center' : '')), row('Planned start', o.plannedStart ? fmtDay(o.plannedStart) : ''), row('Trades considered', o.consideredTrades.map((t) => t.name).join(', '))),
    o.tradePrices.length ? h('p', {}, h('strong', {}, 'Proposed: '), o.tradePrices.map((p) => `${p.name} ${usd(p.amount)}`).join(' · '), ` = ${usd(o.total)}`) : '',
    o.submissions.length ? h('div', {}, h('label', {}, 'Bid versions'), h('table', {}, h('tbody', {}, o.submissions.map((s) => h('tr', {}, h('td', {}, 'v' + s.version), h('td', {}, fmtDay(s.date)), h('td', {}, s.method), h('td', { class: 'n' }, usd(s.price)), h('td', {}, (s.trades || []).map((t) => t.name).join(', ')), h('td', {}, w && o.status === 'Submitted' ? h('button', { class: 'small danger', onclick: guard(err, async () => { const why = prompt('Why remove this submission? (the PDF stays in the folder)'); if (why) { await api('POST', `/opportunities/${o.id}/submissions/${s.id}/void`, { reason: why }); render(); } }) }, 'Remove') : '')))))) : '',
    h('div', { style: 'margin-top:.8rem' }, filesPanel(o, w, err)), h('div', { style: 'margin-top:.8rem' }, notesPanel(o, w)),
    o.acceptedDate && !o.projectId ? await takeoffCard(o, err, w) : '',
    w && !o.projectId ? h('div', { style: 'margin-top:.6rem' }, h('button', { class: 'small danger', onclick: guard(err, async () => { if (confirm(`Delete ${o.name}? This removes its notes and files.`)) { await api('DELETE', '/opportunities/' + o.id); location.hash = '#/estimating/bids'; } }) }, 'Delete opportunity')) : '');
}

// ---------------------------------------------------------------- Follow Ups
const FU_FILTERS = ['Action Needed', 'Due Now', 'Active', 'Waiting', 'Closed', 'All'];
const FU_TONE = { Active: '', 'Replied / Action Needed': 'Pending', 'Needs Schedule Review': 'Rejected', Paused: 'Pending', 'Awaiting GC Award': 'Valid', 'Selected / Awaiting Contract': 'Approved', 'Not Selected / Not Won': 'Rejected', 'Closed / No Response': '', 'Closed / Awarded': 'Approved', Superseded: '' };
async function followUpsPanel(err, w, caseId) {
  const filter = state.fuFilter || 'Active', data = await api('GET', '/followups?filter=' + encodeURIComponent(filter)), today = todayStr();
  const list = h('div', { class: 'card' }, h('h2', {}, 'Follow Ups'), h('p', { class: 'muted' }, 'One case for each submitted bid version. Emails and calls are sent by a person and logged here. Waits are Monday–Friday business days, Eastern time.'),
    filterChips(FU_FILTERS, filter, data.counts, (k) => { state.fuFilter = k; render(); }),
    data.rows.length ? h('div', { class: 'scroll' }, h('table', { class: 'biglist' }, h('thead', {}, h('tr', {}, ['Proposal / Project', 'GC Contact', 'Submitted', 'Scope', 'Stage', 'Next Due', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, data.rows.map((r) => h('tr', {}, h('td', { style: 'white-space:normal;min-width:200px' }, h('strong', {}, r.proposalId || ''), h('div', { class: 'edit', onclick: () => (location.hash = '#/estimating/followups/' + r.id) }, r.name), sub(r.address)),
        h('td', { style: 'white-space:normal' }, r.gc, r.contact ? sub(r.contact) : '', r.email ? sub(r.email) : '', r.phone ? sub(r.phone) : ''), h('td', {}, fmtDay(r.submittedDate), sub('Version ' + r.version)), h('td', { style: 'white-space:normal' }, sub(r.trades.join(', '))),
        h('td', {}, h('span', { class: 'pill ' + (FU_TONE[r.status] || '') }, r.status === 'Active' ? r.stage : r.status)), h('td', {}, r.due ? h('span', { class: r.due < today && ['Active', 'Awaiting GC Award'].includes(r.status) ? 'neg' : '' }, fmtDay(r.due)) : '—'),
        h('td', {}, h('button', { class: 'small', onclick: () => (location.hash = '#/estimating/followups/' + r.id) }, 'Open'))))))) : h('p', { class: 'muted', style: 'padding:1rem 0' }, 'Nothing in this view. A case opens automatically when a proposal is submitted.'));
  return h('div', {}, caseId ? await followCase(caseId, err, w) : '', list);
}
const copy = async (text, btn) => { try { await navigator.clipboard.writeText(text); const t = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => (btn.textContent = t), 1200); } catch { prompt('Copy this text', text); } };
async function followCase(id, err, w) {
  const p = await api('GET', `/opportunities/${id}/followup`), op = await opts(), today = todayStr();
  const stopped = ['Closed / Awarded', 'Not Selected / Not Won', 'Superseded'].includes(p.status), closed = stopped || p.status === 'Closed / No Response';
  const stage = p.steps.find((s) => !s.done && s.key !== 'close');
  const steps = h('div', { class: 'steps' }, p.steps.map((s) => h('div', { class: 'step' + (s.done ? ' done' : s === stage && p.status === 'Active' ? ' now' : '') }, h('div', { class: 'l' }, s.label), s.done ? h('div', {}, '✓ ' + fmtDay(s.done)) : h('div', { class: p.status === 'Active' && s.due < today ? 'neg' : '' }, (s.key === 'close' ? 'After final email: ' : 'Due ') + fmtDay(s.due)))));
  const mail = (d) => `mailto:${p.email || ''}?subject=${encodeURIComponent(d.subject)}&body=${encodeURIComponent(d.body)}`;
  const draft = (title, text, extra) => h('details', { style: 'margin:.3rem 0' }, h('summary', {}, title), h('pre', { class: 'draft' }, text), h('div', { class: 'row' }, h('button', { type: 'button', class: 'small', onclick: (e) => copy(text, e.target) }, 'Copy'), extra || ''));
  const kindFor = { 'First email': 'First Email Sent', 'Call 1': 'Call 1', 'Call 2': 'Call 2', 'Final email': 'Final Email Sent' }[stage?.label];
  const lf = { kind: h('select', {}, [['First Email Sent', 'First email sent'], ['Call 1', 'Call 1 made'], ['Call 2', 'Call 2 made'], ['Final Email Sent', 'Final email sent'], ['Reply Received', 'Reply received from the GC'], ['Note', 'Note only']].map(([v, l]) => h('option', { value: v }, l))), date: h('input', { type: 'date', value: today, max: today }), outcome: h('select', {}, h('option', { value: '' }, 'How did the call go?'), ['Answered', 'No Answer', 'Voicemail Left', 'No Voicemail Available'].map((v) => h('option', { value: v }, v))), note: h('input', { placeholder: 'What was said, or who replied' }) };
  lf.kind.value = kindFor || 'Reply Received'; const outWrap = field('Call outcome', lf.outcome); const sync = () => (outWrap.style.display = lf.kind.value.startsWith('Call') ? '' : 'none'); lf.kind.onchange = sync; sync();
  const log = guard(err, async () => { await api('POST', `/opportunities/${id}/followup/log`, { kind: lf.kind.value, date: lf.date.value, outcome: lf.kind.value.startsWith('Call') ? lf.outcome.value : undefined, note: lf.note.value }); render(); });
  const classify = (title, body, fields, extra) => { const f = fields(); formModal(title, [summary({ name: p.name, proposalId: p.proposalId, gc: p.gc, address: '', city: '', due: null, status: 'Submitted' }), ...f.nodes], async () => { await api('POST', `/opportunities/${id}/followup/classify`, { ...body, ...f.read() }); render(); }, 'Save'); };
  const date = () => h('input', { type: 'date', min: today, max: p.cutoff || undefined });
  const act = [];
  if (w && !closed) {
    act.push(h('button', { class: 'small', onclick: () => { const d = date(); classify('GC says it is not yet awarded', { response: 'Awaiting GC Award' }, () => ({ nodes: [h('p', { class: 'muted wide' }, 'Outreach pauses and the bid stays Pending. Pick the date the GC agreed to be checked again' + (p.cutoff ? ` (on or before ${fmtDay(p.cutoff)})` : '') + '.'), field(lbl('Next check date', true), d)], read: () => ({ nextCheck: d.value }) })); } }, 'GC: not awarded yet'));
    act.push(h('button', { class: 'small', onclick: () => classify('GC selected byOther', { response: 'Selected' }, () => ({ nodes: [h('p', { class: 'muted wide' }, 'Pursuit emails stop and a to-do is created to get the issued contract. The project is created only after the contract is confirmed (Award).')], read: () => ({}) })) }, 'GC: selected us'));
    act.push(h('button', { class: 'small', onclick: () => { const r = h('select', { required: true }, h('option', { value: '' }, 'Choose a reason…'), op.notAwardedReasons.map((x) => h('option', { value: x }, x))); classify('GC says byOther was not selected', { response: 'Not Selected' }, () => ({ nodes: [h('p', { class: 'muted wide' }, 'Only for an explicit rejection of all the submitted scope. The bid is recorded as Not Awarded and outreach stops.'), field(lbl('Reason', true), r, 'wide')], read: () => ({ reason: r.value }) })); } }, 'GC: not selected'));
    act.push(h('button', { class: 'small', onclick: guard(err, async () => { await api('POST', `/opportunities/${id}/followup/classify`, { response: 'Needs Response' }); render(); }) }, 'Needs a reply'));
    if (p.status === 'Active') act.push(h('button', { class: 'small', onclick: guard(err, async () => { await api('POST', `/opportunities/${id}/followup/pause`, {}); render(); }) }, 'Pause'));
  }
  if (w && ['Paused', 'Awaiting GC Award', 'Replied / Action Needed', 'Needs Schedule Review', 'Closed / No Response'].includes(p.status)) act.push(h('button', { class: 'small primary', onclick: () => { const d = date(); formModal('Resume follow-up', [h('p', { class: 'muted wide' }, 'The log is kept and finished steps are not repeated. Choose the weekday for the next action.'), field(lbl('Next action date', true), d)], async () => { await api('POST', `/opportunities/${id}/followup/resume`, { nextCheck: d.value }); render(); }, 'Resume'); } }, 'Resume'));
  const start = h('input', { type: 'date', value: p.plannedStart || '', disabled: !w ? true : null });
  return h('div', { class: 'card', style: 'border-color:var(--navy)' }, h('div', { class: 'row spread' }, h('h2', {}, `Follow-up · ${p.proposalId ? p.proposalId + ' · ' : ''}${p.name}`), h('a', { href: '#/estimating/followups' }, 'Close')),
    h('div', { class: 'row', style: 'gap:.6rem;margin-bottom:.4rem' }, h('span', { class: 'pill ' + (FU_TONE[p.status] || '') }, p.status), h('span', { class: 'muted' }, `${p.gc}${p.contact ? ' · ' + p.contact : ''}${p.email ? ' · ' + p.email : ''}${p.phone ? ' · ' + p.phone : ''}`)),
    h('p', { class: 'muted' }, `${p.address} · Version ${p.version} submitted ${fmtDay(p.submittedDate)} · ${p.trades.join(', ')} · Estimator ${p.estimator || '—'}`),
    p.status === 'Needs Schedule Review' ? h('div', { class: 'err' }, `The remaining contacts cannot fit before the cutoff (${fmtDay(p.cutoff)}). Outreach is paused. Correct the project start date, or resume with a feasible date.`) : '',
    p.status === 'Replied / Action Needed' ? h('div', { class: 'ok' }, 'The GC replied. Read it, answer in your email, then say what the GC said below. Nothing is sent automatically.') : '',
    steps, h('div', { class: 'row', style: 'gap:.6rem;align-items:end' }, field('Planned project start', start), w ? h('button', { class: 'small', onclick: guard(err, async () => { await api('PUT', '/opportunities/' + id, { plannedStart: start.value || null }); render(); }) }, 'Save') : '', p.cutoff ? h('span', { class: 'muted' }, `Last proactive contact by ${fmtDay(p.cutoff)}`) : h('span', { class: 'muted' }, 'No start date: standard 7 / 3 / 2 / 4 / 2 business-day waits.')),
    w && !closed ? h('div', { style: 'margin-top:.8rem' }, h('label', {}, 'Log what happened'), h('div', { class: 'form' }, field('What', lf.kind), field('Date', lf.date), outWrap, field('Note', lf.note, 'wide')), h('button', { class: 'primary', style: 'margin-top:.5rem', onclick: log }, 'Log it')) : '',
    act.length ? h('div', { style: 'margin-top:.8rem' }, h('label', {}, 'What the GC said'), h('div', { class: 'row', style: 'flex-wrap:wrap' }, act)) : '',
    h('div', { style: 'margin-top:.8rem' }, h('label', {}, 'Messages (sent by you; from and reply-to estimates@byother.net)'), p.drafts.missing.length ? h('div', { class: 'err' }, 'Missing: ' + p.drafts.missing.join(', ') + '. Add them on the opportunity before sending; nothing is invented.') : '',
      draft('First email', `Subject: ${p.drafts.email1.subject}\n\n${p.drafts.email1.body}`, p.email ? h('a', { class: 'small', href: mail(p.drafts.email1) }, 'Open in my email app') : ''), draft('Call script (calls 1 and 2)', p.drafts.call), draft('Voicemail (call 2)', p.drafts.voicemail),
      draft('Final email (reply in the same conversation)', `Subject: ${p.drafts.final.subject}\n\n${p.drafts.final.body}`, p.email ? h('a', { class: 'small', href: mail(p.drafts.final) }, 'Open in my email app') : ''), draft('Reply: award still pending', p.drafts.replyPending), draft('Reply: byOther not selected', p.drafts.replyNotSelected)),
    h('div', { style: 'margin-top:.8rem' }, h('label', {}, 'History'), p.history.length ? h('table', {}, h('tbody', {}, p.history.map((x) => h('tr', {}, h('td', {}, fmtDay(x.date)), h('td', {}, x.kind + (x.outcome ? ` (${x.outcome})` : '')), h('td', {}, x.note || ''), h('td', { class: 'muted' }, x.who || ''))))) : h('p', { class: 'muted' }, 'Nothing logged yet.')));
}

// ---------------------------------------------------------------- the project page: everything gathered before the award
export async function originCard(projectId) {
  const o = await api('GET', `/projects/${projectId}/origin`);
  if (!o) return h('div', { class: 'card soon' }, h('h2', {}, 'Bid History'), h('p', {}, 'This project was not created from an estimate, so there is no lead or proposal history.'));
  const row = (l, v) => h('div', {}, h('label', {}, l), h('div', {}, v || '—'));
  return h('div', {}, h('div', { class: 'card' }, h('h2', {}, 'From the lead'), h('div', { class: 'form' }, row('Client', o.client), row('GC', o.gc), row('GC contact', [o.contact, o.email, o.phone].filter(Boolean).join(' · ')), row('Project address', o.address), row('Source', o.sourceType), row('Invitation', o.link && h('a', { href: o.link, target: '_blank', rel: 'noopener' }, 'Open invitation')),
    row('Project type', o.type), row('Estimator', o.estimator), row('Proposal #', o.proposalId), row('Bid due', o.due ? fmtDay(o.due) : ''), row('Accepted', o.acceptedDate ? fmtDay(o.acceptedDate) : ''), row('Trades considered', o.consideredTrades.map((t) => t.name).join(', ')))),
    h('div', { class: 'card' }, h('h2', {}, 'Proposal and submittal'), o.submissions.length ? h('table', {}, h('thead', {}, h('tr', {}, ['Version', 'Submitted', 'How', 'Price', 'Trades'].map((t) => h('th', {}, t)))), h('tbody', {}, o.submissions.map((s) => h('tr', {}, h('td', {}, 'v' + s.version), h('td', {}, fmtDay(s.date)), h('td', {}, s.method), h('td', {}, usd(s.price)), h('td', {}, (s.trades || []).map((t) => `${t.name} ${usd(t.amount)}`).join(' · ')))))) : '',
      h('label', { style: 'margin-top:.6rem' }, 'Files'), o.files.length ? h('div', {}, o.files.map((f) => h('div', {}, h('a', { href: '/api/opportunity-files/' + f.id, target: '_blank', rel: 'noopener' }, f.name), h('span', { class: 'muted' }, ` · ${f.kind}`)))) : h('p', { class: 'muted' }, 'No files.'), o.folderUrl ? h('p', {}, h('a', { href: o.folderUrl, target: '_blank', rel: 'noopener' }, 'OneDrive folder')) : ''),
    h('div', { class: 'card' }, h('h2', {}, 'Notes and history'), h('div', { class: 'notes' }, o.notes.map((n) => h('div', { class: 'note ' + n.kind }, h('div', {}, n.body), h('div', { class: 'meta' }, `${n.kind === 'System' ? 'System' : n.who || 'User'} · ${when(n.at)} ET`)))),
      o.communications.length ? h('p', { class: 'muted' }, 'Follow-up: ' + o.communications.map((c) => `${fmtDay(c.date)} ${c.kind}`).join(' · ')) : ''));
}

// ---------------------------------------------------------------- Insights (+ the decline rules)
async function insightsTab(err) {
  const [panel, op, ins] = await Promise.all([insightsPanel(err), opts(), api('GET', '/estimating/insights')]); const canSet = ['Super Admin', 'Sub Admin'].includes(state.user.role);
  const nd = num(op.rules.declineNewDays, { step: '1', min: '0', max: '30', disabled: !canSet }), rd = num(op.rules.declineReviewingDays, { step: '1', min: '0', max: '30', disabled: !canSet });
  return h('div', {}, panel, h('div', { class: 'card' }, h('h2', {}, 'Auto-decline rules'), h('p', { class: 'muted' }, 'A New opportunity is declined this many days after its bid due date, and the system writes it in Notes. A Reviewing opportunity that was never accepted follows the second number. Opportunities with no bid due date never expire.'),
    h('div', { class: 'row' }, h('label', { style: 'margin:0' }, 'New: days after due'), nd, h('label', { style: 'margin:0' }, 'Reviewing: days after due'), rd, canSet ? h('button', { class: 'small', onclick: guard(err, async () => { await api('PUT', '/settings/estimating', { declineNewDays: nd.value, declineReviewingDays: rd.value }); OPTS = null; render(); }) }, 'Save') : '')),
    ins.declineReasons.length ? h('div', { class: 'card' }, h('h2', {}, 'Why opportunities were declined'), h('table', {}, h('tbody', {}, ins.declineReasons.map((r) => h('tr', {}, h('td', {}, r.reason), h('td', { class: 'n' }, r.n)))))) : '');
}


// ---------------------------------------------------------------- plan takeoff (AI-assisted, verified by a person)
async function takeoffCard(o, err, w) {
  const [runs, trades] = await Promise.all([api('GET', `/opportunities/${o.id}/takeoff`), opts().then((x) => x.trades)]); const tr = trades.filter((t) => !t.archived); const msg = h('div');
  const file = h('input', { type: 'file', accept: '.pdf', style: 'display:none', onchange: guard(msg, async () => { const f = file.files[0]; if (!f) return; notice(msg, 'Reading the plans. This can take a minute or two…', 'ok'); const r = await uploadFile(`/opportunities/${o.id}/takeoff`, f); file.value = ''; if (r.error) { notice(msg, r.error); return; } render(); }) });
  const runCard = (r) => {
    const set = (it, b) => guard(msg, async () => { await api('PUT', `/takeoff/items/${it.id}`, b); render(); });
    const sel = (it) => { const s2 = h('select', { disabled: !w || r.status === 'Applied' ? true : null, onchange: (e) => set(it, { tradeId: e.target.value || null })() }, h('option', { value: '' }, '—'), tr.map((t) => h('option', { value: t.id }, t.name))); s2.value = it.tradeId || ''; return s2; };
    const numIn = (it, k, ph) => h('input', { type: 'number', step: '0.01', min: '0', value: it[k] ?? '', placeholder: ph, style: 'width:90px', disabled: !w || r.status === 'Applied' ? true : null, onchange: (e) => set(it, { [k]: e.target.value === '' ? null : e.target.value })() });
    const chk = (it, k) => h('input', { type: 'checkbox', checked: it[k] ? true : null, disabled: !w || r.status === 'Applied' ? true : null, onchange: (e) => set(it, { [k]: e.target.checked })() });
    const sections = ['Demolition keynote', 'Wall type', 'Paint', 'Carpentry', 'Other']; const th = (t) => h('th', {}, t);
    return h('div', { style: 'margin-top:1rem;border-top:1px solid var(--line);padding-top:.8rem' }, h('div', { class: 'row spread' }, h('strong', {}, `Read ${new Date(r.createdAt).toLocaleString()}${r.by ? ' by ' + r.by : ''}`), h('span', { class: 'pill ' + (r.status === 'Applied' ? 'Approved' : r.status === 'Verified' ? 'Valid' : 'Pending') }, r.status)),
      r.warnings.map((x) => h('div', { class: 'err' }, x)),
      sections.map((sec) => { const items = r.items.filter((i) => i.section === sec); if (!items.length) return ''; return h('div', { style: 'margin-top:.6rem' }, h('label', {}, sec + (sec === 'Carpentry' ? ' (only items the matrix assigns to us are included)' : '')),
        h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, th('Use'), th('OK'), th('Code'), th('What the plans say'), th('Sheet'), sec === 'Carpentry' ? th('Who') : '', th('Qty'), th('Unit'), th('$ / unit'), th('Trade'), th('Total'), th(''))),
          h('tbody', {}, items.map((it) => h('tr', { class: it.include ? '' : 'muted' }, h('td', {}, chk(it, 'include')), h('td', {}, chk(it, 'verified')), h('td', {}, it.code || ''), h('td', { style: 'white-space:normal;min-width:260px' }, it.description), h('td', {}, it.sheet || ''), sec === 'Carpentry' ? h('td', {}, h('span', { class: 'pill ' + (it.responsibility === 'Contractor' ? 'Approved' : it.responsibility === 'By others' ? 'Declined' : 'Pending') }, it.responsibility)) : '', h('td', {}, numIn(it, 'quantity', 'Qty')), h('td', {}, it.unit || ''), h('td', {}, numIn(it, 'unitPrice', '$')), h('td', {}, sel(it)), h('td', { class: 'n' }, it.lineTotal != null ? usd(it.lineTotal) : ''),
            h('td', {}, w && r.status !== 'Applied' ? h('button', { class: 'small danger', onclick: guard(msg, async () => { await api('DELETE', `/takeoff/items/${it.id}`); render(); }) }, '×') : ''))))))); }),
      w && r.status !== 'Applied' ? h('div', { class: 'row', style: 'margin-top:.8rem' }, h('button', { onclick: () => { const d = h('input'), s2 = h('select', {}, sections.map((x) => h('option', { value: x }, x))); formModal('Add an item the plans missed', [field('Section', s2), field('Description', d, 'wide')], async () => { await api('POST', `/takeoff/${r.id}/items`, { section: s2.value, description: d.value }); render(); }, 'Add'); } }, '+ Add item'),
        h('button', { onclick: guard(msg, async () => { await api('POST', `/takeoff/${r.id}/verify`, {}); render(); }) }, 'Mark verified'), h('button', { class: 'primary', disabled: r.status !== 'Verified' ? true : null, title: r.status !== 'Verified' ? 'Verify every included item first' : '', onclick: guard(msg, async () => { const x = await api('POST', `/takeoff/${r.id}/apply`, {}); notice(msg, `Applied to ${x.trades} trade prices. Review them under Price trades.`, 'ok'); render(); }) }, 'Apply to proposal prices')) : '');
  };
  return h('div', { style: 'margin-top:1rem;border-top:1px solid var(--line);padding-top:.8rem' }, h('div', { class: 'row spread' }, h('h2', {}, 'Plan takeoff (AI-assisted)'), w && h('div', { class: 'row' }, file, h('button', { onclick: () => file.click() }, 'Upload plans (PDF) and read them'))),
    h('p', { class: 'muted' }, 'Reads demo keynotes, wall types, paint by code, and carpentry the responsibility matrix assigns to the contractor. You verify each item and add prices; nothing reaches the proposal until you apply it.'), msg, runs.map(runCard), runs.length ? '' : h('p', { class: 'muted' }, 'No takeoff yet.'));
}


async function insightsPanel(err) {
  const i = await api('GET', '/estimating/insights'); const th = (t, n) => h('th', { class: n ? 'n' : '' }, t); const rateTbl = (rows, label) => rows.length ? h('table', {}, h('thead', {}, h('tr', {}, th(label), th('Bids', 1), th('Won', 1), th('Lost', 1), th('Win rate', 1), th('Avg price', 1))), h('tbody', {}, rows.map((r) => h('tr', {}, h('td', {}, r.name), h('td', { class: 'n' }, r.bids ?? ''), h('td', { class: 'n' }, r.won), h('td', { class: 'n' }, r.lost), h('td', { class: 'n' }, r.winRate == null ? '—' : r.winRate + '%'), h('td', { class: 'n' }, r.avgPrice != null ? usd(r.avgPrice) : ''))))) : h('p', { class: 'muted' }, 'Nothing scored yet.');
  const tm = num(i.target, { step: '1', disabled: !['Super Admin', 'Sub Admin'].includes(state.user.role) });
  return h('div', {}, !i.enough ? h('p', { class: 'ok' }, 'Insights sharpen as bids are scored. Mark proposals Awarded or Lost; with 5 or more scored, win-rate forecasts switch on.') : '',
    h('div', { class: 'grid kpis' }, h('div', { class: 'kpi' }, h('div', { class: 'l' }, 'Win rate'), h('div', { class: 'v' }, i.overall.winRate == null ? '—' : i.overall.winRate + '%')), h('div', { class: 'kpi' }, h('div', { class: 'l' }, 'Open proposals'), h('div', { class: 'v' }, i.pipeline.open)), h('div', { class: 'kpi' }, h('div', { class: 'l' }, 'Pipeline value'), h('div', { class: 'v' }, usd(i.pipeline.value))), h('div', { class: 'kpi good' }, h('div', { class: 'l' }, 'Expected awards'), h('div', { class: 'v' }, i.pipeline.expected == null ? '—' : usd(i.pipeline.expected)))),
    h('div', { class: 'card', style: 'margin-top:1rem' }, h('div', { class: 'row spread' }, h('h2', {}, 'Margins you actually make, by trade'), h('div', { class: 'row' }, h('label', { style: 'margin:0' }, 'Target margin %'), tm, ['Super Admin', 'Sub Admin'].includes(state.user.role) && h('button', { class: 'small', onclick: guard(err, async () => { await api('PUT', '/settings/estimating', { targetMargin: tm.value }); render(); }) }, 'Save'))),
      i.margins.length ? h('table', {}, h('thead', {}, h('tr', {}, th('Trade'), th('Projects', 1), th('Realized margin', 1), th('Target', 1), th('What to do'))), h('tbody', {}, i.margins.map((m) => h('tr', {}, h('td', {}, m.trade), h('td', { class: 'n' }, m.projects), h('td', { class: 'n ' + (m.gap > 0 ? 'neg' : 'pos') }, m.margin + '%'), h('td', { class: 'n' }, m.target + '%'), h('td', { style: 'white-space:normal' }, m.suggestion))))) : h('p', { class: 'muted' }, 'Appears once awarded projects have costs posted.')),
    h('div', { class: 'card' }, h('h2', {}, 'By GC'), rateTbl(i.byGc, 'GC')), h('div', { class: 'card' }, h('h2', {}, 'By project type'), rateTbl(i.byType, 'Type')), h('div', { class: 'card' }, h('h2', {}, 'By trade priced'), rateTbl(i.byTrade, 'Trade')),
    i.lossReasons.length ? h('div', { class: 'card' }, h('h2', {}, 'Why bids were lost'), h('table', {}, h('tbody', {}, i.lossReasons.map((r) => h('tr', {}, h('td', {}, r.reason), h('td', { class: 'n' }, r.n)))))) : '');
}

