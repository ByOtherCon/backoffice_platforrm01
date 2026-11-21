// A byOther proposal, made from the company's official proposal template (a Word file).
//  - The Word file IS the template: its logo, header, footer, styles and table are kept exactly, and only the blanks are filled in
//    (who it is for, the project and its site, the P number and trades on the Scope line, and one table row per trade with its scope
//    bullets and total).
//  - The PDF is drawn to look the same (the logo and company block are read out of the template, same layout and colours, a
//    Calibri-compatible font), because the server has no Word to print with.
// Nothing is estimated or reworded here: the content comes in ready, and a missing price prints as "$_____".
// Each trade is its own row of the table: the trade name (bold, underlined), its scope lines on up to three bullet levels (the template's
// own bullets), sub-headings inside a trade, the price at the top of the Total column, and the "*any item not explicitly listed" line.
// Prices are whole dollars, always rounded up; cents are never printed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import JSZip from 'jszip';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const defaultTemplate = () => fs.readFileSync(path.join(HERE, 'estimator', 'proposal-template.docx'));
const FONT = (f) => path.join(HERE, 'estimator', 'fonts', f);
// Whole dollars, rounded up (4,900.01 is $4,901). Cents are never printed.
export const wholeUp = (n) => Math.ceil(Math.round(Number(n) * 100) / 100);
export const priceText = (n) => (n === null || n === undefined || n === '' || !Number.isFinite(Number(n)) ? '$_____' : '$' + wholeUp(n).toLocaleString('en-US'));
const str = (v, n = 4000) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);

// Tidies what the conversation hands over into the one shape both writers use. Throws a plain sentence when something needed is missing.
// A scope line: { text, level } where level 1 to 3 is the bullet level and 0 a plain line with no bullet, or { text, heading: true } for a
// sub-heading inside the trade (bold and underlined, like the trade name). A plain string is a first-level bullet.
const bulletless = (x) => str(x, 1500).replace(/^[•▪■□○o\-*]\s+/, '');
function scopeLines(t) {
  const out = (Array.isArray(t?.notes) ? t.notes : []).map((x) => ({ text: str(x, 1500), level: 0 })).filter((x) => x.text).slice(0, 20);
  for (const x of (Array.isArray(t?.items) ? t.items : []).slice(0, 300)) {
    if (typeof x === 'string') { const v = bulletless(x); if (v) out.push({ text: v, level: 1 }); continue; }
    const v = bulletless(x?.text); if (!v) continue;
    if (x?.heading) out.push({ text: v.toUpperCase(), heading: true });
    else { const lv = Number(x?.level ?? 1); out.push({ text: v, level: Number.isFinite(lv) ? Math.min(3, Math.max(0, Math.round(lv))) : 1 }); }
  }
  return out;
}
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
// How a trade's price was worked out (shown to the estimator, kept with the proposal, never printed on it).
const methodOf = (m) => (m && typeof m === 'object' ? { basis: str(m.basis, 1500), lines: (Array.isArray(m.lines) ? m.lines : []).slice(0, 60).map((l) => ({ description: str(l?.description, 300), quantity: num(l?.quantity), unit: str(l?.unit, 20), rate: num(l?.rate), amount: num(l?.amount), source: str(l?.source, 200) })).filter((l) => l.description) } : null);
export function proposalSpec(input, defaults = {}) {
  const trades = (Array.isArray(input?.trades) ? input.trades : []).slice(0, 20).map((t) => {
    const lines = scopeLines(t), total = num(t?.total);
    return { title: str(t?.name, 80).toUpperCase(), lines, items: lines.filter((l) => !l.heading && l.level).map((l) => l.text), total: total !== null && total >= 0 ? wholeUp(total) : null, method: methodOf(t?.methodology) };
  }).filter((t) => t.title && t.lines.length);
  if (!trades.length) throw new Error('The proposal needs at least one trade with scope items.');
  const flagged = (Array.isArray(input?.flagged) ? input.flagged : []).map((f) => ({ item: str(f?.item, 400), note: str(f?.reference ?? f?.note, 800) })).filter((f) => f.item).slice(0, 80);
  // items the estimating sheet does not cover: priced another way and listed for the sheet to be updated
  const needsUpdate = (Array.isArray(input?.needsUpdate) ? input.needsUpdate : []).map((n) => ({ trade: str(n?.trade, 80), item: str(n?.item, 400), note: str(n?.note, 800) })).filter((n) => n.item).slice(0, 80);
  const rv = input?.revision && typeof input.revision === 'object' && input.revision.isRevision ? { changes: (Array.isArray(input.revision.changes) ? input.revision.changes : []).map((c) => str(c, 600)).filter(Boolean).slice(0, 80) } : null;
  const project = str(input?.projectName, 200) || str(defaults.projectName, 200), gc = str(input?.createdFor, 200) || str(defaults.createdFor, 200);
  if (!project) throw new Error('The proposal needs the project name.');
  const title = (s) => s.charAt(0) + s.slice(1).toLowerCase();
  return { date: str(input?.date, 40) || defaults.date || new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'long', day: 'numeric', year: 'numeric' }),
    createdFor: gc, projectName: project, location: str(input?.projectAddress, 300) || str(defaults.projectAddress, 300), proposalId: str(defaults.proposalId, 40), permitSet: str(input?.permitSet, 300),
    scope: trades.map((t) => title(t.title)).join('/'), trades, flagged, needsUpdate, revision: rv, revisionNo: Number.isInteger(defaults.revisionNo) ? defaults.revisionNo : null, grandTotal: !!input?.showGrandTotal };
}
const sumOf = (spec) => (spec.trades.every((t) => t.total !== null) ? spec.trades.reduce((n, t) => n + t.total, 0) : null);
// the Scope line: the trades, and the revision number when this is a revision
const scopeText = (spec) => spec.scope + (spec.revisionNo ? ` – Revision ${spec.revisionNo}` : '');
const forLine = (spec) => `${spec.createdFor ? spec.createdFor + ': ' : ''}${spec.projectName}${spec.location ? ' – ' + spec.location : ''}`;

// ------------------------------------------------------------------ reading the template
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unesc = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const PARA = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, RUN = /<w:r\b[^>]*>[\s\S]*?<\/w:r>/g, ROW = /<w:tr\b[^>]*>[\s\S]*?<\/w:tr>/g, CELL = /<w:tc\b[^>]*>[\s\S]*?<\/w:tc>/g;
const textOf = (xml) => unesc([...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(''));
const rPrOf = (run) => (run?.match(/<w:rPr>[\s\S]*?<\/w:rPr>/) || [''])[0];
const mkRun = (rPr, text) => `<w:r>${rPr}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
const firstTextRun = (p) => (p.match(RUN) || []).find((r) => /<w:t[\s>]/.test(r));
// The same paragraph (its style, spacing and bullet) with new words in it, in the look of its first run.
const withText = (p, text, rPr = null) => { const open = p.match(/^<w:p\b[^>]*>/)[0], pPr = (p.match(/<w:pPr>[\s\S]*?<\/w:pPr>/) || [''])[0]; return `${open}${pPr}${text === '' ? '' : mkRun(rPr ?? rPrOf(firstTextRun(p)), text)}</w:p>`; };
const MISSING = (what) => new Error(`The proposal template is missing ${what}. Use the official template: a "GC Name: Project Name – Project Location" line, a "Scope:" line, and a table whose second row has the trade name, bullet lines and a "$" in the Total column.`);

// Finds the parts of the template that get filled in. Throws a plain sentence when one is not there.
function templateParts(xml) {
  const t0 = xml.indexOf('<w:tbl>'), t1 = xml.indexOf('</w:tbl>'); if (t0 < 0 || t1 < 0) throw MISSING('its Description/Scope table');
  const head = xml.slice(0, t0), table = xml.slice(t0, t1 + 8), paras = head.match(PARA) || [];
  const forP = paras.find((p) => /gc name/i.test(textOf(p)) || /project name/i.test(textOf(p))); if (!forP) throw MISSING('the "GC Name: Project Name – Project Location" line');
  const scopeP = paras.find((p) => /^\s*scope\b/i.test(textOf(p))); if (!scopeP) throw MISSING('the "Scope:" line');
  const rows = table.match(ROW) || []; if (rows.length < 2) throw MISSING('the trade row in its table');
  const proto = rows[1], cells = proto.match(CELL) || []; if (cells.length < 2) throw MISSING('the Total column in its table');
  const c1 = cells[0].match(PARA) || [], c2 = cells[cells.length - 1].match(PARA) || [];
  const titleP = c1.find((p) => textOf(p).trim()), bulletP = c1.find((p) => /<w:numPr>/.test(p)), noteP = [...c1].reverse().find((p) => /not included|not explicitly/i.test(textOf(p))) ?? null;
  const blankP = c1.find((p) => !textOf(p).trim() && !/<w:numPr>/.test(p)) ?? null, priceP = c2.find((p) => textOf(p).includes('$'));
  if (!titleP || !bulletP) throw MISSING('the trade name and bullet lines in its table'); if (!priceP) throw MISSING('the "$" in the Total column');
  return { head, table, forP, scopeP, rows, proto, cells, titleP, bulletP, noteP, blankP, priceP, c2 };
}
// The bullet levels of the template's bullet list (its numbering): the indent of each level, and the mark it draws (square, circle, dot).
async function bulletLevels(zip, bulletP) {
  const id = (bulletP.match(/<w:numId w:val="(\d+)"/) || [])[1], numbering = await zip.file('word/numbering.xml')?.async('string');
  const fallback = [1, 2, 3].map((k) => ({ ind: null, left: 720 * k, hanging: 360, mark: 'square' }));
  if (!id || !numbering) return fallback;
  const abs = (numbering.match(new RegExp(`<w:num w:numId="${id}"[^>]*>[\\s\\S]*?<w:abstractNumId w:val="(\\d+)"`)) || [])[1]; if (abs === undefined) return fallback;
  const def = (numbering.match(new RegExp(`<w:abstractNum\\b[^>]*w:abstractNumId="${abs}"[^>]*>[\\s\\S]*?</w:abstractNum>`)) || [])[0]; if (!def) return fallback;
  return [0, 1, 2].map((k) => { const l = (def.match(new RegExp(`<w:lvl w:ilvl="${k}"[^>]*>[\\s\\S]*?</w:lvl>`)) || [])[0]; if (!l) return fallback[k];
    const ind = (l.match(/<w:ind\b[^>]*\/>/) || [])[0] || null, left = Number((ind?.match(/w:left="(\d+)"/) || [])[1] ?? 720 * (k + 1)), hanging = Number((ind?.match(/w:hanging="(\d+)"/) || [])[1] ?? 360);
    const t = (l.match(/<w:lvlText w:val="([^"]*)"/) || [])[1] ?? '', font = (l.match(/w:ascii="([^"]*)"/) || [])[1] ?? '';
    const mark = /^o$/i.test(t) ? 'circle' : /symbol/i.test(font) || t === '\uf0b7' || t === '•' ? 'dot' : 'square';
    return { ind, left, hanging, mark }; });
}
// Checks a file is a usable template (for when the owner loads a new one). Returns what it found.
export async function checkTemplate(bytes) {
  let zip; try { zip = await JSZip.loadAsync(bytes); } catch { throw new Error('That is not a Word (.docx) file.'); }
  const doc = zip.file('word/document.xml'); if (!doc) throw new Error('That is not a Word (.docx) file.');
  const p = templateParts(await doc.async('string'));
  return { forLine: textOf(p.forP).trim(), scopeLine: textOf(p.scopeP).trim(), disclaimer: p.noteP ? textOf(p.noteP).trim() : null };
}

// ------------------------------------------------------------------ Word: the template, filled in
export async function proposalDocx(spec, templateBytes = defaultTemplate()) {
  const zip = await JSZip.loadAsync(templateBytes), file = zip.file('word/document.xml'); if (!file) throw new Error('The proposal template is not a Word (.docx) file.');
  let xml = await file.async('string'); const p = templateParts(xml);
  // who it is for: "GC: Project – Site", in the look the template gives that line
  const forNew = withText(p.forP, forLine(spec));
  // Scope: [P#] Trade/Trade. The label stays as it is; the number and the trades take the look of the template's own placeholders.
  const runs = p.scopeP.match(RUN) || [], firstBracket = runs.findIndex((r) => textOf(r).includes('['));
  let cut = firstBracket >= 0 ? firstBracket : runs.findIndex((r) => !/^(scope|:|\s*)$/i.test(textOf(r))); if (cut < 0) cut = runs.length;
  const label = runs.slice(0, cut);
  const numRun = runs.slice(Math.max(firstBracket, 0)).find((r) => /[A-Za-z0-9]/.test(textOf(r)) && !textOf(r).includes('[')) ?? runs[firstBracket] ?? runs.at(-1), tradeRun = [...runs].reverse().find((r) => textOf(r).trim());
  const open = p.scopeP.match(/^<w:p\b[^>]*>/)[0], pPr = (p.scopeP.match(/<w:pPr>[\s\S]*?<\/w:pPr>/) || [''])[0];
  const scopeNew = `${open}${pPr}${label.join('')}${label.length && !/\s$/.test(textOf(label.at(-1))) ? mkRun(rPrOf(label.at(-1)), ' ') : ''}${spec.proposalId ? mkRun(rPrOf(numRun), `[${spec.proposalId}] `) : ''}${mkRun(rPrOf(tradeRun), scopeText(spec))}</w:p>`;
  // one table row per trade, copied from the template's own trade row
  const cellOpen = (c) => c.match(/^<w:tc\b[^>]*>/)[0] + ((c.match(/<w:tcPr>[\s\S]*?<\/w:tcPr>/) || [''])[0]), rowOpen = p.proto.match(/^<w:tr\b[^>]*>/)[0] + ((p.proto.match(/<w:trPr>[\s\S]*?<\/w:trPr>/) || [''])[0]);
  const plainP = (p.blankP ?? p.bulletP).replace(/<w:numPr>[\s\S]*?<\/w:numPr>/, '').replace(/<w:ind\b[^>]*\/>/, '<w:ind w:left="0" w:right="0"/>'), bulletRPr = rPrOf(firstTextRun(p.bulletP)), mid = p.cells.slice(1, -1).join('');
  // the bullet paragraph at levels 1 to 3: the same paragraph with the level and that level's indent from the template's own list
  const levels = await bulletLevels(zip, p.bulletP), blank = p.blankP ?? withText(plainP, '');
  const atLevel = (lv) => { let x = p.bulletP.replace(/<w:ilvl w:val="\d+"\s*\/>/, `<w:ilvl w:val="${lv - 1}"/>`); const ind = levels[lv - 1]?.ind; if (ind) x = x.replace(/(<w:pPr>[\s\S]*?)<w:ind\b[^>]*\/>/, (m0, a) => a + ind); return x; };
  const BULLET = [null, atLevel(1), atLevel(2), atLevel(3)];
  const lineXml = (l, k) => (l.heading ? `${k ? blank : ''}${withText(p.titleP, l.text)}` : l.level ? withText(BULLET[l.level], l.text) : withText(plainP, l.text, bulletRPr));
  const rowFor = (title, lines, price, withNote) => `${rowOpen}${cellOpen(p.cells[0])}${withText(p.titleP, title)}${lines.map(lineXml).join('')}${withNote && p.blankP ? p.blankP : ''}${withNote && p.noteP ? p.noteP : ''}</w:tc>${mid}${cellOpen(p.cells.at(-1))}${p.c2.map((q) => (q === p.priceP ? withText(q, price) : q)).join('')}</w:tc></w:tr>`;
  const body = spec.trades.map((t) => rowFor(t.title, t.lines, priceText(t.total), true)).join('') + (spec.grandTotal ? rowFor('TOTAL', [], priceText(sumOf(spec)), false) : '');
  const table = p.table.replace(p.proto, () => body);
  xml = xml.replace(p.table, () => table).replace(p.forP, () => forNew).replace(p.scopeP, () => scopeNew);
  zip.file('word/document.xml', xml, { createFolders: false });
  // the date at the top is the date of this proposal, and stays that date when the file is opened later
  for (const name of Object.keys(zip.files).filter((n) => /^word\/header\d*\.xml$/.test(n))) {
    const h = await zip.file(name).async('string'), fixed = h.replace(/<w:r\b[^>]*>(?:(?!<\/w:r>)[\s\S])*?<w:fldChar w:fldCharType="begin"[\s\S]*?\bDATE\b[\s\S]*?<w:fldChar w:fldCharType="end"\s*\/>\s*<\/w:r>/, () => mkRun('', spec.date));
    if (fixed !== h) zip.file(name, fixed, { createFolders: false });
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// ------------------------------------------------------------------ PDF, drawn to match the template
// The logo, the company block, the disclaimer and the footer are read out of the template, so a new template changes the PDF too.
async function templateLook(templateBytes) {
  const zip = await JSZip.loadAsync(templateBytes), xml = await zip.file('word/document.xml').async('string'), p = templateParts(xml), paras = p.head.match(PARA) || [];
  let logo = null; const d = p.head.match(/<w:drawing>[\s\S]*?<\/w:drawing>/);
  if (d) { const rid = (d[0].match(/r:embed="([^"]+)"/) || [])[1], ext = d[0].match(/<wp:extent cx="(\d+)" cy="(\d+)"/), rels = await zip.file('word/_rels/document.xml.rels')?.async('string');
    const target = rid && rels ? (rels.match(new RegExp(`Id="${rid}"[^>]*Target="([^"]+)"`)) || rels.match(new RegExp(`Target="([^"]+)"[^>]*Id="${rid}"`)) || [])[1] : null, img = target ? zip.file('word/' + target.replace(/^\/?(word\/)?/, '')) : null;
    if (img && /\.(png|jpe?g)$/i.test(target)) logo = { bytes: await img.async('nodebuffer'), w: ext ? Number(ext[1]) / 12700 : 178, h: ext ? Number(ext[2]) / 12700 : 95 }; }
  // the company block: every line of text between the logo and "Created For"
  const stop = paras.findIndex((q) => /created for/i.test(textOf(q))), company = [];
  for (const q of paras.slice(0, stop < 0 ? paras.indexOf(p.forP) : stop)) { const link = q.match(/<w:hyperlink\b[\s\S]*?<\/w:hyperlink>/), plain = textOf(q.replace(/<w:hyperlink\b[\s\S]*?<\/w:hyperlink>/g, '')).trim();
    if (plain) company.push({ text: plain, bold: /<w:b\s*\/>|<w:b w:val="1"/.test(rPrOf(firstTextRun(q))) }); if (link && textOf(link[0]).trim()) company.push({ text: textOf(link[0]).trim(), link: true }); }
  let footer = ''; for (const name of Object.keys(zip.files).filter((n) => /^word\/footer\d*\.xml$/.test(n))) { const t = textOf(await zip.file(name).async('string')).trim(); if (t) { footer = t; break; } }
  const headRow = p.rows[0].match(CELL) || [];
  return { logo, company, footer, levels: await bulletLevels(zip, p.bulletP), disclaimer: p.noteP ? textOf(p.noteP).trim() : '', th: [textOf(headRow[0] || '').trim() || 'Description/Scope', textOf(headRow.at(-1) || '').trim() || 'Total'], fill: (p.rows[0].match(/w:fill="([0-9A-Fa-f]{6})"/) || [])[1] || '44546A' };
}
// { preview: true } marks every page PREVIEW (the copy shown before the final files are made).
export async function proposalPdf(spec, templateBytes = defaultTemplate(), { preview = false } = {}) {
  const look = await templateLook(templateBytes);
  return new Promise((resolve, reject) => {
    const M = 72, W = 612 - 2 * M, TW = 485.75, DESC = 382.25, TOT = TW - DESC, PADX = 5.4, BOTTOM = 792 - M, GRAY = '#5A5A5A', LINE = '#BFBFBF';
    const doc = new PDFDocument({ size: 'LETTER', margins: { top: M, bottom: 0, left: M, right: M }, info: { Title: `${spec.projectName} Proposal`, Author: 'byOther Construction, LLC' } });
    const chunks = []; doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    doc.registerFont('r', FONT('Carlito-Regular.ttf')); doc.registerFont('b', FONT('Carlito-Bold.ttf')); doc.registerFont('i', FONT('Carlito-Italic.ttf'));
    let y = M;
    // every page: the date at the top right and the company name at the bottom, as in the template's header and footer
    const frame = () => { if (preview) { doc.save(); doc.rotate(-35, { origin: [306, 396] }); doc.font('b').fontSize(120).fillColor('#000').fillOpacity(0.07).text('PREVIEW', 0, 330, { width: 612, align: 'center', lineBreak: false }); doc.restore(); doc.fillOpacity(1); }
      doc.font('r').fontSize(11).fillColor('#000').text(spec.date, M, 36, { width: W, align: 'right', lineBreak: false }); if (look.footer) doc.font('r').fontSize(12).fillColor('#000').text(look.footer, M, 792 - 36 - 28, { lineBreak: false }); };
    const newPage = () => { doc.addPage(); frame(); y = M; };
    const hOf = (t, w, font, size) => { doc.font(font).fontSize(size); return doc.heightOfString(t, { width: w, lineGap: 0 }); };
    // Small capitals the way Word draws them: capitals at full size, everything else as smaller capitals, on one baseline. Wraps by word.
    const smallCaps = (parts, x0, maxW) => {
      const pieces = []; for (const pt of parts) for (const word of String(pt.text).split(/(\s+)/)) { if (!word) continue; const segs = []; let cur = null;
        for (const ch of word) { const small = ch !== ch.toUpperCase(), size = small ? pt.size * 0.8 : pt.size; if (!cur || cur.size !== size) { cur = { text: '', size }; segs.push(cur); } cur.text += ch.toUpperCase(); }
        let w = 0; for (const s of segs) { doc.font(pt.font).fontSize(s.size); s.w = doc.widthOfString(s.text); w += s.w; } pieces.push({ segs, w, space: /^\s+$/.test(word), pt }); }
      const big = Math.max(...parts.map((q) => q.size)), lineH = big * 1.22; let x = x0;
      for (const pc of pieces) { if (!pc.space && x + pc.w > x0 + maxW && x > x0) { x = x0; y += lineH; } if (pc.space && x === x0) continue;
        const startX = x; for (const s of pc.segs) { doc.font(pc.pt.font).fontSize(s.size).fillColor(pc.pt.color || GRAY).text(s.text, x, y + (big - s.size) * 0.75, { lineBreak: false }); x += s.w; }
        if (pc.pt.underline) doc.lineWidth(0.6).strokeColor(pc.pt.color || GRAY).moveTo(startX, y + big * 0.98).lineTo(x, y + big * 0.98).stroke(); }
      y += lineH; };
    frame();
    if (look.logo) { try { doc.image(look.logo.bytes, M, y, { width: look.logo.w, height: look.logo.h }); y += look.logo.h + 2; } catch { /* a logo that cannot be drawn is left out */ } }
    for (const c of look.company) { if (c.link) { doc.font('r').fontSize(12).fillColor('#0563C1').text(c.text, M, y, { lineBreak: false, underline: true }); y += 15; } else { doc.font(c.bold ? 'b' : 'r').fontSize(14).fillColor(GRAY).text(c.text, M, y, { width: W }); y += hOf(c.text, W, c.bold ? 'b' : 'r', 14) + 0.5; } }
    y += 17; smallCaps([{ text: 'Created For', font: 'r', size: 14, underline: true }, { text: ':', font: 'r', size: 14 }], M, W);
    smallCaps([{ text: forLine(spec), font: 'b', size: 14 }], M, W); y += 17;
    smallCaps([{ text: 'Scope', font: 'r', size: 14, underline: true }, { text: ': ', font: 'r', size: 14 }, ...(spec.proposalId ? [{ text: `[${spec.proposalId}] `, font: 'r', size: 12 }] : []), { text: scopeText(spec), font: 'b', size: 14 }], M, W);
    // the table
    const box = (x, top, w, hgt, fill) => { if (fill) doc.rect(x, top, w, hgt).fill('#' + fill); doc.lineWidth(0.5).strokeColor(LINE).rect(x, top, w, hgt).stroke(); };
    if (y + 21.1 + 60 > BOTTOM) newPage();
    box(M, y, DESC, 21.1, look.fill); box(M + DESC, y, TOT, 21.1, look.fill);
    doc.font('r').fontSize(14).fillColor('#D0CECE').text(look.th[0], M, y + 2.5, { width: DESC, align: 'center', lineBreak: false }).text(look.th[1], M + DESC, y + 2.5, { width: TOT, align: 'center', lineBreak: false }); y += 21.1;
    const lv = look.levels, LINE_H = (size) => size * 1.22;
    const mark = (kind, x, yy, size) => { const c = yy + size * 0.58; if (kind === 'circle') doc.lineWidth(0.6).strokeColor('#000').circle(x + 2, c, 2).stroke(); else if (kind === 'dot') doc.circle(x + 2, c, 1.8).fill('#000'); else doc.rect(x + 0.4, c - 1.6, 3.2, 3.2).fill('#000'); };
    const row = (title, lines, price, note) => {
      if (y + 50 > BOTTOM) newPage();
      let top = y, first = true;
      const close = () => { const hgt = Math.max(y - top, 56.65); box(M, top, DESC, hgt); box(M + DESC, top, TOT, hgt); if (first) { doc.font('b').fontSize(12).fillColor('#000').text(price, M + DESC, top + 15.5, { width: TOT, align: 'center', lineBreak: false }); first = false; } y = top + hgt; };
      const put = (s, font, size, indent, bullet, opts = {}) => { const w = DESC - 2 * PADX - indent, hh = hOf(s, w, font, size);
        if (y + hh > BOTTOM) { close(); newPage(); top = y; }
        if (bullet) mark(bullet.mark, M + PADX + indent - bullet.hanging / 20, y, size);
        doc.font(font).fontSize(size).fillColor('#000').text(s, M + PADX + indent, y, { width: w, lineGap: 0, underline: !!opts.underline }); y += hh; };
      put(title, 'b', 12, 0, null, { underline: true });
      lines.forEach((l, k) => { if (l.heading) { if (k) y += LINE_H(12); if (y + 3 * LINE_H(12) > BOTTOM) { close(); newPage(); top = y; } put(l.text, 'b', 12, 0, null, { underline: true }); } else if (!l.level) put(l.text, 'r', 12, 0, null); else { const b = lv[l.level - 1]; put(l.text, 'r', 12, b.left / 20, b); } });
      if (note && look.disclaimer) { y += 13.5; put(look.disclaimer, 'i', 11, 0, null); }
      close();
    };
    for (const t of spec.trades) row(t.title, t.lines, priceText(t.total), true);
    if (spec.grandTotal) row('TOTAL', [], priceText(sumOf(spec)), false);
    doc.end();
  });
}
