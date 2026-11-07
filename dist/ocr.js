const ASSET_CACHE = 'receipt-stitch-ocr-v1';
let pending;
let latestStatus;
let registration;
const listeners = new Set();

export function registerAppWorker() {
  if (!registration) {
    const attempt = Promise.resolve().then(() => navigator.serviceWorker.register('./sw.js')).catch(error => {
      if (registration === attempt) registration = undefined;
      throw error;
    });
    registration = attempt;
  }
  return registration;
}

async function waitForAppWorker() {
  const workers = navigator.serviceWorker;
  if (workers.controller) return;
  await new Promise((resolve, reject) => {
    const attempt = registerAppWorker();
    let finished = false;
    const finish = error => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); workers.removeEventListener('controllerchange', controlled);
      if (error) {
        if (registration === attempt) registration = undefined;
        reject(new Error('本地缓存无法启动，请重新打开页面后重试。'));
      } else resolve();
    };
    const controlled = () => { if (workers.controller) finish(); };
    const timer = setTimeout(() => finish(true), 15000);
    workers.addEventListener('controllerchange', controlled);
    attempt.then(controlled, finish);
    controlled();
  });
}

export async function ocrCacheStatus() {
  if (!window.isSecureContext || !('caches' in window)) return { supported: false, ready: false, partial: false };
  try {
    if (!(await caches.keys()).includes(ASSET_CACHE)) return { supported: true, ready: false, partial: false };
    const cache = await caches.open(ASSET_CACHE), base = new URL('./', document.baseURI);
    const keys = new Set((await cache.keys()).map(request => request.url));
    const response = await cache.match(new URL('ocr/manifest.json', base));
    const manifest = response ? await response.json() : null;
    const ready = Array.isArray(manifest?.files) && manifest.files.length > 0 && manifest.files.every(file => keys.has(new URL(file.file, base).href));
    return { supported: true, ready, partial: keys.size > 0 };
  } catch { return { supported: false, ready: false, partial: false }; }
}

export async function prepareOCR(onStatus = () => {}) {
  listeners.add(onStatus);
  if (latestStatus) onStatus(...latestStatus);
  if (!pending) pending = load((...args) => {
    latestStatus = args;
    for (const listener of listeners) listener(...args);
  }).catch(error => { pending = undefined; latestStatus = undefined; throw error; });
  try { return await pending; }
  finally { listeners.delete(onStatus); }
}

const CDN_HOSTS = ['cdn.jsdelivr.net', 'fastly.jsdelivr.net', 'gcore.jsdelivr.net'];
const contentType = file => file.endsWith('.wasm') ? 'application/wasm' : /\.m?js$/.test(file) ? 'text/javascript' : 'application/octet-stream';
const responseFor = (bytes, file) => new Response(bytes, { headers: { 'Content-Type': contentType(file) } });
async function verified(bytes, file) {
  if (bytes.byteLength !== file.bytes) throw new Error('组件校验失败，请刷新后重试。');
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
  if (digest !== file.sha256) throw new Error('组件校验失败，请刷新后重试。');
  return bytes;
}

async function download(url, onBytes, { signal, mirror = false } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let timer;
  const resetTimeout = () => { clearTimeout(timer); timer = setTimeout(abort, mirror ? 4500 : 20000); };
  resetTimeout();
  const started = performance.now(), chunks = [];
  let received = 0;
  try {
    const response = await fetch(url, { signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!response.ok) throw new Error(`组件下载失败：HTTP ${response.status}`);
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          resetTimeout(); chunks.push(value); received += value.byteLength; onBytes(value.byteLength);
          const elapsed = performance.now() - started;
          if (mirror && elapsed > 4500 && received / elapsed < 96) throw new Error('下载线路较慢，正在换源。');
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    } else {
      const bytes = await response.arrayBuffer(); chunks.push(bytes); onBytes(bytes.byteLength);
    }
    // Do not copy Content-Encoding: fetch may already have decoded the response.
    return new Blob(chunks).arrayBuffer();
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

function sourceBases(manifest, base) {
  const preference = new URLSearchParams(location.search).get('source');
  if (preference === 'origin' || !/^[a-f0-9]{40}$/.test(manifest.cdnRevision || '')) return [base.href];
  return [...CDN_HOSTS.map(host => `https://${host}/gh/kunlun7210/ReceiptStitch@${manifest.cdnRevision}/dist/`), base.href];
}

async function compressedAsset(file, source, onBytes, options) {
  const bytes = await download(new URL(file.transport.file, source), onBytes, options);
  // Some hosts serve .gz with Content-Encoding: gzip, so accept the already decoded form too.
  if (new Uint8Array(bytes)[0] !== 0x1f || new Uint8Array(bytes)[1] !== 0x8b) return verified(bytes, file);
  await verified(bytes, file.transport);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return verified(await new Response(stream).arrayBuffer(), file);
}

async function preferredSources(files, sources) {
  if (sources.length === 1) return sources;
  // jsDelivr is the default; Pages is a fallback, never a competing default.
  const probe = files.reduce((a, b) => a.transport.bytes < b.transport.bytes ? a : b);
  try {
    await compressedAsset(probe, sources[0], () => {}, { mirror: true });
    return sources;
  } catch {}
  // If its default route is unavailable, race its alternate routes with a tiny asset.
  const alternatives = sources.slice(1, -1);
  const controllers = alternatives.map(() => new AbortController());
  try {
    const winner = await Promise.any(alternatives.map(async (source, index) => {
      await compressedAsset(probe, source, () => {}, { signal: controllers[index].signal, mirror: true });
      return source;
    }));
    return [winner, ...alternatives.filter(source => source !== winner), sources.at(-1)];
  } catch { return [sources.at(-1)]; }
  finally { controllers.forEach(controller => controller.abort()); }
}

async function reusePrevious(file, base, cache) {
  const name = file.file.split('/').pop();
  const oldPath = file.file.startsWith('ocr/models-v1/') ? `ocr/${name}`
    : file.file.includes('/ort/') ? `ort/${name}`
    : name.startsWith('worker-entry-') ? 'assets/worker-entry-C9UNuyOJ.js' : null;
  if (!oldPath) return;
  // Both Pages apps share an origin. Read only known old asset URLs, never fetch them.
  const old = await caches.match(new URL(`/lama-watermark-web/${oldPath}`, base), { ignoreSearch: true });
  if (!old?.ok) return;
  try {
    const bytes = await verified(await old.arrayBuffer(), file);
    await cache.put(new URL(file.file, base), responseFor(bytes, file.file));
    return true;
  } catch { /* A different/corrupt old version must be downloaded normally. */ }
}

async function load(onStatus) {
  if (!window.isSecureContext || !('serviceWorker' in navigator) || !('caches' in window)) {
    throw new Error('请使用 Safari 打开 HTTPS 网址后重试。');
  }
  const base = new URL('./', document.baseURI);
  onStatus('正在准备本地识别组件，首次使用需要联网…');
  // Do not download assets if the worker that serves them cannot start.
  await waitForAppWorker();
  const manifestURL = new URL('ocr/manifest.json', base);
  let manifest, manifestBytes;
  try {
    manifestBytes = await download(manifestURL, () => {});
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
    if (!Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Invalid manifest');
  } catch { throw new Error('识别组件清单读取失败，请联网重试。'); }
  const cache = await caches.open(ASSET_CACHE);
  const models = [], states = new Map();
  let supportsCompression = false;
  try { supportsCompression = Boolean(new DecompressionStream('gzip')); } catch {}
  const seen = new Set();
  for (const file of manifest.files) {
    if (!file || !/^ocr\/(runtime-v1|models-v1)\/[\w./-]+$/.test(file.file) || file.file.includes('..') || seen.has(file.file)
      || !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('识别组件清单无效，请联网重试。');
    if (file.transport && (!/^ocr\/transport-v1\/[a-f0-9]{64}\.gz$/.test(file.transport.file) || !Number.isSafeInteger(file.transport.bytes) || file.transport.bytes <= 0
      || !/^[a-f0-9]{64}$/.test(file.transport.sha256))) throw new Error('识别组件传输清单无效，请联网重试。');
    seen.add(file.file);
  }
  for (const file of manifest.files) {
    const url = new URL(file.file, base), asset = await cache.match(url);
    if (asset?.ok) {
      try { await verified(await asset.arrayBuffer(), file); continue; } catch {}
    }
    if (asset) await cache.delete(url);
    if (!await reusePrevious(file, base, cache)) states.set(file.file, { loaded: 0, bytes: supportsCompression && file.transport ? file.transport.bytes : file.bytes });
  }
  let sourceOrder = sourceBases(manifest, base);
  let activeSource = sourceOrder[0];
  const sourceLabel = source => {
    if (!states.size) return '本机缓存';
    const host = new URL(source).hostname;
    if (host.endsWith('.jsdelivr.net')) return host === 'cdn.jsdelivr.net' ? 'jsDelivr' : `jsDelivr · ${host.startsWith('fastly.') ? 'Fastly' : 'Gcore'}`;
    return ['localhost', '127.0.0.1', '[::1]'].includes(host) ? '本机文件' : 'GitHub Pages（备用）';
  };
  let lastUpdate = 0;
  const progress = (phase = 'download', force = false, source = '') => {
    if (!force && performance.now() - lastUpdate < 120) return;
    lastUpdate = performance.now();
    if (source) activeSource = source;
    const total = [...states.values()].reduce((n, state) => n + state.bytes, 0);
    const loaded = [...states.values()].reduce((n, state) => n + Math.min(state.loaded, state.bytes), 0);
    const percent = total ? Math.min(100, loaded / total * 100) : 100;
    const label = sourceLabel(activeSource);
    onStatus(total ? `下载识别组件 ${percent.toFixed(1)}% · ${(loaded / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB · ${label}` : '读取本地组件，无需重新下载', { phase, loaded, total, source: label });
  };
  progress(states.size ? 'download' : 'cache', true);
  if (states.size && supportsCompression && manifest.files.every(file => file.transport)) {
    sourceOrder = await preferredSources(manifest.files, sourceOrder);
    activeSource = sourceOrder[0]; progress('download', true);
  }
  const queue = manifest.files.filter(file => states.has(file.file));
  let next = 0;
  async function loadFile(file) {
    const url = new URL(file.file, base).href;
    const state = states.get(file.file);
    let bytes;
    if (supportsCompression && file.transport) {
      for (const source of sourceOrder) {
        state.loaded = 0;
        try {
          bytes = await compressedAsset(file, source, count => { state.loaded += count; progress('download', false, source); }, { mirror: new URL(source).origin !== base.origin });
          break;
        } catch {
          if (sourceOrder.length > 1) sourceOrder = sourceOrder.filter(candidate => candidate !== source);
          onStatus('正在切换下载线路，已准备的组件会保留…', { phase: 'download' });
        }
      }
    }
    if (!bytes) {
      activeSource = base.href;
      state.bytes = file.bytes; state.loaded = 0;
      const onBytes = count => { state.loaded += count; progress(); };
      if (file.parts) {
        const chunks = [];
        for (let index = 0; index < file.parts.length; index++) {
          const part = file.parts[index];
          if (part !== `${file.file}.part${index + 1}`) throw new Error('识别组件分段路径无效。');
          chunks.push(await download(new URL(part, base), onBytes));
        }
        bytes = await new Blob(chunks).arrayBuffer();
      } else bytes = await download(url, onBytes);
      await verified(bytes, file);
    }
    await cache.put(url, responseFor(bytes, file.file));
    state.loaded = state.bytes; progress('download', true);
  }
  // Two downloads overlap latency without opening many large buffers on iPhones.
  const results = await Promise.allSettled(Array.from({ length: Math.min(2, queue.length) }, async () => {
    while (next < queue.length) await loadFile(queue[next++]);
  }));
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  onStatus('组件已准备好，正在启动本地文字识别…', { phase: 'initializing' });
  try {
    for (const file of manifest.files) if (file.file.startsWith('ocr/models-v1/')) {
      const asset = await cache.match(new URL(file.file, base));
      if (!asset?.ok) throw new Error('模型缓存读取失败，请重试下载。');
      models.push(URL.createObjectURL(await asset.blob()));
    }
    await cache.put(manifestURL, new Response(manifestBytes, { headers: { 'Content-Type': 'application/json' } }));
    const { createEngine } = await import('./ocr/runtime-v1/engine.js');
    const engine = await createEngine({ models, ortBase: new URL('ocr/runtime-v1/ort/', base).href });
    try { void navigator.storage?.persist?.().catch(() => {}); } catch {}
    onStatus('本地识别已准备好', { phase: 'ready' });
    return engine;
  } finally { models.forEach(url => URL.revokeObjectURL(url)); }
}

export async function scanImage(image, onStatus) {
  const engine = await prepareOCR(onStatus);
  onStatus?.('正在识别敏感信息…', { phase: 'recognizing' });
  // Bounded input keeps memory stable on iPhones. Coordinates are mapped back to the original.
  const scale = Math.min(1, 1400 / image.naturalHeight, 1100 / image.naturalWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const scaleX = canvas.width / image.naturalWidth, scaleY = canvas.height / image.naturalHeight;
  try {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('图片读取失败，请缩小图片后重试。');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const predictions = await engine.predict(canvas);
    return predictions.flatMap(result => result.items || []).map(item => ({
      text: item.text, score: item.score,
      poly: item.poly.map(point => [point[0] / scaleX, point[1] / scaleY]),
    }));
  } finally { canvas.width = canvas.height = 1; }
}
