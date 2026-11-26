// Service Worker çekirdeği: uygulamanın internetsiz AÇILABİLMESİ (uygulama kabuğu).
// Tarif verisi burada tutulmaz (o src/offlineCache.js, hesap bazında IndexedDB).
//
// Bu dosya İÇE AKTARMA İÇERMEZ: vite.config.js derlemede `export` sözcüklerini
// atıp src/sw/swMain.js ile birleştirerek dist/sw.js'i üretir; testler ise
// doğrudan ESM olarak içe aktarır (test/serviceWorker.test.mjs).
//
// Yönlendirme (yalnızca aynı origin, GET):
//  - "/" gezinmesi (sorgu dizesi ne olursa olsun; ?sharePanel=1 HARİÇ):
//    ağ önce. Başarılı HTML yanıtı "/" anahtarıyla saklanır. Ağ yoksa ya da
//    önbellekte kopya varken TIMEOUT içinde gelmezse saklanan kopya verilir.
//    Android'de Capacitor 8 native köprüyü WebView destekliyorsa belge başı
//    betiğiyle (addDocumentStartJavaScript) ekler; önbellekten açılan sayfada da
//    çalışır (emülatörde doğrulandı). Bu özelliği olmayan eski WebView'lerde köprü
//    native vekilin HTML'e enjekte ettiği betiktir: yalnızca gerçek gezinme yanıtı
//    saklandığı için o kopya da betiği içerir.
//    Kurulumda da kabuk alınır (Accept: text/html ile; native vekil bu başlıkla
//    köprüyü enjekte eder): yalnız gezinmeye bağlı kalınca kabuk ancak İKİNCİ
//    internetli açılışta saklanıyordu ve yeni sürümü bir kez açıp internetsiz
//    deneyen kullanıcı "Web sayfası mevcut değil" görüyordu (26 Kasım, telefonda).
//    Yönlendirilen (ör. Vercel giriş sayfası) ya da 200 olmayan yanıt saklanmaz.
//  - "/assets/*" (içerik özetli dosya adları): önbellek önce; yoksa ağ + sakla.
//  - Birkaç statik dosya (manifest, ikonlar): ağ önce, yoksa önbellek.
//  - Geri kalan her şey (api, version.json, sw.js, paylaşım paneli, başka
//    origin'ler, POST): Service Worker hiç karışmaz (respondWith yok).
// Paylaşım paneli bilerek dışarıda: internetsiz açıldığında native ShareActivity
// kendi "bağlanılamadı" ekranını göstermeye devam eder.

export const SHELL_CACHE = "tk-shell-v1";
export const ASSET_CACHE_PREFIX = "tk-assets-";
export const STATIC_PATHS = ["/manifest.json", "/icon.svg", "/icon-192.png", "/icon-512.png"];
export const NAV_TIMEOUT_MS = 4000;

export function routeRequest(request, origin) {
  if (request.method !== "GET") return "bypass";
  let url;
  try {
    url = new URL(request.url);
  } catch (e) {
    return "bypass";
  }
  if (url.origin !== origin) return "bypass";
  if (request.mode === "navigate") {
    if (url.pathname !== "/" && url.pathname !== "/index.html") return "bypass";
    if (url.searchParams.get("sharePanel") === "1") return "bypass";
    return "shell";
  }
  if (url.pathname.startsWith("/assets/")) return "asset";
  if (STATIC_PATHS.includes(url.pathname)) return "static";
  return "bypass";
}

export function createSwLogic({ caches, fetch, build, assets, origin, timeoutMs = NAV_TIMEOUT_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const assetCache = `${ASSET_CACHE_PREFIX}${build}`;
  const isHtml = (res) => /text\/html/i.test(res.headers.get("content-type") || "");

  async function precacheShell() {
    try {
      const res = await fetch(
        new Request(new URL("/", origin).href, { cache: "reload", credentials: "same-origin", headers: { Accept: "text/html" } })
      );
      if (res && res.status === 200 && !res.redirected && isHtml(res)) await (await caches.open(SHELL_CACHE)).put("/", res);
    } catch (e) {
      // ağ yoksa ilk gezinmede saklanır
    }
  }

  async function install() {
    await precacheShell();
    const cache = await caches.open(assetCache);
    // Tek tek: bir dosya alınamazsa kurulum yine biter (ilk kullanımda ağdan gelir).
    await Promise.all(
      (assets || []).map(async (path) => {
        try {
          if (await cache.match(path)) return;
          const res = await fetch(new Request(new URL(path, origin).href, { cache: "reload" }));
          if (res && res.ok) await cache.put(path, res);
        } catch (e) {
          // yok say
        }
      })
    );
  }

  // Eski sürümlerin dosyaları: bu sürüm + bir önceki tutulur (açık kalmış eski
  // sayfa tembel yüklenen bir parçasını isteyebilir); daha eskileri silinir.
  async function activate() {
    const names = await caches.keys();
    const builds = names
      .filter((n) => n.startsWith(ASSET_CACHE_PREFIX))
      .map((n) => n.slice(ASSET_CACHE_PREFIX.length))
      .filter((b) => b !== String(build))
      .sort((a, b) => Number(b) - Number(a));
    const keep = new Set([assetCache, SHELL_CACHE, ...builds.slice(0, 1).map((b) => `${ASSET_CACHE_PREFIX}${b}`)]);
    await Promise.all(names.filter((n) => n.startsWith("tk-") && !keep.has(n)).map((n) => caches.delete(n)));
  }

  async function shell(request) {
    const cache = await caches.open(SHELL_CACHE);
    const cached = await cache.match("/");
    const network = fetch(request).then(async (res) => {
      if (res && res.status === 200 && isHtml(res)) await cache.put("/", res.clone());
      return res;
    });
    if (!cached) return network;
    return new Promise((resolve) => {
      let done = false;
      const finish = (res) => {
        if (done) return;
        done = true;
        clearTimer(timer);
        resolve(res);
      };
      const timer = setTimer(() => finish(cached.clone()), timeoutMs);
      network.then(
        (res) => finish(res && res.ok ? res : cached.clone()),
        () => finish(cached.clone())
      );
    });
  }

  async function asset(request) {
    const url = new URL(request.url);
    const key = url.pathname;
    const hit = await caches.match(key);
    if (hit) return hit;
    const res = await fetch(request);
    if (res && res.ok) {
      const cache = await caches.open(assetCache);
      await cache.put(key, res.clone());
    }
    return res;
  }

  async function staticFile(request) {
    const key = new URL(request.url).pathname;
    try {
      const res = await fetch(request);
      if (res && res.ok) {
        const cache = await caches.open(SHELL_CACHE);
        await cache.put(key, res.clone());
      }
      return res;
    } catch (e) {
      const hit = await caches.match(key);
      if (hit) return hit;
      throw e;
    }
  }

  // null → Service Worker karışmaz.
  function handleFetch(request) {
    const route = routeRequest(request, origin);
    if (route === "shell") return shell(request);
    if (route === "asset") return asset(request);
    if (route === "static") return staticFile(request);
    return null;
  }

  return { install, activate, handleFetch, assetCache };
}
