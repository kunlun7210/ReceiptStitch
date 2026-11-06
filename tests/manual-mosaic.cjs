const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const { chromium, webkit } = require('playwright');
const variant = process.env.BROWSER || 'chrome';
const root = path.resolve(__dirname, '..'), outputs = path.resolve(root, '../../outputs');
let server, browser;
(async () => {
  server = require('../scripts/serve.cjs')();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await (variant === 'webkit' ? webkit : chromium).launch({ ...(variant === 'webkit' ? {} : { channel: 'chrome' }), headless: true });
  const context = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, acceptDownloads: true });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/?source=origin`);
  await page.evaluate(() => navigator.serviceWorker.ready);
  const invariant = await page.evaluate(async () => {
    const { paintMasks } = await import('./processing.js');
    const mask = { x: 12, y: 12, width: 240, height: 36, kind: 'manual', source: 'manual' };
    const render = (height, color, scale = 1) => {
      const canvas = document.createElement('canvas'); canvas.width = Math.round(300 * scale); canvas.height = Math.round(1300 * scale);
      const context = canvas.getContext('2d', { willReadFrequently: true }); context.fillStyle = color; context.fillRect(0, 0, canvas.width, canvas.height);
      paintMasks(context, [{ ...mask, height }], scale);
      return { canvas, context };
    };
    const small = render(36, 'red'), large = render(1200, 'blue'), differentSource = render(1200, 'green');
    const a = small.context.getImageData(12, 12, 240, 36).data, b = large.context.getImageData(12, 12, 240, 36).data;
    if (!a.every((value, index) => value === b[index])) throw new Error('Cell size changed when selection became taller');
    const original = large.context.getImageData(12, 12, 240, 1200).data, other = differentSource.context.getImageData(12, 12, 240, 1200).data;
    if (!original.every((value, index) => value === other[index])) throw new Error('Mask retains source content');
    for (let index = 0; index < original.length; index += 4) if (original[index] < 190 || original[index] > 240 || original[index] !== original[index + 1] || original[index] !== original[index + 2] || original[index + 3] !== 255) throw new Error('Mask is not completely opaque light grey');
    for (const scale of [.5, .25]) {
      const down = render(1200, 'orange', scale), data = down.context.getImageData(12 * scale, 12 * scale, 240 * scale, 1200 * scale).data;
      for (let y = 0; y < 1200 * scale; y++) for (let x = 0; x < 240 * scale; x++) for (let channel = 0; channel < 4; channel++) {
        if (data[(y * 240 * scale + x) * 4 + channel] !== original[((y / scale) * 240 + x / scale) * 4 + channel]) throw new Error('Zoom and output cell density differ');
      }
      down.canvas.width = down.canvas.height = 1;
    }
    const outside = [...large.context.getImageData(11, 12, 1, 1).data];
    [small, large, differentSource].forEach(value => value.canvas.width = value.canvas.height = 1);
    return { sameSmallAndLargeGrid: true, sourceIndependent: true, fullyOpaque: true, scales: [.5, .25], outside };
  });
  assert.deepEqual(invariant.outside, [0, 0, 255, 255]);
  console.log('PASS', variant, 'large and small masks share fine cells; zoom, opacity, source independence and boundaries verified');
  const names = ['1.PNG','2.JPG','3.PNG','4.PNG','5.JPG','6.PNG','7.PNG','8.PNG','9.PNG','10.PNG'];
  await page.locator('#fileInput').setInputFiles(names.map(name => path.join(process.env.SAMPLE_DIR, name)));
  await page.waitForFunction(async () => { const { state } = await import('./app.js'); return state.items.length === 10 && !state.busy; }, null, { timeout: 180000 });
  const waitRender = () => page.evaluate(async () => { const { state } = await import('./app.js'); await state.pending; await state.pendingRender; });
  await waitRender();
  assert.deepEqual(await page.evaluate(async () => (await import('./app.js')).state.items.map(item => item.status)), Array(10).fill('ready'));
  if (variant === 'chrome') for (let index = 0; index < 5; index++) {
    const b64 = await page.evaluate(async index => {
      const { state } = await import('./app.js'), bytes = new Uint8Array(await state.results[index].blob.arrayBuffer()); let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768)); return btoa(binary);
    }, index);
    assert.ok(Buffer.from(b64, 'base64').equals(await fs.readFile(path.join(outputs, '本地预览-浅灰马赛克', `${index * 2 + 1}+${index * 2 + 2}.png`))));
  }
  console.log('PASS', variant, 'five automatic results preserved');
  await page.locator('[data-result="0"] [data-result-action="right"]').click();
  const draw = async (x, y, width, height) => {
    const box = await page.locator('#editorCanvas').boundingBox(), scale = box.width / 1206;
    await page.mouse.move(box.x + x * scale, box.y + y * scale); await page.mouse.down();
    await page.mouse.move(box.x + (x + width) * scale, box.y + (y + height) * scale, { steps: 6 }); await page.mouse.up();
  };
  await draw(90, 260, 240, 36); await draw(90, 380, 560, 150); await draw(60, 600, 1080, 1000);
  const masks = await page.evaluate(async () => (await import('./app.js')).state.items[1].masks.filter(mask => mask.kind === 'manual'));
  assert.equal(masks.length, 3); assert.ok(masks.at(-1).height > 990);
  if (variant === 'chrome') await page.locator('#editorViewport').screenshot({ path: path.join(outputs, '本地预览-大框细格马赛克.png'), animations: 'disabled' });
  await page.locator('#closeEditor').click(); await page.waitForTimeout(80); await waitRender();
  await page.evaluate(() => Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => false }));
  const exports = [];
  for (const direction of ['horizontal', 'vertical']) {
    if (direction === 'vertical') { await page.locator('#stitchSettings').evaluate(el => el.open = true); await page.locator('input[value="vertical"]').check(); await waitRender(); }
    const saving = page.waitForEvent('download'); await page.locator('[data-result="0"] [data-result-action="save"]').click();
    const download = await saving, target = variant === 'chrome' ? path.join(outputs, `本地验证-大框细格-${direction === 'vertical' ? '竖向' : '横向'}.png`) : path.resolve(root, `../qa/manual-${direction}-${variant}.png`);
    await download.saveAs(target); const metadata = await sharp(target).metadata();
    assert.equal(metadata.width, direction === 'vertical' ? 1206 : 2412); assert.equal(metadata.height, direction === 'vertical' ? 5244 : 2622);
    exports.push({ direction, width: metadata.width, height: metadata.height });
  }
  await page.locator('#settings').evaluate(el => el.open = true); await page.locator('#watermarkText').fill(''); await page.waitForTimeout(200); await waitRender();
  const density = await page.evaluate(async () => {
    const { state } = await import('./app.js'), r = state.results[0], mask = state.items[1].masks.filter(mask => mask.kind === 'manual').at(-1);
    const image = new Image(); image.src = r.url; await image.decode(); const c = document.createElement('canvas'); c.width = r.width; c.height = r.height;
    const g = c.getContext('2d'); g.drawImage(image, 0, 0); const width = Math.floor(mask.width), x = Math.floor(mask.x), y = r.firstHeight + Math.floor(mask.y) + 1;
    const pixels = g.getImageData(x, y, width, 1).data, changes = [];
    for (let col = 1; col < width; col++) if (pixels[col * 4] !== pixels[(col - 1) * 4]) changes.push(col);
    c.width = c.height = 1; return { width, changes };
  });
  assert.ok(density.changes.length > density.width / 48); assert.ok(density.changes.every(position => position % 24 === 0));
  assert.deepEqual(errors, []);
  console.log('PASS', variant, 'three actual drag selections, editor preview, horizontal/vertical file downloads and exported fine-cell density');
  await fs.writeFile(path.resolve(root, `../qa/manual-mosaic-${variant}.json`), JSON.stringify({ variant, invariant, masks, exports, density, errors, physicalIPhoneTested: false }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); server?.close(); });
