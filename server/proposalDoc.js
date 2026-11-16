// A byOther proposal as a Word file and a PDF, from the same content. The layout follows the company's proposal format: company header,
// who it is for, the permit set, a two-column table (scope | total) with one section per trade, and a red Flagged Items list at the end.
// Nothing is estimated or reworded here: the content comes in ready, and a missing price prints as "$_____".
import PDFDocument from 'pdfkit';
import { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle, ShadingType, UnderlineType, VerticalAlign, LevelFormat } from 'docx';

export const COMPANY = { name: 'byOther Construction, LLC', address: '184 E Liberty St, Hernando FL 34442', phone: '407-434-1825' };
export const DISCLAIMER = '*Any item not explicitly listed is not included in Scope or Price.';
const ACCENT = '1F4E79', DARK = '1A1A1A', WHITE = 'FFFFFF', RED = 'C00000', BAND = 'D6E4F0', GRAYT = '555555', LINE = 'CCCCCC';
const FLAG_INTRO = "The following items were identified in the permit set as outside byOther's standard trade scope, typically excluded, or require clarification of scope ownership prior to proposal submission.";
export const priceText = (n) => (n === null || n === undefined || n === '' || !Number.isFinite(Number(n)) ? '$_____' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const str = (v, n = 4000) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n);

// Tidies what the conversation hands over into the one shape both writers use. Throws a plain sentence when something needed is missing.
export function proposalSpec(input, defaults = {}) {
  const trades = (Array.isArray(input?.trades) ? input.trades : []).slice(0, 20).map((t) => {
    const items = (Array.isArray(t?.items) ? t.items : []).map((x) => str(x, 1500)).filter(Boolean).slice(0, 150), notes = (Array.isArray(t?.notes) ? t.notes : []).map((x) => str(x, 1500)).filter(Boolean).slice(0, 20);
    const total = t?.total === null || t?.total === undefined || t?.total === '' ? null : Number(t.total);
    return { title: str(t?.name, 80).toUpperCase(), items, notes, total: Number.isFinite(total) && total >= 0 ? Math.round(total * 100) / 100 : null };
  }).filter((t) => t.title && (t.items.length || t.notes.length));
  if (!trades.length) throw new Error('The proposal needs at least one trade with scope items.');
  const flagged = (Array.isArray(input?.flagged) ? input.flagged : []).map((f) => ({ item: str(f?.item, 400), note: str(f?.reference ?? f?.note, 800) })).filter((f) => f.item).slice(0, 80);
  const project = str(input?.projectName, 200) || str(defaults.projectName, 200), gc = str(input?.createdFor, 200) || str(defaults.createdFor, 200);
  if (!project) throw new Error('The proposal needs the project name.');
  return { date: str(input?.date, 40) || defaults.date || new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'long', day: 'numeric', year: 'numeric' }),
    createdFor: gc, projectName: project, projectAddress: str(input?.projectAddress, 300) || str(defaults.projectAddress, 300), permitSet: str(input?.permitSet, 300),
    scope: str(input?.scopeLine, 300) || trades.map((t) => t.title.charAt(0) + t.title.slice(1).toLowerCase()).join(' / '), trades, flagged, grandTotal: !!input?.showGrandTotal };
}
const sumOf = (spec) => (spec.trades.every((t) => t.total !== null) ? Math.round(spec.trades.reduce((n, t) => n + t.total * 100, 0)) / 100 : null);

// ------------------------------------------------------------------ Word
export async function proposalDocx(spec) {
  const thin = { style: BorderStyle.SINGLE, size: 1, color: LINE }, cell = { top: thin, bottom: thin, left: thin, right: thin };
  const run = (text, o = {}) => new TextRun({ text, font: 'Arial', size: 20, color: DARK, ...o });
  const info = (label, value) => new Paragraph({ spacing: { before: 0, after: 20 }, children: [run(label, { bold: true }), run(value || '')] });
  const COL_DESC = 7200, COL_TOTAL = 2160, TABLE_W = 9360, pad = { top: 100, bottom: 100, left: 160, right: 160 };
  const headRow = new TableRow({ tableHeader: true, children: [
    new TableCell({ width: { size: COL_DESC, type: WidthType.DXA }, borders: cell, shading: { fill: ACCENT, type: ShadingType.CLEAR }, margins: pad, children: [new Paragraph({ children: [run('DESCRIPTION / SCOPE', { bold: true, color: WHITE })] })] }),
    new TableCell({ width: { size: COL_TOTAL, type: WidthType.DXA }, borders: cell, shading: { fill: ACCENT, type: ShadingType.CLEAR }, margins: pad, children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [run('TOTAL', { bold: true, color: WHITE })] })] })] });
  const rows = [headRow];
  const wide = (text, o) => new TableRow({ children: [new TableCell({ columnSpan: 2, width: { size: TABLE_W, type: WidthType.DXA }, borders: { top: { style: BorderStyle.SINGLE, size: 4, color: ACCENT }, bottom: { style: BorderStyle.SINGLE, size: 4, color: ACCENT }, left: thin, right: thin }, shading: { fill: BAND, type: ShadingType.CLEAR }, margins: { top: 80, bottom: 80, left: 160, right: 160 }, children: [new Paragraph({ children: [run(text, o)] })] })] });
  for (const t of spec.trades) {
    rows.push(wide(t.title, { bold: true, underline: { type: UnderlineType.SINGLE }, color: ACCENT }));
    const paras = [...t.notes.map((n, i) => new Paragraph({ spacing: { before: i === 0 ? 0 : 20, after: 20 }, children: [run(n, { size: 18 })] })),
      ...t.items.map((x) => new Paragraph({ numbering: { reference: 'bullets', level: 0 }, spacing: { before: 20, after: 20 }, children: [run(x, { size: 18 })] })),
      new Paragraph({ spacing: { before: 40, after: 20 }, children: [run(DISCLAIMER, { size: 16, color: GRAYT, italics: true })] })];
    rows.push(new TableRow({ children: [
      new TableCell({ width: { size: COL_DESC, type: WidthType.DXA }, borders: cell, margins: pad, children: paras }),
      new TableCell({ width: { size: COL_TOTAL, type: WidthType.DXA }, borders: cell, verticalAlign: VerticalAlign.CENTER, margins: pad, children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [run(priceText(t.total), { bold: true, size: 18 })] })] })] }));
  }
  if (spec.grandTotal) rows.push(new TableRow({ children: [
    new TableCell({ width: { size: COL_DESC, type: WidthType.DXA }, borders: cell, margins: pad, children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [run('TOTAL', { bold: true })] })] }),
    new TableCell({ width: { size: COL_TOTAL, type: WidthType.DXA }, borders: cell, margins: pad, children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [run(priceText(sumOf(spec)), { bold: true })] })] })] }));
  const spacer = () => new Paragraph({ spacing: { before: 60, after: 0 }, children: [new TextRun('')] });
  const children = [
    new Paragraph({ alignment: AlignmentType.RIGHT, spacing: { before: 0, after: 60 }, children: [run(spec.date, { size: 18, color: GRAYT })] }),
    new Paragraph({ spacing: { before: 0, after: 40 }, children: [run(COMPANY.name, { bold: true, size: 32, color: ACCENT })] }),
    new Paragraph({ spacing: { before: 0, after: 20 }, children: [run(COMPANY.address, { size: 18 })] }),
    new Paragraph({ spacing: { before: 0, after: 20 }, children: [run(COMPANY.phone, { size: 18 })] }),
    new Paragraph({ spacing: { before: 0, after: 0 }, border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: ACCENT, space: 1 } }, children: [new TextRun('')] }),
    spacer(), info('Created For: ', [spec.createdFor, spec.projectName].filter(Boolean).join('  |  ')), info('Project Address: ', spec.projectAddress), info('Permit Set: ', spec.permitSet),
    new Paragraph({ spacing: { before: 0, after: 40 }, children: [run('Scope: ', { bold: true }), run(spec.scope)] }), spacer(),
    new Table({ width: { size: TABLE_W, type: WidthType.DXA }, columnWidths: [COL_DESC, COL_TOTAL], rows })];
  if (spec.flagged.length) children.push(spacer(), spacer(),
    new Paragraph({ spacing: { before: 0, after: 20 }, children: [run('FLAGGED ITEMS — REVIEW BEFORE SENDING', { bold: true, underline: { type: UnderlineType.SINGLE }, size: 28, color: RED })] }),
    new Paragraph({ spacing: { before: 0, after: 60 }, children: [run(FLAG_INTRO, { size: 18, italics: true })] }),
    new Table({ width: { size: TABLE_W, type: WidthType.DXA }, columnWidths: [4680, 4680], rows: [
      new TableRow({ tableHeader: true, children: ['ITEM', 'PLAN REFERENCE / NOTES'].map((h) => new TableCell({ width: { size: 4680, type: WidthType.DXA }, borders: cell, shading: { fill: RED, type: ShadingType.CLEAR }, margins: { top: 80, bottom: 80, left: 160, right: 160 }, children: [new Paragraph({ children: [run(h, { bold: true, color: WHITE, size: 18 })] })] })) }),
      ...spec.flagged.map((f) => new TableRow({ children: [
        new TableCell({ width: { size: 4680, type: WidthType.DXA }, borders: cell, margins: { top: 80, bottom: 80, left: 160, right: 160 }, children: [new Paragraph({ children: [run(f.item, { bold: true, size: 18 })] })] }),
        new TableCell({ width: { size: 4680, type: WidthType.DXA }, borders: cell, margins: { top: 80, bottom: 80, left: 160, right: 160 }, children: [new Paragraph({ children: [run(f.note, { size: 18 })] })] })] }))] }));
  const doc = new Document({
    numbering: { config: [{ reference: 'bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 360 } } } }] }] },
    styles: { default: { document: { run: { font: 'Arial', size: 20 } } } },
    sections: [{ properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 } } }, children }] });
  return Packer.toBuffer(doc);
}

// ------------------------------------------------------------------ PDF (drawn directly, so it needs no office program on the server)
export function proposalPdf(spec) {
  return new Promise((resolve, reject) => {
    const M = 54, W = 612 - 2 * M, DESC = Math.round(W * 7200 / 9360), TOT = W - DESC, PAD = 7, BOTTOM = 792 - M;
    const doc = new PDFDocument({ size: 'LETTER', margins: { top: M, bottom: M, left: M, right: M }, info: { Title: `${spec.projectName} Proposal`, Author: COMPANY.name } });
    const chunks = []; doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    const F = { r: 'Helvetica', b: 'Helvetica-Bold', i: 'Helvetica-Oblique' }, hex = (c) => '#' + c;
    let y = M;
    const text = (t, x, w, o = {}) => { doc.font(o.font || F.r).fontSize(o.size || 9).fillColor(hex(o.color || DARK)); doc.text(t, x, y, { width: w, align: o.align || 'left', underline: !!o.underline, lineGap: 1.5 }); };
    const hOf = (t, w, o = {}) => { doc.font(o.font || F.r).fontSize(o.size || 9); return doc.heightOfString(t, { width: w, lineGap: 1.5 }); };
    const line = (t, o = {}) => { const hh = hOf(t, W, o); if (y + hh > BOTTOM) { doc.addPage(); y = M; } text(t, M, W, o); y += hh + (o.after ?? 2); };
    const pair = (label, value) => { doc.font(F.b).fontSize(10); const lw = doc.widthOfString(label); const hh = Math.max(hOf(value || ' ', W - lw, { size: 10 }), 12); if (y + hh > BOTTOM) { doc.addPage(); y = M; }
      doc.font(F.b).fontSize(10).fillColor(hex(DARK)).text(label, M, y, { lineBreak: false }); doc.font(F.r).fontSize(10).text(value || '', M + lw, y, { width: W - lw, lineGap: 1.5 }); y += hh + 2; };
    const box = (x, top, w, hgt, fill) => { if (fill) doc.rect(x, top, w, hgt).fill(hex(fill)); doc.lineWidth(0.5).strokeColor(hex(LINE)).rect(x, top, w, hgt).stroke(); };
    const tableHead = () => { const hh = 22; box(M, y, DESC, hh, ACCENT); box(M + DESC, y, TOT, hh, ACCENT); y += 6.5; text('DESCRIPTION / SCOPE', M + PAD, DESC - 2 * PAD, { font: F.b, size: 10, color: WHITE }); text('TOTAL', M + DESC, TOT, { font: F.b, size: 10, color: WHITE, align: 'center' }); y += hh - 6.5; };
    // header
    text(spec.date, M, W, { size: 9, color: GRAYT, align: 'right' }); y += 14;
    text(COMPANY.name, M, W, { font: F.b, size: 16, color: ACCENT }); y += 21; text(COMPANY.address, M, W); y += 12; text(COMPANY.phone, M, W); y += 14;
    doc.lineWidth(0.9).strokeColor(hex(ACCENT)).moveTo(M, y).lineTo(M + W, y).stroke(); y += 12;
    pair('Created For: ', [spec.createdFor, spec.projectName].filter(Boolean).join('  |  ')); pair('Project Address: ', spec.projectAddress); pair('Permit Set: ', spec.permitSet); pair('Scope: ', spec.scope); y += 10;
    // the proposal table: a trade's scope can run over several pages; each page part gets its own borders and the header again
    tableHead();
    for (const t of spec.trades) {
      if (y + 21 + 40 > BOTTOM) { doc.addPage(); y = M; tableHead(); }
      doc.rect(M, y, W, 21).fill(hex(BAND)); doc.lineWidth(0.5).strokeColor(hex(LINE)).rect(M, y, W, 21).stroke(); doc.lineWidth(0.8).strokeColor(hex(ACCENT)).moveTo(M, y).lineTo(M + W, y).stroke().moveTo(M, y + 21).lineTo(M + W, y + 21).stroke();
      y += 6; text(t.title, M + PAD, W - 2 * PAD, { font: F.b, size: 10, color: ACCENT, underline: true }); y += 15;
      let top = y, first = true; y += PAD;
      const close = () => { const hgt = Math.max(y + PAD - top, 28); box(M, top, DESC, hgt); box(M + DESC, top, TOT, hgt);
        if (first) { const keep = y; y = top + hgt / 2 - 5; text(priceText(t.total), M + DESC, TOT, { font: F.b, size: 9, align: 'center' }); y = keep; first = false; } y = top + hgt; };
      const put = (s, o, indent = 0, bullet = false) => { const w = DESC - 2 * PAD - indent, hh = hOf(s, w, o);
        if (y + hh + PAD > BOTTOM) { close(); doc.addPage(); y = M; tableHead(); top = y; y += PAD; }
        if (bullet) { doc.font(F.r).fontSize(9).fillColor(hex(DARK)).text('•', M + PAD + 4, y, { lineBreak: false }); }
        text(s, M + PAD + indent, w, o); y += hh + 3; };
      for (const n of t.notes) put(n, {}); for (const x of t.items) put(x, {}, 16, true); put(DISCLAIMER, { font: F.i, size: 8, color: GRAYT });
      close();
    }
    if (spec.grandTotal) { if (y + 24 > BOTTOM) { doc.addPage(); y = M; } const top = y; box(M, top, DESC, 24); box(M + DESC, top, TOT, 24); y = top + 7.5; text('TOTAL', M + PAD, DESC - 2 * PAD, { font: F.b, size: 10, align: 'right' }); text(priceText(sumOf(spec)), M + DESC, TOT, { font: F.b, size: 10, align: 'center' }); y = top + 24; }
    // flagged items
    if (spec.flagged.length) {
      y += 22; if (y + 90 > BOTTOM) { doc.addPage(); y = M; }
      line('FLAGGED ITEMS — REVIEW BEFORE SENDING', { font: F.b, size: 14, color: RED, underline: true, after: 5 }); line(FLAG_INTRO, { font: F.i, size: 9, after: 8 });
      const half = W / 2, fhead = () => { box(M, y, half, 20, RED); box(M + half, y, half, 20, RED); y += 6; text('ITEM', M + PAD, half - 2 * PAD, { font: F.b, size: 9, color: WHITE }); text('PLAN REFERENCE / NOTES', M + half + PAD, half - 2 * PAD, { font: F.b, size: 9, color: WHITE }); y += 14; };
      fhead();
      for (const f of spec.flagged) { const hh = Math.max(hOf(f.item, half - 2 * PAD, { font: F.b }), hOf(f.note || ' ', half - 2 * PAD)) + 2 * PAD - 2;
        if (y + hh > BOTTOM) { doc.addPage(); y = M; fhead(); }
        const top = y; box(M, top, half, hh); box(M + half, top, half, hh); y = top + PAD - 1; text(f.item, M + PAD, half - 2 * PAD, { font: F.b }); text(f.note, M + half + PAD, half - 2 * PAD); y = top + hh; }
    }
    doc.end();
  });
}
