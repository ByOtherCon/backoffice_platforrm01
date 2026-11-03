// SharePoint / OneDrive for Business through Microsoft Graph (app-only sign-in). It keeps the shared project folders:
//   <root>/<year>/<GC name>/<P#_Project_City>/{01. DL, 02. Proposal, 03. Change Orders, 04. Documents, 05. Material & Equipment Specs, 06. Billing}
// This is the layout the team already uses. Everything here is best-effort for the caller: a SharePoint problem is reported, never allowed to lose a local save.
import fs from 'node:fs';
import { HttpError } from './http.js';
import { cleanName, FOLDERS } from '../src/lib/estimating.ts';

let gfetch = (...a) => fetch(...a);
export const setGraphFetch = (f) => { gfetch = f; };   // tests stand in for Microsoft

export const settings = () => ({
  tenant: process.env.MS_TENANT_ID, clientId: process.env.MS_CLIENT_ID, secret: process.env.MS_CLIENT_SECRET,
  siteUrl: (process.env.MS_SITE_URL || '').replace(/\/$/, ''), library: process.env.MS_LIBRARY || 'Documents', root: (process.env.MS_ROOT_FOLDER ?? 'ByOther').split('/').filter(Boolean),
});
export const configured = () => { const s = settings(); return !!(s.tenant && s.clientId && s.secret && s.siteUrl); };
const need = () => { if (!configured()) throw new HttpError(503, 'SharePoint is not connected yet. Add the Microsoft settings (MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, MS_SITE_URL) on the server.'); return settings(); };

let tok = { value: null, exp: 0 }, drive = null;
export const resetCache = () => { tok = { value: null, exp: 0 }; drive = null; };
async function token() {
  if (tok.value && tok.exp > Date.now() + 60000) return tok.value;
  const s = need();
  const r = await gfetch(`https://login.microsoftonline.com/${encodeURIComponent(s.tenant)}/oauth2/v2.0/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: s.clientId, client_secret: s.secret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }) });
  const j = await r.json().catch(() => ({}));
  if (/AADSTS7000215/.test(j.error_description || '')) throw new HttpError(502, 'Microsoft rejected the client secret. MS_CLIENT_SECRET must be the secret VALUE (the long text Azure shows once, when the secret is created), not the Secret ID. In Azure, open the app registration, then Certificates & secrets, create a new secret, copy its Value right away, and paste it into MS_CLIENT_SECRET on Render.');
  if (!r.ok || !j.access_token) throw new HttpError(502, `Microsoft did not accept the app sign-in${j.error_description ? ': ' + String(j.error_description).split('\r')[0].slice(0, 160) : ''}. Check the tenant, client ID and secret.`);
  tok = { value: j.access_token, exp: Date.now() + (j.expires_in || 3000) * 1000 }; return tok.value;
}
async function graph(method, path, { body, raw, headers = {}, absolute } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await gfetch(absolute ? path : 'https://graph.microsoft.com/v1.0' + path, { method, headers: { authorization: 'Bearer ' + (await token()), ...(body && !raw ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? (raw ? body : JSON.stringify(body)) : undefined });
    if ((r.status === 429 || r.status === 503) && attempt < 2) { await new Promise((ok) => setTimeout(ok, Math.min(3000, Number(r.headers?.get?.('retry-after') || 1) * 1000))); continue; }
    if (r.status === 401 && attempt === 0) { tok = { value: null, exp: 0 }; continue; }
    if (r.status === 404) return null;
    if (!r.ok) { const j = await r.json().catch(() => ({})); const e = new HttpError(502, `SharePoint answered with an error (${r.status}${j?.error?.code ? ' ' + j.error.code : ''}).`); e.graph = r.status; e.code = j?.error?.code; throw e; }
    return r.status === 204 ? {} : r.json().catch(() => ({}));
  }
}
async function driveId() {
  if (drive) return drive; const s = need(); const u = new URL(s.siteUrl);
  const site = await graph('GET', `/sites/${u.hostname}:${u.pathname}`); if (!site?.id) throw new HttpError(502, 'SharePoint could not find that site. Check MS_SITE_URL.');
  const drives = (await graph('GET', `/sites/${site.id}/drives`))?.value || []; const d = drives.find((x) => x.name.toLowerCase() === s.library.toLowerCase());
  if (!d) throw new HttpError(502, `The site has no document library named "${s.library}". Libraries here: ${drives.map((x) => x.name).join(', ') || 'none'}.`);
  drive = d.id; return drive;
}
async function children(parentId) {
  const d = await driveId(); const out = []; let next = `/drives/${d}/${parentId === 'root' ? 'root' : 'items/' + parentId}/children?$top=200&$select=id,name,folder,webUrl`;
  for (let i = 0; i < 20 && next; i++) { const r = await graph('GET', next, { absolute: next.startsWith('http') }); if (!r) break; out.push(...(r.value || [])); next = r['@odata.nextLink'] || null; }
  return out;
}
const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Finds a folder by name under a parent (ignoring case and punctuation) or creates it. `alsoMatch` lets a caller accept an older folder name (for example the same job before it had a P number).
export async function ensureFolder(parentId, name, { alsoMatch = (n) => false } = {}) {
  const d = await driveId(), clean = cleanName(name); if (!clean) throw new HttpError(400, 'A folder name is empty.');
  const kids = (await children(parentId)).filter((c) => c.folder);
  const hit = kids.find((c) => key(c.name) === key(clean)) || kids.find((c) => alsoMatch(c.name));
  if (hit) return { id: hit.id, name: hit.name, webUrl: hit.webUrl, existed: true };
  try {
    const r = await graph('POST', `/drives/${d}/${parentId === 'root' ? 'root' : 'items/' + parentId}/children`, { body: { name: clean, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' } });
    return { id: r.id, name: r.name, webUrl: r.webUrl, existed: false };
  } catch (e) {
    if (e.code === 'nameAlreadyExists' || e.graph === 409) { const again = (await children(parentId)).find((c) => key(c.name) === key(clean)); if (again) return { id: again.id, name: again.name, webUrl: again.webUrl, existed: true }; }
    throw e;
  }
}
// Walks root -> year -> GC -> project folder, creating what is missing, then the standard sub-folders.
export async function ensureProjectFolder({ year, gc, folderName, alsoMatch }) {
  const s = need(); let parent = 'root', path = [];
  for (const seg of [...s.root, String(year), gc]) { const f = await ensureFolder(parent, seg); parent = f.id; path.push(f.name); }
  const proj = await ensureFolder(parent, folderName, { alsoMatch }); path.push(proj.name);
  const subs = {}; for (const name of FOLDERS) { const f = await ensureFolder(proj.id, name); subs[name] = f.id; }
  return { id: proj.id, name: proj.name, webUrl: proj.webUrl, path, subs, existed: proj.existed };
}
export async function renameItem(itemId, name) {
  const d = await driveId(); const r = await graph('PATCH', `/drives/${d}/items/${itemId}`, { body: { name: cleanName(name) } });
  if (!r) throw new HttpError(404, 'That SharePoint folder no longer exists.'); return { id: r.id, name: r.name, webUrl: r.webUrl };
}
// Uploads a file into a folder. Files over 4 MB go up in pieces.
export async function uploadFile(folderId, filename, bytes, mime = 'application/octet-stream') {
  const d = await driveId(), name = cleanName(filename) || 'file', base = `/drives/${d}/items/${folderId}:/${encodeURIComponent(name)}:`;
  if (bytes.length <= 4 * 1024 * 1024) { const r = await graph('PUT', base + '/content?@microsoft.graph.conflictBehavior=rename', { body: bytes, raw: true, headers: { 'content-type': mime } }); return { id: r.id, name: r.name, webUrl: r.webUrl }; }
  const sess = await graph('POST', base + '/createUploadSession', { body: { item: { '@microsoft.graph.conflictBehavior': 'rename' } } }); const chunk = 10 * 327680; let last = null;
  for (let at = 0; at < bytes.length; at += chunk) {
    const part = bytes.subarray(at, Math.min(bytes.length, at + chunk));
    const r = await gfetch(sess.uploadUrl, { method: 'PUT', headers: { 'content-length': String(part.length), 'content-range': `bytes ${at}-${at + part.length - 1}/${bytes.length}` }, body: part });
    if (!r.ok && r.status !== 202) throw new HttpError(502, `SharePoint stopped the upload (${r.status}).`); if (r.status !== 202) last = await r.json().catch(() => null);
  }
  return { id: last?.id, name: last?.name ?? name, webUrl: last?.webUrl };
}
// Same as uploadFile, but reads the file from disk in pieces, so a large plan set never has to sit in memory.
export async function uploadFromPath(folderId, filename, filePath, size, mime = 'application/octet-stream') {
  const d = await driveId(), name = cleanName(filename) || 'file', base = `/drives/${d}/items/${folderId}:/${encodeURIComponent(name)}:`;
  if (size <= 4 * 1024 * 1024) return uploadFile(folderId, filename, await fs.promises.readFile(filePath), mime);
  const sess = await graph('POST', base + '/createUploadSession', { body: { item: { '@microsoft.graph.conflictBehavior': 'rename' } } }), chunk = 10 * 327680, fh = await fs.promises.open(filePath, 'r'); let last = null;
  try {
    for (let at = 0; at < size; at += chunk) {
      const len = Math.min(chunk, size - at), buf = Buffer.alloc(len); await fh.read(buf, 0, len, at);
      const r = await gfetch(sess.uploadUrl, { method: 'PUT', headers: { 'content-length': String(len), 'content-range': `bytes ${at}-${at + len - 1}/${size}` }, body: buf });
      if (!r.ok && r.status !== 202) throw new HttpError(502, `SharePoint stopped the upload (${r.status}).`); if (r.status !== 202) last = await r.json().catch(() => null);
    }
  } finally { await fh.close(); }
  return { id: last?.id, name: last?.name ?? name, webUrl: last?.webUrl };
}
// Names of the sub-folders at a path below the library root (empty if the path does not exist yet).
export async function listFolderNames(segments) {
  let parent = 'root';
  for (const seg of segments) { const hit = (await children(parent)).find((c) => c.folder && key(c.name) === key(seg)); if (!hit) return []; parent = hit.id; }
  return (await children(parent)).filter((c) => c.folder).map((c) => c.name);
}
// Files (not folders) whose name passes `match`, looking down at most `depth` levels of sub-folders.
export async function findFiles(folderId, match, depth = 3) {
  const out = []; const walk = async (id, d) => { for (const c of await children(id)) { if (c.folder) { if (d > 0) await walk(c.id, d - 1); } else if (match(c.name)) out.push({ id: c.id, name: c.name, webUrl: c.webUrl }); } };
  await walk(folderId, depth); return out;
}
export async function listFolder(itemId) { return (await children(itemId)).map((c) => ({ id: c.id, name: c.name, folder: !!c.folder, webUrl: c.webUrl })); }
export async function status() {
  const s = settings(); if (!configured()) return { configured: false, connected: false, needs: ['MS_TENANT_ID', 'MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'MS_SITE_URL'].filter((k) => !process.env[k]) };
  try { resetCache(); const d = await driveId(); const root = await graph('GET', `/drives/${d}/root?$select=webUrl,name`); return { configured: true, connected: true, siteUrl: s.siteUrl, library: s.library, root: s.root.join('/'), webUrl: root?.webUrl ?? null }; }
  catch (e) { return { configured: true, connected: false, siteUrl: s.siteUrl, library: s.library, error: e instanceof HttpError ? e.message : 'Could not reach SharePoint.' }; }
}
