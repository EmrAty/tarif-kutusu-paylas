/* global self, caches, SW_BUILD, SW_ASSETS, createSwLogic */
// dist/sw.js'in giriş kısmı (vite.config.js: SW_BUILD ve SW_ASSETS sabitleri +
// swLogic.js bunun önüne eklenir). Elle düzenlenen kaynak: src/sw/swLogic.js.
const logic = createSwLogic({
  caches,
  fetch: (req) => fetch(req),
  build: SW_BUILD,
  assets: SW_ASSETS,
  origin: self.location.origin,
});

self.addEventListener("install", (event) => {
  event.waitUntil(logic.install().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(logic.activate().then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const response = logic.handleFetch(event.request);
  if (response) event.respondWith(response);
});
