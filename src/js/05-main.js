/* Penknife PDF - wiring and start-up. MIT License. */

async function makeSamplePdf() {
  const doc = await PDFDocument.create();
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const serif = await doc.embedFont(StandardFonts.TimesRoman);
  const ink = rgb(0.1, 0.12, 0.17);
  let page = doc.addPage([A4.w, A4.h]);
  const H = A4.h;
  page.drawText('Consulting Services Summary', { x: 56, y: H - 90, size: 24, font: bold, color: ink });
  page.drawText('Sample document - edit me', { x: 56, y: H - 112, size: 11, font: reg, color: rgb(0.4, 0.43, 0.5) });
  const rows = [
    ['Prepared for', 'Example Pty Ltd'],
    ['Date', '28 October 2026'],
    ['Engagement', 'Program delivery review'],
    ['Fee', '$12,500 (excl. GST)'],
    ['Status', 'DRAFT - please review'],
  ];
  rows.forEach(([k, v], i) => {
    const y = H - 168 - i * 26;
    page.drawText(k, { x: 56, y, size: 12, font: bold, color: ink });
    page.drawText(v, { x: 180, y, size: 12, font: reg, color: ink });
  });
  const para = ['This page is generated on your device so you can try the tools.', 'Choose Edit text, then click any line above to change it.', 'Use Add text to place new text, or Sign to add a signature.'];
  para.forEach((t, i) => page.drawText(t, { x: 56, y: H - 340 - i * 20, size: 12, font: serif, color: ink }));
  page = doc.addPage([A4.w, A4.h]);
  page.drawText('Notes', { x: 56, y: H - 90, size: 20, font: bold, color: ink });
  ['Pages can be rotated, reordered, deleted and merged from the thumbnail rail.', 'Highlight, draw and shapes are saved into the PDF when you press Save.'].forEach((t, i) =>
    page.drawText(t, { x: 56, y: H - 126 - i * 20, size: 12, font: reg, color: ink }));
  return doc.save();
}

function setupWorker() {
  try {
    const src = document.getElementById('pdf-worker-src').textContent;
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(url);
  } catch (err) {
    console.warn('Worker setup failed; pdf.js will fall back to the main thread.', err);
  }
}

function init() {
  setupWorker();
  paintIcons();
  buildPropControls();
  wireThumbs();

  const pick = (id) => () => $(id).click();
  $('#b-open').onclick = pick('#f-pdf');
  $('#e-open').onclick = pick('#f-pdf');
  $('#f-pdf').onchange = async (e) => { const f = e.target.files[0]; e.target.value = ''; await openFile(f); };
  $('#b-merge').onclick = pick('#f-merge');
  $('#f-merge').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    await openPdfBytes(new Uint8Array(await f.arrayBuffer()), f.name, { mode: 'insert', insertAfter: S.cur });
  };
  $('#e-sample').onclick = async () => { await openPdfBytes(await makeSamplePdf(), 'Sample document.pdf'); };
  $('#t-image').onclick = pick('#f-img');
  $('#f-img').onchange = async (e) => { const f = e.target.files[0]; e.target.value = ''; await insertImageFile(f); };
  $('#t-sign').onclick = openSignature;
  $('#b-save').onclick = savePdf;
  $('#b-undo').onclick = undo;
  $('#b-redo').onclick = redo;
  $('#b-delete').onclick = removeSelected;
  $('#b-blank').onclick = insertBlank;
  $('#b-zin').onclick = () => setScale(S.scale * 1.2);
  $('#b-zout').onclick = () => setScale(S.scale / 1.2);
  $('#b-fit').onclick = fitWidth;
  $('#b-prev').onclick = () => { const i = clamp(S.cur - 1, 0, S.pages.length - 1); setCurrent(i); scrollToPage(i, true); };
  $('#b-next').onclick = () => { const i = clamp(S.cur + 1, 0, S.pages.length - 1); setCurrent(i); scrollToPage(i, true); };
  $('#pgin').onchange = (e) => { const n = parseInt(e.target.value, 10); if (n >= 1 && n <= S.pages.length) { setCurrent(n - 1); scrollToPage(n - 1, true); } else updateChrome(); };
  $('#b-rail').onclick = () => {
    const m = $('#main');
    if (matchMedia('(max-width: 720px)').matches) m.classList.toggle('rail-open'); else m.classList.toggle('no-rail');
  };
  $$('.tool[data-tool]').forEach((b) => { b.onclick = () => setTool(b.dataset.tool); });

  const pages = $('#pages');
  pages.addEventListener('pointerdown', onPointerDown);
  pages.addEventListener('dblclick', onDblClick);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);

  let ticking = false;
  $('#scroller').addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { ticking = false; if (S.pages.length) setCurrent(currentFromScroll()); });
  }, { passive: true });
  $('#scroller').addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setScale(S.scale * (e.deltaY < 0 ? 1.08 : 1 / 1.08));
  }, { passive: false });

  /* drag and drop files anywhere */
  const drop = $('#drop');
  window.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); drop.classList.add('over'); } });
  window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) drop.classList.remove('over'); });
  window.addEventListener('drop', async (e) => {
    drop.classList.remove('over');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    e.preventDefault();
    if (/pdf$/i.test(f.type) || /\.pdf$/i.test(f.name)) await openFile(f);
    else if (/^image\//.test(f.type)) await insertImageFile(f);
  });

  document.addEventListener('keydown', onKey);
  window.addEventListener('beforeunload', (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });

  setTool('select');
  updateChrome();
}

function onKey(e) {
  const typing = e.target.closest && e.target.closest('input, select, textarea, [contenteditable]');
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); savePdf(); return; }
  if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); $('#f-pdf').click(); return; }
  if (typing || S.editing || !$('#modal-root').hidden) return;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (mod) return;
  if (!S.pages.length) return;
  const k = e.key;
  if (k === 'Delete' || k === 'Backspace') { if (S.sel) { e.preventDefault(); removeSelected(); } return; }
  if (k === 'Escape') { if (S.tool !== 'select') setTool('select'); else deselect(); return; }
  if (k === '+' || k === '=') { setScale(S.scale * 1.2); return; }
  if (k === '-' || k === '_') { setScale(S.scale / 1.2); return; }
  if (k.startsWith('Arrow') && S.sel) {
    const [p, a] = selected();
    if (!a) return;
    e.preventDefault();
    const d = e.shiftKey ? 10 : 1;
    const dx = k === 'ArrowLeft' ? -d : k === 'ArrowRight' ? d : 0, dy = k === 'ArrowUp' ? -d : k === 'ArrowDown' ? d : 0;
    moveAnnot(a, { ...a }, dx, dy);
    commit();
    renderOverlay(p);
    return;
  }
  const hot = { v: 'select', e: 'edit', t: 'text', h: 'highlight', p: 'pen', r: 'rect', o: 'ellipse', l: 'line', c: 'cover' }[k.toLowerCase()];
  if (hot) { setTool(hot); return; }
  if (k.toLowerCase() === 'i') $('#f-img').click();
  if (k.toLowerCase() === 's') openSignature();
}

init();
window.__penknife = { S, openPdfBytes, buildPdfBytes, makeSamplePdf, ensureRuns, runAt, pagePoint };
