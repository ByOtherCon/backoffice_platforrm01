// Takeoff Studio, inside Estimate With AI (#/estimating/<lead>/takeoff). The estimator measures the plans on the lead (scale from a known
// length, walls by type and status, rooms with finishes from the finish schedule and RCP), Claude drafts each step and learns from the
// corrections, and the Report goes to the lead's estimating chat to be priced (Send to estimating chat). The whole takeoff is one
// document per lead (server/takeoffStudio.js); the plan PDFs are drawn here with pdf.js, served from the app itself.
let cssLoaded = false;
const MARKUP = `
  <header class="ts-top">
    <div class="brand"><span class="mark" aria-hidden="true"></span>Takeoff Studio</div>
    <a class="lead-link" href="#/estimating/__LEAD__">← <span id="leadName"></span></a>
    <div class="spacer"></div>
    <span class="status" id="saveStatus"></span>
    <a class="btn small" href="#/estimating/__LEAD__/chat">Open the estimating chat</a>
  </header>

  <div class="toolbar">
    <div class="tools" role="toolbar" aria-label="Tools" id="tools"></div>
    <div class="chips" id="toolChips"></div>
    <div class="spacer"></div>
    <label class="toggle"><input type="checkbox" id="ortho" checked> Ortho</label>
    <label class="toggle"><input type="checkbox" id="snap" checked> Snap</label>
    <label class="toggle"><input type="checkbox" id="showLen" checked> Lengths</label>
    <button class="btn small ghost" id="undoBtn" title="Undo (Ctrl+Z)">Undo</button>
    <button class="btn small ghost" id="redoBtn" title="Redo (Ctrl+Shift+Z)">Redo</button>
  </div>

  <div class="ts-main">
    <aside class="sheets">
      <div class="sec-h">Sheets</div>
      <ul class="sheet-list" id="sheetList"></ul>
      <div class="add-sheet">
        <div class="flabel">Plans on this lead</div>
        <div id="planList" class="plan-list"></div>
        <div class="field"><label for="upRole">Add pages as</label><select id="upRole"><option value="auto">Claude sorts them</option><option value="plan">Floor plan</option><option value="walltypes">Wall types</option><option value="finishes">Finish schedule</option><option value="elevation">Elevations</option><option value="rcp">Reflected ceiling plan</option></select></div>
        <label class="toggle"><input type="checkbox" id="allPages"> Include MEP, structural and other pages</label>
      </div>
    </aside>

    <section class="stage" id="stage">
      <canvas id="cv" aria-label="Drawing sheet"></canvas>
      <div class="banner" id="scaleBanner" hidden></div>
      <div class="hud"><span class="pill" id="hudScale">No scale</span><span class="pill" id="hudLive" hidden></span></div>
      <div class="zoom">
        <button class="btn small" id="zoomOut" aria-label="Zoom out">−</button>
        <button class="btn small" id="zoomFit">Fit</button>
        <button class="btn small" id="zoomIn" aria-label="Zoom in">+</button>
      </div>
    </section>

    <aside class="ledger">
      <div class="tabs" role="tablist">
        <button role="tab" data-tab="item" aria-selected="true">Sheet</button>
        <button role="tab" data-tab="takeoff" aria-selected="false">Report</button>
        <button role="tab" data-tab="library" aria-selected="false">Library</button>
        <button role="tab" data-tab="learn" aria-selected="false">Learning</button>
        <button role="tab" data-tab="chat" aria-selected="false">Chat</button>
      </div>
      <div class="pane" id="pane"></div>
    </aside>
  </div>
`;

export async function takeoffStudioView(C, leadId, canWrite){
  if (!cssLoaded){ const l = document.createElement("link"); l.rel = "stylesheet"; l.href = "/takeoff-studio.css"; document.head.append(l); cssLoaded = true; }
  const call = async (method, path, body, signal) => {
    let res;
    try { res = await fetch("/api" + path, {method, signal, credentials: "same-origin", headers: body ? {"content-type": "application/json"} : {}, body: body ? JSON.stringify(body) : undefined}); }
    catch (e){ const x = new Error(e?.name === "AbortError" ? "Stopped." : "The server could not be reached. Check the connection and try again."); x.code = e?.name === "AbortError" ? "cancelled" : "offline"; throw x; }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401){ C.state.user = null; C.render(); }
    if (!res.ok){ const x = new Error(data.error || "Something went wrong."); x.status = res.status; x.code = res.status === 429 ? "rate_limited" : res.status === 503 || res.status === 504 ? "unavailable" : "http"; throw x; }
    return data;
  };
  const first = await call("GET", `/opportunities/${leadId}/takeoff-studio`);
  const root = document.createElement("div"); root.className = "ts"; root.innerHTML = MARKUP.replaceAll("__LEAD__", leadId);
  mount(root, {C, call, leadId, canWrite, first});
  return C.shell("estimating", [root]);
}

function mount(root, {C, call, leadId, canWrite, first}){
const api = call;

/* ================= utilities ================= */
const $ = s => root.querySelector(s);
const byId = id => root.querySelector("#" + id);
const uid = () => Math.random().toString(36).slice(2, 10);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const clone = o => JSON.parse(JSON.stringify(o));
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const fmt = (n, d = 1) => (n == null || !isFinite(n)) ? "—" : n.toLocaleString(undefined, {minimumFractionDigits: d, maximumFractionDigits: d});
function lsGet(k){ try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v){ try { localStorage.setItem(k, v); } catch {} }

function parseLen(raw){
  let s = String(raw || "").trim().toLowerCase().replace(/[–—]/g, "-").replace(/[’′]/g, "'").replace(/[”″]/g, '"');
  if (!s) return NaN;
  s = s.replace(/(\d+)\s+(\d+)\/(\d+)/g, (a, w, n, d) => String(+w + n / d)).replace(/(^|[^\d.])(\d+)\/(\d+)/g, (a, p, n, d) => p + String(n / d));
  let m = s.match(/^(\d+(?:\.\d+)?)\s*(?:'|ft|feet)\s*-?\s*(?:(\d+(?:\.\d+)?)\s*(?:"|in|inch|inches)?)?$/);
  if (m) return parseFloat(m[1]) * 12 + (m[2] ? parseFloat(m[2]) : 0);
  m = s.match(/^(\d+(?:\.\d+)?)\s*(?:"|in|inch|inches)?$/);
  if (m) return parseFloat(m[1]);
  m = s.match(/^(\d+(?:\.\d+)?)\s*m$/); if (m) return parseFloat(m[1]) * 39.3701;
  m = s.match(/^(\d+(?:\.\d+)?)\s*mm$/); if (m) return parseFloat(m[1]) / 25.4;
  return NaN;
}
function fmtFtIn(inches){
  if (inches == null || !isFinite(inches)) return "—";
  let ft = Math.floor(inches / 12), rem = Math.round(inches - ft * 12);
  if (rem === 12){ ft++; rem = 0; }
  return `${ft}'-${rem}"`;
}
function polyLen(pts, closed){ let L = 0; for (let i = 1; i < pts.length; i++) L += dist(pts[i-1], pts[i]); if (closed && pts.length > 2) L += dist(pts[pts.length-1], pts[0]); return L; }
function polyArea(pts){ let a = 0; for (let i = 0; i < pts.length; i++){ const p = pts[i], q = pts[(i+1) % pts.length]; a += p[0]*q[1] - q[0]*p[1]; } return Math.abs(a) / 2; }
function nearestOnSeg(p, a, b){
  const dx = b[0]-a[0], dy = b[1]-a[1], L2 = dx*dx + dy*dy;
  let t = L2 ? ((p[0]-a[0])*dx + (p[1]-a[1])*dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
  const q = [a[0] + t*dx, a[1] + t*dy]; return {q, t, d: dist(p, q)};
}
function pointInPoly(p, pts){
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++){
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if (((yi > p[1]) !== (yj > p[1])) && (p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function lineSegIntersect(p1, p2, a, b){
  // infinite line p1-p2 with segment a-b
  const d1x = p2[0]-p1[0], d1y = p2[1]-p1[1], d2x = b[0]-a[0], d2y = b[1]-a[1];
  const den = d1x*d2y - d1y*d2x; if (Math.abs(den) < 1e-9) return null;
  const u = ((a[0]-p1[0])*d1y - (a[1]-p1[1])*d1x) / den;
  if (u < 0 || u > 1) return null;
  return [a[0] + u*d2x, a[1] + u*d2y];
}

/* ================= default library ================= */
const TYPE_COLORS = ["#d9480f","#1c7ed6","#2b8a3e","#ae3ec9","#e67700","#0c8599","#c92a2a","#5f3dc4","#495057","#a61e4d"];
function defaultLibrary(){
  return {
    types: [
      {id:"tA", tag:"A", desc:'3-5/8" 20ga mtl stud @ 16" o.c., (1) 5/8" Type X GWB each side, to 10\'-0" AFF', height:10, stud:3.625, spacing:16, sides:2, layers:1, insul:false, waste:10, color:TYPE_COLORS[0]},
      {id:"tB", tag:"B", desc:'3-5/8" 20ga mtl stud @ 16" o.c., (1) 5/8" Type X GWB each side, sound batt, to deck', height:14, stud:3.625, spacing:16, sides:2, layers:1, insul:true, waste:10, color:TYPE_COLORS[1]},
      {id:"tC", tag:"C", desc:'6" 20ga mtl stud @ 16" o.c., (2) 5/8" Type X GWB each side, 2-HR, to deck', height:14, stud:6, spacing:16, sides:2, layers:2, insul:true, waste:12, color:TYPE_COLORS[2]},
      {id:"tD", tag:"D", desc:'7/8" hat channel furring @ 24" o.c., (1) 5/8" GWB one side at exterior wall', height:12, stud:0.875, spacing:24, sides:1, layers:1, insul:false, waste:10, color:TYPE_COLORS[3]},
    ],
    callouts: [
      {id:"cPT1", code:"PT-1", name:"Paint, eggshell", unit:"SF", color:"#1c7ed6"},
      {id:"cCT1", code:"CT-1", name:"Ceramic wall tile", unit:"SF", color:"#2b8a3e"},
      {id:"cWC1", code:"WC-1", name:"Vinyl wall covering", unit:"SF", color:"#ae3ec9"},
      {id:"cRB1", code:"RB-1", name:'Rubber base, 4"', unit:"LF", color:"#e67700"},
      {id:"cWP1", code:"WP-1", name:"Wall protection rail", unit:"LF", color:"#0c8599"},
      {id:"cCG1", code:"CG-1", name:"Corner guard", unit:"EA", color:"#c92a2a"},
      {id:"cACT1", code:"ACT-1", name:"Acoustic ceiling tile, 2x2", unit:"SF", applies:"ceiling", color:"#5f3dc4"},
      {id:"cCPT1", code:"CPT-1", name:"Carpet tile", unit:"SF", applies:"floor", color:"#a61e4d"},
    ]
  };
}

/* ================= state ================= */
const mapRules = rs => (rs || []).map(r => ({id: r.id, text: r.text, scope: r.scope, source: r.source, thisLead: !!r.thisLead, createdAt: r.at ? Date.parse(r.at) : Date.now(), by: r.by}));
// a new takeoff starts from the company list (Library → "Use these … for new takeoffs"), or empty: wall types come from the plans
let lib = {types: first.library?.types || [], callouts: first.library?.callouts || []};
let lessons = mapRules(first.rules);
let version = first.version || 0;
let project = first.data ? first.data : {types: clone(lib.types), callouts: clone(lib.callouts), sheets: [], corrections: [], deductOpenings: true, defaultCeilingHt: 9, createdAt: Date.now()};
project.id = leadId; project.name = first.lead.name; project.sheets ||= []; project.corrections ||= [];
const cur = {sheetId: project.sheets[0]?.id || null, tool: "select", typeId: (project.types || lib.types)[0]?.id || null, calloutId: null, sel: null, selV: -1, draft: null, hover: null, tab: "item", scope: "all", calib: null, aiNote: "", ai: null};
const views = {};
const imgs = {};
const undo = [], redo = [];
const sampleFn = canWrite && first.aiConnected ? askClaude : null, canImages = true;
const downloads = {save: async ({filename, data}) => {
  const b = data instanceof Blob ? data : new Blob([data], {type: /\.json$/i.test(filename) ? "application/json" : "text/csv"});
  const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = filename; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}};

const sheet = () => project.sheets.find(s => s.id === cur.sheetId) || project.sheets[0];

const PT = () => (project.types ||= clone(lib.types));
const wStat = it => it.status || "new";
const STATUS_LABEL = {new: "New", existing: "Existing (ETR)", demo: "Demolish"};
const typeById = id => PT().find(t => t.id === id);
const calloutById = id => PC().find(c => c.id === id);
const selItem = () => sheet()?.items.find(i => i.id === cur.sel);

/* ================= quantities ================= */
function itemQty(it, sh){
  const ppi = sh.ppi; if (!ppi) return null;
  if (it.kind === "partition" || it.kind === "linear") return polyLen(it.pts, false) / ppi / 12;      // LF
  if (it.kind === "opening") return dist(it.pts[0], it.pts[1]) / ppi;                                  // inches wide
  if (it.kind === "area" || it.kind === "room") return polyArea(it.pts) / (ppi * ppi) / 144;                                 // SF
  if (it.kind === "count") return it.pts.length;
  return null;
}
function partitionOf(op, sh){
  let best = null, bd = Infinity; const mid = [(op.pts[0][0]+op.pts[1][0])/2, (op.pts[0][1]+op.pts[1][1])/2];
  for (const it of sh.items) if (it.kind === "partition") for (let i = 1; i < it.pts.length; i++){ const d = nearestOnSeg(mid, it.pts[i-1], it.pts[i]).d; if (d < bd){ bd = d; best = it; } }
  return bd < 40 ? best : null;
}
function computeTakeoff(scope){
  const sheets = scope === "sheet" ? [sheet()] : project.sheets;
  const parts = {}, calls = {}, exist = {}, missingScale = [];
  for (const sh of sheets){
    if (!sh.ppi && sh.items.length) missingScale.push(sh.name);
    for (const it of sh.items){
      const q = itemQty(it, sh); if (q == null) continue;
      if (it.kind === "partition" && wStat(it) !== "new"){
        const st = wStat(it), h = it.heightFt || project.defaultCeilingHt || 9, e = exist[st] ||= {lf: 0, sf: 0, n: 0, noFin: 0};
        e.lf += q; e.sf += q * h; e.n++; if (it.noFinish) e.noFin += q;
      } else if (it.kind === "partition"){
        const t = typeById(it.typeId) || {id: "none", tag: "NEW?", desc: "New walls with no type tag yet: select them and assign a type", height: project.defaultCeilingHt || 10, sides: 2, layers: 1, spacing: 16, waste: 10, insul: false, color: "#868e96"};
        const h = it.heightFt || t.height;
        const r = parts[t.id] ||= {t, lf: 0, wallSf: 0, openSf: 0, runs: 0, heights: new Set()};
        r.lf += q; r.wallSf += q * h; r.runs += 1; r.heights.add(h);
      } else if (it.kind === "room"){ continue;
      } else if (it.kind === "opening"){
        const p = partitionOf(it, sh); if (!p || !project.deductOpenings) continue;
        const t = wStat(p) === "new" && typeById(p.typeId); if (!t) continue;
        const r = parts[t.id] ||= {t, lf: 0, wallSf: 0, openSf: 0, runs: 0, heights: new Set()};
        r.openSf += (q * (it.heightIn || 84)) / 144;
      } else {
        const c = calloutById(it.calloutId) || {id: "none", code: "?", name: "Unassigned", unit: it.kind === "area" ? "SF" : it.kind === "linear" ? "LF" : "EA", color: "#868e96"};
        const st = it.status === "existing" ? "existing" : "new";
        const r = calls[c.id + "|" + st] ||= {c, st, qty: 0, n: 0}; r.qty += q; r.n++;
      }
    }
  }
  const partRows = Object.values(parts).map(r => {
    const t = r.t, net = Math.max(0, r.wallSf - r.openSf);
    const gwb = net * (t.sides || 0) * (t.layers || 0) * (1 + (t.waste || 0) / 100);
    return {...r, net, gwb, boards: Math.ceil(gwb / 48), studs: Math.ceil(r.lf * 12 / (t.spacing || 16)) + r.runs, track: r.lf * 2, insul: t.insul ? net : 0};
  }).sort((a, b) => a.t.tag.localeCompare(b.t.tag));
  const callRows = Object.values(calls).sort((a, b) => a.c.code.localeCompare(b.c.code));
  return {partRows, callRows, exist, missingScale};
}

/* ================= persistence: one takeoff per lead, in the platform's database ================= */
let saveTimer = null;
function setStatus(txt, cls = ""){ const el = $("#saveStatus"); if (el){ el.textContent = txt; el.className = "status " + cls; } }
function dirty(){
  if (!canWrite){ setStatus("View only: changes are not saved"); return; }
  if (saveBlocked) return;
  setStatus("Unsaved changes…");
  clearTimeout(saveTimer); saveTimer = setTimeout(saveProject, 1200);
}
function serializeProject(){ const p = clone(project); p.updatedAt = Date.now(); return p; }
let saving = null, saveAgain = false, saveBlocked = false;
async function saveProject(){
  if (!canWrite || saveBlocked) return;
  clearTimeout(saveTimer); saveTimer = null;
  if (saving){ saveAgain = true; return saving; }
  setStatus("Saving…");
  saving = (async () => {
    try {
      const r = await api("PUT", `/opportunities/${leadId}/takeoff-studio`, {data: serializeProject(), version});
      version = r.version; setStatus("Saved " + new Date().toLocaleTimeString([], {hour: "numeric", minute: "2-digit"}), "ok");
    } catch (e){ if (e.status === 409) saveBlocked = true; setStatus(e.message || "Save failed.", "bad"); }
  })();
  await saving; saving = null;
  if (saveAgain){ saveAgain = false; await saveProject(); }
}
function libDirty(){ dirty(); render(); renderPane(); renderChips(); }
async function saveCompanyList(){
  await api("PUT", "/takeoff-studio/library", {types: PT(), callouts: PC()});
  lib = {types: clone(PT()), callouts: clone(PC())};
}

/* ================= plan sheets: the lead's plan PDFs, drawn with pdf.js ================= */
let pdfjs = null, plans = null, planProblems = [];
const pdfDocs = {}, loading = {}, recent = [];
const RENDER_LONG = 4800;
const scaleFor = (vp1, max) => Math.min(8, max / Math.max(vp1.width, vp1.height));
async function pdfLib(){ if (!pdfjs){ pdfjs = await import("/vendor/pdf.mjs"); pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.mjs"; } return pdfjs; }
function pdfDoc(key){
  return pdfDocs[key] ||= (async () => {
    const lib = await pdfLib();
    const res = await fetch(`/api/opportunities/${leadId}/takeoff-studio/plan-file?key=${encodeURIComponent(key)}`, {credentials: "same-origin"});
    if (!res.ok){ let m = "The plan file could not be opened."; try { m = (await res.json()).error || m; } catch {} throw new Error(m); }
    return lib.getDocument({data: new Uint8Array(await res.arrayBuffer()), isEvalSupported: false}).promise;
  })().catch(e => { delete pdfDocs[key]; throw e; });
}
async function renderSheet(sh, max = RENDER_LONG){
  const doc = await pdfDoc(sh.src.key), page = await doc.getPage(sh.src.page);
  const v1 = page.getViewport({scale: 1}), vp = page.getViewport({scale: scaleFor(v1, max)});
  const c = document.createElement("canvas"); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
  await page.render({canvasContext: g, viewport: vp}).promise; page.cleanup();
  return c;
}
function sheetImage(sh){
  if (!sh) return null;
  if (imgs[sh.id]) return imgs[sh.id];
  if (!sh.src || loading[sh.id]) return null;
  loading[sh.id] = renderSheet(sh).then(c => {
    if (c.width !== sh.w || c.height !== sh.h){ const k = document.createElement("canvas"); k.width = sh.w; k.height = sh.h; k.getContext("2d").drawImage(c, 0, 0, sh.w, sh.h); c = k; }   // measurements were made at this size
    imgs[sh.id] = c; recent.push(sh.id);
    while (recent.length > 4){ const old = recent.shift(); if (old !== cur.sheetId) delete imgs[old]; }   // keep a few sheets drawn, not the whole set
    delete loading[sh.id]; render();
  }).catch(e => { delete loading[sh.id]; sh._bad = e.message; setStatus(e.message || "The sheet could not be drawn.", "bad"); render(); });
  return null;
}
async function sheetCanvas(sh){
  sheetImage(sh);
  while (!imgs[sh.id]){ if (!loading[sh.id]) throw new Error(sh._bad || "The sheet could not be drawn."); await loading[sh.id]; }
  return imgs[sh.id];
}
function imgReady(im){ return !!im; }
async function loadPlans(){
  try { const r = await api("GET", `/opportunities/${leadId}/takeoff-studio/plans`); plans = r.plans; planProblems = r.problems || []; }
  catch (e){ plans = []; planProblems = [e.message]; }
  renderPlans();
}
function renderPlans(){
  const el = $("#planList"); if (!el) return;
  if (!plans){ el.innerHTML = `<p class="hint">Finding the plans on this lead…</p>`; return; }
  const used = k => project.sheets.filter(s => s.src?.key === k).length;
  el.innerHTML = (plans.length ? plans.map((p, i) => `<div class="plan-row"><div class="nm" title="${esc(p.name)}">${esc(p.name)}${p.revision ? ` <span class="badge">revised</span>` : ""}</div>
      <div class="meta">${p.inZip ? "in " + esc(p.inZip) + " · " : ""}${esc(p.where)}${used(p.key) ? ` · ${used(p.key)} sheet${used(p.key) === 1 ? "" : "s"} added` : ""}</div>
      ${canWrite ? `<button class="btn small" data-plan="${i}" ${cur.adding ? "disabled" : ""}>${used(p.key) ? "Add more pages" : "Add pages"}</button>` : ""}</div>`).join("")
    : `<p class="hint">No plan PDFs on this lead yet. Add the plans on the lead page, then come back.</p>`)
    + planProblems.map(t => `<p class="hint" style="color:var(--bad)">${esc(t)}</p>`).join("");
  el.querySelectorAll("[data-plan]").forEach(b => b.onclick = () => addPlanPages(plans[+b.dataset.plan]));
}
// Adds a plan PDF's pages as sheets. Without "all pages", only architectural and interior sheets come in (and pages with no readable sheet
// number), the same rule the estimating chat uses for large sets.
async function addPlanPages(p){
  cur.adding = true; renderPlans(); setStatus(`Opening ${p.name}…`);
  try {
    const all = $("#allPages")?.checked, role = $("#upRole")?.value || "auto";
    const doc = await pdfDoc(p.key); let codes = null;
    if (!all){ try { codes = (await api("GET", `/opportunities/${leadId}/takeoff-studio/plan-pages?key=${encodeURIComponent(p.key)}`)).pages; } catch { codes = null; } }
    const have = new Set(project.sheets.filter(s => s.src?.key === p.key).map(s => s.src.page)), added = []; let skipped = 0;
    const stem = p.name.replace(/\.pdf$/i, "");
    for (let n = 1; n <= doc.numPages; n++){
      if (have.has(n)) continue;
      const c = codes?.[n - 1];
      if (c?.discipline && c.discipline !== "A"){ skipped++; continue; }
      const page = await doc.getPage(n), vp = page.getViewport({scale: scaleFor(page.getViewport({scale: 1}), RENDER_LONG)});
      project.sheets.push({id: "sh" + uid(), name: c?.sheet ? `${c.sheet}${doc.numPages > 1 ? ` (p${n})` : ""}` : (doc.numPages > 1 ? `${stem} p${n}` : stem), kind: role === "auto" ? guessKind(c?.sheet || "") : role,
        src: {key: p.key, page: n, file: p.name}, w: Math.round(vp.width), h: Math.round(vp.height), dpi: vp.scale * 72, ppi: null, items: []});
      added.push(project.sheets.at(-1).id); page.cleanup();
    }
    if (added.length && !project.sheets.some(s => s.id === cur.sheetId && s.items.length)) cur.sheetId = added[0];
    setStatus(added.length ? `Added ${added.length} sheet${added.length === 1 ? "" : "s"}${skipped ? `; left out ${skipped} MEP, structural or other page${skipped === 1 ? "" : "s"}` : ""}.` : skipped ? `Every page is MEP, structural or similar. Tick "Include all pages" to add them anyway.` : "Those pages are already added.", added.length ? "ok" : "");
    if (added.length) dirty();
    renderAll(); fitView();
    if (added.length && role === "auto" && sampleFn) aiClassify(added);
  } catch (e){ setStatus(e.message || "The plan could not be opened.", "bad"); }
  cur.adding = false; renderPlans();
}

/* ================= canvas & view ================= */
const cv = $("#cv"), ctx = cv.getContext("2d");
let dpr = 1, cw = 0, ch = 0;
function view(){ const sh = sheet(); if (!sh) return {x: 0, y: 0, z: 1}; return views[sh.id] ||= fitFor(sh); }
function fitFor(sh){
  const W = sh.w || 1000, H = sh.h || 800; const z = Math.min((cw - 40) / W, (ch - 40) / H) || 0.5;
  return {z, x: (cw - W * z) / 2, y: (ch - H * z) / 2};
}
function fitView(){ const sh = sheet(); if (!sh) return; views[sh.id] = fitFor(sh); render(); }
function toImg(e){ const r = cv.getBoundingClientRect(), v = view(); return [(e.clientX - r.left - v.x) / v.z, (e.clientY - r.top - v.y) / v.z]; }
function toScr(p){ const v = view(); return [p[0] * v.z + v.x, p[1] * v.z + v.y]; }
function resize(){
  const r = $("#stage").getBoundingClientRect(); dpr = window.devicePixelRatio || 1;
  const first = !cw; cw = r.width; ch = r.height;
  cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr);
  if (first) for (const k in views) delete views[k];
  render();
}
const ro = new ResizeObserver(resize); ro.observe($("#stage"));
function cssVar(n){ return getComputedStyle(root).getPropertyValue(n).trim(); }

let raf = 0;
function render(){ if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); }
function colorOf(it){
  if (it.kind === "partition") return wStat(it) === "existing" ? "#7b8794" : wStat(it) === "demo" ? "#a0522d" : (typeById(it.typeId)?.color || "#495057");
  if (it.kind === "room") return "#0b7285";
  if (it.kind === "opening") return "#e03131";
  return calloutById(it.calloutId)?.color || "#868e96";
}
function draw(){
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = cssVar("--surround") || "#cfd6dc"; ctx.fillRect(0, 0, cv.width, cv.height);
  const sh = sheet();
  updateHud();
  if (!sh){
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = cssVar("--muted"); ctx.font = "15px " + cssVar("--f-body"); ctx.textAlign = "center";
    ctx.fillText("Add pages from the plans on this lead (left) to start the takeoff", cw / 2, ch / 2); return;
  }
  const v = view(), im = sheetImage(sh);
  ctx.setTransform(dpr * v.z, 0, 0, dpr * v.z, dpr * v.x, dpr * v.y);
  ctx.fillStyle = "#fff"; ctx.shadowColor = "rgba(0,0,0,.25)"; ctx.shadowBlur = 12 / v.z; ctx.fillRect(0, 0, sh.w || 1000, sh.h || 800); ctx.shadowBlur = 0;
  if (imgReady(im)) ctx.drawImage(im, 0, 0, sh.w, sh.h);
  else { ctx.save(); ctx.fillStyle = "#6b7285"; ctx.font = `${16 / v.z}px ${cssVar("--f-body") || "sans-serif"}`; ctx.textAlign = "center"; ctx.fillText(sh._bad || "Drawing the sheet…", (sh.w || 1000) / 2, (sh.h || 800) / 2); ctx.restore(); }
  const k = 1 / v.z;
  const order = {room: -1, area: 0, partition: 1, linear: 2, opening: 3, count: 4};
  const items = [...sh.items].sort((a, b) => order[a.kind] - order[b.kind]);
  for (const it of items) drawItem(it, sh, k, it.id === cur.sel);
  // draft
  if (cur.draft){
    const d = cur.draft, pts = cur.hover ? [...d.pts, cur.hover.p] : d.pts;
    ctx.save(); ctx.strokeStyle = d.kind === "calibrate" ? "#1d6fd8" : (d.kind === "partition" ? typeById(cur.typeId)?.color : d.kind === "room" ? "#0b7285" : d.kind === "opening" ? "#e03131" : calloutById(cur.calloutId)?.color) || "#d9480f";
    ctx.lineWidth = (d.kind === "partition" ? 6 : 3) * k; ctx.setLineDash(d.kind === "calibrate" ? [6*k, 4*k] : []);
    ctx.globalAlpha = .85; ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(...p) : ctx.moveTo(...p));
    if ((d.kind === "area" || d.kind === "room") && pts.length > 2){ ctx.closePath(); ctx.fillStyle = ctx.strokeStyle; ctx.globalAlpha = .18; ctx.fill(); ctx.globalAlpha = .85; }
    ctx.stroke(); ctx.restore();
    for (const p of d.pts){ ctx.fillStyle = "#fff"; ctx.strokeStyle = "#1d6fd8"; ctx.lineWidth = 1.5*k; ctx.fillRect(p[0]-3*k, p[1]-3*k, 6*k, 6*k); ctx.strokeRect(p[0]-3*k, p[1]-3*k, 6*k, 6*k); }
  }
  if (cur.calib && cur.calib.pts.length === 2){
    ctx.save(); ctx.strokeStyle = "#1d6fd8"; ctx.lineWidth = 3*k; ctx.setLineDash([6*k, 4*k]); ctx.beginPath(); ctx.moveTo(...cur.calib.pts[0]); ctx.lineTo(...cur.calib.pts[1]); ctx.stroke(); ctx.restore();
  }
  // hover crosshair
  if (cur.hover && cur.tool !== "select" && cur.tool !== "pan"){
    const p = cur.hover.p; ctx.strokeStyle = cur.hover.snapped ? "#e8590c" : "#1d6fd8"; ctx.lineWidth = 1.5*k;
    const s = (cur.hover.snapped ? 7 : 5) * k;
    if (cur.hover.snapped){ ctx.strokeRect(p[0]-s, p[1]-s, 2*s, 2*s); } else { ctx.beginPath(); ctx.moveTo(p[0]-s, p[1]); ctx.lineTo(p[0]+s, p[1]); ctx.moveTo(p[0], p[1]-s); ctx.lineTo(p[0], p[1]+s); ctx.stroke(); }
  }
  drawTags(sh, k);
  // focus area
  const fb = cur.focusDraft || sh.focus;
  if (fb){
    ctx.save(); ctx.fillStyle = "rgba(20,30,40,.14)"; ctx.beginPath(); ctx.rect(0, 0, sh.w, sh.h); ctx.rect(fb.x, fb.y, fb.w, fb.h); ctx.fill("evenodd");
    ctx.strokeStyle = "#e8a400"; ctx.lineWidth = 3 * k; ctx.setLineDash([10*k, 6*k]); ctx.strokeRect(fb.x, fb.y, fb.w, fb.h); ctx.restore();
  }
  // labels in screen space
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  for (const it of items) drawLabel(it, sh);
  if (fb){ const s = toScr([fb.x, fb.y]); ctx.font = `600 11.5px ${cssVar("--f-mono") || "monospace"}`; const t = "Claude drafts here"; const w = ctx.measureText(t).width + 10; ctx.fillStyle = "#e8a400"; ctx.fillRect(s[0], s[1] - 19, w, 18); ctx.fillStyle = "#1a1200"; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillText(t, s[0] + 5, s[1] - 9.5); }
}
function drawItem(it, sh, k, selected){
  const col = colorOf(it); ctx.save();
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  if (it.kind === "room"){
    ctx.beginPath(); it.pts.forEach((p, i) => i ? ctx.lineTo(...p) : ctx.moveTo(...p)); ctx.closePath();
    ctx.fillStyle = col; ctx.globalAlpha = selected ? .16 : .07; ctx.fill(); ctx.globalAlpha = .9;
    ctx.strokeStyle = col; ctx.lineWidth = (selected ? 3 : 2) * k; ctx.setLineDash(it.src === "claude" && !it.edited ? [8*k, 5*k] : [3*k, 3*k]); ctx.stroke();
  } else if (it.kind === "area"){
    ctx.beginPath(); it.pts.forEach((p, i) => i ? ctx.lineTo(...p) : ctx.moveTo(...p)); ctx.closePath();
    ctx.fillStyle = col; ctx.globalAlpha = selected ? .32 : .2; ctx.fill(); ctx.globalAlpha = 1;
    ctx.strokeStyle = col; ctx.lineWidth = (selected ? 3 : 2) * k; ctx.stroke();
  } else if (it.kind === "count"){
    it.pts.forEach((p, i) => { ctx.beginPath(); ctx.arc(p[0], p[1], 11*k, 0, Math.PI*2); ctx.fillStyle = col; ctx.globalAlpha = .9; ctx.fill(); ctx.globalAlpha = 1; ctx.strokeStyle = selected ? "#1d6fd8" : "#fff"; ctx.lineWidth = 2*k; ctx.stroke();
      ctx.fillStyle = "#fff"; ctx.font = `700 ${11*k}px ${cssVar("--f-mono")}`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(String(i+1), p[0], p[1]+.5*k); });
  } else {
    const w = it.kind === "partition" ? (wStat(it) === "new" ? 7 : 5) : it.kind === "opening" ? 9 : 4;
    if (selected){ ctx.strokeStyle = "#1d6fd8"; ctx.globalAlpha = .35; ctx.lineWidth = (w + 8) * k; ctx.beginPath(); it.pts.forEach((p, i) => i ? ctx.lineTo(...p) : ctx.moveTo(...p)); ctx.stroke(); ctx.globalAlpha = 1; }
    ctx.strokeStyle = col; ctx.lineWidth = w * k; ctx.globalAlpha = it.kind === "partition" ? .78 : .9;
    if (it.kind === "linear") ctx.setLineDash([10*k, 5*k]);
    if (it.kind === "partition" && it.src === "claude" && !it.edited) ctx.setLineDash([14*k, 4*k]);
    if (it.kind === "partition" && wStat(it) === "demo") ctx.setLineDash([5*k, 5*k]);
    ctx.beginPath(); it.pts.forEach((p, i) => i ? ctx.lineTo(...p) : ctx.moveTo(...p)); ctx.stroke();
  }
  ctx.restore();
  if (selected && it.kind !== "count"){
    it.pts.forEach((p, i) => { const s = (i === cur.selV ? 6 : 4.5) * k; ctx.fillStyle = i === cur.selV ? "#1d6fd8" : "#fff"; ctx.strokeStyle = "#1d6fd8"; ctx.lineWidth = 1.5*k; ctx.fillRect(p[0]-s, p[1]-s, 2*s, 2*s); ctx.strokeRect(p[0]-s, p[1]-s, 2*s, 2*s); });
  }
}
function drawLabel(it, sh){
  const showLen = $("#showLen").checked; let txt = "", at = null;
  const q = itemQty(it, sh);
  if (it.kind === "partition"){
    let best = 0, bi = 1; for (let i = 1; i < it.pts.length; i++){ const L = dist(it.pts[i-1], it.pts[i]); if (L > best){ best = L; bi = i; } }
    if (it.pts.length < 2) return;
    at = [(it.pts[bi-1][0] + it.pts[bi][0]) / 2, (it.pts[bi-1][1] + it.pts[bi][1]) / 2];
    txt = (wStat(it) === "existing" ? "ETR" : wStat(it) === "demo" ? "DEMO" : (typeById(it.typeId)?.tag || "NEW?")) + (it.noFinish ? " ·no fin" : "") + (showLen && q != null ? "  " + fmt(q) + " LF" : "");
  } else if (it.kind === "room" && it.pts.length > 2){
    let cx = 0, cy = 0; it.pts.forEach(p => { cx += p[0]; cy += p[1]; }); at = [cx / it.pts.length, cy / it.pts.length + 22 / view().z];
    txt = `${it.number || "?"} ${it.name || ""}`.trim() + (q != null ? "  " + fmt(q, 0) + " SF" : "");
  } else if (it.kind === "area" && it.pts.length > 2){
    let cx = 0, cy = 0; it.pts.forEach(p => { cx += p[0]; cy += p[1]; }); at = [cx / it.pts.length, cy / it.pts.length];
    txt = (calloutById(it.calloutId)?.code || "?") + (q != null ? "  " + fmt(q, 0) + " SF" : "");
  } else if (it.kind === "linear" && it.pts.length > 1){
    at = [(it.pts[0][0] + it.pts[1][0]) / 2, (it.pts[0][1] + it.pts[1][1]) / 2];
    txt = (calloutById(it.calloutId)?.code || "?") + (showLen && q != null ? "  " + fmt(q) + " LF" : "");
  } else if (it.kind === "opening" && showLen && q != null){
    at = [(it.pts[0][0] + it.pts[1][0]) / 2, (it.pts[0][1] + it.pts[1][1]) / 2]; txt = fmtFtIn(q);
  } else return;
  if (!at || !txt) return;
  const s = toScr(at), v = view();
  if (it.kind === "opening" && v.z < 0.35) return;
  ctx.font = `600 11.5px ${cssVar("--f-mono") || "monospace"}`;
  const w = ctx.measureText(txt).width + 10, h = 18;
  const col = colorOf(it);
  ctx.fillStyle = "rgba(255,255,255,.94)"; ctx.strokeStyle = col; ctx.lineWidth = 1.2;
  const x = s[0] - w/2, y = s[1] - h/2 - (it.kind === "opening" ? 14 : 0);
  ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, 3) : ctx.rect(x, y, w, h); ctx.fill(); ctx.stroke();
  ctx.fillStyle = "#17212b"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(txt, s[0], y + h/2 + .5);
}
function updateHud(){
  const sh = sheet(), el = $("#hudScale"), b = $("#scaleBanner");
  if (!sh){ el.textContent = "No sheet"; b.hidden = true; return; }
  el.textContent = sh.ppi ? `Scale: 1' = ${fmt(sh.ppi * 12, 1)} px${sh.scaleNote ? " · " + sh.scaleNote : ""}` : "No scale set";
  if (!sh.ppi && cur.tool !== "calibrate"){
    b.hidden = false; b.innerHTML = `<b>Set the scale.</b> Pick the Scale tool and click both jambs of a 3'-0" door, or any known dimension.<button class="btn small primary" id="bannerCal">Set scale</button>`;
    $("#bannerCal").onclick = () => setTool("calibrate");
  } else if (sh.scaleAssumed){
    b.hidden = false; b.innerHTML = `<b>Check the scale.</b> Claude set it from ${esc(sh.scaleFrom || "a door it assumed is " + fmtFtIn(sh.scaleAssumed))}. Measure a known dimension to confirm.<button class="btn small" id="bannerOk">Looks right</button>`;
    $("#bannerOk").onclick = () => { delete sh.scaleAssumed; delete sh.scaleFrom; dirty(); render(); };
  } else b.hidden = true;
}

/* ================= tools ================= */
const TOOLS = [
  {id: "select", label: "Select", key: "V", icon: '<path d="M3 2l9 5-4 1.2L6.5 13z" fill="currentColor"/>'},
  {id: "pan", label: "Pan", key: "H", icon: '<path d="M8 1v14M1 8h14M8 1l-2 2M8 1l2 2M8 15l-2-2M8 15l2-2M1 8l2-2M1 8l2 2M15 8l-2-2M15 8l-2 2" stroke="currentColor" fill="none" stroke-width="1.5"/>'},
  {id: "calibrate", label: "Scale", key: "K", icon: '<path d="M1 11l10-10 4 4-10 10z M4 8l1.5 1.5M6 6l1.5 1.5M8 4l1.5 1.5" stroke="currentColor" fill="none" stroke-width="1.4"/>'},
  {id: "partition", label: "Partition", key: "W", icon: '<path d="M2 13V3h7v6h5" stroke="currentColor" fill="none" stroke-width="3"/>'},
  {id: "opening", label: "Opening", key: "O", icon: '<path d="M2 14h3M11 14h3M5 14V4a9 9 0 0 1 9 9" stroke="currentColor" fill="none" stroke-width="1.6"/>'},
  {id: "linear", label: "Linear", key: "L", icon: '<path d="M1 12L15 4" stroke="currentColor" stroke-width="2" stroke-dasharray="3 2" fill="none"/>'},
  {id: "area", label: "Area", key: "A", icon: '<path d="M2 3h9l3 5-3 6H2z" fill="currentColor" fill-opacity=".3" stroke="currentColor" stroke-width="1.5"/>'},
  {id: "focus", label: "Focus", key: "F", icon: '<rect x="2" y="3" width="12" height="10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="3 2"/>'},
  {id: "room", label: "Room", key: "R", icon: '<path d="M2 2h12v12H2z" fill="currentColor" fill-opacity=".15" stroke="currentColor" stroke-width="1.5"/><path d="M5 7h6M5 10h4" stroke="currentColor" stroke-width="1.2"/>'},
  {id: "count", label: "Count", key: "C", icon: '<circle cx="8" cy="8" r="5.5" fill="currentColor"/><text x="8" y="11" font-size="8" text-anchor="middle" style="fill:var(--panel)" font-family="monospace">1</text>'},
];
function renderTools(){
  $("#tools").innerHTML = TOOLS.map(t => `<button class="tool" data-tool="${t.id}" aria-pressed="${cur.tool === t.id}" title="${t.label} (${t.key})"><svg viewBox="0 0 16 16" aria-hidden="true">${t.icon}</svg><span class="tl">${t.label}</span><kbd>${t.key}</kbd></button>`).join("");
  $("#tools").querySelectorAll("button").forEach(b => b.onclick = () => setTool(b.dataset.tool));
}
function setTool(t){
  cur.tool = t; cur.draft = null; if (t !== "calibrate") cur.calib = null;
  cv.style.cursor = t === "pan" ? "grab" : t === "select" ? "default" : "crosshair";
  if (t === "calibrate"){ cur.calib = {pts: []}; cur.tab = "item"; }
  renderTools(); renderChips(); renderPane(); render();
}
function renderChips(){
  const el = $("#toolChips"); const t = cur.tool;
  if (t === "room"){
    el.innerHTML = `<span class="hint">Click the room's inside corners, double-click to finish, then enter its number. Finishes fill from the finish schedule.</span>`; return;
  }
  if (t === "partition"){
    const ws = cur.wallStatus || "new";
    el.innerHTML = `<span class="lbl">New</span>` + (PT().length ? "" : `<span class="hint">No wall types yet.</span>`) + PT().map(x => `<button class="chip" data-id="${x.id}" aria-pressed="${ws === "new" && cur.typeId === x.id}" title="${esc(x.desc)}"><span class="sw" style="background:${x.color}"></span>${esc(x.tag)}</button>`).join("")
      + `<span class="lbl" style="margin-left:8px">Other</span><button class="chip" data-st="existing" aria-pressed="${ws === "existing"}"><span class="sw" style="background:#7b8794"></span>ETR</button><button class="chip" data-st="demo" aria-pressed="${ws === "demo"}"><span class="sw" style="background:#a0522d"></span>Demo</button>`;
    el.querySelectorAll("[data-st]").forEach(b => b.onclick = () => { cur.wallStatus = b.dataset.st; const it = selItem(); if (it?.kind === "partition") changeItem(it, {status: b.dataset.st}); renderChips(); });
    el.querySelectorAll("[data-id]").forEach(b => b.onclick = () => { cur.typeId = b.dataset.id; cur.wallStatus = "new"; const it = selItem(); if (it?.kind === "partition") changeItem(it, {typeId: b.dataset.id, status: "new"}); renderChips(); });
  } else if (t === "area" || t === "linear" || t === "count"){
    const unit = t === "area" ? "SF" : t === "linear" ? "LF" : "EA";
    const list = PC().filter(c => c.unit === unit);
    if (!list.some(c => c.id === cur.calloutId)) cur.calloutId = list[0]?.id || null;
    el.innerHTML = `<span class="lbl">Callout · ${unit}</span>` + (list.length ? list.map(c => `<button class="chip" data-id="${c.id}" aria-pressed="${cur.calloutId === c.id}" title="${esc(c.name)}"><span class="sw" style="background:${c.color}"></span>${esc(c.code)}</button>`).join("") : `<span class="hint">Add a ${unit} callout in Library</span>`);
    el.querySelectorAll("button").forEach(b => b.onclick = () => { cur.calloutId = b.dataset.id; renderChips(); });
  } else if (t === "calibrate"){
    el.innerHTML = `<span class="hint">Click two points of a known length, for example both jambs of a 3'-0" door.</span>`;
  } else if (t === "focus"){
    el.innerHTML = `<span class="hint">Drag a box around the new work. Claude drafts only inside it, at full detail.</span>`;
  } else if (t === "opening"){
    el.innerHTML = `<span class="hint">Click both jambs of a door or window on a partition. It deducts from that wall.</span>`;
  } else el.innerHTML = `<span class="hint">Click an item to edit it. Drag empty space to pan, scroll to zoom.</span>`;
}

/* snapping */
function snapPt(raw, prev, excludeId, shift){
  const sh = sheet(), v = view(), tol = 10 / v.z;
  if ($("#snap").checked){
    let best = null, bd = tol;
    for (const it of sh.items){ if (it.id === excludeId) continue; for (const p of it.pts){ const d = dist(raw, p); if (d < bd){ bd = d; best = p; } } }
    if (cur.draft) for (const p of cur.draft.pts.slice(0, -1)){ const d = dist(raw, p); if (d < bd){ bd = d; best = p; } }
    if (best) return {p: [...best], snapped: true};
  }
  let p = raw;
  const ortho = $("#ortho").checked !== !!shift;
  if (prev && ortho){ p = Math.abs(raw[0] - prev[0]) > Math.abs(raw[1] - prev[1]) ? [raw[0], prev[1]] : [prev[0], raw[1]]; }
  if ($("#snap").checked){
    let best = null, bd = tol * 0.8;
    for (const it of sh.items){ if (it.id === excludeId || it.kind !== "partition") continue;
      for (let i = 1; i < it.pts.length; i++){
        let q;
        if (prev && ortho){ q = lineSegIntersect(prev, p, it.pts[i-1], it.pts[i]); if (!q) continue; }
        else q = nearestOnSeg(p, it.pts[i-1], it.pts[i]).q;
        const d = dist(p, q); if (d < bd){ bd = d; best = q; }
      } }
    if (best) return {p: best, snapped: true};
  }
  return {p, snapped: false};
}
function hitTest(p){
  const sh = sheet(), v = view(), tol = 8 / v.z;
  const order = ["count", "opening", "linear", "partition", "area", "room"];
  for (const kind of order){
    for (const it of [...sh.items].reverse()){
      if (it.kind !== kind) continue;
      if (kind === "count"){ for (let i = 0; i < it.pts.length; i++) if (dist(p, it.pts[i]) < 13 / v.z) return {it, v: i}; continue; }
      for (let i = 1; i < it.pts.length; i++) if (nearestOnSeg(p, it.pts[i-1], it.pts[i]).d < tol + (kind === "partition" ? 4 / v.z : 0)) return {it, seg: i};
      if (kind === "room"){ if (nearestOnSeg(p, it.pts[it.pts.length-1], it.pts[0]).d < tol) return {it, seg: it.pts.length}; if (pointInPoly(p, it.pts)) return {it}; }
      if (kind === "area"){ if (nearestOnSeg(p, it.pts[it.pts.length-1], it.pts[0]).d < tol) return {it, seg: it.pts.length}; if (pointInPoly(p, it.pts)) return {it}; }
    }
  }
  return null;
}
function vertexHit(p){ const it = selItem(); if (!it) return -1; const v = view(); for (let i = 0; i < it.pts.length; i++) if (dist(p, it.pts[i]) < 8 / v.z) return i; return -1; }

/* undo / changes */
function checkpoint(){ const sh = sheet(); if (!sh) return; undo.push({sheetId: sh.id, items: clone(sh.items), ppi: sh.ppi}); if (undo.length > 80) undo.shift(); redo.length = 0; }
function doUndo(stack, other){
  const st = stack.pop(); if (!st) return; const sh = project.sheets.find(s => s.id === st.sheetId); if (!sh) return;
  other.push({sheetId: sh.id, items: clone(sh.items), ppi: sh.ppi}); sh.items = st.items; sh.ppi = st.ppi; cur.sheetId = sh.id; cur.sel = null;
  dirty(); renderAll();
}
function logCorrection(msg){
  project.corrections ||= []; project.corrections.push({t: Date.now(), sheet: sheet()?.name, msg});
  if (project.corrections.length > 300) project.corrections.splice(0, project.corrections.length - 300);
}
function changeItem(it, patch){
  checkpoint();
  if (it.src === "claude"){
    if (patch.typeId && patch.typeId !== it.typeId) logCorrection(`Changed partition type ${typeById(it.typeId)?.tag || "?"} → ${typeById(patch.typeId)?.tag || "?"} (${fmt(itemQty(it, sheet()))} LF)`);
    if (patch.calloutId && patch.calloutId !== it.calloutId) logCorrection(`Changed callout ${calloutById(it.calloutId)?.code || "?"} → ${calloutById(patch.calloutId)?.code || "?"}`);
    if (patch.status && patch.status !== wStat(it)) logCorrection(`Changed wall from ${STATUS_LABEL[wStat(it)]} to ${STATUS_LABEL[patch.status]} (${fmt(itemQty(it, sheet()))} LF)`);
    if (patch.noFinish !== undefined && patch.noFinish !== !!it.noFinish) logCorrection(`Marked a ${STATUS_LABEL[wStat(it)].toLowerCase()} wall as ${patch.noFinish ? "getting no finish" : "getting the room finish"}`);
    if (patch.heightFt !== undefined && patch.heightFt !== it.heightFt) logCorrection(`Overrode height to ${patch.heightFt || "type default"} ft on partition ${typeById(it.typeId)?.tag || "?"}`);
  }
  Object.assign(it, patch); if (it.src === "claude") it.edited = true;
  dirty(); render(); renderPane(); renderSheets();
}
function deleteItem(it){
  checkpoint(); const sh = sheet();
  if (it.src === "claude") logCorrection(`Deleted Claude's ${it.kind} ${it.kind === "partition" ? (typeById(it.typeId)?.tag || "?") : (calloutById(it.calloutId)?.code || "")} (${fmt(itemQty(it, sh))}${it.kind === "area" ? " SF" : " LF"}) — false positive`);
  sh.items = sh.items.filter(x => x !== it); cur.sel = null; cur.selV = -1;
  dirty(); render(); renderPane(); renderSheets();
}
function finishDraft(){
  const d = cur.draft; if (!d) return; const sh = sheet();
  const pts = d.pts.filter((p, i) => i === 0 || dist(p, d.pts[i-1]) > 0.5);
  cur.draft = null;
  const need = d.kind === "area" || d.kind === "room" ? 3 : 2;
  if (pts.length < need){ render(); return; }
  checkpoint();
  const it = {id: uid(), kind: d.kind, pts, src: "user"};
  if (d.kind === "partition"){ if ((cur.wallStatus || "new") === "new") it.typeId = cur.typeId; else it.status = cur.wallStatus; }
  else if (d.kind === "room"){ it.number = ""; it.name = ""; it.finish = {}; }
  else it.calloutId = cur.calloutId;
  if (d.kind === "opening"){ delete it.calloutId; it.heightIn = 84; it.pts = pts.slice(0, 2); }
  sh.items.push(it);
  if (sh.items.some(x => x.src === "claude") && (d.kind === "partition" || d.kind === "area" || d.kind === "linear")){
    const q = itemQty(it, sh);
    logCorrection(`Added ${d.kind} ${d.kind === "partition" ? (typeById(it.typeId)?.tag || "?") : (calloutById(it.calloutId)?.code || "?")} (${fmt(q)}${d.kind === "area" ? " SF" : " LF"}) that Claude missed`);
  }
  cur.sel = it.id; dirty(); render(); renderPane(); renderSheets();
}

/* pointer handling */
let drag = null, spaceDown = false, lastTap = 0;
cv.addEventListener("pointerdown", e => {
  const sh = sheet(); if (!sh) return;
  cv.setPointerCapture(e.pointerId);
  const p = toImg(e);
  if (e.button === 1 || cur.tool === "pan" || spaceDown){ drag = {mode: "pan", sx: e.clientX, sy: e.clientY, v: {...view()}}; cv.style.cursor = "grabbing"; return; }
  if (e.button !== 0) return;
  if (cur.tool === "select"){
    const vi = vertexHit(p);
    if (vi >= 0){ cur.selV = vi; drag = {mode: "vertex", it: selItem(), i: vi, moved: false}; render(); return; }
    const h = hitTest(p);
    if (h){ cur.sel = h.it.id; cur.selV = h.v ?? -1; cur.tab = "item"; drag = {mode: "move", it: h.it, start: p, orig: clone(h.it.pts), moved: false}; renderTabs(); renderPane(); render(); return; }
    cur.sel = null; cur.selV = -1; renderPane(); render();
    drag = {mode: "pan", sx: e.clientX, sy: e.clientY, v: {...view()}}; return;
  }
  const prev = cur.tool === "calibrate" ? cur.calib?.pts[0] : cur.draft?.pts[cur.draft.pts.length - 1];
  const sp = snapPt(p, prev, null, e.shiftKey).p;
  if (cur.tool === "focus"){ drag = {mode: "focus", start: p}; cur.focusDraft = null; return; }
  if (cur.tool === "calibrate"){
    cur.calib ||= {pts: []}; if (cur.calib.pts.length >= 2) cur.calib.pts = [];
    cur.calib.pts.push(sp); renderPane(); render();
    if (cur.calib.pts.length === 2) setTimeout(() => $("#calLen")?.focus(), 0);
    return;
  }
  if (cur.tool === "count"){
    if (!cur.calloutId){ cur.tab = "library"; renderTabs(); renderPane(); return; }
    checkpoint();
    let it = sh.items.find(x => x.kind === "count" && x.calloutId === cur.calloutId);
    if (!it){ it = {id: uid(), kind: "count", calloutId: cur.calloutId, pts: [], src: "user"}; sh.items.push(it); }
    it.pts.push(sp); cur.sel = it.id; dirty(); render(); renderPane(); renderSheets(); return;
  }
  if ((cur.tool === "area" || cur.tool === "linear") && !cur.calloutId){ cur.tab = "library"; renderTabs(); renderPane(); return; }
  const now = Date.now();
  if (cur.draft && now - lastTap < 320 && dist(sp, cur.draft.pts[cur.draft.pts.length-1]) < 6 / view().z){ lastTap = 0; finishDraft(); return; }
  lastTap = now;
  if (!cur.draft) cur.draft = {kind: cur.tool, pts: []};
  cur.draft.pts.push(sp);
  if (cur.tool === "opening" && cur.draft.pts.length === 2) finishDraft();
  if (cur.tool === "linear" && cur.draft && cur.draft.pts.length >= 2 && e.altKey) finishDraft();
  render();
});
cv.addEventListener("pointermove", e => {
  const sh = sheet(); if (!sh) return;
  const p = toImg(e);
  if (drag?.mode === "focus"){ const a = drag.start; cur.focusDraft = {x: Math.min(a[0], p[0]), y: Math.min(a[1], p[1]), w: Math.abs(p[0] - a[0]), h: Math.abs(p[1] - a[1])}; render(); return; }
  if (drag?.mode === "pan"){ const v = views[sh.id]; v.x = drag.v.x + e.clientX - drag.sx; v.y = drag.v.y + e.clientY - drag.sy; render(); return; }
  if (drag?.mode === "vertex"){
    if (!drag.moved){ checkpoint(); drag.moved = true; }
    const it = drag.it, i = drag.i, nb = it.pts[i-1] || it.pts[i+1];
    it.pts[i] = snapPt(p, it.kind === "count" ? null : nb, it.id, e.shiftKey).p; render(); return;
  }
  if (drag?.mode === "move"){
    const dx = p[0] - drag.start[0], dy = p[1] - drag.start[1];
    if (!drag.moved && Math.hypot(dx, dy) * view().z < 4) return;
    if (!drag.moved){ checkpoint(); drag.moved = true; }
    drag.it.pts = drag.orig.map(q => [q[0] + dx, q[1] + dy]); render(); return;
  }
  if (cur.tool !== "select" && cur.tool !== "pan"){
    const prev = cur.tool === "calibrate" ? (cur.calib?.pts.length === 1 ? cur.calib.pts[0] : null) : cur.draft?.pts[cur.draft.pts.length - 1];
    cur.hover = snapPt(p, prev, null, e.shiftKey);
    const live = $("#hudLive");
    if (prev){ const L = dist(prev, cur.hover.p); live.hidden = false; live.textContent = sh.ppi ? `Segment ${fmtFtIn(L / sh.ppi)}${cur.draft && cur.draft.pts.length > 1 ? " · run " + fmt((polyLen(cur.draft.pts) + L) / sh.ppi / 12) + " LF" : ""}` : `Segment ${fmt(L, 0)} px`; }
    else live.hidden = true;
    render();
  }
});
cv.addEventListener("pointerup", e => {
  if (!drag) return;
  if ((drag.mode === "vertex" || drag.mode === "move") && drag.moved){
    if (drag.it.src === "claude" && !drag.it.edited){ logCorrection(`Adjusted geometry of Claude's ${drag.it.kind} ${drag.it.kind === "partition" ? (typeById(drag.it.typeId)?.tag || "") : (calloutById(drag.it.calloutId)?.code || "")}`); }
    if (drag.it.src === "claude") drag.it.edited = true;
    dirty(); renderPane(); renderSheets();
  }
  if (drag.mode === "focus"){
    const f = cur.focusDraft, sh = sheet(); cur.focusDraft = null;
    if (f && f.w * view().z > 12 && f.h * view().z > 12){ sh.focus = {x: Math.max(0, f.x), y: Math.max(0, f.y), w: Math.min(f.w, sh.w - Math.max(0, f.x)), h: Math.min(f.h, sh.h - Math.max(0, f.y))}; dirty(); }
    drag = null; cur.tab = "item"; setTool("select"); return;
  }
  drag = null; cv.style.cursor = cur.tool === "pan" ? "grab" : cur.tool === "select" ? "default" : "crosshair";
});
cv.addEventListener("dblclick", e => {
  if (cur.tool !== "select") return;
  const it = selItem(); if (!it || it.kind === "count" || it.kind === "opening") return;
  const p = toImg(e), v = view();
  const n = it.kind === "area" ? it.pts.length : it.pts.length - 1;
  for (let i = 0; i < n; i++){ const a = it.pts[i], b = it.pts[(i+1) % it.pts.length]; const r = nearestOnSeg(p, a, b); if (r.d < 8 / v.z && r.t > .02 && r.t < .98){ checkpoint(); it.pts.splice(i + 1, 0, r.q); cur.selV = i + 1; if (it.src === "claude") it.edited = true; dirty(); render(); renderPane(); return; } }
});
cv.addEventListener("pointerleave", () => { cur.hover = null; $("#hudLive").hidden = true; render(); });
cv.addEventListener("wheel", e => {
  e.preventDefault(); const sh = sheet(); if (!sh) return;
  const v = view(), r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
  const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018));
  const z = Math.max(0.03, Math.min(12, v.z * f));
  v.x = mx - (mx - v.x) * z / v.z; v.y = my - (my - v.y) * z / v.z; v.z = z; render();
}, {passive: false});
function zoomBy(f){ const v = view(); const mx = cw/2, my = ch/2, z = Math.max(0.03, Math.min(12, v.z * f)); v.x = mx - (mx - v.x) * z / v.z; v.y = my - (my - v.y) * z / v.z; v.z = z; render(); }
$("#zoomIn").onclick = () => zoomBy(1.3); $("#zoomOut").onclick = () => zoomBy(1/1.3); $("#zoomFit").onclick = fitView;

const onKey = e => {
  if (!root.isConnected) return;
  const tag = e.target.tagName; if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (e.key === " "){ spaceDown = true; e.preventDefault(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z"){ e.preventDefault(); e.shiftKey ? doUndo(redo, undo) : doUndo(undo, redo); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y"){ e.preventDefault(); doUndo(redo, undo); return; }
  if (e.key === "Enter"){ finishDraft(); return; }
  if (e.key === "Escape"){ if (cur.draft){ cur.draft = null; } else { cur.sel = null; cur.selV = -1; renderPane(); } render(); return; }
  if (e.key === "Backspace" && cur.draft){ cur.draft.pts.pop(); if (!cur.draft.pts.length) cur.draft = null; render(); e.preventDefault(); return; }
  if (e.key === "Delete" || e.key === "Backspace"){
    const it = selItem(); if (!it) return; e.preventDefault();
    const min = it.kind === "area" ? 3 : it.kind === "count" ? 1 : 2;
    if (cur.selV >= 0 && it.pts.length > min){ checkpoint(); it.pts.splice(cur.selV, 1); cur.selV = -1; if (it.src === "claude") it.edited = true; dirty(); render(); renderPane(); }
    else deleteItem(it);
    return;
  }
  const t = TOOLS.find(t => t.key.toLowerCase() === e.key.toLowerCase()); if (t && !e.ctrlKey && !e.metaKey) setTool(t.id);
};
addEventListener("keydown", onKey);
const onKeyUp = e => { if (e.key === " ") spaceDown = false; };
addEventListener("keyup", onKeyUp);

/* ================= sheets list ================= */
function renderSheets(){
  const ul = $("#sheetList");
  if (!project.sheets.length){ ul.innerHTML = `<li class="hint" style="padding:8px 6px">No sheets yet. Add your plan set below.</li>`; return; }
  ul.innerHTML = project.sheets.map(s => {
    const parts = s.items.filter(i => i.kind === "partition").length, other = s.items.length - parts;
    return `<li><button data-id="${s.id}" aria-current="${s.id === cur.sheetId}"><span class="kind">${roleShort(s.kind)}</span><span class="nm">${esc(s.name)}</span><span class="meta">${s.ppi ? "" : "no scale · "}${parts} walls · ${s.items.filter(i => i.kind === "room").length} rooms · ${other - s.items.filter(i => i.kind === "room").length} other</span></button></li>`;
  }).join("");
  ul.querySelectorAll("button").forEach(b => b.onclick = () => { cur.sheetId = b.dataset.id; cur.sel = null; cur.draft = null; cur.calib = cur.tool === "calibrate" ? {pts: []} : null; renderAll(); });
}

/* ================= right pane ================= */
function renderTabs(){ root.querySelectorAll(".tabs button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === cur.tab))); root.querySelector('.tabs [data-tab="item"]').textContent = selItem() ? "Item" : "Sheet"; }
root.querySelectorAll(".tabs button").forEach(b => b.onclick = () => { cur.tab = b.dataset.tab; renderTabs(); renderPane(); });
function renderPane(){
  renderTabs();
  const el = $("#pane");
  if (cur.tab === "item") el.innerHTML = cur.tool === "calibrate" ? paneCalibrate() : selItem() ? paneItem() : paneSheet();
  else if (cur.tab === "takeoff") el.innerHTML = paneReport();
  else if (cur.tab === "library") el.innerHTML = paneLibrary();
  else if (cur.tab === "chat") el.innerHTML = paneChat();
  else el.innerHTML = paneLearn();
  wirePane();
  if (cur.tab === "chat") wireChat();
}
const srcBadge = it => it.src === "claude" ? (it.edited ? `<span class="badge edited">Claude draft · edited</span>` : `<span class="badge claude">Claude draft</span>`) : `<span class="badge you">Added by you</span>`;
function paneItem(){
  const it = selItem(), sh = sheet(), q = itemQty(it, sh);
  if (it.kind === "room") return paneRoom(it, sh);
  const kindName = {partition: "Partition", opening: "Opening", linear: "Linear callout", area: "Area callout", count: "Count callout"}[it.kind];
  let body = "";
  if (it.kind === "partition"){
    const t = wStat(it) === "new" ? typeById(it.typeId) : null, h = it.heightFt || t?.height || project.defaultCeilingHt || 9;
    const wallSf = q != null ? q * h : null;
    const st = wStat(it);
    body = `<div class="field"><label for="itStatus">Wall status</label><select id="itStatus">${Object.entries(STATUS_LABEL).map(([k, v]) => `<option value="${k}" ${k === st ? "selected" : ""}>${v}</option>`).join("")}</select></div>
      ${st === "new" ? `<div class="field"><label for="itType">Partition type</label><select id="itType"><option value="" ${it.typeId ? "" : "selected"}>No type yet</option>${PT().map(x => `<option value="${x.id}" ${x.id === it.typeId ? "selected" : ""}>${esc(x.tag)} — ${esc(x.desc.slice(0, 60))}</option>`).join("")}</select></div>
      <p class="hint">${esc(t?.desc || "Assign a type so this wall's framing and drywall are counted.")}</p>` : `<p class="hint">${st === "existing" ? "Existing walls get no framing or drywall. Their faces still pick up the finish of the rooms on each side." : "Counted as demolition LF and SF. No finish."}</p>`}
      ${st !== "demo" ? `<label class="toggle"><input type="checkbox" id="itFin" ${it.noFinish ? "" : "checked"}> Gets wall finish from the rooms on each side</label>` : ""}
      <div class="row"><div class="field"><label for="itH">Height override (ft)</label><input id="itH" inputmode="decimal" placeholder="${t ? t.height + " (type default)" : ""}" value="${it.heightFt ?? ""}"></div></div>
      <div class="readout"><div><div class="k">Length</div><div class="v">${q != null ? fmt(q) + " LF" : "—"}</div></div><div><div class="k">Wall face</div><div class="v">${wallSf != null ? fmt(wallSf, 0) + " SF" : "—"}</div></div>
      <div><div class="k">GWB (gross)</div><div class="v">${wallSf != null && t ? fmt(wallSf * t.sides * t.layers, 0) + " SF" : "—"}</div></div><div><div class="k">Segments</div><div class="v">${it.pts.length - 1}</div></div></div>`;
  } else if (it.kind === "opening"){
    const p = partitionOf(it, sh);
    body = `<div class="row"><div class="field"><label for="opH">Opening height</label><input id="opH" value="${fmtFtIn(it.heightIn || 84)}"></div></div>
      <div class="readout"><div><div class="k">Width</div><div class="v">${q != null ? fmtFtIn(q) : "—"}</div></div><div><div class="k">Deducts</div><div class="v">${q != null ? fmt(q * (it.heightIn || 84) / 144, 1) + " SF" : "—"}</div></div></div>
      <p class="hint">${p ? `On partition ${esc(typeById(p.typeId)?.tag || "?")}.` : "Not on a partition, so nothing is deducted. Drag it onto a wall."} ${project.deductOpenings ? "" : "Opening deductions are off for this project."}</p>`;
  } else {
    const unit = it.kind === "area" ? "SF" : it.kind === "linear" ? "LF" : "EA";
    const list = PC().filter(c => c.unit === unit);
    body = `<div class="field"><label for="itSurf">Surface</label><select id="itSurf"><option value="new" ${it.status === "existing" ? "" : "selected"}>New work</option><option value="existing" ${it.status === "existing" ? "selected" : ""}>Existing surface (ETR)</option></select></div>
      <div class="field"><label for="itCall">Callout</label><select id="itCall">${list.map(c => `<option value="${c.id}" ${c.id === it.calloutId ? "selected" : ""}>${esc(c.code)} — ${esc(c.name)}</option>`).join("")}</select></div>
      <div class="readout"><div><div class="k">Quantity</div><div class="v">${q != null ? fmt(q, it.kind === "count" ? 0 : 1) + " " + unit : "—"}</div></div><div><div class="k">${it.kind === "area" ? "Perimeter" : "Points"}</div><div class="v">${it.kind === "area" && sh.ppi ? fmt(polyLen(it.pts, true) / sh.ppi / 12) + " LF" : it.pts.length}</div></div></div>`;
  }
  return `<div class="row" style="justify-content:space-between;align-items:center"><h3>${kindName}</h3>${srcBadge(it)}</div>
    ${body}
    <div class="field"><label for="itNote">Note</label><input id="itNote" value="${esc(it.note || "")}" placeholder="e.g. full height at stair, deduct per detail 4/A8.1"></div>
    <div class="row"><button class="btn danger small" id="itDel">Delete</button><button class="btn small" id="itDup">Duplicate</button><button class="btn small ghost" id="itDone">Done</button></div>
    <p class="hint">Drag a square handle to move a corner. Double-click a segment to add a corner. Select a corner and press Delete to remove it.</p>`;
}
function paneSheet(){
  const sh = sheet();
  if (!sh) return `<h3>Start a takeoff</h3><p class="hint">Add a floor plan sheet on the left. PDFs are split into one sheet per page.</p>${helpBlock()}`;
  const scaleOpts = [["",""],["1/16\" = 1'-0\"",192],["3/32\" = 1'-0\"",128],["1/8\" = 1'-0\"",96],["3/16\" = 1'-0\"",64],["1/4\" = 1'-0\"",48],["3/8\" = 1'-0\"",32],["1/2\" = 1'-0\"",24],["3/4\" = 1'-0\"",16],["1\" = 1'-0\"",12]];
  const ai = cur.ai;
  return `<div class="field"><label for="shName">Sheet name</label><input id="shName" value="${esc(sh.name)}"></div>
    <div class="row"><div class="field"><label for="shRole">Sheet role</label><select id="shRole">${ROLES.map(r => `<option value="${r[0]}" ${r[0] === sh.kind ? "selected" : ""}>${r[1]}</option>`).join("")}</select></div>${sampleFn && canImages ? `<button class="btn small" id="sortOne" ${cur.ai ? "disabled" : ""} style="align-self:end">Ask Claude</button>` : ""}</div>
    <div class="field" ${["walltypes", "finishes", "other"].includes(sh.kind) ? "hidden" : ""}><span class="flabel">Scale</span>
      <div class="readout"><div><div class="k">1 ft on sheet</div><div class="v">${sh.ppi ? fmt(sh.ppi * 12, 1) + " px" : "not set"}</div></div><div><div class="k">Source</div><div class="v" style="font-size:12px">${esc(sh.scaleNote || (sh.ppi ? "measured" : "—"))}</div></div></div>
      <div class="row"><button class="btn small primary" id="goCal">Measure a known length</button>${sh.dpi ? `<select id="archScale" aria-label="Drawing scale">${scaleOpts.map(([l, r]) => `<option value="${r}">${l || "Or pick drawing scale…"}</option>`).join("")}</select>` : ""}</div>
      ${sh.dpi ? "" : `<p class="hint">Picture uploads have no print size, so measure a door or dimension string instead of picking a ratio.</p>`}
    </div>
    ${sh.kind === "elevation" ? elevAiBox(sh) : sh.kind === "walltypes" ? typesSheetBox(sh) : sh.kind === "finishes" ? finishBox(sh) : sh.kind === "rcp" ? roomsBox(sh) : sh.kind === "other" ? `<p class="hint">This sheet is skipped in the takeoff. Change its role if it holds plans, wall types, finishes, elevations or ceilings.</p>` : planAiBox(sh) + roomsBox(sh)}
    <div class="row"><button class="btn small danger" id="shDel">Remove sheet</button>${sh.items.some(i => i.src === "claude" && !i.edited) ? `<button class="btn small" id="acceptAll">Accept Claude's drafts</button>` : ""}</div>
    ${helpBlock()}`;
}
function elevAiBox(sh){
  const ai = cur.ai;
  return `<div class="ai-box"><h3>Draft callouts with Claude</h3>
      <p class="hint">Claude finds finish callouts and traces their areas and lengths. Untouched drafts on this sheet get replaced.</p>
      <div class="row"><button class="btn primary small" id="aiGo" ${sampleFn && canImages && !ai ? "" : "disabled"}>${ai ? "Working…" : "Draft this sheet"}</button>${ai ? `<button class="btn small" id="aiStop">Stop</button>` : ""}</div>
      <div class="row" style="align-items:center"><span class="badge">${sh.focus ? "Area set" : "Whole sheet"}</span><button class="btn small" id="goFocus">${sh.focus ? "Redraw area" : "Limit to an area"}</button>${sh.focus ? `<button class="btn small ghost" id="clrFocus">Clear</button>` : ""}</div>
      ${!sampleFn || !canImages ? `<p class="hint">${first.aiConnected ? "Only estimators can ask Claude to draft. You can look and measure." : "AI is not connected on the server yet, so Claude can't draft. You can still take off by hand."}</p>` : ""}
      ${cur.aiNote ? `<div class="ai-out" id="aiOut">${esc(cur.aiNote)}</div>` : ""}
    </div>`;
}
function helpBlock(){
  return `<div class="kbd-help"><kbd>W</kbd><span>Partition: click corners, double-click or Enter to finish</span><kbd>Shift</kbd><span>Flip ortho while drawing</span><kbd>Backspace</kbd><span>Remove last point while drawing</span><kbd>Space</kbd><span>Hold and drag to pan</span><kbd>Ctrl Z</kbd><span>Undo</span><kbd>Esc</kbd><span>Cancel or deselect</span></div>`;
}
function paneCalibrate(){
  const sh = sheet(); const c = cur.calib || {pts: []};
  const px = c.pts.length === 2 ? dist(c.pts[0], c.pts[1]) : null;
  return `<h3>Set the scale</h3>
    <p class="hint">${c.pts.length === 0 ? "Click the first point: one jamb of a door, or one end of a dimension string." : c.pts.length === 1 ? "Click the second point." : `Measured ${fmt(px, 0)} px. What does that length equal?`}</p>
    ${px ? `<div class="field"><label for="calLen">Real length</label><input id="calLen" value="3'-0&quot;" placeholder="3'-0&quot;, 36, 12'6, 10.5 ft"></div>
    <div class="chips"><button class="chip" data-len="36">36" door</button><button class="chip" data-len="32">32" door</button><button class="chip" data-len="72">6'-0" pair</button><button class="chip" data-len="120">10'-0"</button></div>
    <div class="row"><button class="btn primary" id="calApply">Apply scale</button><button class="btn" id="calRedo">Measure again</button></div>
    <p class="hint">A plain number means inches. Use ' for feet.</p>` : ""}
    ${sh?.ppi ? `<p class="hint">Current: 1 ft = ${fmt(sh.ppi * 12, 1)} px. Applying a new scale updates every quantity on this sheet.</p>` : ""}
    <button class="btn small ghost" id="calCancel">Cancel</button>`;
}
function paneLibrary(){
  return `<h3>Partition types · this project</h3>
    <p class="hint">Each project keeps its own wall types. Reading a sheet fills these in after you confirm.</p>
    ${PT().map(t => `<div class="lib-card" data-type="${t.id}">
      <div class="row"><div class="field" style="flex:0 0 64px;min-width:64px"><label>Tag</label><input data-f="tag" value="${esc(t.tag)}"></div><div class="field"><label>Height ft</label><input data-f="height" inputmode="decimal" value="${t.height}"></div><div class="field" style="flex:0 0 44px;min-width:44px"><label>Color</label><input type="color" data-f="color" value="${t.color}"></div></div>
      <div class="field"><label>Description</label><input data-f="desc" value="${esc(t.desc)}"></div>
      <div class="row"><div class="field"><label>Stud in</label><input data-f="stud" inputmode="decimal" value="${t.stud}"></div><div class="field"><label>O.C. in</label><input data-f="spacing" inputmode="decimal" value="${t.spacing}"></div><div class="field"><label>Faces</label><input data-f="sides" inputmode="numeric" value="${t.sides}"></div><div class="field"><label>Layers</label><input data-f="layers" inputmode="numeric" value="${t.layers}"></div><div class="field"><label>Waste %</label><input data-f="waste" inputmode="decimal" value="${t.waste}"></div></div>
      <div class="row" style="justify-content:space-between;align-items:center"><label class="toggle"><input type="checkbox" data-f="insul" ${t.insul ? "checked" : ""}> Insulated</label><button class="btn small ghost danger" data-del-type="${t.id}">Remove</button></div>
    </div>`).join("")}
    <div class="row"><button class="btn small" id="addType">Add partition type</button><button class="btn small ghost" id="saveCompany" ${canWrite ? "" : "disabled"}>Use these types and finish codes for new takeoffs</button></div>
    <p class="hint" id="libMsg"></p>
    <div class="ai-box"><h3>Read partition details with Claude</h3>
      <p class="hint">Upload a picture of your partition schedule or wall-type details, or paste the text. Claude adds or updates types by tag.</p>
      <input type="file" id="detImg" accept="image/png,image/jpeg,image/webp" ${canImages ? "" : "disabled"}>
      <div class="field"><label for="detTxt">Or paste schedule text</label><textarea id="detTxt" rows="3" placeholder='Type E: 3-5/8" 25ga @ 24" o.c., 1 layer 5/8" GWB ea side to 9&apos;-0" AFF'></textarea></div>
      <div class="row"><button class="btn primary small" id="detGo" ${sampleFn && !cur.ai ? "" : "disabled"}>${cur.ai === "details" ? "Reading…" : "Read details"}</button></div>
      ${cur.detNote ? `<div class="ai-out">${esc(cur.detNote)}</div>` : ""}
    </div>
    <h3>Finish callouts</h3>
    <p class="hint">Used on elevations and plans for SF, LF and EA items.</p>
    ${PC().map(c => `<div class="lib-card" data-call="${c.id}"><div class="row"><div class="field" style="flex:0 0 76px;min-width:76px"><label>Code</label><input data-f="code" value="${esc(c.code)}"></div><div class="field" style="flex:0 0 68px;min-width:68px"><label>Unit</label><select data-f="unit">${["SF","LF","EA"].map(u => `<option ${u === c.unit ? "selected" : ""}>${u}</option>`).join("")}</select></div><div class="field" style="flex:0 0 44px;min-width:44px"><label>Color</label><input type="color" data-f="color" value="${c.color}"></div><button class="btn small ghost danger" data-del-call="${c.id}" style="align-self:end">✕</button></div><div class="field"><label>Description</label><input data-f="name" value="${esc(c.name)}"></div></div>`).join("")}
    <div class="row"><button class="btn small" id="addCall">Add callout</button></div>`;
}
function paneLearn(){
  const corr = (project.corrections || []).slice().reverse();
  const glob = lessons.filter(l => l.scope !== "project"), mine = lessons.filter(l => l.scope === "project" && l.thisLead);
  const otherN = 0;
  const row = (l, isGlobal) => `<div class="lesson"><div><p>${esc(l.text)}</p><span class="src">${esc(l.source === "user" ? "your rule" : "learned from corrections")} · ${new Date(l.createdAt || Date.now()).toLocaleDateString()}</span></div><div class="row" style="gap:4px;flex-wrap:nowrap"><button class="btn small ghost" data-scope-lesson="${l.id}" data-to="${isGlobal ? "project" : "global"}" title="${isGlobal ? "Use only on this project" : "Use on every project"}">${isGlobal ? "This project only" : "Use everywhere"}</button><button class="btn small ghost danger" data-del-lesson="${l.id}" aria-label="Remove rule">✕</button></div></div>`;
  return `<h3>Rules for every project</h3>
    <p class="hint">How you read drawings in general: tag shapes, new versus existing work, what to skip.</p>
    <div>${glob.length ? glob.map(l => row(l, true)).join("") : `<p class="hint">None yet.</p>`}</div>
    <h3>Rules for this project only</h3>
    <p class="hint">Job-specific: which type tags count here, special heights.${otherN ? ` ${otherN} rule${otherN === 1 ? "" : "s"} from other projects ${otherN === 1 ? "is" : "are"} hidden and not used here.` : ""}</p>
    <div>${mine.length ? mine.map(l => row(l, false)).join("") : `<p class="hint">None yet.</p>`}</div>
    <div class="field"><label for="newLesson">Add a rule</label><textarea id="newLesson" rows="2" placeholder="e.g. Only new walls with a tag in a square or diamond count. Skip anything marked ETR."></textarea></div>
    <div class="row"><select id="newScope" aria-label="Where the rule applies"><option value="global">Every takeoff</option><option value="project">This lead only</option></select><button class="btn small" id="addLesson">Add rule</button></div>
    <h3>Corrections on this project</h3>
    <p class="hint">Logged automatically when you change, delete or add to Claude's draft.</p>
    <div class="log">${corr.length ? corr.slice(0, 60).map(c => `<div>${new Date(c.t).toLocaleTimeString([], {hour: "numeric", minute: "2-digit"})} · ${esc(c.sheet || "")} · ${esc(c.msg)}</div>`).join("") : "Nothing yet."}</div>
    <div class="ai-box"><h3>Distill into rules</h3><p class="hint">Claude reads these corrections and writes short rules for this project. Move any that apply everywhere to the top list.</p>
      <div class="row"><button class="btn primary small" id="distill" ${sampleFn && corr.length && !cur.ai ? "" : "disabled"}>${cur.ai === "distill" ? "Thinking…" : "Learn from corrections"}</button></div>
      ${cur.learnNote ? `<div class="ai-out">${esc(cur.learnNote)}</div>` : ""}</div>`;
}

function wirePane(){
  const on = (id, ev, fn) => { const el = byId(id); if (el) el.addEventListener(ev, fn); };
  const it = selItem(), sh = sheet();
  // item
  on("itType", "change", e => { if (e.target.value) cur.typeId = e.target.value; changeItem(it, {typeId: e.target.value || undefined}); renderChips(); });
  on("itStatus", "change", e => changeItem(it, {status: e.target.value === "new" ? undefined : e.target.value, ...(e.target.value === "demo" ? {noFinish: undefined} : {})}));
  on("itFin", "change", e => changeItem(it, {noFinish: e.target.checked ? undefined : true}));
  on("itSurf", "change", e => changeItem(it, {status: e.target.value === "existing" ? "existing" : undefined}));
  on("itH", "change", e => { const v = parseFloat(e.target.value); changeItem(it, {heightFt: isFinite(v) && v > 0 ? v : undefined}); });
  on("opH", "change", e => { const v = parseLen(e.target.value); if (isFinite(v) && v > 0) changeItem(it, {heightIn: v}); else renderPane(); });
  on("itCall", "change", e => { cur.calloutId = e.target.value; changeItem(it, {calloutId: e.target.value}); });
  on("itNote", "change", e => changeItem(it, {note: e.target.value}));
  on("itDel", "click", () => deleteItem(it));
  on("itDup", "click", () => { checkpoint(); const n = clone(it); n.id = uid(); n.src = "user"; delete n.edited; n.pts = n.pts.map(p => [p[0] + 24, p[1] + 24]); sh.items.push(n); cur.sel = n.id; dirty(); render(); renderPane(); renderSheets(); });
  on("itDone", "click", () => { cur.sel = null; renderPane(); render(); });
  // sheet
  on("shName", "change", e => { sh.name = e.target.value || sh.name; dirty(); renderSheets(); });
  on("shRole", "change", e => { sh.kind = e.target.value; cur.aiNote = ""; dirty(); renderPane(); renderSheets(); });
  on("sortOne", "click", () => aiClassify([sh.id]));
  on("aiTypes", "click", () => aiReadTypes());
  on("typesOk", "click", () => confirmReview(false));
  on("aiFinish", "click", () => aiReadFinishes());
  on("finOk", "click", () => confirmSchedule());
  on("aiRooms", "click", () => aiFindRooms());
  root.querySelectorAll("[data-mat-app]").forEach(el => el.onchange = () => { sh.schedule.materials[+el.dataset.matApp].applies = el.value; dirty(); });
  if (it?.kind === "room") wireRoom(it);
  if (cur.tab === "takeoff") wireReport();
  on("goCal", "click", () => setTool("calibrate"));
  on("archScale", "change", e => { const r = +e.target.value; if (!r || !sh.dpi) return; checkpoint(); sh.ppi = sh.dpi / r; sh.scaleNote = e.target.selectedOptions[0].textContent; delete sh.scaleAssumed; dirty(); renderAll(); });
  on("shDel", "click", e => {
    const b = e.target; if (b.dataset.armed){ project.sheets = project.sheets.filter(s => s !== sh); cur.sheetId = project.sheets[0]?.id || null; dirty(); renderAll(); return; }
    b.dataset.armed = "1"; b.textContent = "Click again to remove"; setTimeout(() => { if (b.isConnected){ delete b.dataset.armed; b.textContent = "Remove sheet"; } }, 3000);
  });
  on("acceptAll", "click", () => { checkpoint(); sh.items.forEach(i => { if (i.src === "claude" && !i.edited) i.accepted = true; }); logCorrection(`Accepted Claude's remaining drafts on this sheet as-is`); dirty(); renderPane(); });
  on("aiGo", "click", () => aiDraft());
  if (sh && sh.kind !== "elevation" && cur.tab === "item") wireReview(sh);
  on("goFocus", "click", () => setTool("focus"));
  on("clrFocus", "click", () => { delete sh.focus; dirty(); renderPane(); render(); });
  on("aiStop", "click", () => cur.aiCtl?.abort());
  // calibrate
  root.querySelectorAll("[data-len]").forEach(b => b.onclick = () => { $("#calLen").value = fmtFtIn(+b.dataset.len); });
  const applyCal = () => {
    const L = parseLen($("#calLen").value); const c = cur.calib;
    if (!isFinite(L) || L <= 0){ $("#calLen").style.borderColor = "var(--bad)"; return; }
    checkpoint(); sh.ppi = dist(c.pts[0], c.pts[1]) / L; sh.scaleNote = `measured ${fmtFtIn(L)}`; delete sh.scaleAssumed;
    cur.calib = null; dirty(); setTool("select"); renderSheets();
  };
  on("calApply", "click", applyCal);
  on("calLen", "keydown", e => { if (e.key === "Enter") applyCal(); });
  on("calRedo", "click", () => { cur.calib = {pts: []}; renderPane(); render(); });
  on("calCancel", "click", () => setTool("select"));
  // takeoff
  root.querySelectorAll("[data-scope]").forEach(b => b.onclick = () => { cur.scope = b.dataset.scope; renderPane(); });
  on("dedOpen", "change", e => { project.deductOpenings = e.target.checked; dirty(); renderPane(); });
  on("expCsv", "click", () => exportFile("csv"));
  on("expJson", "click", () => exportFile("json"));
  on("copySum", "click", () => {
    const txt = summaryText();
    navigator.clipboard.writeText(txt).then(() => { $("#copyMsg").textContent = "Copied. Paste it into chat to talk it through with Claude."; }).catch(() => { $("#copyMsg").innerHTML = `<textarea rows="6" style="width:100%">${esc(txt)}</textarea>`; $("#copyMsg textarea").select(); });
  });
  // library
  root.querySelectorAll("[data-type] [data-f]").forEach(inp => inp.addEventListener("change", () => {
    const t = typeById(inp.closest("[data-type]").dataset.type), f = inp.dataset.f;
    t[f] = inp.type === "checkbox" ? inp.checked : ["height","stud","spacing","sides","layers","waste"].includes(f) ? (parseFloat(inp.value) || 0) : inp.value;
    libDirty();
  }));
  root.querySelectorAll("[data-call] [data-f]").forEach(inp => inp.addEventListener("change", () => { const c = calloutById(inp.closest("[data-call]").dataset.call); c[inp.dataset.f] = inp.value; libDirty(); }));
  root.querySelectorAll("[data-del-type]").forEach(b => b.onclick = () => {
    const id = b.dataset.delType, used = project.sheets.some(s => s.items.some(i => i.typeId === id));
    if (used){ $("#libMsg").textContent = "That type is used on this project. Reassign those partitions first."; return; }
    PT() = PT().filter(t => t.id !== id); libDirty();
  });
  root.querySelectorAll("[data-del-call]").forEach(b => b.onclick = () => {
    const id = b.dataset.delCall; if (project.sheets.some(s => s.items.some(i => i.calloutId === id))){ $("#libMsg").textContent = "That callout is used on this project."; return; }
    PC() = PC().filter(c => c.id !== id); libDirty();
  });
  on("addType", "click", () => { const n = PT().length; PT().push({id: "t" + uid(), tag: String.fromCharCode(65 + n), desc: "New partition type", height: 10, stud: 3.625, spacing: 16, sides: 2, layers: 1, insul: false, waste: 10, color: TYPE_COLORS[n % TYPE_COLORS.length]}); libDirty(); });
  on("saveCompany", "click", async () => { try { await saveCompanyList(); $("#libMsg").textContent = "Saved. New takeoffs on other leads start with these."; } catch (e){ $("#libMsg").textContent = e.message; } });
  on("addCall", "click", () => { PC().push({id: "c" + uid(), code: "NEW-1", name: "New finish", unit: "SF", color: TYPE_COLORS[PC().length % TYPE_COLORS.length]}); libDirty(); });
  on("detGo", "click", () => aiDetails());
  // learning
  on("addLesson", "click", () => { const t = $("#newLesson").value.trim(); if (t) addLessons([t], "user", $("#newScope").value); });
  root.querySelectorAll("[data-scope-lesson]").forEach(b => b.onclick = () => setLessonScope(b.dataset.scopeLesson, b.dataset.to));
  root.querySelectorAll("[data-del-lesson]").forEach(b => b.onclick = () => removeLesson(b.dataset.delLesson));
  on("distill", "click", () => aiDistill());
}

/* ================= export ================= */

/* ================= Claude ================= */
const activeLessons = () => lessons.filter(l => l.scope !== "project" || l.thisLead);
const lessonText = () => { const a = activeLessons().slice(-40).map(l => "- " + l.text), ins = (project.instructions || []).map(i => "- (this project) " + i.text); const all = [...a, ...ins]; return all.length ? all.join("\n") : "(none yet)"; };

async function cropBlob(sh, b){
  const im = await sheetCanvas(sh);
  const s = Math.min(2, 1568 / Math.max(b.w, b.h), Math.sqrt(1.15e6 / (b.w * b.h)));
  const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(b.w * s)); c.height = Math.max(1, Math.round(b.h * s));
  const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(im, b.x, b.y, b.w, b.h, 0, 0, c.width, c.height);
  return await new Promise(r => c.toBlob(r, "image/png"));
}
function padBox(sh, b, f = 0.1){
  const minSide = Math.max(sh.w, sh.h) * 0.12;
  let w = Math.max(b.w * (1 + 2*f), minSide), h = Math.max(b.h * (1 + 2*f), minSide);
  let x = b.x + b.w/2 - w/2, y = b.y + b.h/2 - h/2;
  x = Math.max(0, x); y = Math.max(0, y); w = Math.min(w, sh.w - x); h = Math.min(h, sh.h - y);
  return {x, y, w, h};
}
function mergeBoxes(boxes){
  const out = [];
  for (const b of boxes){
    const hit = out.find(o => !(b.x > o.x + o.w || o.x > b.x + b.w || b.y > o.y + o.h || o.y > b.y + b.h));
    if (hit){ const x = Math.min(hit.x, b.x), y = Math.min(hit.y, b.y); hit.w = Math.max(hit.x + hit.w, b.x + b.w) - x; hit.h = Math.max(hit.y + hit.h, b.y + b.h) - y; hit.x = x; hit.y = y; }
    else out.push({...b});
  }
  return out;
}
const sheetBlob = sh => cropBlob(sh, {x: 0, y: 0, w: sh.w, h: sh.h});
// sorting a whole plan set only needs each page small enough to read the title block
const classifyBlob = async sh => { const c = imgs[sh.id] || await renderSheet(sh, 1568); const k = document.createElement("canvas"), s = Math.min(1, 1568 / Math.max(c.width, c.height)); k.width = Math.round(c.width * s); k.height = Math.round(c.height * s); k.getContext("2d").drawImage(c, 0, 0, k.width, k.height); return new Promise(r => k.toBlob(r, "image/jpeg", 0.85)); };
const errCopy = e => ({not_granted: "Claude access was declined for this page.", rate_limited: "Too many requests right now. Try again in a minute.", cancelled: "Stopped.", invalid_json: "Claude's reply couldn't be read as a takeoff. Try again.", images_unavailable: "Images can't be sent to Claude in this view."}[e?.code] || (e?.message || "Something went wrong."));
const TAG_GUIDE = `How to tell a wall-type tag: short text (for example "A3") inside a SQUARE, RECTANGLE or DIAMOND, sitting on or beside a wall, often with a height note such as 11'-6" next to it. Ovals, circles and hexagons holding codes like A197 or 113 are keynotes, room tags or door tags, NOT wall types. "ETR" means existing to remain: those walls are EXISTING, not new. Tags in squares or diamonds name NEW wall types.`;

async function aiDraft(){
  const sh = sheet(); if (!sh || !sampleFn) return;
  const elev = sh.kind === "elevation";
  cur.ai = "draft"; cur.aiCtl = new AbortController(); const signal = cur.aiCtl.signal;
  const say = t => { cur.aiNote = t; renderPane(); };
  const libTags = PT().map(t => t.tag.toUpperCase());
  const typesTxt = PT().map(t => `${t.tag}: ${t.desc} (default height ${t.height} ft)`).join("\n");
  try {
    let boxes, notes = [], otherTags = new Set();
    if (sh.focus) boxes = [sh.focus];
    else if (elev) boxes = [{x: 0, y: 0, w: sh.w, h: sh.h}];
    else {
      say("Step 1 of 2: looking for your wall-type tags on the whole sheet…");
      const loc = await sampleFn.json(`You are reviewing a construction FLOOR PLAN (whole sheet attached) to find where NEW partition work is.
Wall-type tags in the estimator's library:
${typesTxt}
${TAG_GUIDE}
Rules this estimator taught you (follow them):
${lessonText()}

1. Find every wall-type tag on the sheet whose text matches a library tag. Give each tag's box.
2. Give a bounding box around each area of new wall work those tags point to: the full tagged wall runs plus a little margin. Do not include areas that only have existing walls.
3. List any other wall-type tags you see that are not in the library.
Coordinates are normalized 0-1000 on both axes (x from the left edge, y from the top edge).
Reply with only JSON: {"tags":[{"tag":"A3","box":[x0,y0,x1,y1]}],"regions":[[x0,y0,x1,y1]],"other_tags":["..."],"notes":"one sentence"}`, {images: [await sheetBlob(sh)], modelTier: "complex", signal, cache: false});
      (loc.other_tags || []).forEach(t => otherTags.add(String(t)));
      if (loc.notes) notes.push(String(loc.notes));
      const toBox = a => Array.isArray(a) && a.length === 4 && a.every(v => isFinite(+v)) ? (() => { const [x0, y0, x1, y1] = a.map(Number); const X0 = Math.min(x0, x1) / 1000 * sh.w, Y0 = Math.min(y0, y1) / 1000 * sh.h; return {x: X0, y: Y0, w: Math.abs(x1 - x0) / 1000 * sh.w, h: Math.abs(y1 - y0) / 1000 * sh.h}; })() : null;
      let raw = (loc.regions || []).map(toBox).filter(Boolean);
      if (!raw.length) raw = (loc.tags || []).filter(t => libTags.includes(String(t.tag).toUpperCase())).map(t => toBox(t.box)).filter(Boolean);
      boxes = mergeBoxes(raw.map(b => padBox(sh, b, 0.15))).slice(0, 4);
      if (!boxes.length){
        cur.aiNote = `Claude didn't find any ${PT().map(t => t.tag).join(" / ")} tags on this sheet.${otherTags.size ? " It saw these other tags: " + [...otherTags].join(", ") + "." : ""} Draw a focus area around the new work and try again.`;
        cur.ai = null; cur.aiCtl = null; renderPane(); return;
      }
      sh.focus = boxes.length === 1 ? boxes[0] : {x: Math.min(...boxes.map(b => b.x)), y: Math.min(...boxes.map(b => b.y)), w: Math.max(...boxes.map(b => b.x + b.w)) - Math.min(...boxes.map(b => b.x)), h: Math.max(...boxes.map(b => b.y + b.h)) - Math.min(...boxes.map(b => b.y))};
      render();
    }
    const found = [];
    for (let bi = 0; bi < boxes.length; bi++){
      const box = sh.focus && boxes.length === 1 && boxes[0] === sh.focus ? sh.focus : boxes[bi];
      say(elev ? "Reading the elevation…" : `Step 2 of 2: tracing walls in area ${bi + 1} of ${boxes.length} at full detail…`);
      const prompt = elev ? `You are a construction estimator doing a finish takeoff from an interior ELEVATION (image attached${box.w < sh.w ? ", a close-up crop" : ""}). Sheet: "${sh.name}".
Finish callouts in the estimator's library:
${PC().map(c => `${c.code} (${c.unit}): ${c.name}`).join("\n")}
Rules this estimator taught you (follow them):
${lessonText()}

${scaleLine(sh)}
Find every finish callout tag and measure what it covers. Mark each item's status: "existing" when the surface is existing to remain (ETR, existing, or shown screened), otherwise "new". Existing surfaces still count when a finish is called out on them. SF items: a closed polygon excluding doors, windows and openings. LF items (base, rails, trim): a polyline along the item. EA items: one point per instance. Use the code exactly as printed; if it isn't in the library, still return it with a guessed name and unit.
Coordinates are normalized 0-1000 on both axes of THIS image (x from left, y from top).
Reply with only JSON: {"items":[{"callout":"PT-1","name":"Paint","unit":"SF","kind":"area|linear|count","status":"new|existing","pts":[[x,y],...]}],"scale_ref":{"pts":[[x,y],[x,y]],"length_in":120} or null,"notes":"one or two sentences"}`
      : `You are a construction estimator doing a framing and drywall takeoff. The image is a CLOSE-UP crop of a floor plan (sheet "${sh.name}") around new partition work.
Wall types in the estimator's library (tag: description):
${typesTxt}
${TAG_GUIDE}
Rules this estimator taught you (follow them):
${lessonText()}

Trace ONLY new walls identified by a library wall-type tag. A tag applies to the wall it sits on or points at and to the continuous run of that same wall construction (including around corners) up to where it meets existing or different walls. Skip existing walls (ETR, thin, grey or screened linework), demolition (dashed), casework, fixtures, ceilings, dimension and leader lines.
Trace each wall along its centerline as a polyline, with a vertex only at real corners. Run continuously through door openings. Keep horizontal and vertical runs exactly horizontal or vertical.
If a dimension string gives a run's length, put it in printed_length (like "14'-5\\"").
Give one dimension string you can read clearly as scale_ref: the two points its extension lines mark and its length in inches.
List door openings in the walls you traced (two jamb points each).
Coordinates are normalized 0-1000 on both axes of THIS crop (x from its left edge, y from its top edge).
Reply with only JSON: {"partitions":[{"type":"A3","pts":[[x,y],[x,y]],"printed_length":"14'-5\\"" or null,"confidence":"high|low"}],"doors":[{"pts":[[x,y],[x,y]]}],"scale_ref":{"pts":[[x,y],[x,y]],"length_in":72} or null,"other_tags":["tags not in the library"],"notes":"one or two sentences"}`;
      const res = await sampleFn.json(prompt, {images: [await cropBlob(sh, box)], modelTier: "complex", signal, cache: false});
      const N = q => Array.isArray(q) && q.length >= 2 && isFinite(+q[0]) && isFinite(+q[1]) ? [box.x + Math.max(0, Math.min(1000, +q[0])) / 1000 * box.w, box.y + Math.max(0, Math.min(1000, +q[1])) / 1000 * box.h] : null;
      const pts = a => (Array.isArray(a) ? a : []).map(N).filter(Boolean);
      found.push({res, pts});
      (res.other_tags || []).forEach(t => otherTags.add(String(t)));
      if (res.notes) notes.push(String(res.notes));
    }

    checkpoint();
    sh.items = sh.items.filter(i => !(i.src === "claude" && !i.edited && !i.accepted));
    let added = 0; const skipped = {};
    // scale from a printed dimension, if none set
    if (!sh.ppi){
      for (const {res, pts} of found){ const r = res.scale_ref; if (!r) continue; const p = pts(r.pts), L = +r.length_in; if (p.length === 2 && L > 0 && dist(p[0], p[1]) > 4){ sh.ppi = dist(p[0], p[1]) / L; sh.scaleAssumed = L; sh.scaleFrom = `a ${fmtFtIn(L)} dimension string it read`; sh.scaleNote = `from ${fmtFtIn(L)} dim`; break; } }
    }
    const dupTol = () => sh.ppi ? sh.ppi * 4 : 12;
    const isDup = p => sh.items.some(it => it.src === "claude" && it.kind === "partition" && p.every(q => { for (let i = 1; i < it.pts.length; i++) if (nearestOnSeg(q, it.pts[i-1], it.pts[i]).d < dupTol()) return true; return false; }));
    for (const {res, pts} of found){
      if (elev){
        for (const r of (res.items || [])){
          const code = String(r.callout || "").trim().toUpperCase(); if (!code) continue;
          const kind = ["area","linear","count"].includes(r.kind) ? r.kind : "area";
          const unit = kind === "area" ? "SF" : kind === "linear" ? "LF" : "EA";
          let c = PC().find(x => x.code.toUpperCase() === code && x.unit === unit) || PC().find(x => x.code.toUpperCase() === code);
          if (!c){ c = {id: "c" + uid(), code, name: String(r.name || "From elevation"), unit, color: TYPE_COLORS[PC().length % TYPE_COLORS.length]}; PC().push(c); libDirty(); }
          const p = pts(r.pts); if (p.length < (kind === "area" ? 3 : kind === "linear" ? 2 : 1)) continue;
          sh.items.push({id: uid(), kind: c.unit === "SF" ? "area" : c.unit === "LF" ? "linear" : "count", calloutId: c.id, pts: p, src: "claude", ...(r.status === "existing" ? {status: "existing"} : {})}); added++;
        }
        continue;
      }
      for (const r of (res.partitions || [])){
        const tag = String(r.type || "").trim().toUpperCase();
        const t = PT().find(x => x.tag.toUpperCase() === tag);
        if (!t){ skipped[tag || "untagged"] = (skipped[tag || "untagged"] || 0) + 1; continue; }
        const p = pts(r.pts); if (p.length < 2 || isDup(p)) continue;
        const it = {id: uid(), kind: "partition", typeId: t.id, pts: p, src: "claude"};
        const notesIt = [];
        if (r.confidence === "low") notesIt.push("Claude: low confidence");
        const printed = parseLen(r.printed_length);
        if (isFinite(printed) && printed > 0){
          it.printedIn = printed;
          if (sh.ppi){ const meas = polyLen(p) / sh.ppi; if (Math.abs(meas - printed) / printed > 0.1) notesIt.push(`Printed ${fmtFtIn(printed)}, traced ${fmtFtIn(meas)}: check the ends`); }
        }
        if (notesIt.length) it.note = notesIt.join(". ");
        sh.items.push(it); added++;
      }
      for (const d of (res.doors || [])){ const p = pts(d.pts); if (p.length === 2) sh.items.push({id: uid(), kind: "opening", pts: p, heightIn: 84, src: "claude"}); }
    }
    const skipTxt = Object.entries(skipped).map(([k, n]) => `${n} ${k}`).join(", ");
    cur.aiNote = `Drafted ${added} ${elev ? "callout item" : "wall run"}${added === 1 ? "" : "s"} inside the yellow box. Dashed lines are Claude's drafts; edit one and it becomes yours and the change is logged.`
      + (skipTxt ? `\nSkipped walls not in your library: ${skipTxt}.` : "")
      + (otherTags.size ? `\nOther tags seen: ${[...otherTags].join(", ")}.` : "")
      + (notes.length ? "\n\nClaude's notes: " + notes.join(" ") : "");
    dirty(); renderSheets();
  } catch (e){ cur.aiNote = errCopy(e); }
  cur.ai = null; cur.aiCtl = null; renderPane(); render();
}
/* ===== Step 1: read the sheet; Step 2: take off confirmed types ===== */
function tilesFor(sh, area){
  const A = area || {x: 0, y: 0, w: sh.w, h: sh.h};
  let T = 1300, cols = Math.max(1, Math.ceil(A.w / T)), rows = Math.max(1, Math.ceil(A.h / T));
  while (cols * rows > 12){ T *= 1.15; cols = Math.max(1, Math.ceil(A.w / T)); rows = Math.max(1, Math.ceil(A.h / T)); }
  const tw = A.w / cols, th = A.h / rows, ox = cols > 1 ? tw * 0.12 : 0, oy = rows > 1 ? th * 0.12 : 0, out = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++){
    const x = Math.max(A.x, A.x + c * tw - ox), y = Math.max(A.y, A.y + r * th - oy);
    out.push({x, y, w: Math.min(A.x + A.w, A.x + (c + 1) * tw + ox) - x, h: Math.min(A.y + A.h, A.y + (r + 1) * th + oy) - y, r, c, rows, cols});
  }
  return out;
}
async function pool(items, n, fn){
  let i = 0; const out = new Array(items.length);
  await Promise.all(Array.from({length: Math.min(n, items.length)}, async () => { while (i < items.length){ const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}
const tileFatal = e => ["cancelled", "rate_limited", "unavailable", "offline"].includes(e?.code) || e?.status === 401;
const fromTile = (t, q) => Array.isArray(q) && q.length >= 2 && isFinite(+q[0]) && isFinite(+q[1]) ? [t.x + Math.max(0, Math.min(1000, +q[0])) / 1000 * t.w, t.y + Math.max(0, Math.min(1000, +q[1])) / 1000 * t.h] : null;
const boxFromTile = (t, a) => { if (!Array.isArray(a) || a.length !== 4) return null; const p = fromTile(t, [Math.min(a[0], a[2]), Math.min(a[1], a[3])]), q = fromTile(t, [Math.max(a[0], a[2]), Math.max(a[1], a[3])]); return p && q ? {x: p[0], y: p[1], w: Math.max(2, q[0] - p[0]), h: Math.max(2, q[1] - p[1])} : null; };
const scaleLine = sh => sh.ppi ? `The estimator has already set the drawing scale (${esc(sh.scaleNote || "measured")}). Do not look for doors or dimensions to set scale.` : "";
const TYPE_COLOR_FOR = tag => { const t = PT().find(x => x.tag.toUpperCase() === String(tag).toUpperCase()); return t?.color || "#868e96"; };

async function aiReadSheet(){
  const sh = sheet(); if (!sh || !sampleFn) return;
  cur.ai = "read"; cur.aiCtl = new AbortController(); const signal = cur.aiCtl.signal;
  const tiles = tilesFor(sh, sh.focus); let done = 0, failed = 0;
  const say = t => { cur.aiNote = t; renderPane(); };
  say(`Reading the sheet in ${tiles.length} close-up section${tiles.length === 1 ? "" : "s"}… 0 of ${tiles.length} done.`);
  try {
    const results = await pool(tiles, 2, async t => {
      try {
        const res = await sampleFn.json(`You are reading one section of a construction FLOOR PLAN sheet at full detail (section row ${t.r + 1} of ${t.rows}, column ${t.c + 1} of ${t.cols}). Sheet: "${sh.name}".
${TAG_GUIDE}
Rules this estimator taught you (follow them):
${lessonText()}

${PT().length ? "Wall types already defined elsewhere in this plan set: " + PT().map(t => t.tag).join(", ") + ". Tags matching these count as known types.\n" : ""}1. Find every wall-type tag in this section. For each, give the tag text, a box around the tag symbol, any height note printed next to it (like 11'-6"), and whether the wall it marks is NEW construction (solid, heavy or filled linework) or EXISTING (marked ETR or existing to remain, thin, grey or screened linework).
2. If this section contains a wall type legend, partition schedule, or wall type details (small sections or notes keyed to a tag describing studs, gypsum board layers, insulation, fire rating, height), transcribe every type defined there.
Coordinates are normalized 0-1000 on both axes of THIS section (x from its left edge, y from its top edge).
Reply with only JSON: {"tags":[{"tag":"A3","box":[x0,y0,x1,y1],"height_note":"11'-6\\"" or null,"wall":"new|existing|unclear"}],"legend":[{"tag":"A3","desc":"full description","height_ft":11.5 or null,"stud_in":3.625,"spacing_in":16,"faces":2,"layers":1,"insulated":false}],"notes":"one sentence or empty"}`, {images: [await cropBlob(sh, t)], modelTier: "complex", signal, cache: false});
        return res;
      } catch (e){ if (tileFatal(e)) throw e; failed++; return null; }
      finally { done++; if (cur.ai === "read") say(`Reading the sheet in ${tiles.length} close-up sections… ${done} of ${tiles.length} done.`); }
    });
    // aggregate
    const tags = [], legend = {}, notes = [];
    results.forEach((res, k) => {
      if (!res) return; const t = tiles[k];
      for (const g of (res.tags || [])){
        const tag = String(g.tag || "").trim().toUpperCase(); const b = boxFromTile(t, g.box); if (!tag || !b) continue;
        const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
        if (tags.some(o => o.tag === tag && Math.hypot(o.box.x + o.box.w / 2 - cx, o.box.y + o.box.h / 2 - cy) < Math.max(b.w, b.h, 12))) continue;
        tags.push({tag, box: b, wall: ["new", "existing"].includes(g.wall) ? g.wall : "unclear", heightIn: parseLen(g.height_note)});
      }
      for (const L of (res.legend || [])){ const tag = String(L.tag || "").trim().toUpperCase(); if (tag && !legend[tag]) legend[tag] = L; }
      if (res.notes) notes.push(String(res.notes));
    });
    const tagSet = [...new Set([...tags.map(t => t.tag), ...Object.keys(legend)])].sort();
    const types = tagSet.map(tag => {
      const L = legend[tag], ex = PT().find(t => t.tag.toUpperCase() === tag);
      const mine = tags.filter(t => t.tag === tag), nNew = mine.filter(t => t.wall === "new").length, nEx = mine.filter(t => t.wall === "existing").length, nUnc = mine.length - nNew - nEx;
      const hs = mine.map(t => t.heightIn).filter(v => isFinite(v) && v > 0); const hNote = hs.length ? hs.sort((a, b) => hs.filter(v => v === b).length - hs.filter(v => v === a).length)[0] / 12 : null;
      return {tag, desc: String(L?.desc || ex?.desc || ""), height: +(L?.height_ft) || hNote || ex?.height || 10, heightFrom: L?.height_ft ? "legend" : hNote ? "tag note" : ex ? "project" : "default",
        stud: +L?.stud_in || ex?.stud || 3.625, spacing: +L?.spacing_in || ex?.spacing || 16, sides: +L?.faces || ex?.sides || 2, layers: +L?.layers || ex?.layers || 1, insul: L ? !!L.insulated : !!ex?.insul,
        source: L ? "legend" : ex ? "project" : "tag", nNew, nEx, nUnc, include: (nNew + nUnc) > 0 && nNew >= nEx};
    });
    sh.review = {status: "pending", at: Date.now(), types, tags, notes: notes.slice(0, 6), failed, showTags: true};
    cur.aiNote = types.length ? `Found ${tags.length} wall-type tag${tags.length === 1 ? "" : "s"} and ${Object.keys(legend).length} type definition${Object.keys(legend).length === 1 ? "" : "s"}. Check the list below, then confirm.` + (failed ? ` ${failed} section${failed === 1 ? "" : "s"} couldn't be read.` : "")
      : `No wall-type tags found on this sheet.${failed ? ` ${failed} section${failed === 1 ? "" : "s"} couldn't be read; try again.` : " If the tags are there, add a rule describing how they look and read again."}`;
    dirty();
  } catch (e){ cur.aiNote = errCopy(e); }
  cur.ai = null; cur.aiCtl = null; renderPane(); render();
}

function confirmReview(takeoff = true){
  const sh = sheet(), rv = sh.review; if (!rv) return;
  const chosen = rv.types.filter(t => t.include);
  rv.scope ||= {existing: true, demo: false};
  for (const r of chosen){
    const ex = PT().find(t => t.tag.toUpperCase() === r.tag.toUpperCase());
    const f = {tag: r.tag, desc: r.desc || ex?.desc || `Wall type ${r.tag}`, height: +r.height || 10, stud: r.stud, spacing: r.spacing, sides: r.sides, layers: r.layers, insul: r.insul};
    if (ex) Object.assign(ex, f); else PT().push({id: "t" + uid(), waste: 10, color: TYPE_COLORS[PT().length % TYPE_COLORS.length], ...f});
  }
  rv.status = "confirmed"; rv.confirmed = chosen.map(t => t.tag);
  logCorrection(`Confirmed wall types for takeoff: ${chosen.map(t => t.tag).join(", ") || "none"}` + (rv.types.length > chosen.length ? `; left out ${rv.types.filter(t => !t.include).map(t => t.tag).join(", ")}` : ""));
  dirty(); renderChips(); if (takeoff) aiTakeoff(); else { cur.aiNote = `Added ${chosen.length} wall type${chosen.length === 1 ? "" : "s"} to this project.`; renderPane(); }
}

function mergeSegments(segs, tol){
  const out = segs.map(s => ({...s}));
  let changed = true;
  while (changed){
    changed = false;
    outer: for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++){
      const A = out[i], B = out[j]; if (A.typeId !== B.typeId || A.status !== B.status) continue;
      const dx = A.b[0] - A.a[0], dy = A.b[1] - A.a[1], L = Math.hypot(dx, dy); if (L < 1e-6) continue;
      const ux = dx / L, uy = dy / L, ex = B.b[0] - B.a[0], ey = B.b[1] - B.a[1], LB = Math.hypot(ex, ey); if (LB < 1e-6) continue;
      if (Math.abs(ux * ey - uy * ex) / LB > 0.05) continue;                       // not parallel (~3°)
      const perp = q => Math.abs((q[0] - A.a[0]) * -uy + (q[1] - A.a[1]) * ux);
      if (perp(B.a) > tol || perp(B.b) > tol) continue;                            // not collinear
      const proj = q => (q[0] - A.a[0]) * ux + (q[1] - A.a[1]) * uy;
      const ta = [0, L], tb = [proj(B.a), proj(B.b)].sort((a, b) => a - b);
      if (tb[0] > L + tol || tb[1] < -tol) continue;                               // gap between them
      const t0 = Math.min(0, tb[0]), t1 = Math.max(L, tb[1]);
      A.a = [A.a[0] + ux * t0, A.a[1] + uy * t0]; A.b = [A.a[0] - ux * t0 + ux * t1, A.a[1] - uy * t0 + uy * t1];
      A.low = A.low && B.low; out.splice(j, 1); changed = true; break outer;
    }
  }
  return out;
}

async function aiTakeoff(){
  const sh = sheet(), rv = sh?.review; if (!sh || !sampleFn || !rv) return;
  const scope = rv.scope ||= {existing: true, demo: false};
  const chosen = PT().filter(t => (rv.confirmed || []).includes(t.tag));
  const notChosen = new Set(rv.types.filter(t => !(rv.confirmed || []).includes(t.tag)).map(t => t.tag.toUpperCase()));
  if (!chosen.length && !scope.existing && !scope.demo){ cur.aiNote = "Nothing is selected to take off. Tick a wall type or existing walls."; renderPane(); return; }
  cur.ai = "takeoff"; cur.aiCtl = new AbortController(); const signal = cur.aiCtl.signal;
  const want = new Set(chosen.map(t => t.tag.toUpperCase()));
  const allTiles = tilesFor(sh, sh.focus);
  const tagIn = (t, g) => { const cx = g.box.x + g.box.w / 2, cy = g.box.y + g.box.h / 2; return cx >= t.x && cx <= t.x + t.w && cy >= t.y && cy <= t.y + t.h; };
  const relevant = rv.tags.filter(g => want.has(g.tag));
  const tiles = scope.existing || scope.demo || !rv.tags.length ? allTiles : allTiles.filter(t => relevant.some(g => tagIn(t, g)));
  if (!tiles.length){ cur.ai = null; cur.aiNote = "None of the confirmed tags were found, so nothing was taken off."; renderPane(); return; }
  const what = [chosen.length ? "new walls (" + chosen.map(t => t.tag).join(", ") + ")" : "", scope.existing ? "existing walls" : "", scope.demo ? "demolition" : ""].filter(Boolean).join(", ");
  const typesTxt = chosen.length ? chosen.map(t => `${t.tag}: ${t.desc} (height ${t.height} ft)`).join("\n") : "(none: do not return new walls)";
  const statusTxt = [`- "new": new construction (heavy, solid or filled linework per the plan legend, or marked with a wall-type tag). Give the tag of the confirmed type that applies: a tag applies to the wall it marks and to the continuous run of the same construction, around corners, up to where it meets a different type or an existing wall. If a new wall clearly has no tag and no tagged run continues into it, give "type": null.${notChosen.size ? ` Skip new walls of these types, which are out of scope: ${[...notChosen].join(", ")}.` : ""}`,
    scope.existing ? `- "existing": existing walls to remain (marked ETR or existing, thin, grey or screened linework). Trace them too: they may receive paint or other finishes.` : `- Do not return existing walls.`,
    scope.demo ? `- "demo": walls to be demolished (dashed, or marked demo / remove).` : `- Do not return walls to be demolished.`].join("\n");
  let done = 0, failed = 0; const notes = [];
  const say = t => { cur.aiNote = t; renderPane(); };
  say(`Taking off ${what} in ${tiles.length} section${tiles.length === 1 ? "" : "s"}… 0 of ${tiles.length} done.`);
  try {
    const results = await pool(tiles, 2, async t => {
      const here = relevant.filter(g => tagIn(t, g)).map(g => { const n = q => [Math.round((q[0] - t.x) / t.w * 1000), Math.round((q[1] - t.y) / t.h * 1000)]; const a = n([g.box.x, g.box.y]), b = n([g.box.x + g.box.w, g.box.y + g.box.h]); return `${g.tag} at [${a[0]},${a[1]},${b[0]},${b[1]}]`; });
      try {
        return await sampleFn.json(`You are a construction estimator taking off walls from one section of a FLOOR PLAN at full detail (row ${t.r + 1} of ${t.rows}, column ${t.c + 1} of ${t.cols}). Sheet: "${sh.name}".
Confirmed NEW wall types (tag: description):
${typesTxt}
Wall-type tags located in this section (normalized boxes): ${here.join("; ") || "none listed"}
${TAG_GUIDE}
Rules this estimator taught you (follow them):
${lessonText()}
${scaleLine(sh)}

Trace every wall in this section and give each a status:
${statusTxt}
Do not trace casework, fixtures, furniture, ceiling grids, or dimension and leader lines.
Trace each wall along its centerline, with a vertex only at real corners. Run continuously through door openings. Keep horizontal and vertical runs exactly horizontal or vertical. If a wall runs past the edge of this section, trace it to the edge.
List door openings in the walls you traced (two jamb points each).${sh.ppi ? "" : "\nGive one dimension string you can read clearly as scale_ref: the two points its extension lines mark and its length in inches."}
Coordinates are normalized 0-1000 on both axes of THIS section.
Reply with only JSON: {"walls":[{"status":"new|existing|demo","type":"A3" or null,"pts":[[x,y],[x,y]],"confidence":"high|low"}],"doors":[{"pts":[[x,y],[x,y]]}],${sh.ppi ? "" : `"scale_ref":{"pts":[[x,y],[x,y]],"length_in":72} or null,`}"notes":"one sentence or empty"}`, {images: [await cropBlob(sh, t)], modelTier: "complex", signal, cache: false});
      } catch (e){ if (tileFatal(e)) throw e; failed++; return null; }
      finally { done++; if (cur.ai === "takeoff") say(`Taking off ${what} in ${tiles.length} sections… ${done} of ${tiles.length} done.`); }
    });
    checkpoint();
    sh.items = sh.items.filter(i => !(i.src === "claude" && !i.edited && !i.accepted));
    if (!sh.ppi){
      for (let k = 0; k < results.length; k++){ const r = results[k]?.scale_ref; if (!r) continue; const p = (r.pts || []).map(q => fromTile(tiles[k], q)).filter(Boolean), L = +r.length_in;
        if (p.length === 2 && L > 0 && dist(p[0], p[1]) > 4){ sh.ppi = dist(p[0], p[1]) / L; sh.scaleAssumed = L; sh.scaleFrom = `a ${fmtFtIn(L)} dimension string it read`; sh.scaleNote = `from ${fmtFtIn(L)} dim`; break; } }
    }
    const segs = [], doors = []; const skipped = {};
    results.forEach((res, k) => {
      if (!res) return; const t = tiles[k];
      for (const r of (res.walls || res.partitions || [])){
        let status = ["existing", "demo"].includes(r.status) ? r.status : "new", typeId;
        if (status === "existing" && !scope.existing) continue;
        if (status === "demo" && !scope.demo) continue;
        if (status === "new"){
          const tag = String(r.type || "").trim().toUpperCase();
          if (tag){ const ty = chosen.find(x => x.tag.toUpperCase() === tag); if (!ty){ skipped[tag] = (skipped[tag] || 0) + 1; continue; } typeId = ty.id; }
          else if (!chosen.length) continue;
        }
        const p = (r.pts || []).map(q => fromTile(t, q)).filter(Boolean);
        for (let i = 1; i < p.length; i++) if (dist(p[i-1], p[i]) > 1) segs.push({typeId, status, a: p[i-1], b: p[i], low: r.confidence === "low"});
      }
      for (const d of (res.doors || [])){ const p = (d.pts || []).map(q => fromTile(t, q)).filter(Boolean); if (p.length === 2){ const m = [(p[0][0] + p[1][0]) / 2, (p[0][1] + p[1][1]) / 2]; if (!doors.some(o => dist(o.m, m) < dist(p[0], p[1]) * 0.6)) doors.push({p, m}); } }
      if (res.notes) notes.push(String(res.notes));
    });
    const tol = sh.ppi ? sh.ppi * 6 : Math.max(sh.w, sh.h) * 0.004;
    const merged = mergeSegments(segs, tol);
    const cnt = {typed: 0, untyped: 0, existing: 0, demo: 0};
    for (const s of merged){
      const it = {id: uid(), kind: "partition", pts: [s.a, s.b], src: "claude"};
      if (s.status !== "new"){ it.status = s.status; cnt[s.status]++; }
      else if (s.typeId){ it.typeId = s.typeId; cnt.typed++; }
      else { cnt.untyped++; it.note = "New wall with no type tag: assign a type"; }
      if (s.low) it.note = (it.note ? it.note + ". " : "") + "Claude: low confidence";
      sh.items.push(it);
    }
    for (const d of doors) sh.items.push({id: uid(), kind: "opening", pts: d.p, heightIn: 84, src: "claude"});
    const skipTxt = Object.entries(skipped).map(([k, n]) => `${n} ${k}`).join(", ");
    cur.aiNote = `Drafted ${cnt.typed} typed new wall segment${cnt.typed === 1 ? "" : "s"}` + (cnt.untyped ? `, ${cnt.untyped} new without a type (labelled NEW?)` : "") + (scope.existing ? `, ${cnt.existing} existing (ETR)` : "") + (scope.demo ? `, ${cnt.demo} demolition` : "") + `. Dashed lines are Claude's drafts; edit one and it becomes yours and the change is logged.`
      + (failed ? `\n${failed} section${failed === 1 ? "" : "s"} couldn't be read. Run the takeoff again to retry.` : "")
      + (skipTxt ? `\nLeft out new walls of unticked types: ${skipTxt}.` : "")
      + (notes.length ? "\n\nClaude's notes: " + notes.slice(0, 4).join(" ") : "");
    dirty(); renderSheets();
  } catch (e){ cur.aiNote = errCopy(e); }
  cur.ai = null; cur.aiCtl = null; renderPane(); render();
}

function planAiBox(sh){
  const ai = cur.ai, rv = sh.review, ready = sampleFn && canImages && !ai;
  const busy = ai ? `<button class="btn small" id="aiStop">Stop</button>` : "";
  let body = "";
  if (!rv){
    body = `<p class="hint"><b>Step 1.</b> Claude reads the whole sheet in close-up sections, finds every wall-type tag, and reads any wall type legend or details on the sheet. You confirm before anything is measured.</p>
      <div class="row"><button class="btn primary small" id="aiRead" ${ready ? "" : "disabled"}>${ai === "read" ? "Reading…" : "Read this sheet"}</button>${busy}</div>`;
  } else if (rv.status === "pending"){
    body = `<p class="hint"><b>Step 2.</b> Check the wall types Claude found. Ticked types are taken off as new walls with framing and drywall. Tags are circled on the sheet.</p>
      ${rv.types.length ? `<div class="tbl-wrap"><table class="rv"><thead><tr><th></th><th>Tag</th><th>Found</th><th>Height ft</th></tr></thead><tbody>
      ${rv.types.map((t, i) => `<tr><td><input type="checkbox" data-rv-inc="${i}" ${t.include ? "checked" : ""} aria-label="Take off ${esc(t.tag)}"></td><td><span class="swatch" style="background:${TYPE_COLOR_FOR(t.tag)}"></span>${esc(t.tag)}</td><td style="font-family:var(--f-body);text-align:left">${t.nNew} new${t.nEx ? ` · ${t.nEx} existing` : ""}${t.nUnc ? ` · ${t.nUnc} unclear` : ""}</td><td><input data-rv-h="${i}" value="${t.height}" inputmode="decimal" style="width:62px;border:1px solid var(--line);border-radius:3px;padding:2px 4px;background:var(--panel)"></td></tr>
        <tr><td></td><td colspan="3" style="text-align:left;white-space:normal;font-family:var(--f-body)"><input data-rv-d="${i}" value="${esc(t.desc)}" placeholder="Description (no legend found)" style="width:100%;border:1px solid var(--line);border-radius:3px;padding:3px 5px;background:var(--panel)"><span class="hint" style="font-size:11px">${t.source === "legend" ? "Defined in the legend on this sheet" : t.source === "project" ? "Already in this project" : "Tag only: no definition found"} · height from ${t.heightFrom}</span></td></tr>`).join("")}
      </tbody></table></div>` : `<p class="hint">No wall-type tags were found.</p>`}
      ${rv.notes?.length ? `<div class="ai-out">Claude's notes: ${esc(rv.notes.join(" "))}</div>` : ""}
      <div style="display:grid;gap:4px"><span class="flabel">Also take off</span><div class="row" style="gap:12px"><label class="toggle"><input type="checkbox" id="scEx" ${(rv.scope?.existing ?? true) ? "checked" : ""}> Existing walls (ETR), for finishes</label><label class="toggle"><input type="checkbox" id="scDemo" ${rv.scope?.demo ? "checked" : ""}> Demolition</label></div></div>
      <div class="row"><button class="btn primary small" id="rvGo" ${ready && (rv.types.some(t => t.include) || (rv.scope?.existing ?? true) || rv.scope?.demo) ? "" : "disabled"}>${ai === "takeoff" ? "Taking off…" : "Confirm and take off"}</button><button class="btn small" id="aiRead" ${ready ? "" : "disabled"}>${ai === "read" ? "Reading…" : "Read again"}</button>${busy}</div>`;
  } else {
    body = `<p class="hint">New wall types: <b>${esc((rv.confirmed || []).join(", ") || "none")}</b>. Untagged new walls are drafted as NEW? for you to assign.</p>
      <div style="display:grid;gap:4px"><span class="flabel">Also take off</span><div class="row" style="gap:12px"><label class="toggle"><input type="checkbox" id="scEx" ${(rv.scope?.existing ?? true) ? "checked" : ""}> Existing walls (ETR), for finishes</label><label class="toggle"><input type="checkbox" id="scDemo" ${rv.scope?.demo ? "checked" : ""}> Demolition</label></div></div>

      <div class="row"><button class="btn primary small" id="rvGo" ${ready ? "" : "disabled"}>${ai === "takeoff" ? "Taking off…" : "Take off again"}</button><button class="btn small" id="rvEdit" ${ai ? "disabled" : ""}>Change types</button><button class="btn small ghost" id="aiRead" ${ready ? "" : "disabled"}>${ai === "read" ? "Reading…" : "Read sheet again"}</button>${busy}</div>`;
  }
  return `<div class="ai-box"><h3>Take off partitions with Claude</h3>${body}
    ${rv ? `<label class="toggle"><input type="checkbox" id="rvShow" ${rv.showTags !== false ? "checked" : ""}> Circle tags on the sheet</label>` : ""}
    <details><summary class="hint" style="cursor:pointer">Limit to part of the sheet (optional)</summary><div class="row" style="align-items:center;margin-top:6px"><span class="badge">${sh.focus ? "Area set" : "Whole sheet"}</span><button class="btn small" id="goFocus">${sh.focus ? "Redraw area" : "Draw area"}</button>${sh.focus ? `<button class="btn small ghost" id="clrFocus">Clear</button>` : ""}</div></details>
    ${!sampleFn || !canImages ? `<p class="hint">${first.aiConnected ? "Only estimators can ask Claude to draft. You can look and measure." : "AI is not connected on the server yet, so Claude can't draft. You can still take off by hand."}</p>` : ""}
    ${cur.aiNote ? `<div class="ai-out" id="aiOut">${esc(cur.aiNote)}</div>` : ""}
    <p class="hint">${scaleLine(sh) ? "Scale is set, so Claude won't look for one." : "No scale yet: set one first for the most reliable lengths."} Follows ${activeLessons().length} rule${activeLessons().length === 1 ? "" : "s"}.</p>
  </div>`;
}
function wireReview(sh){
  const on = (id, ev, fn) => { const el = byId(id); if (el) el.addEventListener(ev, fn); };
  on("aiRead", "click", () => aiReadSheet());
  on("rvGo", "click", () => sh.review?.status === "pending" ? confirmReview() : aiTakeoff());
  on("rvEdit", "click", () => { sh.review.status = "pending"; sh.review.types.forEach(t => t.include = (sh.review.confirmed || []).includes(t.tag)); dirty(); renderPane(); });
  on("scEx", "change", e => { (sh.review.scope ||= {existing: true, demo: false}).existing = e.target.checked; dirty(); renderPane(); });
  on("scDemo", "change", e => { (sh.review.scope ||= {existing: true, demo: false}).demo = e.target.checked; dirty(); renderPane(); });
  on("rvShow", "change", e => { sh.review.showTags = e.target.checked; dirty(); render(); });
  root.querySelectorAll("[data-rv-inc]").forEach(el => el.onchange = () => { sh.review.types[+el.dataset.rvInc].include = el.checked; dirty(); renderPane(); render(); });
  root.querySelectorAll("[data-rv-h]").forEach(el => el.onchange = () => { const v = parseFloat(el.value); if (v > 0){ const t = sh.review.types[+el.dataset.rvH]; t.height = v; t.heightFrom = "you"; } dirty(); renderPane(); });
  root.querySelectorAll("[data-rv-d]").forEach(el => el.onchange = () => { sh.review.types[+el.dataset.rvD].desc = el.value; dirty(); });
}
function drawTags(sh, k){
  const rv = sh.review; if (!rv || rv.showTags === false || !rv.tags?.length) return;
  const inc = new Set(rv.status === "confirmed" ? (rv.confirmed || []) : rv.types.filter(t => t.include).map(t => t.tag));
  ctx.save();
  for (const g of rv.tags){
    const on = inc.has(g.tag) && g.wall !== "existing", pad = 8 * k;
    ctx.strokeStyle = on ? TYPE_COLOR_FOR(g.tag) : "#868e96"; ctx.lineWidth = (on ? 3 : 1.5) * k; ctx.setLineDash(on ? [] : [5*k, 4*k]);
    ctx.beginPath(); ctx.ellipse(g.box.x + g.box.w / 2, g.box.y + g.box.h / 2, g.box.w / 2 + pad, g.box.h / 2 + pad, 0, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();
}

async function aiDetails(){
  const file = $("#detImg")?.files?.[0], txt = $("#detTxt")?.value.trim();
  if (!file && !txt){ cur.detNote = "Choose a picture or paste schedule text first."; renderPane(); return; }
  cur.ai = "details"; cur.detNote = "Reading partition details…"; renderPane();
  try {
    const prompt = `You are reading a construction PARTITION SCHEDULE or wall-type details${file ? " (image attached)" : ""}.
${txt ? "Text provided by the estimator:\n" + txt + "\n" : ""}
Existing types (tag: description): ${PT().map(t => t.tag + ": " + t.desc).join(" | ")}
For each partition type found, return its fields. Height in feet (use the "to deck" or listed height; if unclear guess 10). stud = stud depth in inches. spacing = on-center inches. sides = number of faces receiving board (1 or 2). layers = board layers per face. insul = true if batt or sound insulation.
Reply with only JSON: [{"tag":"A","desc":"short full description","height":10,"stud":3.625,"spacing":16,"sides":2,"layers":1,"insul":false}]`;
    const res = await sampleFn.json(prompt, {images: file ? [file] : undefined, modelTier: "default", cache: false});
    let n = 0, u = 0;
    for (const r of (Array.isArray(res) ? res : [])){
      const tag = String(r.tag || "").trim(); if (!tag) continue;
      const f = {tag, desc: String(r.desc || tag), height: +r.height || 10, stud: +r.stud || 3.625, spacing: +r.spacing || 16, sides: +r.sides || 2, layers: +r.layers || 1, insul: !!r.insul};
      const ex = PT().find(t => t.tag.toUpperCase() === tag.toUpperCase());
      if (ex){ Object.assign(ex, f); u++; } else { PT().push({id: "t" + uid(), waste: 10, color: TYPE_COLORS[PT().length % TYPE_COLORS.length], ...f}); n++; }
    }
    cur.detNote = `Added ${n} and updated ${u} partition type${n + u === 1 ? "" : "s"}. Check the heights and layers above.`;
    libDirty();
  } catch (e){ cur.detNote = errCopy(e); }
  cur.ai = null; renderPane();
}
async function aiDistill(){
  cur.ai = "distill"; cur.learnNote = "Reading your corrections…"; renderPane();
  try {
    const corr = (project.corrections || []).slice(-120).map(c => `- [${c.sheet || ""}] ${c.msg}`).join("\n");
    const prompt = `You help an estimator's AI takeoff assistant improve. Below are the corrections the estimator made to the assistant's drafted takeoff, plus the rules it already follows.
Partition types: ${PT().map(t => t.tag + " = " + t.desc).join("; ")}
Existing rules:
${lessonText()}
Corrections:
${corr}
Write up to 5 NEW short, specific, actionable rules (one sentence each) that would have prevented these corrections next time. Don't repeat existing rules. Skip one-off corrections that don't generalize. Prefer rules about how to recognize the right walls (tag shapes, new vs existing linework, what to exclude) over rules that name this project's type tags.
Reply with only a JSON array of strings.`;
    const res = await sampleFn.json(prompt, {modelTier: "default", cache: false});
    const rules = (Array.isArray(res) ? res : []).map(String).map(s => s.trim()).filter(Boolean).slice(0, 5);
    await addLessons(rules, "claude", "project");
    cur.learnNote = rules.length ? `Added ${rules.length} rule${rules.length === 1 ? "" : "s"}. Claude follows them on its next draft.` : "No new general rules came out of these corrections.";
  } catch (e){ cur.learnNote = errCopy(e); }
  cur.ai = null; renderPane();
}
/* ================= Claude, through the platform (server/takeoffStudio.js → streamClaude) ================= */
const blobB64 = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = () => rej(r.error); r.readAsDataURL(b); });
function parseJsonReply(t){
  const s = String(t || "").trim();
  try { return JSON.parse(s); } catch {}
  const f = s.match(/```(?:json)?\s*([\s\S]*?)```/); if (f){ try { return JSON.parse(f[1]); } catch {} }
  const starts = ["{", "["].map(c => s.indexOf(c)).filter(i => i >= 0), a = starts.length ? Math.min(...starts) : -1, b = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
  if (a >= 0 && b > a){ try { return JSON.parse(s.slice(a, b + 1)); } catch {} }
  const e = new Error("Claude's reply couldn't be read as a takeoff. Try again."); e.code = "invalid_json"; e.text = s; throw e;
}
// One question to Claude: text, pictures of sheets, and the page's own tools (Claude asks for them; they run here and the answers go back).
async function askClaude(input, opts = {}){
  const turns = typeof input === "string" ? [{role: "user", content: input}] : input.map(m => ({role: m.role, content: m.content}));
  const pics = opts.images ? (Array.isArray(opts.images) ? opts.images : [opts.images]) : [];
  if (pics.length){
    const last = turns[turns.length - 1], blocks = [];
    for (const b of pics) blocks.push({type: "image", source: {type: "base64", media_type: ["image/png", "image/jpeg", "image/webp"].includes(b.type) ? b.type : "image/png", data: await blobB64(b)}});
    last.content = [...blocks, {type: "text", text: String(last.content)}];
  }
  const tools = opts.tools || [], defs = tools.map(t => ({name: t.name, description: t.description, input_schema: t.inputSchema || {type: "object", properties: {}}}));
  let messages = turns, text = "";
  for (let round = 0; round < 8; round++){
    const r = await api("POST", `/opportunities/${leadId}/takeoff-studio/ask`, {messages, tools: defs, tier: opts.modelTier || "default"}, opts.signal);
    text = (r.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    if (opts.onText && text) opts.onText({text, delta: text});
    const calls = (r.content || []).filter(b => b.type === "tool_use");
    if (r.stopReason !== "tool_use" || !calls.length) return {text, truncated: r.stopReason === "max_tokens"};
    const results = [];
    for (const c of calls){
      const t = tools.find(x => x.name === c.name);
      try { if (!t) throw new Error("No such tool."); const out = await t.execute(c.input || {}); results.push({type: "tool_result", tool_use_id: c.id, content: typeof out === "string" ? out : JSON.stringify(out ?? "")}); }
      catch (e){ results.push({type: "tool_result", tool_use_id: c.id, content: String(e?.message || e), is_error: true}); }
    }
    messages = [...messages, {role: "assistant", content: r.content}, {role: "user", content: results}];
  }
  return {text, truncated: false};
}
askClaude.json = async (input, opts = {}) => parseJsonReply((await askClaude(input, opts)).text);

/* ================= rules Claude follows (stored on the server) ================= */
async function reloadRules(){ try { lessons = mapRules((await api("GET", `/opportunities/${leadId}/takeoff-studio/rules`)).rules); } catch (e){ setStatus(e.message, "bad"); } renderPane(); }
async function setLessonScope(id, scope){
  try { await api("PUT", `/opportunities/${leadId}/takeoff-studio/rules/${id}`, {scope}); } catch (e){ setStatus("Couldn't change the rule: " + e.message, "bad"); }
  await reloadRules();
}
async function addLessons(texts, source, scope = "global"){
  for (const text of texts){ try { await api("POST", `/opportunities/${leadId}/takeoff-studio/rules`, {text, source, scope}); } catch (e){ setStatus("Rule not saved: " + e.message, "bad"); } }
  await reloadRules();
}
async function removeLesson(id){
  try { await api("DELETE", `/opportunities/${leadId}/takeoff-studio/rules/${id}`); } catch (e){ setStatus("Couldn't remove the rule: " + e.message, "bad"); }
  await reloadRules();
}

/* ================= plan set: sheet roles ================= */
const ROLES = [
  ["plan", "Floor plan", "PLAN"], ["walltypes", "Wall types", "TYPES"], ["finishes", "Finish schedule", "FINISH"],
  ["elevation", "Elevations", "ELEV"], ["rcp", "Reflected ceiling plan", "RCP"], ["other", "Other (skip)", "OTHER"]];
const roleShort = k => (ROLES.find(r => r[0] === k) || ROLES[0])[2];
function guessKind(name){
  const n = name || "";
  if (/\brcp\b|ceiling/i.test(n)) return "rcp";
  if (/finish|schedule/i.test(n)) return "finishes";
  if (/wall ?type|partition ?type|partition ?detail/i.test(n)) return "walltypes";
  if (/elev|interior/i.test(n)) return "elevation";
  return "plan";
}
const PC = () => (project.callouts ||= clone(lib.callouts));
const calloutByCode = code => PC().find(c => c.code.toUpperCase() === String(code || "").toUpperCase());

async function aiClassify(ids){
  if (!sampleFn || !canImages || cur.ai) return;
  const list = project.sheets.filter(s => ids.includes(s.id)); if (!list.length) return;
  cur.ai = "sort"; cur.aiCtl = new AbortController(); const signal = cur.aiCtl.signal; let done = 0;
  setStatus(`Claude is sorting ${list.length} sheet${list.length === 1 ? "" : "s"}…`);
  try {
    await pool(list, 2, async sh => {
      try {
        const r = await sampleFn.json(`You are sorting the pages of a construction drawing set for an interior framing, drywall and finishes estimator. Look at this whole page and say what it is.
Roles:
- plan: floor plan, partition plan or finish plan that shows walls and rooms
- walltypes: wall type or partition type legend, schedule or details
- finishes: finish schedule, finish legend or room finish schedule
- elevation: interior elevations
- rcp: reflected ceiling plan
- other: cover, general notes, site, structural, MEP, door schedules or anything else
If the page holds several of these, pick the one that matters most for the takeoff and list the others in "also".
Read the sheet number and title from the title block.
Reply with only JSON: {"role":"plan","also":[],"sheet_number":"A1.01","title":"FLOOR PLAN"}`, {images: [await classifyBlob(sh)], modelTier: "default", signal, cache: false});
        if (ROLES.some(x => x[0] === r.role)) sh.kind = r.role;
        sh.also = (Array.isArray(r.also) ? r.also : []).filter(a => ROLES.some(x => x[0] === a) && a !== sh.kind);
        const nm = [r.sheet_number, r.title].filter(Boolean).join(" ").trim(); if (nm) sh.name = nm.slice(0, 60);
        sh.sorted = true;
      } catch (e){ if (tileFatal(e)) throw e; }
      finally { done++; setStatus(`Claude is sorting sheets… ${done} of ${list.length}`); renderSheets(); }
    });
    const order = Object.fromEntries(ROLES.map((r, i) => [r[0], i]));
    project.sheets.sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9));
    setStatus("Sheets sorted. Check the roles on the left.", "ok"); dirty();
  } catch (e){ setStatus(errCopy(e), "bad"); }
  cur.ai = null; cur.aiCtl = null; renderAll();
}

/* ================= wall types sheet ================= */
async function aiReadTypes(){
  const sh = sheet(); if (!sh || !sampleFn) return;
  cur.ai = "types"; cur.aiCtl = new AbortController(); const signal = cur.aiCtl.signal;
  const tiles = tilesFor(sh, sh.focus); let done = 0, failed = 0;
  const say = t => { cur.aiNote = t; renderPane(); };
  say(`Reading wall types in ${tiles.length} section${tiles.length === 1 ? "" : "s"}…`);
  try {
    const results = await pool(tiles, 2, async t => {
      try {
        return await sampleFn.json(`You are reading one section of a construction WALL TYPE / PARTITION TYPE sheet at full detail (row ${t.r + 1} of ${t.rows}, column ${t.c + 1} of ${t.cols}).
Transcribe every wall type defined in this section: its tag exactly as printed, a full description (studs, gauge, spacing, gypsum board layers per side, insulation, fire or sound rating), the height (to deck, to ceiling plus a distance, or a dimension), stud depth in inches, stud spacing in inches, number of faces that get board (1 or 2), layers per face, and whether it is insulated. If a type is cut off at the edge, return what is readable.
Reply with only JSON: {"legend":[{"tag":"A3","desc":"...","height_ft":12 or null,"height_note":"to deck" or null,"stud_in":3.625,"spacing_in":16,"faces":2,"layers":1,"insulated":false}]}`, {images: [await cropBlob(sh, t)], modelTier: "complex", signal, cache: false});
      } catch (e){ if (tileFatal(e)) throw e; failed++; return null; }
      finally { done++; if (cur.ai === "types") say(`Reading wall types… ${done} of ${tiles.length} sections done.`); }
    });
    const legend = {};
    for (const res of results) for (const L of (res?.legend || [])){
      const tag = String(L.tag || "").trim().toUpperCase(); if (!tag) continue;
      if (!legend[tag] || String(L.desc || "").length > String(legend[tag].desc || "").length) legend[tag] = L;
    }
    const types = Object.keys(legend).sort().map(tag => {
      const L = legend[tag], ex = PT().find(t => t.tag.toUpperCase() === tag);
      return {tag, desc: String(L.desc || "") + (L.height_note && !L.height_ft ? ` (${L.height_note})` : ""), height: +L.height_ft || ex?.height || 10, heightFrom: L.height_ft ? "legend" : "default",
        stud: +L.stud_in || 3.625, spacing: +L.spacing_in || 16, sides: +L.faces || 2, layers: +L.layers || 1, insul: !!L.insulated, source: "legend", nNew: 0, nEx: 0, nUnc: 0, include: true};
    });
    sh.review = {status: "pending", mode: "types", at: Date.now(), types, tags: [], notes: [], failed};
    cur.aiNote = types.length ? `Read ${types.length} wall type${types.length === 1 ? "" : "s"}. Check heights and descriptions, then add them to the project.` + (failed ? ` ${failed} section${failed === 1 ? "" : "s"} couldn't be read.` : "") : "No wall types found on this sheet. Check the sheet role.";
    dirty();
  } catch (e){ cur.aiNote = errCopy(e); }
  cur.ai = null; cur.aiCtl = null; renderPane();
}
function reviewTable(rv){
  return `<div class="tbl-wrap"><table><thead><tr><th></th><th>Tag</th><th>${rv.mode === "types" ? "Build-up" : "Found"}</th><th>Height ft</th></tr></thead><tbody>
  ${rv.types.map((t, i) => `<tr><td><input type="checkbox" data-rv-inc="${i}" ${t.include ? "checked" : ""} aria-label="Use ${esc(t.tag)}"></td><td><span class="swatch" style="background:${TYPE_COLOR_FOR(t.tag)}"></span>${esc(t.tag)}</td><td style="font-family:var(--f-body);text-align:left">${rv.mode === "types" ? `${t.sides} face${t.sides === 1 ? "" : "s"} · ${t.layers} layer${t.layers === 1 ? "" : "s"}${t.insul ? " · insul." : ""}` : `${t.nNew} new${t.nEx ? ` · ${t.nEx} existing` : ""}${t.nUnc ? ` · ${t.nUnc} unclear` : ""}`}</td><td><input data-rv-h="${i}" value="${t.height}" inputmode="decimal" style="width:62px;border:1px solid var(--line);border-radius:3px;padding:2px 4px;background:var(--panel)"></td></tr>
    <tr><td></td><td colspan="3" style="text-align:left;white-space:normal;font-family:var(--f-body)"><input data-rv-d="${i}" value="${esc(t.desc)}" placeholder="Description" style="width:100%;border:1px solid var(--line);border-radius:3px;padding:3px 5px;background:var(--panel)"><span class="hint" style="font-size:11px">${t.source === "legend" ? "Defined on " + (rv.mode === "types" ? "this sheet" : "this sheet's legend") : t.source === "project" ? "Defined on your wall types sheet" : "Tag only: no definition found"} · height from ${t.heightFrom}</span></td></tr>`).join("")}
  </tbody></table></div>`;
}
function typesSheetBox(sh){
  const ai = cur.ai, rv = sh.review?.mode === "types" ? sh.review : null, ready = sampleFn && canImages && !ai;
  const busy = ai ? `<button class="btn small" id="aiStop">Stop</button>` : "";
  return `<div class="ai-box"><h3>Wall types on this sheet</h3>
    ${!rv ? `<p class="hint">Claude reads every wall type here (tag, build-up, height) so floor plans in this set can be taken off against them.</p>
      <div class="row"><button class="btn primary small" id="aiTypes" ${ready ? "" : "disabled"}>${ai === "types" ? "Reading…" : "Read wall types"}</button>${busy}</div>`
    : rv.status === "pending" ? `<p class="hint">Untick any types that aren't in your scope. Fix heights if the legend says "to deck".</p>${rv.types.length ? reviewTable(rv) : ""}
      <div class="row"><button class="btn primary small" id="typesOk" ${ai || !rv.types.some(t => t.include) ? "disabled" : ""}>Add to project</button><button class="btn small" id="aiTypes" ${ready ? "" : "disabled"}>${ai === "types" ? "Reading…" : "Read again"}</button>${busy}</div>`
    : `<p class="hint">Added to this project: <b>${esc((rv.confirmed || []).join(", "))}</b>. Floor plans in this set now use these definitions.</p>
      <div class="row"><button class="btn small" id="rvEdit">Change</button><button class="btn small ghost" id="aiTypes" ${ready ? "" : "disabled"}>Read again</button>${busy}</div>`}
    ${cur.aiNote ? `<div class="ai-out">${esc(cur.aiNote)}</div>` : ""}
  </div>`;
}

/* ================= finish schedule ================= */
const APPLIES_UNIT = {wall: "SF", ceiling: "SF", floor: "SF", base: "LF", other: "EA"};
async function aiReadFinishes(){
  const sh = sheet(); if (!sh || !sampleFn) return;
  cur.ai = "finishes"; cur.aiCtl = new AbortController(); const signal = cur.aiCtl.signal;
  const tiles = tilesFor(sh, sh.focus); let done = 0, failed = 0;
  const say = t => { cur.aiNote = t; renderPane(); };
  say(`Reading the finish schedule in ${tiles.length} section${tiles.length === 1 ? "" : "s"}…`);
  try {
    const results = await pool(tiles, 2, async t => {
      try {
        return await sampleFn.json(`You are reading one section of a construction FINISH SCHEDULE / FINISH LEGEND sheet at full detail (row ${t.r + 1} of ${t.rows}, column ${t.c + 1} of ${t.cols}).
1. Finish materials (legend or key): each code exactly as printed (like PT-1, WC-2, ACT-1, CPT-1, LVT-1, RB-1, CT-1) with its description or product, and where it goes: wall, ceiling, floor, base, or other.
2. Room finish schedule rows: room number, room name, floor code, base code, wall finish codes (a list; if there are North/East/South/West columns list them in that order), ceiling code, ceiling height as printed, and notes.
If a table is cut off at the edge of this section, return the rows that are readable.
Reply with only JSON: {"materials":[{"code":"PT-1","desc":"Paint, eggshell","applies":"wall|ceiling|floor|base|other"}],"rooms":[{"number":"101","name":"OFFICE","floor":"CPT-1","base":"RB-1","walls":["PT-1"],"ceiling":"ACT-1","ceiling_height":"9'-0\\"","notes":""}]}`, {images: [await cropBlob(sh, t)], modelTier: "complex", signal, cache: false});
      } catch (e){ if (tileFatal(e)) throw e; failed++; return null; }
      finally { done++; if (cur.ai === "finishes") say(`Reading the finish schedule… ${done} of ${tiles.length} sections done.`); }
    });
    const mats = {}, rooms = {};
    for (const res of results){
      for (const m of (res?.materials || [])){ const code = String(m.code || "").trim().toUpperCase(); if (!code) continue; const applies = APPLIES_UNIT[m.applies] ? m.applies : "other";
        if (!mats[code] || String(m.desc || "").length > mats[code].desc.length) mats[code] = {code, desc: String(m.desc || ""), applies}; }
      for (const r of (res?.rooms || [])){ const num = String(r.number || "").trim(); if (!num) continue; const o = rooms[num] ||= {number: num};
        for (const k of ["name", "floor", "base", "ceiling", "notes"]) if (r[k] && !o[k]) o[k] = String(r[k]);
        if (Array.isArray(r.walls) && r.walls.length && !o.walls) o.walls = r.walls.map(String).filter(Boolean);
        const h = parseLen(r.ceiling_height); if (isFinite(h) && h > 0 && !o.ceilingHt) o.ceilingHt = +(h / 12).toFixed(2); }
    }
    // codes used in rooms but missing from legend
    for (const r of Object.values(rooms)){
      const add = (c, applies) => { const code = String(c || "").toUpperCase(); if (code && !mats[code] && /^[A-Z]{1,5}-?\d/.test(code)) mats[code] = {code, desc: "", applies}; };
      add(r.floor, "floor"); add(r.base, "base"); add(r.ceiling, "ceiling"); (r.walls || []).forEach(w => add(w, "wall"));
    }
    sh.schedule = {status: "pending", materials: Object.values(mats).sort((a, b) => a.code.localeCompare(b.code)), rooms: Object.values(rooms).sort((a, b) => a.number.localeCompare(b.number, undefined, {numeric: true})), failed};
    cur.aiNote = `Read ${sh.schedule.materials.length} finish material${sh.schedule.materials.length === 1 ? "" : "s"} and ${sh.schedule.rooms.length} room${sh.schedule.rooms.length === 1 ? "" : "s"}.` + (failed ? ` ${failed} section${failed === 1 ? "" : "s"} couldn't be read.` : "");
    dirty();
  } catch (e){ cur.aiNote = errCopy(e); }
  cur.ai = null; cur.aiCtl = null; renderPane();
}
function confirmSchedule(){
  const sh = sheet(), S = sh.schedule; if (!S) return;
  const fs = project.finishSchedule ||= {materials: [], rooms: []};
  for (const m of S.materials){
    const i = fs.materials.findIndex(x => x.code === m.code); if (i >= 0) fs.materials[i] = m; else fs.materials.push(m);
    const unit = APPLIES_UNIT[m.applies] || "SF"; const c = calloutByCode(m.code);
    if (c){ if (m.desc) c.name = m.desc; c.applies = m.applies; }
    else PC().push({id: "c" + uid(), code: m.code, name: m.desc || m.code, unit, applies: m.applies, color: TYPE_COLORS[PC().length % TYPE_COLORS.length]});
  }
  for (const r of S.rooms){ const i = fs.rooms.findIndex(x => x.number === r.number); if (i >= 0) fs.rooms[i] = {...fs.rooms[i], ...r}; else fs.rooms.push(r); }
  S.status = "confirmed"; applyScheduleToRooms();
  logCorrection(`Confirmed finish schedule: ${S.materials.length} materials, ${S.rooms.length} rooms`);
  dirty(); renderPane(); renderChips();
}
function applyScheduleToRooms(){
  const fs = project.finishSchedule; if (!fs) return 0; let n = 0;
  for (const sh of project.sheets) for (const it of sh.items){
    if (it.kind !== "room" || !it.number) continue;
    const r = fs.rooms.find(x => x.number === it.number); if (!r) continue;
    it.finish ||= {};
    if (!it.finish.floor && r.floor) it.finish.floor = r.floor;
    if (!it.finish.base && r.base) it.finish.base = r.base;
    if (!(it.finish.walls?.length) && r.walls?.length) it.finish.walls = [...r.walls];
    if (!it.finish.ceiling && r.ceiling) it.finish.ceiling = r.ceiling;
    if (!it.ceilingHt && r.ceilingHt){ it.ceilingHt = r.ceilingHt; it.ceilingFrom = "finish schedule"; }
    if (!it.name && r.name) it.name = r.name;
    n++;
  }
  return n;
}
function finishBox(sh){
  const ai = cur.ai, S = sh.schedule, ready = sampleFn && canImages && !ai;
  const busy = ai ? `<button class="btn small" id="aiStop">Stop</button>` : "";
  const cell = s => esc(s || "—");
  return `<div class="ai-box"><h3>Finish schedule</h3>
    ${!S ? `<p class="hint">Claude reads the finish legend and the room finish schedule: floor, base, walls, ceiling and ceiling height per room. Rooms you find on the floor plan pick these up by room number.</p>
      <div class="row"><button class="btn primary small" id="aiFinish" ${ready ? "" : "disabled"}>${ai === "finishes" ? "Reading…" : "Read finish schedule"}</button>${busy}</div>`
    : `${S.materials.length ? `<div class="tbl-wrap"><table><thead><tr><th>Code</th><th>Description</th><th>Goes on</th></tr></thead><tbody>${S.materials.map((m, i) => `<tr><td>${esc(m.code)}</td><td style="text-align:left;white-space:normal;font-family:var(--f-body)">${cell(m.desc)}</td><td><select data-mat-app="${i}" ${S.status === "confirmed" ? "disabled" : ""}>${Object.keys(APPLIES_UNIT).map(a => `<option ${a === m.applies ? "selected" : ""}>${a}</option>`).join("")}</select></td></tr>`).join("")}</tbody></table></div>` : ""}
      ${S.rooms.length ? `<div class="tbl-wrap"><table><thead><tr><th>Room</th><th>Floor</th><th>Base</th><th>Walls</th><th>Clg</th><th>Ht</th></tr></thead><tbody>${S.rooms.map(r => `<tr><td>${esc(r.number)} <span style="font-family:var(--f-body)">${esc(r.name || "")}</span></td><td>${cell(r.floor)}</td><td>${cell(r.base)}</td><td>${cell((r.walls || []).join("/"))}</td><td>${cell(r.ceiling)}</td><td>${r.ceilingHt ? r.ceilingHt + "'" : "—"}</td></tr>`).join("")}</tbody></table></div>` : ""}
      <div class="row">${S.status === "pending" ? `<button class="btn primary small" id="finOk" ${ai ? "disabled" : ""}>Use this schedule</button>` : `<span class="badge you">In use for this project</span>`}<button class="btn small" id="aiFinish" ${ready ? "" : "disabled"}>${ai === "finishes" ? "Reading…" : "Read again"}</button>${busy}</div>`}
    ${cur.aiNote ? `<div class="ai-out">${esc(cur.aiNote)}</div>` : ""}
  </div>`;
}

/* ================= rooms ================= */
function roomHt(it){
  if (it.ceilingHt) return {ht: it.ceilingHt, from: it.ceilingFrom || "you"};
  const r = project.finishSchedule?.rooms.find(x => x.number === it.number);
  if (r?.ceilingHt) return {ht: r.ceilingHt, from: "finish schedule"};
  return {ht: project.defaultCeilingHt || 9, from: "project default"};
}
function roomQty(it, sh){
  const ppi = sh.ppi; if (!ppi || it.pts.length < 3) return null;
  const area = polyArea(it.pts) / (ppi * ppi) / 144, perim = polyLen(it.pts, true) / ppi / 12;
  const {ht, from} = roomHt(it);
  let openW = 0, openSf = 0; const tol = ppi * 18;
  for (const op of sh.items){
    if (op.kind !== "opening") continue;
    const m = [(op.pts[0][0] + op.pts[1][0]) / 2, (op.pts[0][1] + op.pts[1][1]) / 2]; let d = Infinity;
    for (let i = 0; i < it.pts.length; i++) d = Math.min(d, nearestOnSeg(m, it.pts[i], it.pts[(i + 1) % it.pts.length]).d);
    if (d < tol){ const w = dist(op.pts[0], op.pts[1]) / ppi; openW += w; openSf += w * (op.heightIn || 84) / 144; }
  }
  const wallGross = perim * ht, wallNet = Math.max(0, wallGross - (project.deductOpenings ? openSf : 0));
  const split = perimSplit(it, sh);
  const finFrac = split ? 1 - split.none - split.demo : 1;
  return {area, perim, ht, htFrom: from, wallNet, wallSf: wallNet * finFrac, split, baseLf: Math.max(0, perim - openW / 12), openings: openW > 0 ? Math.round(openSf / 21) : 0};
}
function perimSplit(it, sh){
  const walls = sh.items.filter(w => w.kind === "partition"); if (!walls.length || !sh.ppi) return null;
  const tol = sh.ppi * 12, step = sh.ppi * 12, acc = {new: 0, existing: 0, demo: 0, none: 0, untraced: 0}; let tot = 0;
  for (let i = 0; i < it.pts.length; i++){
    const a = it.pts[i], b = it.pts[(i + 1) % it.pts.length], L = dist(a, b); if (L < 1) continue;
    const n = Math.min(200, Math.max(2, Math.ceil(L / step)));
    for (let j = 0; j < n; j++){
      const t = (j + 0.5) / n, p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      let best = null, bd = tol;
      for (const w of walls) for (let k = 1; k < w.pts.length; k++){ const d = nearestOnSeg(p, w.pts[k-1], w.pts[k]).d; if (d < bd){ bd = d; best = w; } }
      const key = !best ? "untraced" : wStat(best) === "demo" ? "demo" : best.noFinish ? "none" : wStat(best);
      acc[key] += L / n; tot += L / n;
    }
  }
  if (!tot) return null;
  for (const k in acc) acc[k] /= tot;
  return acc;
}
async function aiFindRooms(){
  const sh = sheet(); if (!sh || !sampleFn) return;
  const rcp = sh.kind === "rcp";
  cur.ai = "rooms"; cur.aiCtl = new AbortController(); const signal = cur.aiCtl.signal;
  const tiles = tilesFor(sh, sh.focus); let done = 0, failed = 0;
  const say = t => { cur.aiNote = t; renderPane(); };
  say(`Step 1 of 2: finding room tags in ${tiles.length} section${tiles.length === 1 ? "" : "s"}…`);
  try {
    const results = await pool(tiles, 2, async t => {
      try {
        return await sampleFn.json(`You are reading one section of a construction ${rcp ? "REFLECTED CEILING PLAN" : "FLOOR PLAN"} at full detail (row ${t.r + 1} of ${t.rows}, column ${t.c + 1} of ${t.cols}). Sheet: "${sh.name}".
Find every room tag (room name and number, usually in a box or oval inside the room). For each, give the number, name, the position of the tag, and a point near the middle of the room's floor area.${rcp ? `
Also read that room's ceiling: the ceiling height as printed (for example 9'-0" AFF, +9'-0", or CLG 9'-0") and the ceiling type or finish code (ACT-1, GWB, open to structure).` : ""}
Rules this estimator taught you (follow them):
${lessonText()}
Coordinates are normalized 0-1000 on both axes of THIS section.
Reply with only JSON: {"rooms":[{"number":"101","name":"OFFICE","tag":[x,y],"center":[x,y]${rcp ? `,"ceiling_height":"9'-0\\"","ceiling":"ACT-1"` : ""}}]}`, {images: [await cropBlob(sh, t)], modelTier: "complex", signal, cache: false});
      } catch (e){ if (tileFatal(e)) throw e; failed++; return null; }
      finally { done++; if (cur.ai === "rooms") say(`Step 1 of 2: finding room tags… ${done} of ${tiles.length} sections done.`); }
    });
    const found = {};
    results.forEach((res, k) => { for (const r of (res?.rooms || [])){
      const num = String(r.number || "").trim(), name = String(r.name || "").trim(); const key = num || name; if (!key) continue;
      const c = fromTile(tiles[k], r.center) || fromTile(tiles[k], r.tag); if (!c) continue;
      const o = found[key] ||= {number: num, name, center: c}; if (!o.name && name) o.name = name;
      const h = parseLen(r.ceiling_height); if (isFinite(h) && h > 0) o.ceilingHt = +(h / 12).toFixed(2);
      if (r.ceiling && !o.ceiling) o.ceiling = String(r.ceiling);
    } });
    const allRooms = project.sheets.flatMap(s => s.items.filter(i => i.kind === "room").map(i => ({it: i, sh: s})));
    let updated = 0; const toTrace = [];
    for (const r of Object.values(found)){
      const ex = r.number && allRooms.find(x => x.it.number === r.number && (rcp ? true : x.sh === sh && (x.it.src !== "claude" || x.it.edited)));
      if (rcp && ex){
        if (r.ceilingHt && ex.it.ceilingFrom !== "you"){ ex.it.ceilingHt = r.ceilingHt; ex.it.ceilingFrom = "RCP"; }
        if (r.ceiling){ ex.it.finish ||= {}; if (!ex.it.finish.ceiling) ex.it.finish.ceiling = r.ceiling; }
        updated++;
      } else if (!ex) toTrace.push(r);
    }
    checkpoint();
    sh.items = sh.items.filter(i => !(i.kind === "room" && i.src === "claude" && !i.edited && !i.accepted && toTrace.some(r => r.number === i.number || !i.number)));
    let added = 0;
    if (toTrace.length){
      const area = sh.focus || {x: 0, y: 0, w: sh.w, h: sh.h};
      const nrm = p => [Math.round((p[0] - area.x) / area.w * 1000), Math.round((p[1] - area.y) / area.h * 1000)];
      for (let i = 0; i < toTrace.length; i += 40){
        const chunk = toTrace.slice(i, i + 40);
        say(`Step 2 of 2: outlining ${toTrace.length} room${toTrace.length === 1 ? "" : "s"}${toTrace.length > 40 ? ` (batch ${i / 40 + 1})` : ""}…`);
        const res = await sampleFn.json(`You are outlining rooms on a construction ${rcp ? "reflected ceiling plan" : "floor plan"} (image attached${area.w < sh.w ? ", a crop of the sheet" : ""}).
For each room below, trace its outline as a closed polygon along the inside face of the walls that enclose it, with a vertex at each corner. Keep horizontal and vertical edges exactly horizontal or vertical. Close door openings straight across.
Rooms (number, name, a point inside it): ${chunk.map(r => `${r.number || "?"} ${r.name} at [${nrm(r.center).join(",")}]`).join("; ")}
Coordinates are normalized 0-1000 on both axes of this image.
Reply with only JSON: {"rooms":[{"number":"101","name":"OFFICE","pts":[[x,y],[x,y],[x,y],[x,y]]}]}`, {images: [await cropBlob(sh, area)], modelTier: "complex", signal, cache: false});
        for (const r of (res.rooms || [])){
          const src = chunk.find(c => (c.number && c.number === String(r.number || "").trim()) || (!c.number && c.name === r.name)); if (!src) continue;
          const pts = (r.pts || []).map(q => fromTile(area, q)).filter(Boolean); if (pts.length < 3) continue;
          const it = {id: uid(), kind: "room", number: src.number, name: src.name, pts, src: "claude", finish: {}};
          if (src.ceilingHt){ it.ceilingHt = src.ceilingHt; it.ceilingFrom = "RCP"; }
          if (src.ceiling) it.finish.ceiling = src.ceiling;
          sh.items.push(it); added++;
        }
      }
    }
    const matched = applyScheduleToRooms();
    cur.aiNote = `Found ${Object.keys(found).length} room tag${Object.keys(found).length === 1 ? "" : "s"}. ` + (added ? `Outlined ${added} room${added === 1 ? "" : "s"}. ` : "") + (updated ? `Updated ceiling height and type for ${updated} room${updated === 1 ? "" : "s"} from this RCP. ` : "")
      + (project.finishSchedule ? `${matched} room${matched === 1 ? "" : "s"} matched the finish schedule.` : "No finish schedule read yet, so finishes are blank.")
      + (failed ? ` ${failed} section${failed === 1 ? "" : "s"} couldn't be read.` : "") + (added ? "\nRoom outlines are drafts traced from the whole sheet: drag corners to fit the walls." : "");
    dirty(); renderSheets();
  } catch (e){ cur.aiNote = errCopy(e); }
  cur.ai = null; cur.aiCtl = null; renderPane(); render();
}
function roomsBox(sh){
  const ai = cur.ai, ready = sampleFn && canImages && !ai, rcp = sh.kind === "rcp";
  const n = sh.items.filter(i => i.kind === "room").length;
  return `<div class="ai-box"><h3>${rcp ? "Ceilings from this RCP" : "Rooms for finishes"}</h3>
    <p class="hint">${rcp ? "Claude reads each room's ceiling height and ceiling type and applies them to the rooms on your floor plan by room number. Rooms not on a floor plan get outlined here." : "Claude finds every room, outlines it, and pulls its finishes from the finish schedule. Room perimeter × ceiling height gives wall finish SF; room area gives ceiling and floor SF."}</p>
    <div class="row"><button class="btn primary small" id="aiRooms" ${ready ? "" : "disabled"}>${ai === "rooms" ? "Working…" : rcp ? "Read ceilings" : n ? "Find rooms again" : "Find rooms"}</button>${ai ? `<button class="btn small" id="aiStop">Stop</button>` : ""}</div>
    <p class="hint">${n} room${n === 1 ? "" : "s"} on this sheet. Draw one yourself with the Room tool (R).</p>
    ${cur.aiNote && cur.ai !== "read" && cur.ai !== "takeoff" ? "" : ""}
  </div>`;
}
function paneRoom(it, sh){
  const q = roomQty(it, sh), f = it.finish || {}, codes = PC().map(c => c.code);
  const dl = `<datalist id="codeList">${codes.map(c => `<option value="${esc(c)}">`).join("")}</datalist>`;
  const sched = project.finishSchedule?.rooms.find(x => x.number === it.number);
  return `<div class="row" style="justify-content:space-between;align-items:center"><h3>Room</h3>${srcBadge(it)}</div>
    <div class="row"><div class="field" style="flex:0 0 90px"><label for="rmNo">Number</label><input id="rmNo" value="${esc(it.number || "")}"></div><div class="field"><label for="rmName">Name</label><input id="rmName" value="${esc(it.name || "")}"></div></div>
    <div class="row"><div class="field"><label for="rmHt">Ceiling height ft</label><input id="rmHt" inputmode="decimal" value="${it.ceilingHt ?? ""}" placeholder="${q ? q.ht + " (" + q.htFrom + ")" : ""}"></div></div>
    ${dl}
    <div class="row"><div class="field"><label for="rmWalls">Wall finish</label><input id="rmWalls" list="codeList" value="${esc((f.walls || []).join(", "))}" placeholder="PT-1, WC-1"></div><div class="field"><label for="rmCeil">Ceiling</label><input id="rmCeil" list="codeList" value="${esc(f.ceiling || "")}" placeholder="ACT-1"></div></div>
    <div class="row"><div class="field"><label for="rmFloor">Floor</label><input id="rmFloor" list="codeList" value="${esc(f.floor || "")}" placeholder="CPT-1"></div><div class="field"><label for="rmBase">Base</label><input id="rmBase" list="codeList" value="${esc(f.base || "")}" placeholder="RB-1"></div></div>
    <p class="hint">${sched ? "Matched to the finish schedule. Blank fields fill from it." : project.finishSchedule ? "No row for this room number in the finish schedule." : "Read a finish schedule sheet to fill these in automatically."}${(f.walls || []).length > 1 ? " Wall area is split evenly between the wall finishes." : ""}</p>
    <div class="readout"><div><div class="k">Floor / ceiling</div><div class="v">${q ? fmt(q.area, 0) + " SF" : "—"}</div></div><div><div class="k">Perimeter</div><div class="v">${q ? fmt(q.perim) + " LF" : "—"}</div></div>
    <div><div class="k">Wall finish</div><div class="v">${q ? fmt(q.wallSf, 0) + " SF" : "—"}</div></div><div><div class="k">Base</div><div class="v">${q ? fmt(q.baseLf) + " LF" : "—"}</div></div></div>
    ${q?.split ? `<p class="hint">Perimeter: ${Math.round(q.split.new * 100)}% new walls · ${Math.round(q.split.existing * 100)}% existing${q.split.untraced > 0.01 ? ` · ${Math.round(q.split.untraced * 100)}% not traced` : ""}${q.split.none + q.split.demo > 0.01 ? ` · ${Math.round((q.split.none + q.split.demo) * 100)}% gets no finish` : ""}.</p>` : ""}
    ${q?.openings ? `<p class="hint">${project.deductOpenings ? "Less" : "Not deducting"} ${q.openings} door opening${q.openings === 1 ? "" : "s"} on this room's walls.</p>` : ""}
    <div class="row"><button class="btn danger small" id="itDel">Delete</button><button class="btn small ghost" id="itDone">Done</button></div>`;
}
function wireRoom(it){
  const on = (id, fn) => { const el = byId(id); if (el) el.addEventListener("change", fn); };
  const codes = v => v.split(/[,/]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
  const setF = (k, v) => { const f = {...(it.finish || {})}; f[k] = v; changeItem(it, {finish: f}); };
  on("rmNo", e => { changeItem(it, {number: e.target.value.trim()}); applyScheduleToRooms(); renderPane(); });
  on("rmName", e => changeItem(it, {name: e.target.value.trim()}));
  on("rmHt", e => { const v = parseFloat(e.target.value); changeItem(it, isFinite(v) && v > 0 ? {ceilingHt: v, ceilingFrom: "you"} : {ceilingHt: undefined, ceilingFrom: undefined}); });
  on("rmWalls", e => setF("walls", codes(e.target.value)));
  on("rmCeil", e => setF("ceiling", codes(e.target.value)[0] || ""));
  on("rmFloor", e => setF("floor", codes(e.target.value)[0] || ""));
  on("rmBase", e => setF("base", codes(e.target.value)[0] || ""));
}

/* ================= report ================= */
function codeDesc(code){
  const c = calloutByCode(code); if (c?.name && c.name !== code) return c.name;
  return project.finishSchedule?.materials.find(m => m.code === code)?.desc || "";
}
function reportLines(){
  const T = computeTakeoff("all"), L = [], warn = [];
  for (const r of T.partRows){
    const t = r.t;
    L.push({key: `fr-${t.tag}`, group: "Framing", code: t.tag, desc: t.desc, qty: r.lf, unit: "LF", detail: `${[...r.heights].join("/")}' high · ${r.studs} studs @ ${t.spacing}" o.c. · ${fmt(r.track, 0)} LF track`});
    if (t.sides && t.layers) L.push({key: `gwb-${t.tag}`, group: "Drywall", code: t.tag, desc: `Gypsum board on type ${t.tag}: ${t.sides} face${t.sides === 1 ? "" : "s"} × ${t.layers} layer${t.layers === 1 ? "" : "s"}`, qty: r.gwb, unit: "SF", detail: `${fmt(r.net, 0)} SF net wall + ${t.waste}% waste · ${r.boards} 4×12 boards`});
    if (r.insul) L.push({key: `ins-${t.tag}`, group: "Insulation", code: t.tag, desc: `Insulation in type ${t.tag}`, qty: r.insul, unit: "SF", detail: ""});
  }
  const agg = {}; let nRooms = 0, noHt = 0, noFin = 0, roomArea = 0;
  const add = (group, code, qty, unit, room, sub = "") => { if (!code || !(qty > 0.05)) return; const k = `${group}|${code}|${sub}`; const a = agg[k] ||= {key: `rm-${group}-${code}${sub ? "-" + sub.replace(/\W+/g, "") : ""}`, group, code, desc: codeDesc(code) + (sub ? ` · ${sub}` : ""), qty: 0, unit, rooms: new Set()}; a.qty += qty; a.rooms.add(room); };
  for (const sh of project.sheets) for (const it of sh.items){
    if (it.kind !== "room") continue; const q = roomQty(it, sh); if (!q) continue;
    nRooms++; roomArea += q.area; const f = it.finish || {}, label = it.number || it.name || "room";
    if (q.htFrom === "project default") noHt++;
    if (!f.walls?.length && !f.floor && !f.ceiling) noFin++;
    (f.walls || []).forEach(w => {
      const per = q.wallNet / f.walls.length;
      if (q.split){ const s = q.split; add("Wall finishes", w, per * s.new, "SF", label, "on new walls"); add("Wall finishes", w, per * s.existing, "SF", label, "on existing walls"); add("Wall finishes", w, per * s.untraced, "SF", label, "on walls not traced"); }
      else add("Wall finishes", w, per, "SF", label);
    });
    add("Ceilings", f.ceiling, q.area, "SF", label); add("Flooring", f.floor, q.area, "SF", label); add("Base", f.base, q.baseLf, "LF", label);
  }
  for (const a of Object.values(agg)){ a.detail = `${a.rooms.size} room${a.rooms.size === 1 ? "" : "s"}: ${[...a.rooms].slice(0, 8).join(", ")}${a.rooms.size > 8 ? "…" : ""}`; delete a.rooms; L.push(a); }
  const ex = T.exist.existing, dm = T.exist.demo;
  if (ex) L.push({key: "ex-walls", group: "Existing walls", code: "ETR", desc: "Existing walls to remain (no framing or drywall)", qty: ex.lf, unit: "LF", detail: `${ex.n} run${ex.n === 1 ? "" : "s"} · ${fmt(ex.sf, 0)} SF per face at the default height${ex.noFin ? ` · ${fmt(ex.noFin)} LF marked no finish` : ""}`});
  if (dm){ L.push({key: "demo-lf", group: "Demolition", code: "DEMO", desc: "Demolish walls", qty: dm.lf, unit: "LF", detail: `${dm.n} run${dm.n === 1 ? "" : "s"}`}); L.push({key: "demo-sf", group: "Demolition", code: "DEMO", desc: "Demolish walls, wall area (one face)", qty: dm.sf, unit: "SF", detail: "Length × default ceiling height"}); }
  for (const r of T.callRows) L.push({key: `ms-${r.c.code}${r.st === "existing" ? "-ex" : ""}`, group: "Measured on drawings", code: r.c.code, desc: r.c.name + (r.st === "existing" ? " · existing surfaces" : ""), qty: r.qty, unit: r.c.unit, detail: `${r.n} item${r.n === 1 ? "" : "s"} drawn on elevations or plans`});
  if (T.missingScale.length) warn.push(`No scale on ${T.missingScale.join(", ")}: those sheets are left out.`);
  if (noHt) warn.push(`${noHt} room${noHt === 1 ? " uses" : "s use"} the default ceiling height. Read an RCP or finish schedule, or set heights per room.`);
  if (noFin) warn.push(`${noFin} room${noFin === 1 ? " has" : "s have"} no finishes assigned.`);
  return {lines: L, warn, nRooms, roomArea};
}
const GROUP_ORDER = ["Demolition", "Framing", "Drywall", "Insulation", "Existing walls", "Wall finishes", "Ceilings", "Flooring", "Base", "Measured on drawings"];
function paneReport(){
  const R = reportLines(), off = project.reportOff || {};
  const groups = GROUP_ORDER.filter(g => R.lines.some(l => l.group === g));
  const nSel = R.lines.filter(l => !lineOff(l)).length;
  return `<div class="row" style="justify-content:space-between;align-items:center"><h3>Takeoff report</h3><span class="badge">${nSel} of ${R.lines.length} lines selected</span></div>
    <div class="row"><label class="toggle"><input type="checkbox" id="dedOpen" ${project.deductOpenings ? "checked" : ""}> Deduct door openings</label><div class="field" style="flex:0 0 150px;min-width:0"><label for="defHt">Default ceiling ht ft</label><input id="defHt" inputmode="decimal" value="${project.defaultCeilingHt || 9}"></div></div>
    ${R.warn.map(w => `<p class="hint" style="color:var(--warn)">${esc(w)}</p>`).join("")}
    ${R.nRooms ? `<div class="readout"><div><div class="k">Rooms</div><div class="v">${R.nRooms}</div></div><div><div class="k">Room floor area</div><div class="v">${fmt(R.roomArea, 0)} SF</div></div></div>` : ""}
    ${groups.length ? groups.map(g => `<div class="tbl-wrap"><table><thead><tr><th style="width:24px"><input type="checkbox" data-grp="${esc(g)}" ${!(project.groupOff || {})[g] && R.lines.filter(l => l.group === g).every(l => !off[l.key]) ? "checked" : ""} aria-label="Select all ${esc(g)}"></th><th style="text-align:left">${esc(g)}</th><th>Qty</th><th>Unit</th></tr></thead><tbody>
      ${R.lines.filter(l => l.group === g).map(l => `<tr><td><input type="checkbox" data-line="${esc(l.key)}" ${lineOff(l) ? "" : "checked"} ${(project.groupOff || {})[g] ? "disabled" : ""} aria-label="Include ${esc(l.code)}"></td><td style="text-align:left;white-space:normal;font-family:var(--f-body)"><b>${esc(l.code)}</b> ${esc(l.desc)}<br><span class="hint" style="font-size:11px">${esc(l.detail || "")}</span></td><td>${fmt(l.qty, l.unit === "EA" ? 0 : l.unit === "SF" ? 0 : 1)}</td><td>${l.unit}</td></tr>`).join("")}
    </tbody></table></div>`).join("") : `<p class="hint">Nothing measured yet. Take off partitions on a floor plan, find rooms, or draw areas on elevations.</p>`}
    <div class="row"><button class="btn small primary" id="sendChat" ${canWrite ? "" : "disabled"}>Send to estimating chat</button><button class="btn small" id="copyPrice">Copy</button><button class="btn small" id="expCsv" ${downloads ? "" : "disabled"}>Export CSV</button><button class="btn small" id="expJson" ${downloads ? "" : "disabled"}>Export JSON</button></div>
    <p class="hint" id="copyMsg">Only selected lines are sent, copied or exported. Send to estimating chat attaches them to this lead's chat, where they are priced before anything read off the plans.</p>`;
}
function wireReport(){
  const R = () => reportLines();
  root.querySelectorAll("[data-line]").forEach(el => el.onchange = () => { const o = project.reportOff ||= {}; if (el.checked) delete o[el.dataset.line]; else o[el.dataset.line] = true; dirty(); renderPane(); });
  root.querySelectorAll("[data-grp]").forEach(el => el.onchange = () => { const o = project.reportOff ||= {}, go = project.groupOff ||= {}, g = el.dataset.grp; if (el.checked){ delete go[g]; R().lines.filter(l => l.group === g).forEach(l => delete o[l.key]); } else go[g] = true; dirty(); renderPane(); });
  const d = byId("defHt"); if (d) d.onchange = () => { const v = parseFloat(d.value); if (v > 0){ project.defaultCeilingHt = v; dirty(); } renderPane(); };
  const sc = byId("sendChat"); if (sc) sc.onclick = async () => {
    sc.disabled = true; const m = $("#copyMsg");
    try {
      if (!selectedLines().length) throw new Error("Nothing is selected. Tick the lines to send.");
      await saveProject();
      const r = await api("POST", `/opportunities/${leadId}/takeoff-studio/send`, {text: pricingText() + "\n\nDETAIL (byother.takeoff/v1)\n" + JSON.stringify(takeoffJson())});
      m.innerHTML = `Sent as ${esc(r.name)}. It waits on your next message in the <a href="#/estimating/${leadId}/chat">estimating chat</a>; sending again replaces it.`;
    } catch (e){ m.textContent = e.message; }
    sc.disabled = false;
  };
  const c = byId("copyPrice"); if (c) c.onclick = () => {
    const txt = pricingText();
    navigator.clipboard.writeText(txt).then(() => { $("#copyMsg").textContent = "Copied. Paste it into the pricing chat."; }).catch(() => { $("#copyMsg").innerHTML = `<textarea rows="8" style="width:100%">${esc(txt)}</textarea>`; $("#copyMsg textarea").select(); });
  };
}
const lineOff = l => !!((project.reportOff || {})[l.key] || (project.groupOff || {})[l.group]);
const selectedLines = () => reportLines().lines.filter(l => !lineOff(l));
function pricingText(){
  const lines = selectedLines(); const by = {};
  lines.forEach(l => (by[l.group] ||= []).push(l));
  let s = `TAKEOFF FOR PRICING: ${project.name}\nDate: ${new Date().toLocaleDateString()} · Source: Takeoff Studio (quantities are measured, waste is noted where included)\n`;
  for (const g of GROUP_ORDER) if (by[g]){ s += `\n${g.toUpperCase()}\n`; by[g].forEach(l => s += `- ${l.code}${l.desc ? " " + l.desc : ""}: ${fmt(l.qty, l.unit === "LF" ? 1 : 0)} ${l.unit}${l.detail ? " (" + l.detail + ")" : ""}\n`); }
  s += `\nPrice each selected line with the estimating sheet. Lines on existing walls may need prep before finishing.`;
  return s;
}
function takeoffJson(){
  const lines = selectedLines();
  return {
    schema: "byother.takeoff/v1", generatedAt: new Date().toISOString(), units: "imperial",
    project: {id: project.id, name: project.name, deductOpenings: !!project.deductOpenings, defaultCeilingHeightFt: project.defaultCeilingHt || 9},
    lines: lines.map(l => ({group: l.group, code: l.code, description: l.desc, quantity: +l.qty.toFixed(2), unit: l.unit, details: l.detail || ""})),
    wallTypes: PT().map(t => ({tag: t.tag, description: t.desc, heightFt: t.height, studIn: t.stud, spacingIn: t.spacing, faces: t.sides, layers: t.layers, insulated: !!t.insul, wastePct: t.waste})),
    finishes: PC().map(c => ({code: c.code, description: c.name, unit: c.unit, appliesTo: c.applies || null})),
    walls: project.sheets.flatMap(sh => sh.items.filter(i => i.kind === "partition").map(it => ({sheet: sh.name, status: wStat(it), type: typeById(it.typeId)?.tag || null, lengthLf: sh.ppi ? +itemQty(it, sh).toFixed(2) : null, getsFinish: !it.noFinish && wStat(it) !== "demo"}))),
    rooms: project.sheets.flatMap(sh => sh.items.filter(i => i.kind === "room").map(it => { const q = roomQty(it, sh); return {sheet: sh.name, number: it.number || null, name: it.name || null, areaSf: q ? +q.area.toFixed(1) : null, perimeterLf: q ? +q.perim.toFixed(1) : null, ceilingHeightFt: q?.ht ?? null, wallFinishSf: q ? +q.wallSf.toFixed(1) : null, perimeterSplit: q?.split ? Object.fromEntries(Object.entries(q.split).map(([k, v]) => [k, +v.toFixed(3)])) : null, baseLf: q ? +q.baseLf.toFixed(1) : null, finishes: it.finish || {}}; })),
    sheets: project.sheets.map(sh => ({name: sh.name, role: sh.kind, scaleFtPx: sh.ppi ? +(sh.ppi * 12).toFixed(3) : null, items: sh.items.length}))
  };
}
function summaryText(){ return pricingText(); }
async function exportFile(kind){
  if (!downloads) return;
  const base = (project.name || "takeoff").replace(/[^\w\- ]+/g, "").trim() || "takeoff";
  try {
    if (kind === "csv"){
      const rows = [["Section", "Code", "Description", "Quantity", "Unit", "Details"], ...selectedLines().map(l => [l.group, l.code, l.desc, l.qty.toFixed(l.unit === "LF" ? 1 : 0), l.unit, l.detail || ""])];
      await downloads.save({filename: base + " takeoff.csv", data: rows.map(r => r.map(v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v).join(",")).join("\n")});
    } else await downloads.save({filename: base + " takeoff.json", data: JSON.stringify(takeoffJson(), null, 2)});
  } catch (e){ const m = $("#copyMsg"); if (m && e.code !== "cancelled" && e.code !== "declined") m.textContent = "Export didn't finish: " + (e.message || e.code); }
}

/* ================= chat: tweak the takeoff in plain words ================= */
const projInstr = () => (project.instructions ||= []);
function stateSummary(){
  const R = reportLines(), off = project.reportOff || {}, goff = project.groupOff || {};
  const lines = R.lines.map(l => `${l.group} | ${l.code} ${l.desc} | ${fmt(l.qty, l.unit === "LF" ? 1 : 0)} ${l.unit}${off[l.key] || goff[l.group] ? " | EXCLUDED" : ""}`).slice(0, 80);
  const rooms = project.sheets.flatMap(sh => sh.items.filter(i => i.kind === "room").map(i => `${i.number || "?"} ${i.name || ""} ht ${roomHt(i).ht}' walls ${(i.finish?.walls || []).join("/") || "-"} clg ${i.finish?.ceiling || "-"} flr ${i.finish?.floor || "-"} base ${i.finish?.base || "-"}`)).slice(0, 60);
  return `PROJECT: ${project.name}
SHEETS: ${project.sheets.map(s => `${s.name} [${s.kind}${s.ppi ? "" : ", no scale"}; ${s.items.length} items]`).join("; ") || "none"}
WALL TYPES: ${PT().map(t => `${t.tag} (${t.height}' , ${t.sides} faces x ${t.layers} layers${t.insul ? ", insulated" : ""}): ${t.desc}`).join(" | ") || "none"}
FINISH CODES: ${PC().map(c => `${c.code} ${c.unit} ${c.name}`).join(" | ")}
EXCLUDED SECTIONS: ${Object.keys(goff).filter(k => goff[k]).join(", ") || "none"}
DEFAULT CEILING HEIGHT: ${project.defaultCeilingHt || 9} ft · DEDUCT OPENINGS: ${project.deductOpenings ? "yes" : "no"}
PROJECT INSTRUCTIONS: ${projInstr().map(i => `[${i.id}] ${i.text}`).join(" | ") || "none"}
RULES FOR ALL PROJECTS: ${lessons.filter(l => l.scope !== "project").map(l => `[${l.id}] ${l.text}`).join(" | ") || "none"}
REPORT LINES:
${lines.join("\n") || "(nothing measured yet)"}
ROOMS:
${rooms.join("\n") || "(none)"}`;
}
const CHAT_RULES = `You are the takeoff assistant inside Takeoff Studio, working with a construction estimator on an interior framing, drywall and finishes takeoff. The estimator talks to you to change scope, add context, or ask about quantities.
- When the estimator gives an instruction that should shape future drafts (for example "ignore the millwork", "walls in the stair are by others", "all corridor walls go to deck"), save it with add_instruction. Use scope "project" unless they say it applies to every job.
- When they want a trade or section left out ("ignore flooring", "no demo"), call exclude_sections AND save an instruction so Claude's drafts skip it too.
- Use the other tools to change wall types, room finishes, heights, or wall status. Change only what they asked.
- Report sections are: ${GROUP_ORDER.join(", ")}.
- After acting, answer in one to three short plain sentences saying exactly what changed. If something is unclear, ask one short question instead of guessing.
- Never invent quantities. Use get_takeoff when you need current numbers.`;

const CHAT_TOOLS = () => [
  {name: "get_takeoff", description: "Returns the current takeoff: sheets, wall types, finish codes, report lines with quantities, rooms and instructions. Use before answering questions about quantities.", inputSchema: {type: "object", properties: {}}, execute: () => stateSummary()},
  {name: "add_instruction", description: "Saves an instruction that every future Claude draft and reading on this project (or every project) will follow. Returns the saved instruction id.", inputSchema: {type: "object", properties: {text: {type: "string", description: "The instruction, one clear sentence."}, scope: {type: "string", enum: ["project", "all_projects"]}}, required: ["text"]},
    execute: async ({text, scope}) => { const t = String(text || "").trim(); if (!t) throw new Error("Empty instruction"); if (scope === "all_projects"){ await addLessons([t], "user", "global"); return "Saved as a rule for all projects."; } const id = "i" + uid(); projInstr().push({id, text: t, at: Date.now()}); chatActed(`Instruction added: ${t}`); return "Saved project instruction " + id; }},
  {name: "remove_instruction", description: "Removes a project instruction or an all-projects rule by its id (ids are shown in get_takeoff).", inputSchema: {type: "object", properties: {id: {type: "string"}}, required: ["id"]},
    execute: async ({id}) => { id = String(id); const i = projInstr().findIndex(x => x.id === id); if (i >= 0){ const [x] = projInstr().splice(i, 1); chatActed(`Instruction removed: ${x.text}`); return "Removed."; } if (lessons.some(l => l.id === id)){ await removeLesson(id); chatActed("Rule removed"); return "Removed rule."; } throw new Error("No instruction with that id"); }},
  {name: "exclude_sections", description: "Leaves whole report sections (trades) out of the report and exports, or puts them back. Optionally also specific codes.", inputSchema: {type: "object", properties: {sections: {type: "array", items: {type: "string"}, description: "Section names, e.g. Flooring, Demolition, Wall finishes"}, codes: {type: "array", items: {type: "string"}, description: "Specific codes like WC-1 or A3"}, exclude: {type: "boolean"}}, required: ["exclude"]},
    execute: ({sections = [], codes = [], exclude}) => {
      const go = project.groupOff ||= {}, off = project.reportOff ||= {}, done = [];
      for (const s of sections){ const g = GROUP_ORDER.find(x => x.toLowerCase() === String(s).toLowerCase()); if (!g) continue; if (exclude) go[g] = true; else delete go[g]; done.push(g); }
      const lines = reportLines().lines;
      for (const c of codes){ for (const l of lines.filter(l => l.code.toUpperCase() === String(c).toUpperCase())){ if (exclude) off[l.key] = true; else delete off[l.key]; done.push(l.code); } }
      if (!done.length) throw new Error("Nothing matched. Sections are: " + GROUP_ORDER.join(", "));
      chatActed(`${exclude ? "Excluded" : "Included"}: ${[...new Set(done)].join(", ")}`); return `${exclude ? "Excluded" : "Included"} ${[...new Set(done)].join(", ")}`;
    }},
  {name: "update_wall_type", description: "Changes a wall type's fields by tag: height_ft, description, faces, layers, stud_in, spacing_in, insulated, waste_pct.", inputSchema: {type: "object", properties: {tag: {type: "string"}, height_ft: {type: "number"}, description: {type: "string"}, faces: {type: "number"}, layers: {type: "number"}, stud_in: {type: "number"}, spacing_in: {type: "number"}, insulated: {type: "boolean"}, waste_pct: {type: "number"}}, required: ["tag"]},
    execute: (a) => { const t = PT().find(x => x.tag.toUpperCase() === String(a.tag).toUpperCase()); if (!t) throw new Error("No wall type " + a.tag); const m = {height_ft: "height", description: "desc", faces: "sides", layers: "layers", stud_in: "stud", spacing_in: "spacing", insulated: "insul", waste_pct: "waste"}; const ch = [];
      for (const [k, f] of Object.entries(m)) if (a[k] !== undefined){ t[f] = typeof t[f] === "number" ? Number(a[k]) : a[k]; ch.push(`${f} ${a[k]}`); } chatActed(`Type ${t.tag}: ${ch.join(", ")}`); return "Updated " + t.tag; }},
  {name: "change_walls", description: "Changes walls in bulk on all sheets: pick walls by current type tag and/or status, then set a new status (new, existing, demo), a new type tag, or whether they get a wall finish. Returns how many changed.", inputSchema: {type: "object", properties: {from_tag: {type: "string"}, from_status: {type: "string", enum: ["new", "existing", "demo"]}, to_status: {type: "string", enum: ["new", "existing", "demo"]}, to_tag: {type: "string"}, gets_finish: {type: "boolean"}}},
    execute: (a) => {
      const toT = a.to_tag ? PT().find(x => x.tag.toUpperCase() === String(a.to_tag).toUpperCase()) : null; if (a.to_tag && !toT) throw new Error("No wall type " + a.to_tag);
      if (!a.from_tag && !a.from_status) throw new Error("Say which walls: from_tag or from_status");
      let n = 0;
      for (const sh of project.sheets) for (const w of sh.items){
        if (w.kind !== "partition") continue;
        if (a.from_tag && (typeById(w.typeId)?.tag || "").toUpperCase() !== String(a.from_tag).toUpperCase()) continue;
        if (a.from_status && wStat(w) !== a.from_status) continue;
        if (a.to_status) w.status = a.to_status === "new" ? undefined : a.to_status;
        if (toT){ w.typeId = toT.id; w.status = undefined; }
        if (a.gets_finish !== undefined) w.noFinish = a.gets_finish ? undefined : true;
        if (w.src === "claude") w.edited = true; n++;
      }
      chatActed(`Changed ${n} wall${n === 1 ? "" : "s"}`); logCorrection(`Chat: changed ${n} walls (${JSON.stringify(a)})`); return `Changed ${n} walls`;
    }},
  {name: "update_rooms", description: "Changes rooms by number (or all rooms): ceiling_height_ft, wall finish codes, ceiling, floor, base codes. Use numbers: [\"all\"] for every room.", inputSchema: {type: "object", properties: {numbers: {type: "array", items: {type: "string"}}, ceiling_height_ft: {type: "number"}, walls: {type: "array", items: {type: "string"}}, ceiling: {type: "string"}, floor: {type: "string"}, base: {type: "string"}}, required: ["numbers"]},
    execute: (a) => {
      const all = (a.numbers || []).some(n => String(n).toLowerCase() === "all"); let n = 0;
      for (const sh of project.sheets) for (const r of sh.items){
        if (r.kind !== "room" || !(all || (a.numbers || []).map(String).includes(r.number))) continue;
        r.finish ||= {};
        if (a.ceiling_height_ft > 0){ r.ceilingHt = Number(a.ceiling_height_ft); r.ceilingFrom = "you"; }
        if (Array.isArray(a.walls)) r.finish.walls = a.walls.map(s => String(s).toUpperCase());
        for (const k of ["ceiling", "floor", "base"]) if (a[k] !== undefined) r.finish[k] = String(a[k]).toUpperCase();
        n++;
      }
      if (!n) throw new Error("No matching rooms");
      chatActed(`Updated ${n} room${n === 1 ? "" : "s"}`); return `Updated ${n} rooms`;
    }},
  {name: "set_project_setting", description: "Sets default_ceiling_height_ft or deduct_openings for the project.", inputSchema: {type: "object", properties: {default_ceiling_height_ft: {type: "number"}, deduct_openings: {type: "boolean"}}},
    execute: (a) => { if (a.default_ceiling_height_ft > 0) project.defaultCeilingHt = Number(a.default_ceiling_height_ft); if (a.deduct_openings !== undefined) project.deductOpenings = !!a.deduct_openings; chatActed("Project settings updated"); return "Updated"; }},
];
let chatActs = [];
function chatActed(t){ chatActs.push(t); dirty(); renderSheets(); render(); }
async function chatSend(){
  const box = $("#chatIn"); const text = box?.value.trim(); if (!text || !sampleFn || cur.chatBusy) return;
  const hist = project.chat ||= [];
  hist.push({role: "user", content: text, at: Date.now()}); box.value = "";
  const reply = {role: "assistant", content: "", at: Date.now(), acts: []}; hist.push(reply);
  cur.chatBusy = true; cur.chatCtl = new AbortController(); chatActs = []; renderPane();
  try {
    const turns = [{role: "user", content: CHAT_RULES + "\n\nCURRENT TAKEOFF:\n" + stateSummary()}, ...hist.slice(-21, -1).filter(m => m.content).map(m => ({role: m.role, content: m.content}))];
    const res = await sampleFn(turns, {tools: CHAT_TOOLS(), signal: cur.chatCtl.signal, onText: ({text}) => { reply.content = text; const el = byId("chatLive"); if (el) el.textContent = text; }});
    reply.content = res.text || "Done.";
  } catch (e){ reply.content = e.text || ""; reply.err = e.code === "cancelled" ? "Stopped." : errCopy(e); }
  reply.acts = chatActs.slice(); chatActs = [];
  if (hist.length > 60) hist.splice(0, hist.length - 60);
  cur.chatBusy = false; cur.chatCtl = null; dirty(); renderAll();
}
function paneChat(){
  const hist = project.chat || [], ins = projInstr();
  const msg = (m, i) => {
    const live = cur.chatBusy && i === hist.length - 1 && m.role === "assistant";
    return `<div class="msg ${m.role}"><div class="bubble"${live ? ` id="chatLive"` : ""}>${esc(m.content || (live ? "Thinking…" : ""))}</div>${(m.acts || []).map(a => `<span class="act">✓ ${esc(a)}</span>`).join("")}${m.err ? `<span class="act err">${esc(m.err)}</span>` : ""}</div>`;
  };
  return `<h3>Talk to the takeoff</h3>
    <p class="hint">Add context or change scope in plain words. Claude saves instructions for future drafts and can change types, rooms, walls and report sections.</p>
    ${ins.length ? `<div class="field"><span class="flabel">Instructions for this project</span>${ins.map(i => `<div class="lesson"><p>${esc(i.text)}</p><button class="btn small ghost danger" data-del-ins="${i.id}" aria-label="Remove instruction">✕</button></div>`).join("")}</div>` : ""}
    <div class="chatlog" id="chatLog">${hist.length ? hist.map(msg).join("") : `<div class="hint">Try: "Ignore flooring, it's by the owner." · "Walls in the stair are by others." · "Type A3 goes to 12 feet." · "Paint all existing walls in rooms 101 to 110."</div>`}</div>
    <div class="chatbar"><textarea id="chatIn" rows="2" placeholder="${sampleFn ? "Tell Claude what to change or keep in mind…" : "Chat needs the AI connected and estimator access"}" ${sampleFn ? "" : "disabled"}></textarea>
      <div class="row"><button class="btn primary small" id="chatGo" ${sampleFn && !cur.chatBusy ? "" : "disabled"}>${cur.chatBusy ? "Working…" : "Send"}</button>${cur.chatBusy ? `<button class="btn small" id="chatStop">Stop</button>` : ""}${hist.length && !cur.chatBusy ? `<button class="btn small ghost" id="chatClear">Clear chat</button>` : ""}</div></div>`;
}
function wireChat(){
  const on = (id, ev, fn) => { const el = byId(id); if (el) el.addEventListener(ev, fn); };
  on("chatGo", "click", chatSend);
  on("chatIn", "keydown", e => { if (e.key === "Enter" && !e.shiftKey){ e.preventDefault(); chatSend(); } });
  on("chatStop", "click", () => cur.chatCtl?.abort());
  on("chatClear", "click", () => { project.chat = []; dirty(); renderPane(); });
  root.querySelectorAll("[data-del-ins]").forEach(b => b.onclick = () => { const i = projInstr().findIndex(x => x.id === b.dataset.delIns); if (i >= 0){ projInstr().splice(i, 1); dirty(); renderPane(); } });
  const log = $("#chatLog"); if (log) log.scrollTop = log.scrollHeight;
}

/* ================= wiring ================= */
function renderAll(){ renderSheets(); renderTools(); renderChips(); renderPane(); renderPlans(); render(); }
$("#ortho").onchange = $("#snap").onchange = () => render();
$("#showLen").onchange = () => render();
$("#undoBtn").onclick = () => doUndo(undo, redo);
$("#redoBtn").onclick = () => doUndo(redo, undo);
$("#leadName").textContent = project.name;
// leaving the page saves what is waiting to be saved
addEventListener("hashchange", function leave(){ if (!location.hash.startsWith(`#/estimating/${leadId}/takeoff`)){ removeEventListener("hashchange", leave); if (saveTimer) saveProject(); removeEventListener("keydown", onKey); removeEventListener("keyup", onKeyUp); ro.disconnect(); for (const k in imgs) delete imgs[k]; Object.values(pdfDocs).forEach(p => p.then(d => d.destroy()).catch(() => {})); } });
if (first.updatedAt) setStatus(`Saved ${new Date(first.updatedAt).toLocaleString([], {month: "short", day: "numeric", hour: "numeric", minute: "2-digit"})}${first.updatedBy ? " by " + first.updatedBy : ""}`, "ok");
else setStatus(canWrite ? "New takeoff" : "View only");
renderAll();
loadPlans();
}
