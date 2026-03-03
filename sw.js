/* eslint-env serviceworker */

const CACHE_NAME = "wedding-reels-v1";
const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/maskable-192.png",
  "./icons/maskable-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon.ico",
  "./icons/favicon-32.png",
  "./icons/favicon-16.png",
];

async function precache() {
  const cache = await caches.open(CACHE_NAME);
  await cache.addAll(PRECACHE_URLS);
}

async function cleanupOldCaches() {
  const keys = await caches.keys();
  await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch {
    return new Response("Offline", { status: 503, statusText: "Offline" });
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request)
    .then((res) => {
      if (res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => null);

  if (cached) return cached;
  const res = await fetchPromise;
  if (res) return res;
  return new Response("Offline", { status: 503, statusText: "Offline" });
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    return new Response("Offline", { status: 503, statusText: "Offline" });
  }
}

async function navigationNetworkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch {
    return (await cache.match(request)) || (await cache.match("./")) || (await cache.match("./index.html")) || new Response("Offline", { status: 503, statusText: "Offline" });
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    precache()
      .then(() => self.skipWaiting())
      .catch(() => {
        // If precache fails, still install so fetch handler can do runtime caching.
      }),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    cleanupOldCaches()
      .then(() => self.clients.claim())
      .catch(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(navigationNetworkFirst(request));
    return;
  }

  const pathname = url.pathname;
  if (pathname.endsWith("/data.bin") || pathname.endsWith("/data.json")) {
    event.respondWith(networkFirst(request));
    return;
  }

  if (pathname.endsWith(".png") || pathname.endsWith(".ico")) {
    event.respondWith(cacheFirst(request));
    return;
  }

  if (pathname.endsWith(".js") || pathname.endsWith(".css") || pathname.endsWith(".html")) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});
