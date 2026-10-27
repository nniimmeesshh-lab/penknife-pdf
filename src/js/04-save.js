/* Penknife PDF - writing the edited PDF with pdf-lib. MIT License. */

function dataUrlToBytes(url) {
  const b64 = url.slice(url.indexOf(',') + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* Text the standard PDF fonts cannot encode (Hindi, Chinese, emoji...) is drawn with the browser's
   own fonts onto a transparent canvas and embedded as an image. It looks right but is not selectable. */
function rasterizeText(a) {
  const k = 4, lh = a.size * LINE_H;
  const lines = a.text.split('\n');
  const font = `${a.italic ? 'italic ' : ''}${a.bold ? 'bold ' : ''}${a.size * k}px ${FONT_CSS[a.family] || FONT_CSS.Helvetica}`;
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = font;
  const wpx = Math.max(...lines.map((l) => probe.measureText(l).width), 1);
  const c = document.createElement('canvas');
  c.width = Math.ceil(wpx) + 8; c.height = Math.ceil(lines.length * lh * k) + 8;
  const ctx = c.getContext('2d');
  ctx.font = font; ctx.fillStyle = a.color; ctx.textBaseline = 'alphabetic';
  lines.forEach((l, i) => ctx.fillText(l, 4, 4 + (baselineOffset(a.family, a.size) + i * lh) * k));
  return { url: c.toDataURL('image/png'), w: c.width / k, h: c.height / k, pad: 4 / k };
}

async function buildPdfBytes() {
  const used = [...new Set(S.pages.filter((p) => !p.blank).map((p) => p.docId))];
  if (used.some((id) => S.docs[id].encrypted)) {
    const err = new Error('encrypted');
    err.code = 'encrypted';
    throw err;
  }
  const load = (id) => PDFDocument.load(S.docs[id].bytes, { updateMetadata: false });

  // If nothing structural changed, edit the original in place so forms, bookmarks and metadata survive.
  let out, outPages;
  const inPlace = used.length === 1 && !S.pages.some((p) => p.blank) &&
    S.docs[used[0]].pdf.numPages === S.pages.length && S.pages.every((p, i) => p.srcIndex === i);
  if (inPlace) {
    out = await load(used[0]);
    outPages = out.getPages();
  } else {
    out = await PDFDocument.create();
    const copied = new Map();
    for (const id of used) {
      const src = await load(id);
      const idx = [...new Set(S.pages.filter((p) => p.docId === id).map((p) => p.srcIndex))];
      const pgs = await out.copyPages(src, idx);
      idx.forEach((n, j) => copied.set(id + ':' + n, pgs[j]));
    }
    outPages = S.pages.map((p) => {
      const pg = p.blank ? out.addPage([p.w, p.h]) : out.addPage(copied.get(p.docId + ':' + p.srcIndex));
      return pg;
    });
  }

  const fonts = {}, images = {};
  const getFont = async (name) => (fonts[name] = fonts[name] || await out.embedFont(name));
  const getImage = async (url) => {
    if (!images[url]) {
      const bytes = dataUrlToBytes(url);
      images[url] = /^data:image\/png/.test(url) ? await out.embedPng(bytes) : await out.embedJpg(bytes);
    }
    return images[url];
  };

  for (let i = 0; i < S.pages.length; i++) {
    const p = S.pages[i], page = outPages[i];
    page.setRotation(degrees((p.baseRot + p.rot) % 360));
    if (!p.annots.length) continue;
    const box = page.getCropBox();
    const uw = box.width, uh = box.height, br = p.baseRot;
    const toUser = (x, y) => {
      let ux, uy;
      if (br === 0) { ux = x; uy = uh - y; }
      else if (br === 90) { ux = y; uy = x; }
      else if (br === 180) { ux = uw - x; uy = y; }
      else { ux = uw - y; uy = uh - x; }
      return [box.x + ux, box.y + uy];
    };
    const rectOf = (x, y, w, h) => {
      const A = toUser(x, y), B = toUser(x + w, y + h);
      return { x: Math.min(A[0], B[0]), y: Math.min(A[1], B[1]), width: Math.abs(B[0] - A[0]), height: Math.abs(B[1] - A[1]) };
    };
    const line = (x1, y1, x2, y2, color, thickness) => {
      const A = toUser(x1, y1), B = toUser(x2, y2);
      page.drawLine({ start: { x: A[0], y: A[1] }, end: { x: B[0], y: B[1] }, thickness, color, lineCap: LineCapStyle.Round });
    };
    const drawImageAt = async (url, x, y, w, h) => {
      const img = await getImage(url);
      const o = toUser(x, y + h);
      page.drawImage(img, { x: o[0], y: o[1], width: w, height: h, rotate: degrees(br) });
    };

    for (const a of p.annots) {
      switch (a.type) {
        case 'cover':
        case 'highlight': {
          const r = rectOf(a.x, a.y, a.w, a.h);
          page.drawRectangle({ ...r, color: hexToRgb(a.fill || '#ffffff'), borderColor: undefined, borderWidth: 0, opacity: a.type === 'highlight' ? 0.42 : 1 });
          break;
        }
        case 'rect': {
          const r = rectOf(a.x, a.y, a.w, a.h);
          page.drawRectangle({ ...r, color: a.fill ? hexToRgb(a.fill) : undefined, borderColor: hexToRgb(a.stroke), borderWidth: a.sw });
          break;
        }
        case 'ellipse': {
          const c = toUser(a.x + a.w / 2, a.y + a.h / 2);
          const swap = br % 180 !== 0;
          page.drawEllipse({ x: c[0], y: c[1], xScale: (swap ? a.h : a.w) / 2, yScale: (swap ? a.w : a.h) / 2, color: a.fill ? hexToRgb(a.fill) : undefined, borderColor: hexToRgb(a.stroke), borderWidth: a.sw });
          break;
        }
        case 'line': {
          const col = hexToRgb(a.stroke);
          line(a.x1, a.y1, a.x2, a.y2, col, a.sw);
          if (a.arrow) { const [h1, h2] = arrowHead(a); line(a.x2, a.y2, h1[0], h1[1], col, a.sw); line(a.x2, a.y2, h2[0], h2[1], col, a.sw); }
          break;
        }
        case 'ink': {
          const col = hexToRgb(a.stroke);
          const pts = a.points;
          if (pts.length === 1) line(pts[0][0], pts[0][1], pts[0][0] + 0.01, pts[0][1], col, a.sw);
          for (let j = 1; j < pts.length; j++) line(pts[j - 1][0], pts[j - 1][1], pts[j][0], pts[j][1], col, a.sw);
          break;
        }
        case 'image':
          await drawImageAt(a.src, a.x, a.y, a.w, a.h);
          break;
        case 'text': {
          if (!a.text.trim()) break;
          const font = await getFont(pdfFontName(a.family, a.bold, a.italic));
          const lines = a.text.split('\n');
          let encodable = true;
          try { for (const l of lines) if (l) font.widthOfTextAtSize(l, a.size); } catch (_) { encodable = false; }
          if (encodable) {
            const color = hexToRgb(a.color);
            lines.forEach((l, n) => {
              if (!l) return;
              const o = toUser(a.x, a.y + baselineOffset(a.family, a.size) + n * a.size * LINE_H);
              page.drawText(l, { x: o[0], y: o[1], size: a.size, font, color, rotate: degrees(br) });
            });
          } else {
            const r = rasterizeText(a);
            await drawImageAt(r.url, a.x - r.pad, a.y - r.pad, r.w, r.h);
          }
          break;
        }
      }
    }
  }
  return out.save();
}

function outputName() {
  const base = (S.fileName || 'document.pdf').replace(/\.pdf$/i, '');
  return base + '-edited.pdf';
}

async function savePdf() {
  if (!S.pages.length) return;
  if (S.editing) endTextEdit();
  const btn = $('#b-save');
  btn.disabled = true;
  let bytes;
  try {
    bytes = await buildPdfBytes();
  } catch (err) {
    console.error(err);
    toast(err.code === 'encrypted'
      ? 'This file is password protected, so edits cannot be saved yet. Save an unprotected copy first.'
      : 'Sorry, the PDF could not be written. ' + (err.message || ''), 'err');
    btn.disabled = false;
    return;
  }
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const name = outputName();
  let ok = false;
  let dl = null;
  try { dl = window.claude && window.claude.use ? await window.claude.use('downloads') : null; } catch (_) { dl = null; }
  if (dl) {
    try { await dl.save({ filename: name, data: blob }); ok = true; }
    catch (e) { if (!e || e.code !== 'declined') toast('The file could not be saved here.', 'err'); }
  } else {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    ok = true;
  }
  if (ok) { S.dirty = false; toast('Saved as ' + name); }
  btn.disabled = false;
  updateChrome();
}
