import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
const root = path.resolve('dist');
const required = ['index.html','app.js','processing.js','ocr.js','styles.css','sw.js','manifest.webmanifest','icon.svg','icon-192.png','icon-512.png','apple-touch-icon.png'];
for (const file of required) if ((await fs.stat(path.join(root,file))).size === 0) throw new Error(`Empty: ${file}`);
const manifest = JSON.parse(await fs.readFile(path.join(root,'ocr/manifest.json'),'utf8'));
for (const entry of manifest.files) {
  const bytes = entry.parts ? Buffer.concat(await Promise.all(entry.parts.map(file => fs.readFile(path.join(root,file))))) : await fs.readFile(path.join(root,entry.file));
  if (bytes.length !== entry.bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error(`Asset mismatch: ${entry.file}`);
}
const html = await fs.readFile(path.join(root,'index.html'),'utf8');
if (html.includes('type="color"') || !html.includes('智能隐私拼图')) throw new Error('Requested UI changes missing');
const visit = async dir => { for (const entry of await fs.readdir(dir,{withFileTypes:true})) { const file = path.join(dir,entry.name); if (entry.isDirectory()) await visit(file); else { if (/^(?:\d+|\d+\+\d+)\.(?:png|jpg)$/i.test(entry.name)) throw new Error(`Private sample in deployment: ${entry.name}`); if ((await fs.stat(file)).size > 25 * 1024 * 1024) throw new Error(`Static asset exceeds 25 MiB: ${file}`); } } };
await visit(root);
console.log(`Verified ${required.length} shell assets, ${manifest.files.length} OCR asset hashes, and no private samples.`);
