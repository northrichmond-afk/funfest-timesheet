// Caches the app shell so it opens without signal. Never caches Supabase API calls.
const CACHE = 'ff-shell-v5';
const SHELL = [
  './', './index.html', './app.js', './app.css', './manifest.webmanifest', './icon.svg', './icon-192.png',
  '../shared/styles.css', '../shared/config.js', '../shared/supabase.js', '../shared/hours.js', '../shared/ui.js', '../shared/search.js', '../shared/login.js', '../shared/native.js',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.hostname.endsWith('supabase.co')) return;
  // Network first (so updates arrive), fall back to cache when offline
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok && (url.origin === location.origin || url.hostname === 'esm.sh')) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
