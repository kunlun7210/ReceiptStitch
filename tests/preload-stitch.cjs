const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { chromium, webkit } = require('playwright');
const variant = process.env.BROWSER || 'chrome';
const root = path.resolve(__dirname, '..');
const outputs = path.resolve(root, '../../outputs');
let server, browser;
(async () => {
  const requests = [], errors = [], checks = [];
  server = require('../scripts/serve.cjs')({ basePath: '/ReceiptStitch/' });
  server.prependListener('request', (req, res) => {
    requests.push(req.url);
    if (!req.url.includes('/ocr/transport-v1/')) return;
    const end = res.end.bind(res); let timer;
    res.end = bytes => {
      let offset = 0;
      const send = () => {
        if (res.destroyed) return;
        if (offset === bytes.length) return end();
        const next = Math.min(bytes.length, offset + 65536);
        res.write(bytes.subarray(offset, next)); offset = next; timer = setTimeout(send, 10);
      };
      send(); return res;
    };
    res.on('close', () => clearTimeout(timer));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/ReceiptStitch/`;
  browser = await (variant === 'webkit' ? webkit : chromium).launch({ ...(variant === 'webkit' ? {} : { channel: 'chrome' }), headless: true });
  const context = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, acceptDownloads: true });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '?source=origin'); await page.evaluate(() => navigator.serviceWorker.ready);
  const pass = name => { checks.push(name); console.log('PASS', variant, name); };
  const waitRender = () => page.evaluate(async () => { const { state } = await import('./app.js'); await state.pending; await state.pendingRender; });
  assert.equal(await page.locator('input[value="horizontal"]').isChecked(), true);
  assert.equal(await page.locator('#stitchSummary').innerText(), '横向拼接 · 第一张在左');
  assert.equal(requests.some(url => url.includes('/ocr/')), false, 'Opening the page must not download models');
  const fonts = await page.evaluate(() => ({ brand: getComputedStyle(document.querySelector('.brand')).fontSize, steps: getComputedStyle(document.querySelector('.steps')).fontSize, weight: getComputedStyle(document.querySelector('.brand')).fontWeight }));
  assert.equal(fonts.brand, fonts.steps); assert.equal(fonts.weight, '400');
  await page.locator('#stitchSettings').evaluate(el => el.open = true);
  if (variant === 'chrome') await page.screenshot({ path: path.join(outputs, '本地预览-模型下载和拼图设置.png'), fullPage: true });
  pass('默认横向、左上角字号与步骤相同，打开页面不自动下载模型');

  assert.equal(await page.locator('#modelInfo').getAttribute('open'), null);
  await page.locator('#modelInfo > summary').click();

  await page.evaluate(() => { window.originalFetch = window.fetch; window.fetch = (url, init) => String(url).includes('/ocr/manifest.json') ? Promise.reject(new Error('测试：下载失败，请重试')) : window.originalFetch(url, init); });
  await page.locator('#downloadModelButton').click();
  await page.waitForFunction(() => document.getElementById('downloadModelButton').textContent === '重试下载模型');
  assert.equal(await page.locator('#downloadModelButton').isEnabled(), true);
  await page.evaluate(() => { window.fetch = window.originalFetch; });
  await page.locator('#downloadModelButton').click();
  await page.waitForFunction(() => { const p = document.getElementById('modelDownloadProgress'); return !p.hidden && p.value > .02 && p.value < .95 && document.getElementById('modelDownloadStatus').textContent.includes('MB'); });
  assert.equal(await page.evaluate(async () => (await import('./app.js')).state.items.length), 0);
  assert.equal(await page.locator('#prepareButton').isDisabled(), true);
  await page.waitForFunction(() => document.getElementById('downloadModelButton').textContent === '模型已下载', null, { timeout: 180000 });
  assert.equal(await page.evaluate(async () => (await import('./app.js')).state.items.length), 0);
  assert.equal(requests.filter(url => url.includes('/ocr/transport-v1/')).length, 8);
  pass('未选照片也可手动下载，显示实时进度，失败可重试，帮助入口共享状态');

  const names = ['1.PNG', '2.JPG', '3.PNG', '4.PNG', '5.JPG', '6.PNG', '7.PNG', '8.PNG', '9.PNG', '10.PNG'];
  const files = names.map(name => path.join(process.env.SAMPLE_DIR, name));
  await page.locator('#fileInput').setInputFiles(files);
  await page.waitForFunction(async () => { const { state } = await import('./app.js'); return state.items.length === 10 && !state.busy; }, null, { timeout: 180000 }); await waitRender();
  assert.deepEqual(await page.evaluate(async () => (await import('./app.js')).state.items.map(item => item.status)), Array(10).fill('ready'));
  async function saveResults(direction) {
    const records = [];
    const dest = path.join(outputs, `本地验证-${direction === 'vertical' ? '竖向' : '横向'}拼接`);
    if (variant === 'chrome') await fs.mkdir(dest, { recursive: true });
    for (let index = 0; index < 5; index++) {
      const result = await page.evaluate(async index => {
        const { state } = await import('./app.js'), r = state.results[index];
        const data = new Uint8Array(await r.blob.arrayBuffer()); let binary = '';
        for (let i = 0; i < data.length; i += 32768) binary += String.fromCharCode(...data.subarray(i, i + 32768));
        return { width: r.width, height: r.height, data: btoa(binary) };
      }, index);
      const bytes = Buffer.from(result.data, 'base64'), name = `${index * 2 + 1}+${index * 2 + 2}.png`;
      const metadata = await sharp(bytes).metadata(); assert.equal(metadata.width, result.width); assert.equal(metadata.height, result.height);
      if (variant === 'chrome') {
        await fs.writeFile(path.join(dest, name), bytes);
        if (direction === 'horizontal') assert.equal(bytes.equals(await fs.readFile(path.join(outputs, '本地预览-浅灰马赛克', name))), true, `Original horizontal export changed: ${name}`);
      }
      records.push({ pair: name, width: result.width, height: result.height, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
    }
    return records;
  }
  const horizontal = await saveResults('horizontal');
  assert.equal(horizontal[0].width, 2412); assert.equal(horizontal[0].height, 2622);
  pass('提前下载后处理 10 张素材不重复下载，5 组横向导出保持原样');
  await page.locator('input[value="vertical"]').check(); await waitRender();
  assert.equal(await page.locator('#stitchStep').innerText(), '拼接');
  assert.equal(await page.locator('[data-result="0"] [data-result-action="swap"]').innerText(), '⇅ 交换上下');
  assert.equal(await page.locator('[data-result="0"] [data-result-action="right"]').innerText(), '检查下图');
  const vertical = await saveResults('vertical');
  assert.equal(vertical[0].width, 1206); assert.equal(vertical[0].height, 5244);
  await page.evaluate(() => Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => false }));
  const saving = page.waitForEvent('download'); await page.locator('[data-result="0"] [data-result-action="save"]').click();
  const saved = await saving; await saved.saveAs(path.resolve(root, `../qa/vertical-saved-${variant}.png`));
  assert.equal((await sharp(await saved.path()).metadata()).height, 5244);
  pass('5 组竖向拼接实际生成 PNG，保存按钮导出正确的 1206×5244 图片');

  await page.locator('#settings').evaluate(el => el.open = true); await page.locator('#watermarkText').fill('');
  await page.waitForTimeout(220); await waitRender();
  const pixels = await page.evaluate(async () => {
    const { state } = await import('./app.js'); const canvases = [];
    for (const r of state.results) { const image = new Image(); image.src = r.url; await image.decode(); const c = document.createElement('canvas'); c.width = r.width; c.height = r.height; c.getContext('2d').drawImage(image, 0, 0); canvases.push(c); }
    let checked = 0;
    for (const [index, roi] of [[1,[457,670,106,34]],[1,[597,1031,196,34]],[3,[457,685,106,34]],[3,[597,1046,183,34]],[5,[626,776,96,34]],[5,[413,956,184,34]],[7,[506,684,90,33]],[9,[618,935,106,34]],[9,[412,1115,101,34]]]) {
      const pair = Math.floor(index / 2), r = state.results[pair], source = state.items[index].image, scale = r.width / source.naturalWidth;
      const [x,y,w,h] = roi.map(value => Math.round(value * scale));
      const data = canvases[pair].getContext('2d').getImageData(x, r.firstHeight + y, w, h).data;
      for (let i = 0; i < data.length; i += 4) if (data[i] < 190 || data[i] > 240 || data[i] !== data[i + 1] || data[i] !== data[i + 2] || data[i + 3] !== 255) throw new Error(`Uncovered vertical sensitive pixel in image ${index + 1}`);
      checked++;
    }
    const source = document.createElement('canvas'); source.width = 1206; source.height = 2622; const g = source.getContext('2d'); g.drawImage(state.items[0].image, 0, 0);
    const a = canvases[0].getContext('2d').getImageData(0,0,1206,2622).data, b = g.getImageData(0,0,1206,2622).data;
    let firstDiff = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) firstDiff++;
    g.clearRect(0,0,1206,2622); g.drawImage(state.items[1].image,0,0);
    const p = canvases[0].getContext('2d').getImageData(400,2622+920,660,75).data, q = g.getImageData(400,920,660,75).data;
    let amountDiff = 0; for (let i=0;i<p.length;i++) if (p[i] !== q[i]) amountDiff++;
    canvases.forEach(c => c.width = c.height = 1); source.width = source.height = 1;
    return { checked, firstDiff, amountDiff };
  });
  assert.equal(pixels.checked, 9); assert.equal(pixels.firstDiff, 0); assert.equal(pixels.amountDiff, 0);
  await page.locator('#resetSettings').click(); await waitRender();
  assert.equal(await page.locator('input[value="vertical"]').isChecked(), true, 'Reset watermark must not reset layout');
  await page.locator('[data-result="0"] [data-result-action="swap"]').click(); await waitRender();
  assert.deepEqual(await page.evaluate(async () => (await import('./app.js')).state.items.slice(0,2).map(item => item.name)), ['2.JPG','1.PNG']);
  pass('竖向的 9 个敏感数字区全部遮挡，原图与交易金额保留，交换上下和水印重置正确');

  const layouts = [];
  for (const width of [320,393,1280]) { await page.setViewportSize({ width, height: 852 }); const metric = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth, brand: getComputedStyle(document.querySelector('.brand')).fontSize, steps: getComputedStyle(document.querySelector('.steps')).fontSize })); assert.equal(metric.overflow, false); assert.equal(metric.brand, metric.steps); layouts.push({ width, ...metric }); }
  await page.reload(); await page.waitForFunction(() => document.getElementById('downloadModelButton').textContent === '模型已下载');
  assert.equal(await page.locator('input[value="vertical"]').isChecked(), true);
  assert.equal(requests.filter(url => url.includes('/ocr/transport-v1/')).length, 8);
  const port = server.address().port;
  if (variant === 'webkit') { await new Promise(resolve => server.close(resolve)); await assert.rejects(fetch(base)); } else await context.setOffline(true);
  await page.reload(); await page.waitForFunction(() => document.getElementById('downloadModelButton').textContent === '模型已下载');
  await page.locator('#fileInput').setInputFiles(files.slice(8));
  await page.waitForFunction(async () => { const { state } = await import('./app.js'); return state.items.length === 2 && !state.busy; }, null, { timeout:180000 }); await waitRender();
  assert.deepEqual(await page.evaluate(async () => (await import('./app.js')).state.items.map(item => item.status)), ['ready','ready']);
  assert.equal(await page.evaluate(async () => (await import('./app.js')).state.results[0].width), 1206);
  pass('记住手动方向，重开识别已下载缓存，离线竖向实际识别与导出成功');
  assert.deepEqual(errors, []);
  await fs.writeFile(path.resolve(root, `../qa/preload-stitch-${variant}.json`), JSON.stringify({ variant, checks, horizontal, vertical, pixels, layouts, errors, physicalIPhoneTested: false, offlineMode: variant === 'webkit' ? 'origin-server-stopped' : 'browser-offline' }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); server?.close(); });
