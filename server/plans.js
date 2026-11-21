// The plan PDFs a lead already has, wherever they are: uploaded to the app, inside an uploaded zip, or sitting in the lead's SharePoint
// plans folder (01. DL). They are found once, sent to the AI service once (each file is remembered by its fingerprint), and used by the
// estimating conversation. Nothing here changes or deletes a plan file.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import os from 'node:os';
import { pipeline } from 'node:stream/promises';
import { q } from './db.js';
import { HttpError } from './http.js';
import { UPLOAD_DIR } from './documents.js';
import * as SP from './sharepoint.js';
import * as folders from './folders.js';
import { uploadAiFile } from './ai.js';
import { PDFDocument } from 'pdf-lib';

// What to do about a PDF the AI service could not read: a very large plan set has to be split; anything else re-saved.
export const BIG_PDF = 30 * 1024 * 1024;
export const fixFor = (name, size) => (Number(size) > BIG_PDF ? `the AI service could not read it in one piece (${Math.round(Number(size) / 1048576)} MB). Split it into smaller PDFs, for example the architectural sheets and the MEP sheets separately or about 50 sheets each, and upload those.` : 'the AI service could not read this PDF. Open it, save it again as a PDF (Print to PDF), and upload the new copy.');
const MAX_PDF = 480 * 1024 * 1024;
// A plan set the AI service cannot take in one piece is sent as parts: a PDF over 30 MB or over 100 pages is cut into parts of up to 40
// pages, and a part still over 30 MB is cut again (down to single pages). The AI reads up to 600 pages in one conversation turn.
export let roomToSplit = (size) => { const c = typeof process.constrainedMemory === 'function' ? Number(process.constrainedMemory()) : 0, limit = c > 0 && c < os.totalmem() ? c : os.totalmem(); return process.memoryUsage().rss + size * 3.2 < limit * 0.85; };
export const setRoomToSplit = (f) => { roomToSplit = f; };   // tests
// ---------------------------------------------------------------- which sheet each page is
// From the set's bookmarks when it has them (Bluebeam and Revit sets usually do), otherwise from the text on the page: the sheet number
// printed largest on it, which is the one in the title block (a "SEE A-5.01" note is smaller). null when a page says nothing readable
// (a scanned sheet, or CAD text drawn as lines).
const SHEET_RE = /^\s*((?:FP|FA|FS|LS|AD|ID|SD|CS|EL|PL|[GTCLADISMPEQK])[-. ]?\d{1,3}(?:[.-]\d{1,3})?[A-Z]?)\b/i;
export const sheetCode = (s) => { const m = SHEET_RE.exec(String(s || '')); return m ? m[1].toUpperCase() : null; };
export const discipline = (code) => (code ? code.match(/^[A-Z]+/)[0].replace(/^(AD|ID)$/, 'A').replace(/^SD$/, 'S').replace(/^(CS|T)$/, 'G').replace(/^(D|I|LS)$/, 'A') : null);
export async function sheetMap(filePath) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await fs.promises.readFile(filePath)), isEvalSupported: false, disableFontFace: true, verbosity: 0 }).promise;
  try {
    const out = new Array(doc.numPages).fill(null);
    try { const walk = async (items) => { for (const it of items || []) { let dest = it.dest; if (typeof dest === 'string') dest = await doc.getDestination(dest);
        if (Array.isArray(dest) && dest[0]) { const i = await doc.getPageIndex(dest[0]).catch(() => -1), code = sheetCode(it.title); if (i >= 0 && code && !out[i]) out[i] = code; } await walk(it.items); } };
      await walk(await doc.getOutline()); } catch { /* no usable bookmarks */ }
    for (let i = 0; i < out.length; i++) if (!out[i]) {
      const page = await doc.getPage(i + 1), tc = await page.getTextContent(); let best = null;
      for (const it of tc.items) { const t = String(it.str || '').trim(); if (t.length > 12) continue; const code = sheetCode(t); if (code && code.length >= t.replace(/\s/g, '').length - 1) { const h = Math.abs(it.transform?.[3] || it.height || 0); if (!best || h > best.h) best = { code, h }; } }
      out[i] = best?.code ?? null; page.cleanup();
    }
    return out;
  } finally { await doc.destroy(); }
}
// The owner's rule for a set that has to be split: keep page 1 through the last architectural or structural sheet; what follows (MEP,
// fire protection, specs) is not needed for byOther's estimate and is not sent. Returns the last page index to keep, or null when the
// sheets could not be told apart (then everything is sent).
export function keepThrough(codes) { let last = -1; codes.forEach((c, i) => { if (['A', 'S'].includes(discipline(c))) last = i; }); return last >= 0 ? last : null; }
export const SPLIT_PAGES = 100, PART_PAGES = 40, MAX_TURN_PAGES = 580;          // the AI service takes files up to 500 MB
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
  const rows = await q(`SELECT id, name, size, storage_key, sp_url, sp_item_id, created_at, COALESCE((meta->>'revision')::boolean, false) AS revision FROM opportunity_files WHERE opportunity_id=$1 AND kind='Plans' AND sp_removed_at IS NULL ORDER BY created_at`, [opportunityId]);
  const out = [], seen = new Set(), seenIds = new Set(), sizes = new Map();
  let spFiles = null; const sp = async () => { if (spFiles) return spFiles; spFiles = [];
    if (folders.enabled() && o.sp_item_id) { try { const dl = (await SP.listFolder(o.sp_item_id)).find((k) => k.folder && k.name === '01. DL'); if (dl) spFiles = await SP.findFiles(dl.id, (n) => /\.(pdf|zip)$/i.test(n), 3); } catch { spFiles = []; } }
    return spFiles; };
  for (const r of rows) {
    const zip = /\.zip$/i.test(r.name); if (!zip && !/\.pdf$/i.test(r.name)) continue;
    const mark = { revision: !!r.revision, at: r.created_at };   // a revised set the estimator added to compare against the earlier plans
    if (r.storage_key) out.push({ key: 'file:' + r.id, name: r.name, size: Number(r.size) || 0, where: 'app', zip, local: path.join(UPLOAD_DIR, path.basename(r.storage_key)), ...mark });
    else { const all = await sp(), hit = all.find((f) => r.sp_item_id && f.id === r.sp_item_id) || all.find((f) => f.name.toLowerCase() === r.name.toLowerCase()); if (hit) out.push({ key: 'sp:' + hit.id, name: r.name, size: Number(r.size) || 0, where: 'SharePoint', zip, spId: hit.id, ...mark }); else out.push({ key: 'file:' + r.id, name: r.name, size: Number(r.size) || 0, where: 'SharePoint', zip, missing: true, ...mark }); }
    seen.add(r.name.toLowerCase()); if (r.sp_item_id) seenIds.add(r.sp_item_id); sizes.set(r.name.toLowerCase(), Number(r.size) || 0);
  }
  // plans dropped straight into the SharePoint folder (never uploaded through the app)
  // ...but not SharePoint's own second copy of a file the lead already has ("Plans 1.pdf" next to "Plans.pdf", same size)
  const copyOf = (f) => { const base = f.name.replace(/(?: \d+| \(\d+\))(\.[^.]+)$/, '$1').toLowerCase(); return base !== f.name.toLowerCase() && seen.has(base) && (!f.size || !sizes.get(base) || Number(f.size) === sizes.get(base)); };
  for (const f of await sp()) if (!seen.has(f.name.toLowerCase()) && !seenIds.has(f.id) && !copyOf(f)) { seen.add(f.name.toLowerCase()); out.push({ key: 'sp:' + f.id, name: f.name, size: 0, where: 'SharePoint', zip: /\.zip$/i.test(f.name), spId: f.id }); }
  return out;
}

// Makes sure every plan PDF of the lead is at the AI service, and returns them: { docs: [{ sha256, name, size, fileId }], problems: [text] }.
// A file already sent (same fingerprint) is not sent again. `onStep` is told what is happening, for the screen.
export async function preparePlans(opportunityId, onStep = () => {}) {
  const sources = await planSources(opportunityId), docs = [], problems = [], notes = [], have = new Set();
  const known = new Map((await q('SELECT source_key, docs FROM plan_sources WHERE opportunity_id=$1', [opportunityId])).map((r) => [r.source_key, r.docs]));
  // a large set worked out before parts existed is worked out again (once), so it is sent as parts
  const stale = (list) => list.some((d) => (!d.part && !d.pages && Number(d.size) > BIG_PDF) || (d.part && !d.rule));   // parts made before the keep-through-structural rule are made again
  const add = async (list, s) => { if (stale(list)) return false; for (const d of list) { if (have.has(d.sha256)) continue; const [f] = await q('SELECT file_id, unreadable FROM ai_files WHERE sha256=$1', [d.sha256]); if (!f) return false; have.add(d.sha256);
    if (f.unreadable) { problems.push(`${d.name} was left out: ${fixFor(d.name, d.size)}`); continue; }   // known bad: never sent again
    if (d.note) notes.push(d.note); docs.push({ ...d, fileId: f.file_id, revision: !!s?.revision, at: s?.at ?? null }); } return true; };
  const sendPdf = async (file, name) => {
    if (!(await startsWithPdf(file))) { problems.push(`${name} is not a readable PDF.`); return null; }
    const { size } = await fs.promises.stat(file); if (size > MAX_PDF) { problems.push(`${name} is too large for the AI to read (${Math.round(size / 1048576)} MB).`); return null; }
    const sha256 = await sha256File(file), [f] = await q('SELECT file_id FROM ai_files WHERE sha256=$1', [sha256]);
    if (!f) { onStep(`Sending ${name} to the AI…`); const fileId = await uploadAiFile(file, name); await q('INSERT INTO ai_files(sha256,file_id,name,size) VALUES ($1,$2,$3,$4) ON CONFLICT (sha256) DO UPDATE SET file_id=$2', [sha256, fileId, name.slice(0, 200), size]); }
    return { sha256, name: name.slice(0, 200), size };
  };
  // One plan PDF as the AI gets it: whole when it is small, otherwise in parts named "<name> (pages 1-40 of 120).pdf".
  const sendPlan = async (file, name) => {
    if (!(await startsWithPdf(file))) { problems.push(`${name} is not a readable PDF.`); return []; }
    const { size } = await fs.promises.stat(file); let src = null, pages = null;
    // splitting holds the file in memory about three times over: on a server without that much room it is not tried (it would crash it)
    if (size > BIG_PDF && !roomToSplit(size)) { problems.push(`${name} (${Math.round(size / 1048576)} MB) is too large for this server to split for the AI. Split it into smaller PDFs, for example the architectural sheets and the MEP sheets separately or about 50 sheets each, and upload those.`); return []; }
    try { src = await PDFDocument.load(await fs.promises.readFile(file), { updateMetadata: false, throwOnInvalidObject: false }); pages = src.getPageCount(); }
    catch { src = null; pages = null; }   // a locked or unusual PDF is sent as it is; if the AI service cannot read it the estimator is told
    if (!src || (size <= BIG_PDF && pages <= SPLIT_PAGES)) { const d = await sendPdf(file, name); return d ? [{ ...d, pages }] : []; }
    onStep(`${name} is large (${Math.round(size / 1048576)} MB, ${pages} pages): reading its sheet numbers…`);
    let last = null; try { last = keepThrough(await sheetMap(file)); } catch { last = null; }
    const upTo = last === null ? pages - 1 : last, note = last === null ? `${name}: the sheet numbers could not be read, so all ${pages} pages were sent, in parts.`
      : upTo < pages - 1 ? `${name}: pages 1-${upTo + 1} were sent (cover through the architectural and structural sheets); pages ${upTo + 2}-${pages} (MEP, fire protection, specs and anything after) were left out, as byOther's rule for large sets says.` : null;
    onStep(`Splitting ${name} into parts for the AI…`);
    const stem = name.replace(/\.pdf$/i, ''), out = [];
    const part = async (from, to) => {   // pages from..to (0-based, inclusive)
      const doc = await PDFDocument.create(); for (const pg of await doc.copyPages(src, Array.from({ length: to - from + 1 }, (_, k) => from + k))) doc.addPage(pg);
      const bytes = Buffer.from(await doc.save({ useObjectStreams: true }));
      if (bytes.length > BIG_PDF && to > from) { const mid = Math.floor((from + to) / 2); await part(from, mid); await part(mid + 1, to); return; }
      const tmp = await tmpFile('.pdf'), label = `${stem} (pages ${from + 1}-${to + 1} of ${pages}).pdf`;
      try { await fs.promises.writeFile(tmp, bytes, { mode: 0o600 }); const d = await sendPdf(tmp, label); if (d) out.push({ ...d, pages: to - from + 1, part: true, rule: 1 }); } finally { await rm(tmp); }
    };
    for (let p = 0; p <= upTo; p += PART_PAGES) await part(p, Math.min(p + PART_PAGES - 1, upTo));
    if (note && out.length) out[0].note = note;   // said to the AI (and so to the estimator) whenever this set is used
    return out;
  };
  for (const s of sources) {
    if (known.has(s.key) && await add(known.get(s.key), s)) continue;   // already worked out and still at the AI service
    if (s.missing) { problems.push(`${s.name} is recorded on this lead but was not found in the SharePoint plans folder.`); continue; }
    let file = s.local, temp = null;
    try {
      if (!file) { onStep(`Getting ${s.name} from SharePoint…`); temp = file = await tmpFile(s.zip ? '.zip' : '.pdf'); await SP.downloadToFile(s.spId, file); }
      else if (!fs.existsSync(file)) { problems.push(`${s.name} is missing from storage.`); continue; }
      const found = [];
      if (s.zip) {
        const entries = await zipPdfEntries(file); if (!entries.length) problems.push(`${s.name} has no PDF plans inside it.`);
        for (const e of entries) { const out = await tmpFile('.pdf'); try { await zipExtract(file, e, out); found.push(...(await sendPlan(out, path.basename(e.name)))); } finally { await rm(out); } }
      } else found.push(...(await sendPlan(file, s.name)));
      await q(`INSERT INTO plan_sources(opportunity_id,source_key,docs) VALUES ($1,$2,$3) ON CONFLICT (opportunity_id,source_key) DO UPDATE SET docs=$3`, [opportunityId, s.key, JSON.stringify(found)]);
      await add(found, s);
    } catch (e) { problems.push(`${s.name}: ${e instanceof HttpError ? e.message : 'could not be read.'}`); }
    finally { if (temp) await rm(temp); }
  }
  // the AI reads up to 600 pages at a time: past that, the rest is left out and the estimator is told
  let total = 0; const keep = [], over = [];
  for (const d of docs) { const n = Number(d.pages) || 0; if (total + n > MAX_TURN_PAGES) over.push(d); else { keep.push(d); total += n; } }
  if (over.length) problems.push(`The plans add up to more pages than the AI can read at once (about ${MAX_TURN_PAGES}). Left out: ${over.map((d) => d.name).join(', ')}. Take sheets the estimate does not need (specs, civil, structural) out of the plans on this lead, or upload only the sheets for the trades being estimated.`);
  return { docs: keep, problems, notes, sources: sources.length };
}
// When the AI service says a plan file is gone (deleted or expired there), forget where the lead's files were so they are sent again.
export async function forgetPlans(opportunityId) {
  const rows = await q('DELETE FROM plan_sources WHERE opportunity_id=$1 RETURNING docs', [opportunityId]);
  const shas = rows.flatMap((r) => (r.docs || []).map((d) => d.sha256)); if (shas.length) await q('DELETE FROM ai_files WHERE sha256 = ANY($1::text[])', [shas]);
}
