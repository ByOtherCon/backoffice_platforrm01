// Ties the app to the shared SharePoint folders. The layout matches the team's existing one:
//   ByOther / <year> / <GC name> / <P11011_Project_City> / 01. DL, 02. Proposal, 03. Change Orders, 04. Documents, 05. Material & Equipment Specs
// When a proposal is awarded its P becomes a C (C11011_…), and the project's documents carry that code.
// Every function here is safe to call when SharePoint is not set up (it does nothing) and never lets a SharePoint problem break the caller.
import fs from 'node:fs';
import path from 'node:path';
import { q } from './db.js';
import { HttpError } from './http.js';
import * as SP from './sharepoint.js';
import { cleanName, todayEastern } from '../src/lib/estimating.ts';
import * as R from '../src/lib/bidrules.ts';

export const enabled = () => SP.configured();
const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const oneLine = (e) => (e instanceof HttpError ? e.message : 'SharePoint could not be reached.');
const note = (id, body) => q(`INSERT INTO opportunity_notes(opportunity_id,kind,body) VALUES ($1,'System',$2)`, [id, body]);

// Which numbered folder a kind of file belongs in.
export const SUBFOLDER = { Proposal: '02. Proposal', Submittal: '02. Proposal', Plans: '01. DL', Contract: '04. Documents', 'Approved CO': '03. Change Orders', Specs: '05. Material & Equipment Specs', Other: '04. Documents' };

export const projectFolderName = ({ code, name, city }) => [code, name, city].filter(Boolean).map(cleanName).filter(Boolean).join('_');
// An older or hand-made folder for the same job is reused instead of creating a second one.
function matcher({ code, name }) {
  const n = key(name);
  return (found) => { const f = key(found); return (!!code && (found.startsWith(code + '_') || found.startsWith(code + ' '))) || (n.length >= 6 && f.includes(n)); };
}

// Makes sure this opportunity has its folder in the current year. Creates the year, GC and project folders when missing, renames a
// folder that was made before the P number existed, and remembers where it is.
async function ensureMainFolder(id) {
  if (!enabled()) throw new HttpError(503, 'SharePoint is not connected yet. Add the Microsoft settings on the server first.');
  const [o] = await q('SELECT * FROM opportunities WHERE id=$1', [id]); if (!o) throw new HttpError(404, 'Opportunity not found.');
  const want = projectFolderName({ code: o.project_id && o.proposal_id ? 'C' + o.proposal_id.slice(1) : o.proposal_id, name: o.name, city: o.city });   // once awarded the folder carries the C code
  if (o.sp_item_id) {
    // the folder on record may have been deleted or moved out of the library by hand: then it is made again instead of failing quietly forever
    const live = await SP.getItem(o.sp_item_id);
    if (!live || !live.folder) { await q('UPDATE opportunities SET sp_item_id=NULL, sp_path=NULL, folder_url=NULL WHERE id=$1', [id]); await q('UPDATE opportunity_files SET sp_url=NULL WHERE opportunity_id=$1 AND storage_key IS NOT NULL', [id]); await note(id, 'The SharePoint folder for this lead was no longer in the library (deleted or moved). It is being made again and the files kept in the app are copied back into it.'); return ensureMainFolder(id); }
    const cur = live.name;
    if (key(cur) !== key(want)) { try { const r = await SP.renameItem(o.sp_item_id, want); const path = [...o.sp_path.split('/').slice(0, -1), r.name].join('/'); await q('UPDATE opportunities SET sp_path=$2, folder_url=$3, sp_error=NULL WHERE id=$1', [id, path, r.webUrl ?? o.folder_url]); await note(id, `SharePoint folder renamed to ${r.name}.`); return { id: o.sp_item_id, path, webUrl: r.webUrl ?? o.folder_url, renamed: true }; }
      catch (e) { if (e.graph === 404) { await q('UPDATE opportunities SET sp_item_id=NULL WHERE id=$1', [id]); return ensureMainFolder(id); } throw e; } }
    return { id: o.sp_item_id, path: o.sp_path, webUrl: o.folder_url };
  }
  const year = (o.accepted_date || todayEastern()).slice(0, 4);
  const f = await SP.ensureProjectFolder({ year, gc: o.gc_name, folderName: want, alsoMatch: matcher({ code: o.proposal_id, name: o.name }) });
  await q('UPDATE opportunities SET sp_item_id=$2, sp_path=$3, folder_url=$4, sp_error=NULL WHERE id=$1', [id, f.id, f.path.join('/'), f.webUrl]);
  syncGcs(year);   // a new GC folder may have just appeared
  await note(id, `${f.existed ? 'Linked the existing' : 'Created the'} SharePoint folder ${f.path.join(' / ')}.`);
  return { id: f.id, path: f.path.join('/'), webUrl: f.webUrl, existed: f.existed };
}
export async function ensureOpportunityFolder(id) {
  const d = await ensureMainFolder(id);
  await ensureGcFolders(id).catch(() => {});   // a bundled job that keeps a folder under each GC gets them all
  return d;
}
// A job pitched to several GCs (bundled) can keep the same project folder under each GC, with everything duplicated. Nothing is created
// unless that was chosen on the lead. The main folder is the one on the lead; the others are listed in opportunity_folders.
export async function ensureGcFolders(id) {
  if (!enabled()) return [];
  const [o] = await q('SELECT * FROM opportunities WHERE id=$1', [id]); if (!o || !o.folder_per_gc || !o.sp_item_id) return [];
  const want = projectFolderName({ code: o.proposal_id, name: o.name, city: o.city }), year = (o.accepted_date || todayEastern()).slice(0, 4), out = [];
  const have = new Map((await q('SELECT * FROM opportunity_folders WHERE opportunity_id=$1', [id])).map((r) => [R.gcKey(r.gc_name), r]));
  for (const gc of R.gcNames(o.gc_name, o.invitations).slice(1)) {
    const row = have.get(R.gcKey(gc));
    if (row?.sp_item_id) {
      if (key((row.sp_path || '').split('/').pop()) !== key(want)) { try { const r = await SP.renameItem(row.sp_item_id, want); const path = [...row.sp_path.split('/').slice(0, -1), r.name].join('/'); await q('UPDATE opportunity_folders SET sp_path=$3, folder_url=$4 WHERE opportunity_id=$1 AND gc_name=$2', [id, row.gc_name, path, r.webUrl ?? row.folder_url]); out.push({ gc, path }); continue; } catch { /* made again below */ } }
      else { out.push({ gc, path: row.sp_path }); continue; }
    }
    const f = await SP.ensureProjectFolder({ year, gc, folderName: want, alsoMatch: matcher({ code: o.proposal_id, name: o.name }) });
    await q(`INSERT INTO opportunity_folders(opportunity_id,gc_name,sp_item_id,sp_path,folder_url) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (opportunity_id,gc_name) DO UPDATE SET sp_item_id=$3, sp_path=$4, folder_url=$5`, [id, gc, f.id, f.path.join('/'), f.webUrl]);
    await note(id, `${f.existed ? 'Linked the existing' : 'Created the'} SharePoint folder for ${gc}: ${f.path.join(' / ')}.`);
    out.push({ gc, path: f.path.join('/') });
  }
  return out;
}
export async function tryEnsureGcFolders(id) {
  if (!enabled()) return null;
  try { await tryEnsureOpportunityFolder(id); return await ensureGcFolders(id); } catch (e) { await note(id, `The folders under the other GCs were not created: ${oneLine(e)}`).catch(() => {}); return null; }
}
// The GC that awarded a bundled job becomes the lead's main GC: its folder takes the main place (and is the one renamed to C), the old main folder is kept as an extra.
export async function promoteGc(id, winner, oldMain) {
  if (!enabled()) return null;
  try {
    let [o] = await q('SELECT * FROM opportunities WHERE id=$1', [id]); if (!o) return null;
    let [row] = (await q('SELECT * FROM opportunity_folders WHERE opportunity_id=$1', [id])).filter((r) => R.gcKey(r.gc_name) === R.gcKey(winner));
    if (!row?.sp_item_id) {   // one folder was kept: the winner gets its own under its GC so the project lives under the GC that awarded it
      const want = projectFolderName({ code: o.proposal_id, name: o.name, city: o.city });
      const f = await SP.ensureProjectFolder({ year: (o.accepted_date || todayEastern()).slice(0, 4), gc: winner, folderName: want, alsoMatch: matcher({ code: o.proposal_id, name: o.name }) });
      row = { gc_name: winner, sp_item_id: f.id, sp_path: f.path.join('/'), folder_url: f.webUrl };
      await note(id, `${f.existed ? 'Linked the existing' : 'Created the'} SharePoint folder under ${winner}: ${f.path.join(' / ')}.${o.sp_path ? ` Files saved earlier are in ${o.sp_path}.` : ''}`);
    }
    await q('DELETE FROM opportunity_folders WHERE opportunity_id=$1 AND lower(gc_name)=lower($2)', [id, winner]);
    if (o.sp_item_id) await q(`INSERT INTO opportunity_folders(opportunity_id,gc_name,sp_item_id,sp_path,folder_url) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (opportunity_id,gc_name) DO UPDATE SET sp_item_id=$3, sp_path=$4, folder_url=$5`, [id, oldMain, o.sp_item_id, o.sp_path, o.folder_url]);
    await q('UPDATE opportunities SET sp_item_id=$2, sp_path=$3, folder_url=$4, sp_error=NULL WHERE id=$1', [id, row.sp_item_id, row.sp_path, row.folder_url]);
    return { id: row.sp_item_id, path: row.sp_path, webUrl: row.folder_url };
  } catch (e) { await note(id, `The folder under ${winner} could not be set up: ${oneLine(e)}`).catch(() => {}); return null; }
}
// Best-effort wrappers: report a problem in the record's Notes, never throw.
export async function tryEnsureOpportunityFolder(id) {
  if (!enabled()) return null;
  try { return await ensureOpportunityFolder(id); } catch (e) { await q('UPDATE opportunities SET sp_error=$2 WHERE id=$1', [id, oneLine(e)]).catch(() => {}); await note(id, `SharePoint folder not created: ${oneLine(e)}`).catch(() => {}); return null; }
}
const extraFolders = (oppId) => q(`SELECT f.* FROM opportunity_folders f JOIN opportunities o ON o.id=f.opportunity_id WHERE f.opportunity_id=$1 AND o.folder_per_gc AND f.sp_item_id IS NOT NULL`, [oppId]);
// Saves a copy of a file into the right numbered folder of an opportunity.
export async function pushOpportunityFile(oppId, { kind, filename, bytes, mime }) {
  if (!enabled()) return null;
  try {
    const dir = await ensureOpportunityFolder(oppId); const sub = await SP.ensureFolder(dir.id, SUBFOLDER[kind] || SUBFOLDER.Other);
    const up = await SP.uploadFile(sub.id, filename, bytes, mime);
    for (const x of await extraFolders(oppId)) { try { const xs = await SP.ensureFolder(x.sp_item_id, SUBFOLDER[kind] || SUBFOLDER.Other); await SP.uploadFile(xs.id, filename, bytes, mime); } catch (e) { await note(oppId, `Not copied to the ${x.gc_name} folder: ${oneLine(e)}`).catch(() => {}); } }
    return up;
  } catch (e) { await note(oppId, `Saved in the app, but not copied to SharePoint: ${oneLine(e)}`).catch(() => {}); return null; }
}
// Same, for a big file already on disk (plans). Returns the SharePoint item or null.
export async function pushOpportunityFilePath(oppId, { kind, filename, filePath, size, mime }) {
  if (!enabled()) return null;
  try { const dir = await ensureOpportunityFolder(oppId); const sub = await SP.ensureFolder(dir.id, SUBFOLDER[kind] || SUBFOLDER.Other); const up = await SP.uploadFromPath(sub.id, filename, filePath, size, mime);
    for (const x of await extraFolders(oppId)) { try { const xs = await SP.ensureFolder(x.sp_item_id, SUBFOLDER[kind] || SUBFOLDER.Other); await SP.uploadFromPath(xs.id, filename, filePath, size, mime); } catch (e) { await note(oppId, `Not copied to the ${x.gc_name} folder: ${oneLine(e)}`).catch(() => {}); } }
    return up; }
  catch (e) { await note(oppId, `Saved in the app, but not copied to SharePoint: ${oneLine(e)}`).catch(() => {}); return null; }
}
// At award: the folder and the project take the C code.
export async function onAwarded(oppId, projectId) {
  if (!enabled()) return null;
  const [o] = await q('SELECT proposal_id FROM opportunities WHERE id=$1', [oppId]); if (!o?.proposal_id) return null;
  const code = 'C' + o.proposal_id.slice(1);
  try {
    // rename the folder P… -> C…
    const [row] = await q('SELECT * FROM opportunities WHERE id=$1', [oppId]); let dir = null;
    if (row.sp_item_id) { const cur = (row.sp_path || '').split('/').pop(); const next = cur.replace(/^P(?=\d)/i, 'C'); const r = await SP.renameItem(row.sp_item_id, next); const path = [...row.sp_path.split('/').slice(0, -1), r.name].join('/'); await q('UPDATE opportunities SET sp_path=$2, folder_url=$3 WHERE id=$1', [oppId, path, r.webUrl ?? row.folder_url]); dir = { id: row.sp_item_id, path, webUrl: r.webUrl ?? row.folder_url }; await note(oppId, `SharePoint folder renamed to ${r.name} (P became C: this is now a contract).`); }
    else dir = await ensureOpportunityFolder(oppId).then(async (d) => { const r = await SP.renameItem(d.id, projectFolderName({ code, name: (await q('SELECT name FROM opportunities WHERE id=$1', [oppId]))[0].name, city: (await q('SELECT city FROM opportunities WHERE id=$1', [oppId]))[0].city })); const path = [...d.path.split('/').slice(0, -1), r.name].join('/'); await q('UPDATE opportunities SET sp_path=$2, folder_url=$3 WHERE id=$1', [oppId, path, r.webUrl ?? d.webUrl]); return { id: d.id, path, webUrl: r.webUrl ?? d.webUrl }; });
    await q('UPDATE projects SET sp_item_id=$2, sp_path=$3, folder_url=$4 WHERE id=$1', [projectId, dir.id, dir.path, dir.webUrl]); return dir;
  } catch (e) { await note(oppId, `The project was created, but its SharePoint folder could not be renamed to ${code}: ${oneLine(e)}`).catch(() => {}); return null; }
}
// A project that did not come from an opportunity gets its own folder.
export async function ensureProjectFolder(projectId) {
  if (!enabled()) throw new HttpError(503, 'SharePoint is not connected yet. Add the Microsoft settings on the server first.');
  const [p] = await q('SELECT p.*, g.name AS gc FROM projects p JOIN gcs g ON g.id=p.gc_id WHERE p.id=$1', [projectId]); if (!p) throw new HttpError(404, 'Project not found.');
  if (p.sp_item_id) return { id: p.sp_item_id, path: p.sp_path, webUrl: p.folder_url };
  if (p.opportunity_id) { const d = await ensureOpportunityFolder(p.opportunity_id); await q('UPDATE projects SET sp_item_id=$2, sp_path=$3, folder_url=$4 WHERE id=$1', [projectId, d.id, d.path, d.webUrl]); return d; }
  const f = await SP.ensureProjectFolder({ year: String(p.logged_date || todayEastern()).slice(0, 4), gc: p.gc, folderName: projectFolderName({ code: p.ref_code || p.proposal_id, name: p.name }), alsoMatch: matcher({ code: p.ref_code, name: p.name }) });
  await q('UPDATE projects SET sp_item_id=$2, sp_path=$3, folder_url=$4 WHERE id=$1', [projectId, f.id, f.path.join('/'), f.webUrl]); return { id: f.id, path: f.path.join('/'), webUrl: f.webUrl, existed: f.existed };
}
// A project document (contract, change order, plans...) goes into its numbered folder, named with the contract code.
export async function pushProjectFile(projectId, { category, filename, bytes, mime }) {
  if (!enabled()) return null;
  try {
    const [p] = await q('SELECT ref_code FROM projects WHERE id=$1', [projectId]); const dir = await ensureProjectFolder(projectId);
    const sub = await SP.ensureFolder(dir.id, SUBFOLDER[category] || SUBFOLDER.Other); const name = p?.ref_code && !filename.startsWith(p.ref_code) ? `${p.ref_code} - ${filename}` : filename;
    return await SP.uploadFile(sub.id, name, bytes, mime);
  } catch (e) { return null; }
}

// The GC list fills itself from the folders that already exist: every GC folder under <root>/<year> becomes a GC (once). Nothing is
// ever removed or re-activated, and a name that matches an existing GC (ignoring case and punctuation) is not added again. Folders that start with zz, _ or a dot,
// numbered office folders ("00. Proposal Kit") and year-prefixed ones ("2026 Regions Bank Docs") are skipped.
export async function syncGcs(year = todayEastern().slice(0, 4)) {
  if (!enabled()) return { added: 0, found: 0 };
  try {
    const names = await SP.listFolderNames([...SP.settings().root, String(year)]); if (!names.length) return { added: 0, found: 0 };
    const have = new Set((await q('SELECT name FROM gcs')).map((g) => key(g.name))); let added = 0;
    for (const raw of names) { const name = raw.trim(); if (!name || have.has(key(name)) || /^(zz|_|\.)/i.test(name) || /^\d{1,2}\.\s/.test(name) || /^20\d\d\b/.test(name)) continue; await q('INSERT INTO gcs(name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [name]); have.add(key(name)); added++; }
    return { added, found: names.length };
  } catch { return { added: 0, found: 0 }; }
}

// ---- keeping the lead and its library folder in step
// Makes sure the folder is there, then copies every file the app holds for the lead that the library does not have yet (a backup, in the
// right numbered folder). Safe to run as often as wanted: a file already copied is not copied again.
const syncing = new Set();
export async function syncOpportunity(id, { force = false } = {}) {
  if (!enabled()) return { enabled: false, pushed: 0 };
  // Opening a lead runs this. A new or declined lead that has no folder, no P number and nothing to back up is left alone (no folder is
  // made just by looking); `force` is the Sync button, which always makes the folder.
  const [o] = await q('SELECT sp_item_id, proposal_id, status FROM opportunities WHERE id=$1', [id]); if (!o) throw new HttpError(404, 'Opportunity not found.');
  const [{ n }] = await q('SELECT count(*)::int AS n FROM opportunity_files WHERE opportunity_id=$1 AND storage_key IS NOT NULL AND sp_url IS NULL', [id]);
  if (!force && !o.sp_item_id && !o.proposal_id && ['New', 'Declined'].includes(o.status) && !n) return { enabled: true, linked: false, pushed: 0, waiting: true };
  if (syncing.has(id)) return { enabled: true, busy: true, pushed: 0 };
  syncing.add(id);
  try {
    let dir; try { dir = await ensureOpportunityFolder(id); } catch (e) { await q('UPDATE opportunities SET sp_error=$2 WHERE id=$1', [id, oneLine(e)]).catch(() => {}); return { enabled: true, linked: false, pushed: 0, error: oneLine(e) }; }
    const rows = await q(`SELECT id, kind, name, storage_key, mime, size FROM opportunity_files WHERE opportunity_id=$1 AND storage_key IS NOT NULL AND sp_url IS NULL ORDER BY created_at`, [id]);
    const { UPLOAD_DIR } = await import('./documents.js'), subs = new Map(), done = [], failed = [];
    for (const f of rows) {
      const file = path.join(UPLOAD_DIR, path.basename(f.storage_key)); if (!fs.existsSync(file)) continue;
      try {
        const subName = SUBFOLDER[f.kind] || SUBFOLDER.Other; if (!subs.has(subName)) { const sf = await SP.ensureFolder(dir.id, subName); subs.set(subName, { id: sf.id, kids: await SP.listFolder(sf.id) }); }
        const sub = subs.get(subName), there = sub.kids.find((k) => !k.folder && k.name.toLowerCase() === (cleanName(f.name) || f.name).toLowerCase());   // copied before, but the link was never recorded
        const up = there ?? (await SP.uploadFromPath(sub.id, f.name, file, Number(f.size) || fs.statSync(file).size, f.mime || 'application/octet-stream'));
        if (f.kind === 'Plans') { await q('UPDATE opportunity_files SET sp_url=$2, storage_key=NULL WHERE id=$1', [f.id, up.webUrl ?? null]); await fs.promises.rm(file, { force: true }); }   // big plan sets live in the library only, as when they are uploaded
        else await q('UPDATE opportunity_files SET sp_url=$2 WHERE id=$1', [f.id, up.webUrl ?? null]);
        if (!there) done.push(f.name);
      } catch (e) { failed.push(`${f.name}: ${oneLine(e)}`); }
    }
    if (done.length) await note(id, `Copied to the SharePoint folder as a backup: ${done.slice(0, 12).join(', ')}${done.length > 12 ? ` and ${done.length - 12} more` : ''}.`);
    if (failed.length) await note(id, `Not copied to SharePoint: ${failed.slice(0, 5).join('; ')}`);
    return { enabled: true, linked: true, pushed: done.length, failed, folderUrl: dir.webUrl };
  } finally { syncing.delete(id); }
}

// The proposals of a lead, wherever they are: written or uploaded in the app, or saved by hand into 02. Proposal in the library (a Word file
// edited there, a PDF saved from it). The same file in both places is one entry and opens from the library. Newest first; `latestPdf`
// and `latestWord` are what the lead and the project show.
export async function proposalView(oppId) {
  const app = await q(`SELECT id, name, created_at, sp_url, (storage_key IS NOT NULL) AS local FROM opportunity_files WHERE opportunity_id=$1 AND kind='Proposal'`, [oppId]);
  let lib = { enabled: enabled(), linked: false, proposals: [] }; try { lib = await folderFiles(oppId); } catch (e) { lib = { enabled: enabled(), linked: false, proposals: [], error: oneLine(e) }; }
  const iso = (d) => (d ? new Date(d).toISOString() : null), by = new Map();
  for (const f of app) by.set(f.name.toLowerCase(), { name: f.name, at: iso(f.created_at), href: f.local ? `/api/opportunity-files/${f.id}` : f.sp_url, where: 'App', fileId: f.id });
  for (const s of lib.proposals || []) { const k = s.name.toLowerCase(), cur = by.get(k); by.set(k, { name: s.name, at: iso(s.modified) ?? cur?.at ?? null, href: s.webUrl || cur?.href, where: cur ? 'App and SharePoint' : 'SharePoint', fileId: cur?.fileId ?? null }); }
  const all = [...by.values()].filter((x) => x.href).sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  const latestPdf = all.find((x) => /\.pdf$/i.test(x.name)) ?? null, latestWord = all.find((x) => /\.docx?$/i.test(x.name)) ?? null;
  return { enabled: !!lib.enabled, linked: !!lib.linked, error: lib.error ?? null, folderUrl: lib.folderUrl ?? null, proposalFolderUrl: lib.proposalFolderUrl ?? null, plansFolderUrl: lib.plansFolderUrl ?? null,
    latestPdf, latestWord, total: all.length, earlier: all.filter((x) => x !== latestPdf && x !== latestWord), plans: lib.allPlans ?? [] };
}

// What is in the job's folder right now: the BID SET plan PDFs in 01. DL (for the Open Plans link) and the PDFs in 02. Proposal.
// A lead whose folder exists in SharePoint but was never linked is linked here (nothing is created for a lead that has no P number yet).
export async function folderFiles(oppId) {
  if (!enabled()) return { enabled: false, plans: [], allPlans: [], proposals: [] };
  let [o] = await q('SELECT id, sp_item_id, proposal_id, status FROM opportunities WHERE id=$1', [oppId]); if (!o) throw new HttpError(404, 'Opportunity not found.');
  if (!o.sp_item_id && (o.proposal_id || ['Reviewing', 'Accepted', 'Started', 'Submitted'].includes(o.status))) { await tryEnsureOpportunityFolder(oppId); [o] = await q('SELECT id, sp_item_id FROM opportunities WHERE id=$1', [oppId]); }
  if (!o?.sp_item_id) return { enabled: true, linked: false, plans: [], allPlans: [], proposals: [] };
  try {
    const kids = await SP.listFolder(o.sp_item_id), sub = (n) => kids.find((k) => k.folder && k.name === n);
    // an empty listing can mean the folder on record is gone (deleted or moved by hand): say so instead of showing nothing
    if (!kids.length && !(await SP.getItem(o.sp_item_id))) return { enabled: true, linked: false, plans: [], allPlans: [], proposals: [], error: 'The SharePoint folder for this lead is no longer in the library (deleted or moved). Press Sync With SharePoint to make it again.' };
    const pdf = (n) => /\.pdf$/i.test(n);
    // proposals: every PDF and Word file in 02. Proposal, newest first (a file saved there by hand counts the same as one made in the app)
    const [plans, allPlans, found] = await Promise.all([sub('01. DL') ? SP.findFiles(sub('01. DL').id, (n) => pdf(n) && /bid\s*set/i.test(n), 3) : [], sub('01. DL') ? SP.findFiles(sub('01. DL').id, (n) => /\.(pdf|zip)$/i.test(n), 3) : [], sub('02. Proposal') ? SP.findFiles(sub('02. Proposal').id, (n) => /\.(pdf|docx?)$/i.test(n) && !n.startsWith('~$'), 2) : []]);
    const proposals = found.sort((a, b) => String(b.modified || '').localeCompare(String(a.modified || '')));
    const [main] = await q('SELECT folder_url FROM opportunities WHERE id=$1', [oppId]);
    return { enabled: true, linked: true, plans, allPlans, proposals, folderUrl: main?.folder_url ?? null, plansFolderUrl: sub('01. DL')?.webUrl ?? null, proposalFolderUrl: sub('02. Proposal')?.webUrl ?? null };
  } catch (e) { return { enabled: true, linked: true, plans: [], allPlans: [], proposals: [], error: oneLine(e) }; }
}
