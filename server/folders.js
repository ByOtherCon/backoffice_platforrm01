// Ties the app to the shared SharePoint folders. The layout matches the team's existing one:
//   ByOther / <year> / <GC name> / <P11011_Project_City> / 01. DL, 02. Proposal, 03. Change Orders, 04. Documents, 05. Material & Equipment Specs
// When a proposal is awarded its P becomes a C (C11011_…), and the project's documents carry that code.
// Every function here is safe to call when SharePoint is not set up (it does nothing) and never lets a SharePoint problem break the caller.
import { q } from './db.js';
import { HttpError } from './http.js';
import * as SP from './sharepoint.js';
import { cleanName, todayEastern } from '../src/lib/estimating.ts';

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
export async function ensureOpportunityFolder(id) {
  if (!enabled()) throw new HttpError(503, 'SharePoint is not connected yet. Add the Microsoft settings on the server first.');
  const [o] = await q('SELECT * FROM opportunities WHERE id=$1', [id]); if (!o) throw new HttpError(404, 'Opportunity not found.');
  const want = projectFolderName({ code: o.proposal_id, name: o.name, city: o.city });
  if (o.sp_item_id) {
    const cur = (o.sp_path || '').split('/').pop();
    if (key(cur) !== key(want)) { try { const r = await SP.renameItem(o.sp_item_id, want); const path = [...o.sp_path.split('/').slice(0, -1), r.name].join('/'); await q('UPDATE opportunities SET sp_path=$2, folder_url=$3, sp_error=NULL WHERE id=$1', [id, path, r.webUrl ?? o.folder_url]); await note(id, `SharePoint folder renamed to ${r.name}.`); return { id: o.sp_item_id, path, webUrl: r.webUrl ?? o.folder_url, renamed: true }; }
      catch (e) { if (e.graph === 404) { await q('UPDATE opportunities SET sp_item_id=NULL WHERE id=$1', [id]); return ensureOpportunityFolder(id); } throw e; } }
    return { id: o.sp_item_id, path: o.sp_path, webUrl: o.folder_url };
  }
  const year = (o.accepted_date || todayEastern()).slice(0, 4);
  const f = await SP.ensureProjectFolder({ year, gc: o.gc_name, folderName: want, alsoMatch: matcher({ code: o.proposal_id, name: o.name }) });
  await q('UPDATE opportunities SET sp_item_id=$2, sp_path=$3, folder_url=$4, sp_error=NULL WHERE id=$1', [id, f.id, f.path.join('/'), f.webUrl]);
  syncGcs(year);   // a new GC folder may have just appeared
  await note(id, `${f.existed ? 'Linked the existing' : 'Created the'} SharePoint folder ${f.path.join(' / ')}.`);
  return { id: f.id, path: f.path.join('/'), webUrl: f.webUrl, existed: f.existed };
}
// Best-effort wrappers: report a problem in the record's Notes, never throw.
export async function tryEnsureOpportunityFolder(id) {
  if (!enabled()) return null;
  try { return await ensureOpportunityFolder(id); } catch (e) { await q('UPDATE opportunities SET sp_error=$2 WHERE id=$1', [id, oneLine(e)]).catch(() => {}); await note(id, `SharePoint folder not created: ${oneLine(e)}`).catch(() => {}); return null; }
}
// Saves a copy of a file into the right numbered folder of an opportunity.
export async function pushOpportunityFile(oppId, { kind, filename, bytes, mime }) {
  if (!enabled()) return null;
  try {
    const dir = await ensureOpportunityFolder(oppId); const sub = await SP.ensureFolder(dir.id, SUBFOLDER[kind] || SUBFOLDER.Other);
    const up = await SP.uploadFile(sub.id, filename, bytes, mime); return up;
  } catch (e) { await note(oppId, `Saved in the app, but not copied to SharePoint: ${oneLine(e)}`).catch(() => {}); return null; }
}
// Same, for a big file already on disk (plans). Returns the SharePoint item or null.
export async function pushOpportunityFilePath(oppId, { kind, filename, filePath, size, mime }) {
  if (!enabled()) return null;
  try { const dir = await ensureOpportunityFolder(oppId); const sub = await SP.ensureFolder(dir.id, SUBFOLDER[kind] || SUBFOLDER.Other); return await SP.uploadFromPath(sub.id, filename, filePath, size, mime); }
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
// ever removed or re-activated, and a name that matches an existing GC (ignoring case and punctuation) is not added again.
export async function syncGcs(year = todayEastern().slice(0, 4)) {
  if (!enabled()) return { added: 0, found: 0 };
  try {
    const names = await SP.listFolderNames([...SP.settings().root, String(year)]); if (!names.length) return { added: 0, found: 0 };
    const have = new Set((await q('SELECT name FROM gcs')).map((g) => key(g.name))); let added = 0;
    for (const raw of names) { const name = raw.trim(); if (!name || have.has(key(name)) || /^(zz|_|\.)/i.test(name)) continue; await q('INSERT INTO gcs(name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [name]); have.add(key(name)); added++; }
    return { added, found: names.length };
  } catch { return { added: 0, found: 0 }; }
}
