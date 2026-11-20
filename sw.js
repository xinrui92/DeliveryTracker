/* Delivery Tracker service worker
   - App shell (HTML/CSS/JS/icons + Supabase library) is cached so the app opens instantly and offline.
   - Own files: network-first, so new deploys show up straight away; cache is the offline fallback.
   - Supabase API / auth / realtime traffic is never cached (always live data, respects security). */
const VERSION = "dt-v2";
const SHELL = [
  "/",
  "/index.html",
  "/css/styles.css",
  "/js/config.js",
  "/js/app.js",
  "/js/pwa.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
  "/icons/favicon-32.png",
  "/icons/logo.png",
];
const CDN = [
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cache.addAll(SHELL);
    await Promise.all(CDN.map((u) => fetch(u, { mode: "cors" }).then((r) => r.ok && cache.put(u, r)).catch(() => {})));
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data === "skipWaiting") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Never touch Supabase (data, auth, functions, realtime)
  if (url.hostname.endsWith(".supabase.co") || url.hostname.endsWith(".supabase.in")) return;

  const sameOrigin = url.origin === self.location.origin;
  const isCdn = url.hostname === "cdn.jsdelivr.net";
  const isFont = url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";

  if (sameOrigin) {
    // Network first, fall back to cache (and to the app shell for navigations)
    event.respondWith((async () => {
      const cache = await caches.open(VERSION);
      try {
        const res = await fetch(req);
        if (res.ok) cache.put(req.mode === "navigate" ? "/index.html" : req, res.clone());
        return res;
      } catch (_) {
        return (await cache.match(req)) || (req.mode === "navigate" ? await cache.match("/index.html") : undefined) || Response.error();
      }
    })());
    return;
  }

  if (isCdn || isFont) {
    // Cache first for third-party static assets
    event.respondWith((async () => {
      const cache = await caches.open(VERSION);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok || res.type === "opaque") cache.put(req, res.clone());
        return res;
      } catch (_) {
        return Response.error();
      }
    })());
  }
});
