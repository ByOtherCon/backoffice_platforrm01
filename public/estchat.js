// Estimate With AI: the conversation between an estimator and the AI on one lead. It reads the lead's plans, follows byOther's own
// estimating instructions, and saves each proposal it writes as a new version on the lead. Text is inserted with textContent only.
import { h, notice, guard, modal } from '/ui.js';
let C;
export const init = (c) => { C = c; };
const api = (...a) => C.api(...a);

// ---------------------------------------------------------------- Markdown, drawn safely (no HTML is ever inserted)
function inline(s) {
  const out = []; let rest = String(s);
  const re = /(\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`|\[([^\]]+)\]\((https:\/\/[^\s)]+)\)|\*([^*\s][^*]*)\*|(?<![A-Za-z0-9])_([^_\s][^_]*)_(?![A-Za-z0-9]))/;
  for (let m; (m = re.exec(rest));) {
    if (m.index) out.push(rest.slice(0, m.index));
    if (m[2] || m[3]) out.push(h('strong', {}, m[2] || m[3])); else if (m[4]) out.push(h('code', {}, m[4])); else if (m[5]) out.push(h('a', { href: m[6], target: '_blank', rel: 'noopener' }, m[5])); else out.push(h('em', {}, m[7] || m[8]));
    rest = rest.slice(m.index + m[0].length);
  }
  if (rest) out.push(rest); return out;
}
export function markdown(src) {
  const lines = String(src || '').replace(/\r/g, '').split('\n'), out = []; let i = 0;
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    if (/^```/.test(l)) { const buf = []; i++; while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]); i++; out.push(h('pre', {}, buf.join('\n'))); continue; }
    const hd = l.match(/^(#{1,4})\s+(.*)$/); if (hd) { out.push(h('h' + Math.min(4, hd[1].length + 1), {}, inline(hd[2]))); i++; continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(l)) { out.push(h('hr')); i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = cells(l); i += 2; const rows = []; while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      const numeric = (c0) => { const c = c0.replace(/[*_`]/g, ''); return /^[$(-]?[\d,.]+%?\)?$/.test(c) || /^\$/.test(c); };
      out.push(h('div', { class: 'scroll' }, h('table', { class: 'nostack' }, h('thead', {}, h('tr', {}, head.map((c) => h('th', {}, inline(c))))), h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c) => h('td', { class: numeric(c) ? 'n' : '' }, inline(c)))))))));
      continue;
    }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(l)) {
      const ordered = /^\s*\d+[.)]\s+/.test(l), items = [];
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) { let t = lines[i].replace(/^\s*([-*•]|\d+[.)])\s+/, ''); i++; while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) t += ' ' + lines[i++].trim(); items.push(t); }
      out.push(h(ordered ? 'ol' : 'ul', {}, items.map((t) => h('li', {}, inline(t)))));
      continue;
    }
    const para = [l]; i++; while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*([-*•]|\d+[.)])\s+|\s*\|.*\|\s*$)/.test(lines[i])) para.push(lines[i++]);
    const p = h('p', {}); para.forEach((t, k) => { if (k) p.append(h('br')); p.append(...inline(t)); }); out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------- the conversation
const mb = (n) => (n ? ` (${(n / 1048576).toFixed(n > 10485760 ? 0 : 1)} MB)` : '');
const when = (d) => new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const STARTERS = ['Read the plans and draft the proposal with a section for each trade in our scope.', 'What is in our scope for demolition? List it by keynote.', 'List everything that should be flagged before we send a proposal.'];

export async function estimateChatView(oppId, canWrite) {
  let data = await api('GET', `/opportunities/${oppId}/estimate-chat${C.state.estChatId ? '?chat=' + C.state.estChatId : ''}`), timer = 0, alive = true, latest = {};
  const here = location.hash, err = h('div'), list = h('div', { class: 'chat-list' }), side = h('div'), box = h('textarea', { rows: 2, placeholder: 'Ask about the plans, price a trade, or ask for the proposal…', disabled: canWrite ? null : true });
  const send = h('button', { class: 'primary', type: 'button' }, 'Send');
  const nearBottom = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;
  const toBottom = () => window.scrollTo({ top: document.documentElement.scrollHeight });
  const fileChip = (f) => h('a', { class: 'chat-file', href: `/api/opportunity-files/${f.id}`, target: '_blank', rel: 'noopener' }, h('strong', {}, f.kind || (/\.pdf$/i.test(f.name) ? 'PDF' : 'Word')), ' ', f.name);
  const bubble = (m) => {
    if (m.role === 'user') return h('div', { class: 'chat-msg me' }, h('div', { class: 'chat-who' }, `${m.who || 'You'} · ${when(m.at)}`), h('div', { class: 'chat-bubble' }, m.text.split('\n').flatMap((t, k) => (k ? [h('br'), t] : [t]))));
    const body = h('div', { class: 'chat-bubble' }, m.text ? markdown(m.text) : '', m.status === 'working' ? h('div', { class: 'chat-dots' }, h('i'), h('i'), h('i')) : '',
      m.status === 'error' ? h('div', { class: 'err' }, m.error || 'This answer failed. Send your message again.') : '', (m.files || []).length ? h('div', { class: 'chat-files' }, m.files.map(fileChip)) : '');
    return h('div', { class: 'chat-msg ai' }, h('div', { class: 'chat-who' }, `AI Estimator · ${when(m.at)}`), body);
  };
  const drawSide = () => {
    const plans = data.plans.length ? h('div', {}, data.plans.map((p) => h('div', { class: 'chat-plan' }, p.name, h('span', { class: 'muted' }, `${mb(p.size)}${p.zip ? ' · the PDFs inside are read' : ''}${p.missing ? ' · not found in SharePoint' : ''}`))))
      : h('p', { class: 'muted', style: 'margin:.2rem 0' }, 'No plans on this lead yet. Upload them and they are saved to the lead once; or ask a question without plans.');
    const up = h('input', { type: 'file', accept: '.pdf,.zip', style: 'display:none', onchange: guard(err, async () => { const f = up.files[0]; up.value = ''; if (!f) return; notice(err, `Uploading ${f.name}…`, 'ok'); await C.uploadFile(`/opportunities/${oppId}/plans`, f); notice(err, `${f.name} is saved on the lead and will be read with your next message.`, 'ok'); data = await load(); drawSide(); }) });
    // the official proposal template the files are made from: everyone can download it, the owner can load a newer one
    const sup = C.state.user?.role === 'Super Admin', tp = data.template;
    const tplUp = h('input', { type: 'file', accept: '.docx', style: 'display:none', onchange: guard(err, async () => { const f = tplUp.files[0]; tplUp.value = ''; if (!f) return;
      if (!confirm(`Use ${f.name} as the proposal template from now on?\n\nIt has to keep the "GC Name: Project Name – Project Location" line, the "Scope:" line and the table row with the trade, bullet lines and "$". Proposals already saved are not changed.`)) return;
      const r = await C.uploadFile('/estimating/proposal-template', f); notice(err, `${r.name} is now the proposal template. The next proposal uses it.`, 'ok'); data = await load(); drawSide(); }) });
    const template = tp ? h('div', { style: 'margin-top:.7rem' }, h('label', {}, 'Proposal template'), h('div', { class: 'chat-plan' }, tp.name, h('span', { class: 'muted' }, tp.custom ? ` · loaded ${when(tp.updatedAt)}${tp.updatedBy ? ' by ' + tp.updatedBy : ''}` : ' · the official template'), '  ',
      h('a', { href: '/api/estimating/proposal-template/file', target: '_blank', rel: 'noopener' }, 'Download'),
      sup ? [' ', tplUp, h('button', { class: 'small', type: 'button', onclick: () => tplUp.click() }, 'Load A New Template'), tp.custom ? [' ', h('button', { class: 'small', type: 'button', onclick: guard(err, async () => { if (!confirm('Go back to the original proposal template?')) return; await api('DELETE', '/estimating/proposal-template'); data = await load(); drawSide(); }) }, 'Back To The Original')] : ''] : '')) : '';
    side.replaceChildren(h('div', { class: 'card chat-side' },
      h('div', { class: 'row spread' }, h('label', { style: 'margin:0' }, 'Plans the AI reads'), canWrite ? h('span', {}, up, h('button', { class: 'small', type: 'button', onclick: () => up.click() }, data.plans.length ? 'Add Plans' : 'Upload Plans')) : ''), plans,
      latest.latestPdf || latest.latestWord || latest.proposalFolderUrl ? h('div', { style: 'margin-top:.7rem' }, h('label', {}, 'Latest proposal'),
        [['PDF', latest.latestPdf], ['Word', latest.latestWord]].filter((x) => x[1]).map(([l, f]) => h('div', { class: 'chat-plan' }, h('strong', {}, l), ' ', h('a', { href: f.href, target: '_blank', rel: 'noopener' }, f.name), h('span', { class: 'muted' }, f.at ? ` · ${when(f.at)}` : ''))),
        latest.proposalFolderUrl ? h('div', { class: 'chat-plan' }, h('a', { href: latest.proposalFolderUrl, target: '_blank', rel: 'noopener' }, 'Open The Proposal Folder In SharePoint')) : '') : '', template));
  };
  const draw = (stick) => {
    list.replaceChildren(...(data.messages.length ? data.messages.map(bubble) : [h('div', { class: 'chat-empty' }, h('h2', {}, 'Estimate this job with the AI'),
      h('p', { class: 'muted' }, 'It reads the plans on this lead and follows the byOther estimating instructions. Ask it anything, price a trade together, and ask for the proposal when you are ready: each one is saved to the lead as a new version, and this conversation stays with the lead.'),
      canWrite ? h('div', { class: 'chat-starters' }, STARTERS.map((s) => h('button', { type: 'button', class: 'small', onclick: () => { box.value = s; box.focus(); } }, s))) : '')]));
    send.disabled = !canWrite || data.working || !data.aiConnected ? true : null; send.textContent = data.working ? 'Answering…' : 'Send';
    if (stick) toBottom();
  };
  const load = () => api('GET', `/opportunities/${oppId}/estimate-chat${data?.chatId ? '?chat=' + data.chatId : ''}`);
  const poll = () => { clearTimeout(timer); if (!alive || location.hash !== here) { alive = false; return; } timer = setTimeout(async () => { try { const stick = nearBottom(); const was = data.working; data = await load(); draw(stick); if (was && !data.working) { drawSide(); loadLatest(); } } catch { /* try again */ } if (data.working) poll(); }, 1300); };
  // the latest proposal (PDF and Word) wherever it was saved, and the library folder; read on opening and again after each answer
  const loadLatest = async () => { try { latest = await api('GET', `/opportunities/${oppId}/proposal-files`); if (alive) drawSide(); } catch { /* the side card shows without it */ } };
  let startNew = false;
  const submit = guard(err, async () => {
    const t = box.value.trim(); if (!t || data.working) return; notice(err, '');
    const ids = await api('POST', `/opportunities/${oppId}/estimate-chat`, startNew ? { text: t, newChat: true } : { text: t, chatId: data.chatId });
    startNew = false; box.value = ''; C.state.estChatId = ids.chatId; data = await api('GET', `/opportunities/${oppId}/estimate-chat?chat=${ids.chatId}`); draw(true); poll();
  });
  send.onclick = submit; box.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } };
  // a new conversation starts with the next message; the one on screen stays saved on the lead
  const newChat = () => { if (data.messages.length && !confirm('Start a new conversation? This one stays saved on the lead and you can come back to it.')) return; startNew = true; data = { ...data, messages: [], working: false }; draw(false); box.focus(); };
  const pick = data.chats.length > 1 ? h('select', { onchange: (e) => { C.state.estChatId = e.target.value; C.render(); } }, data.chats.map((c, k) => h('option', { value: c.id }, `${k === 0 ? 'Latest conversation' : 'Conversation'} · started ${when(c.startedAt)} · ${c.messages} messages`))) : ''; if (pick) pick.value = data.chatId;
  const instr = h('button', { class: 'small', type: 'button', onclick: () => instructionsModal().catch((e) => notice(err, e.message)) }, 'Estimating Instructions');
  drawSide(); draw(false); loadLatest(); if (data.working) poll(); setTimeout(() => { if (data.messages.length) toBottom(); }, 50);
  return C.shell('estimating', [h('div', { class: 'chat-page' },
    h('div', { class: 'row spread', style: 'flex-wrap:wrap;gap:.5rem' }, h('div', {}, h('a', { href: '#/estimating/' + oppId }, '← Back to the lead'), h('h1', { style: 'margin:.2rem 0 0' }, 'Estimate With AI'), h('p', { class: 'sub', style: 'margin:0' }, [data.opportunity.proposalId, data.opportunity.name, data.opportunity.gc].filter(Boolean).join(' · '))),
      h('div', { class: 'row', style: 'gap:.4rem;flex-wrap:wrap' }, pick, canWrite ? h('button', { class: 'small', type: 'button', onclick: newChat }, 'New Conversation') : '', instr)),
    data.aiConnected ? '' : h('p', { class: 'err' }, 'AI is not connected yet. The owner adds the Anthropic API key on the server; then this works.'),
    h('p', { class: 'muted', style: 'font-size:13px;margin:.4rem 0 0' }, `Following: ${data.instructions.label}${data.instructions.updatedAt ? ' · updated ' + when(data.instructions.updatedAt) + (data.instructions.updatedBy ? ' by ' + data.instructions.updatedBy : '') : ''}.`),
    side, list, err,
    h('div', { class: 'chat-compose' }, box, send), h('p', { class: 'muted', style: 'font-size:12px;margin:.3rem 0 0' }, 'Enter sends, Shift+Enter starts a new line. The first answer on a full plan set can take a few minutes. Check quantities and prices yourself before sending a proposal.'))]);
}

// The instructions the AI follows. Everyone can read them. The app cannot see the estimating file kept in Claude chats, so when that file
// changes the owner loads the new one here (from the file, or pasted) and names the version; every conversation uses it from then on.
async function instructionsModal() {
  const d = await api('GET', '/estimating/instructions'), sup = C.state.user?.role === 'Super Admin', msg = h('div');
  const ta = h('textarea', { rows: 20, style: 'font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px', disabled: sup ? null : true }); ta.value = d.text;
  const label = h('input', { placeholder: 'For example: Estimating 2.42', value: d.custom && d.label !== 'Edited in the app' ? d.label : '', disabled: sup ? null : true });
  const pick = (append) => { const f = h('input', { type: 'file', accept: '.md,.markdown,.txt,.docx', style: 'display:none', onchange: guard(msg, async () => { const file = f.files[0]; if (!file) return; notice(msg, `Reading ${file.name}…`, 'ok');
    const r = await C.uploadFile('/estimating/instructions/file', file); ta.value = append ? `${ta.value.trim()}\n\n---\n\n${r.text}` : r.text; if (!label.value) label.value = file.name.replace(/\.[^.]+$/, '');
    notice(msg, `${file.name} was read (${r.text.length.toLocaleString()} characters) and ${append ? 'added to the end' : 'put in place of the text'}. Look it over, then press Save Instructions. Nothing changes until you save.`, 'ok'); }) }); document.body.append(f); f.click(); setTimeout(() => f.remove(), 60000); };
  const bg = modal('Estimating Instructions', h('div', {},
    h('p', { class: 'muted' }, h('strong', {}, `In use: ${d.label}`), d.updatedAt ? ` · updated ${when(d.updatedAt)}${d.updatedBy ? ' by ' + d.updatedBy : ''}` : '', '. ',
      sup ? 'The app cannot see your estimating file in Claude chats. When that file changes (new prices or rules), load the new file here or paste it, name the version, and save. Every conversation follows it from the next message on.' : 'Only the owner can change them.'),
    sup ? h('div', { class: 'row', style: 'gap:.5rem;flex-wrap:wrap;margin:.4rem 0;align-items:flex-end' }, h('div', { style: 'flex:1;min-width:14rem' }, h('label', {}, 'Version name'), label),
      h('button', { type: 'button', class: 'small', title: 'Replaces everything in the box with the text of a file (.md, .txt or .docx).', onclick: () => pick(false) }, 'Replace With A File'),
      h('button', { type: 'button', class: 'small', title: 'Keeps what is in the box and adds the text of a file after it, for example a new pricing guide.', onclick: () => pick(true) }, 'Add A File To The End')) : '',
    ta, msg, h('div', { class: 'row', style: 'margin-top:.8rem;justify-content:flex-end;gap:.5rem' }, h('button', { type: 'button', onclick: () => bg.remove() }, 'Close'),
      sup && d.custom ? h('button', { type: 'button', onclick: guard(msg, async () => { if (!confirm('Go back to the original instructions? Your edited text is discarded.')) return; await api('PUT', '/estimating/instructions', { reset: true }); bg.remove(); C.render(); }) }, 'Back To The Original') : '',
      sup ? h('button', { type: 'button', class: 'primary', onclick: guard(msg, async () => { await api('PUT', '/estimating/instructions', { text: ta.value, label: label.value }); bg.remove(); C.render(); }) }, 'Save Instructions') : '')), { mode: 'edit' });
}
