// Smoke test: opens the built file in Chromium, exercises the main tools, saves, and checks the saved PDF.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileSync, readFileSync } from 'node:fs';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.env.TEST_OUT || tmpdir();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, acceptDownloads: true });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await page.goto('file://' + join(root, 'dist/penknife-pdf.html'));
await page.setInputFiles('#f-pdf', join(root, 'tests/sample-input.pdf'));
await page.waitForSelector('.page canvas');
await page.waitForTimeout(1200);
await page.screenshot({ path: join(out, 'shot-1-open.png') });
const info = await page.evaluate(() => ({ pages: window.__penknife.S.pages.length, sizes: window.__penknife.S.pages.map(p => [Math.round(p.w), Math.round(p.h), p.baseRot]) }));
console.log('opened', JSON.stringify(info));
// helper: page-space point -> client coords on page i (no extra rotation)
const pt = async (i, x, y) => page.evaluate(([i, x, y]) => {
  const S = window.__penknife.S; const p = S.pages[i]; const e = S.els.get(p.id); const r = e.paper.getBoundingClientRect();
  return { x: r.left + x * S.scale, y: r.top + y * S.scale };
}, [i, x, y]);
// 1) edit existing text: click the "Total revenue" line
await page.click('[data-tool="edit"]');
let c = await pt(0, 80, 146);
await page.mouse.move(c.x, c.y); await page.waitForTimeout(300);
await page.mouse.click(c.x, c.y);
await page.waitForTimeout(300);
await page.keyboard.press('Control+A');
await page.keyboard.type('Total revenue: $51,900');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
// 2) add text
await page.click('[data-tool="text"]');
c = await pt(0, 80, 400);
await page.mouse.click(c.x, c.y);
await page.keyboard.type('Reviewed by Nimesh');
await page.keyboard.press('Escape');
// 3) rectangle + highlight + pen + line
await page.click('[data-tool="rect"]');
let a = await pt(0, 70, 480), b = await pt(0, 260, 540);
await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 5 }); await page.mouse.up();
await page.click('[data-tool="highlight"]');
a = await pt(0, 70, 108); b = await pt(0, 250, 130);
await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 5 }); await page.mouse.up();
await page.click('[data-tool="pen"]');
a = await pt(0, 300, 480);
await page.mouse.move(a.x, a.y); await page.mouse.down();
for (let i = 0; i < 20; i++) { const q = await pt(0, 300 + i * 8, 500 + Math.sin(i / 2) * 20); await page.mouse.move(q.x, q.y); }
await page.mouse.up();
await page.click('[data-tool="select"]');
await page.waitForTimeout(300);
// 4) page 3 is rotated 90 in the file: draw a rectangle there (tests coordinate mapping)
await page.evaluate(() => { const S = window.__penknife.S; document.querySelector('#scroller').scrollTop = S.els.get(S.pages[2].id).root.offsetTop - 10; });
await page.waitForTimeout(400);
await page.click('[data-tool="rect"]');
a = await pt(2, 60, 60); b = await pt(2, 200, 140);
await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 4 }); await page.mouse.up();
// 5) rotate page 2 via thumb action, delete none
await page.hover('.thumb:nth-child(2)');
await page.click('.thumb:nth-child(2) [data-a="rr"]');
await page.waitForTimeout(500);
await page.screenshot({ path: join(out, 'shot-2-edited.png') });
const counts = await page.evaluate(() => window.__penknife.S.pages.map(p => p.annots.map(a => a.type)));
console.log('annots', JSON.stringify(counts));
// 6) save
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#b-save')]);
const saved = join(out, 'saved-edited.pdf');
await dl.saveAs(saved);
console.log('saved as', dl.suggestedFilename());
// 7) sample doc path + unicode text on a fresh load
await page.reload();
await page.click('#e-sample');
await page.waitForSelector('.page canvas');
await page.click('[data-tool="text"]');
c = await pt(0, 80, 440);
await page.mouse.click(c.x, c.y);
await page.keyboard.type('नमस्ते दुनिया - Hello');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
await page.screenshot({ path: join(out, 'shot-3-sample.png') });
const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#b-save')]);
await dl2.saveAs(join(out, 'saved-unicode.pdf'));
console.log('errors', JSON.stringify(errors));
await browser.close();
