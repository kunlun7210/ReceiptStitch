const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '../dist');
const fixtures = process.env.SAMPLE_DIR || path.resolve(__dirname, '../../fixtures');
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.mjs':'text/javascript', '.json':'application/json', '.css':'text/css', '.png':'image/png', '.svg':'image/svg+xml', '.wasm':'application/wasm', '.jpg':'image/jpeg', '.tar':'application/octet-stream' };
function createServer({basePath = '/'} = {}) { return http.createServer(async (req, res) => {
  let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (basePath !== '/') {
    if (pathname === basePath.slice(0,-1)) return res.writeHead(301,{Location:basePath}).end();
    if (!pathname.startsWith(basePath)) return res.writeHead(404).end();
    pathname = '/' + pathname.slice(basePath.length);
  }
  const allowedRoot = pathname.startsWith('/fixtures/') ? fixtures : root;
  const route = pathname.startsWith('/fixtures/') ? pathname.slice('/fixtures/'.length) : pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(allowedRoot, route);
  if (!file.startsWith(allowedRoot + path.sep)) return res.writeHead(403).end();
  try {
    res.setHeader('Content-Type', types[path.extname(file).toLowerCase()] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.end(await fs.readFile(file));
  } catch { res.writeHead(404).end(); }
}); }
module.exports = createServer;
if (require.main === module) createServer().listen(48721, '127.0.0.1', () => console.log('Local: http://127.0.0.1:48721'));
