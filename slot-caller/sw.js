/**
 * sw.js — offline support.
 *
 * Casino wifi is unreliable and basements have no signal, so the app must keep
 * working with no network. The app shell is precached on install; the much
 * larger text-recognition engine and its language data are cached the first
 * time they are fetched, after which meter reading is fully offline.
 *
 * The Anthropic API is never cached — it is a live call by definition, and it
 * is the only part of the app that needs a connection.
 */

const VERSION = 'slotcaller-v1';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './src/app.js',
  './src/audio.js',
  './src/camera.js',
  './src/cloud.js',
  './src/engine.js',
  './src/frame.js',
  './src/ocr.js',
  './src/reading.js',
  './src/session.js',
  './src/simulator.js',
  './src/speech.js',
];

const RUNTIME_CACHEABLE = [
  'cdn.jsdelivr.net',          // tesseract.js, its wasm core, and eng.traineddata
  'cdnjs.cloudflare.com',      // fallback mirror for the same
  'tessdata.projectnaptha.com',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.hostname === 'api.anthropic.com') return;   // never cache live calls

  const runtime = RUNTIME_CACHEABLE.includes(url.hostname);

  if (runtime) {
    // Cache first: these files are large, versioned, and never change.
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok || res.type === 'opaque') {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      }))
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  // Network first for our own files so an update is picked up promptly,
  // falling back to the cache when there is no signal.
  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
  );
});
