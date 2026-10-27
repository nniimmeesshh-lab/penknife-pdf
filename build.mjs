// Penknife PDF build script. MIT License.
// Inlines pdf.js, pdf-lib and the app into ONE self-contained HTML file (works offline, no server needed).
//   npm install && npm run build   ->   dist/penknife-pdf.html
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(p, 'utf8');
const pkgDir = (name) => dirname(require.resolve(name + '/package.json', { paths: [root] }));

const pdfjsDir = pkgDir('pdfjs-dist');
const pdfLibDir = pkgDir('pdf-lib');
const pdfjsVersion = JSON.parse(read(join(pdfjsDir, 'package.json'))).version;
const pdfLibVersion = JSON.parse(read(join(pdfLibDir, 'package.json'))).version;
const appVersion = JSON.parse(read(join(root, 'package.json'))).version;

// pdf.js ships as an ES module. Turn its trailing `export {...}` into a global so the app can use it
// from an inline script (an inline module cannot be imported by name).
function exposePdfJs(src) {
  const at = src.lastIndexOf('export{');
  const alt = src.lastIndexOf('export {');
  const i = Math.max(at, alt);
  if (i < 0) throw new Error('Could not find the export list in pdf.js');
  const end = src.indexOf('}', i);
  const items = src.slice(src.indexOf('{', i) + 1, end).split(',').map((s) => s.trim()).filter(Boolean);
  const props = items.map((it) => {
    const m = it.match(/^(\S+)\s+as\s+(\S+)$/);
    return m ? `${m[2]}:${m[1]}` : it;
  });
  return src.slice(0, i) + `globalThis.pdfjsLib={${props.join(',')}};` + src.slice(end + 1);
}

// Some hosts reject a literal U+FFFD in a page; inside JS strings the escape is equivalent.
const guard = (name, text) => {
  if (/<\/script/i.test(text)) throw new Error(name + ' contains a closing script tag and cannot be inlined safely');
  return text.replace(/\uFFFD/g, '\\uFFFD');
};

const css = read(join(root, 'src/styles.css'));
const body = read(join(root, 'src/body.html'));
const jsFiles = readdirSync(join(root, 'src/js')).filter((f) => f.endsWith('.js')).sort();
const appJs = jsFiles.map((f) => read(join(root, 'src/js', f))).join('\n');
const pdfLib = guard('pdf-lib', read(join(pdfLibDir, 'dist/pdf-lib.min.js')));
const pdfjs = guard('pdf.js', exposePdfJs(read(join(pdfjsDir, 'build/pdf.min.mjs'))));
// The worker is also an ES module. Browsers refuse module workers created from blob: URLs on file:// pages,
// so turn it into a classic script (no import.meta, no export) and start it as a classic Worker.
function classicWorker(src) {
  const out = src.replace(/import\.meta\.url/g, 'self.location.href').replace(/export\s*\{\s*WorkerMessageHandler\s*\}\s*;?\s*$/, '');
  if (/\bimport\.meta\b/.test(out) || /\bexport\s*\{/.test(out)) throw new Error('worker still contains module-only syntax');
  return out;
}
const worker = guard('pdf.js worker', classicWorker(read(join(pdfjsDir, 'build/pdf.worker.min.mjs'))));

const fonts = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">';
const banner = `<!-- Penknife PDF ${appVersion} | MIT License | bundles pdf.js ${pdfjsVersion} (Apache-2.0) and pdf-lib ${pdfLibVersion} (MIT). See THIRD_PARTY_NOTICES.md -->`;

const scripts = `<script>${pdfLib}</script>
<script type="text/plain" id="pdf-worker-src">${worker}</script>
<script type="module">${pdfjs}</script>
<script type="module">${appJs}</script>`;

mkdirSync(join(root, 'dist'), { recursive: true });

// 1) Standalone file: double-click it to run.
const standalone = `<!doctype html>
${banner}
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Penknife PDF</title>${fonts}
<style>${css}</style></head><body>
${body}
${scripts}
</body></html>`;
writeFileSync(join(root, 'dist/penknife-pdf.html'), standalone);

// 2) Fragment for hosts that wrap the page in their own skeleton (used for the hosted copy).
const fragment = `<title>Penknife PDF</title>
<style>${css}</style>
${fonts}
${body}
${scripts}`;
writeFileSync(join(root, 'dist/penknife-pdf.fragment.html'), fragment);

const kb = (s) => Math.round(Buffer.byteLength(s) / 1024);
console.log(`dist/penknife-pdf.html  ${kb(standalone)} KB  (pdf.js ${pdfjsVersion}, pdf-lib ${pdfLibVersion})`);
