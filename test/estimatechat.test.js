import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
process.env.ANTHROPIC_API_KEY = 'test-key'; delete process.env.ANTHROPIC_ESTIMATE_MODEL;
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bo-est-'));
const { pool, q } = await import('../server/db.js');
const { server } = await import('../server/index.js');
const { hashPassword } = await import('../server/auth.js');
const ai = await import('../server/ai.js');
const ec = await import('../server/estimateChat.js');
const plans = await import('../server/plans.js');
const addr = await import('../server/address.js');
const { todayEastern, shift } = await import('../src/lib/estimating.ts');
const today = todayEastern();

// ---- a stand-in for the AI service: it keeps every request, takes file uploads, and answers a conversation with whatever `script` holds next
let uploads = [], requests = [], script = [], fileSeq = 0;
const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const startMsg = (usage = { input_tokens: 120, cache_creation_input_tokens: 9000, cache_read_input_tokens: 0, output_tokens: 1 }) => ({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], usage } });
const endMsg = (reason, out = 50) => [{ type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: out } }, { type: 'message_stop' }];
const textAnswer = (...pieces) => sse([startMsg(), { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-abc' } }, { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }, ...pieces.map((t) => ({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: t } })), { type: 'content_block_stop', index: 1 }, ...endMsg('end_turn')]);
const toolAnswer = (input, lead = 'Saving it now.') => { const j = JSON.stringify(input), half = Math.floor(j.length / 2);
  return sse([startMsg(), { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: lead } }, { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_' + (++fileSeq), name: 'save_proposal', input: {} } }, { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: j.slice(0, half) } }, { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: j.slice(half) } }, { type: 'content_block_stop', index: 1 }, ...endMsg('tool_use')]); };
const service = async (url, init = {}) => {
  if (String(url).endsWith('/v1/files')) { const f = init.body.get('file'); uploads.push({ name: f.name, size: f.size, head: Buffer.from(await f.arrayBuffer()).subarray(0, 5).toString() }); return { ok: true, status: 200, json: async () => ({ id: 'file_' + uploads.length }) }; }
  const body = JSON.parse(init.body); requests.push({ body, headers: init.headers }); const next = script.shift();
  if (!next) return { ok: true, status: 200, text: async () => textAnswer('(nothing scripted)') };
  if (next.status) return { ok: false, status: next.status, json: async () => ({ error: { message: next.message } }) };
  return { ok: true, status: 200, text: async () => next };
};
let pending = Promise.resolve(); const settle = () => pending;

// a small zip made by hand: one entry stored, one deflated, plus things that are not plans
const zipOf = (entries) => { const parts = [], central = []; let off = 0;
  for (const [name, data, deflate] of entries) { const nm = Buffer.from(name), comp = deflate ? zlib.deflateRawSync(data) : data, crc = zlib.crc32 ? zlib.crc32(data) : 0;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(deflate ? 8 : 0, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(deflate ? 8 : 0, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42);
    parts.push(lh, nm, comp); central.push(ch, nm); off += 30 + nm.length + comp.length; }
  const cd = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]); };
const pdf = (label) => Buffer.from(`%PDF-1.4\n% ${label}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF`);

let base, owner, est, pm, estId, oid;
const census = async (url) => { const u = new URL(url), c = (k) => u.searchParams.get(k); return { ok: true, json: async () => ({ result: { addressMatches: [{ matchedAddress: c('street'), addressComponents: { city: c('city'), state: c('state'), zip: c('zip'), fromAddress: c('street') } }] } }) }; };
async function call(method, p, body, cookie, raw) {
  const r = await fetch(base + p, { method, headers: { ...(body && !raw ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(raw ? { 'x-file-name': raw } : {}) }, body: body ? (raw ? body : JSON.stringify(body)) : undefined });
  const t = await r.text(); let b = null; try { b = t ? JSON.parse(t) : null; } catch { b = t; } return { status: r.status, body: b };
}
const login = async (email) => (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct horse battery' }) })).headers.get('set-cookie').split(';')[0];
const chat = async () => (await call('GET', `/api/opportunities/${oid}/estimate-chat`, null, est)).body;
const say = async (text, extra = {}) => { const r = await call('POST', `/api/opportunities/${oid}/estimate-chat`, { text, ...extra }, est); assert.equal(r.status, 200, JSON.stringify(r.body)); await settle(); return r.body; };
const PROPOSAL = { createdFor: 'CW Hayes Construction', projectName: 'Wingstop - St Cloud', projectAddress: '1200 13th St, St Cloud, FL 34769', permitSet: 'RDL Architects, Project #24-118, Issued 10/02/2026',
  trades: [{ name: 'Demolition', items: ['D-1: Remove and dispose of existing ACT ceiling.', 'D-2: Remove existing floor finish.'], total: 12500 }, { name: 'Framing', items: ['Type 1 partition: 3-5/8" 20 ga. studs — _____ LF'], total: null }],
  flagged: [{ item: 'Slab cutting', reference: 'P-1.0 keynote 4' }] };

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  const h = await hashPassword('correct horse battery');
  for (const [e, n, r] of [['owner@x.net', 'Benny', 'Super Admin'], ['est@x.net', 'Juliana', 'Estimator'], ['pm@x.net', 'Pat', 'Project Manager']]) await q('INSERT INTO app_users(email,name,role,password_hash) VALUES ($1,$2,$3,$4)', [e, n, r, h]);
  estId = (await q(`SELECT id FROM app_users WHERE email='est@x.net'`))[0].id;
  await q(`INSERT INTO trades(name,sort) VALUES ('Demolition',1),('Framing & Drywall',2)`);
  addr.setAddressFetch(census); ai.setFetch(service); ec.setRunner((fn) => { pending = fn(); });
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
  owner = await login('owner@x.net'); est = await login('est@x.net'); pm = await login('pm@x.net');
  const v = (await call('POST', '/api/address/verify', { street: '1200 13th St', city: 'St Cloud', state: 'FL', zip: '34769', kind: 'project' }, est)).body;
  const r = await call('POST', '/api/opportunities', { name: 'Wingstop - St Cloud', client: 'Wingstop', gc: 'CW Hayes Construction', addr: { ...v.address, token: v.token }, sourceType: 'Referral', estimatorId: estId, due: shift(today, 7), type: 'Other' }, est);
  assert.equal(r.status, 200, JSON.stringify(r.body)); oid = r.body.id;
});
after(async () => { server.close(); await pool.end(); fs.rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true }); });

test('a lead can be a project type of Other and come from a Referral', async () => {
  const o = (await call('GET', `/api/opportunities/${oid}`, null, est)).body; assert.deepEqual([o.type, o.sourceType], ['Other', 'Referral']);
});

test('a zip is read from disk: PDFs are found (stored or compressed), other files and Mac leftovers are skipped', async () => {
  const z = path.join(process.env.UPLOAD_DIR, 't.zip'); fs.writeFileSync(z, zipOf([['A-1.0 Floor Plan.pdf', pdf('a1'), false], ['sub/A-2.0 RCP.pdf', pdf('a2'), true], ['notes.txt', Buffer.from('x'), false], ['__MACOSX/._A-1.0 Floor Plan.pdf', Buffer.from('junk'), false]]));
  const es = await plans.zipPdfEntries(z); assert.deepEqual(es.map((e) => e.name), ['A-1.0 Floor Plan.pdf', 'sub/A-2.0 RCP.pdf']);
  const out = path.join(process.env.UPLOAD_DIR, 'x.pdf'); await plans.zipExtract(z, es[1], out); assert.deepEqual(fs.readFileSync(out), pdf('a2')); fs.rmSync(z); fs.rmSync(out);
});

test('the estimating instructions are byOther\'s own; only the owner can replace them, and can go back to the original', async () => {
  const d = (await call('GET', '/api/estimating/instructions', null, est)).body; assert.equal(d.custom, false); assert.match(d.text, /byOther Construction — Estimating Skill/); assert.match(d.text, /Pricing Guide/); assert.match(d.text, /FLAGGED ITEMS/);
  assert.equal((await call('PUT', '/api/estimating/instructions', { text: 'x' }, est)).status, 403);
  const s = (await call('PUT', '/api/estimating/instructions', { text: 'Version 2.42: always quote ACT by the square foot.' }, owner)).body; assert.equal(s.custom, true);
  assert.match(await ec.systemPrompt(), /Version 2\.42: always quote ACT by the square foot\./); assert.match(await ec.systemPrompt(), /call the save_proposal tool/);
  // the version is named, and the chat page says which one is being followed
  const named = (await call('PUT', '/api/estimating/instructions', { text: 'Estimating rules 2.42: demo dumpster is now $1,050.', label: 'Estimating 2.42' }, owner)).body; assert.deepEqual([named.label, named.updatedBy], ['Estimating 2.42', 'Benny']);
  assert.deepEqual((({ label, updatedBy, custom }) => [label, updatedBy, custom])((await chat()).instructions), ['Estimating 2.42', 'Benny', true]);
  const back = (await call('PUT', '/api/estimating/instructions', { reset: true }, owner)).body; assert.deepEqual([back.custom, back.label], [false, 'Original (as set up)']);
});

test('the latest estimating file can be loaded from the file itself: text, Markdown, or a Word document; only by the owner', async () => {
  const up = (bytes, name, who = owner) => call('POST', '/api/estimating/instructions/file', bytes, who, name);
  assert.equal((await up(Buffer.from('x'), 'rules.md', est)).status, 403);
  const md = await up(Buffer.from('# Estimating 2.43\n\nDumpster, 30-yard: $1,100'), 'Estimating 2.43.md'); assert.equal(md.status, 200); assert.match(md.body.text, /Dumpster, 30-yard: \$1,100/);
  const xml = '<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>Estimating 2.44</w:t></w:r></w:p><w:p><w:r><w:t>Framing &amp; drywall: $9.50</w:t></w:r><w:r><w:tab/><w:t>per SF</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>ACT</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>$4.25</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>';
  const docx = await up(zipOf([['[Content_Types].xml', Buffer.from('<Types/>'), false], ['word/document.xml', Buffer.from(xml), true]]), 'Estimating 2.44.docx'); assert.equal(docx.status, 200, JSON.stringify(docx.body));
  assert.match(docx.body.text, /^Estimating 2\.44\nFraming & drywall: \$9\.50\tper SF\nACT/); assert.match(docx.body.text, /\$4\.25/);
  assert.equal((await up(Buffer.from('%PDF-1.4'), 'rules.pdf')).status, 400); assert.equal((await up(Buffer.alloc(0), 'rules.md')).status, 400);
  assert.equal((await call('GET', '/api/estimating/instructions', null, est)).body.custom, false);   // reading a file changes nothing until it is saved
});

test('the plans already on the lead are used: nothing is asked for again, each file goes to the AI once, and the answer arrives as it is written', async () => {
  assert.equal((await call('POST', `/api/opportunities/${oid}/plans`, pdf('cover sheet'), est, 'G-0.0 Cover.pdf')).status, 200);
  assert.equal((await call('POST', `/api/opportunities/${oid}/plans`, zipOf([['A-1.0 Floor Plan.pdf', pdf('a1'), false], ['A-2.0 RCP.pdf', pdf('a2'), true]]), est, 'Bid Set.zip')).status, 200);
  let c = await chat(); assert.deepEqual(c.plans.map((p) => [p.name, p.zip]), [['G-0.0 Cover.pdf', false], ['Bid Set.zip', true]]); assert.equal(c.chatId, null); assert.equal(c.aiConnected, true);
  assert.equal((await call('POST', `/api/opportunities/${oid}/estimate-chat`, { text: 'hi' }, pm)).status, 403);
  script = [textAnswer('Here is the ', 'demolition scope.')];
  const ids = await say('Read these plans and list the demolition scope.');
  assert.deepEqual(uploads.map((u) => [u.name, u.head]), [['G-0.0 Cover.pdf', '%PDF-'], ['A-1.0 Floor Plan.pdf', '%PDF-'], ['A-2.0 RCP.pdf', '%PDF-']]);
  const rq = requests[0].body, first = rq.messages[0].content;
  assert.equal(rq.stream, true); assert.equal(rq.model, 'claude-sonnet-5-5'); assert.match(rq.system[0].text, /byOther Construction — Estimating Skill/); assert.deepEqual(rq.system[0].cache_control, { type: 'ephemeral' });
  assert.deepEqual(first.filter((b) => b.type === 'document').map((b) => [b.source.type, b.source.file_id, b.title]), [['file', 'file_1', 'G-0.0 Cover.pdf'], ['file', 'file_2', 'A-1.0 Floor Plan.pdf'], ['file', 'file_3', 'A-2.0 RCP.pdf']]);
  assert.deepEqual(first[2].cache_control, { type: 'ephemeral' });   // the plans are cached for the turns that follow
  const txt = first.at(-1).text; assert.match(txt, /Project: Wingstop - St Cloud/); assert.match(txt, /GC: CW Hayes Construction/); assert.match(txt, /Read these plans and list the demolition scope\./);
  assert.deepEqual(rq.tools.map((t) => t.name), ['save_proposal']);
  c = await chat(); assert.equal(c.chatId, ids.chatId); assert.deepEqual(c.messages.map((m) => [m.role, m.status, m.text]), [['user', 'done', 'Read these plans and list the demolition scope.'], ['assistant', 'done', 'Here is the demolition scope.']]);
  assert.equal(c.messages[0].who, 'Juliana'); assert.equal(c.working, false);
  const [use] = await q(`SELECT kind, model, input_tokens, output_tokens, cache_write_tokens FROM ai_usage WHERE kind='estimate'`); assert.deepEqual([use.model, use.input_tokens, use.output_tokens, use.cache_write_tokens], ['claude-sonnet-5-5', 9120, 50, 9000]);
});

test('asking for the document saves a .pdf and a .docx on the lead as version 1; the conversation carries on from what was said before', async () => {
  script = [toolAnswer(PROPOSAL), textAnswer('Version 1 is saved. Framing still needs a price.')];
  await say('Looks right. Demolition is $12,500. Make the proposal.');
  assert.equal(uploads.length, 3);   // the plans were not sent again
  const second = requests[1].body.messages; assert.equal(second.length, 3); assert.equal(second[1].role, 'assistant'); assert.deepEqual(second[1].content.map((b) => b.type), ['thinking', 'text']); assert.equal(second[1].content[0].signature, 'sig-abc');   // the earlier answer goes back exactly as it came
  assert.ok(!second[2].content.some((b) => b.type === 'document'));
  const third = requests[2].body.messages, result = third.at(-1).content[0]; assert.equal(third.at(-2).content.at(-1).type, 'tool_use'); assert.deepEqual(third.at(-2).content.at(-1).input.trades[0].total, 12500);
  const stem = `byOther Proposal-CW Hayes Construction_Wingstop - St Cloud_St Cloud_${today.slice(5, 7)}-${today.slice(8, 10)}-${today.slice(0, 4)}`;   // byOther Proposal-P#_GC_Project Name_City_Date (no P# until the lead is accepted)
  assert.equal(result.type, 'tool_result'); assert.equal(result.content, `Saved as version 1: ${stem}.pdf and ${stem}.docx. Prices still blank: FRAMING. 1 flagged item was recorded on the lead and is not printed on the proposal.`);
  const c = await chat(), last = c.messages.at(-1); assert.equal(last.text, 'Saving it now.\n\nVersion 1 is saved. Framing still needs a price.'); assert.deepEqual(last.files.map((f) => f.kind), ['PDF', 'Word']);
  const dl = await fetch(`${base}/api/opportunity-files/${last.files[0].id}`, { headers: { cookie: est } }); assert.equal(dl.status, 200); assert.equal(Buffer.from(await dl.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  const dx = await fetch(`${base}/api/opportunity-files/${last.files[1].id}`, { headers: { cookie: est } }); assert.equal(dx.status, 200); const word = Buffer.from(await dx.arrayBuffer()); assert.equal(word.subarray(0, 2).toString(), 'PK');
  // the Word file is the official template, filled in: same logo, header and footer; the blanks carry the GC, the project and its site, the trades and their scope
  const JSZip = (await import('jszip')).default, tpl = await JSZip.loadAsync(fs.readFileSync(new URL('../server/estimator/proposal-template.docx', import.meta.url))), made = await JSZip.loadAsync(word);
  const names = (z) => Object.keys(z.files).sort(); assert.deepEqual(names(made), names(tpl));
  for (const same of ['word/media/image1.png', 'word/styles.xml', 'word/numbering.xml', 'word/footer1.xml', 'word/theme/theme1.xml']) assert.ok((await made.file(same).async('nodebuffer')).equals(await tpl.file(same).async('nodebuffer')), same + ' is untouched');
  const xml = await made.file('word/document.xml').async('string'), words = xml.replace(/<[^>]+>/g, '\u0001').replace(/\u0001+/g, '|');
  assert.match(words, /Created For\|: \|CW Hayes Construction: Wingstop - St Cloud – 1200 13th St, St Cloud, FL 34769\|/); assert.match(words, /Scope\|:\| \|DEMOLITION\/FRAMING\|/i); assert.ok(!/GC Name|Xxxxxx|Breakdown item|PXXXXX/.test(words));
  assert.match(words, /\|DEMOLITION\|D-1: Remove and dispose of existing ACT ceiling\.\|D-2: Remove existing floor finish\.\|\*any item not explicitly listed is not included in\| \|Scope or Price\|\$12,500\.00\|FRAMING\|Type 1 partition: 3-5\/8" 20 ga\. studs — _____ LF\|\*any item/);
  assert.match(words, /\$_____\|/); assert.equal((xml.match(/<w:numPr>/g) || []).length, 3); assert.equal((xml.match(/<w:drawing>/g) || []).length, (await tpl.file('word/document.xml').async('string')).match(/<w:drawing>/g).length);   // three bullets; the logo is still there
  assert.ok(!/Slab cutting/.test(words));   // flagged items are for the estimator, not for the GC
  const hdr = await made.file('word/header1.xml').async('string'); assert.ok(!/fldChar/.test(hdr)); assert.match(hdr, /[A-Z][a-z]+ \d{1,2}, \d{4}/);   // the date is the proposal's date and no longer changes when the file is opened
  const o = (await call('GET', `/api/opportunities/${oid}`, null, est)).body; assert.equal(o.files.filter((f) => f.kind === 'Proposal').length, 2); assert.ok(o.notes.some((n) => /Proposal version 1 written with the AI estimator by Juliana: DEMOLITION \$12,500\.00, FRAMING \$_____\. Earlier versions are kept\. Permit set: RDL Architects, Project #24-118, Issued 10\/02\/2026\. Flagged for review before sending \(not printed on the proposal\): Slab cutting \(P-1\.0 keynote 4\)/.test(n.body)));
  const pr = (await call('GET', `/api/opportunity-files/${last.files[0].id}/prices`, null, est)).body; assert.deepEqual(pr.trades.map((t) => [t.trade, t.amount, !!t.tradeId]), [['DEMOLITION', 12500, true]]); assert.equal(pr.version, 1);   // matched to the app's Demolition trade, ready for the Submit window
  assert.equal((await call('GET', `/api/opportunity-files/${last.files[1].id}/prices`, null, est)).status, 400);
});

test('saving again adds version 2 and keeps version 1', async () => {
  script = [toolAnswer({ ...PROPOSAL, trades: [PROPOSAL.trades[0], { ...PROPOSAL.trades[1], total: 30000 }] }, ''), textAnswer('Version 2 is saved.')];
  await say('Framing is $30,000. Update it.');
  const c = await chat(); assert.deepEqual(c.proposals.map((p) => p.version), [2, 2, 1, 1]); assert.match(c.proposals[0].name, /^byOther Proposal-CW Hayes Construction_Wingstop - St Cloud_St Cloud_\d\d-\d\d-\d{4} \(2\)\.(pdf|docx)$/);   // a second one the same day is added beside the first
  await q(`UPDATE opportunities SET proposal_id='P26011' WHERE id=$1`, [oid]); script = [toolAnswer(PROPOSAL, ''), textAnswer('Saved.')]; await say('Save it once more.');
  assert.match((await chat()).proposals[0].name, /^byOther Proposal-P26011_CW Hayes Construction_Wingstop - St Cloud_St Cloud_\d\d-\d\d-\d{4}\.(pdf|docx)$/);   // once the lead has its P number the name starts with it await q(`UPDATE opportunities SET proposal_id=NULL WHERE id=$1`, [oid]);
  assert.equal((await q('SELECT count(*)::int AS n FROM opportunity_files WHERE opportunity_id=$1 AND version=1', [oid]))[0].n, 2);
});

test('a proposal the AI sends incomplete is not saved: it is told why and can try again; a service error is shown and the next message still works', async () => {
  script = [toolAnswer({ projectName: 'Wingstop - St Cloud', trades: [] }, ''), textAnswer('It needs at least one trade. What should it include?')];
  await say('Save a blank one.');
  const res = requests.at(-1).body.messages.at(-1).content[0]; assert.equal(res.is_error, true); assert.match(res.content, /^Not saved: The proposal needs at least one trade/);
  assert.equal((await chat()).proposals.length, 6);
  script = [{ status: 500, message: 'overloaded' }]; await say('And the ceilings?');
  let c = await chat(); assert.deepEqual([c.messages.at(-1).status, c.messages.at(-1).role], ['error', 'assistant']); assert.match(c.messages.at(-1).error, /AI service refused the request \(500: overloaded\)/);
  script = [textAnswer('ACT ceiling: 2x2 grid.')]; await say('Try again: and the ceilings?');
  c = await chat(); assert.equal(c.messages.at(-1).text, 'ACT ceiling: 2x2 grid.');
  const roles = requests.at(-1).body.messages.map((m) => m.role); assert.deepEqual(roles.slice(-2), ['user', 'user']);   // the failed answer is left out; both questions are there
});

test('plans added later are attached to the next message only; a new conversation starts clean but uses the same plans without sending them again', async () => {
  assert.equal((await call('POST', `/api/opportunities/${oid}/plans`, pdf('addendum'), est, 'Addendum 1.pdf')).status, 200);
  script = [textAnswer('Addendum noted.')]; await say('There is an addendum.');
  assert.equal(uploads.length, 4); const lastMsg = requests.at(-1).body.messages.at(-1).content; assert.deepEqual(lastMsg.filter((b) => b.type === 'document').map((b) => b.title), ['Addendum 1.pdf']); assert.match(lastMsg.at(-1).text, /New plan files were added to the lead and are attached: Addendum 1\.pdf/);
  script = [textAnswer('Fresh start.')]; const ids = await say('Start over on pricing.', { newChat: true });
  assert.equal(uploads.length, 4); const rq = requests.at(-1).body.messages; assert.equal(rq.length, 1); assert.equal(rq[0].content.filter((b) => b.type === 'document').length, 4);
  const c = await chat(); assert.equal(c.chatId, ids.chatId); assert.equal(c.chats.length, 2); assert.equal(c.messages.length, 2);
  const old = (await call('GET', `/api/opportunities/${oid}/estimate-chat?chat=${c.chats[1].id}`, null, est)).body; assert.ok(old.messages.length > 6);   // the first conversation is still there
});

test('the official proposal template: everyone estimating can see and download it; only the owner can load a newer one, and a file that is not the template is refused', async () => {
  const info = (await call('GET', '/api/estimating/proposal-template', null, est)).body; assert.deepEqual([info.custom, info.name], [false, 'byOther Proposal template.docx']);
  const dl = await fetch(`${base}/api/estimating/proposal-template/file`, { headers: { cookie: est } }); assert.equal(dl.status, 200); const original = Buffer.from(await dl.arrayBuffer()); assert.equal(original.subarray(0, 2).toString(), 'PK');
  const up = (bytes, name, who = owner) => call('POST', '/api/estimating/proposal-template', bytes, who, name);
  assert.equal((await up(original, 'New template.docx', est)).status, 403);
  assert.equal((await up(Buffer.from('not a word file'), 'x.docx')).status, 400); assert.equal((await up(original, 'template.pdf')).status, 400);
  const blank = await up(zipOf([['word/document.xml', Buffer.from('<w:document><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body></w:document>'), true]]), 'Letterhead.docx'); assert.equal(blank.status, 400); assert.match(blank.body.error, /template is missing its Description\/Scope table/);
  // a newer template (here: the same one with a different company line) takes effect for the next proposal
  const JSZip = (await import('jszip')).default, z = await JSZip.loadAsync(original); z.file('word/document.xml', (await z.file('word/document.xml').async('string')).replace('184', '200'));
  const ok = await up(await z.generateAsync({ type: 'nodebuffer' }), 'byOther Proposal 2027.docx'); assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.deepEqual([ok.body.custom, ok.body.name, ok.body.updatedBy], [true, 'byOther Proposal 2027.docx', 'Benny']); assert.match(ok.body.found.forLine, /GC Name/);
  script = [toolAnswer(PROPOSAL, ''), textAnswer('Saved.')]; await say('Save it on the new template.');
  const f = (await chat()).messages.at(-1).files.find((x) => x.kind === 'Word'), made = await JSZip.loadAsync(Buffer.from(await (await fetch(`${base}/api/opportunity-files/${f.id}`, { headers: { cookie: est } })).arrayBuffer()));
  assert.match(await made.file('word/document.xml').async('string'), /<w:t>200<\/w:t>/);
  assert.equal((await call('DELETE', '/api/estimating/proposal-template', null, est)).status, 403); assert.equal((await call('DELETE', '/api/estimating/proposal-template', null, owner)).body.custom, false);
});
