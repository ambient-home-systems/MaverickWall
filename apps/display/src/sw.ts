/**
 * The service worker: the shell, so a reload works with the server down.
 *
 * The stored manifest is useless if the page that reads it cannot load, and a
 * reload with no server fails at the very first request — the HTML. This
 * caches the handful of files that make up the wall so that request is
 * answered from the device.
 *
 * **It will not register over plain http.** Service workers require a secure
 * context, and a household browsing to `http://192.168.1.10:8080` does not
 * have one; only `localhost` and https qualify. That is a limitation of the
 * platform rather than a choice, and `main.ts` treats registration as
 * best-effort for exactly that reason. The stored manifest still does its job
 * on http for the far commoner case: a wall that stays loaded for months while
 * the server comes and goes underneath it.
 *
 * Compiled as its own entry point and served from the root, because a worker
 * can only control the paths at or below where it is served from.
 */

/// <reference lib="webworker" />

/*
 * A typed alias rather than a redeclaration of `self`.
 *
 * Redeclaring it shadows the lib's own global and the event map goes with it;
 * making the file a module to allow the shadow would emit an ES module worker,
 * which needs `{ type: 'module' }` at registration and is not something to
 * assume of whatever browser is bolted to a wall.
 */
const worker = self as unknown as ServiceWorkerGlobalScope;

/*
 * Bumping this name is what retires an old cache.
 *
 * A wall updates when its container does, which may be months apart, so the
 * old cache has to go on the way in rather than lingering for a version of
 * the bundle nobody is running.
 */
const CACHE = 'maverick-wall-shell-v1';

/**
 * Everything needed to draw without a network.
 *
 * Listed rather than discovered at runtime: a worker that caches whatever it
 * happens to see would also cache a half-built page from a bad deploy and
 * serve it for ever. The list itself, though, is generated rather than
 * hand-maintained — `scripts/generate-shell.mjs` rewrites it after the build
 * by walking `main.js`'s own `import` graph, and `test/sw-shell.test.ts`
 * pins the two in parity from source. It has drifted three times by hand
 * already; nothing here should require editing it by hand again.
 */
const SHELL = [
  '/',
  '/assets/display.css',
  '/assets/main.js',
  '/assets/clock.js',
  '/assets/density.js',
  '/assets/ladder.js',
  '/assets/manifest.js',
  '/assets/month-spans.js',
  '/assets/orientation.js',
  '/assets/render.js',
  '/assets/store.js',
  '/assets/theme.js',
  '/assets/tiers.js',
  '/assets/viewmodel.js',
  '/assets/watchdog.js',
  '/assets/widget-options.js',
  '/assets/widget-views.js',
];

worker.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) =>
        // Individually, not `addAll`: one missing file must not throw away the
        // whole cache and leave the wall with nothing.
        Promise.all(
          SHELL.map((path) =>
            fetch(path, { cache: 'reload' })
              .then((response) => (response.ok ? cache.put(path, response) : undefined))
              .catch(() => undefined),
          ),
        ),
      )
      // Taking over immediately. The alternative is a wall running the old
      // bundle until every tab closes, which on a wall is never.
      .then(() => worker.skipWaiting()),
  );
});

worker.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))),
      )
      .then(() => worker.clients.claim()),
  );
});

worker.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== worker.location.origin) return;

  /*
   * The manifest and the pictures are never served from here.
   *
   * A stale manifest handed back by a cache would be indistinguishable from a
   * fresh one, and the display would have no idea it was showing an old day —
   * which is the precise failure this whole feature exists to prevent. The
   * display keeps its own copy and knows exactly how old it is.
   */
  if (url.pathname.startsWith('/d/')) return;

  /*
   * The shell is served cache-first and refreshed behind the reader.
   *
   * A wall must paint from the device even when the server is unreachable, and
   * a network-first shell would make every reload wait for a timeout first.
   */
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached ?? Response.error());

      return cached ?? network;
    }),
  );
});
