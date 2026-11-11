import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { q, tx } from './db.js';
import { bad, text, dateStr, httpsUrl, HttpError } from './http.js';
import * as folders from './folders.js';
import { afterVendorUpload, readVendorDocument } from './subVerify.js';

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

// The same checks saveFile makes (type, contents), without saving anything: used when a file is only being read.
export function checkFile(bytes, filename) {
  const t = TYPES[path.extname(String(filename || '')).toLowerCase()];
  if (!t) throw bad('That file type is not allowed. Use PDF, PNG, JPG, DOCX, XLSX, CSV or TXT.');
  if (!bytes.length) throw bad('The file is empty.');
  if (!t[1](bytes)) throw bad('The file contents do not match its type.');
  return { mime: t[0] };
}
export const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
// The earlier copy of a file with this fingerprint: a document (any project) or a file kept on a lead.
export async function findDuplicate(sha) {
  const [d] = await q(`SELECT d.id, d.name, d.category, d.created_at, d.project_id, p.name AS project FROM documents d LEFT JOIN projects p ON p.id=d.project_id WHERE d.sha256=$1 ORDER BY d.created_at LIMIT 1`, [sha]);
  if (d) return { kind: 'document', ...d };
  const [f] = await q(`SELECT f.id, f.name, f.kind AS category, f.created_at, o.name AS lead FROM opportunity_files f JOIN opportunities o ON o.id=f.opportunity_id WHERE f.sha256=$1 ORDER BY f.created_at LIMIT 1`, [sha]);
  return f ? { kind: 'lead', ...f } : null;
}
export class DuplicateFile extends HttpError {
  constructor(d) {
    const day = d.created_at instanceof Date ? d.created_at.toISOString().slice(0, 10) : String(d.created_at || '').slice(0, 10), where = d.project ? ` in project ${d.project}` : d.lead ? ` on lead ${d.lead}` : '';
    super(409, `This file is already saved${d.name ? ` as "${d.name}"` : ''}${where}${day ? `, added ${day}` : ''}. The same file is not kept twice.`); this.existing = d;
  }
}
// With reuse, a file that is already saved is not stored again: the caller gets { duplicate } and carries on with the saved one (reading a contract again, for example).
export async function saveFile(bytes, filename, { reuse = false } = {}) {
  const ext = path.extname(String(filename || '')).toLowerCase(); const t = TYPES[ext];
  if (!t) throw bad('That file type is not allowed. Use PDF, PNG, JPG, DOCX, XLSX, CSV or TXT.');
  if (!bytes.length) throw bad('The file is empty.');
  if (!t[1](bytes)) throw bad('The file contents do not match its type.');
  const sha = sha256(bytes), dup = await findDuplicate(sha);
  if (dup) { if (reuse && dup.kind === 'document') return { duplicate: dup, sha256: sha, mime: t[0], size: bytes.length }; throw new DuplicateFile(dup); }
  await fs.promises.mkdir(UPLOAD_DIR, { recursive: true });
  const key = crypto.randomBytes(16).toString('hex') + ext;
  await fs.promises.writeFile(path.join(UPLOAD_DIR, key), bytes, { mode: 0o600 });
  return { key, mime: t[0], size: bytes.length, sha256: sha };
}
// The id of the saved document to carry on with, when saveFile found the file already saved (never one that belongs to a different project).
export function reusedId(f, projectId = null) {
  if (!f.duplicate) return null;
  if (f.duplicate.project_id && projectId && f.duplicate.project_id !== projectId) throw new DuplicateFile(f.duplicate);
  return f.duplicate.id;
}
// A large upload that was streamed to a temp file: check the name and the first bytes, then move it into storage.
export async function adoptFile(tmpPath, filename, allow = ['.pdf', '.zip']) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  const check = { '.pdf': ['application/pdf', (b) => b.subarray(0, 5).toString() === '%PDF-'], '.zip': ['application/zip', (b) => b.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) || b.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x05, 0x06]))] }[ext];
  if (!check || !allow.includes(ext)) throw bad('That file type is not allowed here. Use a ZIP or PDF.');
  const fh = await fs.promises.open(tmpPath, 'r'); const head = Buffer.alloc(8); const { bytesRead } = await fh.read(head, 0, 8, 0); await fh.close();
  const size = (await fs.promises.stat(tmpPath)).size; if (!size) throw bad('The file is empty.'); if (!check[1](head.subarray(0, bytesRead))) throw bad('The file contents do not match its type.');
  const hash = crypto.createHash('sha256'); for await (const chunk of fs.createReadStream(tmpPath)) hash.update(chunk);
  const sha = hash.digest('hex'), dup = await findDuplicate(sha); if (dup) throw new DuplicateFile(dup);
  const key = crypto.randomBytes(16).toString('hex') + ext; await fs.promises.rename(tmpPath, path.join(UPLOAD_DIR, key)); await fs.promises.chmod(path.join(UPLOAD_DIR, key), 0o600).catch(() => {});
  return { key, mime: check[0], size, sha256: sha };
}
export async function uploadDocument(user, { category, name, filename, bytes, projectId, subcontractorId, employeeId, expiresOn }) {
  if (!CATEGORIES.includes(category)) throw bad('Choose a document category.');
  const exp = dateStr(expiresOn, 'Expiration date', category === 'COI');
  const f = await saveFile(bytes, filename);
  try {
    return await tx(async (t) => {
      if (projectId && !(await t('SELECT 1 FROM projects WHERE id=$1', [projectId])).length) throw bad('Project not found.');
      const [d] = await t('INSERT INTO documents(category,name,storage_key,mime,size,project_id,expires_on,created_by,sha256) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
        [category, text(name, 'Name', { max: 200, required: false }) || filename, f.key, f.mime, f.size, projectId || null, exp, user.id, f.sha256]);
      if (employeeId) {   // a 1099 crew member's W-9: private (tax numbers), replaces the one before
        if (category !== 'W-9') throw bad('Only a W-9 attaches to an employee.');
        await t('UPDATE documents SET restricted=true WHERE id=$1', [d.id]);
        if (!(await t('UPDATE employees SET w9_document_id=$2 WHERE id=$1 RETURNING id', [employeeId, d.id])).length) throw new HttpError(404, 'Employee not found.');
      }
      if (subcontractorId) {
        if (!VENDOR_DOC[category]) throw bad('Only W-9, COI and Exemption documents attach to a vendor.');
        if (!(await t(`UPDATE subcontractors SET ${VENDOR_DOC[category]}=$2 WHERE id=$1 RETURNING id`, [subcontractorId, d.id])).length) throw new HttpError(404, 'Vendor not found.');
      }
      return { id: d.id };
    }).then(async (r) => {
      if (projectId) { const [pr] = await q('SELECT ref_code FROM projects WHERE id=$1', [projectId]); if (pr?.ref_code) await q('UPDATE documents SET ref_code=$2 WHERE id=$1', [r.id, pr.ref_code]); const up = await folders.pushProjectFile(projectId, { category, filename, bytes, mime: f.mime }); if (up?.webUrl) await q('UPDATE documents SET sp_url=$2 WHERE id=$1', [r.id, up.webUrl]); }
      if (employeeId) { try { return { ...r, read: await readVendorDocument(user, r.id, bytes, f.mime, filename) }; } catch { /* the file is saved either way */ } }   // the address on it is read; it is not copied to SharePoint
      if (subcontractorId) { try { const x = await afterVendorUpload(user, { docId: r.id, subId: subcontractorId, category, filename, bytes, mime: f.mime }); return { ...r, ...x }; } catch { /* the file is saved either way */ } }   // copied to the subcontractor's SharePoint folder; the address on it is read
      return r;
    });
  } catch (e) { await fs.promises.rm(path.join(UPLOAD_DIR, f.key), { force: true }); throw e; }
}
export async function addLink(user, { category, name, url, projectId, expiresOn }) {
  if (!CATEGORIES.includes(category)) throw bad('Choose a document category.');
  const u = httpsUrl(url, 'Link'); if (!u) throw bad('Enter the document link.');
  const [same] = await q('SELECT d.name, d.created_at, p.name AS project FROM documents d LEFT JOIN projects p ON p.id=d.project_id WHERE d.url=$1 AND d.project_id IS NOT DISTINCT FROM $2 LIMIT 1', [u, projectId || null]); if (same) throw new DuplicateFile({ ...same });   // the same link is not kept twice either
  const [d] = await q('INSERT INTO documents(category,name,url,project_id,expires_on,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [category, text(name, 'Name', { max: 200, required: false }) || `${category} link`, u, projectId || null, dateStr(expiresOn, 'Expiration date', category === 'COI'), user.id]);
  return { id: d.id };
}
export const listDocuments = ({ projectId, category } = {}) => {
  const w = [`d.category <> 'Employee ID'`, 'NOT d.restricted'], v = [];
  // A project's documents: everything uploaded to it, plus every file tied to its money and paperwork: the contract, client invoices, the receipts
  // and invoices on its costs, subcontractor bills, the plans read for it, and the W-9 and insurance of the subcontractors working on it.
  if (projectId) {
    v.push(projectId); const P = `$${v.length}`;
    w.push(`(d.project_id=${P}
      OR d.id = (SELECT contract_document_id FROM projects WHERE id=${P})
      OR d.id IN (SELECT document_id FROM client_invoices WHERE project_id=${P} AND document_id IS NOT NULL)
      OR d.id IN (SELECT si.document_id FROM sub_invoices si JOIN sub_commitments c ON c.id=si.commitment_id WHERE c.project_id=${P} AND si.document_id IS NOT NULL)
      OR d.id IN (SELECT si.document_id FROM supplier_invoices si JOIN supplier_allocations sa ON sa.supplier_invoice_id=si.id WHERE sa.project_id=${P} AND si.document_id IS NOT NULL)
      OR d.id IN (SELECT tr.document_id FROM takeoff_runs tr JOIN opportunities o ON o.id=tr.opportunity_id WHERE o.project_id=${P} AND tr.document_id IS NOT NULL)
      OR d.id IN (SELECT x.doc FROM sub_commitments c JOIN subcontractors s ON s.id=c.subcontractor_id CROSS JOIN LATERAL (VALUES (s.w9_document_id), (s.coi_document_id), (s.exemption_document_id)) AS x(doc) WHERE c.project_id=${P} AND x.doc IS NOT NULL))`);
  }
  if (category) { v.push(category); w.push(`d.category=$${v.length}`); }
  return q(`SELECT d.id, d.category, d.name, d.url, d.expires_on, d.size, d.created_at, d.project_id, (d.storage_key IS NOT NULL) AS has_file, u.name AS uploaded_by FROM documents d LEFT JOIN app_users u ON u.id=d.created_by WHERE ${w.join(' AND ')} ORDER BY d.created_at DESC LIMIT 500`, v);
};
// Files saved before fingerprints existed get theirs now (runs in the background at start).
export async function backfillHashes() {
  let n = 0;
  const sets = [['documents', await q('SELECT id, storage_key FROM documents WHERE sha256 IS NULL AND storage_key IS NOT NULL')], ['opportunity_files', await q('SELECT id, storage_key FROM opportunity_files WHERE sha256 IS NULL AND storage_key IS NOT NULL')]];
  for (const [table, rows] of sets) {
    for (const r of rows) {
      try { const hash = crypto.createHash('sha256'); for await (const c of fs.createReadStream(path.join(UPLOAD_DIR, path.basename(r.storage_key)))) hash.update(c); await q(`UPDATE ${table} SET sha256=$2 WHERE id=$1`, [r.id, hash.digest('hex')]); n++; } catch { /* a file missing from storage keeps no fingerprint */ }
    }
  }
  return n;
}
export async function getFile(id) {
  const [d] = await q('SELECT storage_key, mime, name, category, project_id, restricted FROM documents WHERE id=$1', [id]);
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
    await t('UPDATE employees SET w9_document_id=NULL WHERE w9_document_id=$1', [id]);
    await t('UPDATE supplier_invoices SET document_id=NULL WHERE document_id=$1', [id]);
    await t('DELETE FROM documents WHERE id=$1', [id]);
  }).catch((e) => { throw e.code === '23503' ? new HttpError(409, 'This document is still referenced elsewhere.') : e; });
  if (d.storage_key) await fs.promises.rm(path.join(UPLOAD_DIR, path.basename(d.storage_key)), { force: true });
}
