import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { gzipSync } from 'node:zlib';

const root = path.resolve('dist');
const manifestPath = path.join(root, 'ocr/manifest.json');
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
let original = 0, transferred = 0;
await fs.mkdir(path.join(root, 'ocr/transport-v1'), { recursive: true });
for (const file of manifest.files) {
  const bytes = file.parts
    ? Buffer.concat(await Promise.all(file.parts.map(part => fs.readFile(path.join(root, part)))))
    : await fs.readFile(path.join(root, file.file));
  if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) throw new Error(`Original asset changed: ${file.file}`);
  const compressed = gzipSync(bytes, { level: 9 });
  file.transport = { file: `ocr/transport-v1/${file.sha256}.gz`, bytes: compressed.length, sha256: digest(compressed) };
  await fs.writeFile(path.join(root, file.transport.file), compressed);
  original += bytes.length; transferred += compressed.length;
}
manifest.version = 2;
await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ original, transferred, savedPercent: +(100 * (1 - transferred / original)).toFixed(1) }));
