import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { q, tx } from './db.js';
import { bad, text, dateStr, httpsUrl, HttpError } from './http.js';

export const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || 'uploads');
export const CATEGORIES = ['Contract', 'Proposal', 'COI', 'W-9', 'Exemption', 'Approved CO', 'Invoice', 'Client Invoice', 'Vendor Invoice', 'Receipt', 'Plans', 'Notice to Owner', 'Supplier Statement', 'Employee ID', 'Other'];
const VENDOR_DOC = { 'W-9': 'w9_document_id', COI: 'coi_document_id', Exemption: 'exemption_document_id' };
// Only these file types are accepted, and the first bytes must match the type, not just the name.
const TYPES = {
  '.pdf': ['application/pdf', (b) => b.subarray(0, 5).toString() === '%PDF-'],
  '.png': ['image/png', (b) => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))],
  '.jpg': ['image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff], '.jpeg': ['image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', (b) => b.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))],
  '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', (b) => b.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))],
  '.csv': ['text/csv', (b) => !b.includes(0)], '.txt': ['text/plain', (b) => !b.includes(0)],
};
export const mimeOf = (name) => TYPES[path.extname(name).toLowerCase()]?.[0] ?? null;

export async function saveFile(bytes, filename) {
  const ext = path.extname(String(filename || '')).toLowerCase(); const t = TYPES[ext];
  if (!t) throw bad('That file type is not allowed. Use PDF, PNG, JPG, DOCX, XLSX, CSV or TXT.');
  if (!bytes.length) throw bad('The file is empty.');
  if (!t[1](bytes)) throw bad('The file contents do not match its type.');
  await fs.promises.mkdir(UPLOAD_DIR, { recursive: true });
  const key = crypto.randomBytes(16).toString('hex') + ext;
  await fs.promises.writeFile(path.join(UPLOAD_DIR, key), bytes, { mode: 0o600 });
  return { key, mime: t[0], size: bytes.length };
}
export async function uploadDocument(user, { category, name, filename, bytes, projectId, subcontractorId, expiresOn }) {
  if (!CATEGORIES.includes(category)) throw bad('Choose a document category.');
  const exp = dateStr(expiresOn, 'Expiration date', category === 'COI');
  const f = await saveFile(bytes, filename);
  try {
    return await tx(async (t) => {
      if (projectId && !(await t('SELECT 1 FROM projects WHERE id=$1', [projectId])).length) throw bad('Project not found.');
      const [d] = await t('INSERT INTO documents(category,name,storage_key,mime,size,project_id,expires_on,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
        [category, text(name, 'Name', { max: 200, required: false }) || filename, f.key, f.mime, f.size, projectId || null, exp, user.id]);
      if (subcontractorId) {
        if (!VENDOR_DOC[category]) throw bad('Only W-9, COI and Exemption documents attach to a vendor.');
        if (!(await t(`UPDATE subcontractors SET ${VENDOR_DOC[category]}=$2 WHERE id=$1 RETURNING id`, [subcontractorId, d.id])).length) throw new HttpError(404, 'Vendor not found.');
      }
      return { id: d.id };
    });
  } catch (e) { await fs.promises.rm(path.join(UPLOAD_DIR, f.key), { force: true }); throw e; }
}
export async function addLink(user, { category, name, url, projectId, expiresOn }) {
  if (!CATEGORIES.includes(category)) throw bad('Choose a document category.');
  const u = httpsUrl(url, 'Link'); if (!u) throw bad('Enter the document link.');
  const [d] = await q('INSERT INTO documents(category,name,url,project_id,expires_on,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [category, text(name, 'Name', { max: 200, required: false }) || `${category} link`, u, projectId || null, dateStr(expiresOn, 'Expiration date', category === 'COI'), user.id]);
  return { id: d.id };
}
export const listDocuments = ({ projectId, category } = {}) => {
  const w = [`d.category <> 'Employee ID'`], v = [];
  if (projectId) { v.push(projectId); w.push(`d.project_id=$${v.length}`); }
  if (category) { v.push(category); w.push(`d.category=$${v.length}`); }
  return q(`SELECT d.id, d.category, d.name, d.url, d.expires_on, d.size, d.created_at, d.project_id, (d.storage_key IS NOT NULL) AS has_file, u.name AS uploaded_by FROM documents d LEFT JOIN app_users u ON u.id=d.created_by WHERE ${w.join(' AND ')} ORDER BY d.created_at DESC LIMIT 500`, v);
};
export async function getFile(id) {
  const [d] = await q('SELECT storage_key, mime, name, category, project_id FROM documents WHERE id=$1', [id]);
  if (!d || !d.storage_key) throw new HttpError(404, 'File not found.');
  const file = path.join(UPLOAD_DIR, path.basename(d.storage_key));
  if (!fs.existsSync(file)) throw new HttpError(404, 'File is missing from storage.');
  return { ...d, file };
}
export async function deleteDocument(id) {
  const [d] = await q('SELECT storage_key FROM documents WHERE id=$1', [id]); if (!d) throw new HttpError(404, 'Document not found.');
  await tx(async (t) => {
    for (const c of Object.values(VENDOR_DOC)) await t(`UPDATE subcontractors SET ${c}=NULL WHERE ${c}=$1`, [id]);
    await t('UPDATE projects SET contract_document_id=NULL WHERE contract_document_id=$1', [id]);
    await t('UPDATE supplier_invoices SET document_id=NULL WHERE document_id=$1', [id]);
    await t('DELETE FROM documents WHERE id=$1', [id]);
  }).catch((e) => { throw e.code === '23503' ? new HttpError(409, 'This document is still referenced elsewhere.') : e; });
  if (d.storage_key) await fs.promises.rm(path.join(UPLOAD_DIR, path.basename(d.storage_key)), { force: true });
}
