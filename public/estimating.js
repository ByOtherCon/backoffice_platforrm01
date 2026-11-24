// Estimating screens: Bid Opportunities, Proposal Tracker, Submittal Tracker, Follow Ups, Insights, and the one opportunity form
// that every tracker uses. Everything is inserted with textContent (never innerHTML).
import { h, usd, notice, guard, oneAtATime, folderError, modal, formModal, field, todayStr, num } from '/ui.js';
import { addressBlock as makeAddressBlock } from '/address.js';
import * as estchat from '/estchat.js';
let C;
export const init = (c) => { C = c; estchat.init(c); };
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
const sub = (t, title) => h('div', { class: 'muted', style: 'font-size:13px', title: title || null }, t);
const addrLine = (o) => [o.address, o.city, o.zip ? 'FL ' + o.zip : ''].filter(Boolean).join(', ');

// ---------------------------------------------------------------- pieces every form shares
const summary = (o) => h('div', { class: 'osum' }, h('strong', {}, o.name), o.proposalId ? h('span', {}, '· ' + o.proposalId) : '', h('span', { class: 'muted' }, [o.gc, addrLine(o), o.due ? 'Bid due ' + fmtDay(o.due) : 'No bid due date'].filter(Boolean).join(' · ')), pill(o.status));
const star = () => h('span', { class: 'req' }, ' *');
const lbl = (t, required) => h('span', {}, t, required ? star() : '');

const addressBlock = (o) => makeAddressBlock(api, o);
function tradePicker(all, selected, canAdd) {
  const sel = new Set(selected), box = h('div', { class: 'chips' }), list = [...all];
  const draw = () => box.replaceChildren(...list.map((t) => h('button', { type: 'button', class: 'chip' + (sel.has(t.id) ? ' on' : ''), onclick: () => { sel.has(t.id) ? sel.delete(t.id) : sel.add(t.id); draw(); } }, (sel.has(t.id) ? '✓ ' : '+ ') + t.name)),
    canAdd ? h('button', { type: 'button', class: 'chip', onclick: async () => { const n = prompt('Name of the trade to add'); if (!n || !n.trim()) return; try { const r = await api('POST', '/admin/trades', { name: n.trim(), sort: list.length + 1 }); OPTS = null; list.push({ id: r.id, name: n.trim() }); sel.add(r.id); draw(); } catch (e) { alert(e.message); } } }, '+ New trade') : '');
  draw(); return { el: box, get: () => [...sel] };
}
// The log is kept closed until someone opens it.
function notesPanel(o, canWrite) {
  const box = h('div'), err = h('div'), text = h('textarea', { rows: 2, placeholder: 'Add a note. Status changes and edits are logged here automatically.' }), sum = h('summary', { style: 'cursor:pointer;font-weight:600' });
  const draw = (notes) => { sum.textContent = `Notes and activity (${notes.length})`; box.replaceChildren(h('div', { class: 'notes' }, notes.length ? notes.map((n) => h('div', { class: 'note ' + n.kind }, h('div', {}, n.body), h('div', { class: 'meta' }, `${n.kind === 'System' ? 'System' : n.who || 'User'} · ${when(n.at)} ET`))) : h('p', { class: 'muted' }, 'No notes yet.'))); };
  draw(o.notes || []);
  const add = guard(err, async () => { if (!text.value.trim()) return; await api('POST', `/opportunities/${o.id}/notes`, { body: text.value }); text.value = ''; draw((await api('GET', '/opportunities/' + o.id)).notes); });
  return h('details', { class: 'notes-d' }, sum, box, canWrite ? h('div', {}, text, h('button', { type: 'button', class: 'small', style: 'margin-top:.3rem', onclick: add }, 'Add note')) : '', err);
}
// Plans and files. "Open Plans" appears once a PDF with BID SET in its name is in the job's 01. DL folder; the proposal PDFs listed
// are whatever is in the job's 02. Proposal folder, plus anything uploaded here.
function filesPanel(o, canWrite, err) {
  const plansIn = h('input', { type: 'file', accept: '.zip,.pdf', style: 'display:none', onchange: guard(err, async () => { const f = plansIn.files[0]; if (!f) return; notice(err, `Uploading ${f.name} (${(f.size / 1048576).toFixed(1)} MB). Keep this page open until it finishes…`, 'ok'); const r = await uploadFile(`/opportunities/${o.id}/plans`, f); plansIn.value = ''; notice(err, r.sharepoint ? 'Plans uploaded. Copying them to the 01. DL folder in SharePoint now; a note appears in the log when it is done.' : 'Plans uploaded.', 'ok'); setTimeout(render, 1800); }) });
  const link = (f) => h('a', { href: f.local === false ? f.spUrl || '#' : '/api/opportunity-files/' + f.id, target: '_blank', rel: 'noopener' }, f.name);
  const del = (f) => (canWrite && !o.submissions.some((s) => s.fileId === f.id) ? h('button', { class: 'small danger', onclick: guard(err, async () => { if (confirm(`Remove ${f.name} from this lead? A copy already in SharePoint stays there.`)) { await api('DELETE', `/opportunities/${o.id}/files/${f.id}`); render(); } }) }, 'Remove') : '');
  const rowOf = (f) => h('tr', {}, h('td', {}, link(f), f.local === false ? h('span', { class: 'muted', style: 'font-size:12px' }, '  (in SharePoint)') : ''), h('td', { class: 'muted' }, when(f.at)), h('td', {}, del(f)));
  const live = o.files.filter((f) => !f.removed), plans = live.filter((f) => f.kind === 'Plans'), others = live.filter((f) => f.kind !== 'Plans' && f.kind !== 'Proposal'), props = live.filter((f) => f.kind === 'Proposal').sort((a, b) => String(b.at).localeCompare(String(a.at)));
  // ---- Plans
  const plansLive = h('div');
  const plansBox = h('div', {}, h('div', { class: 'row spread' }, h('label', {}, 'Plans'), canWrite ? h('span', {}, plansIn, h('button', { type: 'button', class: 'small primary', onclick: () => plansIn.click(), title: 'The zip from the BuildingConnected Files tab (Download All), or a PDF' }, 'Upload Plans')) : ''), plansLive,
    plans.length ? h('table', {}, h('tbody', {}, plans.map(rowOf))) : h('p', { class: 'muted', style: 'margin:.2rem 0' }, 'No plans uploaded here yet.'));
  // ---- Proposals: only the latest PDF and the latest Word file, wherever they were saved (made here, or saved into the library folder)
  const propLive = h('div', {}, h('p', { class: 'muted', style: 'margin:.2rem 0' }, 'Checking the SharePoint folder…')), gcLive = h('div'), propLabel = h('label', {}, 'Proposals');
  // Remove takes the file off the lead and out of the SharePoint folder (to its recycle bin); the next newest one then shows as the latest.
  const removeBtn = (f) => (canWrite && (f.fileId || f.itemId) ? h('button', { type: 'button', class: 'small danger', style: 'margin-left:.5rem', title: 'Remove this proposal file', onclick: guard(err, async () => {
    if (!confirm(`Remove ${f.name}?\n\nIt is taken off this lead and deleted from the SharePoint folder (it goes to the SharePoint recycle bin).${f.used ? ' It was submitted, so it stays on that submission\'s record.' : ''}`)) return;
    await api('POST', `/opportunities/${o.id}/proposals/remove`, { fileId: f.fileId || undefined, itemId: f.itemId || undefined }); render(); }) }, 'Remove') : '');
  const fileLine = (label, f) => h('div', { style: 'padding:.2rem 0' }, label ? [h('span', { class: 'pill' }, label), ' '] : '', h('a', { href: f.href, target: '_blank', rel: 'noopener' }, f.name), h('span', { class: 'muted', style: 'font-size:12px' }, `  ${f.at ? when(f.at) : ''}${f.where === 'SharePoint' ? ' · saved in SharePoint' : ''}`), removeBtn(f));
  const earlierList = (list) => (list?.length ? h('details', { style: 'margin-top:.3rem' }, h('summary', { style: 'cursor:pointer;font-size:14px' }, `Earlier files (${list.length})`), list.map((f) => fileLine('', f))) : '');
  const propIn = h('input', { type: 'file', accept: '.pdf,.docx', style: 'display:none', onchange: guard(err, async () => { const f = propIn.files[0]; propIn.value = ''; if (!f) return; notice(err, `Uploading ${f.name}…`, 'ok'); const r = await uploadFile(`/opportunities/${o.id}/files?kind=Proposal`, f);
    notice(err, `${f.name} is saved on this lead${r.sharepoint ? ' and in the 02. Proposal folder in SharePoint' : ''}.${r.aiError ? ' Its prices could not be read: ' + r.aiError : ''}`, 'ok'); setTimeout(render, 900); }) });
  const drawProps = (v, msg) => {
    const none = !v.latestPdf && !v.latestWord;
    propLive.replaceChildren(
      v.latestPdf ? fileLine('Latest PDF', v.latestPdf) : '', v.latestWord ? fileLine('Latest Word', v.latestWord) : '', none ? h('p', { class: 'muted', style: 'margin:.2rem 0' }, 'No proposal yet. Upload one here, write one in the estimating chat, or save one into the 02. Proposal folder.') : '',
      h('div', { class: 'row', style: 'gap:.6rem;flex-wrap:wrap;margin-top:.3rem;font-size:14px' },
        v.proposalFolderUrl ? h('a', { href: v.proposalFolderUrl, target: '_blank', rel: 'noopener' }, `Open The Proposal Folder In SharePoint${v.total > 2 ? ` (all ${v.total} files)` : ''}`) : '',
        !v.enabled ? h('span', { class: 'muted' }, 'SharePoint is not connected.') : !v.linked ? h('span', { class: 'muted' }, 'This lead has no SharePoint folder yet. It is made when the lead is Reviewed, Accepted or Started.') : '',
        canWrite && v.enabled ? h('button', { type: 'button', class: 'small', title: 'Makes the folder if it is missing, copies files kept here into it as a backup, and reads what was saved into it.', onclick: () => sync(true) }, 'Sync With SharePoint') : ''),
      v.error ? h('div', { class: 'err' }, v.error) : '', msg ? h('div', { class: msg.bad ? 'err' : 'ok' }, msg.text) : '',
      earlierList(v.earlier));
    // a bundled job: each other GC has its own proposals, in its own folder
    gcLive.replaceChildren(...(v.gcs || []).map((g) => { const up = h('input', { type: 'file', accept: '.pdf,.docx', style: 'display:none', onchange: guard(err, async () => { const f = up.files[0]; up.value = ''; if (!f) return; notice(err, `Uploading ${f.name} for ${g.gc}…`, 'ok'); const r = await uploadFile(`/opportunities/${o.id}/files?kind=Proposal&gc=${encodeURIComponent(g.gc)}`, f); notice(err, r.sharepoint ? `${f.name} is saved in the ${g.gc} folder.` : `${f.name} is saved here. It was not copied to the ${g.gc} folder; press Sync With SharePoint.`, r.sharepoint ? 'ok' : 'err'); sync(false); }) });
      return h('div', { style: 'margin-top:.9rem' }, h('div', { class: 'row spread' }, h('label', {}, `Proposals · ${g.gc}`), canWrite ? h('span', {}, up, h('button', { type: 'button', class: 'small', onclick: () => up.click() }, `Upload Proposal For ${g.gc}`)) : ''),
        g.latestPdf ? fileLine('Latest PDF', g.latestPdf) : '', g.latestWord ? fileLine('Latest Word', g.latestWord) : '', !g.latestPdf && !g.latestWord ? h('p', { class: 'muted', style: 'margin:.2rem 0' }, `No proposal for ${g.gc} yet. Upload its PDF here, save it into its 02. Proposal folder, or ask for it in the estimating chat ("make the proposal for ${g.gc}").`) : '',
        earlierList(g.earlier), g.proposalFolderUrl ? h('div', { style: 'font-size:14px;margin-top:.3rem' }, h('a', { href: g.proposalFolderUrl, target: '_blank', rel: 'noopener' }, `Open The ${g.gc} Proposal Folder In SharePoint${g.total > 2 ? ` (all ${g.total} files)` : ''}`)) : '', g.error ? h('div', { class: 'err' }, g.error) : ''); }));
    propLabel.textContent = (v.gcs || []).length ? `Proposals · ${v.gc || o.gc}` : 'Proposals';
    plansLive.replaceChildren((v.plans || []).filter((p) => !plans.some((x) => x.name.toLowerCase() === p.name.toLowerCase())).length ? h('div', { style: 'margin:.2rem 0' }, (v.plans || []).filter((p) => !plans.some((x) => x.name.toLowerCase() === p.name.toLowerCase())).map((p) => h('div', {}, h('a', { href: p.webUrl, target: '_blank', rel: 'noopener' }, p.name), h('span', { class: 'muted', style: 'font-size:12px' }, '  (in SharePoint)')))) : '',
      v.plansFolderUrl ? h('div', { style: 'font-size:14px;margin:.2rem 0' }, h('a', { href: v.plansFolderUrl, target: '_blank', rel: 'noopener' }, 'Open The Plans Folder In SharePoint')) : '');
  };
  // Opening the lead brings the two in step: the folder is made if it should exist, files kept here are backed up, and the library is read.
  const sync = async (force) => { try { if (force) propLive.append(h('p', { class: 'muted' }, 'Syncing…')); const v = canWrite ? await api('POST', `/opportunities/${o.id}/sync`, { force: !!force }) : await api('GET', `/opportunities/${o.id}/proposal-files`); const sy = v.sync;
    drawProps(v, sy?.error ? { bad: true, text: `The SharePoint folder could not be made: ${sy.error}` } : sy?.failed?.length ? { bad: true, text: `Not copied: ${sy.failed.join('; ')}` } : sy?.pushed || sy?.fixed || sy?.shortened || sy?.plansCopied || sy?.removed || sy?.renamedShort ? { text: [sy.pushed ? `${sy.pushed} file${sy.pushed === 1 ? '' : 's'} copied to SharePoint as a backup.` : '', sy.fixed ? `${sy.fixed} file${sy.fixed === 1 ? '' : 's'} in SharePoint given ${sy.fixed === 1 ? 'its' : 'their'} full name (.pdf, .docx).` : '', sy.renamedShort ? `${sy.renamedShort} file${sy.renamedShort === 1 ? '' : 's'} saved by Windows under a short name (like BYOTHE-1.PDF) ${sy.renamedShort === 1 ? 'was' : 'were'} given ${sy.renamedShort === 1 ? 'its' : 'their'} proper name and type.` : '', sy.removed ? `${sy.removed} file${sy.removed === 1 ? '' : 's'} you deleted in SharePoint ${sy.removed === 1 ? 'is' : 'are'} no longer listed here and will not be copied back.` : '', sy.plansCopied ? `${sy.plansCopied} plan file${sy.plansCopied === 1 ? '' : 's'} copied to the other GC folders.` : '', sy.shortened ? `${sy.shortened} proposal file${sy.shortened === 1 ? '' : 's'} given a shorter name so Word can open and save ${sy.shortened === 1 ? 'it' : 'them'}.` : ''].filter(Boolean).join(' ') } : force ? { text: 'In step with SharePoint.' } : null);
  } catch (e) { drawProps({ enabled: true, linked: false, earlier: props.map((f) => ({ name: f.name, href: f.local === false ? f.spUrl : '/api/opportunity-files/' + f.id })), latestPdf: null, latestWord: null, total: props.length }, { bad: true, text: e.message }); } };
  sync(false);
  const propsBox = h('div', { style: 'margin-top:.9rem' }, h('div', { class: 'row spread' }, propLabel, canWrite ? h('span', {}, propIn, h('button', { type: 'button', class: 'small primary', onclick: () => propIn.click(), title: 'A PDF or a Word (.docx) file. It is saved on this lead and in the 02. Proposal folder.' }, 'Upload Proposal')) : ''), propLive);
  return h('div', {}, plansBox, propsBox, gcLive,
    others.length ? h('div', { style: 'margin-top:.9rem' }, h('label', {}, 'Other files'), h('table', {}, h('tbody', {}, others.map(rowOf)))) : '',
    // once the job is a project, its own documents (contract, change orders, insurance) show here too
    o.projectDocs?.length ? h('div', { style: 'margin-top:.6rem' }, h('label', {}, 'Project documents'), o.projectDocs.map((d) => h('div', {}, h('a', { href: d.has_file ? `/api/documents/${d.id}/file` : d.url, target: '_blank', rel: 'noopener' }, d.name), ' ', h('span', { class: 'pill' }, d.category)))) : '');
}

// ---------------------------------------------------------------- the shared folder: opened in SharePoint
// Opens the first BID SET plan PDF from the job's 01. DL folder (or says there is none yet).
const openPlansButton = (o) => h('button', { type: 'button', class: 'small', onclick: async () => { const win = window.open('', '_blank'); try { const r = await api('GET', `/opportunities/${o.id}/folder-files`); if (r.plans.length) win.location = r.plans[0].webUrl; else { win.close(); alert('There is no BID SET PDF in the 01. DL folder yet.'); } } catch (e) { win.close(); alert(e.message); } } }, 'Open Plans');
// For one record's page: SharePoint link, File Explorer shortcut, the path to copy. (A project that has no folder can still be given one.)
export function folderButtons(o, w, kind = 'opportunity', sharepointOn = true) {
  const err = h('div');
  if (o.folderUrl) return h('div', {}, h('div', { class: 'row', style: 'flex-wrap:wrap;gap:.4rem' }, h('a', { class: 'small', href: o.folderUrl, target: '_blank', rel: 'noopener' }, 'Open in SharePoint')), err);
  if (kind === 'project' && w && sharepointOn) return h('div', {}, h('button', { type: 'button', class: 'small', onclick: guard(err, async () => { await api('POST', `/projects/${o.id}/folder`, {}); render(); }) }, 'Create folder in SharePoint'), err);
  return h('span', { class: 'muted' }, !sharepointOn ? 'SharePoint is not connected yet' : kind === 'project' ? 'No folder yet' : 'The folder is created automatically when the lead is Reviewed or Accepted.');
}

// ---------------------------------------------------------------- the one opportunity form: the same layout to read it (Open) and to change it (Edit)
// In Open mode an empty field reads as a dash, not a blank date picker.
const dash = (readonly, value, attrs) => (readonly && !value ? h('input', { value: '—', disabled: true }) : h('input', { ...attrs, value: value ?? '', disabled: readonly || null }));
function buildOpportunityForm(full, op, known, { readonly = false } = {}) {
  const isNew = !full, me = state.user, canAddTrade = ['Super Admin', 'Sub Admin', 'Exec Assistant'].includes(me.role), ro = readonly || null;
  const f = { name: h('input', { value: full?.name ?? '', required: true, disabled: ro }), client: h('input', { value: full?.client ?? '', required: true, disabled: ro }), gc: h('input', { value: full?.gc ?? '', required: true, list: 'gc-list', autocomplete: 'off', disabled: ro }),
    contact: h('input', { value: full?.contact ?? '', disabled: ro }), email: h('input', { type: 'email', value: full?.email ?? '', disabled: ro }), phone: h('input', { type: 'tel', value: full?.phone ?? '', disabled: ro }),
    source: h('select', { required: true, disabled: ro }, h('option', { value: '' }, 'Choose…'), op.sources.map((s) => h('option', { value: s }, s))), link: h('input', { type: 'url', value: full?.link ?? '', placeholder: 'https://app.buildingconnected.com/…', disabled: ro }),
    est: h('select', { required: true, disabled: ro }, h('option', { value: '' }, 'Choose…'), op.estimators.map((u) => h('option', { value: u.id }, u.name || u.email))),
    due: dash(readonly, full?.due, { type: 'date', required: isNew || !!full?.due }), time: dash(readonly, full?.dueTime, { type: 'time' }), start: dash(readonly, full?.plannedStart, { type: 'date' }),
    mall: h('input', { type: 'checkbox', checked: full?.mall ? true : null, disabled: ro }), note: h('textarea', { rows: 2, placeholder: 'Anything worth remembering' }) };
  f.source.value = full?.sourceType ?? ''; f.est.value = full?.estimatorId ?? (isNew && op.estimators.some((u) => u.id === me.id) ? me.id : '');
  let type = full?.type ?? ''; const typeBox = h('div', { class: 'seg' }); const drawType = () => typeBox.replaceChildren(...op.projectTypes.map((t) => h('button', { type: 'button', class: t === type ? 'on' : '', disabled: ro, onclick: () => { type = t; drawType(); } }, t === 'Office / Medical / Other' ? 'Medical / Office' : t))); drawType();
  const gcb = addressBlock({ kind: 'gc', init: full?.gcAddr, label: 'GC address (optional)', readonly }), proj = addressBlock({ kind: 'project', init: full ? { street: full.address, city: full.city, state: 'FL', zip: full.zip, verified: full.addrVerified } : null, label: 'Project address (Florida)', readonly });
  const picker = tradePicker(op.trades, (full?.consideredTrades || []).map((t) => t.tradeId), canAddTrade && !readonly); const linkLabel = h('label', {}, 'Invitation link');
  const sync = () => { linkLabel.replaceChildren('Invitation link', f.source.value === 'Building Connected' && !readonly ? star() : ''); f.link.required = f.source.value === 'Building Connected'; }; f.source.onchange = sync; sync();
  const hint = h('div', { class: 'muted wide', style: 'font-size:13px' });
  f.gc.onchange = () => { if (readonly) return; const g = known.find((x) => x.name.toLowerCase() === f.gc.value.trim().toLowerCase()); if (!g) { hint.textContent = f.gc.value.trim() ? 'A new GC. It joins the list when you save.' : ''; return; } hint.textContent = 'A GC we already work with. Its details were filled in.';
    f.gc.value = g.name; if (gcb.empty() && g.addr) gcb.set(g.addr, null, true); if (!f.contact.value) f.contact.value = g.contact; if (!f.email.value) f.email.value = g.email; if (!f.phone.value) f.phone.value = g.phone; };
  const req = (t) => (readonly ? t : lbl(t, true));
  const nodes = [h('datalist', { id: 'gc-list' }, known.map((g) => h('option', { value: g.name }))),
    field(req('Project name'), f.name), field(req('Client name'), f.client), field(req('GC name'), f.gc), hint,
    h('div', { class: 'wide' }, gcb.head, gcb.el),
    h('div', { class: 'wide' }, h('label', {}, 'GC estimating contact')), field('Name', f.contact), field('Email', f.email), field('Phone', f.phone),
    h('div', { class: 'wide' }, proj.head, proj.el),
    field(req('Source'), f.source), h('div', {}, linkLabel, f.link), field(req('Estimator'), f.est),
    field(req('Bid due date'), f.due), field('Due time (ET)', f.time), field('Planned start', f.start),
    h('div', { class: 'wide' }, h('label', {}, req('Project type')), typeBox, h('label', { style: 'text-transform:none;letter-spacing:0;font-size:15px;font-weight:400;margin-top:.5rem;display:block' }, f.mall, ' In a shopping center / mall')),
    h('div', { class: 'wide' }, h('label', {}, 'Trades being considered'), readonly && !(full?.consideredTrades || []).length ? h('span', { class: 'muted' }, 'Chosen by the estimator') : picker.el),
    isNew ? h('div', { class: 'wide' }, h('label', {}, 'Note'), f.note, h('div', { class: 'muted', style: 'font-size:13px' }, 'A note with your name and the date and time is added automatically.')) : ''].filter((x) => x !== '');
  const body = () => {
    if (!type) throw new Error('Choose the project type.');
    if (!proj.ok()) throw new Error('The project address is not verified yet. Fill in street, city and ZIP; it checks itself and shows a green check.');
    if (!gcb.empty() && !gcb.ok()) throw new Error('The GC address is not verified yet, or clear its fields.');
    const b = { name: f.name.value, client: f.client.value, gc: f.gc.value, addr: proj.get(), gcAddr: gcb.empty() ? { street: '', city: '', state: '', zip: '' } : gcb.get(), contact: f.contact.value, email: f.email.value, phone: f.phone.value, sourceType: f.source.value, link: f.link.value, estimatorId: f.est.value || null, due: f.due.value || null, dueTime: f.time.value || null, plannedStart: f.start.value || null, type, mall: f.mall.checked, tradeIds: picker.get() };
    if (isNew) b.note = f.note.value; return b;
  };
  return { nodes, body, wrap: () => h('div', { class: 'form oform' + (readonly ? ' ro' : '') }, nodes) };
}
async function opportunityForm(o) {   // a new opportunity, in a pop-up (an existing one is opened on its own page)
  const op = await opts(), known = await api('GET', '/gcs/known'); const built = buildOpportunityForm(null, op, known);
  formModal('New opportunity', built.nodes, async () => {
    const b = built.body(), qs = new URLSearchParams({ name: b.name, gc: b.gc, city: b.addr?.city || '', address: b.addr?.street || '' });
    const same = (await api('GET', '/opportunities/similar?' + qs)).leads;
    if (same.length) { const pick = await askBundle(same, b); if (!pick) throw new Error('Not saved yet. Choose Bundle or Create Separately.'); if (pick.bundleWith) b.bundleWith = pick.bundleWith; }
    await api('POST', '/opportunities', b); render();
  }, 'Add opportunity');
}
// What happens to the folders of one job under more than one GC (there is no choice to make).
const FOLDERS_SAY = 'Each GC gets its own project folder once the lead is Accepted or Started. Plans are copied into all of them. Proposals are not: each GC keeps its own, because the price can differ. When the lead is Started it becomes one proposal for each GC (P11031, P11031-B, P11031-C), so each one is submitted on its own.';
function askBundle(same, b) {
  return new Promise((done) => {
    const name = 'bw' + Math.random().toString(36).slice(2, 7); let settled = false;
    const finish = (v) => { if (settled) return; settled = true; bg.remove(); done(v); };
    const rows = same.map((l, i) => h('label', { style: 'display:block;text-transform:none;letter-spacing:0;font-size:15px;font-weight:400;margin:.3rem 0' }, h('input', { type: 'radio', name, value: l.id, checked: i === 0 ? true : null }), ' ', h('strong', {}, l.name), ` · ${l.gcs.join(', ')} · ${l.city || ''} · due ${l.due ? fmtDay(l.due) : '—'} · ${l.status}`));
    const bg = modal('Same Job Already On The List', h('div', {}, h('p', {}, `${b.name} is already on the list under ${[...new Set(same.flatMap((l) => l.gcs))].join(', ')}. The same job from another GC is one job with one submission, and any of those GCs can award it.`),
      h('div', {}, rows), h('p', { class: 'muted', style: 'margin-top:.8rem' }, FOLDERS_SAY),
      h('div', { class: 'row', style: 'margin-top:1rem;justify-content:flex-end;gap:.5rem' }, h('button', { type: 'button', onclick: () => finish(null) }, 'Go Back'), h('button', { type: 'button', onclick: () => finish({}) }, 'Create Separately'),
        h('button', { type: 'button', class: 'primary', onclick: () => finish({ bundleWith: bg.querySelector(`input[name=${name}]:checked`)?.value }) }, 'Bundle With This Job'))), { mode: 'edit' });
  });
}

// ---------------------------------------------------------------- moving between statuses (same look for every move)
async function statusModal(o, to) {
  const op = await opts(); const reasons = { Declined: op.declineReasons, 'Decided Not To Submit': op.dntsReasons, 'Not Awarded': op.notAwardedReasons }[to];
  if (to === 'Submitted' && ['Accepted', 'Started'].includes(o.status)) return submitModal(o);
  const f = { reason: h('select', { required: true }, h('option', { value: '' }, 'Choose a reason…'), (reasons || []).map((r) => h('option', { value: r }, r))), est: h('select', {}, op.estimators.map((u) => h('option', { value: u.id }, u.name || u.email))), due: h('input', { type: 'date' }), note: h('textarea', { rows: 2, placeholder: 'Optional' }) };
  f.awarded = h('select', { required: true }, h('option', { value: '' }, 'Choose the GC…'), (o.gcs || []).map((g) => h('option', { value: g }, g)));
  f.est.value = o.estimatorId || (op.estimators.some((u) => u.id === state.user.id) ? state.user.id : op.estimators[0]?.id);
  const WHAT = { Reviewing: 'It moves to the Proposal Tracker as Reviewing. No proposal number or folders are created yet.', Accepted: 'It gets the next proposal number, an estimator, and moves to the Proposal Tracker.', Started: 'Work on the estimate and proposal has started.', New: 'It goes back to Bid Opportunities.',
    Declined: 'It leaves Bid Opportunities and stays searchable.', Submitted: 'The result is cleared and follow-up resumes.', 'Decided Not To Submit': 'It leaves the Proposal and Submittal trackers and stays searchable.', Awarded: 'This creates the project in Job Costing with the lead, proposal and submittal details attached.', 'Not Awarded': 'The bid is recorded as not awarded and follow-up stops.',
    'No Communication': 'The GC never answered. Follow-up closes; the proposal and history are kept.' };
  const reopen = o.status === 'Submitted' && to === 'Started';
  const fields = [summary(o), h('p', { class: 'muted wide' }, reopen ? 'Reopen for revision: the next proposal PDF becomes a new bid version. Earlier versions are kept.' : WHAT[to] || ''),
    to === 'Awarded' && (o.gcs || []).length > 1 ? field(lbl('Which GC awarded the job?', true), f.awarded, 'wide') : '',
    to === 'Accepted' ? field(lbl('Estimator', true), f.est) : '', to === 'Accepted' && !o.due ? field(lbl('Bid due date', true), f.due) : '', reasons ? field(lbl('Reason', true), f.reason, 'wide') : '', field('Note', f.note, 'wide')].filter(Boolean);
  formModal(`${reopen ? 'Reopen for revision' : sname(to)} · ${o.name}`, fields, async () => {
    const body = { status: to, note: f.note.value }; if (reasons) body.reason = f.reason.value; if (to === 'Awarded' && (o.gcs || []).length > 1) body.awardedGc = f.awarded.value; if (to === 'Accepted') { body.estimatorId = f.est.value; if (!o.due) body.due = f.due.value; }
    const r = await api('POST', `/opportunities/${o.id}/status`, body);
    if (r.projectId) { location.hash = '#/projects/' + r.projectId; return; }
    if (r.proposalId) { setTimeout(() => acceptedModal(o, r), 0); location.hash = '#/estimating/proposals'; }
    render();
  }, to === 'Awarded' ? 'Award and create project' : reopen ? 'Reopen' : 'Confirm');
}
function acceptedModal(o, r) {
  const msg = h('div');
  modal(`Accepted · ${r.proposalId}`, h('div', {}, h('p', {}, 'This is the standard folder tree for the proposal:'), h('pre', { class: 'draft' }, r.folderPlan.root + '\n' + r.folderPlan.folders.map((x) => '  ' + x).join('\n')),
    C.hasFolderAccess() ? h('button', { type: 'button', onclick: guard(msg, oneAtATime(async () => { try { const where = await C.createProposalFolders(r.folderPlan); notice(msg, `Created in ${where}`, 'ok'); } catch (e) { throw folderError(e); } })) }, 'Create these folders on my computer…') : '', C.folderNote(), msg, h('p', { class: 'muted' }, 'Paste the OneDrive folder link on the opportunity (Edit) so it is one click away.')));
}

// ---------------------------------------------------------------- submitting: the proposal PDF is required, read, and checked by a person
async function submitModal(o, pre = null) {
  const op = await opts(); let fileId = pre?.fileId ?? null, rows = pre ? pre.rows.map((r) => ({ ...r })) : (o.tradePrices || []).map((p) => ({ tradeId: p.tradeId, amount: p.amount, hint: '' }));
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
    const copied = r.reused ? ' This PDF was already on the lead, so that copy is used.' : r.sharepoint ? ' It was also copied to the 02. Proposal folder in SharePoint.' : '';
    if (r.parsed) { rows = r.parsed.trades.map((t) => ({ tradeId: t.tradeId || '', amount: t.amount, hint: t.trade })); notice(info, `Read ${rows.length} trade${rows.length === 1 ? '' : 's'} from the PDF. Check every amount before saving.${copied}`, 'ok'); r.parsed.warnings.forEach((w) => info.append(h('div', { class: 'err' }, w))); }
    else { notice(info, r.aiError ? r.aiError : `The PDF is saved. Enter the trades and amounts below.${r.reused ? copied : ''}`, r.aiError ? 'err' : 'ok'); }
    redraw();
  });
  redraw();
  if (pre) { f.date.value = pre.date; f.method.value = pre.method; notice(info, `Using the same proposal PDF (${pre.fileName}) and prices as the lead for ${pre.fromGc}. Change the prices if ${o.gc}'s are different.`, 'ok'); }
  // a proposal written in the estimating chat is already saved on the lead: pick it instead of uploading it again, and its prices fill in
  const savedList = (o.files || []).filter((x) => x.kind === 'Proposal' && /\.pdf$/i.test(x.name) && !x.used && !x.removed).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const saved = h('select', {}, h('option', { value: '' }, 'Choose a saved proposal…'), savedList.map((x) => h('option', { value: x.id }, `${x.version ? `Version ${x.version} · ` : ''}${x.name}`)));
  saved.onchange = guard(info, async () => { if (!saved.value) return; const r = await api('GET', `/opportunity-files/${saved.value}/prices`); fileId = r.fileId; file.value = '';
    if (r.trades.length) rows = r.trades.map((t) => ({ tradeId: t.tradeId || '', amount: t.amount, hint: t.trade })); notice(info, `Using ${r.name}. ${r.trades.length ? 'Its prices were filled in below; check every amount before saving.' : 'It has no prices yet; enter the trades and amounts below.'}`, 'ok'); redraw(); });
  formModal(`Submit proposal · ${o.name}`, [summary(o), h('div', { class: 'wide' }, h('label', {}, lbl('Proposal PDF', true)), file, savedList.length ? h('div', { style: 'margin-top:.4rem' }, h('span', { class: 'muted', style: 'font-size:13px' }, 'Or one already on this lead: '), saved) : '', info), h('div', { class: 'wide' }, h('label', {}, lbl('Trades and amounts', true)), table, h('div', { class: 'row', style: 'justify-content:space-between;margin-top:.4rem' }, h('span', { class: 'muted' }, 'Proposal total'), total)),
    h('div', {}, h('label', {}, lbl('Date submitted', true)), f.date, state.user.role === 'Super Admin' && o.startDate ? h('div', { class: 'muted', style: 'font-size:12px' }, `As the owner you can enter a date before ${fmtDay(o.startDate)}, the day it was accepted here.`) : ''), field(lbl('How it was sent', true), f.method), field('Known project start (optional)', f.start), field('Note', f.note, 'wide')],
  async () => {
    if (!fileId) throw new Error('Upload the proposal PDF first.');
    if (rows.some((r) => !r.tradeId || !(Number(r.amount) > 0))) throw new Error('Every row needs a trade and an amount.');
    await api('POST', `/opportunities/${o.id}/submissions`, { fileId, date: f.date.value, method: f.method.value, plannedStart: f.start.value || null, noteText: f.note.value, prices: rows.map((r) => ({ tradeId: r.tradeId, amount: r.amount })) });
    // other leads that may be the same job (not joined on their own): ask before moving on
    let maybe = []; try { maybe = (await api('GET', `/opportunities/${o.id}/possible-matches`)).leads; } catch { /* the question is skipped */ }
    if (maybe.length) { const file = (o.files || []).find((x) => x.id === fileId); setTimeout(() => matchesModal(o, maybe, { fileId, fileName: file?.name || 'the proposal PDF', rows: rows.map((r) => ({ tradeId: r.tradeId, amount: r.amount, hint: '' })), date: f.date.value, method: f.method.value, fromGc: o.gc }), 0); return; }
    location.hash = '#/estimating/submittals'; render();
  }, 'Record submission');
}

// After a submission: leads that may be the same job (not joined on their own), with what can be done about each. The app is not sure,
// so it asks: join it in, submit the same proposal to that GC too, or say it is not the same job (then it is not asked again).
function matchesModal(o, leads, pre) {
  const err = h('div'), list = h('div'), done = () => { bg.remove(); location.hash = '#/estimating/submittals'; render(); };
  const card = (m) => { const el = h('div', { class: 'card', style: 'margin:.5rem 0;padding:.7rem .8rem' },
    h('div', {}, h('strong', {}, m.name), m.proposalId ? ` · ${m.proposalId}` : ''), sub([(m.gcs || [m.gc]).join(' · '), m.address || m.city, sname(m.status), m.due ? 'due ' + fmtDay(m.due) : ''].filter(Boolean).join(' · ')),
    h('p', { style: 'margin:.35rem 0' }, h('em', {}, m.why)),
    h('div', { class: 'row', style: 'gap:.4rem;flex-wrap:wrap' },
      m.canSubmit ? h('button', { class: 'primary small', onclick: guard(err, async () => { const c = await api('POST', `/opportunities/${m.id}/files/copy`, { fileId: pre.fileId }), lead = await api('GET', `/opportunities/${m.id}`); bg.remove(); submitModal(lead, { ...pre, fileId: c.fileId, fileName: c.name }); }) }, `Submit To ${m.gc} Too`)
        : ['New', 'Reviewing'].includes(m.status) ? h('a', { class: 'btn small', href: '#/estimating/' + m.id, onclick: () => bg.remove() }, 'Open It To Accept And Submit') : '',
      m.canMerge ? h('button', { class: 'small', onclick: guard(err, async () => { if (!confirm(`Join "${m.name}" (${m.gc}) into this lead? ${m.sameGc ? 'Same GC: it becomes one lead.' : 'Another GC: it is bundled in, and any of these GCs can award it.'} Its notes and files move here.`)) return; await api('POST', `/opportunities/${o.id}/merge`, { otherId: m.id }); el.replaceChildren(h('p', { class: 'muted', style: 'margin:0' }, `"${m.name}" was joined into this lead.`)); }) }, 'Same Job: Join It In') : '',
      h('button', { class: 'small', onclick: guard(err, async () => { await api('POST', `/opportunities/${o.id}/not-same`, { otherId: m.id }); el.remove(); if (!list.children.length) done(); }) }, 'Not The Same Job')),
    !m.canMerge && m.mergeNote ? sub(m.mergeNote) : ''); return el; };
  list.append(...leads.map(card));
  const bg = modal('Is This The Same Job?', h('div', {}, h('p', { class: 'muted', style: 'margin-top:0' }, `The proposal for ${o.name} (${o.gc}) is recorded. ${leads.length === 1 ? 'This lead looks' : 'These leads look'} like it could be the same job, but the app is not sure enough to join ${leads.length === 1 ? 'it' : 'them'} on its own.`), err, list,
    h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:.6rem' }, h('button', { type: 'button', class: 'primary', onclick: done }, 'Done'))));
}
// Joins another lead into this one: the likely matches first, or any lead found by the search.
async function mergeModal(o) {
  const err = h('div'), list = h('div'), box = h('input', { type: 'search', placeholder: 'Find the other lead: name, GC, city or P number', autocomplete: 'off', style: 'width:100%' });
  const join = (x) => guard(err, async () => { if (!confirm(`Join "${x.name}" (${x.gc}) into "${o.name}" (${o.gc})?\n\nThe same GC becomes one lead; another GC is bundled in. Its notes, files and messages move here. This lead is the one kept.`)) return; const r = await api('POST', `/opportunities/${o.id}/merge`, { otherId: x.id }); bg.remove(); notice(err, r.how === 'bundled' ? 'Bundled.' : 'Joined.', 'ok'); render(); });
  const table = (rows, why) => h('table', { class: 'nostack' }, h('tbody', {}, rows.map((x) => h('tr', {}, h('td', { style: 'white-space:normal' }, h('strong', {}, x.name), x.proposalId ? ` · ${x.proposalId}` : '', sub([(x.gcs || [x.gc]).join(' · '), x.city, x.statusLabel || sname(x.status)].filter(Boolean).join(' · ')), why && x.why ? sub(x.why) : '', x.mergeNote ? sub(x.mergeNote) : ''),
    h('td', {}, x.canMerge === false ? '' : h('button', { class: 'small primary', type: 'button', onclick: join(x) }, 'Join Into This Lead'))))));
  const sugg = (await api('GET', `/opportunities/${o.id}/possible-matches`)).leads;
  const showSugg = () => list.replaceChildren(sugg.length ? h('div', {}, h('label', {}, 'Leads that look like the same job'), table(sugg, true)) : h('p', { class: 'muted' }, 'No lead looks like the same job. Search for the other one.'));
  let tm = 0; box.oninput = () => { clearTimeout(tm); tm = setTimeout(guard(err, async () => { const t = box.value.trim(); if (!t) return showSugg(); const rows = (await api('GET', `/opportunities?tab=search&q=${encodeURIComponent(t)}`)).rows.filter((x) => x.id !== o.id); list.replaceChildren(rows.length ? table(rows.slice(0, 25), false) : h('p', { class: 'muted' }, 'Nothing matches.')); }), 300); };
  showSugg();
  const bg = modal(`Join Another Lead Into ${o.name}`, h('div', {}, h('p', { class: 'muted', style: 'margin-top:0' }, 'For two leads that are the same job but were not joined on their own. The one you open is kept; the other joins it. A lead that already has its own P number or submission has to be the one kept.'), box, err, list));
  setTimeout(() => box.focus(), 50);
}

// A status control used in every table: it lists only the moves that are allowed from here and opens the matching form.
function statusSelect(o, w) {
  const moves = o.next.filter((s) => !(s === 'Submitted' && !['Accepted', 'Started'].includes(o.status))), choices = [o.status, ...moves];
  const label = (s) => (s === 'Awarded' ? 'Awarded — Create Project in JC' : s === 'Started' && o.status === 'Submitted' ? 'Reopen for revision' : s === 'New' && o.status === 'Declined' ? 'Reopen as New' : sname(s));
  const sel = h('select', { 'aria-label': 'Status', disabled: !w || !moves.length ? true : null, onchange: (e) => { const v = e.target.value; sel.value = o.status; if (v !== o.status) statusModal(o, v).catch((er) => alert(er.message)); } }, choices.map((s) => h('option', { value: s }, label(s))));
  sel.value = o.status; return sel;
}

// ---------------------------------------------------------------- the page
let searchTimer = 0;
// where each list was scrolled to, so Close puts you back at the same row
const scrollAt = {}; let scrollHooked = false;
function restoreScroll() {
  if (!scrollHooked) { scrollHooked = true; addEventListener('scroll', () => { if (!state.estRestore && /^#\/estimating\/(bids|proposals|submittals|followups|insights)?$/.test(location.hash) || location.hash === '#/estimating') scrollAt[location.hash] = window.scrollY; }, { passive: true }); }
  if (state.estRestore) { const y = scrollAt[location.hash] || 0; setTimeout(() => { window.scrollTo(0, y); state.estRestore = false; }, 0); }
}
// called as the page is handed over: the cursor goes back into the search box after the results are redrawn
function afterDraw() { if (state.estSearchFocus) setTimeout(() => { const el = document.getElementById('est-search'); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } state.estSearchFocus = false; }, 0); }
const closeLead = () => { state.estRestore = true; location.hash = state.estBack || '#/estimating/bids'; };
// every lead that matches the search box, whatever its status
function searchResults(rows, term) {
  return h('div', { class: 'card' }, h('h2', {}, `Search: "${term}"`), h('p', { class: 'muted', style: 'margin-top:0' }, rows.length ? `${rows.length} lead${rows.length === 1 ? '' : 's'}, every status, declined ones too. Click a row to open it.` : 'Nothing matches. Try part of the name, the GC, the city or the proposal number.'),
    rows.length ? h('div', { class: 'scroll' }, h('table', { class: 'biglist' }, h('thead', {}, h('tr', {}, ['Proposal / Project', 'General Contractors', 'City', 'Bid Due', 'Status', 'Estimator'].map((t) => h('th', {}, t)))),
      h('tbody', {}, rows.map((o) => h('tr', { style: 'cursor:pointer', onclick: () => (location.hash = '#/estimating/' + o.id) }, h('td', { style: 'white-space:normal;min-width:220px' }, o.proposalId ? h('strong', {}, o.proposalId) : '', h('div', {}, o.name), o.client && o.client !== o.gc ? sub(o.client) : ''),
        h('td', { style: 'white-space:normal' }, (o.gcs || [o.gc]).join(' · ')), h('td', {}, o.city || ''), h('td', {}, o.due ? fmtDay(o.due) : '—'), h('td', {}, h('span', { class: 'pill' }, o.statusLabel || o.status)), h('td', {}, o.estimator || '—')))))) : '');
}
const TABS = [['bids', 'Bid Opportunities'], ['proposals', 'Proposal Tracker'], ['submittals', 'Submittal Tracker'], ['followups', 'Follow Ups'], ['insights', 'Insights']];
export async function estimatingView(arg, arg2) {
  if (arg && arg2 === 'chat') return estchat.estimateChatView(arg, canEstimate());   // Estimate With AI: its own page for one lead
  const tab = TABS.some(([t]) => t === arg) ? arg : 'bids', detailId = arg && !TABS.some(([t]) => t === arg) ? arg : null, err = h('div'), w = canEstimate();
  const search = state.estSearch || '';
  // results show while you type; the page is drawn again a moment after you stop, and the cursor stays in the box
  const sbox = h('input', { id: 'est-search', type: 'search', placeholder: 'Find a project, GC, client, contact or proposal #', value: search, autocomplete: 'off',
    oninput: (e) => { clearTimeout(searchTimer); const v = e.target.value; searchTimer = setTimeout(() => { state.estSearch = v; state.estSearchFocus = true; render(); }, 300); } });
  const scope = state.estScope || (['Super Admin', 'Sub Admin'].includes(state.user.role) ? 'all' : 'mine'), q = `q=${encodeURIComponent(search)}&scope=${scope}`;
  // a lead opened on its own: nothing else on the page; Close goes back to the list you came from, at the same place on it
  if (detailId) {
    const detail = await opportunityDetail(detailId, err, w, arg2 === 'edit');
    return C.shell('estimating', [h('div', { class: 'row spread' }, h('h1', {}, 'Estimating'), h('div', { class: 'row' }, sbox)), err, detail]);
  }
  state.estBack = location.hash && location.hash.startsWith('#/estimating') ? location.hash : '#/estimating/' + tab;
  if (search) {
    const found = await api('GET', `/opportunities?tab=search&q=${encodeURIComponent(search)}`); afterDraw();
    const stabs = h('div', { class: 'tabs', style: 'margin-top:1rem' }, TABS.map(([t, l]) => h('a', { href: '#/estimating/' + t, onclick: (e) => { e.preventDefault(); state.estSearch = ''; clearTimeout(searchTimer); if (location.hash === '#/estimating/' + t) render(); else location.hash = '#/estimating/' + t; } }, l)));
    return C.shell('estimating', [h('div', { class: 'row spread' }, h('h1', {}, 'Estimating'), h('div', { class: 'row' }, sbox, h('button', { onclick: () => { state.estSearch = ''; render(); } }, 'Clear'))), stabs, err, searchResults(found.rows, search)]);
  }
  const data = tab === 'bids' ? await api('GET', `/opportunities?tab=bids&${q}${state.estAll ? '&all=1' : ''}`)
    : tab === 'proposals' ? await api('GET', `/opportunities?tab=proposals&${q}&filter=${encodeURIComponent(state.propFilter || 'Active')}`)
    : tab === 'submittals' ? await api('GET', `/opportunities?tab=submittals&${q}`) : null;
  const st = data?.stats || (await api('GET', `/opportunities?tab=proposals&scope=${scope}`)).stats;
  const kpi = (l, v, tone = '') => h('div', { class: 'kpi ' + tone }, h('div', { class: 'l' }, l), h('div', { class: 'v' }, v));
  const scopeBar = h('div', { class: 'row spread', style: 'margin:.2rem 0' }, h('span', { class: 'muted', style: 'font-size:13px' }, scope === 'mine' ? 'Accepted, working, submitted, awarded and follow-up figures are yours. New and Reviewing are for the whole company.' : 'Showing the whole company.'), h('div', { class: 'seg' }, [['mine', 'Mine'], ['all', 'All']].map(([v, l]) => h('button', { type: 'button', class: v === scope ? 'on' : '', onclick: () => { state.estScope = v; render(); } }, l))));
  const head = h('div', { class: 'grid kpis', style: 'grid-template-columns:repeat(auto-fit,minmax(140px,1fr))' }, kpi('New opportunities', st.openLeads), kpi('Reviewing', st.reviewing), kpi('Accepted this month', st.accepted), kpi('Working now', st.working), kpi('Submitted this month', st.submitted), kpi('Awarded this month', st.awarded ?? 0, st.awarded ? 'good' : ''), kpi('Awarded in all', st.awardedAll ?? 0), kpi('Follow-ups due', st.awaitingFollowUp, st.awaitingFollowUp ? 'warn' : ''), kpi('Awaiting award', st.interested, st.interested ? 'good' : ''));
  const tabs = h('div', { class: 'tabs', style: 'margin-top:1rem' }, TABS.map(([t, l]) => h('a', { class: t === tab ? 'on' : '', href: '#/estimating/' + t, onclick: () => { state.estSearch = ''; clearTimeout(searchTimer); } }, l)));   // another tab: the search is cleared
  let body;
  if (tab === 'bids') body = bidsPanel(data, err, w, await api('GET', '/bids/status'), w ? (await api('GET', '/opportunities/bundles')).groups : []);
  else if (tab === 'proposals') body = proposalsPanel(data, err, w);
  else if (tab === 'submittals') body = submittalsPanel(data, err, w);
  else if (tab === 'followups') body = await followUpsPanel(err, w, arg === 'followups' ? arg2 : null);
  else body = await insightsTab(err);
  restoreScroll(); afterDraw();
  return C.shell('estimating', [h('div', { class: 'row spread' }, h('h1', {}, 'Estimating'), h('div', { class: 'row' }, sbox, h('button', { onclick: () => calendarModal().catch((e) => alert(e.message)), title: 'Put the bid due dates on your Outlook or Google calendar' }, 'Calendar'), w && h('button', { onclick: () => acceptSeveralModal().catch((e) => alert(e.message)), title: 'Paste a list of job names, find them (declined ones too), and accept them all for one estimator.' }, 'Accept Several'), w && h('button', { onclick: importForm }, 'Import leads'), w && h('button', { class: 'primary', onclick: () => opportunityForm(null).catch((e) => alert(e.message)) }, '+ Opportunity'))),
    h('p', { class: 'sub' }, 'Florida bid invitations to proposals to awarded projects. Reviewing and Accepted work moves to the Proposal Tracker; an award builds the project in Job Costing.'), scopeBar, head, tabs, err, body]);
}
async function importForm() {
  const conn = (await api('GET', '/estimating/connection')).buildingConnected; const csv = h('textarea', { rows: 8, placeholder: 'Paste the CSV here, or choose a file below. First row = headings (Project, GC / Company, City, State, Bid Due, …).' }), file = h('input', { type: 'file', accept: '.csv,text/csv' });
  file.onchange = async () => { if (file.files[0]) csv.value = await file.files[0].text(); };
  formModal('Import bid invitations', [h('p', { class: conn.connected ? 'ok wide' : 'muted wide' }, conn.note), field('CSV', csv, 'wide'), field('File', file, 'wide')],
    async () => { const r = await api('POST', '/opportunities/import', { csv: csv.value, source: 'BuildingConnected' }); if (r.added) render(); throw new Error(`Added ${r.added}, already had ${r.duplicates}, skipped ${r.skipped.length}.${r.skipped.length ? ' ' + r.skipped.slice(0, 4).join(' | ') : ''}`); }, 'Import');
}

// ---------------------------------------------------------------- one job under several GCs
function bundleModal(groups) {
  const err = h('div'), picks = groups.map((g) => ({ g, main: g.primaryId, on: new Set(g.leads.map((l) => l.id)) }));
  const draw = () => box.replaceChildren(...picks.map((p, gi) => h('div', { class: 'card', style: 'margin:.6rem 0' },
    h('strong', {}, p.g.leads[0].name), h('div', { class: 'muted', style: 'font-size:13px' }, [p.g.leads[0].address, p.g.leads[0].city].filter(Boolean).join(', ')),
    p.g.blocked ? h('p', { class: 'neg' }, p.g.blocked) : '',
    h('table', {}, h('thead', {}, h('tr', {}, ['Include', 'Main lead', 'GC', 'Project name', 'Bid due', 'Status', 'Proposal'].map((t) => h('th', {}, t)))), h('tbody', {}, p.g.leads.map((l) => h('tr', {},
      h('td', {}, h('input', { type: 'checkbox', checked: p.on.has(l.id) ? true : null, disabled: l.id === p.main ? true : null, onchange: (e) => { e.target.checked ? p.on.add(l.id) : p.on.delete(l.id); } })),
      h('td', {}, h('input', { type: 'radio', name: 'main' + gi, checked: l.id === p.main ? true : null, onchange: () => { p.main = l.id; p.on.add(l.id); draw(); } })),
      h('td', {}, h('strong', {}, l.gc)), h('td', {}, l.name), h('td', {}, l.due ? fmtDay(l.due) : '—'), h('td', {}, l.status), h('td', {}, l.proposalId ? `${l.proposalId}${l.submissions ? ' · submitted' : ''}` : '—'))))),
    h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:.5rem' }, h('button', { class: 'primary small', disabled: p.g.blocked ? true : null, onclick: guard(err, async () => {
      const others = [...p.on].filter((id) => id !== p.main); if (!others.length) throw new Error('Include at least one more lead to bundle.');
      await api('POST', '/opportunities/bundle', { primaryId: p.main, otherIds: others }); bg.remove(); render(); }) }, 'Bundle This Job')))));
  const box = h('div'); draw();
  const bg = modal('Bundle Jobs Under More Than One GC', h('div', {}, h('p', {}, 'These jobs came in more than once, from different GCs. Bundled, a job is one lead with one submission. Any of the GCs can award it, and we work with whichever does. Pick the main lead (it keeps the proposal number and the notes) and tick the ones to join it.'),
    h('p', { class: 'muted' }, FOLDERS_SAY), err, box), { mode: 'edit' });
}

// ---------------------------------------------------------------- bid due dates on your own calendar
// A private link your calendar app subscribes to once. It then shows every bid that is not submitted yet on its due date, and follows changes.
async function calendarModal() {
  let l = await api('GET', '/calendar/link'); const msg = h('div'), box = h('div');
  const row = (label, url) => h('div', { style: 'margin:.5rem 0' }, h('label', {}, label), h('div', { class: 'row', style: 'gap:.5rem;flex-wrap:nowrap' }, h('input', { value: url, readonly: true, onclick: (e) => e.target.select(), style: 'flex:1;min-width:0' }),
    h('button', { type: 'button', class: 'small', onclick: async (e) => { try { await navigator.clipboard.writeText(url); e.target.textContent = 'Copied'; setTimeout(() => (e.target.textContent = 'Copy'), 1500); } catch { notice(msg, 'Select the link and copy it.'); } } }, 'Copy')));
  const draw = () => box.replaceChildren(row('Every open bid', l.all), row('Only the bids I am the estimator on', l.mine));
  draw();
  const bg = modal('Bid Due Dates On Your Calendar', h('div', {},
    h('p', { class: 'muted' }, 'Copy one of these links and add it to your calendar once. Your calendar then shows each bid that is not submitted yet on its due date (at its due time when there is one), and updates by itself when a date changes here.'),
    box, msg,
    h('p', { style: 'margin:.8rem 0 .2rem' }, h('strong', {}, 'Outlook: '), 'Calendar, Add calendar, Subscribe from web, paste the link, Import.'),
    h('p', { style: 'margin:.2rem 0' }, h('strong', {}, 'Google Calendar: '), 'on a computer, the + next to Other calendars, From URL, paste the link, Add calendar.'),
    h('p', { class: 'muted', style: 'font-size:13px' }, 'Calendars re-read the link on their own schedule: Outlook every few hours, Google Calendar about once a day. The link is private to you: anyone who has it can see the bid list, so do not forward it. Reset makes a new link and switches the old one off.'),
    h('div', { class: 'row', style: 'justify-content:flex-end;gap:.5rem;margin-top:.8rem' }, h('button', { type: 'button', onclick: guard(msg, async () => { if (!confirm('Make a new link? Calendars using the old link stop updating until you add the new one.')) return; l = await api('POST', '/calendar/link/reset', {}); draw(); notice(msg, 'New links made. The old ones no longer work.', 'ok'); }) }, 'Reset The Link'),
      h('button', { type: 'button', class: 'primary', onclick: () => bg.remove() }, 'Close'))), { mode: 'edit' });
}

// ---------------------------------------------------------------- accept several leads at once, for one estimator
// Paste the job names, see what each one matched (every lead is searched, declined ones too), then accept the ticked ones. Each lead goes
// through the same steps as by hand: a declined one is reopened first, accepting gives it its P number and its folder, and one that is
// already accepted only changes estimator. Everything is written in each lead's log.
async function acceptSeveralModal() {
  const op = await opts(), msg = h('div'), box = h('div'), ta = h('textarea', { rows: 10, style: 'width:100%', placeholder: 'One job on each line, for example:\nNew Balance - Orlando, FL\nVerano - Lithia, FL (November 20th)' });
  const est = h('select', {}, h('option', { value: '' }, 'Choose the estimator…'), op.estimators.map((u) => h('option', { value: u.id }, u.name || u.email)));
  let found = null; const chosen = new Map();
  const draw = () => box.replaceChildren(...(found ? [h('table', {}, h('thead', {}, h('tr', {}, ['Pasted', 'Lead found', 'Now', 'Bid due', 'Result'].map((t) => h('th', {}, t)))), h('tbody', {}, found.map((l, i) => {
    const c = chosen.get(i), m = l.matches.find((x) => x.id === c?.id), pick = h('select', { onchange: (e) => { chosen.set(i, { id: e.target.value || null, result: '' }); draw(); } }, h('option', { value: '' }, l.matches.length ? 'Leave this one out' : 'Not found'), l.matches.map((x) => h('option', { value: x.id }, `${x.proposalId ? x.proposalId + ' · ' : ''}${x.name} · ${x.gc || ''} · ${x.city || ''}`))); pick.value = c?.id || '';
    return h('tr', {}, h('td', { style: 'white-space:normal;max-width:240px' }, l.line), h('td', { style: 'white-space:normal' }, l.matches.length ? pick : h('span', { class: 'neg' }, 'Not found. Add it with + Opportunity.')), h('td', {}, m ? `${m.statusLabel}${m.estimator ? ' · ' + m.estimator : ''}` : ''), h('td', {}, m ? (m.due ? fmtDay(m.due) : l.due ? `${fmtDay(l.due)} (from your list)` : h('span', { class: 'neg' }, 'none')) : ''), h('td', { style: 'white-space:normal' }, c?.result ? h('span', { class: c.bad ? 'neg' : 'pos' }, c.result) : '')); }))),
    h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:.8rem;gap:.5rem' }, h('button', { type: 'button', onclick: () => { bg.remove(); render(); } }, 'Close'), h('button', { type: 'button', class: 'primary', onclick: run }, `Accept And Assign (${[...chosen.values()].filter((c) => c.id && !c.done).length})`))] : []));
  const find = guard(msg, async () => { notice(msg, ''); const r = await api('POST', '/opportunities/find-several', { text: ta.value }); found = r.lines; chosen.clear(); found.forEach((l, i) => chosen.set(i, { id: l.pick, result: '' })); draw(); });
  const run = guard(msg, async () => {
    if (!est.value) throw new Error('Choose the estimator first.');
    for (const [i, c] of chosen) {
      if (!c.id || c.done) continue; const l = found[i], m = l.matches.find((x) => x.id === c.id); c.result = 'Working…'; c.bad = false; draw();
      try {
        if (['Submitted', 'Awarded', 'Not Awarded', 'No Communication'].includes(m.status)) { c.result = `Left as it is: already ${m.statusLabel}.`; c.done = true; continue; }
        if (m.status === 'Declined') await api('POST', `/opportunities/${m.id}/status`, { status: 'New' });
        if (['Accepted', 'Started'].includes(m.status)) { if (m.estimatorId !== est.value) await api('PUT', `/opportunities/${m.id}`, { estimatorId: est.value }); c.result = `Already ${m.statusLabel}${m.proposalId ? ' (' + m.proposalId + ')' : ''}. Estimator set.`; }
        else { const r = await api('POST', `/opportunities/${m.id}/status`, { status: 'Accepted', estimatorId: est.value, ...(m.due || !l.due ? {} : { due: l.due }) }); c.result = `Accepted${r.proposalId ? ' as ' + r.proposalId : ''}.`; }
        c.done = true;
      } catch (e) { c.result = e.message; c.bad = true; }
    }
    draw(); notice(msg, 'Done. Check the Result column; anything in red was not changed.', 'ok');
  });
  const bg = modal('Accept Several Leads', h('div', {}, h('p', { class: 'muted' }, 'Paste the job names, one on each line. Every lead is searched, including declined ones. You see what each line matched before anything changes.'),
    ta, h('div', { class: 'row', style: 'gap:.6rem;flex-wrap:wrap;margin:.6rem 0;align-items:flex-end' }, h('div', { style: 'min-width:14rem' }, h('label', {}, 'Assign to'), est), h('button', { type: 'button', class: 'primary', onclick: find }, 'Find These Leads')), msg, h('div', { class: 'scroll' }, box)), { mode: 'edit' });
}

// ---------------------------------------------------------------- Bid Opportunities
const BID_RULES = (r) => `One list of NEW opportunities, ordered by week, then closeness to Orlando, then shopping centers, then Retail, Restaurant, and Medical / Office. Weeks run Monday–Sunday: a bid due ON a Monday goes in the prior week. Undated leads stay visible. A New lead is declined ${r.declineNewDays} days after its bid due date, after 7 working days if nobody takes it up, and a Tier 3 or 4 lead is declined when its week is over; every change is written in the lead's log. The Include Declined box lists leads declined in the last 30 days; the search box finds a declined lead of any age. The same job from the same GC that arrives twice is combined into one lead. Reviewing and Accepted opportunities move to the Proposal Tracker.`;
function bidFeedBar(feed, err, w) {
  const bar = h('div', { class: 'card', style: 'padding:.7rem 1rem' }); const refresh = guard(err, async () => { await api('POST', '/bids/refresh', {}); render(); });
  const connect = h('button', { class: 'primary small', onclick: guard(err, async () => { location.href = (await api('GET', '/gmail/connect')).url; }) }, feed.expectedEmail ? 'Reconnect Gmail' : 'Connect Gmail');
  if (feed.needsReconnect) {
    bar.style.borderColor = 'var(--red)';
    bar.append(h('div', { class: 'row spread', style: 'gap:.6rem;flex-wrap:wrap' }, h('div', {}, h('strong', { class: 'neg' }, feed.connected ? 'The Gmail feed has lost its connection. No new bid invitations are coming in.' : 'The Gmail feed is not connected. No new bid invitations are coming in.'),
      h('div', { class: 'muted', style: 'font-size:13px' }, feed.googleSetUp ? (feed.expectedEmail ? `Press Reconnect Gmail and sign in to Google as ${feed.expectedEmail}.` : 'Press Connect Gmail and sign in with the mailbox that receives the bid invitations.') : 'Google is not set up on the server yet (see Admin).')),
      w && feed.googleSetUp ? connect : ''));
    return bar;
  }
  const l = feed.last, ok = feed.lastGood;
  bar.append(h('div', { class: 'row spread' }, h('div', {}, feed.running ? h('strong', {}, 'Refreshing from Gmail…') : l?.status === 'Error' ? h('span', { class: 'neg' }, `Last refresh failed: ${l.error}`) : ok ? h('span', {}, 'Last refreshed ', h('strong', {}, when(ok.finished_at)), ` · ${ok.added} new, ${ok.updated} updated${ok.declined ? `, ${ok.declined} declined` : ''}${ok.skipped ? `, ${ok.skipped} outside Florida skipped` : ''}`) : 'Not refreshed yet.', h('span', { class: 'muted', style: 'margin-left:.6rem;font-size:13px' }, `Automatic at 8:00 AM and 1:00 PM · ${feed.email}`)), w ? h('button', { class: 'primary', disabled: feed.running ? true : null, onclick: refresh }, feed.running ? 'Refreshing…' : 'Refresh now') : ''));
  if (feed.running) setTimeout(() => { if (location.hash.startsWith('#/estimating')) render(); }, 2500);
  return bar;
}
const weekLabel = (n) => (n.startsWith('Week Of ') ? fmtDay(n.slice(8)) : n === 'Due This Week — Too Tight To Bid' ? 'This week — too tight to bid' : n === 'Missed / Past Due' ? 'Missed / past due' : n === 'No Bid Due Date Provided' ? 'No bid due date provided' : n);
const BID_COLS = [['week', 'Week Of'], ['project', 'Project / Location'], ['gc', 'General Contractors / Contact'], ['due', 'Bid Due'], ['status', 'Status'], ['invitation', 'Invitation']];
function inviteCell(o) {
  const inv = (o.invitations || []).filter((i) => i.link), list = inv.length ? inv : o.link ? [{ gc: o.gc, link: o.link }] : [];
  return h('td', { style: 'white-space:nowrap' }, list.length ? list.map((i) => h('div', {}, h('a', { href: i.link, target: '_blank', rel: 'noopener', title: `Open the ${i.gc} invitation on BuildingConnected` }, list.length > 1 ? `View · ${i.gc.split(/[ ,]/)[0]}` : 'View Invitation'))) : '—', o.emailLink ? h('div', {}, h('a', { href: o.emailLink, target: '_blank', rel: 'noopener', class: 'muted', style: 'font-size:13px' }, 'Email')) : '');
}
const contactBlock = (o) => { const nda = (o.invitations || []).some((i) => i.nda) && !o.email;
  return [h('strong', {}, o.gc), o.additionalGcs ? sub('Also: ' + o.additionalGcs) : '', o.contact ? sub(o.contact) : '', o.email ? h('div', {}, h('a', { href: 'mailto:' + o.email, style: 'font-size:13px' }, o.email)) : '', o.phone ? sub(o.phone) : '', nda ? h('div', { class: 'neg', style: 'font-size:13px' }, 'Contact is locked behind an NDA') : (!o.contact && !o.email && !o.phone ? sub('No contact on file') : '')]; };
// No due date on the invitation: the AI looks for it after every Gmail refresh; Find It asks it to look right now.
const findDue = (o, btn) => async () => { btn.disabled = true; btn.textContent = 'Looking…'; try { const r = await api('POST', `/opportunities/${o.id}/find-due`); alert(r.message); if (r.found) render(); } catch (e) { alert(e.message); } finally { btn.disabled = false; btn.textContent = 'Find It'; } };
const dueCell = (o) => { const btn = h('button', { class: 'small', type: 'button', title: 'The AI reads the invitation email and page for the bid due date' }, 'Find It'); btn.onclick = findDue(o, btn);
  return h('td', {}, o.due ? [fmtDay(o.due), o.dueTime ? sub(`${o.dueTime} Eastern`) : sub(o.countdown)] : [h('strong', { class: 'neg', style: 'font-size:13px' }, 'NO BID DUE DATE PROVIDED'), (o.invitations || []).some((i) => i.nda) ? sub('May be locked behind an NDA') : '', h('div', { style: 'margin-top:.25rem' }, btn)]); };
function bidsPanel(data, err, w, feed, dups = []) {
  const rows = data.groups.flatMap((g) => g.rows.map((o) => ({ ...o, week: g.name }))); rows.forEach((o, i) => (o.rank = i));
  const sort = state.bidSort || { key: 'week', dir: 1 };
  const keyOf = { week: (o) => o.rank, project: (o) => o.name.toLowerCase(), gc: (o) => o.gc.toLowerCase(), due: (o) => o.due || '9999', status: (o) => o.status, invitation: (o) => (o.link || (o.invitations || []).some((i) => i.link) ? 0 : 1), onedrive: (o) => (o.folderUrl ? 0 : 1) }[sort.key];
  rows.sort((a, b) => { const x = keyOf(a), y = keyOf(b); return (x < y ? -1 : x > y ? 1 : a.rank - b.rank) * sort.dir; });
  const head = BID_COLS.map(([k, l]) => h('th', {}, h('button', { class: 'sortbtn', onclick: () => { state.bidSort = { key: k, dir: sort.key === k ? -sort.dir : 1 }; render(); } }, l, h('span', { class: sort.key === k ? 'on' : '' }, sort.key === k ? (sort.dir === 1 ? ' ↑' : ' ↓') : ' ↕'))));
  const tip = BID_RULES(data.rules || { declineNewDays: 2 });
  const banner = dups.length ? h('div', { class: 'card', style: 'padding:.7rem 1rem;border-color:var(--navy)' }, h('div', { class: 'row spread' }, h('span', {}, h('strong', {}, `${dups.length} ${dups.length === 1 ? 'job appears' : 'jobs appear'} under more than one GC.`), ' Bundle them so each job is one lead and one submission.'), h('button', { class: 'primary small', onclick: () => bundleModal(dups) }, 'Review And Bundle'))) : '';
  return h('div', {}, bidFeedBar(feed, err, w), banner,
    h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', {}, 'Bid Opportunities'), h('div', { class: 'row' }, h('label', { style: 'text-transform:none;letter-spacing:0;font-size:14px;font-weight:400;margin:0' }, h('input', { type: 'checkbox', checked: state.estAll ? true : null, onchange: (e) => { state.estAll = e.target.checked; render(); } }), ' Include declined (last 30 days)'), h('span', { class: 'info-tip', tabindex: '0', 'aria-label': tip, 'data-tip': tip }, 'i'))),
      rows.length ? h('div', { class: 'scroll' }, h('table', { class: 'biglist' }, h('thead', {}, h('tr', {}, ...head, h('th', {}, 'Actions'))),
        h('tbody', {}, rows.map((o) => h('tr', { class: o.status === 'Declined' ? 'muted' : '' },
          h('td', {}, h('div', {}, weekLabel(o.week)), sub(o.tier === 0 ? 'Tier 0 · Awarded' : `Tier ${o.tier}`, o.tierNote || '')),
          h('td', { style: 'white-space:normal;min-width:240px' }, h('strong', {}, o.name), o.client && o.client !== o.gc ? sub('Client: ' + o.client) : '', sub([addrLine(o), o.mall ? 'Shopping center' : '', o.type, o.sourceType].filter(Boolean).join(' · '))),
          h('td', { style: 'white-space:normal;min-width:200px' }, contactBlock(o)), dueCell(o),
          h('td', {}, statusSelect(o, w), o.autoDeclined ? sub('Auto-declined') : o.declinedReason ? sub(o.declinedReason) : ''),
          inviteCell(o),
          h('td', {}, h('div', { class: 'stack' }, h('button', { class: 'small', onclick: () => (location.hash = '#/estimating/' + o.id) }, 'Open'), w ? h('button', { class: 'small', onclick: () => (location.hash = `#/estimating/${o.id}/edit`) }, 'Edit') : ''))))))) : h('p', { class: 'muted', style: 'padding:1rem 0' }, feed.connected ? 'No new opportunities. They appear after the next refresh (8:00 AM and 1:00 PM), or press Refresh now.' : 'No opportunities yet. Connect Gmail in Admin, or add one with + Opportunity.')));
}

// ---------------------------------------------------------------- Proposal Tracker
const tradeList = (o) => (o.tradePrices.length ? h('div', {}, o.tradePrices.map((p) => h('div', { style: 'font-size:13px;white-space:nowrap' }, `${p.name} ${usd(p.amount)}`)), h('strong', { style: 'font-size:13px' }, usd(o.total))) : o.consideredTrades.length ? sub('Considering: ' + o.consideredTrades.map((t) => t.name).join(', ')) : sub('—'));
function filterChips(list, current, counts, onPick) { return h('div', { class: 'filters' }, list.map((k) => h('button', { type: 'button', class: 'chip' + (k === current ? ' on' : ''), onclick: () => onPick(k) }, `${k === 'Decided Not To Submit' ? 'Decided Not To Submit' : k}${counts?.[k] != null ? ' ' + counts[k] : ''}`))); }
const LEGEND = h('p', { class: 'muted', style: 'font-size:13px;margin:.2rem 0 .6rem' }, h('span', { class: 'swatch green' }), ' submitted  ', h('span', { class: 'swatch yellow' }), ' started, time left  ', h('span', { class: 'swatch red' }), ' due today or past due, not submitted');
function proposalsPanel(data, err, w) {
  const open = (o) => (location.hash = '#/estimating/' + o.id);
  const filters = ['Active', 'Reviewing', 'Accepted', 'Started', 'Submitted', 'Decided Not To Submit', 'All'];
  return h('div', { class: 'card' }, h('h2', {}, 'Proposal Tracker'), filterChips(filters, data.filter, data.counts, (k) => { state.propFilter = k; render(); }), LEGEND,
    data.rows.length ? h('div', { class: 'scroll' }, h('table', { class: 'biglist' }, h('thead', {}, h('tr', {}, ['Proposal / Project', 'General Contractors', 'Estimator / Scope', 'Due', 'Status', 'Proposed Price By Trade', 'Invitation', 'Plans', 'Actions'].map((t) => h('th', {}, t)))),
      h('tbody', {}, data.rows.map((o) => h('tr', { class: 'tone-' + (o.tone || 'none') },
        h('td', { style: 'white-space:normal;min-width:220px' }, o.proposalId ? h('strong', {}, o.proposalId) : pill('Reviewing'), h('div', { class: 'edit', onclick: () => open(o) }, o.name), sub(addrLine(o)), o.expiry === 'expiring' ? h('div', { class: 'neg', style: 'font-size:12px;font-weight:600' }, 'Lead is expiring') : ''),
        h('td', { style: 'white-space:normal;min-width:180px' }, contactBlock(o)), h('td', { style: 'white-space:normal' }, o.estimator || '—', o.consideredTrades.length ? sub(o.consideredTrades.map((t) => t.name).join(', ')) : ''),
        h('td', {}, fmtDay(o.due), sub(o.countdown)), h('td', {}, statusSelect(o, w)), h('td', {}, tradeList(o)),
        inviteCell(o), h('td', {}, h('div', { class: 'stack' }, o.spPath ? openPlansButton(o) : h('span', { class: 'muted' }, '—'))),
        h('td', {}, h('div', { class: 'stack' }, w && ['Accepted', 'Started'].includes(o.status) ? h('button', { class: 'small primary', onclick: () => submitModal(o) }, 'Submit') : '', w && o.tone === 'red' ? h('button', { class: 'small danger', title: 'The due date has arrived and nothing was submitted: submit it, or say why not', onclick: () => statusModal(o, 'Decided Not To Submit').catch((e) => alert(e.message)) }, 'Decide now') : '', w ? h('button', { class: 'small', onclick: () => (location.hash = `#/estimating/${o.id}/edit`) }, 'Edit') : ''))))))) : h('p', { class: 'muted', style: 'padding:1rem 0' }, 'Nothing here yet. Mark a New opportunity Reviewing or Accepted from Bid Opportunities.'));
}

// ---------------------------------------------------------------- Submittal Tracker (list and calendar)
function submittalsPanel(data, err, w) {
  const view = state.subView || 'list', filter = state.subFilter || 'All';
  const FIL = { All: () => true, 'Not Submitted': (o) => ['Accepted', 'Started'].includes(o.status), Submitted: (o) => ['Submitted', 'Awarded', 'Not Awarded', 'No Communication'].includes(o.status) /* every bid that was sent, whatever came of it */, Awarded: (o) => o.status === 'Awarded', 'Not Awarded': (o) => o.status === 'Not Awarded', 'No Communication': (o) => o.status === 'No Communication' };
  const rows = data.rows.filter(FIL[filter]), counts = Object.fromEntries(Object.entries(FIL).map(([k, f]) => [k, data.rows.filter(f).length]));
  const toggle = h('div', { class: 'seg' }, ['list', 'calendar'].map((v) => h('button', { type: 'button', class: v === view ? 'on' : '', onclick: () => { state.subView = v; render(); } }, v === 'list' ? 'List' : 'Calendar')));
  return h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', {}, 'Submittal Tracker'), toggle), filterChips(Object.keys(FIL), filter, counts, (k) => { state.subFilter = k; render(); }), LEGEND, tradeTally(data.rows), view === 'calendar' ? calendar(rows) : submittalList(rows, w));
}
// What is out with GCs right now, by trade: how many bids and how much, and the total across all trades.
// This month's submissions by trade (it starts again on the 1st); closed until it is opened.
function tradeTally(all) {
  const month = todayStr().slice(0, 7), label = new Date(month + '-15T12:00:00').toLocaleDateString('en-US', { month: 'long' });
  const subs = all.flatMap((o) => (o.submissions || []).filter((s) => String(s.date).startsWith(month)).map((s) => ({ o, s })));
  const by = new Map(); let total = 0; for (const { s } of subs) for (const t of s.trades || []) { const e = by.get(t.name) || { bids: 0, amount: 0 }; e.bids++; e.amount += Number(t.amount); by.set(t.name, e); total += Number(t.amount); }
  const waiting = subs.filter(({ o }) => o.status === 'Submitted').length;
  if (!subs.length) return h('p', { class: 'muted', style: 'margin:.2rem 0 .8rem' }, `Nothing submitted in ${label} yet.`);
  return h('details', { style: 'margin:.2rem 0 .8rem' }, h('summary', { style: 'cursor:pointer;font-weight:600' }, `Submitted in ${label}: ${subs.length} bid${subs.length === 1 ? '' : 's'}, ${usd(total)} · ${waiting} still waiting for an answer`),
    h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Trade'), h('th', { class: 'n' }, 'Bids'), h('th', { class: 'n' }, 'Total'))), h('tbody', {}, [...by].sort((a, b) => b[1].amount - a[1].amount).map(([n, e]) => h('tr', {}, h('td', {}, n), h('td', { class: 'n' }, e.bids), h('td', { class: 'n' }, usd(e.amount))))), h('tfoot', {}, h('tr', { class: 'total' }, h('td', {}, 'All trades'), h('td', { class: 'n' }, [...by.values()].reduce((n, e) => n + e.bids, 0)), h('td', { class: 'n' }, usd(total))))));
}
// The latest proposal PDF of a lead (one per GC when the job keeps a folder under each GC). The one the app holds shows at once; the
// library is then asked, a few leads at a time, and the answer is kept for a minute so redrawing the page does not ask again.
const pdfSeen = new Map(), pdfQueue = []; let pdfBusy = 0;
const pdfPump = () => { while (pdfBusy < 4 && pdfQueue.length) { const job = pdfQueue.shift(); pdfBusy++; job().finally(() => { pdfBusy--; pdfPump(); }); } };
const latestPdfs = (o) => { const hit = pdfSeen.get(o.id); if (hit && Date.now() - hit.at < 60000) return hit.p;
  const p = new Promise((ok, no) => { pdfQueue.push(() => api('GET', `/opportunities/${o.id}/latest-pdfs`).then(ok, no)); pdfPump(); }); pdfSeen.set(o.id, { at: Date.now(), p }); p.catch(() => pdfSeen.delete(o.id)); return p; };
function latestPdfBox(o, { small = false } = {}) {
  const size = small ? '12px' : '13px', box = h('div', { style: `font-size:${size};white-space:normal;overflow-wrap:anywhere` });
  const a = (f, text) => h('a', { href: f.href, target: '_blank', rel: 'noopener', title: f.name, onclick: (e) => e.stopPropagation() }, text || f.name);
  const mine = o.files.filter((f) => f.kind === 'Proposal' && !f.removed && /\.pdf$/i.test(f.name)).sort((x, y) => String(y.at).localeCompare(String(x.at)))[0];
  const draw = (list, note, perGc) => box.replaceChildren(...(list.length ? list.map((f) => h('div', {}, perGc || list.length > 1 ? [h('strong', {}, f.gc + ': '), a(f, small ? 'Latest PDF' : null)] : a(f, small ? 'Latest PDF' : null))) : [small ? '' : h('span', { class: 'muted' }, 'No proposal PDF yet')]), note ? h('div', { class: 'neg' }, note) : '');
  draw(mine ? [{ gc: o.gc, name: mine.name, href: mine.local === false ? mine.spUrl : '/api/opportunity-files/' + mine.id }].filter((f) => f.href) : []);
  if (o.spPath) latestPdfs(o).then((r) => { if (r.pdfs.length || !r.error) draw(r.pdfs, r.error ? 'SharePoint could not be read: ' + r.error : '', r.perGc); }).catch(() => {});
  return box;
}
function submittalList(rows, w) {
  if (!rows.length) return h('p', { class: 'muted', style: 'padding:1rem 0' }, 'Nothing here. Accepted and Started work appears here until it is submitted.');
  return h('div', { class: 'scroll' }, h('table', { class: 'biglist' }, h('thead', {}, h('tr', {}, ['Proposal / Project', 'General Contractors', 'Due', 'Submitted', 'Price By Trade', 'Status', 'Latest Proposal PDF', 'Actions'].map((t) => h('th', {}, t)))),
    h('tbody', {}, rows.map((o) => { const s = o.lastSubmission; return h('tr', { class: 'tone-' + (o.tone || 'none') }, h('td', { style: 'white-space:normal;min-width:200px' }, h('strong', {}, o.proposalId || ''), h('div', { class: 'edit', onclick: () => (location.hash = '#/estimating/' + o.id) }, o.name), sub(addrLine(o))),
      h('td', { style: 'white-space:normal' }, o.gc, o.contact ? sub(o.contact) : ''), h('td', {}, fmtDay(o.due)), h('td', {}, s ? [fmtDay(s.date), sub(`Version ${s.version} · ${s.method}`)] : h('span', { class: 'muted' }, 'Not yet')), h('td', {}, tradeList(o)), h('td', {}, statusSelect(o, w)),
      h('td', { style: 'min-width:220px;max-width:340px' }, latestPdfBox(o)),
      h('td', {}, h('div', { class: 'stack' }, w && ['Accepted', 'Started'].includes(o.status) ? h('button', { class: 'small primary', onclick: () => submitModal(o) }, 'Submit') : '', s ? h('button', { class: 'small', onclick: () => (location.hash = '#/estimating/followups/' + o.id) }, 'Follow up') : '', h('button', { class: 'small', onclick: () => (location.hash = '#/estimating/' + o.id) }, 'Open'))));
    }))));
}
function calEvent(o) {
  const s = o.lastSubmission, open = () => (location.hash = '#/estimating/' + o.id);
  if (!s) return h('button', { type: 'button', class: 'ev due', title: 'Bid due', onclick: open }, h('strong', {}, 'Due'), h('div', {}, o.name));
  const trades = s.trades || [], total = s.price ?? trades.reduce((n, t) => n + Number(t.amount || 0), 0);
  return h('div', { class: 'ev sub', title: `Submitted ${s.date}; original due ${o.due || 'unknown'}` },
    h('div', { class: 'ev-head', role: 'button', tabindex: 0, onclick: open, onkeydown: (e) => { if (e.key === 'Enter') open(); } }, h('strong', {}, `Submitted V${s.version}`), h('div', {}, o.name), h('div', { class: 'muted' }, o.gcs?.length > 1 ? o.gcs.join(' · ') : o.gc), o.due ? h('div', { class: 'muted' }, 'Due ' + fmtDay(o.due)) : ''),
    trades.length || total ? h('div', { class: 'ev-sum' }, trades.map((t) => h('div', { class: 'row spread' }, h('span', {}, t.name), h('span', {}, usd(t.amount)))), h('div', { class: 'row spread ev-total' }, h('span', {}, 'Total'), h('span', {}, usd(total)))) : '',
    latestPdfBox(o, { small: true }));
}
function calendar(rows) {
  const month = state.subMonth || todayStr().slice(0, 7), [y, m] = month.split('-').map(Number), first = new Date(y, m - 1, 1), days = new Date(y, m, 0).getDate(), pad = (first.getDay() + 6) % 7, today = todayStr();
  const nav = (d) => { const x = new Date(y, m - 1 + d, 1); state.subMonth = `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`; render(); };
  const by = {}; for (const o of rows) if (o.calendarDate) (by[o.calendarDate] ||= []).push(o);
  const cells = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => h('div', { class: 'dow' }, d));
  for (let i = 0; i < pad; i++) cells.push(h('div', { class: 'day off' }));
  for (let d = 1; d <= days; d++) { const key = `${month}-${String(d).padStart(2, '0')}`; cells.push(h('div', { class: 'day' + (key === today ? ' today' : '') }, h('div', { class: 'muted' }, d), (by[key] || []).map(calEvent))); }
  return h('div', {}, h('div', { class: 'row spread', style: 'margin-bottom:.6rem' }, h('button', { class: 'small', onclick: () => nav(-1) }, '← Previous'), h('strong', {}, first.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })), h('button', { class: 'small', onclick: () => nav(1) }, 'Next →')), h('div', { class: 'cal' }, cells),
    h('p', { class: 'muted', style: 'font-size:13px' }, 'Submitted bids sit on the day they were actually sent, with the original due date shown. Bids not yet sent sit on their due date.'));
}

// ---------------------------------------------------------------- one opportunity: Open and Edit share one layout
function bundleSection(o, w, msg) {
  const awarded = o.status === 'Awarded';
  return h('div', { class: 'card', style: 'margin-top:.8rem;padding:.7rem 1rem' }, h('label', {}, 'Pitched to more than one GC'),
    h('p', { style: 'margin:.2rem 0' }, o.gcs.join(' · '), '. One job and one submission. ', awarded ? '' : 'Any of these GCs can award it.'), h('p', { class: 'muted', style: 'margin:.2rem 0;font-size:14px' }, FOLDERS_SAY),
    w && !awarded ? h('div', { class: 'row', style: 'gap:.5rem;flex-wrap:wrap;margin-top:.4rem' },
      (o.bundled || []).map((x) => h('button', { class: 'small', title: `Make ${x.gc} its own lead again`, onclick: guard(msg, async () => { if (!confirm(`Take ${x.gc} out of this bundle and make it its own lead again?`)) return; await api('POST', `/opportunities/${x.id}/unbundle`, {}); render(); }) }, `Split Out ${x.gc}`)),
      // a GC whose invitation email was joined to this lead (it never had a lead of its own): taken off when it is a different job
      o.gcs.slice(1).filter((g) => !(o.bundled || []).some((x) => x.gc.toLowerCase() === g.toLowerCase())).map((g) => h('button', { class: 'small', title: `${g}'s invitation is a different job: take it off this lead`, onclick: guard(msg, async () => {
        if (!confirm(`Take ${g}'s invitation off this lead?\n\nUse this when it is a different job (another store at the same mall, for example). Its email is read again on the next refresh and becomes a lead of its own.`)) return;
        const r = await api('POST', `/opportunities/${o.id}/invitations/remove`, { gc: g }); render(); if (r.reread) setTimeout(() => alert(`${g} is off this lead. Press Refresh Now on Bid Opportunities to bring its invitation in as its own lead.`), 50); }) }, `Not This Job: ${g}`))) : '');
}
async function opportunityDetail(id, err, w, editing) {
  const o = await api('GET', '/opportunities/' + id), op = await opts(), known = await api('GET', '/gcs/known');
  const built = buildOpportunityForm(o, op, known, { readonly: !editing }), msg = h('div');
  const save = guard(msg, async () => { await api('PUT', '/opportunities/' + id, built.body()); location.hash = '#/estimating/' + id; render(); });
  return h('div', { class: 'card', style: 'border-color:var(--navy)' }, h('div', { class: 'row spread' }, h('h2', {}, `${o.proposalId ? o.proposalId + ' · ' : ''}${o.name}`), h('div', { class: 'row', style: 'gap:.6rem;align-items:center' }, w && !o.mergedInto && !o.projectId ? h('button', { class: 'small', type: 'button', title: 'Two leads for the same job that were not joined on their own', onclick: () => mergeModal(o).catch((e) => alert(e.message)) }, 'Join Another Lead') : '', h('a', { href: state.estBack || '#/estimating/' + (['New', 'Declined'].includes(o.status) ? 'bids' : o.lastSubmission ? 'submittals' : 'proposals'), onclick: (e) => { e.preventDefault(); closeLead(); } }, 'Close'))),
    h('div', { class: 'row', style: 'margin:.3rem 0 .8rem;flex-wrap:wrap;gap:.5rem' }, statusSelect(o, w), o.expiry === 'expiring' ? h('span', { class: 'neg', style: 'font-size:13px;font-weight:600' }, 'Lead is expiring') : '',
      w && !editing ? h('button', { class: 'small', onclick: () => (location.hash = `#/estimating/${id}/edit`) }, 'Edit') : '', w && editing ? h('button', { class: 'small primary', onclick: save }, 'Save changes') : '', editing ? h('button', { class: 'small', onclick: () => (location.hash = '#/estimating/' + id) }, 'Cancel') : '',
      o.lastSubmission ? h('a', { href: '#/estimating/followups/' + o.id }, 'Open follow-up') : '', o.projectId ? h('a', { href: '#/projects/' + o.projectId }, 'Open the project') : ''), msg,
    built.wrap(),
    o.tradePrices.length ? h('p', { style: 'margin-top:.8rem' }, h('strong', {}, 'Proposed: '), o.tradePrices.map((p) => `${p.name} ${usd(p.amount)}`).join(' · '), ` = ${usd(o.total)}`) : '',
    o.submissions.length ? h('div', { style: 'margin-top:.8rem' }, h('label', {}, 'Bid versions'), h('table', {}, h('tbody', {}, o.submissions.map((s) => h('tr', {}, h('td', {}, 'v' + s.version), h('td', {}, fmtDay(s.date)), h('td', {}, s.method), h('td', { class: 'n' }, usd(s.price)), h('td', {}, (s.trades || []).map((t) => t.name).join(', ')), h('td', {}, w && o.status === 'Submitted' ? h('button', { class: 'small danger', onclick: guard(err, async () => { const why = prompt('Why remove this submission? (the PDF stays in the folder)'); if (why) { await api('POST', `/opportunities/${o.id}/submissions/${s.id}/void`, { reason: why }); render(); } }) }, 'Remove') : '')))))) : '',
    (o.gcs || []).length > 1 ? bundleSection(o, w, msg) : '',
    (o.sameSite || []).length ? h('div', { class: 'card', style: 'margin-top:.8rem;padding:.7rem 1rem' }, h('label', {}, 'Other leads at this address'), h('p', { class: 'muted', style: 'margin:.2rem 0;font-size:14px' }, 'The same street: another store at the same center, or the same job under another name.'), o.sameSite.map((x) => h('div', {}, h('a', { href: '#/estimating/' + x.id }, `${x.proposalId ? x.proposalId + ' · ' : ''}${x.name}`), h('span', { class: 'muted' }, ` · ${x.gc}${x.client && x.client !== x.gc ? ' · ' + x.client : ''} · ${x.address} · ${x.statusLabel}`)))) : '',
    (o.siblings || []).length ? h('div', { class: 'card', style: 'margin-top:.8rem;padding:.7rem 1rem' }, h('label', {}, 'Same job, other GCs'), h('p', { class: 'muted', style: 'margin:.2rem 0;font-size:14px' }, 'Each GC has its own proposal and is submitted on its own.'), o.siblings.map((x) => h('div', {}, h('a', { href: '#/estimating/' + x.id }, `${x.proposalId || ''} · ${x.gc}`), h('span', { class: 'muted' }, ` · ${x.statusLabel}`)))) : '',
    h('div', { style: 'margin-top:.8rem' }, h('label', {}, 'Shared folder'), folderButtons(o, w, 'opportunity', OPTS?.sharepoint !== false)),
    h('div', { style: 'margin-top:.8rem' }, filesPanel(o, w, err)),
    h('div', { style: 'margin-top:.8rem' }, notesPanel(o, w)),
    await takeoffCard(o, err, w));
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
  // the latest proposal (PDF and Word), including one saved straight into the library folder after the award
  const latestBox = h('div'); api('GET', `/projects/${projectId}/lead-proposals`).then((v) => { if (!v.latestPdf && !v.latestWord && !v.proposalFolderUrl) return;
    latestBox.replaceChildren(h('label', { style: 'margin-top:.6rem' }, 'Latest proposal'), ...[['Latest PDF', v.latestPdf], ['Latest Word', v.latestWord]].filter((x) => x[1]).map(([l, f]) => h('div', {}, h('span', { class: 'pill' }, l), ' ', h('a', { href: f.href, target: '_blank', rel: 'noopener' }, f.name), h('span', { class: 'muted', style: 'font-size:12px' }, f.at ? '  ' + when(f.at) : ''))),
      v.proposalFolderUrl ? h('div', { style: 'font-size:14px;margin-top:.2rem' }, h('a', { href: v.proposalFolderUrl, target: '_blank', rel: 'noopener' }, 'Open The Proposal Folder In SharePoint')) : ''); }).catch(() => {});
  return h('div', {}, h('div', { class: 'card' }, h('h2', {}, 'From the lead'), h('div', { class: 'form' }, row('Client', o.client), row('GC', o.gc), row('GC contact', [o.contact, o.email, o.phone].filter(Boolean).join(' · ')), row('Project address', o.address), row('Source', o.sourceType), row('Invitation', o.link && h('a', { href: o.link, target: '_blank', rel: 'noopener' }, 'Open invitation')),
    row('Project type', o.type === 'Office / Medical / Other' ? 'Medical / Office' : o.type), row('Estimator', o.estimator), row('Proposal #', o.proposalId), row('Bid due', o.due ? fmtDay(o.due) : ''), row('Accepted', o.acceptedDate ? fmtDay(o.acceptedDate) : ''), row('Trades considered', o.consideredTrades.map((t) => t.name).join(', ')))),
    h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', {}, 'Proposal and submittal'), o.id ? h('a', { href: `#/estimating/${o.id}/chat` }, 'Open The Estimating Chat') : ''), o.submissions.length ? h('table', {}, h('thead', {}, h('tr', {}, ['Version', 'Submitted', 'How', 'Price', 'Trades'].map((t) => h('th', {}, t)))), h('tbody', {}, o.submissions.map((s) => h('tr', {}, h('td', {}, 'v' + s.version), h('td', {}, fmtDay(s.date)), h('td', {}, s.method), h('td', {}, usd(s.price)), h('td', {}, (s.trades || []).map((t) => `${t.name} ${usd(t.amount)}`).join(' · ')))))) : '',
      latestBox,
      h('label', { style: 'margin-top:.6rem' }, 'Files'), o.files.length ? h('div', {}, o.files.map((f) => h('div', {}, h('a', { href: '/api/opportunity-files/' + f.id, target: '_blank', rel: 'noopener' }, f.name), h('span', { class: 'muted' }, ` · ${f.kind}`)))) : h('p', { class: 'muted' }, 'No files.'), o.folderUrl ? h('p', {}, h('a', { href: o.folderUrl, target: '_blank', rel: 'noopener' }, 'OneDrive folder')) : ''),
    h('div', { class: 'card' }, h('h2', {}, 'Notes and history'), h('div', { class: 'notes' }, o.notes.map((n) => h('div', { class: 'note ' + n.kind }, h('div', {}, n.body), h('div', { class: 'meta' }, `${n.kind === 'System' ? 'System' : n.who || 'User'} · ${when(n.at)} ET`)))),
      o.communications.length ? h('p', { class: 'muted' }, 'Follow-up: ' + o.communications.map((c) => `${fmtDay(c.date)} ${c.kind}`).join(' · ')) : ''));
}

// ---------------------------------------------------------------- the lead clean-up rules: one table, each rule with its number and an on/off switch
// Shown on Insights and in Admin, Company. The owner and the Sub Admin change them; everyone else reads them.
export async function rulesCard(errBox) {
  const r = (await api('GET', '/estimating/options')).rules, can = ['Super Admin', 'Sub Admin'].includes(state.user.role), err = errBox || h('div');
  const n = (k, lo, hi) => num(r[k], { step: '1', min: String(lo), max: String(hi), disabled: !can, style: 'width:5rem' }), on = (k) => { const c = h('input', { type: 'checkbox', disabled: !can ? true : null }); c.checked = r[k] !== false; return c; };
  const f = { pastDueOn: on('pastDueOn'), declineNewDays: n('declineNewDays', 0, 30), declineReviewingDays: n('declineReviewingDays', 0, 30), idleOn: on('idleOn'), idleWorkingDays: n('idleWorkingDays', 1, 60), weekEndOn: on('weekEndOn'), weekEndMinTier: n('weekEndMinTier', 1, 4), expireOn: on('expireOn'), expiringDays: n('expiringDays', 0, 30), expireDays: n('expireDays', 1, 60) };
  const row = (sw, rule, what, setting) => h('tr', {}, h('td', {}, sw), h('td', { style: 'white-space:normal;font-weight:600' }, rule), h('td', { style: 'white-space:normal' }, what), h('td', { style: 'white-space:normal' }, setting));
  return h('div', { class: 'card' }, h('h2', {}, 'Lead Clean-Up Rules'), h('p', { class: 'muted', style: 'margin-top:0' }, 'The system moves leads by itself with these rules, checked every hour and at each Gmail refresh. Every move is written in the lead\'s log with the reason, and any lead can be brought back by hand.'), err,
    h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['On', 'Rule', 'What happens', 'Setting'].map((t) => h('th', {}, t)))), h('tbody', {},
      row(f.pastDueOn, 'New lead past its bid date', 'Declined after its bid due date has passed by:', h('span', {}, f.declineNewDays, ' days')),
      row('', 'Reviewing lead past its bid date', 'Declined after its bid due date has passed by (same switch as above):', h('span', {}, f.declineReviewingDays, ' days')),
      row(f.idleOn, 'New lead nobody took up', 'Declined when nobody has reviewed or accepted it this many working days (Monday to Friday) after it arrived or was brought back:', h('span', {}, f.idleWorkingDays, ' working days')),
      row(f.weekEndOn, 'Far-away New lead', 'A lead of this tier or higher (farther from Orlando) is declined when the week it arrived in is over. It always gets at least 3 working days; one that arrives Thursday to Sunday gets the next week too.', h('span', {}, 'Tier ', f.weekEndMinTier, ' and up')),
      row(f.expireOn, 'Accepted or Started, nothing submitted', 'Shows "Lead is expiring" after the bid due date by:', h('span', {}, f.expiringDays, ' days')),
      row('', '', 'Then becomes Decided Not To Submit after the bid due date by (same switch):', h('span', {}, f.expireDays, ' days'))))),
    h('ul', { class: 'muted', style: 'font-size:13px;margin:.6rem 0 0 1.2rem' },
      h('li', {}, 'A lead with no bid due date is never moved by the date rules.'),
      h('li', {}, 'A lead brought back by hand, or accepted or started after its bid date had already passed, is left alone by the date rules.'),
      h('li', {}, 'Submitted, Awarded, Not Awarded and No Communication are never moved by the clean-up.'),
      h('li', {}, 'Declined leads stay findable with the search box; the Include Declined box lists the last 30 days.')),
    can ? h('div', { class: 'row', style: 'margin-top:.6rem' }, h('button', { class: 'primary', onclick: guard(err, async () => { await api('PUT', '/settings/estimating', Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.type === 'checkbox' ? el.checked : el.value]))); OPTS = null; notice(err, 'Saved. The next check uses the new rules.', 'ok'); }) }, 'Save Rules')) : '');
}

// ---------------------------------------------------------------- Insights (+ the decline rules)
async function insightsTab(err) {
  const [panel, op, ins] = await Promise.all([insightsPanel(err), opts(), api('GET', '/estimating/insights')]); const canSet = ['Super Admin', 'Sub Admin'].includes(state.user.role);
  return h('div', {}, panel, await rulesCard(err),
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
  return h('div', { style: 'margin-top:1rem;border-top:1px solid var(--line);padding-top:.8rem' }, h('div', { class: 'row spread' }, h('h2', {}, 'Estimate With AI'), h('div', { class: 'row' }, file, h('button', { class: 'primary', onclick: () => (location.hash = `#/estimating/${o.id}/chat`) }, 'Open The Estimating Chat'))),
    h('p', { class: 'muted' }, 'Reads the plans already on this lead (it asks for plans only when there are none), follows the byOther estimating instructions, and works through scope and pricing with you. Each proposal it writes is saved here as a new version, and the conversation stays with the lead.'), msg,
    runs.length ? h('details', { style: 'margin-top:.6rem' }, h('summary', {}, `Earlier plan readings (${runs.length})`), runs.map(runCard)) : '');
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

