/* Service worker: houdt de app zelf beschikbaar (ook bij slecht bereik).
 * Eigen bestanden: eerst netwerk (zodat updates direct doorkomen), anders uit cache.
 * Kaarttegels en zoekdiensten worden niet opgeslagen. */
const CACHE = 'kaartdata-v7';
const APP = [
  './', 'index.html', 'css/style.css', 'js/gate.js', 'js/store.js', 'js/share.js', 'js/plan.js', 'js/app.js', 'manifest.webmanifest',
  'vendor/leaflet/leaflet.css', 'vendor/leaflet/leaflet.js',
  'vendor/geoman/leaflet-geoman.css', 'vendor/geoman/leaflet-geoman.min.js',
  'vendor/turf/turf.min.js', 'icons/icon-192.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(APP)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })   // altijd bij de server controleren op een nieuwe versie
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html')))
  );
});
