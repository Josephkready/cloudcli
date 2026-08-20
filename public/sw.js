// Service Worker for CloudCLI PWA
// Cache only manifest (needed for PWA install). HTML and JS are never cached
// here at all, so a rebuild + refresh always picks up the latest assets.
//
// Bump this by hand whenever the cached set changes. It is *not* a per-build
// version and must not become one — see the note on `activate` for why a build
// hash cannot work in this repo, and why it no longer needs to (issue #372).
const CACHE_NAME = 'claude-ui-v3';
const urlsToCache = [
  '/manifest.json'
];

// Install event
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
  self.skipWaiting();
});

// Fetch event — network-first throughout; nothing here writes to the cache
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // Never intercept API requests or WebSocket upgrades
  if (url.includes('/api/') || url.includes('/ws')) {
    return;
  }

  // Navigation requests (HTML) — always go to network, no caching
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('/manifest.json').then(() =>
        new Response('<h1>Offline</h1><p>Please check your connection.</p>', {
          headers: { 'Content-Type': 'text/html' }
        })
      ))
    );
    return;
  }

  // NOTE: /assets/ is deliberately not cached here (issue #372).
  //
  // This used to be a cache-first branch that `put` every hashed JS/CSS chunk
  // into CACHE_NAME. Because the filenames are content-hashed, each deploy added
  // a whole fresh set and nothing ever removed the previous one — the cache grew
  // by one full build per deploy, forever. That is the failure mode iOS punishes
  // hardest, since it evicts an origin's storage wholesale and opaquely.
  //
  // Removing it costs nothing, because the HTTP cache already does this job and
  // does it better: server/middleware/compression.ts serves everything matching
  // IMMUTABLE_ASSET_PATTERN out of dist/ as
  // `Cache-Control: public, max-age=31536000, immutable`. So a hashed chunk was
  // being held twice — once in a browser-managed cache with real eviction, and
  // once in a Cache Storage bucket with none. Only the second one was a leak.
  //
  // There is also no offline capability to lose: the navigate branch above has
  // no cached shell to fall back on and answers with a static "Offline" page, so
  // cached chunks could never have been used without a network anyway.
  //
  // Everything else — network-first. Nothing but /manifest.json is precached, so
  // the fallback almost always resolves to undefined and the request fails; log
  // it, because a silent failure here is indistinguishable from a bug in the app.
  event.respondWith(
    fetch(event.request).catch(() => {
      console.warn('[sw] fetch failed, no cached fallback:', url);
      return caches.match(event.request);
    })
  );
});

// Activate event — purge every cache that is not the current one.
//
// This fires only when the *bytes of this file* change: the browser byte-compares
// sw.js on navigation and does nothing if it matches, so `install`/`activate`
// never re-run between deploys that leave this file alone. That is why deriving
// CACHE_NAME from a build hash is not the fix it looks like — and in this repo it
// cannot work at all, because server/index.js mounts `public/` ahead of `dist/`
// (see mountStaticAssets in server/middleware/compression.ts). A build step that
// stamped `dist/sw.js` would emit a file that never reaches the wire; `/sw.js`
// always answers from this un-stamped source, which is also what
// compression.test.ts pins.
//
// It no longer needs to. Nothing accumulates now that /assets/ is uncached, so
// the only job left is the one-shot cleanup: bumping v2 -> v3 changes these bytes,
// which is what makes this handler run once per install and delete the caches
// that earlier builds piled up.
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      const stale = cacheNames.filter(name => name !== CACHE_NAME);
      // The one-shot cleanup is the whole point of the version bump, and it runs
      // on a user's device where nothing else can observe it. Without this line
      // there is no way to tell from a devtools console whether it ever fired.
      if (stale.length) {
        console.info('[sw] purging stale caches:', stale.join(', '));
      }
      return Promise.all(stale.map(name => caches.delete(name)));
    })
  );
  self.clients.claim();
});

// Push notification event
self.addEventListener('push', event => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'CloudCLI', body: event.data.text() };
  }

  const options = {
    body: payload.body || '',
    icon: '/logo-256.png',
    badge: '/logo-128.png',
    data: payload.data || {},
    tag: payload.data?.tag || `${payload.data?.sessionId || 'global'}:${payload.data?.code || 'default'}`,
    renotify: true
  };

  event.waitUntil(
    self.registration.showNotification(payload.title || 'CloudCLI', options)
  );
});

// Notification click event
self.addEventListener('notificationclick', event => {
  event.notification.close();

  const sessionId = event.notification.data?.sessionId;
  const provider = event.notification.data?.provider || null;
  const urlPath = sessionId ? `/session/${sessionId}` : '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async clientList => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin)) {
          await client.focus();
          client.postMessage({
            type: 'notification:navigate',
            sessionId: sessionId || null,
            provider,
            urlPath
          });
          return;
        }
      }
      return self.clients.openWindow(urlPath);
    })
  );
});
