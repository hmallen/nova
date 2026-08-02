/* Nova service worker — deliberately dumb. The app is useless offline (the
 * whole point is a live OpenAI session), so this exists only to satisfy
 * installability and make loads instant. Strategy: network-first with cache
 * fallback for the same-origin static shell; /api/* and cross-origin
 * requests (OpenAI, Open-Meteo) pass through untouched.
 *
 * Bump CACHE whenever a shell file changes — hand-managed versioning is
 * acceptable for a shell this small.
 */

const CACHE = "nova-v5";
const SHELL = [
  "/",
  "/app.js",
  "/lib/helpers.js",
  "/style.css",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith("nova-") && k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/")) return;
  e.respondWith(
    fetch(e.request)
      .then((resp) => {
        if (resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return resp;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
