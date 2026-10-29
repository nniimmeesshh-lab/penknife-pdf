// Colour test: edited text and its cover should blend into a coloured page.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.env.TEST_OUT || tmpdir();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
await page.goto('file://' + join(root, 'dist/penknife-pdf.html'));
await page.setInputFiles('#f-pdf', join(root, 'tests/coloured-background.pdf'));
await page.waitForSelector('.page canvas'); await page.waitForTimeout(900);
const pt = (x, y) => page.evaluate(([x, y]) => { const S = window.__penknife.S; const r = S.els.get(S.pages[0].id).paper.getBoundingClientRect(); return { x: r.left + x * S.scale, y: r.top + y * S.scale }; }, [x, y]);
async function edit(x, y, text) {
  await page.click('[data-tool="edit"]'); const c = await pt(x, y);
  await page.mouse.move(c.x, c.y); await page.waitForTimeout(250); await page.mouse.click(c.x, c.y);
  await page.keyboard.press('Control+A'); await page.keyboard.type(text); await page.keyboard.press('Escape'); await page.waitForTimeout(200);
}
await edit(100, 136, 'Invoice total: $540.00');     // dark red text on beige
await edit(100, 241, 'Paid in full - thank you!');  // white text on green banner
const a = await page.evaluate(() => window.__penknife.S.pages[0].annots.map(a => ({ t: a.type, fill: a.fill, color: a.color })));
console.log(JSON.stringify(a));
// manual cover on beige region + "Match page" button
await page.click('[data-tool="cover"]'); let s = await pt(60, 300), e = await pt(250, 340);
await page.mouse.move(s.x, s.y); await page.mouse.down(); await page.mouse.move(e.x, e.y, { steps: 4 }); await page.mouse.up();
const cov = await page.evaluate(() => { const S = window.__penknife.S; const c = S.pages[0].annots.filter(a => a.type === 'cover').pop(); return c.fill; });
console.log('new cover fill', cov);
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#b-save')]);
await dl.saveAs(join(out, 'colour-saved.pdf'));
await browser.close();
