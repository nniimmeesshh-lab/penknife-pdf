/* Penknife PDF - document loading and rendering. MIT License. */

/* ---- loading ---- */
async function openPdfBytes(bytes, name, { mode = 'replace', insertAfter = null } = {}) {
  let encrypted = false;
  const task = pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false });
  task.onPassword = async (update, reason) => {
    encrypted = true;
    const pw = await askPassword(reason === 2);
    if (pw === null) task.destroy(); else update(pw);
  };
  let pdf;
  try {
    pdf = await task.promise;
  } catch (err) {
    if (err && err.name === 'PasswordException') return false;
    console.error(err);
    toast('Could not open that file. It may be damaged or not a PDF.', 'err');
    return false;
  }
  const docId = uid();
  S.docs[docId] = { id: docId, name, bytes, pdf, encrypted };
  const pages = [];
  for (let i = 0; i < pdf.numPages; i++) {
    const pg = await pdf.getPage(i + 1);
    const vp = pg.getViewport({ scale: 1 });
    pages.push({ id: uid(), docId, srcIndex: i, blank: false, rot: 0, baseRot: ((pg.rotate % 360) + 360) % 360, w: vp.width, h: vp.height, annots: [] });
  }
  if (mode === 'replace') {
    S.pages = pages;
    S.fileName = name;
    S.cur = 0; S.sel = null; S.editing = null;
    S.runs.clear();
    S.dirty = false;
    resetHistory();
  } else {
    const at = insertAfter === null ? S.pages.length : insertAfter + 1;
    S.pages.splice(at, 0, ...pages);
    commit();
    S.cur = at;
  }
  renderAll();
  if (mode !== 'replace') scrollToPage(S.cur);
  return true;
}

async function openFile(file) {
  if (!file) return;
  if (S.pages.length && S.dirty) {
    const ok = await confirmModal('Discard unsaved changes?', 'Opening another file will close this one. Changes you have not saved will be lost.', 'Discard and open');
    if (!ok) return;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  await openPdfBytes(bytes, file.name || 'document.pdf');
}

async function getPdfPage(p) {
  return S.docs[p.docId].pdf.getPage(p.srcIndex + 1);
}

/* ---- layout helpers ---- */
const isSideways = (p) => p.rot % 180 !== 0;
function rotorSize(p) {
  const w = p.w * S.scale, h = p.h * S.scale;
  return isSideways(p) ? { rw: h, rh: w, pw: w, ph: h } : { rw: w, rh: h, pw: w, ph: h };
}

/* ---- the page column ---- */
let pageObserver = null;
function renderAll() {
  const holder = $('#pages');
  holder.textContent = '';
  S.els.clear();
  if (pageObserver) pageObserver.disconnect();
  pageObserver = new IntersectionObserver((entries) => {
    for (const en of entries) {
      const pid = en.target.dataset.pid;
      const p = pageById(pid);
      if (!p) continue;
      if (en.isIntersecting) paintPage(p); else releasePage(p);
    }
  }, { root: $('#scroller'), rootMargin: '1200px 0px' });

  S.pages.forEach((p, i) => {
    const e = buildPageEl(p, i);
    holder.appendChild(e.root);
    S.els.set(p.id, e);
    renderOverlay(p);
    pageObserver.observe(e.root);
  });
  $('#empty').hidden = S.pages.length > 0;
  $('#pgtot').textContent = S.pages.length;
  renderThumbs();
  updateChrome();
}

function buildPageEl(p, i) {
  const { rw, rh, pw, ph } = rotorSize(p);
  const root = document.createElement('section');
  root.className = 'page';
  root.dataset.pid = p.id;
  root.style.width = rw + 'px';
  root.style.height = rh + 'px';
  const rotor = document.createElement('div');
  rotor.className = 'rotor';
  rotor.style.width = rw + 'px';
  rotor.style.height = rh + 'px';
  const paper = document.createElement('div');
  paper.className = 'paper';
  paper.style.width = pw + 'px';
  paper.style.height = ph + 'px';
  paper.style.left = (rw - pw) / 2 + 'px';
  paper.style.top = (rh - ph) / 2 + 'px';
  paper.style.transform = p.rot ? `rotate(${p.rot}deg)` : '';
  const canvas = document.createElement('canvas');
  canvas.style.width = pw + 'px';
  canvas.style.height = ph + 'px';
  const tl = document.createElement('div');
  tl.className = 'textLayer';
  tl.style.width = pw + 'px';
  tl.style.height = ph + 'px';
  const svg = svgEl('svg', { class: 'ov', width: p.w, height: p.h, viewBox: `0 0 ${p.w} ${p.h}` });
  svg.style.transform = `scale(${S.scale})`;
  paper.append(canvas, tl, svg);
  rotor.appendChild(paper);
  const no = document.createElement('div');
  no.className = 'pgno';
  no.textContent = i + 1;
  root.append(rotor, no);
  return { root, paper, canvas, tl, svg, rendered: null, task: null };
}

async function paintPage(p) {
  const e = S.els.get(p.id);
  if (!e || e.rendered === S.scale) return;
  e.rendered = S.scale;
  const token = (e.token = (e.token || 0) + 1);
  const { pw, ph } = rotorSize(p);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let k = S.scale * dpr;
  while (p.w * p.h * k * k > 28e6) k *= 0.85;
  const cw = Math.ceil(p.w * k), ch = Math.ceil(p.h * k);
  e.canvas.width = cw; e.canvas.height = ch;
  e.canvas.style.width = pw + 'px'; e.canvas.style.height = ph + 'px';
  const ctx = e.canvas.getContext('2d');
  if (p.blank) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cw, ch); return; }
  try {
    const page = await getPdfPage(p);
    if (token !== e.token) return;
    const vp = page.getViewport({ scale: cw / p.w });
    if (e.task) { try { e.task.cancel(); } catch (_) {} }
    e.task = page.render({ canvasContext: ctx, canvas: e.canvas, viewport: vp });
    await e.task.promise;
    if (token !== e.token) return;
    // selectable text layer
    e.tl.textContent = '';
    e.tl.style.setProperty('--scale-factor', S.scale);
    const tvp = page.getViewport({ scale: S.scale });
    const layer = new pdfjsLib.TextLayer({ textContentSource: page.streamTextContent(), container: e.tl, viewport: tvp });
    await layer.render();
  } catch (err) {
    if (err && err.name === 'RenderingCancelledException') return;
    e.rendered = null;
    console.warn('render failed', err);
  }
}
function releasePage(p) {
  const e = S.els.get(p.id);
  if (!e || e.rendered === null) return;
  e.token = (e.token || 0) + 1;
  if (e.task) { try { e.task.cancel(); } catch (_) {} e.task = null; }
  e.canvas.width = 0; e.canvas.height = 0;
  e.tl.textContent = '';
  e.rendered = null;
}

/* ---- thumbnails ---- */
let thumbObserver = null;
const THUMB_W = 112;
function renderThumbs() {
  const box = $('#thumbs');
  box.textContent = '';
  if (thumbObserver) thumbObserver.disconnect();
  thumbObserver = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) { paintThumb(en.target); thumbObserver.unobserve(en.target); }
  }, { root: box, rootMargin: '300px 0px' });
  S.pages.forEach((p, i) => {
    const t = document.createElement('div');
    t.className = 'thumb' + (i === S.cur ? ' cur' : '');
    t.dataset.pid = p.id;
    t.draggable = true;
    const sc = THUMB_W / Math.max(p.w, p.h);
    const bw = (isSideways(p) ? p.h : p.w) * sc, bh = (isSideways(p) ? p.w : p.h) * sc;
    t.innerHTML = `<div class="tbox" style="width:${bw}px;height:${bh}px"><canvas></canvas></div><div class="tno">${i + 1}</div>
      <div class="tact"><button data-a="rl" title="Rotate left"><svg data-icon="rotl"></svg></button><button data-a="rr" title="Rotate right"><svg data-icon="rotr"></svg></button><button data-a="del" title="Delete page"><svg data-icon="trash"></svg></button></div>`;
    paintIcons(t);
    box.appendChild(t);
    thumbObserver.observe(t);
  });
}
async function paintThumb(t) {
  const p = pageById(t.dataset.pid);
  if (!p) return;
  const canvas = $('canvas', t);
  const sc = THUMB_W / Math.max(p.w, p.h);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cw = Math.ceil(p.w * sc * dpr), ch = Math.ceil(p.h * sc * dpr);
  canvas.width = cw; canvas.height = ch;
  canvas.style.width = p.w * sc + 'px'; canvas.style.height = p.h * sc + 'px';
  canvas.style.transform = `translate(-50%,-50%) rotate(${p.rot}deg)`;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cw, ch);
  if (p.blank) return;
  try {
    const page = await getPdfPage(p);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: cw / base.width });
    await page.render({ canvasContext: ctx, canvas, viewport: vp }).promise;
  } catch (_) { /* ignore */ }
}

/* ---- navigation / zoom ---- */
function scrollToPage(i, smooth = false) {
  const p = S.pages[i];
  if (!p) return;
  const e = S.els.get(p.id);
  if (!e) return;
  const sc = $('#scroller');
  sc.scrollTo({ top: e.root.offsetTop - 14, behavior: smooth ? 'smooth' : 'auto' });
}
function currentFromScroll() {
  const sc = $('#scroller');
  const mid = sc.scrollTop + sc.clientHeight * 0.4;
  let best = 0;
  for (let i = 0; i < S.pages.length; i++) {
    const e = S.els.get(S.pages[i].id);
    if (!e) continue;
    if (e.root.offsetTop <= mid) best = i; else break;
  }
  return best;
}
function setCurrent(i) {
  if (i === S.cur) return;
  S.cur = i;
  updateChrome();
  $$('.thumb').forEach((t, j) => t.classList.toggle('cur', j === i));
  const t = $$('.thumb')[i];
  if (t) t.scrollIntoView({ block: 'nearest' });
}
function setScale(next, anchor = true) {
  next = clamp(Math.round(next * 100) / 100, 0.25, 4);
  if (next === S.scale || !S.pages.length) return;
  const sc = $('#scroller');
  const ratio = next / S.scale;
  const cx = sc.scrollLeft + sc.clientWidth / 2, cy = sc.scrollTop + sc.clientHeight / 2;
  S.scale = next;
  const keepSel = S.sel;
  renderAll();
  S.sel = keepSel;
  S.pages.forEach(renderOverlay);
  if (anchor) { sc.scrollLeft = cx * ratio - sc.clientWidth / 2; sc.scrollTop = cy * ratio - sc.clientHeight / 2; }
  updateChrome();
}
function fitWidth() {
  if (!S.pages.length) return;
  const p = S.pages[S.cur] || S.pages[0];
  const w = isSideways(p) ? p.h : p.w;
  const avail = $('#scroller').clientWidth - 48;
  setScale(avail / w);
}

/* ---- annotation overlay ---- */
function renderOverlay(p) {
  const e = S.els.get(p.id);
  if (!e) return;
  if (S.editing && S.editing.pid === p.id) return;   // never wipe an element being typed into
  const svg = e.svg;
  svg.textContent = '';
  for (const a of p.annots) svg.appendChild(annotNode(a));
  if (S.tmp && S.tmp.pid === p.id) svg.appendChild(annotNode(S.tmp.annot, true));
  if (S.hoverRun && S.hoverRun.pid === p.id) {
    const r = S.hoverRun.run;
    svgEl('rect', { class: 'runbox', x: r.x, y: r.top, width: r.w, height: r.bottom - r.top }, svg);
  }
  if (S.sel && S.sel.pid === p.id) {
    const a = annotById(p, S.sel.id);
    if (a) drawSelection(svg, a);
  }
  if (a_measureNeeded(p)) measureTexts(p);
}
function a_measureNeeded(p) { return p.annots.some((a) => a.type === 'text' && !a.w); }

function annotNode(a, ghost = false) {
  const g = svgEl('g', ghost ? {} : { 'data-aid': a.id });
  switch (a.type) {
    case 'rect':
    case 'cover':
    case 'highlight': {
      const attrs = { x: a.x, y: a.y, width: Math.max(a.w, 0), height: Math.max(a.h, 0) };
      if (a.type === 'highlight') { attrs.fill = a.fill; attrs.opacity = 0.45; attrs.style = 'mix-blend-mode:multiply'; }
      else if (a.type === 'cover') { attrs.fill = a.fill || '#ffffff'; }
      else { attrs.fill = a.fill || 'none'; attrs.stroke = a.stroke; attrs['stroke-width'] = a.sw; }
      svgEl('rect', attrs, g);
      break;
    }
    case 'ellipse':
      svgEl('ellipse', { cx: a.x + a.w / 2, cy: a.y + a.h / 2, rx: Math.max(a.w / 2, 0), ry: Math.max(a.h / 2, 0), fill: a.fill || 'none', stroke: a.stroke, 'stroke-width': a.sw }, g);
      break;
    case 'line': {
      svgEl('line', { x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, stroke: 'transparent', 'stroke-width': Math.max(a.sw, 10) }, g);
      svgEl('line', { x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, stroke: a.stroke, 'stroke-width': a.sw, 'stroke-linecap': 'round' }, g);
      if (a.arrow) {
        const pts = arrowHead(a);
        svgEl('path', { d: `M${pts[0][0]} ${pts[0][1]}L${a.x2} ${a.y2}L${pts[1][0]} ${pts[1][1]}`, fill: 'none', stroke: a.stroke, 'stroke-width': a.sw, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, g);
      }
      break;
    }
    case 'ink': {
      const d = a.points.map((q, i) => (i ? 'L' : 'M') + q[0].toFixed(2) + ' ' + q[1].toFixed(2)).join('');
      svgEl('path', { d, fill: 'none', stroke: 'transparent', 'stroke-width': Math.max(a.sw, 10) }, g);
      svgEl('path', { d: a.points.length === 1 ? d + 'l0.01 0' : d, fill: 'none', stroke: a.stroke, 'stroke-width': a.sw, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, g);
      break;
    }
    case 'image':
      svgEl('image', { href: a.src, x: a.x, y: a.y, width: a.w, height: a.h, preserveAspectRatio: 'none' }, g);
      break;
    case 'text': {
      const fo = svgEl('foreignObject', { x: a.x, y: a.y, width: 3000, height: 3000 }, g);
      const d = document.createElementNS(XHTML, 'div');
      d.setAttribute('class', 'txt');
      d.setAttribute('style', textStyle(a));
      d.textContent = a.text;
      fo.appendChild(d);
      break;
    }
  }
  return g;
}
function textStyle(a) {
  return `font:${a.italic ? 'italic ' : ''}${a.bold ? 'bold ' : ''}${a.size}px/${LINE_H} ${FONT_CSS[a.family] || FONT_CSS.Helvetica};color:${a.color};`;
}
function arrowHead(a) {
  const ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
  const len = 7 + a.sw * 2.2, spread = Math.PI / 7;
  return [
    [a.x2 - len * Math.cos(ang - spread), a.y2 - len * Math.sin(ang - spread)],
    [a.x2 - len * Math.cos(ang + spread), a.y2 - len * Math.sin(ang + spread)],
  ];
}
function measureTexts(p) {
  const e = S.els.get(p.id);
  if (!e) return;
  let changed = false;
  for (const a of p.annots) {
    if (a.type !== 'text') continue;
    const node = e.svg.querySelector(`[data-aid="${a.id}"] .txt`);
    if (!node) continue;
    const w = node.offsetWidth, h = node.offsetHeight;
    if (w && h && (a.w !== w || a.h !== h)) { a.w = w; a.h = h; changed = true; }
  }
  if (changed) {
    // keep the history snapshot in sync so measuring does not look like an edit
    const snap = S.last && S.last.find((q) => q.id === p.id);
    if (snap) for (const a of p.annots) { const b = snap.annots.find((q) => q.id === a.id); if (b) { b.w = a.w; b.h = a.h; } }
    renderOverlay(p);
  }
}

function drawSelection(svg, a) {
  const b = bbox(a);
  const hs = 9 / S.scale;
  const pad = a.type === 'text' ? 2 : 0;
  svgEl('rect', { class: 'selbox', x: b.x - pad, y: b.y - pad, width: b.w + pad * 2, height: b.h + pad * 2 }, svg);
  if (a.type === 'text' || a.type === 'ink') return;
  const put = (id, x, y) => svgEl('rect', { class: 'handle', 'data-h': id, x: x - hs / 2, y: y - hs / 2, width: hs, height: hs, rx: hs / 5 }, svg);
  if (a.type === 'line') { put('p1', a.x1, a.y1); put('p2', a.x2, a.y2); return; }
  const { x, y, w, h } = b;
  put('nw', x, y); put('n', x + w / 2, y); put('ne', x + w, y);
  put('e', x + w, y + h / 2); put('se', x + w, y + h); put('s', x + w / 2, y + h);
  put('sw', x, y + h); put('w', x, y + h / 2);
}

/* ---- pointer -> page coordinates (handles on-screen rotation) ---- */
function pagePoint(ev, p) {
  const e = S.els.get(p.id);
  const r = e.paper.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const vx = ev.clientX - cx, vy = ev.clientY - cy;
  const th = (p.rot * Math.PI) / 180;
  const ux = vx * Math.cos(th) + vy * Math.sin(th);
  const uy = -vx * Math.sin(th) + vy * Math.cos(th);
  const pw = p.w * S.scale, ph = p.h * S.scale;
  return { x: (ux + pw / 2) / S.scale, y: (uy + ph / 2) / S.scale };
}

/* ---- toolbar state ---- */
function updateChrome() {
  const has = S.pages.length > 0;
  $('#pgin').value = has ? S.cur + 1 : 0;
  $('#pgtot').textContent = S.pages.length;
  $('#zoomread').textContent = Math.round(S.scale * 100) + '%';
  $('#fname').textContent = has ? S.fileName : '';
  $('#dirty').hidden = !(has && S.dirty);
  $('#b-save').disabled = !has;
  document.title = (has ? S.fileName + (S.dirty ? ' • ' : ' - ') : '') + 'Penknife PDF';
  $$('.tool, #b-blank, #b-merge, #b-fit, #b-zin, #b-zout, #b-prev, #b-next, #pgin').forEach((b) => { if (!b.id || b.id !== 't-sign') b.disabled = !has; });
  syncButtons();
}
function syncButtons() {
  $('#b-undo').disabled = !S.undo.length;
  $('#b-redo').disabled = !S.redo.length;
  $('#b-delete').disabled = !S.sel;
  $('#dirty').hidden = !(S.pages.length && S.dirty);
}
