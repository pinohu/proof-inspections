/* ProofInspect contractor app shell service worker.
   Cache-first for the app shell; network-first for API reads; never cache POSTs. */
const CACHE = "pi-contractor-v1";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isApi(url) {
  return url.includes("/contractor/") || url.includes("/orders/");
}

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return; // never cache writes
  const url = e.request.url;
  if (isApi(url)) {
    // API: network first, fall back to cache (offline job list reuse)
    e.respondWith(
      fetch(e.request)
        .then((r) => {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
          return r;
        })
        .catch(() => caches.match(e.request))
    );
  } else {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
  }
});
