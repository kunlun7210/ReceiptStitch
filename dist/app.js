import { DEFAULTS, COMMON_COLORS, PALETTE, detectSensitive, paintMasks, composePair, makeThumbnail, boundedImageSize } from './processing.js';
import { scanImage, prepareOCR, ocrCacheStatus, registerAppWorker } from './ocr.js';

const $ = id => document.getElementById(id);
export const state = { items: [], results: [], busy: false, settings: { ...DEFAULTS }, stitchDirection: 'horizontal', manualMaskStyle: 'mosaic', sequence: 0, revision: 0, pending: Promise.resolve() };
let toastTimer, renderTimer, rendering = Promise.resolve(), editing = null, drawing = null, drawEnabled = true, editingStyle = 'mosaic';
let renderedRevision = -1;
const editorPointers = new Map();
let editorGesture = null, editorPanAnchor = null, scrollbarDrag = null, editorPageScroll = null;
let modelPreparation = null, modelPhase = 'idle';
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
try { if (localStorage.getItem('receipt-stitch-layout') === 'vertical') state.stitchDirection = 'vertical'; } catch {}
try { const style = localStorage.getItem('receipt-stitch-mask-style'); if (['mosaic','solid','smear'].includes(style)) state.manualMaskStyle = style; } catch {}
writeSettings();
writeStitchSettings();

if ('serviceWorker' in navigator) {
  const alreadyControlled = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!alreadyControlled) return;
    if (state.items.length === 0 && !state.busy && !modelPreparation) location.reload();
    else toast('新版本已准备好，保存照片后重新打开即可更新。');
  });
  registerAppWorker().catch(() => {
    if (!navigator.serviceWorker.controller) $('offlineStatus').textContent = '离线缓存未能启动；请重新打开页面后重试。';
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

function writeStitchSettings() {
  const vertical = state.stitchDirection === 'vertical';
  document.querySelector(`input[name="stitchDirection"][value="${state.stitchDirection}"]`).checked = true;
  $('stitchSummary').textContent = vertical ? '竖向拼接 · 第一张在上' : '横向拼接 · 第一张在左';
  $('stitchStep').textContent = '拼接';
  $('uploadOrderHint').textContent = `按选择顺序${vertical ? '上下' : '左右'}排列`;
  $('photoOrderHint').textContent = `单张可直接处理；多张按选择顺序${vertical ? '上下' : '左右'}排列，可调整顺序`;
  $('stitchHint').textContent = `单张图片直接打码加水印；两张图片按同${vertical ? '宽' : '高'}拼接，保留完整画面。`;
}
$('stitchSettings').addEventListener('change', event => {
  if (event.target.name !== 'stitchDirection') return;
  state.stitchDirection = event.target.value === 'vertical' ? 'vertical' : 'horizontal';
  try { localStorage.setItem('receipt-stitch-layout', state.stitchDirection); } catch {}
  writeStitchSettings(); invalidateResults(0);
});

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
  if (!files.length) return toast('请选择相册中的图片。');
  const unsupported = files.find(file => !file.type.startsWith('image/') && !/\.(png|jpe?g|webp|heic|heif|gif|avif|bmp)$/i.test(file.name));
  if (unsupported) return toast(`${unsupported.name} 不是可读取的图片，本批未添加。`);
  if (state.items.length + files.length > 20) return toast('一次最多 20 张照片，可先保存再处理下一批。');
  setProcessing(true); markResultsStale();
  status('正在读取照片', '按你的选择顺序排列');
  const batch = [];
  try {
    // Commit only a complete selection so a failed decode cannot shift pairs.
    for (const file of files) {
      const { image, url } = await loadImage(file);
      const item = { id: ++state.sequence, name: file.name, image, url, thumbnail: null, thumbnailRevision: 0, masks: [], status: 'pending', reviewed: false };
      batch.push(item);
      item.thumbnail = await makeThumbnail(item).catch(() => null);
    }
  } catch (error) {
    batch.forEach(releaseItem);
    setProcessing(false); renderPhotos(); invalidateResults(0);
    const message = `${error.message} 本批未添加，原配对顺序保留。`;
    status('读取图片失败', message, true); toast(message);
    return;
  }
  state.items.push(...batch);
  renderPhotos();
  return analyzePending();
}

function setProcessing(busy) {
  state.busy = busy;
  $('chooseButton').disabled = $('addMoreButton').disabled = busy;
  $('clearButton').disabled = busy;
}

async function analyzePending() {
  if (!state.busy) { setProcessing(true); markResultsStale(); }
  $('progress').hidden = false; $('progress').value = 0; $('retryButton').hidden = true;
  const targets = state.items.filter(item => item.status === 'pending' || item.status === 'error');
  let completed = 0;
  try {
    for (const item of targets) {
      item.status = 'processing'; renderPhotos();
      try {
        status(`正在识别 ${completed + 1} / ${targets.length}`, item.name);
        const lines = await scanImage(item.image, (message, info) => {
          if (info?.phase !== 'recognizing') showModelPreparation(message, info);
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
        // Keep manual selections made while inference was running.
        item.masks = [...automatic, ...item.masks.filter(m => m.source === 'manual')];
        item.status = 'ready'; updateOfflineStatus();
        if (item === editing) redrawEditor();
      } catch (error) {
        item.status = 'error'; item.error = /下载|联网|读取|校验|HTTPS|启动|超时/.test(error.message) ? error.message : '本地识别暂未完成，请重试。';
        if (modelPhase !== 'ready') {
          showModelError(error);
          // A shared setup failure cannot be fixed by running the remaining photos.
          for (const rest of targets.slice(completed + 1)) { rest.status = 'error'; rest.error = item.error; }
          break;
        }
      }
      await refreshThumbnail(item);
      $('progress').value = ++completed / targets.length;
      renderPhotos();
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  } finally {
    for (const item of targets) if (['pending','processing'].includes(item.status)) { item.status = 'error'; item.error = '本地识别暂未完成，请重试。'; }
    setProcessing(false); $('progress').hidden = true;
    const failure = state.items.find(item => item.status === 'error');
    $('retryButton').hidden = !failure;
    if (failure) status('自动识别未完成', `${failure.error} 可重试，或逐张手动框选后完成检查。`, true);
    else if (state.items.length) status('识别完成', '请检查卡尾号和可用余额的遮挡位置。可点照片手动补框。');
    renderPhotos(); invalidateResults(0);
  }
  await state.pendingRender;
}
$('retryButton').addEventListener('click', () => { if (!state.busy) state.pending = analyzePending(); });

function releaseItem(item) {
  URL.revokeObjectURL(item.url);
  if (item.thumbnail) URL.revokeObjectURL(item.thumbnail);
  item.image.removeAttribute('src');
}
async function refreshThumbnail(item) {
  const revision = ++item.thumbnailRevision;
  const next = await makeThumbnail(item).catch(() => null);
  if (revision !== item.thumbnailRevision || !state.items.includes(item)) {
    if (next) URL.revokeObjectURL(next);
    return;
  }
  if (item.thumbnail) URL.revokeObjectURL(item.thumbnail);
  item.thumbnail = next;
}
function renderPhotos() {
  const count = state.items.length;
  $('workbench').hidden = !count; $('dropZone').hidden = count > 0; $('photoCount').textContent = count;
  $('clearButton').disabled = state.busy;
  $('photoList').innerHTML = state.items.map((item, index) => `<article class="photo-item" data-id="${item.id}">
    <button class="photo-figure" data-photo-action="edit" aria-label="检查第 ${index + 1} 张照片的遮挡">${item.thumbnail ? `<img src="${item.thumbnail}" alt="${escapeHTML(item.name)}">` : '<span>点此检查图片</span>'}<span class="photo-number">${index + 1}</span><span class="photo-state${['pending','processing'].includes(item.status) ? ' pending' : item.status === 'error' && !item.reviewed ? ' failed' : ''}">${item.status === 'ready' || item.reviewed ? '✓' : item.status === 'error' ? '!' : '…'}</span></button>
    <p class="photo-name">${escapeHTML(item.name)}</p><div class="photo-controls"><button data-photo-action="up" aria-label="将第 ${index + 1} 张前移" ${index === 0 || state.busy ? 'disabled' : ''}>‹</button><button data-photo-action="down" aria-label="将第 ${index + 1} 张后移" ${index === count - 1 || state.busy ? 'disabled' : ''}>›</button><button data-photo-action="remove" aria-label="移除第 ${index + 1} 张" ${state.busy ? 'disabled' : ''}>×</button></div></article>`).join('');
}
$('photoList').addEventListener('click', event => {
  const button = event.target.closest('[data-photo-action]'); if (!button) return;
  const index = state.items.findIndex(item => item.id === Number(button.closest('[data-id]').dataset.id));
  const action = button.dataset.photoAction;
  if (action === 'edit') return openEditor(state.items[index]);
  if (state.busy) return;
  if (action === 'remove') { const [item] = state.items.splice(index, 1); releaseItem(item); }
  else { const next = index + (action === 'up' ? -1 : 1); if (next < 0 || next >= state.items.length) return; [state.items[index], state.items[next]] = [state.items[next], state.items[index]]; }
  renderPhotos(); invalidateResults(0);
});
$('clearButton').addEventListener('click', () => {
  if (state.busy) return;
  state.items.forEach(releaseItem);
  state.items = []; renderPhotos(); invalidateResults(0);
});

function resultsCurrent() { return !state.busy && !editing && renderedRevision === state.revision; }
function markResultsStale() {
  state.revision++; clearTimeout(renderTimer); $('saveAllButton').disabled = true;
  if ($('saveDialog').open) $('saveDialog').close();
  $('saveImage').removeAttribute('src');
  for (const button of $('results').querySelectorAll('[data-result-action="save"], [data-result-action="preview"]')) {
    button.disabled = true;
    if (button.querySelector('img')) {
      // Also remove the old image, so a long press cannot save it.
      button.style.minHeight = `${button.offsetHeight}px`;
      const label = document.createElement('span'); label.className = 'generating'; label.textContent = '正在更新图片…';
      button.replaceChildren(label);
    }
  }
}
function invalidateResults(delay = 180) {
  markResultsStale();
  if (delay) renderTimer = setTimeout(() => queueRender(), delay); else queueRender();
}
function queueRender() {
  const revision = state.revision;
  rendering = rendering.catch(() => {}).then(() => renderResults(revision));
  state.pendingRender = rendering;
}
async function renderResults(revision) {
  if (revision !== state.revision || state.busy || editing) return;
  const groups = Math.ceil(state.items.length / 2);
  $('resultsSection').hidden = !state.items.length;
  $('resultCount').textContent = groups;
  $('pairHint').hidden = state.items.length < 3 || state.items.length % 2 === 0;
  $('pairHint').textContent = '最后 1 张将单独打码并加水印，也可继续添加图片进行拼接。';
  const next = [];
  const settings = { ...state.settings };
  const direction = state.stitchDirection, vertical = direction === 'vertical';
  for (let i = 0; i < groups; i++) {
    if (revision !== state.revision || state.busy || editing) { next.forEach(freeResult); return; }
    const left = state.items[i * 2], right = state.items[i * 2 + 1];
    const items = right ? [left, right] : [left];
    const usable = items.every(item => item.status === 'ready' || item.status === 'error' && item.reviewed);
    if (!usable) { next.push({ left, right, index: i, error: items.some(item => item.status === 'error') ? '识别未完成，请重试或逐张手动检查图片。' : '正在识别图片，完成后自动生成…' }); continue; }
    try {
      const output = await composePair(left, right, settings, direction);
      next.push({ ...output, left, right, index: i, url: URL.createObjectURL(output.blob), file: new File([output.blob], `${String(i + 1).padStart(2,'0')}-${right ? '收款拼图' : '隐私图片'}.png`, { type: 'image/png' }) });
    } catch (error) { next.push({ left, right, index:i, error: error.message }); }
  }
  if (revision !== state.revision || state.busy || editing) { next.forEach(freeResult); return; }
  state.results.forEach(freeResult); state.results = next;
  renderedRevision = revision;
  $('results').innerHTML = next.map(result => {
    const masks = [...result.left.masks, ...(result.right?.masks || [])], single = !result.right;
    const cards = masks.filter(m => m.kind === 'card').length, balances = masks.filter(m => m.kind === 'balance').length, manuals = masks.filter(m => m.kind === 'manual').length;
    const description = result.error ? '请先完成识别或手动检查' : masks.length ? [cards ? `尾号 ${cards} 处` : '', balances ? `余额 / 额度 ${balances} 处` : '', manuals ? `补框 ${manuals} 处` : ''].filter(Boolean).join(' · ') : '未发现目标字段，可点照片检查或补框';
    return `<article class="result-card" data-result="${result.index}"><div class="result-heading"><h3>第 ${result.index + 1} ${state.items.length === 1 ? '张' : '组'} <span>${single ? `${result.index * 2 + 1} · 单张处理` : `${result.index * 2 + 1} + ${result.index * 2 + 2}`}</span></h3>${single ? '' : `<button data-result-action="swap" ${state.busy ? 'disabled' : ''}>${vertical ? '⇅ 交换上下' : '⇄ 交换左右'}</button>`}</div>
      <button class="result-preview" data-result-action="preview" aria-label="放大查看第 ${result.index + 1} 个处理结果" ${result.url ? '' : 'disabled'}>${result.url ? `<img src="${result.url}" alt="第 ${result.index + 1} 个结果：已遮挡敏感信息${single ? '' : `、${vertical ? '竖向' : '横向'}拼接`}并添加水印"><span class="preview-zoom">⊕</span>` : `<span class="generating">${escapeHTML(result.error)}</span>`}</button>
      <div class="result-info"><p class="mask-summary${!masks.length || result.error ? ' warn' : ''}"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2l6 2v5c0 4-6 8-6 8S4 13 4 9V4l6-2Z"/><path d="m7 9 2 2 4-4"/></svg>${description}</p><div class="result-actions"><button class="secondary" data-result-action="left">检查${single ? '图片' : vertical ? '上图' : '左图'}</button>${single ? '' : `<button class="secondary" data-result-action="right">检查${vertical ? '下' : '右'}图</button>`}<button class="primary compact" data-result-action="save" ${result.url ? '' : 'disabled'}>保存图片</button></div>${result.url ? `<p class="result-detail">${result.width} × ${result.height} · PNG${result.resized ? ' · 已适配手机导出尺寸' : ' · 完整画面'}</p>` : ''}</div></article>`;
  }).join('');
  $('saveAllButton').disabled = next.length === 0 || next.some(result => !result.file) || state.busy;
}
$('results').addEventListener('click', event => {
  const button = event.target.closest('[data-result-action]'); if (!button) return;
  const result = state.results[Number(button.closest('[data-result]').dataset.result)]; if (!result) return;
  const action = button.dataset.resultAction;
  if (action === 'left' || action === 'right') return openEditor(result[action]);
  if (action === 'swap') { if (state.busy || !result.right) return; const i = result.index * 2; [state.items[i],state.items[i+1]] = [state.items[i+1],state.items[i]]; renderPhotos(); return invalidateResults(0); }
  if (button.disabled || !resultsCurrent()) return;
  if (action === 'preview' && result.url) return showSave(result);
  if (action === 'save' && result.file) shareFiles([result.file], result);
});
function showSave(result) {
  if (!resultsCurrent() || !state.results.includes(result) || !result.url) return;
  $('saveImage').src = result.url; $('saveDialog').showModal();
}
$('closeSave').addEventListener('click', () => $('saveDialog').close());
$('saveDialog').addEventListener('close', () => $('saveImage').removeAttribute('src'));
function downloadFile(file) { const url = URL.createObjectURL(file), a = document.createElement('a'); a.href = url; a.download = file.name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
function shareFiles(files, result) {
  const fallback = () => {
    if (!resultsCurrent() || result && !state.results.includes(result)) return;
    if (result) { showSave(result); toast('可长按图片保存到相册。'); }
    else toast('当前无法一次分享这些图片，请逐组点“保存图片”。');
  };
  // Files are prepared before this user gesture, as required by iOS Web Share.
  try {
    if (navigator.canShare?.({ files }) && navigator.share) {
      navigator.share({ files }).catch(error => { if (error?.name !== 'AbortError') fallback(); });
      return;
    }
  } catch (error) { if (error?.name !== 'AbortError') fallback(); return; }
  if (/iPhone|iPad|iPod/.test(navigator.userAgent) || /Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1) { fallback(); return; }
  for (const file of files) downloadFile(file);
  toast(files.length > 1 ? '已开始下载；如浏览器拦截多文件，请分别保存。' : '已开始下载图片。');
}
$('saveAllButton').addEventListener('click', () => {
  if (!resultsCurrent() || !state.results.length || state.results.some(result => !result.file)) return;
  shareFiles(state.results.map(result => result.file), state.results.length === 1 ? state.results[0] : undefined);
});

function openEditor(item) {
  if (!item) return;
  resetEditorGesture(); editing = item; $('editorZoom').value = '1'; setDrawMode(true);
  const previous = item.masks.filter(mask => mask.kind === 'manual').at(-1);
  editingStyle = previous ? previous.style || 'mosaic' : state.manualMaskStyle;
  writeMaskStyle();
  $('editorTitle').textContent = `检查第 ${state.items.indexOf(item) + 1} 张`;
  $('editorSubtitle').textContent = item.name;
  editorPageScroll = { x: window.scrollX, y: window.scrollY };
  document.body.style.setProperty('--editor-page-top', `${-editorPageScroll.y}px`);
  document.body.style.setProperty('--editor-page-left', `${-editorPageScroll.x}px`);
  document.body.classList.add('editor-page-locked');
  $('editor').showModal(); redrawEditor();
}
function setDrawMode(enabled) { resetEditorGesture(); drawEnabled = enabled; $('drawMode').classList.toggle('active', enabled); $('browseMode').classList.toggle('active', !enabled); $('drawMode').setAttribute('aria-pressed', String(enabled)); $('browseMode').setAttribute('aria-pressed', String(!enabled)); $('editorViewport').classList.toggle('browse', !enabled); if ($('editor').open) redrawEditor(); }
$('drawMode').addEventListener('click', () => setDrawMode(true)); $('browseMode').addEventListener('click', () => setDrawMode(false));
$('editorZoom').addEventListener('change', () => { resetEditorGesture(); $('editorViewport').scrollTo(0, 0); redrawEditor(); });
function writeMaskStyle() {
  for (const button of $('maskStyleOptions').querySelectorAll('[data-mask-style]')) {
    const active = button.dataset.maskStyle === editingStyle;
    button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
  }
}
$('maskStyleOptions').addEventListener('click', event => {
  const button = event.target.closest('[data-mask-style]');
  if (!button || !editing || !['mosaic','solid','smear'].includes(button.dataset.maskStyle)) return;
  editingStyle = state.manualMaskStyle = button.dataset.maskStyle;
  try { localStorage.setItem('receipt-stitch-mask-style', editingStyle); } catch {}
  const changed = editing.masks.some(mask => mask.kind === 'manual' && mask.style !== editingStyle);
  for (const mask of editing.masks) if (mask.kind === 'manual') mask.style = editingStyle;
  if (changed) markResultsStale();
  writeMaskStyle(); redrawEditor();
});
function redrawEditor() {
  if (!editing) return;
  const canvas = $('editorCanvas'), viewport = $('editorViewport');
  // The chip list can wrap, so lay out the footer before measuring the remaining image space.
  $('maskList').innerHTML = editing.masks.map((mask, index) => `<button class="mask-chip" data-mask-index="${index}" aria-label="移除${labels[mask.kind]}遮挡 ${index + 1}">${labels[mask.kind]} ${index + 1}<span>×</span></button>`).join('');
  $('undoMask').disabled = !editing.masks.some(mask => mask.source === 'manual');
  const padding = getComputedStyle(viewport), zoom = $('editorZoom').value;
  const availableWidth = Math.max(1, viewport.clientWidth - parseFloat(padding.paddingLeft) - parseFloat(padding.paddingRight));
  const availableHeight = Math.max(1, viewport.clientHeight - parseFloat(padding.paddingTop) - parseFloat(padding.paddingBottom));
  const fitWidth = availableWidth / editing.image.naturalWidth;
  const requestedRatio = zoom === 'fit' ? Math.min(1, fitWidth, availableHeight / editing.image.naturalHeight) : Math.min(1, fitWidth * Number(zoom));
  const width = Math.max(1, Math.floor(editing.image.naturalWidth * requestedRatio));
  const height = Math.max(1, Math.round(editing.image.naturalHeight * (zoom === 'fit' ? requestedRatio : width / editing.image.naturalWidth)));
  const raster = boundedImageSize(width, height);
  canvas.width = raster.width; canvas.height = raster.height;
  canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
  const context = canvas.getContext('2d');
  if (!context) { toast('暂时无法显示此图，请退出检查后重试。'); return; }
  const scaleX = canvas.width / editing.image.naturalWidth, scaleY = canvas.height / editing.image.naturalHeight;
  context.drawImage(editing.image, 0, 0, canvas.width, canvas.height); paintMasks(context, editing.masks, scaleX, true, scaleY);
  if (drawing) { context.strokeStyle = '#ef913c'; context.lineWidth = 2; context.setLineDash([5,3]); context.strokeRect(drawing.x * scaleX, drawing.y * scaleY, (drawing.endX - drawing.x) * scaleX, (drawing.endY - drawing.y) * scaleY); }
  if (zoom === 'fit') viewport.scrollTo(0, 0);
  updateEditorScrollbar();
}
function editorPoint(event) { const rect = $('editorCanvas').getBoundingClientRect(); return { x: Math.min(editing.image.naturalWidth, Math.max(0,(event.clientX - rect.left) / rect.width * editing.image.naturalWidth)), y: Math.min(editing.image.naturalHeight, Math.max(0,(event.clientY - rect.top) / rect.height * editing.image.naturalHeight)) }; }
function resetEditorGesture() {
  const pointers = [...editorPointers.keys()];
  editorPointers.clear(); drawing = null; editorGesture = null; editorPanAnchor = null;
  for (const id of pointers) if ($('editorViewport').hasPointerCapture(id)) $('editorViewport').releasePointerCapture(id);
}
function editorPointerCenter() {
  const points = [...editorPointers.values()];
  return { x: points.reduce((sum, point) => sum + point.x, 0) / points.length, y: points.reduce((sum, point) => sum + point.y, 0) / points.length };
}
$('editorViewport').addEventListener('pointerdown', event => {
  if (!editing || (event.pointerType === 'mouse' && event.button !== 0)) return;
  event.preventDefault(); editorPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  try { $('editorViewport').setPointerCapture(event.pointerId); } catch {}
  if (editorPointers.size > 1 || !drawEnabled || editorGesture === 'pan') {
    drawing = null; editorGesture = 'pan'; editorPanAnchor = editorPointerCenter(); redrawEditor();
  } else if (event.target === $('editorCanvas')) {
    editorGesture = 'draw'; const point = editorPoint(event); drawing = { ...point, endX: point.x, endY: point.y };
  }
});
$('editorViewport').addEventListener('pointermove', event => {
  if (!editing || !editorPointers.has(event.pointerId)) return;
  event.preventDefault(); editorPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (editorGesture === 'pan') {
    const center = editorPointerCenter(), viewport = $('editorViewport');
    viewport.scrollLeft += editorPanAnchor.x - center.x; viewport.scrollTop += editorPanAnchor.y - center.y;
    editorPanAnchor = center; updateEditorScrollbar();
  } else if (drawing) { const point = editorPoint(event); drawing.endX = point.x; drawing.endY = point.y; redrawEditor(); }
});
function endEditorPointer(event) {
  if (!editorPointers.has(event.pointerId)) return;
  if (event.type === 'pointerup' && editing && editorGesture === 'draw' && drawing) {
    const point = editorPoint(event), x = Math.min(drawing.x, point.x), y = Math.min(drawing.y, point.y), width = Math.abs(point.x - drawing.x), height = Math.abs(point.y - drawing.y);
    if (width >= 7 && height >= 7) {
      editing.masks.push({ x:Math.floor(x), y:Math.floor(y), width:Math.ceil(x + width) - Math.floor(x), height:Math.ceil(y + height) - Math.floor(y), kind:'manual', source:'manual', style:editingStyle });
      markResultsStale();
    }
  }
  drawing = null; editorPointers.delete(event.pointerId);
  // Keep a two-finger gesture in pan mode until every finger is lifted.
  if (editorPointers.size) { editorGesture = 'pan'; editorPanAnchor = editorPointerCenter(); }
  else { editorGesture = null; editorPanAnchor = null; }
  redrawEditor();
}
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) $('editorViewport').addEventListener(type, endEditorPointer);
function updateEditorScrollbar() {
  const viewport = $('editorViewport'), bar = $('editorScrollbar'), thumb = $('editorScrollThumb');
  const maximum = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  bar.hidden = maximum <= 1;
  if (bar.hidden) return;
  const height = Math.min(bar.clientHeight, Math.max(32, bar.clientHeight * viewport.clientHeight / viewport.scrollHeight));
  thumb.style.height = `${height}px`;
  thumb.style.top = `${(bar.clientHeight - height) * viewport.scrollTop / maximum}px`;
  bar.setAttribute('aria-valuemax', String(Math.ceil(maximum))); bar.setAttribute('aria-valuenow', String(Math.round(viewport.scrollTop)));
}
$('editorViewport').addEventListener('scroll', updateEditorScrollbar, { passive: true });
function scrollEditorFromBar(clientY) {
  const viewport = $('editorViewport'), bar = $('editorScrollbar'), thumb = $('editorScrollThumb');
  const travel = bar.clientHeight - thumb.offsetHeight;
  if (travel > 0) viewport.scrollTop = Math.max(0, Math.min(1, (clientY - bar.getBoundingClientRect().top - scrollbarDrag.offset) / travel)) * (viewport.scrollHeight - viewport.clientHeight);
  updateEditorScrollbar();
}
$('editorScrollbar').addEventListener('pointerdown', event => {
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  event.preventDefault(); resetEditorGesture(); redrawEditor();
  const thumb = $('editorScrollThumb');
  scrollbarDrag = { id: event.pointerId, offset: event.target === thumb ? event.clientY - thumb.getBoundingClientRect().top : thumb.offsetHeight / 2 };
  try { $('editorScrollbar').setPointerCapture(event.pointerId); } catch {}
  scrollEditorFromBar(event.clientY);
});
$('editorScrollbar').addEventListener('pointermove', event => { if (scrollbarDrag?.id === event.pointerId) { event.preventDefault(); scrollEditorFromBar(event.clientY); } });
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) $('editorScrollbar').addEventListener(type, event => { if (scrollbarDrag?.id === event.pointerId) scrollbarDrag = null; });
$('editorScrollbar').addEventListener('keydown', event => {
  const viewport = $('editorViewport'), maximum = viewport.scrollHeight - viewport.clientHeight;
  const targets = { ArrowDown: viewport.scrollTop + 40, ArrowUp: viewport.scrollTop - 40, PageDown: viewport.scrollTop + viewport.clientHeight * .85, PageUp: viewport.scrollTop - viewport.clientHeight * .85, Home: 0, End: maximum };
  if (event.key in targets) { event.preventDefault(); viewport.scrollTop = targets[event.key]; updateEditorScrollbar(); }
});
$('maskList').addEventListener('click', event => { const button = event.target.closest('[data-mask-index]'); if (!button || !editing) return; editing.masks.splice(Number(button.dataset.maskIndex),1); markResultsStale(); redrawEditor(); });
$('undoMask').addEventListener('click', () => { if (!editing) return; const index = editing.masks.findLastIndex(mask => mask.source === 'manual'); if (index >= 0) { editing.masks.splice(index,1); markResultsStale(); redrawEditor(); } });
$('closeEditor').addEventListener('click', () => {
  if (editing && !editing.reviewed) { editing.reviewed = true; if (editing.status === 'error') markResultsStale(); }
  $('editor').close();
});
$('editor').addEventListener('close', async () => {
  const item = editing; resetEditorGesture(); scrollbarDrag = null; editing = null;
  document.body.classList.remove('editor-page-locked');
  document.body.style.removeProperty('--editor-page-top'); document.body.style.removeProperty('--editor-page-left');
  const restoreScroll = editorPageScroll; editorPageScroll = null;
  if (restoreScroll) window.scrollTo(restoreScroll.x, restoreScroll.y);
  if (!item) return;
  await refreshThumbnail(item); renderPhotos();
  if (renderedRevision !== state.revision && !state.busy && !editing) invalidateResults(0);
  await state.pendingRender;
  if (!editing) $('editorCanvas').width = $('editorCanvas').height = 1;
  // Replacing the result cards can move WebKit's scroll anchor after the dialog closes.
  if (restoreScroll && !editing) {
    window.scrollTo(restoreScroll.x, restoreScroll.y);
    requestAnimationFrame(() => { if (!editing && !$('editor').open) window.scrollTo(restoreScroll.x, restoreScroll.y); });
  }
});
window.addEventListener('resize', () => { if (editing) redrawEditor(); });
new ResizeObserver(() => { if (editing) redrawEditor(); }).observe($('editorViewport'));
$('helpButton').addEventListener('click', () => $('helpDialog').showModal()); $('closeHelp').addEventListener('click', () => $('helpDialog').close());
function updateModelButtons() {
  const disabled = ['loading', 'ready', 'unsupported'].includes(modelPhase);
  const text = modelPhase === 'ready' ? '模型已下载' : modelPhase === 'loading' ? '正在准备识别模型…' : modelPhase === 'error' ? '重试下载模型' : '提前下载识别模型';
  for (const id of ['downloadModelButton', 'prepareButton']) { $(id).disabled = disabled; $(id).textContent = text; }
  $('modelCacheTag').textContent = ({ ready: '已缓存', loading: '下载中', error: '未完成', unsupported: '不可用' })[modelPhase] || '未缓存';
  $('modelCacheTag').dataset.state = modelPhase;
}
function markModelsReady() {
  modelPhase = 'ready'; updateModelButtons(); updateOfflineStatus();
  $('modelDownloadState').textContent = '已下载 · 可离线使用';
  $('modelDownloadSource').textContent = $('prepareSource').textContent = '使用本机缓存';
  $('modelDownloadStatus').textContent = $('prepareStatus').textContent = '模型已保存在本机，选择照片即可识别。';
  for (const id of ['modelDownloadProgress', 'prepareProgress']) $(id).hidden = true;
}
function showModelPreparation(message, info) {
  if (info?.phase === 'ready') { markModelsReady(); return; }
  modelPhase = 'loading'; updateModelButtons();
  $('modelDownloadState').textContent = '正在准备本地识别模型';
  $('modelDownloadStatus').textContent = $('prepareStatus').textContent = message;
  if (info?.source) $('modelDownloadSource').textContent = $('prepareSource').textContent = `下载源：${info.source}`;
  for (const id of ['modelDownloadProgress', 'prepareProgress']) {
    const progress = $(id); progress.hidden = false;
    if (info?.total) progress.value = info.loaded / info.total;
    else progress.removeAttribute('value');
  }
}
function showModelError(error) {
  modelPhase = 'error'; updateModelButtons();
  $('modelDownloadState').textContent = '尚未准备完成 · 已下载的组件会保留';
  $('modelDownloadStatus').textContent = $('prepareStatus').textContent = error.message;
  for (const id of ['modelDownloadProgress', 'prepareProgress']) $(id).hidden = true;
}
async function refreshModelCache() {
  const status = await ocrCacheStatus();
  if (modelPhase !== 'idle') return;
  if (status.ready) markModelsReady();
  else if (!status.supported) {
    modelPhase = 'unsupported'; updateModelButtons();
    $('modelDownloadState').textContent = '离线缓存不可用';
    $('modelDownloadStatus').textContent = '请在 Safari 的 HTTPS 页面中打开后重试。';
  } else if (status.partial) {
    $('modelCacheTag').textContent = '部分缓存'; $('modelCacheTag').dataset.state = 'partial';
    $('modelDownloadState').textContent = '已保存部分组件 · 可继续下载';
    $('downloadModelButton').textContent = $('prepareButton').textContent = '继续下载识别模型';
  }
}
function downloadModels() {
  if (modelPreparation) return modelPreparation;
  if (modelPhase === 'ready') return Promise.resolve();
  showModelPreparation('正在准备模型，完成后即可选择照片。');
  modelPreparation = (async () => {
    try { await prepareOCR(showModelPreparation); markModelsReady(); }
    catch (error) { showModelError(error); }
    finally { modelPreparation = null; }
  })();
  return modelPreparation;
}
$('prepareButton').addEventListener('click', downloadModels);
$('downloadModelButton').addEventListener('click', downloadModels);
void refreshModelCache();
window.addEventListener('online', () => toast('网络已连接。')); window.addEventListener('offline', () => toast('当前离线，已缓存的识别组件仍可使用。'));
