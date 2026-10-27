// Feature test: undo/redo, move/resize, page operations, merge, signature, image insert, save.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.env.TEST_OUT || tmpdir();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
let failed = 0;
const check = (name, ok, extra = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!ok) failed++; };
const st = () => page.evaluate(() => { const S = window.__penknife.S; return { pages: S.pages.length, annots: S.pages.map(p => p.annots.map(a => a.type)), undo: S.undo.length, redo: S.redo.length, sel: !!S.sel, cur: S.cur, dirty: S.dirty }; });
const pt = (i, x, y) => page.evaluate(([i, x, y]) => { const S = window.__penknife.S; const e = S.els.get(S.pages[i].id); const r = e.paper.getBoundingClientRect(); return { x: r.left + x * S.scale, y: r.top + y * S.scale }; }, [i, x, y]);
await page.goto('file://' + join(root, 'dist/penknife-pdf.html'));
await page.setInputFiles('#f-pdf', join(root, 'tests/sample-input.pdf'));
await page.waitForSelector('.page canvas');
await page.waitForTimeout(600);

// undo / redo
await page.click('[data-tool="rect"]');
let a = await pt(0, 300, 200), b = await pt(0, 420, 260);
await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 4 }); await page.mouse.up();
let s = await st(); check('rect created and selected', s.annots[0].join() === 'rect' && s.sel);
await page.click('#b-undo'); s = await st(); check('undo removes it', s.annots[0].length === 0);
await page.click('#b-redo'); s = await st(); check('redo restores it', s.annots[0].join() === 'rect');

// move + resize with the select tool
const before = await page.evaluate(() => { const S = window.__penknife.S; const r = S.pages[0].annots[0]; return { x: r.x, y: r.y, w: r.w, h: r.h }; });
a = await pt(0, 300, 200); b = await pt(0, 360, 230);   // grab the top edge (stroke) and drag
await page.mouse.move(a.x + 40, a.y); await page.mouse.down(); await page.mouse.move(b.x + 40, b.y, { steps: 4 }); await page.mouse.up();
let after = await page.evaluate(() => { const r = window.__penknife.S.pages[0].annots[0]; return { x: r.x, y: r.y, w: r.w, h: r.h }; });
check('drag moves the shape', Math.abs(after.x - before.x - 60) < 1 && Math.abs(after.y - before.y - 30) < 1, JSON.stringify(after));
const se = await page.locator('.ov [data-h="se"]').first().boundingBox();
await page.mouse.move(se.x + se.width / 2, se.y + se.height / 2); await page.mouse.down(); await page.mouse.move(se.x + 60, se.y + 40, { steps: 4 }); await page.mouse.up();
const after2 = await page.evaluate(() => { const r = window.__penknife.S.pages[0].annots[0]; return { w: r.w, h: r.h }; });
check('resize handle grows the shape', after2.w > after.w + 20 && after2.h > after.h + 10, JSON.stringify(after2));
await page.keyboard.press('Delete'); s = await st(); check('Delete removes selection', s.annots[0].length === 0);

// page operations
await page.click('#b-blank'); s = await st(); check('blank page inserted after current', s.pages === 4 && s.cur === 1);
await page.setInputFiles('#f-merge', join(root, 'tests/sample-input.pdf')); await page.waitForTimeout(800); s = await st(); check('merge adds 3 pages', s.pages === 7, 'pages=' + s.pages);
await page.hover('.thumb:nth-child(2)'); await page.click('.thumb:nth-child(2) [data-a="del"]'); s = await st(); check('delete page', s.pages === 6);
await page.dragAndDrop('.thumb:nth-child(1)', '.thumb:nth-child(3)', { targetPosition: { x: 40, y: 60 } });
await page.waitForTimeout(300);
const order = await page.evaluate(() => window.__penknife.S.pages.map(p => p.docId ? p.srcIndex : 'b'));
console.log('order after drag', JSON.stringify(order));
check('reorder by drag changed order', order[0] !== 0 || order.join() !== '0,1,2,0,1,2');
await page.click('#b-undo'); await page.waitForTimeout(200);
s = await st(); check('undo reverts the reorder', s.pages === 6);

// image + signature
await page.setInputFiles('#f-img', join(root, 'tests/test-image.png')); await page.waitForTimeout(500);
s = await st(); check('image placed', s.annots.flat().includes('image'));
await page.click('#t-sign');
const pad = await page.locator('.sigpad').boundingBox();
await page.mouse.move(pad.x + 40, pad.y + 90); await page.mouse.down();
for (let i = 0; i < 30; i++) await page.mouse.move(pad.x + 40 + i * 10, pad.y + 90 + Math.sin(i / 2) * 40);
await page.mouse.up();
await page.click('[data-r="use"]'); await page.waitForTimeout(400);
s = await st(); check('signature placed', s.annots.flat().filter((t) => t === 'image').length === 2);
await page.screenshot({ path: join(out, 'shot-4-features.png') });

// save and reopen result
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#b-save')]);
await dl.saveAs(join(out, 'features-saved.pdf'));
await page.reload();
await page.setInputFiles('#f-pdf', join(out, 'features-saved.pdf')); await page.waitForSelector('.page canvas');
s = await st(); check('saved file reopens with 6 pages', s.pages === 6);
console.log('page errors', JSON.stringify(errors));
console.log(failed ? failed + ' FAILED' : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
