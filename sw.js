/*
 * sw.js — the offline service worker.
 *
 * Why this exists: the app is used on a stand, on an iPhone or iPad, in rooms
 * with no usable signal. Everything it needs is already static files; without a
 * worker they simply fail to load when the network does.
 *
 * The caching strategy is chosen around ONE hazard: a service worker that pins
 * users to a stale build. That is much worse here than a slow load, because the
 * only CI console is GitHub Actions and a wedged client cannot be debugged from
 * a phone. So:
 *
 *   - **Navigations are network-first.** Online, you always get today's HTML,
 *     which means today's script URLs. The cache is only the fallback when the
 *     network fails. A bad deploy can never be permanently pinned by the worker.
 *   - **Same-origin assets are stale-while-revalidate.** Instant from cache,
 *     refreshed in the background, so the next load is current. This self-heals
 *     without needing the cache version to be bumped by hand.
 *   - **Cross-origin (CDN) requests are cache-first, best-effort.** See the
 *     honest limit at the bottom.
 *
 * Everything is wrapped so a cache failure degrades to a plain network fetch —
 * the worker must never be the reason the app stops working.
 */
var CACHE_VERSION = 'v1';
var CACHE = 'csmp-' + CACHE_VERSION;

/*
 * The app shell. These are exactly the files the deploy step copies into dist/,
 * so tests/pwa.test.mjs pins this list against the CI copy list — a script that
 * ships but is not precached would work online and vanish offline, which is the
 * kind of bug that only shows up on stage.
 */
var PRECACHE = [
  './',
  './index.html',
  './ui.css',
  './utils.js',
  './chordTheory.js',
  './chordProcessing.js',
  './csmpnParser.js',
  './settings.js',
  './musicFont.js',
  './musicXmlCore.js',
  './brassTranspose.js',
  './renderer.js',
  './importPipeline.js',
  './importGuitarPro.js',
  './powerTabImporter.js',
  './chordSlashMLRenderer.js',
  './backupRestore.js',
  './audioPlayback.js',
  './lyricsView.js',
  './stageSheets.js',
  './performanceLyrics.js',
  './audioCapture.js',
  './abcSuite.js',
  './midiImport.js',
  './chordsheetPdf.js',
  './sheetOcr.js',
  './offlineStore.js',
  './recognitionBridge.js',
  './recognitionEngine.mjs',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches
      .open(CACHE)
      .then(function (cache) {
        // addAll is atomic — one 404 would reject the whole install and leave
        // the app with no worker at all. Each file is added on its own so a
        // single missing asset costs only that asset.
        return Promise.all(
          PRECACHE.map(function (url) {
            return cache.add(url).catch(function () {
              /* not fatal: it will be picked up at runtime */
            });
          })
        );
      })
      .catch(function () {
        /* no cache storage — the app still works online */
      })
  );
  // Take over promptly; combined with network-first navigation this shortens the
  // window where a fresh install serves nothing.
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (names) {
        return Promise.all(
          names.map(function (n) {
            // Drop caches from older versions of this app, and nothing else.
            return n !== CACHE && n.indexOf('csmp-') === 0 ? caches.delete(n) : null;
          })
        );
      })
      .then(function () {
        return self.clients.claim();
      })
      .catch(function () {})
  );
});

function putSafe(request, response) {
  // Only cache real, complete same-origin responses. An opaque or partial
  // response stored here would be served back as though it were the truth.
  if (!response || response.status !== 200 || response.type !== 'basic') return response;
  var copy = response.clone();
  caches
    .open(CACHE)
    .then(function (c) {
      c.put(request, copy);
    })
    .catch(function () {});
  return response;
}

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;

  var url;
  try {
    url = new URL(req.url);
  } catch (_e) {
    return;
  }

  // Navigations: network first, cache as the offline fallback. This is what
  // keeps a deploy from being pinned, and it also keeps ?import=handoff working
  // (the query is carried to the network; the fallback is the shell, which reads
  // the handoff from localStorage anyway).
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(function (res) {
          return putSafe(req, res);
        })
        .catch(function () {
          return caches.match('./index.html').then(function (hit) {
            return hit || caches.match('./');
          });
        })
    );
    return;
  }

  // Cross-origin (the CDN libraries): cache-first, best effort. See the limit note.
  if (url.origin !== self.location.origin) {
    event.respondWith(
      caches.match(req).then(function (hit) {
        return (
          hit ||
          fetch(req)
            .then(function (res) {
              var copy = res.clone();
              caches
                .open(CACHE)
                .then(function (c) {
                  c.put(req, copy);
                })
                .catch(function () {});
              return res;
            })
            .catch(function () {
              return hit;
            })
        );
      })
    );
    return;
  }

  // Same-origin assets: stale-while-revalidate.
  event.respondWith(
    caches.match(req).then(function (hit) {
      var net = fetch(req)
        .then(function (res) {
          return putSafe(req, res);
        })
        .catch(function () {
          return hit;
        });
      return hit || net;
    })
  );
});

/*
 * HONEST LIMIT — third-party libraries.
 *
 * abcjs, VexFlow, AlphaTab and pdf.js load from CDNs and are fetched lazily, on
 * first use of the feature that needs them. They are cached here once fetched,
 * so a feature you have used before keeps working offline — but a feature you
 * have NEVER opened while online will not work offline the first time. Those
 * responses are also opaque (no-cors), so their success cannot be verified;
 * they are stored as-is.
 *
 * The core chart work — writing, rendering, Slash-Rhythm View, setlists,
 * printing — is all first-party and fully precached above.
 */
