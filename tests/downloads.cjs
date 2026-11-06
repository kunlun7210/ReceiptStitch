const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium, webkit } = require('playwright');
const root = path.resolve(__dirname, '..');
const variant = process.env.BROWSER || 'chrome';
const manifest = require('../dist/ocr/manifest.json');
let browser, server, scenario, requests = [], transferred = 0, active = [], timer;
let legacy = false, rateLimited = false;
const oldLoader = execFileSync('git', ['show', 'ccb10a1:dist/ocr.js'], { cwd: root });
const oldApp = execFileSync('git', ['show', 'ccb10a1:dist/app.js'], { cwd: root });
const oldManifest = execFileSync('git', ['show', 'ccb10a1:dist/ocr/manifest.json'], { cwd: root });
const report = { variant, physicalIPhoneTested: false, cases: [] };

function pacedEnd(res, bytes, end) {
  active.push({ res, bytes, offset: 0, end });
  if (timer) return;
  timer = setInterval(() => {
    let budget = 80000; // Same aggregate 5 MB/s ceiling for old and new loaders.
    while (budget > 0 && active.length) {
      const job = active.shift();
      if (job.res.destroyed) continue;
      const count = Math.min(16000, budget, job.bytes.length - job.offset);
      job.res.write(job.bytes.subarray(job.offset, job.offset + count));
      job.offset += count; budget -= count;
      if (job.offset === job.bytes.length) job.end();
      else active.push(job);
    }
    if (!active.length) { clearInterval(timer); timer = undefined; }
  }, 16);
}

(async () => {
  server = require('../scripts/serve.cjs')({ basePath: '/ReceiptStitch/' });
  server.prependListener('request', (req, res) => {
    requests.push(req.url);
    const end = res.end.bind(res);
    res.end = bytes => {
      if (!Buffer.isBuffer(bytes)) return end(bytes);
      if (legacy && req.url.endsWith('/app.js')) return end(oldApp);
      if (legacy && req.url.endsWith('/ocr.js')) return end(oldLoader);
      if (legacy && req.url.endsWith('/ocr/manifest.json')) return end(oldManifest);
      if (req.url.includes('/ocr/') && !req.url.endsWith('/manifest.json') && !req.url.includes('__cdn_fixture')) {
        transferred += bytes.length;
        if (rateLimited) { pacedEnd(res, bytes, end); return res; }
      }
      return end(bytes);
    };
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/ReceiptStitch/`;
  browser = await (variant === 'webkit' ? webkit : chromium).launch({ ...(variant === 'webkit' ? {} : { channel: 'chrome' }), headless: true });
  async function run(name, options = {}) {
    scenario = name; requests = []; transferred = 0;
    legacy = Boolean(options.legacy); rateLimited = Boolean(options.benchmark);
    const context = await browser.newContext({ viewport: { width: 393, height: 852 } });
    const page = await context.newPage(), cdn = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    if (process.env.DEBUG_DOWNLOAD === '1') page.on('console', message => console.log('BROWSER', message.type(), message.text().slice(0, 400)));
    if (variant === 'webkit') await page.addInitScript(options => {
      // Playwright WebKit does not route these SW pass-through requests. Substitute
      // fetch only for the fixture CDN; real CDN CORS is checked separately.
      const original = window.fetch;
      window.__testCdnRequests = [];
      window.fetch = async (input, init) => {
        const url = new URL(String(input), document.baseURI);
        if (!/^(cdn|fastly|gcore)\.jsdelivr\.net$/.test(url.host)) return original(input, init);
        window.__testCdnRequests.push(url.href);
        if ((options.alternate && url.host !== 'gcore.jsdelivr.net') || options.cdnBlocked) throw new TypeError('Simulated unavailable CDN');
        const response = await original(new URL(url.pathname.split('/dist/')[1] + '?__cdn_fixture', document.baseURI), init);
        if (options.corrupt && url.host === 'cdn.jsdelivr.net' && url.pathname.includes('477db3f0')) {
          const bytes = new Uint8Array(await response.arrayBuffer()); bytes[bytes.length - 1] ^= 1;
          return new Response(bytes);
        }
        return response;
      };
    }, options);
    if (options.noDecompression) await page.addInitScript(() => { globalThis.DecompressionStream = undefined; });
    await context.route(/https:\/\/(?:cdn|fastly|gcore)\.jsdelivr\.net\//, async route => {
      const url = new URL(route.request().url()); cdn.push(url.href);
      if (options.alternate && url.host !== 'gcore.jsdelivr.net') return route.abort();
      if (options.cdnBlocked) return route.abort();
      const relative = url.pathname.split('/dist/')[1];
      assert.ok(/^ocr\/transport-v1\/[a-f0-9]{64}\.gz$/.test(relative));
      let body = await fs.readFile(path.join(root, 'dist', relative));
      if (options.corrupt && url.host === 'cdn.jsdelivr.net' && relative.includes('477db3f0')) { body = Buffer.from(body); body[body.length - 1] ^= 1; }
      await route.fulfill({ status: 200, headers: { 'Content-Type': 'application/gzip', 'Access-Control-Allow-Origin': '*' }, body });
    });
    await page.goto(base + (options.cdn ? '?source=cdn' : '?source=origin'));
    await page.evaluate(() => navigator.serviceWorker.ready);
    if (options.reuse) {
      const mapping = manifest.files.filter(file => file.file.includes('/models-v1/') || file.file.endsWith('.wasm') || file.file.includes('/worker-entry-')).map(file => ({ file: file.file, old: file.file.includes('/models-v1/') ? 'ocr/' + path.basename(file.file) : file.file.endsWith('.wasm') ? 'ort/' + path.basename(file.file) : 'assets/worker-entry-C9UNuyOJ.js', parts: file.parts }));
      await page.evaluate(async mapping => {
        const cache = await caches.open('lama-ocr-v6-small-v1');
        for (const file of mapping) {
          const response = file.parts ? new Response(new Blob(await Promise.all(file.parts.map(async part => (await fetch(new URL(part, document.baseURI))).arrayBuffer())))) : await fetch(new URL(file.file, document.baseURI));
          await cache.put(new URL('/lama-watermark-web/' + file.old, location.origin), response);
        }
      }, mapping);
      requests = []; transferred = 0;
    }
    const metrics = await page.evaluate(async () => {
      const { prepareOCR } = await import('./ocr.js');
      const start = performance.now(), events = [];
      await prepareOCR((message, info) => events.push({ message, ...info, ms: performance.now() - start }));
      return { preparedMs: performance.now() - start, downloadMs: events.find(e => e.phase === 'initializing')?.ms, total: events.find(e => e.total)?.total, events };
    });
    const networkBytes = transferred;
    if (variant === 'webkit') cdn.push(...await page.evaluate(() => window.__testCdnRequests));
    if (process.env.DEBUG_DOWNLOAD === '1') console.log('DOWNLOAD-DIAG', await page.evaluate(() => ({ href: location.href, base: document.baseURI, decompression: typeof DecompressionStream, controlled: Boolean(navigator.serviceWorker.controller) })), { cdn, networkBytes, events: metrics.events.slice(0, 6) });
    const files = ['9.PNG', '10.PNG'].map(file => path.join(process.env.SAMPLE_DIR, file));
    await page.locator('#fileInput').setInputFiles(files);
    await page.waitForFunction(async () => { const { state } = await import('./app.js'); return state.items.length === 2 && !state.busy; }, null, { timeout: 180000 });
    const result = await page.evaluate(async () => {
      const { state } = await import('./app.js'); await state.pending; await state.pendingRender;
      if (state.items.length !== 2) throw new Error(JSON.stringify({ url: location.href, items: state.items.length, scripts: [...document.scripts].map(s => s.src), resources: performance.getEntriesByType('resource').filter(e => e.name.includes('app.js')).map(e => e.name) }));
      return { status: state.items.map(item => item.status), masks: state.items[1].masks, hash: [...new Uint8Array(await crypto.subtle.digest('SHA-256', await state.results[0].blob.arrayBuffer()))].map(n => n.toString(16).padStart(2, '0')).join('') };
    });
    assert.deepEqual(result.status, ['ready', 'ready']); assert.deepEqual(result.masks.map(mask => mask.kind), ['card', 'balance']); assert.deepEqual(errors, []);
    if (options.cdn && !options.cdnBlocked) assert.equal(requests.filter(url => url.includes('/ocr/transport-v1/') && !url.includes('__cdn_fixture')).length, 0, 'CDN must precede Pages');
    if (options.alternate) assert.ok(cdn.filter(url => url.includes('gcore.jsdelivr.net')).length >= 8);
    if (options.corrupt) assert.ok(cdn.some(url => url.includes('fastly.jsdelivr.net') && url.includes('477db3f0')));
    if (options.noDecompression) assert.ok(requests.some(url => url.endsWith('.wasm.part1')) && requests.some(url => url.endsWith('.wasm.part2')));
    if (options.reuse) {
      assert.equal(networkBytes, 3513887);
      const oldCache = await page.evaluate(async () => (await (await caches.open('lama-ocr-v6-small-v1')).keys()).length);
      assert.equal(oldCache, 4);
    }
    const record = { name, originAssetBytes: networkBytes, preparedMs: Math.round(metrics.preparedMs), downloadMs: Math.round(metrics.downloadMs), total: metrics.total, cdnRequests: cdn.length, resultHash: result.hash, masks: result.masks };
    report.cases.push(record); console.log('PASS', JSON.stringify(record));
    await context.close(); return record;
  }
  if (process.env.BENCHMARK_ONLY === '1') {
    const baseline = await run('unchanged previous loader, controlled 5 MB/s', { legacy: true, benchmark: true });
    const optimized = await run('compressed loader, controlled 5 MB/s', { benchmark: true });
    assert.equal(baseline.originAssetBytes, 79669084); assert.equal(optimized.originAssetBytes, 39213936); assert.equal(baseline.resultHash, optimized.resultHash); assert.deepEqual(baseline.masks, optimized.masks);
    report.savedPercent = 100 * (1 - optimized.originAssetBytes / baseline.originAssetBytes);
  } else {
    const primary = await run('jsDelivr default source', { cdn: true });
    for (const options of (process.env.PRIMARY_ONLY === '1' ? [] : [
      { name: 'jsDelivr default route unavailable, alternate route', cdn: true, alternate: true },
      { name: 'corrupt CDN asset rejected and next source verified', cdn: true, corrupt: true },
      { name: 'all CDN routes unavailable, Pages fallback', cdn: true, cdnBlocked: true },
      { name: 'reuse original AI app models, WASM and worker cache', reuse: true },
      { name: 'browser without gzip decompression uses original assets', noDecompression: true },
    ])) {
      const record = await run(options.name, options); assert.equal(record.resultHash, primary.resultHash); assert.deepEqual(record.masks, primary.masks);
    }
    report.cdnTestsUseLocalFixtures = true;
    report.cdnFixtureMode = variant === 'webkit' ? 'page-fetch-substitution-for-SW-pass-through' : 'browser-context-route';
  }
  await fs.writeFile(path.resolve(root, `../qa/${process.env.BENCHMARK_ONLY === '1' ? 'download-benchmark' : 'download-paths'}-${variant}.json`), JSON.stringify(report, null, 2));
})().catch(error => { console.error('FAIL', scenario, error); process.exitCode = 1; }).finally(async () => { clearInterval(timer); await browser?.close(); server?.close(); });
