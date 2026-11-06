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

const charWeight = char => /[\u2e80-\uffef]/.test(char) && !/[，。：（）]/.test(char) ? 1 : /[ilI.,:;!|\s]/.test(char) ? .28 : /[（）()]/.test(char) ? .4 : .57;

function tightenToInk(mask, target, pixelSource, imageWidth, imageHeight) {
  if (!pixelSource) return mask;
  const count = (target.match(/[0-9*＊•●]/g) || []).length;
  if (!count) return mask;
  const { canvas, image } = pixelSource;
  canvas.width = Math.min(mask.width, imageWidth - mask.x);
  canvas.height = Math.min(mask.height, imageHeight - mask.y);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, mask.x, mask.y, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
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
  const weights = Array.from(line.text).map(charWeight);
  const total = weights.reduce((a, b) => a + b, 0);
  const before = weights.slice(0, start).reduce((a, b) => a + b, 0);
  const target = weights.slice(start, end).reduce((a, b) => a + b, 0);
  const pad = Math.max(6, height * .2);
  const left = Math.max(0, x + width * before / total - pad);
  const top = Math.max(0, y - pad);
  const mask = { x: Math.floor(left), y: Math.floor(top), width: Math.ceil(Math.min(imageWidth - left, width * target / total + pad * 2)), height: Math.ceil(Math.min(imageHeight - top, height + pad * 2)), kind, source: 'auto' };
  return tightenToInk(mask, line.text.slice(start, end), pixelSource, imageWidth, imageHeight);
}

export function detectSensitive(items, imageWidth, imageHeight, image) {
  const pixelSource = image && typeof document !== 'undefined' ? { image, canvas: document.createElement('canvas') } : null;
  const lines = items.filter(item => item.text && item.poly?.length >= 4).map(item => ({ ...item, text: item.text.replace(/\s+/g, ''), box: bounds(item.poly) }));
  const masks = [];
  const add = (line, match, kind) => {
    const box = textRegion(line, match.index, match.index + match[0].length, kind, imageWidth, imageHeight, pixelSource);
    if (!masks.some(m => m.kind === kind && Math.abs(m.x - box.x) < 16 && Math.abs(m.y - box.y) < 16)) masks.push(box);
  };
  const isSameRow = (a, b) => Math.abs(a.box.y + a.box.height / 2 - b.box.y - b.box.height / 2) < Math.max(a.box.height, b.box.height) * .62;
  const nearbyRight = label => lines.filter(line => line !== label && isSameRow(label, line) && line.box.x > label.box.x + label.box.width * .7).sort((a, b) => a.box.x - b.box.x);
  const cardKey = /(?:银行卡尾[号数]|银行卡号|卡号尾[号数]|卡号后四位|尾[号数])/;
  const balanceKey = /可用(?:余额|余額|额度|額度|金额|金額|余领|余颤)/;
  for (const line of lines) {
    const card = line.text.match(cardKey);
    if (card) {
      const after = card.index + card[0].length;
      const number = /[0-9*＊•●]{4,19}/.exec(line.text.slice(after));
      if (number) { number.index += after; add(line, number, 'card'); }
      else for (const candidate of nearbyRight(line)) {
        const digits = /[0-9*＊•●]{4,19}/.exec(candidate.text);
        if (digits) { add(candidate, digits, 'card'); break; }
      }
    }
    const balance = line.text.match(balanceKey);
    if (balance) {
      const after = balance.index + balance[0].length;
      const money = /[-−]?[\d,，]+(?:[.．]\d{1,2})?/.exec(line.text.slice(after));
      if (money) { money.index += after; add(line, money, 'balance'); }
      else for (const candidate of nearbyRight(line)) {
        const digits = /[-−]?[\d,，]+(?:[.．]\d{1,2})?/.exec(candidate.text);
        if (digits) { add(candidate, digits, 'balance'); break; }
      }
    }
  }
  if (pixelSource) pixelSource.canvas.width = pixelSource.canvas.height = 1;
  return masks;
}

// Independent opaque pixels remove all source information within a mask.
// Conventional downsampled mosaic can retain the shapes of short card numbers.
export function paintMasks(context, masks, scale = 1, outlines = false) {
  for (let index = 0; index < masks.length; index++) {
    const mask = masks[index];
    const x = Math.floor(mask.x * scale), y = Math.floor(mask.y * scale);
    const width = Math.ceil(mask.width * scale), height = Math.ceil(mask.height * scale);
    const style = mask.kind === 'manual' ? mask.style || 'mosaic' : 'mosaic';
    context.save(); context.globalAlpha = 1; context.globalCompositeOperation = 'source-over';
    // Manual cells remain fixed in source pixels, independently of selection size.
    const block = mask.kind === 'manual'
      ? Math.max(1, Math.round(24 * scale))
      : Math.max(3, Math.round(mask.height * scale / 3));
    let seed = ((mask.x * 73856093) ^ (mask.y * 19349663) ^ (index * 83492791)) >>> 0;
    if (style === 'solid') {
      context.fillStyle = '#ededed'; context.fillRect(x, y, width, height);
    } else if (style === 'smear') {
      // An opaque base removes the original pixels before adding a light brush texture.
      context.fillStyle = '#f5f5f5'; context.fillRect(x, y, width, height);
      context.save(); context.beginPath(); context.rect(x, y, width, height); context.clip();
      const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
      const count = Math.max(3, Math.ceil(mask.width * mask.height / 14000));
      context.lineCap = 'round';
      for (let stroke = 0; stroke < count; stroke++) {
        const cx = x + random() * width, cy = y + random() * height;
        const length = (90 + random() * 130) * scale, grey = Math.round(229 + random() * 17);
        context.strokeStyle = `rgb(${grey},${grey},${grey})`;
        context.lineWidth = (18 + random() * 24) * scale;
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
    if (outlines) { context.strokeStyle = '#1b9b88'; context.lineWidth = Math.max(1, 2 * scale); context.strokeRect(x, y, width, height); }
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

export function outputGeometry(left, right, direction = 'horizontal') {
  if (direction === 'vertical') {
    const width = Math.max(left.naturalWidth, right.naturalWidth);
    const firstHeight = Math.round(left.naturalHeight * width / left.naturalWidth);
    const secondHeight = Math.round(right.naturalHeight * width / right.naturalWidth);
    const ratio = Math.min(1, Math.sqrt(12_000_000 / (width * (firstHeight + secondHeight))), 8192 / width, 8192 / (firstHeight + secondHeight));
    const targetFirstHeight = Math.max(1, Math.floor(firstHeight * ratio)), targetSecondHeight = Math.max(1, Math.floor(secondHeight * ratio));
    return { width: Math.max(1, Math.floor(width * ratio)), height: targetFirstHeight + targetSecondHeight, firstHeight: targetFirstHeight, secondHeight: targetSecondHeight, resized: ratio < 1 };
  }
  const height = Math.max(left.naturalHeight, right.naturalHeight);
  const leftWidth = Math.round(left.naturalWidth * height / left.naturalHeight);
  const rightWidth = Math.round(right.naturalWidth * height / right.naturalHeight);
  const ratio = Math.min(1, Math.sqrt(12_000_000 / ((leftWidth + rightWidth) * height)), 8192 / (leftWidth + rightWidth), 8192 / height);
  const targetHeight = Math.round(height * ratio);
  const firstWidth = Math.round(leftWidth * ratio), secondWidth = Math.round(rightWidth * ratio);
  return { width: firstWidth + secondWidth, height: targetHeight, leftWidth: firstWidth, rightWidth: secondWidth, resized: ratio < 1 };
}

export async function composePair(left, right, settings, direction = 'horizontal') {
  const vertical = direction === 'vertical';
  const geometry = outputGeometry(left.image, right.image, direction);
  const canvas = document.createElement('canvas');
  canvas.width = geometry.width; canvas.height = geometry.height;
  const context = canvas.getContext('2d', { alpha: false });
  context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
  let offset = 0;
  const images = vertical
    ? [[left, geometry.width, geometry.firstHeight], [right, geometry.width, geometry.secondHeight]]
    : [[left, geometry.leftWidth, geometry.height], [right, geometry.rightWidth, geometry.height]];
  for (const [item, width, height] of images) {
    context.save(); context.translate(vertical ? 0 : offset, vertical ? offset : 0);
    context.drawImage(item.image, 0, 0, width, height);
    paintMasks(context, item.masks, vertical ? width / item.image.naturalWidth : height / item.image.naturalHeight);
    context.restore(); offset += vertical ? height : width;
  }
  paintWatermark(context, canvas.width, canvas.height, settings);
  try {
    const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('生成图片失败，请减少一次选择的照片数量后重试。')), 'image/png'));
    return { blob, ...geometry };
  } finally { canvas.width = canvas.height = 1; }
}

export async function makeThumbnail(item) {
  const canvas = document.createElement('canvas');
  const scale = 300 / item.image.naturalHeight;
  canvas.width = Math.round(item.image.naturalWidth * scale); canvas.height = 300;
  const context = canvas.getContext('2d');
  context.drawImage(item.image, 0, 0, canvas.width, canvas.height);
  paintMasks(context, item.masks, scale);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .82));
  canvas.width = canvas.height = 1;
  return URL.createObjectURL(blob);
}
