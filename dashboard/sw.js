/* Fire Potential Dashboard — PWA shell worker.
   Release discipline: bump CACHE together with APP_VERSION in index.html on EVERY release —
   the byte-diff here is what triggers the client update banner.
   Data policy: weather / FEMS / NWS requests never touch this cache. The app layer owns
   staleness (45-min weather cache, FEMS age pills) — the worker only guarantees the shell
   and the zone layer open on a ridgetop with no signal. */
const CACHE = "fpd-shell-v112";
const SHELL = [
  "./",
  "index.html",
  "zones_west.geojson",
  "manifest.json",
  "leaflet/leaflet.css",
  "leaflet/leaflet.js",
  "leaflet/images/marker-icon.png",
  "leaflet/images/marker-icon-2x.png",
  "leaflet/images/marker-shadow.png",
  "leaflet/images/layers.png",
  "leaflet/images/layers-2x.png",
  "icon-192.png",
  "icon-512.png",
  "icon-180.png"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", e => {
  if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; /* Open-Meteo, FEMS, NWS, tiles: network only */
  const scopePath = new URL(self.registration.scope).pathname;
  if (!url.pathname.startsWith(scopePath)) return; /* stay out of the rest of the site (FPB lives beside us) */
  e.respondWith(
    caches.match(req, { ignoreSearch: req.mode === "navigate" }).then(hit =>
      hit || (req.mode === "navigate"
        ? caches.match("index.html").then(ix => ix || fetch(req))
        : fetch(req))
    )
  );
});
