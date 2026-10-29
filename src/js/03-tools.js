/* Penknife PDF - tools, pointer handling, text editing. MIT License. */

const STICKY_TOOLS = new Set(['pen', 'highlight']);
const TOOL_HINTS = {
  select: 'Click an item to select it. Drag to move. Select text on the page to copy it.',
  edit: 'Click any line of text on the page to change it.',
  text: 'Click where you want the text, then type.',
  highlight: 'Drag across the area to highlight.',
  pen: 'Draw with the mouse, trackpad, or a pen.',
  rect: 'Drag to draw a rectangle.',
  ellipse: 'Drag to draw an ellipse.',
  line: 'Drag to draw a line.',
  cover: 'Drag over content to hide it with a white box. The original data stays in the file.',
};

function setTool(t) {
  if (S.editing) endTextEdit();
  S.tool = t;
  S.hoverRun = null;
  $$('.tool[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
  const holder = $('#pages');
  holder.className = 'tool-' + t;
  if (t !== 'select') deselect();
  updateProps();
  S.pages.forEach(renderOverlay);
}
function deselect() {
  if (!S.sel) return;
  const pid = S.sel.pid;
  S.sel = null;
  const p = pageById(pid);
  if (p) renderOverlay(p);
  syncButtons();
  updateProps();
}
function select(pid, id) {
  const prev = S.sel;
  S.sel = { pid, id };
  if (prev && prev.pid !== pid) { const pp = pageById(prev.pid); if (pp) renderOverlay(pp); }
  renderOverlay(pageById(pid));
  syncButtons();
  updateProps();
}

/* ---- creating annotations ---- */
function newAnnot(type, props) { return { id: uid(), type, ...props }; }
function addAnnot(p, a, { select: doSel = true } = {}) {
  p.annots.push(a);
  commit();
  if (doSel) { S.sel = { pid: p.id, id: a.id }; }
  renderOverlay(p);
  syncButtons();
  updateProps();
}
function removeSelected() {
  const [p, a] = selected();
  if (!a) return;
  p.annots = p.annots.filter((x) => x.id !== a.id);
  S.sel = null;
  commit();
  renderOverlay(p);
  syncButtons();
  updateProps();
}

/* ---- pointer handling ---- */
let drag = null;
function onPointerDown(ev) {
  if (ev.button !== 0) return;
  const pageEl = ev.target.closest('.page');
  if (!pageEl) return;
  const p = pageById(pageEl.dataset.pid);
  if (!p) return;
  if (ev.target.closest('.txt[contenteditable]')) return;       // typing inside a text box
  if (S.editing) endTextEdit();
  setCurrent(S.pages.indexOf(p));
  const pt = pagePoint(ev, p);
  const tool = S.tool;

  if (tool === 'select') {
    const h = ev.target.closest('[data-h]');
    const [sp, sa] = selected();
    if (h && sa) {
      ev.preventDefault();
      drag = { kind: 'resize', p, a: sa, handle: h.dataset.h, orig: { ...sa }, start: pt, moved: false };
      return;
    }
    const node = ev.target.closest('[data-aid]');
    if (node) {
      ev.preventDefault();
      const a = annotById(p, node.dataset.aid);
      select(p.id, a.id);
      drag = { kind: 'move', p, a, orig: { ...a }, start: pt, moved: false };
      return;
    }
    if (S.sel) deselect();
    return;     // let the text layer handle text selection
  }

  ev.preventDefault();
  if (tool === 'text') {
    const node = ev.target.closest('[data-aid]');
    if (node) { const a = annotById(p, node.dataset.aid); if (a && a.type === 'text') { select(p.id, a.id); beginTextEdit(p, a); return; } }
    const st = S.style;
    const a = newAnnot('text', { x: pt.x, y: pt.y - st.size * 0.6, text: '', size: st.size, family: st.family, bold: st.bold, italic: st.italic, color: st.color });
    p.annots.push(a);
    S.sel = { pid: p.id, id: a.id };
    renderOverlay(p);
    beginTextEdit(p, a, { isNew: true });
    return;
  }
  if (tool === 'edit') { handleEditClick(p, pt); return; }

  if (['rect', 'ellipse', 'line', 'highlight', 'cover'].includes(tool)) {
    drag = { kind: 'create', tool, p, start: pt, moved: false };
    return;
  }
  if (tool === 'pen') {
    const a = newAnnot('ink', { points: [[pt.x, pt.y]], stroke: S.style.color, sw: +S.style.width });
    S.tmp = { pid: p.id, annot: a };
    drag = { kind: 'pen', p, a, moved: false };
    renderOverlay(p);
  }
}

function onPointerMove(ev) {
  if (!drag) {
    if (S.tool === 'edit') hoverEditRun(ev);
    return;
  }
  const { p } = drag;
  const pt = pagePoint(ev, p);
  drag.moved = true;
  if (drag.kind === 'move') {
    const dx = pt.x - drag.start.x, dy = pt.y - drag.start.y;
    moveAnnot(drag.a, drag.orig, dx, dy);
    renderOverlay(p);
  } else if (drag.kind === 'resize') {
    resizeAnnot(drag.a, drag.orig, drag.handle, pt, ev.shiftKey);
    renderOverlay(p);
  } else if (drag.kind === 'create') {
    S.tmp = { pid: p.id, annot: shapeFromDrag(drag.tool, drag.start, pt, ev.shiftKey) };
    renderOverlay(p);
  } else if (drag.kind === 'pen') {
    const last = drag.a.points[drag.a.points.length - 1];
    if (Math.hypot(pt.x - last[0], pt.y - last[1]) > 0.6) { drag.a.points.push([pt.x, pt.y]); renderOverlay(p); }
  }
}

function onPointerUp() {
  if (!drag) return;
  const d = drag;
  drag = null;
  const { p } = d;
  if (d.kind === 'move' || d.kind === 'resize') {
    if (d.moved) commit();
    renderOverlay(p);
    return;
  }
  if (d.kind === 'create') {
    const a = S.tmp && S.tmp.annot;
    S.tmp = null;
    if (a && bboxBigEnough(a)) {
      if (a.type === 'cover') matchPageColour(p, a);
      addAnnot(p, a, { select: !STICKY_TOOLS.has(d.tool) });
      if (!STICKY_TOOLS.has(d.tool)) setTool('select'), select(p.id, a.id);
    } else renderOverlay(p);
    return;
  }
  if (d.kind === 'pen') {
    S.tmp = null;
    p.annots.push(d.a);
    commit();
    renderOverlay(p);
  }
}
function bboxBigEnough(a) {
  const b = bbox(a);
  return Math.max(b.w, b.h) >= 3;
}

function shapeFromDrag(tool, s, e, shift) {
  let x = Math.min(s.x, e.x), y = Math.min(s.y, e.y), w = Math.abs(e.x - s.x), h = Math.abs(e.y - s.y);
  if (shift && tool !== 'line' && tool !== 'highlight' && tool !== 'cover') { const m = Math.max(w, h); w = h = m; x = e.x < s.x ? s.x - m : s.x; y = e.y < s.y ? s.y - m : s.y; }
  const st = S.style;
  switch (tool) {
    case 'rect': return newAnnot('rect', { x, y, w, h, stroke: st.color, sw: +st.width, fill: st.fillOn ? st.fill : null });
    case 'ellipse': return newAnnot('ellipse', { x, y, w, h, stroke: st.color, sw: +st.width, fill: st.fillOn ? st.fill : null });
    case 'highlight': return newAnnot('highlight', { x, y, w, h, fill: st.hl });
    case 'cover': return newAnnot('cover', { x, y, w, h, fill: '#ffffff' });
    case 'line': {
      let x2 = e.x, y2 = e.y;
      if (shift) { const dx = e.x - s.x, dy = e.y - s.y; if (Math.abs(dx) > Math.abs(dy) * 2) y2 = s.y; else if (Math.abs(dy) > Math.abs(dx) * 2) x2 = s.x; }
      return newAnnot('line', { x1: s.x, y1: s.y, x2, y2, stroke: st.color, sw: +st.width, arrow: st.arrow });
    }
  }
}

function moveAnnot(a, o, dx, dy) {
  if (a.type === 'line') { a.x1 = o.x1 + dx; a.y1 = o.y1 + dy; a.x2 = o.x2 + dx; a.y2 = o.y2 + dy; }
  else if (a.type === 'ink') a.points = o.points.map(([x, y]) => [x + dx, y + dy]);
  else { a.x = o.x + dx; a.y = o.y + dy; }
}
function resizeAnnot(a, o, h, pt, keepRatio) {
  if (a.type === 'line') { if (h === 'p1') { a.x1 = pt.x; a.y1 = pt.y; } else { a.x2 = pt.x; a.y2 = pt.y; } return; }
  let x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.h;
  if (h.includes('w')) x0 = pt.x;
  if (h.includes('e')) x1 = pt.x;
  if (h.includes('n')) y0 = pt.y;
  if (h.includes('s')) y1 = pt.y;
  if (keepRatio && o.w && o.h && h.length === 2) {
    const r = o.w / o.h;
    let w = Math.abs(x1 - x0), hh = Math.abs(y1 - y0);
    if (w / hh > r) w = hh * r; else hh = w / r;
    if (h.includes('w')) x0 = x1 - w * Math.sign(x1 - x0 || 1); else x1 = x0 + w * Math.sign(x1 - x0 || 1);
    if (h.includes('n')) y0 = y1 - hh * Math.sign(y1 - y0 || 1); else y1 = y0 + hh * Math.sign(y1 - y0 || 1);
  }
  a.x = Math.min(x0, x1); a.y = Math.min(y0, y1);
  a.w = Math.max(Math.abs(x1 - x0), 2); a.h = Math.max(Math.abs(y1 - y0), 2);
}

/* ---- text editing ---- */
function beginTextEdit(p, a, { isNew = false, selectAll = false } = {}) {
  S.editing = null;
  renderOverlay(p);
  const e = S.els.get(p.id);
  const node = e.svg.querySelector(`[data-aid="${a.id}"] .txt`);
  if (!node) return;
  S.editing = { pid: p.id, id: a.id, isNew };
  node.setAttribute('contenteditable', 'plaintext-only');
  if (node.contentEditable !== 'plaintext-only') node.setAttribute('contenteditable', 'true');
  node.spellcheck = false;
  node.focus();
  const r = document.createRange();
  r.selectNodeContents(node);
  if (!selectAll) r.collapse(false);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  node.addEventListener('blur', () => { if (S.editing && S.editing.id === a.id) endTextEdit(); }, { once: true });
  node.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); node.blur(); } ev.stopPropagation(); });
}
function endTextEdit() {
  const ed = S.editing;
  if (!ed) return;
  S.editing = null;
  const p = pageById(ed.pid);
  const a = annotById(p, ed.id);
  if (!p || !a) return;
  const e = S.els.get(p.id);
  const node = e && e.svg.querySelector(`[data-aid="${a.id}"] .txt`);
  let text = node ? node.innerText.replace(/ /g, ' ') : a.text;
  if (text.endsWith('\n')) text = text.slice(0, -1);
  const removeWithCover = () => {
    p.annots = p.annots.filter((x) => x.id !== a.id && x.id !== a.coverId);
    S.sel = null;
  };
  if (!text.trim()) {
    removeWithCover();
    if (!ed.isNew && !a.editOf) commit();
    else if (a.editOf !== undefined) { /* nothing was committed for an untouched run */ }
  } else if (a.editOf !== undefined && text === a.editOf && !a.touched) {
    removeWithCover();                         // user opened a run and changed nothing
  } else {
    const changed = text !== a.text;
    a.text = text;
    a.w = 0; a.h = 0;
    if (a.editOf !== undefined) a.touched = true;
    if (changed || ed.isNew || a.editOf !== undefined) commit();
    S.sel = { pid: p.id, id: a.id };
  }
  renderOverlay(p);
  syncButtons();
  updateProps();
}

/* ---- sampling the page's own colours (so covers blend in) ---- */
const toHex = (c) => '#' + [c[0], c[1], c[2]].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
function renderedCanvas(p) {
  const e = S.els.get(p.id);
  return e && e.canvas.width ? e.canvas : null;
}
/* Most common colour in a thin ring just outside rect r (page points). Returns [r,g,b] or null. */
function sampleBackground(p, r, pad = 2.5) {
  const cv = renderedCanvas(p);
  if (!cv) return null;
  const k = cv.width / p.w;
  const grow = pad + 2.5;
  const x0 = Math.max(0, Math.floor((r.x - grow) * k)), y0 = Math.max(0, Math.floor((r.y - grow) * k));
  const x1 = Math.min(cv.width, Math.ceil((r.x + r.w + grow) * k)), y1 = Math.min(cv.height, Math.ceil((r.y + r.h + grow) * k));
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  const img = cv.getContext('2d').getImageData(x0, y0, x1 - x0, y1 - y0);
  const buckets = new Map();
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const px = (x + 0.5) / k, py = (y + 0.5) / k;
      const dx = Math.max(r.x - px, 0, px - (r.x + r.w)), dy = Math.max(r.y - py, 0, py - (r.y + r.h));
      const d = Math.hypot(dx, dy);
      if (d < pad || d > pad + 2.5) continue;
      const i = ((y - y0) * img.width + (x - x0)) * 4;
      const R = img.data[i], G = img.data[i + 1], B = img.data[i + 2];
      const key = (R >> 3) << 10 | (G >> 3) << 5 | (B >> 3);
      const b = buckets.get(key) || { n: 0, R: 0, G: 0, B: 0 };
      b.n++; b.R += R; b.G += G; b.B += B;
      buckets.set(key, b);
    }
  }
  let best = null;
  for (const b of buckets.values()) if (!best || b.n > best.n) best = b;
  return best ? [best.R / best.n, best.G / best.n, best.B / best.n] : null;
}
/* Darkest/most contrasting ink inside rect r compared with background bg. Returns [r,g,b] or null. */
function sampleInk(p, r, bg) {
  const cv = renderedCanvas(p);
  if (!cv || !bg) return null;
  const k = cv.width / p.w;
  const x0 = Math.max(0, Math.floor(r.x * k)), y0 = Math.max(0, Math.floor(r.y * k));
  const x1 = Math.min(cv.width, Math.ceil((r.x + r.w) * k)), y1 = Math.min(cv.height, Math.ceil((r.y + r.h) * k));
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  const img = cv.getContext('2d').getImageData(x0, y0, x1 - x0, y1 - y0).data;
  let max = 0;
  const dist = (i) => Math.abs(img[i] - bg[0]) + Math.abs(img[i + 1] - bg[1]) + Math.abs(img[i + 2] - bg[2]);
  for (let i = 0; i < img.length; i += 4) max = Math.max(max, dist(i));
  if (max < 150) return null;
  let n = 0, R = 0, G = 0, B = 0;
  for (let i = 0; i < img.length; i += 4) if (dist(i) >= max * 0.85) { n++; R += img[i]; G += img[i + 1]; B += img[i + 2]; }
  return n ? [R / n, G / n, B / n] : null;
}
function matchPageColour(p, cover) {
  const c = sampleBackground(p, { x: cover.x, y: cover.y, w: cover.w, h: cover.h });
  if (!c) { toast('Scroll that page into view first, then try again.'); return false; }
  cover.fill = toHex(c);
  return true;
}
const coverOf = (p, a) => (a && a.coverId ? annotById(p, a.coverId) : null);

/* ---- editing existing page text ---- */
async function ensureRuns(p) {
  if (S.runs.has(p.id)) return S.runs.get(p.id);
  if (p.blank) { S.runs.set(p.id, []); return []; }
  const page = await getPdfPage(p);
  const tc = await page.getTextContent();
  const vp = page.getViewport({ scale: 1 });
  const runs = [];
  let cur = null;
  const flush = () => { if (cur && cur.str.trim()) runs.push(cur); cur = null; };
  for (const it of tc.items) {
    if (!('str' in it)) continue;
    const tx = pdfjsLib.Util.transform(vp.transform, it.transform);
    const size = Math.hypot(tx[2], tx[3]);
    if (!size || Math.abs(tx[1]) > size * 0.05 || Math.abs(tx[2]) > size * 0.05) { flush(); continue; }   // skip rotated text
    const x = tx[4], y = tx[5], w = it.width * (vp.width / p.w || 1);
    // a wide run of spaces is a column gap (labels and values, table cells): keep them as separate runs
    if (!it.str.trim() && it.str && w > size * 1.2) { flush(); continue; }
    if (cur) {
      const gap = x - (cur.x + cur.w);
      if (Math.abs(y - cur.y) > size * 0.35 || gap < -size * 0.5 || gap > size * 1.2) flush();
    }
    if (!cur) {
      const style = tc.styles[it.fontName] || {};
      let name = '';
      try { const f = page.commonObjs.has(it.fontName) ? page.commonObjs.get(it.fontName) : null; name = (f && f.name) || ''; } catch (_) { /* font not loaded yet */ }
      const fam = (style.fontFamily || '') + ' ' + name;
      const family = /mono|courier|consol/i.test(fam) ? 'Courier' : (/serif/i.test(fam) && !/sans/i.test(fam)) || /times|georgia|garamond|palatino|cambria|minion|book/i.test(fam) ? 'Times' : 'Helvetica';
      const asc = clamp(style.ascent || 0.9, 0.7, 1.1), desc = clamp(style.descent || -0.22, -0.45, -0.1);
      cur = { x, y, w: 0, size, str: '', family, bold: /bold|black|heavy|semibold/i.test(name), italic: /italic|oblique/i.test(name), asc, desc };
    }
    const gap = x - (cur.x + cur.w);
    if (cur.str && gap > size * 0.15 && !cur.str.endsWith(' ') && !it.str.startsWith(' ')) cur.str += ' ';
    cur.str += it.str;
    cur.w = x + w - cur.x;
    if (it.hasEOL) flush();
  }
  flush();
  for (const r of runs) { r.top = r.y - r.asc * r.size; r.bottom = r.y - r.desc * r.size; }
  S.runs.set(p.id, runs);
  return runs;
}
function runAt(runs, pt) {
  const pad = 1.5;
  let best = null;
  for (const r of runs) {
    if (pt.x >= r.x - pad && pt.x <= r.x + r.w + pad && pt.y >= r.top - pad && pt.y <= r.bottom + pad) {
      if (!best || r.w < best.w) best = r;
    }
  }
  return best;
}
async function hoverEditRun(ev) {
  const pageEl = ev.target.closest && ev.target.closest('.page');
  let next = null;
  if (pageEl) {
    const p = pageById(pageEl.dataset.pid);
    if (p) {
      const runs = S.runs.get(p.id) || await ensureRuns(p);
      const r = runAt(runs, pagePoint(ev, p));
      if (r) next = { pid: p.id, run: r };
    }
  }
  const prev = S.hoverRun;
  if ((prev && prev.run) === (next && next.run)) return;
  S.hoverRun = next;
  if (prev) { const pp = pageById(prev.pid); if (pp) renderOverlay(pp); }
  if (next) renderOverlay(pageById(next.pid));
}
async function handleEditClick(p, pt) {
  const runs = await ensureRuns(p);
  const r = runAt(runs, pt);
  if (!r) { toast('No editable text there. Try Add text to place new text.'); return; }
  S.hoverRun = null;
  const pad = 1;
  const box = { x: r.x - pad, y: r.top - pad, w: r.w + pad * 2, h: r.bottom - r.top + pad * 2 };
  const bg = sampleBackground(p, box);
  const ink = sampleInk(p, { x: r.x, y: r.top, w: r.w, h: r.bottom - r.top }, bg);
  const cover = newAnnot('cover', { ...box, fill: bg ? toHex(bg) : '#ffffff' });
  const text = newAnnot('text', {
    x: r.x, y: r.y - baselineOffset(r.family, r.size), text: r.str, size: Math.round(r.size * 10) / 10,
    family: r.family, bold: r.bold, italic: r.italic, color: ink ? toHex(ink) : '#000000', editOf: r.str, coverId: cover.id,
  });
  p.annots.push(cover, text);
  S.sel = { pid: p.id, id: text.id };
  renderOverlay(p);
  beginTextEdit(p, text, { selectAll: false });
}
function onDblClick(ev) {
  if (S.tool !== 'select') return;
  const node = ev.target.closest && ev.target.closest('[data-aid]');
  const pageEl = ev.target.closest && ev.target.closest('.page');
  if (!node || !pageEl) return;
  const p = pageById(pageEl.dataset.pid);
  const a = annotById(p, node.dataset.aid);
  if (a && a.type === 'text') { select(p.id, a.id); beginTextEdit(p, a); }
}

/* ---- images + signature ---- */
function visibleCenter() {
  const p = S.pages[S.cur];
  const e = S.els.get(p.id);
  const sc = $('#scroller').getBoundingClientRect();
  const r = e.paper.getBoundingClientRect();
  const vx = clamp(sc.left + sc.width / 2, r.left + 10, r.right - 10);
  const vy = clamp(sc.top + sc.height / 2, r.top + 10, r.bottom - 10);
  return { p, pt: pagePoint({ clientX: vx, clientY: vy }, p) };
}
function placeImage(src, iw, ih, maxW = 220) {
  if (!S.pages.length) return;
  const { p, pt } = visibleCenter();
  const w = Math.min(maxW, iw, p.w * 0.6);
  const h = w * (ih / iw);
  const a = newAnnot('image', { src, x: clamp(pt.x - w / 2, 0, Math.max(0, p.w - w)), y: clamp(pt.y - h / 2, 0, Math.max(0, p.h - h)), w, h });
  addAnnot(p, a);
  setTool('select');
  select(p.id, a.id);
}
async function insertImageFile(file) {
  if (!file) return;
  const url = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; }).catch(() => { toast('That image could not be read.', 'err'); });
  if (!img.naturalWidth) return;
  let src = url;
  if (!/^data:image\/(png|jpeg)/.test(url)) {           // PDFs embed PNG or JPEG only
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    src = c.toDataURL('image/png');
  }
  placeImage(src, img.naturalWidth, img.naturalHeight);
}

function openSignature() {
  if (!S.pages.length) return;
  const n = document.createElement('div');
  let saved = null;
  try { saved = localStorage.getItem('penknife.signature'); } catch (_) { /* storage may be blocked */ }
  n.innerHTML = `<h2>Draw your signature</h2><p>Use the mouse, trackpad, or a pen. It is placed on the page and you can move and resize it.</p>
    <canvas class="sigpad" width="860" height="340"></canvas><div class="sigline"></div>
    <label style="display:flex;gap:6px;align-items:center;color:var(--muted)"><input type="checkbox" id="sig-keep" checked /> Remember it on this device for next time</label>
    <div class="row"><button class="btn outline" data-r="saved" ${saved ? '' : 'hidden'}>Use saved signature</button><button class="btn outline" data-r="clear">Clear</button><button class="btn outline" data-r="cancel">Cancel</button><button class="btn primary" data-r="use">Place signature</button></div>`;
  const close = openModal(n);
  const cv = $('canvas', n), ctx = cv.getContext('2d');
  ctx.lineWidth = 5; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#0f2347';
  let down = false, any = false, last = null;
  const pos = (e) => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * cv.width / r.width, (e.clientY - r.top) * cv.height / r.height]; };
  cv.addEventListener('pointerdown', (e) => { down = true; any = true; last = pos(e); cv.setPointerCapture(e.pointerId); ctx.beginPath(); ctx.moveTo(...last); ctx.lineTo(last[0] + 0.1, last[1]); ctx.stroke(); });
  cv.addEventListener('pointermove', (e) => { if (!down) return; const q = pos(e); ctx.beginPath(); ctx.moveTo(...last); ctx.lineTo(...q); ctx.stroke(); last = q; });
  const up = () => { down = false; };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  const finish = (dataUrl, w, h) => { close(); placeImage(dataUrl, w, h, 170); };
  n.addEventListener('click', (e) => {
    const b = e.target.closest('[data-r]');
    if (!b) return;
    const r = b.dataset.r;
    if (r === 'cancel') close();
    if (r === 'clear') { ctx.clearRect(0, 0, cv.width, cv.height); any = false; }
    if (r === 'saved' && saved) { const im = new Image(); im.onload = () => finish(saved, im.naturalWidth, im.naturalHeight); im.src = saved; }
    if (r === 'use') {
      if (!any) { toast('Draw your signature first.'); return; }
      const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
      let x0 = cv.width, y0 = cv.height, x1 = 0, y1 = 0;
      for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) if (d[(y * cv.width + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      const pad = 6; x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(cv.width, x1 + pad); y1 = Math.min(cv.height, y1 + pad);
      const out = document.createElement('canvas'); out.width = x1 - x0; out.height = y1 - y0;
      out.getContext('2d').drawImage(cv, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
      const url = out.toDataURL('image/png');
      if ($('#sig-keep', n).checked) { try { localStorage.setItem('penknife.signature', url); } catch (_) { /* ignore */ } }
      finish(url, out.width / 2, out.height / 2);
    }
  });
}

/* ---- properties row ---- */
function activeContext() {
  const [, a] = selected();
  if (a) return a.type === 'cover' ? 'cover' : a.type;
  return S.tool;
}
function updateProps() {
  const ctx = activeContext();
  const [, a] = selected();
  const st = S.style;
  const src = a || null;
  $$('#props .grp').forEach((g) => { g.hidden = !g.dataset.for.split(' ').includes(ctx); });
  const hint = $('#p-hint');
  hint.hidden = false;
  hint.textContent = a ? (a.type === 'image' ? 'Drag to move. Drag the handles to resize. Press Delete to remove.' : a.type === 'text' ? 'Double-click to edit the text. Drag to move.' : 'Drag to move. Press Delete to remove.') : (TOOL_HINTS[S.tool] || '');
  if (a && (a.type === 'rect' || a.type === 'ellipse' || a.type === 'line' || a.type === 'ink')) {
    $('#p-width').value = String(a.sw);
  } else $('#p-width').value = String(st.width);
  const colorNow = src && (src.type === 'text' ? src.color : src.stroke) || st.color;
  $('#p-color').value = colorNow;
  $$('#p-swatches .sw').forEach((s) => s.classList.toggle('on', s.dataset.c.toLowerCase() === colorNow.toLowerCase()));
  const hl = src && src.type === 'highlight' ? src.fill : st.hl;
  $$('#p-hl .sw').forEach((s) => s.classList.toggle('on', s.dataset.c === hl));
  const fillOn = src && (src.type === 'rect' || src.type === 'ellipse') ? !!src.fill : st.fillOn;
  $('#p-fillon').checked = fillOn;
  $('#p-fill').value = (src && src.fill && src.type !== 'highlight' && src.type !== 'cover' ? src.fill : st.fill);
  $('#p-arrow').checked = src && src.type === 'line' ? !!src.arrow : st.arrow;
  const cv = src && src.type === 'cover' ? src : null;
  if (cv) $('#p-cover').value = cv.fill || '#ffffff';
  const linked = src && src.type === 'text' ? coverOf(selected()[0], src) : null;
  $('#p-bg').hidden = !linked;
  if (linked) $('#p-bgc').value = linked.fill || '#ffffff';
  const t = src && src.type === 'text' ? src : st;
  $('#p-family').value = t.family;
  $('#p-size').value = Math.round(t.size * 10) / 10;
  $('#p-bold').classList.toggle('on', !!t.bold);
  $('#p-italic').classList.toggle('on', !!t.italic);
}
function applyProp(prop, value) {
  const st = S.style;
  const [p, a] = selected();
  st[prop] = value;
  if (!a) return;
  switch (prop) {
    case 'color': if (a.type === 'text') a.color = value; else if (a.stroke !== undefined) a.stroke = value; break;
    case 'hl': if (a.type === 'highlight') a.fill = value; break;
    case 'width': if (a.sw !== undefined) a.sw = +value; break;
    case 'fillOn': if (a.type === 'rect' || a.type === 'ellipse') a.fill = value ? st.fill : null; break;
    case 'fill': if ((a.type === 'rect' || a.type === 'ellipse') && st.fillOn) a.fill = value; break;
    case 'arrow': if (a.type === 'line') a.arrow = !!value; break;
    case 'family': case 'size': case 'bold': case 'italic':
      if (a.type === 'text') { a[prop] = value; a.w = 0; a.h = 0; }
      break;
  }
  commit();
  renderOverlay(p);
  updateProps();
}

function buildPropControls() {
  const sw = $('#p-swatches');
  SWATCHES.forEach((c) => { const b = document.createElement('button'); b.className = 'sw'; b.style.background = c; b.dataset.c = c; b.title = c; b.setAttribute('aria-label', 'Colour ' + c); sw.appendChild(b); });
  sw.addEventListener('click', (e) => { const b = e.target.closest('.sw'); if (b) applyProp('color', b.dataset.c); });
  const hl = $('#p-hl');
  HL_SWATCHES.forEach((c) => { const b = document.createElement('button'); b.className = 'sw'; b.style.background = c; b.dataset.c = c; b.setAttribute('aria-label', 'Highlight ' + c); hl.appendChild(b); });
  hl.addEventListener('click', (e) => { const b = e.target.closest('.sw'); if (b) applyProp('hl', b.dataset.c); });
  $('#p-color').addEventListener('input', (e) => applyProp('color', e.target.value));
  const setFill = (getCover, how) => {
    const [p, a] = selected();
    const cov = getCover(p, a);
    if (!cov) return;
    if (how === 'match') { if (!matchPageColour(p, cov)) return; } else cov.fill = how;
    commit(); renderOverlay(p); updateProps();
  };
  const self = (p, a) => (a && a.type === 'cover' ? a : null);
  $('#p-cover').addEventListener('change', (e) => setFill(self, e.target.value));
  $('#p-match').addEventListener('click', () => setFill(self, 'match'));
  $('#p-bgc').addEventListener('change', (e) => setFill(coverOf, e.target.value));
  $('#p-bgmatch').addEventListener('click', () => setFill(coverOf, 'match'));
  $('#p-fillon').addEventListener('change', (e) => applyProp('fillOn', e.target.checked));
  $('#p-fill').addEventListener('input', (e) => { S.style.fillOn = true; $('#p-fillon').checked = true; applyProp('fill', e.target.value); });
  $('#p-width').addEventListener('change', (e) => applyProp('width', e.target.value));
  $('#p-arrow').addEventListener('change', (e) => applyProp('arrow', e.target.checked));
  $('#p-family').addEventListener('change', (e) => applyProp('family', e.target.value));
  $('#p-size').addEventListener('change', (e) => applyProp('size', clamp(+e.target.value || 14, 4, 200)));
  $('#p-bold').addEventListener('click', () => { const [, a] = selected(); applyProp('bold', !(a && a.type === 'text' ? a.bold : S.style.bold)); });
  $('#p-italic').addEventListener('click', () => { const [, a] = selected(); applyProp('italic', !(a && a.type === 'text' ? a.italic : S.style.italic)); });
}

/* ---- page operations (thumbnail rail) ---- */
function rotatePage(i, dir) {
  const p = S.pages[i];
  p.rot = (p.rot + dir + 360) % 360;
  commit();
  renderAll();
  scrollToPage(S.cur);
}
function deletePage(i) {
  if (S.pages.length <= 1) { toast('A document needs at least one page.'); return; }
  const gone = S.pages.splice(i, 1)[0];
  S.runs.delete(gone.id);
  if (S.sel && S.sel.pid === gone.id) S.sel = null;
  S.cur = clamp(S.cur, 0, S.pages.length - 1);
  commit();
  renderAll();
  scrollToPage(S.cur);
}
function insertBlank() {
  if (!S.pages.length) return;
  const ref = S.pages[S.cur];
  const np = { id: uid(), docId: null, srcIndex: 0, blank: true, rot: 0, baseRot: 0, w: ref.w, h: ref.h, annots: [] };
  S.pages.splice(S.cur + 1, 0, np);
  S.cur += 1;
  commit();
  renderAll();
  scrollToPage(S.cur);
}
function movePage(from, to) {
  if (from === to || from + 1 === to) return;
  const [p] = S.pages.splice(from, 1);
  const at = to > from ? to - 1 : to;
  S.pages.splice(at, 0, p);
  S.cur = at;
  commit();
  renderAll();
  scrollToPage(S.cur);
}

function wireThumbs() {
  const box = $('#thumbs');
  let dragFrom = null;
  box.addEventListener('click', (e) => {
    const t = e.target.closest('.thumb');
    if (!t) return;
    const i = $$('.thumb').indexOf(t);
    const act = e.target.closest('[data-a]');
    if (act) {
      const a = act.dataset.a;
      if (a === 'rl') rotatePage(i, -90);
      else if (a === 'rr') rotatePage(i, 90);
      else if (a === 'del') deletePage(i);
      return;
    }
    setCurrent(i);
    scrollToPage(i, true);
  });
  box.addEventListener('dragstart', (e) => {
    const t = e.target.closest('.thumb');
    if (!t) return;
    dragFrom = $$('.thumb').indexOf(t);
    t.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(dragFrom));
  });
  box.addEventListener('dragend', () => { dragFrom = null; $$('.thumb').forEach((t) => t.classList.remove('dragging', 'drop-before', 'drop-after')); });
  box.addEventListener('dragover', (e) => {
    if (dragFrom === null) return;
    e.preventDefault();
    const t = e.target.closest('.thumb');
    $$('.thumb').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
    if (!t) return;
    const r = t.getBoundingClientRect();
    t.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
  });
  box.addEventListener('drop', (e) => {
    if (dragFrom === null) return;
    e.preventDefault();
    const t = e.target.closest('.thumb');
    if (!t) return;
    const i = $$('.thumb').indexOf(t);
    const r = t.getBoundingClientRect();
    const to = e.clientY < r.top + r.height / 2 ? i : i + 1;
    const from = dragFrom;
    dragFrom = null;
    movePage(from, to);
  });
}
