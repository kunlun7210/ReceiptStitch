const ASSET_CACHE = 'receipt-stitch-ocr-v1';
let pending;

export async function prepareOCR(onStatus = () => {}) {
  if (pending) return pending;
  pending = load(onStatus).catch(error => { pending = undefined; throw error; });
  return pending;
}

async function load(onStatus) {
  if (!window.isSecureContext || !('serviceWorker' in navigator) || !('caches' in window)) {
    throw new Error('请使用 Safari 打开 HTTPS 网址后重试。');
  }
  const base = new URL('./', document.baseURI);
  onStatus('正在准备本地识别组件，首次使用需要联网…');
  const response = await fetch(new URL('ocr/manifest.json', base));
  if (!response.ok) throw new Error('识别组件清单读取失败，请联网重试。');
  const manifest = await response.clone().json();
  const cache = await caches.open(ASSET_CACHE);
  const models = [];
  let complete = 0;
  const total = manifest.files.reduce((sum, file) => sum + file.bytes, 0);
  for (const file of manifest.files) {
    if (!/^ocr\/(runtime-v1|models-v1)\/[\w./-]+$/.test(file.file) || file.file.includes('..')) throw new Error('识别组件路径无效。');
    const url = new URL(file.file, base).href;
    let asset = await cache.match(url);
    if (!asset) {
      if (file.parts) {
        const chunks = [];
        for (let index = 0; index < file.parts.length; index++) {
          const part = file.parts[index];
          if (part !== `${file.file}.part${index + 1}`) throw new Error('识别组件分段路径无效。');
          const response = await fetch(new URL(part, base));
          if (!response.ok) throw new Error('组件下载未完成，请联网后重试。已完成的部分会保留。');
          chunks.push(await response.arrayBuffer());
        }
        asset = new Response(new Blob(chunks, { type: 'application/wasm' }), { headers: { 'Content-Type': 'application/wasm' } });
      } else {
        asset = await fetch(url);
        if (!asset.ok) throw new Error('组件下载未完成，请联网后重试。已完成的部分会保留。');
      }
      const bytes = await asset.clone().arrayBuffer();
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
      if (bytes.byteLength !== file.bytes || digest !== file.sha256) throw new Error('组件校验失败，请刷新后重试。');
      await cache.put(url, asset.clone());
    }
    if (file.file.startsWith('ocr/models-v1/')) models.push(URL.createObjectURL(await asset.blob()));
    complete += file.bytes;
    onStatus(`准备本地识别 ${Math.round(complete / total * 100)}% · 图片留在本机`);
  }
  await cache.put(new URL('ocr/manifest.json', base), response);
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) await new Promise(resolve => {
    navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
  });
  onStatus('正在启动本地文字识别…');
  try {
    const { createEngine } = await import('./ocr/runtime-v1/engine.js');
    const engine = await createEngine({ models, ortBase: new URL('ocr/runtime-v1/ort/', base).href });
    try { await navigator.storage?.persist?.(); } catch {}
    return engine;
  } finally { models.forEach(url => URL.revokeObjectURL(url)); }
}

export async function scanImage(image, onStatus) {
  const engine = await prepareOCR(onStatus);
  // Bounded input keeps memory stable on iPhones. Coordinates are mapped back to the original.
  const scale = Math.min(1, 1400 / image.naturalHeight, 1100 / image.naturalWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(image.naturalWidth * scale);
  canvas.height = Math.round(image.naturalHeight * scale);
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  try {
    const predictions = await engine.predict(canvas);
    return predictions.flatMap(result => result.items || []).map(item => ({
      text: item.text, score: item.score,
      poly: item.poly.map(point => [point[0] / scale, point[1] / scale]),
    }));
  } finally { canvas.width = canvas.height = 1; }
}
