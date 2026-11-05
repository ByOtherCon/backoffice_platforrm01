// Pick a file from the company SharePoint library: folders open on click, a path shows where you are, a file click chooses it.
// Resolves to { id, name } or null when closed. Everything is inserted with textContent (never innerHTML).
import { h, modal, notice } from '/ui.js';
export function pickFromSharePoint(api, { title = 'Choose a file from SharePoint' } = {}) {
  return new Promise((resolve) => {
    const err = h('div'), list = h('div', { class: 'sp-list' }), crumbs = h('div', { class: 'row', style: 'flex-wrap:wrap;gap:.3rem;margin:.3rem 0' });
    let trail = [{ id: 'root', name: 'Library' }], done = false;
    const bg = modal(title, h('div', { style: 'min-width:min(34rem,86vw)' }, h('p', { class: 'muted', style: 'margin-top:0' }, 'Open a folder, then click the PDF or photo to use.'), crumbs, err, list));
    const finish = (v) => { if (done) return; done = true; bg.remove(); resolve(v); };
    new MutationObserver(() => { if (!document.body.contains(bg)) finish(null); }).observe(document.body, { childList: true });
    async function open(id) {
      notice(err, ''); list.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
      try {
        const r = await api('GET', '/sharepoint/browse?id=' + encodeURIComponent(id));
        crumbs.replaceChildren(...trail.flatMap((t, i) => [i ? h('span', { class: 'muted' }, '›') : '', h('button', { type: 'button', class: 'small', onclick: () => { trail = trail.slice(0, i + 1); open(t.id); } }, t.name)]));
        list.replaceChildren(r.items.length ? h('div', { style: 'max-height:50vh;overflow:auto' }, h('table', {}, h('tbody', {}, r.items.map((it) => h('tr', {}, h('td', {}, h('button', { type: 'button', class: 'linklike', style: 'text-align:left', onclick: () => { if (it.folder) { trail = [...trail, { id: it.id, name: it.name }]; open(it.id); } else finish({ id: it.id, name: it.name }); } }, (it.folder ? '📁 ' : '📄 ') + it.name))))))) : h('p', { class: 'muted' }, 'Nothing to pick in this folder.'));
      } catch (e) { list.replaceChildren(); notice(err, e.message); }
    }
    open('root');
  });
}
