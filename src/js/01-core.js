/* Penknife PDF - core state, helpers, icons. MIT License. */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const uid = () => Math.random().toString(36).slice(2, 10);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const SVGNS = 'http://www.w3.org/2000/svg';
const XHTML = 'http://www.w3.org/1999/xhtml';
const A4 = { w: 595.28, h: 841.89 };

const { PDFDocument, StandardFonts, rgb, degrees, LineCapStyle } = window.PDFLib;

/* ---- icons: 24px grid, stroke only ---- */
const ICONS = {
  cursor: 'M5 3l13 7-6 2-2 6z',
  edittext: 'M4 20h7 M14 5l5 5-8 8H6v-5z',
  text: 'M5 6V4h14v2 M12 4v16 M9 20h6',
  marker: 'M4 20h6 M15 4l5 5-9 9-5 1 1-5z',
  pen: 'M3 17c2.5-7 4.5-7 6-2.5s3.5 3 6-3 4-3 6-1',
  rect: 'M4 6h16v12H4z',
  ellipse: 'M12 5c5 0 9 3 9 7s-4 7-9 7-9-3-9-7 4-7 9-7z',
  line: 'M5 19L19 5 M10 5h9v9',
  eraser: 'M14 4l6 6-9 9H6l-3-3z M9 9l6 6 M12 19h9',
  image: 'M4 5h16v14H4z M4 16l5-5 4 4 3-3 4 4 M15.5 9.5h.01',
  sign: 'M3 17c3 0 4-8 6-8s0 8 3 8 3-5 5-5 2 3 4 3 M3 21h18',
  open: 'M3 7h6l2 2h10v10H3z',
  save: 'M12 4v11 M7 11l5 5 5-5 M5 20h14',
  undo: 'M9 14L4 9l5-5 M4 9h10a6 6 0 010 12h-3',
  redo: 'M15 14l5-5-5-5 M20 9H10a6 6 0 000 12h3',
  plus: 'M5 12h14 M12 5v14',
  minus: 'M5 12h14',
  fit: 'M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5',
  panel: 'M4 5h16v14H4z M9 5v14',
  up: 'M6 15l6-6 6 6',
  down: 'M6 9l6 6 6-6',
  rotl: 'M3 12a9 9 0 109-9 M3 4v6h6',
  rotr: 'M21 12a9 9 0 11-9-9 M21 4v6h-6',
  trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13',
  pageplus: 'M6 3h8l4 4v14H6z M12 10v6 M9 13h6',
  merge: 'M8 3h8l4 4v10H8z M4 7v14h12',
};
function iconSvg(name) {
  return `<path d="${ICONS[name] || ''}"/>`;
}
function paintIcons(root = document) {
  $$('svg[data-icon]', root).forEach((s) => {
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '1.7');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    s.innerHTML = iconSvg(s.dataset.icon);
  });
}

/* ---- application state ----
   Annotation coordinates are in points (1/72in) in the page's "base view":
   the page as pdf.js first displays it (its own /Rotate applied), origin top-left, y down.
   `rot` on a page is an extra user rotation applied on top (0/90/180/270). */
const S = {
  docs: {},            // docId -> { id, name, bytes, pdf, encrypted }
  pages: [],           // { id, docId, srcIndex, blank, rot, baseRot, w, h, annots[] }
  cur: 0,
  scale: 1.25,
  tool: 'select',
  sel: null,           // { pid, id }
  editing: null,       // { pid, id }
  tmp: null,           // transient annotation being drawn { pid, annot }
  hoverRun: null,      // { pid, run }
  els: new Map(),      // pid -> element refs
  runs: new Map(),     // pid -> text runs cache
  undo: [], redo: [], last: null,
  fileName: 'document.pdf',
  dirty: false,
  style: {
    color: '#111827', fillOn: false, fill: '#fff3a0', width: 2, arrow: false,
    hl: '#ffe45c', family: 'Helvetica', size: 14, bold: false, italic: false,
  },
};

const SWATCHES = ['#111827', '#d1342f', '#2c52c4', '#1f7a4d', '#e08a00', '#7a3fc4'];
const HL_SWATCHES = ['#ffe45c', '#8ff0a4', '#ff9ec4', '#8cd3ff', '#ffb357'];

/* ---- toasts + modal ---- */
function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), kind === 'err' ? 6500 : 3200);
}
function openModal(node) {
  const root = $('#modal-root');
  root.textContent = '';
  const box = document.createElement('div');
  box.className = 'modal';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.appendChild(node);
  root.appendChild(box);
  root.hidden = false;
  return () => { root.hidden = true; root.textContent = ''; };
}
function confirmModal(title, text, okLabel = 'OK') {
  return new Promise((resolve) => {
    const n = document.createElement('div');
    n.innerHTML = `<h2></h2><p></p><div class="row"><button class="btn outline" data-r="0">Cancel</button><button class="btn primary" data-r="1"></button></div>`;
    $('h2', n).textContent = title;
    $('p', n).textContent = text;
    $('[data-r="1"]', n).textContent = okLabel;
    const close = openModal(n);
    n.addEventListener('click', (e) => {
      const b = e.target.closest('[data-r]');
      if (!b) return;
      close();
      resolve(b.dataset.r === '1');
    });
    $('[data-r="1"]', n).focus();
  });
}
function askPassword(wrong) {
  return new Promise((resolve) => {
    const n = document.createElement('form');
    n.innerHTML = `<h2>This PDF is password protected</h2><p></p><input type="password" id="pw" autocomplete="off" aria-label="Password" /><div class="row"><button type="button" class="btn outline" data-r="cancel">Cancel</button><button class="btn primary">Open</button></div>`;
    $('p', n).textContent = wrong ? 'That password was not right. Try again.' : 'Enter the password to view it. You can read it here, but saving edits to protected files is not supported yet.';
    const close = openModal(n);
    n.addEventListener('submit', (e) => { e.preventDefault(); const v = $('#pw', n).value; close(); resolve(v); });
    n.addEventListener('click', (e) => { if (e.target.closest('[data-r="cancel"]')) { close(); resolve(null); } });
    $('#pw', n).focus();
  });
}

/* ---- tiny SVG helper ---- */
function svgEl(tag, attrs = {}, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) if (attrs[k] !== undefined && attrs[k] !== null) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}

/* ---- font metrics (CSS preview and PDF output must agree) ---- */
const FONT_CSS = {
  Helvetica: 'Helvetica, Arial, "Nirmala UI", "Noto Sans", sans-serif',
  Times: '"Times New Roman", Times, "Nirmala UI", "Noto Serif", serif',
  Courier: '"Courier New", Courier, "Nirmala UI", monospace',
};
const FONT_ASC = { Helvetica: [0.905, 0.212], Times: [0.891, 0.216], Courier: [0.833, 0.300] };
const LINE_H = 1.2;
function baselineOffset(family, size) {
  const [a, d] = FONT_ASC[family] || FONT_ASC.Helvetica;
  return ((LINE_H - (a + d)) / 2 + a) * size;
}
function pdfFontName(family, bold, italic) {
  const m = {
    Helvetica: ['Helvetica', 'HelveticaBold', 'HelveticaOblique', 'HelveticaBoldOblique'],
    Times: ['TimesRoman', 'TimesRomanBold', 'TimesRomanItalic', 'TimesRomanBoldItalic'],
    Courier: ['Courier', 'CourierBold', 'CourierOblique', 'CourierBoldOblique'],
  }[family] || ['Helvetica', 'HelveticaBold', 'HelveticaOblique', 'HelveticaBoldOblique'];
  return StandardFonts[m[(bold ? 1 : 0) + (italic ? 2 : 0)]];
}
function hexToRgb(hex) {
  const h = (hex || '#000000').replace('#', '');
  const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(f, 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/* ---- history ---- */
function clonePages(pages) {
  // annotations are treated as immutable-by-value once committed, so a shallow copy per annotation is enough
  return pages.map((p) => ({ ...p, annots: p.annots.map((a) => ({ ...a })) }));
}
function resetHistory() {
  S.undo = []; S.redo = [];
  S.last = clonePages(S.pages);
  syncButtons();
}
function commit(markDirty = true) {
  S.undo.push(S.last);
  if (S.undo.length > 120) S.undo.shift();
  S.redo = [];
  S.last = clonePages(S.pages);
  if (markDirty) S.dirty = true;
  syncButtons();
}
function restore(snap) {
  S.pages = clonePages(snap);
  S.sel = null; S.editing = null; S.tmp = null;
  S.cur = clamp(S.cur, 0, S.pages.length - 1);
  S.dirty = true;
  renderAll();
  syncButtons();
}
function undo() {
  if (!S.undo.length) return;
  S.redo.push(S.last);
  const snap = S.undo.pop();
  S.last = snap;
  restore(snap);
}
function redo() {
  if (!S.redo.length) return;
  S.undo.push(S.last);
  const snap = S.redo.pop();
  S.last = snap;
  restore(snap);
}

/* ---- lookups ---- */
const pageById = (pid) => S.pages.find((p) => p.id === pid);
const annotById = (p, id) => p && p.annots.find((a) => a.id === id);
function selected() {
  if (!S.sel) return [null, null];
  const p = pageById(S.sel.pid);
  return [p, annotById(p, S.sel.id)];
}

function bbox(a) {
  switch (a.type) {
    case 'line': return { x: Math.min(a.x1, a.x2), y: Math.min(a.y1, a.y2), w: Math.abs(a.x2 - a.x1), h: Math.abs(a.y2 - a.y1) };
    case 'ink': {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of a.points) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    case 'text': return { x: a.x, y: a.y, w: a.w || a.size * 2, h: a.h || a.size * LINE_H };
    default: return { x: a.x, y: a.y, w: a.w, h: a.h };
  }
}
