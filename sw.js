const SHELL = 'receipt-stitch-shell-v8';
const OCR = 'receipt-stitch-ocr-v1';
const FILES = ['./','./index.html','./styles.css','./app.js','./processing.js','./ocr.js','./manifest.webmanifest','./icon.svg','./icon-192.png','./icon-512.png','./apple-touch-icon.png'];
self.addEventListener('install', event => { event.waitUntil(caches.open(SHELL).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', event => { event.waitUntil((async () => {
  for (const key of await caches.keys()) if (key.startsWith('receipt-stitch-shell-') && key !== SHELL) await caches.delete(key);
  await self.clients.claim();
})()); });
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET' || url.pathname.includes('/fixtures/')) return;
  if (url.pathname.includes('/ocr/')) {
    event.respondWith((async () => (await (await caches.open(OCR)).match(event.request)) || fetch(event.request))());
    return;
  }
  if (event.request.mode === 'navigate') {
    event.respondWith((async () => (await (await caches.open(SHELL)).match('./index.html')) || fetch(event.request))());
    return;
  }
  // Shell uses a versioned cache; never persist sign-in or callback responses.
  if (FILES.slice(1).some(file => new URL(file, self.registration.scope).pathname === url.pathname)) {
    event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
  }
});
