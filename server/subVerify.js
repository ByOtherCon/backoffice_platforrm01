// Subcontractor folders in SharePoint (<root>/Subcontractors/<company or person>), their documents copied there, and reading the name and
// address off a W-9 or certificate so it can be compared with the subcontractor's verified address. Everything here is best effort:
// a SharePoint or AI problem never loses an upload.
import { q } from './db.js';
import { HttpError } from './http.js';
import { readVendorFile } from './vendorRead.js';
import * as SP from './sharepoint.js';
import { cleanName } from '../src/lib/estimating.ts';

export const FOLDER_NAME = 'Subcontractors';
const oneLine = (e) => (e instanceof HttpError ? e.message : 'SharePoint could not be reached.');
// A subcontractor's own folder: ByOther / Subcontractors / <name>. Created on first need and remembered; renamed when the name changes.
export async function ensureSubFolder(subId) {
  if (!SP.configured()) throw new HttpError(503, 'SharePoint is not connected yet. Add the Microsoft settings on the server first.');
  const [s] = await q('SELECT id, name, sp_item_id FROM subcontractors WHERE id=$1', [subId]); if (!s) throw new HttpError(404, 'Subcontractor not found.');
  const want = cleanName(s.name); if (!want) throw new HttpError(400, 'The subcontractor needs a name first.');
  const root = SP.settings().root;
  if (s.sp_item_id) { try { const f = await SP.renameItem(s.sp_item_id, want).catch((e) => { if (e instanceof HttpError && /no longer exists/.test(e.message)) return null; throw e; }); if (f) { await q('UPDATE subcontractors SET sp_path=$2, folder_url=$3 WHERE id=$1', [s.id, [...root, FOLDER_NAME, f.name].join('/'), f.webUrl]); return { id: s.sp_item_id, webUrl: f.webUrl }; } } catch { /* fall through to make it again */ } }
  const f = await SP.ensurePath([...root, FOLDER_NAME, want]);
  await q('UPDATE subcontractors SET sp_item_id=$2, sp_path=$3, folder_url=$4 WHERE id=$1', [s.id, f.id, f.path.join('/'), f.webUrl]); return { id: f.id, webUrl: f.webUrl };
}
export async function tryEnsureSubFolder(subId) { if (!SP.configured()) return null; try { return await ensureSubFolder(subId); } catch (e) { console.error('Subcontractor folder:', oneLine(e)); return null; } }
export async function pushSubFile(subId, { category, filename, bytes, mime }) {
  if (!SP.configured()) return null;
  try { const dir = await ensureSubFolder(subId); return await SP.uploadFile(dir.id, `${category} - ${filename}`, bytes, mime); } catch { return null; }
}

// Reads the name and address (and, on insurance, the coverages and dates) off a saved document and keeps them with it. The tax number is never read or stored.
export async function readVendorDocument(user, docId, bytes, mime, filename) {
  const r = await readVendorFile(user, bytes, mime, filename);   // the answer given while the form was open is reused, so the AI is asked once per file
  if (r.error) return { error: r.error };
  await q('UPDATE documents SET read_name=$2, read_address=$3, read_policies=$4 WHERE id=$1', [docId, r.name || null, r.address, r.policies.length ? JSON.stringify(r.policies) : null]);
  return { name: r.name, legalName: r.legalName, address: r.address, policies: r.policies, expires: r.expires };
}
// After a W-9 / COI / exemption file is uploaded for a subcontractor: copy it to their folder and read the address off it.
export async function afterVendorUpload(user, { docId, subId, category, filename, bytes, mime }) {
  const out = {}; const up = await pushSubFile(subId, { category, filename, bytes, mime });
  if (up?.webUrl) { await q('UPDATE documents SET sp_url=$2 WHERE id=$1', [docId, up.webUrl]); out.sharepoint = up.webUrl; }
  out.read = await readVendorDocument(user, docId, bytes, mime, filename);
  return out;
}
