import { DEFAULTS, COMMON_COLORS, PALETTE, detectSensitive, paintMasks, composePair, makeThumbnail } from './processing.js';
import { scanImage, prepareOCR } from './ocr.js';

const $ = id => document.getElementById(id);
export const state = { items: [], results: [], busy: false, settings: { ...DEFAULTS }, sequence: 0, revision: 0, pending: Promise.resolve() };
let toastTimer, renderTimer, rendering = Promise.resolve(), editing = null, drawing = null, drawEnabled = true;
const labels = { card: '卡尾号', balance: '可用余额 / 额度', manual: '手动遮挡' };
const colorChoices = [...COMMON_COLORS, ...PALETTE];
const colorName = color => colorChoices.find(([value]) => value === color)?.[1] || '浅灰';

try {
  const saved = JSON.parse(localStorage.getItem('receipt-stitch-settings') || 'null');
  if (saved && typeof saved.text === 'string' && colorChoices.some(([color]) => color === saved.color)) state.settings = {
    text: saved.text.slice(0, 120), color: saved.color,
    fontSize: Math.min(120, Math.max(20, Number(saved.fontSize) || 50)),
    transparency: Math.min(95, Math.max(0, Number(saved.transparency) || 0)),
  };
} catch {}
writeSettings();

if ('serviceWorker' in navigator) {
  const alreadyControlled = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!alreadyControlled) return;
    if (state.items.length === 0) location.reload();
    else toast('新版本已准备好，保存照片后重新打开即可更新。');
  });
  navigator.serviceWorker.register('./sw.js').catch(() => {
    $('offlineStatus').textContent = '离线缓存不可用；请在 Safari 的 HTTPS 页面中使用。';
  });
}
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 4500); }
function status(title, detail = '', error = false) {
  $('statusTitle').textContent = title; $('statusDetail').textContent = detail;
  $('statusDot').className = `status-dot${state.busy ? ' busy' : ''}${error ? ' error' : ''}`;
}
function escapeHTML(value) { return String(value).replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char])); }
function freeResult(result) { if (result.url) URL.revokeObjectURL(result.url); }
function updateOfflineStatus() { $('offlineStatus').textContent = '本地识别组件已准备好，可离线使用。照片仅保留在当前页面。'; }
function updateRangeTracks() {
  for (const id of ['transparency','fontSize']) {
    const input = $(id);
    input.style.setProperty('--range-progress',`${(Number(input.value)-Number(input.min))/(Number(input.max)-Number(input.min))*100}%`);
  }
}

function writeSettings() {
  const s = state.settings;
  $('watermarkText').value = s.text; $('fontSize').value = s.fontSize; $('transparency').value = s.transparency;
  $('transparencyValue').textContent = `${s.transparency}%`;
  $('fontSizeValue').textContent = `${s.fontSize} pt`;
  updateRangeTracks();
  renderPalette();
  $('settingsSummary').textContent = `${s.fontSize} pt · 透明度 ${s.transparency}% · ${colorName(s.color)} · 平铺`;
}
function renderPalette() {
  $('colorLabel').textContent = colorName(state.settings.color);
  const custom = !COMMON_COLORS.some(([color]) => color === state.settings.color);
  $('commonColors').innerHTML = COMMON_COLORS.map(([color,name]) => `<button type="button" class="color-choice" data-color="${color}" aria-label="${name}" aria-pressed="${color === state.settings.color}"><span style="background:${color}">${color === state.settings.color ? '✓' : ''}</span></button>`).join('') + `<button type="button" id="openColorPalette" class="color-choice palette-trigger" aria-label="调色盘，更多颜色" aria-haspopup="dialog" aria-controls="colorDialog" aria-expanded="${$('colorDialog').open}" aria-pressed="${custom}"><span class="palette-wheel" style="--selected-color:${custom ? state.settings.color : '#ffffff'}"></span></button>`;
  $('colorPalette').innerHTML = PALETTE.map(([color,name]) => `<button type="button" class="color-choice" data-color="${color}" aria-label="${name}" aria-pressed="${color === state.settings.color}"><span style="background:${color}">${color === state.settings.color ? '✓' : ''}</span></button>`).join('');
}
function readSettings() {
  state.settings = { text: $('watermarkText').value, fontSize: Math.min(120, Math.max(20, Number($('fontSize').value) || 50)), transparency: Number($('transparency').value), color: state.settings.color };
  try { localStorage.setItem('receipt-stitch-settings', JSON.stringify(state.settings)); } catch {}
  $('transparencyValue').textContent = `${state.settings.transparency}%`;
  $('fontSizeValue').textContent = `${state.settings.fontSize} pt`;
  updateRangeTracks();
  $('colorLabel').textContent = colorName(state.settings.color);
  $('settingsSummary').textContent = `${state.settings.fontSize} pt · 透明度 ${state.settings.transparency}% · ${$('colorLabel').textContent} · 平铺`;
  invalidateResults();
}
for (const id of ['watermarkText','fontSize','transparency']) $(id).addEventListener('input', readSettings);
$('colorPalette').addEventListener('click', event => { const button = event.target.closest('[data-color]'); if (!button) return; state.settings.color = button.dataset.color; renderPalette(); readSettings(); });
$('commonColors').addEventListener('click', event => {
  const button = event.target.closest('[data-color]');
  if (button) { state.settings.color = button.dataset.color; renderPalette(); readSettings(); }
  else if (event.target.closest('#openColorPalette')) { $('colorDialog').showModal(); $('openColorPalette').setAttribute('aria-expanded','true'); }
});
$('closeColorPalette').addEventListener('click', () => $('colorDialog').close());
$('colorDialog').addEventListener('close', () => $('openColorPalette').setAttribute('aria-expanded','false'));
$('fontSize').addEventListener('change', () => $('fontSize').value = state.settings.fontSize);
$('resetSettings').addEventListener('click', () => { state.settings = { ...DEFAULTS }; writeSettings(); readSettings(); });

function chooseFiles() { $('fileInput').click(); }
$('chooseButton').addEventListener('click', chooseFiles); $('addMoreButton').addEventListener('click', chooseFiles);
$('fileInput').addEventListener('change', event => { const files = Array.from(event.target.files); event.target.value = ''; state.pending = importFiles(files); });
for (const name of ['dragenter','dragover']) $('dropZone').addEventListener(name, event => { event.preventDefault(); $('dropZone').classList.add('dragging'); });
for (const name of ['dragleave','drop']) $('dropZone').addEventListener(name, event => { event.preventDefault(); $('dropZone').classList.remove('dragging'); });
$('dropZone').addEventListener('drop', event => { state.pending = importFiles(Array.from(event.dataTransfer.files)); });

async function loadImage(file) {
  const url = URL.createObjectURL(file), image = new Image();
  try { image.src = url; await image.decode(); }
  catch { URL.revokeObjectURL(url); throw new Error(`${file.name} 无法读取。请在相册中转为 PNG 或 JPEG 后重试。`); }
  if (!image.naturalWidth || !image.naturalHeight) { URL.revokeObjectURL(url); throw new Error(`${file.name} 没有有效的图像尺寸。`); }
  return { image, url };
}
async function importFiles(files) {
  if (state.busy) { toast('正在处理这一批，请完成后再添加照片。'); return; }
  files = files.filter(file => file.type.startsWith('image/') || /\.(png|jpe?g|webp|heic|heif)$/i.test(file.name));
  if (!files.length) return toast('请选择相册中的图片。');
  if (state.items.length + files.length > 20) return toast('一次最多 20 张照片，可先保存再处理下一批。');
  state.busy = true;
  $('chooseButton').disabled = $('addMoreButton').disabled = true;
  const errors = [];
  status('正在读取照片', '按你的选择顺序排列');
  // Keep picker order, including IMG_*. Numeric sample filenames are naturally sorted only by the picker itself.
  for (const file of files) {
    try {
      const { image, url } = await loadImage(file);
      const item = { id: ++state.sequence, name: file.name, image, url, thumbnail: null, masks: [], lines: [], status: 'pending', reviewed: false, manualRevision: 0 };
      item.thumbnail = await makeThumbnail(item); state.items.push(item);
    } catch (error) { errors.push(error.message); }
  }
  renderPhotos();
  if (errors.length) toast(errors.join('；'));
  await analyzePending();
}

async function analyzePending() {
  state.busy = true; $('progress').hidden = false; $('retryButton').hidden = true;
  const targets = state.items.filter(item => item.status === 'pending' || item.status === 'error');
  let completed = 0;
  for (const item of targets) {
    item.status = 'processing'; renderPhotos();
    try {
      status(`正在识别 ${completed + 1} / ${targets.length}`, item.name);
      const lines = await scanImage(item.image, (message, info) => {
        if (info?.phase === 'recognizing') {
          status(`正在识别 ${completed + 1} / ${targets.length}`, item.name);
          $('progress').setAttribute('aria-label','图片识别进度');
          $('progress').value = completed / targets.length;
        } else {
          status(info?.phase === 'download' ? '下载本地识别组件' : '准备本地文字识别', message);
          $('progress').setAttribute('aria-label','识别组件下载进度');
          if (info?.total) $('progress').value = info.loaded / info.total;
          else $('progress').removeAttribute('value');
        }
      });
      const automatic = detectSensitive(lines, item.image.naturalWidth, item.image.naturalHeight, item.image);
      // Never overwrite edits made while inference was running.
      item.lines = lines;
      item.masks = [...automatic, ...item.masks.filter(m => m.source === 'manual')];
      item.status = 'ready'; updateOfflineStatus();
    } catch (error) {
      item.status = 'error'; item.error = /下载|联网|读取|校验|HTTPS/.test(error.message) ? error.message : '本地识别暂未完成，请重试。';
      status('自动识别未完成', `${item.error} 可重试，或逐张手动框选后完成检查。`, true);
      // Initialization failures should not trigger repeated downloads for every photo.
      for (const rest of targets.slice(completed + 1)) { rest.status = 'error'; rest.error = item.error; }
      break;
    }
    await refreshThumbnail(item);
    $('progress').value = ++completed / targets.length;
    renderPhotos();
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  state.busy = false; $('chooseButton').disabled = $('addMoreButton').disabled = false; $('progress').hidden = true;
  $('statusDot').classList.remove('busy');
  if (state.items.some(item => item.status === 'error')) $('retryButton').hidden = false;
  else if (state.items.length) status('识别完成', '请检查卡尾号和可用余额的遮挡位置。可点照片手动补框。');
  renderPhotos(); invalidateResults(0); await rendering;
}
$('retryButton').addEventListener('click', () => { if (!state.busy) state.pending = analyzePending(); });

async function refreshThumbnail(item) { const next = await makeThumbnail(item); if (item.thumbnail) URL.revokeObjectURL(item.thumbnail); item.thumbnail = next; }
function renderPhotos() {
  const count = state.items.length;
  $('workbench').hidden = !count; $('dropZone').hidden = count > 0; $('photoCount').textContent = count;
  $('clearButton').disabled = state.busy;
  $('photoList').innerHTML = state.items.map((item, index) => `<article class="photo-item" data-id="${item.id}">
    <button class="photo-figure" data-photo-action="edit" aria-label="检查第 ${index + 1} 张照片的遮挡"><img src="${item.thumbnail}" alt="${escapeHTML(item.name)}"><span class="photo-number">${index + 1}</span><span class="photo-state${['pending','processing'].includes(item.status) ? ' pending' : item.status === 'error' && !item.reviewed ? ' failed' : ''}">${item.status === 'ready' || item.reviewed ? '✓' : item.status === 'error' ? '!' : '…'}</span></button>
    <p class="photo-name">${escapeHTML(item.name)}</p><div class="photo-controls"><button data-photo-action="up" aria-label="将第 ${index + 1} 张前移" ${index === 0 || state.busy ? 'disabled' : ''}>‹</button><button data-photo-action="down" aria-label="将第 ${index + 1} 张后移" ${index === count - 1 || state.busy ? 'disabled' : ''}>›</button><button data-photo-action="remove" aria-label="移除第 ${index + 1} 张" ${state.busy ? 'disabled' : ''}>×</button></div></article>`).join('');
}
$('photoList').addEventListener('click', event => {
  const button = event.target.closest('[data-photo-action]'); if (!button) return;
  const index = state.items.findIndex(item => item.id === Number(button.closest('[data-id]').dataset.id));
  const action = button.dataset.photoAction;
  if (action === 'edit') return openEditor(state.items[index]);
  if (state.busy) return;
  if (action === 'remove') { const [item] = state.items.splice(index, 1); URL.revokeObjectURL(item.url); URL.revokeObjectURL(item.thumbnail); item.image.src = ''; }
  else { const next = index + (action === 'up' ? -1 : 1); if (next < 0 || next >= state.items.length) return; [state.items[index], state.items[next]] = [state.items[next], state.items[index]]; }
  renderPhotos(); invalidateResults(0);
});
$('clearButton').addEventListener('click', () => {
  if (state.busy) return;
  for (const item of state.items) { URL.revokeObjectURL(item.url); URL.revokeObjectURL(item.thumbnail); item.image.src = ''; }
  state.items = []; renderPhotos(); invalidateResults(0);
});

function invalidateResults(delay = 180) {
  state.revision++; clearTimeout(renderTimer); $('saveAllButton').disabled = true;
  for (const button of document.querySelectorAll('[data-result-action="save"]')) button.disabled = true;
  if (delay) renderTimer = setTimeout(() => queueRender(), delay); else queueRender();
}
function queueRender() {
  const revision = state.revision;
  rendering = rendering.catch(() => {}).then(() => renderResults(revision));
  state.pendingRender = rendering;
}
async function renderResults(revision) {
  if (revision !== state.revision) return;
  const pairs = Math.floor(state.items.length / 2);
  $('resultsSection').hidden = !state.items.length;
  $('resultCount').textContent = pairs;
  $('pairHint').hidden = state.items.length % 2 === 0;
  $('pairHint').textContent = `最后 1 张还没有配对。再添加 1 张，即可生成第 ${pairs + 1} 组。`;
  const next = [];
  const settings = { ...state.settings };
  for (let i = 0; i < pairs; i++) {
    if (revision !== state.revision) { next.forEach(freeResult); return; }
    const left = state.items[i * 2], right = state.items[i * 2 + 1];
    const usable = [left, right].every(item => item.status === 'ready' || item.status === 'error' && item.reviewed);
    if (!usable) { next.push({ left, right, index: i, error: [left,right].some(item => item.status === 'error') ? '识别未完成，请重试或手动检查两张照片。' : '正在识别照片，完成后自动生成…' }); continue; }
    try {
      const output = await composePair(left, right, settings);
      next.push({ ...output, left, right, index: i, url: URL.createObjectURL(output.blob), file: new File([output.blob], `${String(i + 1).padStart(2,'0')}-收款拼图.png`, { type: 'image/png' }) });
    } catch (error) { next.push({ left, right, index:i, error: error.message }); }
  }
  if (revision !== state.revision) { next.forEach(freeResult); return; }
  state.results.forEach(freeResult); state.results = next;
  $('results').innerHTML = next.map(result => {
    const masks = [...result.left.masks, ...result.right.masks];
    const cards = masks.filter(m => m.kind === 'card').length, balances = masks.filter(m => m.kind === 'balance').length, manuals = masks.filter(m => m.kind === 'manual').length;
    const description = result.error ? '请先完成识别或手动检查' : masks.length ? [cards ? `尾号 ${cards} 处` : '', balances ? `余额 / 额度 ${balances} 处` : '', manuals ? `补框 ${manuals} 处` : ''].filter(Boolean).join(' · ') : '未发现目标字段，可点照片检查或补框';
    return `<article class="result-card" data-result="${result.index}"><div class="result-heading"><h3>第 ${result.index + 1} 组 <span>${result.index * 2 + 1} + ${result.index * 2 + 2}</span></h3><button data-result-action="swap" ${state.busy ? 'disabled' : ''}>⇄ 交换左右</button></div>
      <button class="result-preview" data-result-action="preview" aria-label="放大查看第 ${result.index + 1} 组结果">${result.url ? `<img src="${result.url}" alt="第 ${result.index + 1} 组：已遮挡敏感信息、横向拼接并添加水印"><span class="preview-zoom">⊕</span>` : `<span class="generating">${escapeHTML(result.error)}</span>`}</button>
      <div class="result-info"><p class="mask-summary${!masks.length || result.error ? ' warn' : ''}"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2l6 2v5c0 4-6 8-6 8S4 13 4 9V4l6-2Z"/><path d="m7 9 2 2 4-4"/></svg>${description}</p><div class="result-actions"><button class="secondary" data-result-action="left">检查左图</button><button class="secondary" data-result-action="right">检查右图</button><button class="primary compact" data-result-action="save" ${result.url ? '' : 'disabled'}>保存图片</button></div>${result.url ? `<p class="result-detail">${result.width} × ${result.height} · PNG${result.resized ? ' · 已适配手机导出尺寸' : ' · 完整画面'}</p>` : ''}</div></article>`;
  }).join('');
  $('saveAllButton').disabled = next.length === 0 || next.some(result => !result.file) || state.busy;
}
$('results').addEventListener('click', event => {
  const button = event.target.closest('[data-result-action]'); if (!button) return;
  const result = state.results[Number(button.closest('[data-result]').dataset.result)]; if (!result) return;
  const action = button.dataset.resultAction;
  if (action === 'left' || action === 'right') return openEditor(result[action]);
  if (action === 'swap') { if (state.busy) return; const i = result.index * 2; [state.items[i],state.items[i+1]] = [state.items[i+1],state.items[i]]; renderPhotos(); return invalidateResults(0); }
  if (action === 'preview' && result.url) return showSave(result);
  if (action === 'save' && result.file) shareFiles([result.file], result);
});
function showSave(result) { $('saveImage').src = result.url; $('saveDialog').showModal(); }
$('closeSave').addEventListener('click', () => { $('saveDialog').close(); $('saveImage').removeAttribute('src'); });
function downloadFile(file) { const url = URL.createObjectURL(file), a = document.createElement('a'); a.href = url; a.download = file.name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
function shareFiles(files, result) {
  // Files are prepared before this user gesture, as required by iOS Web Share.
  if (navigator.canShare?.({ files }) && navigator.share) {
    navigator.share({ files }).catch(error => {
      if (error.name === 'AbortError') return;
      if (result) { showSave(result); toast('可长按图片保存到相册。'); }
      else toast('系统未能分享这批图片，请分别点每组“保存图片”。');
    });
  } else if (/iPhone|iPad|iPod/.test(navigator.userAgent) && result) showSave(result);
  else { for (const file of files) downloadFile(file); toast(files.length > 1 ? '已开始下载；如浏览器拦截多文件，请分别保存。' : '已开始下载图片。'); }
}
$('saveAllButton').addEventListener('click', () => { const valid = state.results.filter(r => r.file); if (valid.length && !state.busy) shareFiles(valid.map(result => result.file)); });

function openEditor(item) {
  if (!item) return;
  editing = item; drawing = null; $('editorZoom').value = '1'; setDrawMode(true);
  $('editorTitle').textContent = `检查第 ${state.items.indexOf(item) + 1} 张`;
  $('editorSubtitle').textContent = item.name;
  $('editor').showModal(); redrawEditor();
}
function setDrawMode(enabled) { drawEnabled = enabled; $('drawMode').classList.toggle('active', enabled); $('browseMode').classList.toggle('active', !enabled); $('drawMode').setAttribute('aria-pressed', String(enabled)); $('browseMode').setAttribute('aria-pressed', String(!enabled)); $('editorViewport').classList.toggle('browse', !enabled); }
$('drawMode').addEventListener('click', () => setDrawMode(true)); $('browseMode').addEventListener('click', () => setDrawMode(false));
$('editorZoom').addEventListener('change', redrawEditor);
function redrawEditor() {
  if (!editing) return;
  const canvas = $('editorCanvas'), viewport = $('editorViewport');
  const width = Math.min(650, viewport.clientWidth - (innerWidth <= 600 ? 16 : 24)) * Number($('editorZoom').value);
  const ratio = Math.min(1, width / editing.image.naturalWidth);
  canvas.width = Math.round(editing.image.naturalWidth * ratio); canvas.height = Math.round(editing.image.naturalHeight * ratio);
  canvas.style.width = `${canvas.width}px`; canvas.style.height = `${canvas.height}px`;
  const context = canvas.getContext('2d'); context.drawImage(editing.image, 0, 0, canvas.width, canvas.height); paintMasks(context, editing.masks, ratio, true);
  if (drawing) { context.strokeStyle = '#ef913c'; context.lineWidth = 2; context.setLineDash([5,3]); context.strokeRect(drawing.x * ratio, drawing.y * ratio, (drawing.endX - drawing.x) * ratio, (drawing.endY - drawing.y) * ratio); }
  $('maskList').innerHTML = editing.masks.map((mask, index) => `<button class="mask-chip" data-mask-index="${index}" aria-label="移除${labels[mask.kind]}遮挡 ${index + 1}">${labels[mask.kind]} ${index + 1}<span>×</span></button>`).join('');
  $('undoMask').disabled = !editing.masks.some(mask => mask.source === 'manual');
}
function editorPoint(event) { const rect = $('editorCanvas').getBoundingClientRect(); return { x: Math.min(editing.image.naturalWidth, Math.max(0,(event.clientX - rect.left) / rect.width * editing.image.naturalWidth)), y: Math.min(editing.image.naturalHeight, Math.max(0,(event.clientY - rect.top) / rect.height * editing.image.naturalHeight)) }; }
$('editorCanvas').addEventListener('pointerdown', event => {
  if (!drawEnabled || !editing || event.isPrimary === false) return;
  event.preventDefault(); const point = editorPoint(event); drawing = { ...point, endX: point.x, endY: point.y }; $('editorCanvas').setPointerCapture(event.pointerId);
});
$('editorCanvas').addEventListener('pointermove', event => { if (!drawing) return; const point = editorPoint(event); drawing.endX = point.x; drawing.endY = point.y; redrawEditor(); });
$('editorCanvas').addEventListener('pointerup', event => {
  if (!drawing) return;
  const point = editorPoint(event), x = Math.min(drawing.x, point.x), y = Math.min(drawing.y, point.y), width = Math.abs(point.x - drawing.x), height = Math.abs(point.y - drawing.y);
  if (width >= 7 && height >= 7) { editing.masks.push({ x:Math.floor(x), y:Math.floor(y), width:Math.ceil(width), height:Math.ceil(height), kind:'manual', source:'manual' }); editing.manualRevision++; }
  drawing = null; redrawEditor();
});
$('editorCanvas').addEventListener('pointercancel', () => { drawing = null; redrawEditor(); });
$('maskList').addEventListener('click', event => { const button = event.target.closest('[data-mask-index]'); if (!button || !editing) return; editing.masks.splice(Number(button.dataset.maskIndex),1); editing.manualRevision++; redrawEditor(); });
$('undoMask').addEventListener('click', () => { if (!editing) return; const index = editing.masks.findLastIndex(mask => mask.source === 'manual'); if (index >= 0) { editing.masks.splice(index,1); editing.manualRevision++; redrawEditor(); } });
$('closeEditor').addEventListener('click', () => { if (editing) editing.reviewed = true; $('editor').close(); });
$('editor').addEventListener('close', async () => { const item = editing; editing = null; drawing = null; if (!item) return; await refreshThumbnail(item); renderPhotos(); invalidateResults(0); $('editorCanvas').width = $('editorCanvas').height = 1; });
window.addEventListener('resize', () => { if (editing) redrawEditor(); });
$('helpButton').addEventListener('click', () => $('helpDialog').showModal()); $('closeHelp').addEventListener('click', () => $('helpDialog').close());
$('prepareButton').addEventListener('click', async () => {
  $('prepareButton').disabled = true;
  try { await prepareOCR(message => $('prepareStatus').textContent = message); updateOfflineStatus(); $('prepareStatus').textContent = '准备完成，可以离线识别了。'; }
  catch (error) { $('prepareStatus').textContent = error.message; }
  finally { $('prepareButton').disabled = false; }
});
window.addEventListener('online', () => toast('网络已连接。')); window.addEventListener('offline', () => toast('当前离线，已缓存的识别组件仍可使用。'));
