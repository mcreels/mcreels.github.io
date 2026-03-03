/* eslint-env serviceworker */

const CACHE_PREFIX = "wedding-reels-";
const CACHE_NAME = `${CACHE_PREFIX}v1`;
const MEDIA_CACHE = `${CACHE_PREFIX}media-v1`;
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
  const keep = new Set([CACHE_NAME, MEDIA_CACHE]);
  await Promise.all(
    keys
      .filter((key) => key.startsWith(CACHE_PREFIX) && !keep.has(key))
      .map((key) => caches.delete(key)),
  );
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
    return (
      (await cache.match(request)) ||
      (await cache.match("./")) ||
      (await cache.match("./index.html")) ||
      new Response("Offline", { status: 503, statusText: "Offline" })
    );
  }
}

function isLikelyVideoRequest(request) {
  if (request.destination === "video") return true;
  try {
    const url = new URL(request.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;

    const host = url.hostname;
    if (
      host.endsWith(".googleapis.com") &&
      url.pathname.includes("/drive/v3/files/") &&
      url.searchParams.get("alt") === "media"
    ) {
      return true;
    }
    if (host === "drive.google.com" && url.pathname === "/uc" && url.searchParams.get("export") === "download") {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

async function cacheVideo(event) {
  const request = event.request;
  const cache = await caches.open(MEDIA_CACHE);
  const cacheKey = request.url;

  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  // Always fetch a full response (no Range header) so we can cache the entire video for offline use.
  const fullRequest = new Request(request.url, {
    method: "GET",
    mode: request.mode,
    credentials: request.credentials,
    redirect: request.redirect,
  });

  try {
    const res = await fetch(fullRequest);
    event.waitUntil(
      (async () => {
        try {
          const isOpaque = res.type === "opaque" || res.type === "opaqueredirect";
          if (!isOpaque && !res.ok) return;
          await cache.put(cacheKey, res.clone());
        } catch {
          // Ignore quota / caching errors. Playback still works.
        }
      })(),
    );
    return res;
  } catch {
    return new Response("Offline", { status: 503, statusText: "Offline" });
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    precache()
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

self.addEventListener("message", (event) => {
  const data = event?.data;
  if (!data || typeof data !== "object") return;
  if ("type" in data && data.type === "SKIP_WAITING") {
    event.waitUntil(self.skipWaiting());
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  if (isLikelyVideoRequest(request)) {
    event.respondWith(cacheVideo(event));
    return;
  }

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

  if (pathname.endsWith(".js") || pathname.endsWith(".css")) {
    event.respondWith(networkFirst(request));
    return;
  }

  if (pathname.endsWith(".html")) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});
