// The plan PDFs a lead already has, wherever they are: uploaded to the app, inside an uploaded zip, or sitting in the lead's SharePoint
// plans folder (01. DL). They are found once, sent to the AI service once (each file is remembered by its fingerprint), and used by the
// estimating conversation. Nothing here changes or deletes a plan file.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { q } from './db.js';
import { HttpError } from './http.js';
import { UPLOAD_DIR } from './documents.js';
import * as SP from './sharepoint.js';
import * as folders from './folders.js';
import { uploadAiFile } from './ai.js';

const MAX_PDF = 480 * 1024 * 1024;          // the AI service takes files up to 500 MB
const isPdfName = (n) => /\.pdf$/i.test(n) && !/(^|\/)(__MACOSX\/|\._)/.test(n) && !path.basename(n).startsWith('.');
const tmpDir = async () => { const d = path.join(UPLOAD_DIR, '.plans-tmp'); await fs.promises.mkdir(d, { recursive: true }); return d; };
const tmpFile = async (ext) => path.join(await tmpDir(), crypto.randomBytes(10).toString('hex') + ext);
const rm = (p) => fs.promises.rm(p, { force: true }).catch(() => {});
async function sha256File(p) { const h = crypto.createHash('sha256'); await pipeline(fs.createReadStream(p), h); return h.digest('hex'); }
async function startsWithPdf(p) { const fd = await fs.promises.open(p, 'r'); try { const b = Buffer.alloc(5); await fd.read(b, 0, 5, 0); return b.toString() === '%PDF-'; } finally { await fd.close(); } }

// ---------------------------------------------------------------- reading a zip from disk without loading it into memory
// Returns the PDF entries of a zip: [{ name, size, method, compSize, offset }]. Handles the large-file (zip64) form.
export const zipPdfEntries = (zipPath) => zipEntries(zipPath, isPdfName);
// The entries of a zip whose name passes `want`.
export async function zipEntries(zipPath, want) {
  const fd = await fs.promises.open(zipPath, 'r');
  try {
    const { size } = await fd.stat(), tailLen = Math.min(size, 66000), tail = Buffer.alloc(tailLen); await fd.read(tail, 0, tailLen, size - tailLen);
    let e = -1; for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break; }
    if (e < 0) throw new HttpError(400, 'That zip file could not be opened.');
    let count = tail.readUInt16LE(e + 10), cdSize = tail.readUInt32LE(e + 12), cdOff = tail.readUInt32LE(e + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {   // zip64: the real numbers are in a second record
      const loc = e - 20; if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) throw new HttpError(400, 'That zip file could not be opened.');
      const recOff = Number(tail.readBigUInt64LE(loc + 8)), rec = Buffer.alloc(56); await fd.read(rec, 0, 56, recOff);
      if (rec.readUInt32LE(0) !== 0x06064b50) throw new HttpError(400, 'That zip file could not be opened.');
      count = Number(rec.readBigUInt64LE(32)); cdSize = Number(rec.readBigUInt64LE(40)); cdOff = Number(rec.readBigUInt64LE(48));
    }
    if (cdSize > 64 * 1024 * 1024) throw new HttpError(400, 'That zip file has too many files in it.');
    const cd = Buffer.alloc(cdSize); await fd.read(cd, 0, cdSize, cdOff); const out = [];
    for (let p = 0, n = 0; n < count && p + 46 <= cd.length; n++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const method = cd.readUInt16LE(p + 10), nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commentLen = cd.readUInt16LE(p + 32);
      let compSize = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24), offset = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');
      for (let x = p + 46 + nameLen, end = x + extraLen; x + 4 <= end;) {   // zip64 sizes live in an extra field, in this order
        const id = cd.readUInt16LE(x), len = cd.readUInt16LE(x + 2); let y = x + 4;
        if (id === 1) { if (usize === 0xffffffff) { usize = Number(cd.readBigUInt64LE(y)); y += 8; } if (compSize === 0xffffffff) { compSize = Number(cd.readBigUInt64LE(y)); y += 8; } if (offset === 0xffffffff) offset = Number(cd.readBigUInt64LE(y)); }
        x += 4 + len;
      }
      if (!name.endsWith('/') && want(name) && (method === 0 || method === 8)) out.push({ name, size: usize, method, compSize, offset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  } finally { await fd.close(); }
}
// Writes one entry of a zip to `dest`.
export async function zipExtract(zipPath, entry, dest) {
  const fd = await fs.promises.open(zipPath, 'r');
  try {
    const lh = Buffer.alloc(30); await fd.read(lh, 0, 30, entry.offset); if (lh.readUInt32LE(0) !== 0x04034b50) throw new HttpError(400, 'That zip file could not be read.');
    const start = entry.offset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
    const src = fs.createReadStream(zipPath, { start, end: start + entry.compSize - 1 });
    if (entry.compSize === 0) { await fs.promises.writeFile(dest, Buffer.alloc(0)); return; }
    if (entry.method === 8) await pipeline(src, zlib.createInflateRaw(), fs.createWriteStream(dest, { mode: 0o600 })); else await pipeline(src, fs.createWriteStream(dest, { mode: 0o600 }));
  } finally { await fd.close(); }
}

// ---------------------------------------------------------------- what plans a lead has
// The plans files on the lead, without opening them: [{ key, name, size, where, zip }]. `key` is stable for the same file.
export async function planSources(opportunityId) {
  const [o] = await q('SELECT id, sp_item_id FROM opportunities WHERE id=$1', [opportunityId]); if (!o) throw new HttpError(404, 'Opportunity not found.');
  const rows = await q(`SELECT id, name, size, storage_key, sp_url FROM opportunity_files WHERE opportunity_id=$1 AND kind='Plans' AND sp_removed_at IS NULL ORDER BY created_at`, [opportunityId]);
  const out = [], seen = new Set();
  let spFiles = null; const sp = async () => { if (spFiles) return spFiles; spFiles = [];
    if (folders.enabled() && o.sp_item_id) { try { const dl = (await SP.listFolder(o.sp_item_id)).find((k) => k.folder && k.name === '01. DL'); if (dl) spFiles = await SP.findFiles(dl.id, (n) => /\.(pdf|zip)$/i.test(n), 3); } catch { spFiles = []; } }
    return spFiles; };
  for (const r of rows) {
    const zip = /\.zip$/i.test(r.name); if (!zip && !/\.pdf$/i.test(r.name)) continue;
    if (r.storage_key) out.push({ key: 'file:' + r.id, name: r.name, size: Number(r.size) || 0, where: 'app', zip, local: path.join(UPLOAD_DIR, path.basename(r.storage_key)) });
    else { const hit = (await sp()).find((f) => f.name.toLowerCase() === r.name.toLowerCase()); if (hit) out.push({ key: 'sp:' + hit.id, name: r.name, size: Number(r.size) || 0, where: 'SharePoint', zip, spId: hit.id }); else out.push({ key: 'file:' + r.id, name: r.name, size: Number(r.size) || 0, where: 'SharePoint', zip, missing: true }); }
    seen.add(r.name.toLowerCase());
  }
  // plans dropped straight into the SharePoint folder (never uploaded through the app)
  for (const f of await sp()) if (!seen.has(f.name.toLowerCase())) { seen.add(f.name.toLowerCase()); out.push({ key: 'sp:' + f.id, name: f.name, size: 0, where: 'SharePoint', zip: /\.zip$/i.test(f.name), spId: f.id }); }
  return out;
}

// Makes sure every plan PDF of the lead is at the AI service, and returns them: { docs: [{ sha256, name, size, fileId }], problems: [text] }.
// A file already sent (same fingerprint) is not sent again. `onStep` is told what is happening, for the screen.
export async function preparePlans(opportunityId, onStep = () => {}) {
  const sources = await planSources(opportunityId), docs = [], problems = [], have = new Set();
  const known = new Map((await q('SELECT source_key, docs FROM plan_sources WHERE opportunity_id=$1', [opportunityId])).map((r) => [r.source_key, r.docs]));
  const add = async (list) => { for (const d of list) { if (have.has(d.sha256)) continue; const [f] = await q('SELECT file_id FROM ai_files WHERE sha256=$1', [d.sha256]); if (!f) return false; have.add(d.sha256); docs.push({ ...d, fileId: f.file_id }); } return true; };
  const sendPdf = async (file, name) => {
    if (!(await startsWithPdf(file))) { problems.push(`${name} is not a readable PDF.`); return null; }
    const { size } = await fs.promises.stat(file); if (size > MAX_PDF) { problems.push(`${name} is too large for the AI to read (${Math.round(size / 1048576)} MB).`); return null; }
    const sha256 = await sha256File(file), [f] = await q('SELECT file_id FROM ai_files WHERE sha256=$1', [sha256]);
    if (!f) { onStep(`Sending ${name} to the AI…`); const fileId = await uploadAiFile(file, name); await q('INSERT INTO ai_files(sha256,file_id,name,size) VALUES ($1,$2,$3,$4) ON CONFLICT (sha256) DO UPDATE SET file_id=$2', [sha256, fileId, name.slice(0, 200), size]); }
    return { sha256, name: name.slice(0, 200), size };
  };
  for (const s of sources) {
    if (known.has(s.key) && await add(known.get(s.key))) continue;   // already worked out and still at the AI service
    if (s.missing) { problems.push(`${s.name} is recorded on this lead but was not found in the SharePoint plans folder.`); continue; }
    let file = s.local, temp = null;
    try {
      if (!file) { onStep(`Getting ${s.name} from SharePoint…`); temp = file = await tmpFile(s.zip ? '.zip' : '.pdf'); await SP.downloadToFile(s.spId, file); }
      else if (!fs.existsSync(file)) { problems.push(`${s.name} is missing from storage.`); continue; }
      const found = [];
      if (s.zip) {
        const entries = await zipPdfEntries(file); if (!entries.length) problems.push(`${s.name} has no PDF plans inside it.`);
        for (const e of entries) { const out = await tmpFile('.pdf'); try { await zipExtract(file, e, out); const d = await sendPdf(out, path.basename(e.name)); if (d) found.push(d); } finally { await rm(out); } }
      } else { const d = await sendPdf(file, s.name); if (d) found.push(d); }
      await q(`INSERT INTO plan_sources(opportunity_id,source_key,docs) VALUES ($1,$2,$3) ON CONFLICT (opportunity_id,source_key) DO UPDATE SET docs=$3`, [opportunityId, s.key, JSON.stringify(found)]);
      await add(found);
    } catch (e) { problems.push(`${s.name}: ${e instanceof HttpError ? e.message : 'could not be read.'}`); }
    finally { if (temp) await rm(temp); }
  }
  return { docs, problems, sources: sources.length };
}
// When the AI service says a plan file is gone (deleted or expired there), forget where the lead's files were so they are sent again.
export async function forgetPlans(opportunityId) {
  const rows = await q('DELETE FROM plan_sources WHERE opportunity_id=$1 RETURNING docs', [opportunityId]);
  const shas = rows.flatMap((r) => (r.docs || []).map((d) => d.sha256)); if (shas.length) await q('DELETE FROM ai_files WHERE sha256 = ANY($1::text[])', [shas]);
}
