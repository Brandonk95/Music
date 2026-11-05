// Offline support: network-first for app files (so updates show immediately),
// falling back to the cache when offline. API calls are never cached here.
const CACHE = 'tempotune-v5';
const ASSETS = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/audio.js', 'js/metronome.js', 'js/metronome-engine.js', 'js/notes.js', 'js/pitch.js',
  'js/settings.js', 'js/settings-view.js', 'js/sounds.js', 'js/store.js', 'js/tone.js', 'js/tuner.js',
  'js/ui.js', 'js/wakelock.js', 'js/personalize.js', 'js/clock.js', 'js/acoustic.js', 'js/capture-worklet.js', 'js/party.js', 'js/party-ui.js', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-180.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/_/')) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' }) // revalidate: never mix old and new app files
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))),
  );
});
