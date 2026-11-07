export const DEFAULTS = Object.freeze({ text: '机器/收款码办理 详询VX：kunlun7210', fontSize: 50, transparency: 70, color: '#b3b3b3' });
export const COMMON_COLORS = Object.freeze([
  ['#ff0000','红色'], ['#000000','黑色'], ['#0055ff','蓝色'], ['#b3b3b3','浅灰'],
]);
export const PALETTE = Object.freeze([
  ['#376b20','深绿'],['#fa8210','橙色'],['#e85b00','深橙'],['#b9191c','深红'],['#442923','深棕'],['#141414','黑色'],
  ['#6ca236','草绿'],['#ffc42d','金黄'],['#ff8500','橙黄'],['#d92a2e','红色'],['#66483c','棕色'],['#666666','深灰'],
  ['#8dc246','青绿'],['#ffeb3c','亮黄'],['#ff9900','亮橙'],['#ff443a','朱红'],['#805d4c','浅棕'],['#8e8e8e','灰色'],
  ['#acd67e','浅绿'],['#fff275','淡黄'],['#ffb74e','浅橙'],['#e97378','浅红'],['#a88f85','灰棕'],['#b3b3b3','浅灰'],
  ['#deedc9','淡绿'],['#fff8c2','奶黄'],['#ffe0ae','淡橙'],['#ffcbd1','淡粉'],['#d7cbc7','淡棕'],['#dddddd','淡灰'],
]);

export function bounds(poly) {
  const xs = poly.map(p => p[0]), ys = poly.map(p => p[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

const charWeight = char => (char.length > 1 || /[\u2e80-\uffef]/.test(char)) && !/[，。：（）]/.test(char) ? 1 : /[ilI.,:;!|\s]/.test(char) ? .28 : /[（）()]/.test(char) ? .4 : .57;

function tightenToInk(mask, target, pixelSource, imageWidth, imageHeight) {
  if (!pixelSource || mask.width * mask.height > 1_000_000) return mask;
  const count = (target.match(/[0-9０-９*＊•●]/g) || []).length;
  if (!count) return mask;
  const { canvas, image } = pixelSource;
  canvas.width = Math.min(mask.width, imageWidth - mask.x);
  canvas.height = Math.min(mask.height, imageHeight - mask.y);
  let pixels;
  try {
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, mask.x, mask.y, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
    pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  } catch { return mask; }
  const runs = [];
  let run;
  for (let x = 0; x < canvas.width; x++) {
    let top = canvas.height, bottom = -1;
    for (let y = 0; y < canvas.height; y++) {
      const offset = (y * canvas.width + x) * 4;
      if (pixels[offset + 3] > 200 && Math.max(pixels[offset], pixels[offset + 1], pixels[offset + 2]) < 170) {
        top = Math.min(top, y); bottom = Math.max(bottom, y);
      }
    }
    if (bottom >= 0) {
      if (!run) run = { left: x, right: x, top, bottom };
      else { run.right = x; run.top = Math.min(run.top, top); run.bottom = Math.max(run.bottom, bottom); }
    } else if (run) { runs.push(run); run = undefined; }
  }
  if (run) runs.push(run);
  const heights = runs.map(r => r.bottom - r.top + 1).filter(h => h >= mask.height * .25).sort((a,b) => a-b);
  if (!heights.length) return mask;
  const glyphHeight = heights[Math.floor(heights.length / 2)];
  if (glyphHeight >= mask.height * .92) return mask;
  const tall = r => r.bottom - r.top + 1 >= glyphHeight * .58;
  let best;
  for (let start = 0; start < runs.length; start++) {
    if (!tall(runs[start])) continue;
    let digits = 0;
    for (let end = start; end < runs.length; end++) {
      if (tall(runs[end])) digits++;
      if (digits > count) break;
      if (digits !== count || !tall(runs[end])) continue;
      const group = runs.slice(start, end + 1);
      const left = group[0].left, right = group[group.length - 1].right;
      const top = Math.min(...group.map(r => r.top)), bottom = Math.max(...group.map(r => r.bottom));
      // A decimal point may be a separate short run or touch a neighbouring digit.
      const score = Math.abs((left + right) / 2 - mask.width / 2) * 4 / glyphHeight
        + Math.abs(right - left + 1 - mask.width) / mask.width * .2
        + group.filter(tall).reduce((sum,r) => sum + Math.max(0, r.bottom-r.top+1-glyphHeight*1.18) / glyphHeight, 0);
      if (!best || score < best.score) best = { left, right, top, bottom, score };
    }
  }
  if (!best) return mask;
  const pad = Math.max(2, Math.round((best.bottom - best.top + 1) * .06));
  const x = Math.max(0, mask.x + best.left - pad), y = Math.max(0, mask.y + best.top - pad);
  const right = Math.min(imageWidth, mask.x + best.right + 1 + pad);
  const bottom = Math.min(imageHeight, mask.y + best.bottom + 1 + pad);
  return { ...mask, x, y, width: right - x, height: bottom - y };
}

function textRegion(line, start, end, kind, imageWidth, imageHeight, pixelSource) {
  const { x, y, width, height } = line.box;
  const weight = text => Array.from(text).reduce((sum, char) => sum + charWeight(char), 0);
  const total = weight(line.text), before = weight(line.text.slice(0, start)), target = weight(line.text.slice(start, end));
  const pad = Math.max(6, height * .2);
  const left = Math.max(0, x + width * before / total - pad);
  const top = Math.max(0, y - pad);
  const mask = { x: Math.floor(left), y: Math.floor(top), width: Math.ceil(Math.min(imageWidth - left, width * target / total + pad * 2)), height: Math.ceil(Math.min(imageHeight - top, height + pad * 2)), kind, source: 'auto' };
  if (!(mask.width > 0 && mask.height > 0)) return null;
  return tightenToInk(mask, line.text.slice(start, end), pixelSource, imageWidth, imageHeight);
}

// Keep matching offsets aligned with the original OCR text, including full-width glyphs.
const halfWidth = text => text.replace(/[！-～]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
const fieldKey = /([银銀]行卡(?:尾[号號数數]|[号號])|卡[号號]尾[号號数數]|卡[号號][后後]四位|尾[号號数數])|(可用(?:[余餘][额額领颤]|[额額]度|金[额額]))|(?:交易(?:金[额額]|[时時][间間]|日期|[类類]型)|消[费費]金[额額]|支[付出]金[额額]|[转轉][账帳]金[额額]|[发發]生金[额額]|扣款金[额額]|[账帳][单單]金[额額]|[订訂][单單][号號])/g;
const cardValue = /^(?:[:=(【\[]|为|為|是|[后後末][四4]位)*([0-9*•●]{4,19}(?:[-–][0-9*•●]{2,4})*)/;
// A recognized separator may be misread, but all digits in the amount still need covering.
const balanceValue = /^(?:[:=(【\[,]|为|為|是|人民[币幣]|[港澳][币幣元]|美[元金]|[欧歐]元|[台臺][币幣]|日[元圓]|英[镑鎊]|RMB|CNY|CNH|HKD|MOP|TWD|USD|EUR|GBP|JPY|KRW|SGD|AUD|CAD|NZD|CHF|[$€£¥￥₩￦₹])*([+\-−]?\d+(?:[.,]\d+)*)/i;

export function detectSensitive(items, imageWidth, imageHeight, image) {
  const pixelSource = image && typeof document !== 'undefined' ? { image, canvas: document.createElement('canvas') } : null;
  const lines = items.filter(item => typeof item.text === 'string' && item.text.trim() && Array.isArray(item.poly) && item.poly.length >= 4
    && item.poly.every(point => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]))).map(item => {
      const text = item.text.replace(/\s+/g, ''), matchText = halfWidth(text);
      return { text, matchText, box: bounds(item.poly), fields: [...matchText.matchAll(fieldKey)] };
    }).filter(({box}) => box.width > 0 && box.height > 0 && box.x < imageWidth && box.y < imageHeight && box.x + box.width > 0 && box.y + box.height > 0);
  const masks = [];
  const add = (line, start, end, kind) => {
    const box = textRegion(line, start, end, kind, imageWidth, imageHeight, pixelSource);
    if (box && !masks.some(m => m.kind === kind && Math.abs(m.x - box.x) < 16 && Math.abs(m.y - box.y) < 16)) masks.push(box);
  };
  const isSameRow = (a, b) => Math.abs(a.box.y + a.box.height / 2 - b.box.y - b.box.height / 2) < Math.max(a.box.height, b.box.height) * .62;
  const nearbyRight = label => lines.filter(line => line !== label && isSameRow(label, line) && line.box.x > label.box.x + label.box.width * .7
    && line.box.x - label.box.x - label.box.width <= Math.max(10 * label.box.height, imageWidth * .22)).sort((a, b) => a.box.x - b.box.x);
  const addValue = (line, kind, from, to) => {
    const match = (kind === 'card' ? cardValue : balanceValue).exec(line.matchText.slice(from, to));
    if (!match) return false;
    const end = from + match[0].length;
    add(line, end - match[1].length, end, kind);
    return true;
  };
  try {
    for (const line of lines) for (let index = 0; index < line.fields.length; index++) {
      const field = line.fields[index], next = line.fields[index + 1];
      const kind = field[1] ? 'card' : field[2] ? 'balance' : null;
      if (!kind || addValue(line, kind, field.index + field[0].length, next?.index) || next) continue;
      for (const candidate of nearbyRight(line)) {
        if (addValue(candidate, kind, 0, candidate.fields[0]?.index) || candidate.fields.length) break;
      }
    }
  } finally { if (pixelSource) pixelSource.canvas.width = pixelSource.canvas.height = 1; }
  return masks;
}

// Independent opaque pixels remove all source information within a mask.
// Conventional downsampled mosaic can retain the shapes of short card numbers.
export function paintMasks(context, masks, scale = 1, outlines = false, scaleY = scale) {
  for (let index = 0; index < masks.length; index++) {
    const mask = masks[index];
    const x = Math.floor(mask.x * scale), y = Math.floor(mask.y * scaleY);
    const width = Math.ceil((mask.x + mask.width) * scale) - x, height = Math.ceil((mask.y + mask.height) * scaleY) - y;
    if (!(width > 0 && height > 0)) continue;
    const cellScale = Math.min(scale, scaleY);
    const style = mask.kind === 'manual' ? mask.style || 'mosaic' : 'mosaic';
    context.save(); context.globalAlpha = 1; context.globalCompositeOperation = 'source-over';
    // Manual cells remain fixed in source pixels, independently of selection size.
    const block = mask.kind === 'manual'
      ? Math.max(1, Math.round(24 * cellScale))
      : Math.max(3, Math.round(mask.height * scaleY / 3));
    let seed = ((mask.x * 73856093) ^ (mask.y * 19349663) ^ (index * 83492791)) >>> 0;
    if (style === 'solid') {
      context.fillStyle = '#ededed'; context.fillRect(x, y, width, height);
    } else if (style === 'smear') {
      // An opaque base removes the original pixels before adding a light brush texture.
      context.fillStyle = '#f5f5f5'; context.fillRect(x, y, width, height);
      context.save(); context.beginPath(); context.rect(x, y, width, height); context.clip();
      const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
      const count = Math.max(3, Math.min(2000, Math.ceil(mask.width * mask.height / 14000)));
      context.lineCap = 'round';
      for (let stroke = 0; stroke < count; stroke++) {
        const cx = x + random() * width, cy = y + random() * height;
        const length = (90 + random() * 130) * cellScale, grey = Math.round(229 + random() * 17);
        context.strokeStyle = `rgb(${grey},${grey},${grey})`;
        context.lineWidth = (18 + random() * 24) * cellScale;
        context.beginPath(); context.moveTo(cx - length * .4, cy + length * .24);
        context.quadraticCurveTo(cx, cy - length * .12, cx + length * .4, cy - length * .24); context.stroke();
      }
      context.restore();
    } else {
      for (let row = 0; row < height; row += block) for (let col = 0; col < width; col += block) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const grey = [190, 205, 218, 230, 240][seed % 5];
        context.fillStyle = `rgb(${grey},${grey},${grey})`;
        context.fillRect(x + col, y + row, Math.min(block, width - col), Math.min(block, height - row));
      }
    }
    if (outlines) { context.strokeStyle = '#1b9b88'; context.lineWidth = Math.max(1, 2 * cellScale); context.strokeRect(x, y, width, height); }
    context.restore();
  }
}

export function paintWatermark(context, width, height, settings) {
  if (!settings.text.trim()) return;
  const size = settings.fontSize * 96 / 72;
  context.save();
  context.fillStyle = settings.color;
  context.globalAlpha = 1 - settings.transparency / 100;
  context.font = `${size}px -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif`;
  context.textBaseline = 'middle';
  context.translate(width / 2, height / 2);
  context.rotate(-Math.PI / 6);
  const length = Math.hypot(width, height);
  const spacingX = context.measureText(settings.text).width + size * 2.1;
  const spacingY = size * 3.6;
  let row = 0;
  for (let y = -length; y <= length; y += spacingY, row++) {
    for (let x = -length + (row % 2 ? -spacingX / 2 : 0); x <= length; x += spacingX) context.fillText(settings.text, x, y);
  }
  context.restore();
}

export function boundedImageSize(width, height) {
  const ratio = Math.min(1, Math.sqrt(12_000_000 / (width * height)), 8192 / width, 8192 / height);
  return { width: Math.max(1, Math.floor(width * ratio)), height: Math.max(1, Math.floor(height * ratio)), resized: ratio < 1 };
}

export function outputGeometry(left, right, direction = 'horizontal') {
  if (!right) return boundedImageSize(left.naturalWidth, left.naturalHeight);
  if (direction === 'vertical') {
    const width = Math.max(left.naturalWidth, right.naturalWidth);
    const firstHeight = Math.round(left.naturalHeight * width / left.naturalWidth);
    const secondHeight = Math.round(right.naturalHeight * width / right.naturalWidth);
    const size = boundedImageSize(width, firstHeight + secondHeight);
    const height = Math.max(2, size.height);
    const first = Math.max(1, Math.min(height - 1, Math.round(height * firstHeight / (firstHeight + secondHeight))));
    return { ...size, height, firstHeight: first, secondHeight: height - first };
  }
  const height = Math.max(left.naturalHeight, right.naturalHeight);
  const leftWidth = Math.round(left.naturalWidth * height / left.naturalHeight);
  const rightWidth = Math.round(right.naturalWidth * height / right.naturalHeight);
  const size = boundedImageSize(leftWidth + rightWidth, height);
  const width = Math.max(2, size.width);
  const first = Math.max(1, Math.min(width - 1, Math.round(width * leftWidth / (leftWidth + rightWidth))));
  return { ...size, width, leftWidth: first, rightWidth: width - first };
}

export async function composePair(left, right, settings, direction = 'horizontal') {
  const vertical = direction === 'vertical';
  const geometry = outputGeometry(left.image, right?.image, direction);
  const canvas = document.createElement('canvas');
  canvas.width = geometry.width; canvas.height = geometry.height;
  try {
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('图片暂时无法生成，请减少一次处理的照片数量后重试。');
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
    let offset = 0;
    const images = !right ? [[left, geometry.width, geometry.height]] : vertical
      ? [[left, geometry.width, geometry.firstHeight], [right, geometry.width, geometry.secondHeight]]
      : [[left, geometry.leftWidth, geometry.height], [right, geometry.rightWidth, geometry.height]];
    for (const [item, width, height] of images) {
      context.save(); context.translate(vertical ? 0 : offset, vertical ? offset : 0);
      context.beginPath(); context.rect(0, 0, width, height); context.clip();
      context.drawImage(item.image, 0, 0, width, height);
      paintMasks(context, item.masks, width / item.image.naturalWidth, false, height / item.image.naturalHeight);
      context.restore(); offset += vertical ? height : width;
    }
    paintWatermark(context, canvas.width, canvas.height, settings);
    const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('生成图片失败，请减少一次选择的照片数量后重试。')), 'image/png'));
    return { blob, ...geometry };
  } finally { canvas.width = canvas.height = 1; }
}

export async function makeThumbnail(item) {
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 300 / item.image.naturalWidth, 300 / item.image.naturalHeight);
  canvas.width = Math.max(1, Math.round(item.image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(item.image.naturalHeight * scale));
  try {
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(item.image, 0, 0, canvas.width, canvas.height);
    paintMasks(context, item.masks, canvas.width / item.image.naturalWidth, false, canvas.height / item.image.naturalHeight);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .82));
    return blob ? URL.createObjectURL(blob) : null;
  } finally { canvas.width = canvas.height = 1; }
}
