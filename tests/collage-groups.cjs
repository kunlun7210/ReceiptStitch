const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const { chromium, webkit } = require('playwright');
const { selectGroupMode } = require('./photo-groups.cjs');

const variant = process.env.BROWSER || 'chrome';
const qa = process.env.COLLAGE_QA_DIR || path.resolve(__dirname, '../../qa');
const preview = process.env.COLLAGE_PREVIEW_DIR;
const checks = [];
const pass = message => { checks.push(message); console.log('PASS', variant, message); };
let server, browser;

async function fixture(index, height = 144) {
  const color = [60 + index * 7, 100 + (index * 19) % 100, 225 - index * 4];
  const buffer = await sharp({ create: { width: 96, height, channels: 3, background: { r: color[0], g: color[1], b: color[2] } } }).png().toBuffer();
  return { color, file: { name: `test-${index + 1}.png`, mimeType: 'image/png', buffer } };
}

(async () => {
  await fs.mkdir(qa, { recursive: true });
  server = require('../scripts/serve.cjs')({ basePath: '/ReceiptStitch/' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/ReceiptStitch/?source=origin`;
  browser = await (variant === 'webkit' ? webkit : chromium).launch({ ...(variant === 'webkit' ? {} : { channel: 'chrome' }), headless: true });
  const context = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, acceptDownloads: true });
  await context.addInitScript(() => Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => false }));
  const page = await context.newPage(), pageErrors = [], unexpectedRequests = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', request => {
    if (request.method() !== 'GET' || /^https?:/.test(request.url()) && !request.url().startsWith(new URL(base).origin + '/')) unexpectedRequests.push(request.url());
  });
  const settle = () => page.evaluate(async () => {
    const { state } = await import('./app.js');
    await state.pending; await state.pendingRender;
    return {
      ready: state.items.map(photo => photo.status),
      groups: state.results.map(result => result.photos.map(photo => photo.name)),
      sizes: state.results.map(result => [result.width, result.height]),
    };
  });
  const add = async files => { await page.locator('#fileInput').setInputFiles(files); return settle(); };
  const layout = async value => {
    await page.locator('#stitchSettings').evaluate(panel => panel.open = true);
    await page.locator(`input[name="stitchDirection"][value="${value}"]`).check();
    return settle();
  };
  const save = async (index, size, points = [], filename) => {
    const pending = page.waitForEvent('download');
    await page.locator(`[data-result="${index}"] [data-result-action="save"]`).click();
    const download = await pending, file = await download.path();
    const png = sharp(file), metadata = await png.metadata();
    assert.equal(metadata.format, 'png');
    assert.deepEqual([metadata.width, metadata.height], size);
    if (points.length) {
      const { data, info } = await png.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      for (const [x, y, color] of points) {
        const offset = (y * info.width + x) * 4;
        assert.deepEqual([...data.subarray(offset, offset + 4)], [...color, 255], `pixel ${x}, ${y}`);
      }
    }
    if (filename) await download.saveAs(filename);
  };
  const groupPicker = index => page.locator('#photoList [data-photo-group]').nth(index);
  const group = async (index, value) => {
    await groupPicker(index).selectOption(value);
    return groupPicker(index).inputValue();
  };

  await page.goto(base);
  assert.equal(await page.locator('input[value="horizontal"]').isChecked(), true);
  assert.doesNotMatch(await page.locator('body').textContent(), /按选择顺序左右排列/);
  await page.locator('#settings').evaluate(panel => panel.open = true);
  await page.locator('#watermarkText').fill('');
  await page.locator('#settings').evaluate(panel => panel.open = false);
  const fixtures = await Promise.all(Array.from({ length: 21 }, (_, index) => fixture(index)));
  const imported = await add(fixtures.map(image => image.file));
  assert.deepEqual(imported.ready, Array(21).fill('ready'));
  assert.deepEqual(imported.groups, [fixtures.map(image => image.file.name)]);
  await save(0, [2016, 144], fixtures.map((image, index) => [index * 96 + 48, 72, image.color]));
  await layout('vertical');
  await save(0, [96, 3024], fixtures.map((image, index) => [48, index * 144 + 72, image.color]));
  pass('21 张照片的横排和竖排各保存一张 PNG，逐张像素验证顺序');

  await page.locator('#clearButton').click(); await settle();
  const photos = [fixtures[0], fixtures[1], await fixture(2, 72), fixtures[3], fixtures[4]];
  await add(photos.map(image => image.file));
  const white = [255, 255, 255];
  await layout('grid-2');
  await save(0, [192, 432], [[48, 170, white], [48, 216, photos[2].color], [144, 216, photos[3].color], [48, 360, photos[4].color], [144, 360, white]]);
  await layout('grid-3');
  await save(0, [288, 288], [[240, 20, white], [240, 72, photos[2].color], [144, 216, photos[4].color], [240, 216, white]]);
  pass('双列和三列网格保留横图比例，未填满的格子留白');

  const itemId = await page.locator('#photoList article').nth(2).getAttribute('data-id');
  await page.locator('[data-result-action="check"]').selectOption(itemId);
  await page.locator('#editorCanvas').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#editorTitle').innerText(), '检查第 3 张');
  await page.locator('[data-mask-style="solid"]').click();
  const area = await page.locator('#editorCanvas').boundingBox();
  await page.mouse.move(area.x + 14, area.y + 12); await page.mouse.down();
  await page.mouse.move(area.x + 52, area.y + 45, { steps: 5 }); await page.mouse.up();
  await page.locator('#closeEditor').click();
  await page.waitForFunction(() => document.getElementById('editorCanvas').width === 1);
  await settle();
  await save(0, [288, 288], [[224, 64, [237, 237, 237]], [272, 64, photos[2].color]]);
  pass('多张结果可直接检查任意照片，手动遮挡只应用于选中的照片');

  await selectGroupMode(page, 'custom');
  const secondGroup = await group(1, 'new');
  await group(3, secondGroup);
  await group(4, 'new');
  const custom = [['test-1.png', 'test-3.png'], ['test-2.png', 'test-4.png'], ['test-5.png']];
  assert.deepEqual((await settle()).groups, custom);
  await save(0, [192, 144], [[48, 72, photos[0].color], [128, 64, [237, 237, 237]], [176, 64, photos[2].color]]);
  await save(2, [96, 144], [[48, 72, photos[4].color]]);
  await selectGroupMode(page, 'single');
  assert.deepEqual((await settle()).groups, photos.map(image => [image.file.name]));
  await selectGroupMode(page, 'all'); assert.equal((await settle()).groups.length, 1);
  await selectGroupMode(page, 'custom'); assert.deepEqual((await settle()).groups, custom);
  pass('不相邻照片可同组，单张与多张可同批导出，切换模式保留自定义分组');

  const broken = { name: 'broken-test.png', mimeType: 'image/png', buffer: Buffer.from('not a PNG') };
  assert.deepEqual((await add([fixtures[5].file, broken, fixtures[6].file])).groups, custom);
  assert.deepEqual((await add([fixtures[5].file])).groups, [...custom, ['test-6.png']]);
  await page.locator('#photoList [data-photo-action="remove"]').last().click();
  assert.deepEqual((await settle()).groups, custom);
  await page.setViewportSize({ width: 320, height: 852 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const sizes = await page.locator('.group-options label span, .photo-group select').evaluateAll(elements => elements.map(el => el.getBoundingClientRect().height));
  assert.ok(sizes.every(height => height >= 44), JSON.stringify(sizes));
  await page.setViewportSize({ width: 393, height: 852 });
  await page.reload();
  assert.equal(await page.locator('input[value="grid-3"]').isChecked(), true);
  pass('追加、删除和坏图恢复保留原分组，窄屏无溢出，网格偏好可重开恢复');

  if (preview) {
    await fs.mkdir(preview, { recursive: true });
    await page.locator('#stitchSettings').evaluate(panel => panel.open = true);
    await page.locator('#stitchSettings').screenshot({ path: path.join(preview, '拼图样式.png') });
    await page.locator('#settings').evaluate(panel => panel.open = true);
    await page.locator('#resetSettings').click();
    await page.locator('#settings').evaluate(panel => panel.open = false);
    const samples = ['1.PNG', '2.JPG', '3.PNG', '4.PNG', '5.JPG'].map(name => path.join(process.env.SAMPLE_DIR, name));
    const report = await add(samples);
    assert.deepEqual(report.ready, Array(5).fill('ready'));
    await save(0, report.sizes[0], [], path.join(preview, '三列网格成品.png'));
    await selectGroupMode(page, 'custom');
    const other = await group(1, 'new'); await group(3, other); await group(4, 'new'); await settle();
    await page.locator('#toast').waitFor({ state: 'hidden' });
    await page.locator('#workbench').screenshot({ path: path.join(preview, '自定义分组.png') });
  }
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(unexpectedRequests, []);
  await fs.writeFile(path.join(qa, `collage-groups-${variant}.json`), JSON.stringify({ browser: variant, checks, photosInOneStrip: 21, uploads: 0, pageErrors }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); server?.close(); });
