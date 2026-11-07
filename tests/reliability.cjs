const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium, webkit } = require('playwright');
const root = process.env.AUDIT_PROJECT || path.resolve(__dirname, '..');
const engine = process.env.BROWSER || 'chrome';
const audit = process.env.AUDIT_DIR || path.resolve(root, '../qa');
const stage = process.env.AUDIT_STAGE || 'fixed';
const report = { stage, engine, cases: [] };
const record = (name, passed, details) => {
  report.cases.push({ name, passed, details });
  console.log(passed ? 'PASS' : 'GAP', name, JSON.stringify(details));
};
let server, browser;
(async () => {
  await fs.mkdir(audit, { recursive: true });
  const { detectSensitive, outputGeometry } = await import(pathToFileURL(path.join(root, 'dist/processing.js')).href);
  const line = (text, x = 40, y = 40, width = 380, height = 32) => ({ text, poly: [[x,y],[x+width,y],[x+width,y+height],[x,y+height]] });
  for (const [name, lines, expected, coverLast = false] of [
    ['全角数字与繁体尾号', [line('銀行卡尾號：１２３４')], ['card']],
    ['全角千分位和繁体余额', [line('可用餘額：￥１，２３４．５０')], ['balance']],
    ['带币种代码的余额', [line('可用余额：HKD 1,234.50')], ['balance'], true],
    ['带中文币种的余额', [line('可用餘額：港幣 1,234.50')], ['balance'], true],
    ['千分位误识别时仍覆盖末位数字', [line('可用余额：1,23.50')], ['balance'], true],
    ['尾号带末四位前缀', [line('银行卡尾号：末四位 1234')], ['card'], true],
    ['同一行两个尾号', [line('尾号1234；尾号9876；交易金额8888.00')], ['card','card']],
    ['尾号空缺时保留交易金额', [line('银行卡尾号：交易金额8888.00')], []],
    ['余额空缺时保留交易金额', [line('可用余额：',40,40,160),line('交易金额：8888.00',260,40,220)], []],
    ['分列余额仍可识别', [line('可用余额：',40,40,160),line('人民币1,200.00元',260,40,220)], ['balance']],
  ]) {
    const masks = detectSensitive(lines, 1206, 2622);
    const actual = masks.map(mask => mask.kind);
    const fullNumber = !coverLast || masks.some(mask => mask.x + mask.width >= lines[0].poly[1][0]);
    record(name, JSON.stringify(actual) === JSON.stringify(expected) && fullNumber, { actual, expected, ...(coverLast ? { fullNumber } : {}) });
  }
  const horizontal = outputGeometry({ naturalWidth: 8193, naturalHeight: 32 }, { naturalWidth: 8191, naturalHeight: 32 });
  const narrow = outputGeometry({ naturalWidth: 1, naturalHeight: 32 }, { naturalWidth: 25000, naturalHeight: 32 });
  record('超宽拼图尺寸上限与窄图保留', horizontal.width <= 8192 && narrow.leftWidth >= 1 && narrow.rightWidth >= 1, { horizontal, narrow });
  const requests = [];
  let failManifest = false, failWorker = false;
  server = require(path.join(root, 'scripts/serve.cjs'))({ basePath: '/ReceiptStitch/' });
  server.prependListener('request', (req, res) => {
    requests.push(req.url);
    if ((failManifest && req.url.includes('/ocr/manifest.json')) || (failWorker && req.url.endsWith('/sw.js'))) {
      const end = res.end.bind(res);
      res.end = () => { res.statusCode = 503; return end('Temporarily unavailable'); };
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/ReceiptStitch/?source=origin`;
  const types = engine === 'webkit' ? webkit : chromium;
  browser = await types.launch({ ...(engine === 'webkit' ? {} : { channel: 'chrome' }), headless: true });
  const context = await browser.newContext({ viewport: { width: 393, height: 852 }, acceptDownloads: true });
  const page = await context.newPage(), pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const samples = process.env.SAMPLE_DIR || path.resolve(root, '../fixtures');
  const files = ['9.PNG','10.PNG'].map(name => path.join(samples, name));
  const resultSave = page.locator('[data-result="0"] [data-result-action="save"]');
  const resultPreview = page.locator('[data-result="0"] [data-result-action="preview"]');
  const status = target => target.evaluate(async () => {
    const { state } = await import('./app.js');
    return { count: state.items.length, busy: state.busy, statuses: state.items.map(item => item.status), results: state.results.filter(result => result.file).length };
  });
  const settle = target => target.evaluate(async () => {
    const { state } = await import('./app.js'); await state.pending; await state.pendingRender;
  });
  const select = async (target, value) => { await target.locator('#fileInput').setInputFiles(value); await settle(target); return status(target); };
  await page.goto(url);
  const started = await select(page, files);
  if (started.results !== 1 || started.statuses.some(value => value !== 'ready')) throw new Error('Fixture OCR setup failed: ' + JSON.stringify(started));
  const resized = await page.evaluate(async () => {
    const { composePair, DEFAULTS } = await import('./processing.js');
    const mask = { x: 1, y: 5, width: 8, height: 8, kind: 'manual', source: 'manual', style: 'solid' };
    const make = async color => {
      const canvas = document.createElement('canvas'); canvas.width = 16384; canvas.height = 32;
      const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0,0,canvas.width,canvas.height);
      context.fillStyle = color; context.fillRect(mask.x,mask.y,mask.width,mask.height);
      const image = new Image(); image.src = canvas.toDataURL('image/png'); await image.decode(); canvas.width = canvas.height = 1;
      const result = await composePair({ image, masks: [mask] }, undefined, { ...DEFAULTS, text: '' });
      const output = new Image(), url = URL.createObjectURL(result.blob); output.src = url; await output.decode();
      canvas.width = result.width; canvas.height = result.height; context.drawImage(output,0,0);
      const pixels = context.getImageData(0,0,canvas.width,canvas.height).data; canvas.width = canvas.height = 1;
      URL.revokeObjectURL(url); return { pixels, dimensions: [result.width,result.height] };
    };
    const a = await make('#000'), b = await make('#f00');
    let differingChannels = 0;
    for (let i=0; i<a.pixels.length; i++) if (a.pixels[i] !== b.pixels[i]) differingChannels++;
    return { dimensions: a.dimensions, differingChannels };
  });
  record('缩放后遮挡边缘不残留原始像素', resized.differingChannels === 0, resized);

  await page.locator('[data-result="0"] [data-result-action="left"]').click();
  const box = await page.locator('#editorCanvas').boundingBox();
  await page.mouse.move(box.x+30,box.y+50); await page.mouse.down();
  await page.mouse.move(box.x+95,box.y+105,{steps:5}); await page.mouse.up();
  await page.evaluate(async () => {
    const { state } = await import('./app.js'); window.auditOldFile = state.results[0].file;
    window.auditSharedFiles = []; window.auditHeldThumbnails = [];
    Object.defineProperty(navigator,'canShare',{configurable:true,value:()=>true});
    Object.defineProperty(navigator,'share',{configurable:true,value:({ files })=>{window.auditSharedFiles.push(...files);return Promise.resolve();}});
    const original = HTMLCanvasElement.prototype.toBlob;
    window.auditReleaseThumb = () => { HTMLCanvasElement.prototype.toBlob = original; window.auditHeldThumbnails.splice(0).forEach(run => run()); };
    HTMLCanvasElement.prototype.toBlob = function (callback,type,...args) {
      if (type === 'image/jpeg') { window.auditHeldThumbnails.push(() => original.call(this,callback,type,...args)); return; }
      return original.call(this,callback,type,...args);
    };
  });
  await page.locator('#closeEditor').click();
  await page.waitForFunction(() => window.auditHeldThumbnails.length > 0);
  const duringEdit = await page.evaluate(() => {
    const save = document.querySelector('[data-result="0"] [data-result-action="save"]');
    const preview = document.querySelector('[data-result="0"] [data-result-action="preview"]');
    const retainedOldPreview = Boolean(preview.querySelector('img'));
    save.click(); preview.click();
    return { oldFileShared: window.auditSharedFiles.includes(window.auditOldFile), oldPreviewOpened: document.getElementById('saveDialog').open && retainedOldPreview, retainedOldPreview };
  });
  if (await page.locator('#saveDialog').evaluate(el => el.open)) await page.locator('#closeSave').click();
  await page.evaluate(() => window.auditReleaseThumb());
  await page.waitForFunction(() => document.getElementById('editorCanvas').width === 1 && !document.querySelector('[data-result="0"] [data-result-action="save"]').disabled);
  await resultSave.click();
  const fresh = await page.evaluate(async () => { const { state } = await import('./app.js'); return { manual: state.items[0].masks.filter(mask=>mask.kind==='manual').length, newFileShared: window.auditSharedFiles.at(-1) === state.results[0].file && state.results[0].file !== window.auditOldFile }; });
  record('补框后不能查看或分享旧成品', !duringEdit.oldFileShared && !duringEdit.oldPreviewOpened && !duringEdit.retainedOldPreview && fresh.newFileShared && fresh.manual === 1, { ...duringEdit, ...fresh });

  const payload = async name => ({ name, mimeType:'image/png', buffer:await fs.readFile(path.join(samples,name)) });
  const batch = [await payload('9.PNG'), { name:'audit-corrupt.png', mimeType:'image/png', buffer:Buffer.from('not an image') }, await payload('10.PNG')];
  const before = await status(page), after = await select(page, batch);
  record('损坏图片不会打乱整批配对', before.count === after.count && before.results === after.results && !after.busy, { before: before.count, after: after.count, resultCount: after.results });
  await page.locator('#clearButton').click(); await settle(page); await select(page, files[0]);
  await page.evaluate(() => {
    Object.defineProperty(navigator,'userAgent',{configurable:true,value:'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)'});
    Object.defineProperty(navigator,'canShare',{configurable:true,value:()=>false});
    window.auditDownloadCount=0;
    const click=HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click=function(){if(this.download){window.auditDownloadCount++;return;}return click.call(this);};
  });
  await page.locator('#saveAllButton').click();
  const fallback = await page.evaluate(() => ({ previewOpen: document.getElementById('saveDialog').open, downloads: window.auditDownloadCount }));
  if (fallback.previewOpen) await page.locator('#closeSave').click();
  record('iPhone 不支持分享文件时单张保存全部可长按保存', fallback.previewOpen && fallback.downloads === 0, fallback);

  failManifest = true;
  await page.reload(); const unavailable = await select(page, files);
  record('站点清单临时返回 503 仍可用已缓存模型', unavailable.statuses.every(value => value === 'ready') && unavailable.results === 1, unavailable);
  failManifest = false;
  await page.evaluate(async () => {
    const cache = await caches.open('receipt-stitch-ocr-v1');
    const url = new URL('ocr/models-v1/PP-OCRv6_small_det_onnx_infer.tar',location.href);
    await cache.put(url, new Response(new Uint8Array([0xde,0xad])));
  });
  const beforeRepair = requests.length;
  await page.reload(); const repaired = await select(page, files);
  const repairFetches = requests.slice(beforeRepair).filter(url => url.includes('/ocr/transport-v1/')).length;
  record('损坏的模型缓存自动修复且只重下该组件', repaired.results === 1 && repaired.statuses.every(value => value === 'ready') && repairFetches === 1, { ...repaired, repairFetches });
  report.pageErrors = pageErrors;
  await context.close();

  failWorker = true;
  const unavailableContext = await browser.newContext({ viewport: { width: 393, height: 852 } });
  const unavailablePage = await unavailableContext.newPage(), beforeBlocked = requests.length;
  await unavailablePage.goto(url);
  const blockedAt = Date.now();
  await unavailablePage.locator('#fileInput').setInputFiles(files[0]);
  await unavailablePage.evaluate(async wait => {
    const { state } = await import('./app.js');
    let timer;
    try { await Promise.race([state.pending, new Promise(resolve => { timer = setTimeout(resolve, wait); })]); }
    finally { clearTimeout(timer); }
  }, stage === 'fixed' ? 18000 : 6000);
  const noWorker = await status(unavailablePage);
  const unnecessaryDownloads = requests.slice(beforeBlocked).filter(url => url.includes('/ocr/transport-v1/')).length;
  record('缓存服务启动失败不会卡住或白下载模型', !noWorker.busy && noWorker.statuses[0] === 'error' && unnecessaryDownloads === 0, { ...noWorker, unnecessaryDownloads, elapsedMs: Date.now() - blockedAt });
  await unavailableContext.close();
  await fs.writeFile(path.join(audit, `edge-${stage}-${engine}.json`), JSON.stringify(report,null,2));
  if (stage === 'fixed' && (report.cases.some(item=>!item.passed) || pageErrors.length)) process.exitCode = 1;
})().catch(async error => { console.error(error); await fs.writeFile(path.join(audit, `edge-${stage}-${engine}.json`), JSON.stringify({ ...report, aborted: error.message },null,2)); process.exitCode = 1; }).finally(async () => { await browser?.close(); server?.close(); });
