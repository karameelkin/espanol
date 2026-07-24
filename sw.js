// Service worker: network-first for the app shell (fresh code online, cached offline),
// cache-first for audio clips (immutable, saved once).

const SHELL_CACHE = 'span-shell-v1';
const AUDIO_CACHE = 'span-audio-v1';

const SHELL = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'fsrs.js',
  'db.js',
  'audio.js',
  'deck.json',
  'manifest.webmanifest',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-512-maskable.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== SHELL_CACHE && k !== AUDIO_CACHE).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

async function cacheFirst(req) {
  const cache = await caches.open(AUDIO_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    return new Response('', { status: 504 });
  }
}

async function networkFirst(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const hit = await cache.match(req);
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const idx = await cache.match('index.html');
      if (idx) return idx;
    }
    return new Response('', { status: 504 });
  }
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.includes('/audio/')) e.respondWith(cacheFirst(e.request));
  else e.respondWith(networkFirst(e.request));
});
