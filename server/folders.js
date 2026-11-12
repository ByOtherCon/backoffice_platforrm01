// Ties the app to the shared SharePoint folders. The layout matches the team's existing one:
//   ByOther / <year> / <GC name> / <P11011_Project_City> / 01. DL, 02. Proposal, 03. Change Orders, 04. Documents, 05. Material & Equipment Specs
// When a proposal is awarded its P becomes a C (C11011_…), and the project's documents carry that code.
// Every function here is safe to call when SharePoint is not set up (it does nothing) and never lets a SharePoint problem break the caller.
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
  const want = projectFolderName({ code: o.proposal_id, name: o.name, city: o.city });
  if (o.sp_item_id) {
    const cur = (o.sp_path || '').split('/').pop();
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

// What is in the job's folder right now: the BID SET plan PDFs in 01. DL (for the Open Plans link) and the PDFs in 02. Proposal.
// A lead whose folder exists in SharePoint but was never linked is linked here (nothing is created for a lead that has no P number yet).
export async function folderFiles(oppId) {
  if (!enabled()) return { enabled: false, plans: [], proposals: [] };
  let [o] = await q('SELECT id, sp_item_id, proposal_id, status FROM opportunities WHERE id=$1', [oppId]); if (!o) throw new HttpError(404, 'Opportunity not found.');
  if (!o.sp_item_id && (o.proposal_id || ['Reviewing', 'Accepted', 'Started', 'Submitted'].includes(o.status))) { await tryEnsureOpportunityFolder(oppId); [o] = await q('SELECT id, sp_item_id FROM opportunities WHERE id=$1', [oppId]); }
  if (!o?.sp_item_id) return { enabled: true, linked: false, plans: [], proposals: [] };
  try {
    const kids = await SP.listFolder(o.sp_item_id), sub = (n) => kids.find((k) => k.folder && k.name === n);
    const pdf = (n) => /\.pdf$/i.test(n);
    const [plans, proposals] = await Promise.all([sub('01. DL') ? SP.findFiles(sub('01. DL').id, (n) => pdf(n) && /bid\s*set/i.test(n), 3) : [], sub('02. Proposal') ? SP.findFiles(sub('02. Proposal').id, pdf, 2) : []]);
    return { enabled: true, linked: true, plans, proposals };
  } catch (e) { return { enabled: true, linked: true, plans: [], proposals: [], error: oneLine(e) }; }
}
