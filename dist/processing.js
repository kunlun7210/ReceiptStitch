export const DEFAULTS = Object.freeze({ text: '机器/收款码办理 详询VX：kunlun7210', fontSize: 50, transparency: 70, color: '#b3b3b3' });
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

function textRegion(line, start, end, kind, imageWidth, imageHeight) {
  const { x, y, width, height } = line.box;
  const weights = Array.from(line.text).map(charWeight);
  const total = weights.reduce((a, b) => a + b, 0);
  const before = weights.slice(0, start).reduce((a, b) => a + b, 0);
  const target = weights.slice(start, end).reduce((a, b) => a + b, 0);
  const pad = Math.max(6, height * .2);
  const left = Math.max(0, x + width * before / total - pad);
  const top = Math.max(0, y - pad);
  return { x: Math.floor(left), y: Math.floor(top), width: Math.ceil(Math.min(imageWidth - left, width * target / total + pad * 2)), height: Math.ceil(Math.min(imageHeight - top, height + pad * 2)), kind, source: 'auto' };
}

export function detectSensitive(items, imageWidth, imageHeight) {
  const lines = items.filter(item => item.text && item.poly?.length >= 4).map(item => ({ ...item, text: item.text.replace(/\s+/g, ''), box: bounds(item.poly) }));
  const masks = [];
  const add = (line, match, kind) => {
    const box = textRegion(line, match.index, match.index + match[0].length, kind, imageWidth, imageHeight);
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
  return masks;
}

// Independent opaque pixels remove all source information within a mask.
// Conventional downsampled mosaic can retain the shapes of short card numbers.
export function paintMasks(context, masks, scale = 1, outlines = false) {
  for (let index = 0; index < masks.length; index++) {
    const mask = masks[index];
    const x = Math.floor(mask.x * scale), y = Math.floor(mask.y * scale);
    const width = Math.ceil(mask.width * scale), height = Math.ceil(mask.height * scale);
    const block = Math.max(3, Math.round(mask.height * scale / 3));
    let seed = ((mask.x * 73856093) ^ (mask.y * 19349663) ^ (index * 83492791)) >>> 0;
    for (let row = 0; row < height; row += block) for (let col = 0; col < width; col += block) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const grey = [30, 65, 105, 145, 185][seed % 5];
      context.fillStyle = `rgb(${grey},${grey},${grey})`;
      context.fillRect(x + col, y + row, Math.min(block, width - col), Math.min(block, height - row));
    }
    if (outlines) { context.strokeStyle = '#1b9b88'; context.lineWidth = Math.max(1, 2 * scale); context.strokeRect(x, y, width, height); }
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

export function outputGeometry(left, right) {
  const height = Math.max(left.naturalHeight, right.naturalHeight);
  const leftWidth = Math.round(left.naturalWidth * height / left.naturalHeight);
  const rightWidth = Math.round(right.naturalWidth * height / right.naturalHeight);
  const ratio = Math.min(1, Math.sqrt(12_000_000 / ((leftWidth + rightWidth) * height)), 8192 / (leftWidth + rightWidth), 8192 / height);
  const targetHeight = Math.round(height * ratio);
  const firstWidth = Math.round(leftWidth * ratio), secondWidth = Math.round(rightWidth * ratio);
  return { width: firstWidth + secondWidth, height: targetHeight, leftWidth: firstWidth, rightWidth: secondWidth, resized: ratio < 1 };
}

export async function composePair(left, right, settings) {
  const geometry = outputGeometry(left.image, right.image);
  const canvas = document.createElement('canvas');
  canvas.width = geometry.width; canvas.height = geometry.height;
  const context = canvas.getContext('2d', { alpha: false });
  context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
  let offset = 0;
  for (const [item, width] of [[left, geometry.leftWidth], [right, geometry.rightWidth]]) {
    context.save(); context.translate(offset, 0);
    context.drawImage(item.image, 0, 0, width, geometry.height);
    paintMasks(context, item.masks, geometry.height / item.image.naturalHeight);
    context.restore(); offset += width;
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
