// Service Worker çekirdeği (src/sw/swLogic.js): Node'un yerleşik Request/Response'u
// ve bellek içi Cache Storage taklidiyle. Gerçek tarayıcı/WebView davranışı
// (Capacitor köprü enjeksiyonu dahil) cihazda ayrıca doğrulanmalı.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createSwLogic, routeRequest, SHELL_CACHE } from "../src/sw/swLogic.js";

const ORIGIN = "https://tarifkutusu.app";

function memoryCaches() {
  const stores = new Map();
  const keyOf = (req) => (typeof req === "string" ? new URL(req, ORIGIN).pathname : new URL(req.url).pathname);
  const open = async (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name);
    return {
      match: async (req) => (m.has(keyOf(req)) ? m.get(keyOf(req)).clone() : undefined),
      put: async (req, res) => void m.set(keyOf(req), res.clone()),
    };
  };
  return {
    stores,
    open,
    keys: async () => [...stores.keys()],
    delete: async (n) => stores.delete(n),
    match: async (req) => {
      for (const m of stores.values()) if (m.has(keyOf(req))) return m.get(keyOf(req)).clone();
      return undefined;
    },
  };
}

const nav = (path) => ({ method: "GET", mode: "navigate", url: `${ORIGIN}${path}` });
const get = (path, origin = ORIGIN) => ({ method: "GET", mode: "cors", url: `${origin}${path}` });
const html = (body) => new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });

test("yönlendirme: yalnızca kabuk, /assets ve statik dosyalar; api/paylaşım paneli/başka origin karışmaz", () => {
  assert.equal(routeRequest(nav("/"), ORIGIN), "shell");
  assert.equal(routeRequest(nav("/?recipeShare=abc"), ORIGIN), "shell");
  assert.equal(routeRequest(nav("/?sharePanel=1"), ORIGIN), "bypass");
  assert.equal(routeRequest(nav("/privacy"), ORIGIN), "bypass");
  assert.equal(routeRequest(get("/assets/index-abc.js"), ORIGIN), "asset");
  assert.equal(routeRequest(get("/manifest.json"), ORIGIN), "static");
  assert.equal(routeRequest(get("/api/data?bucket=recipes"), ORIGIN), "bypass");
  assert.equal(routeRequest(get("/version.json"), ORIGIN), "bypass");
  assert.equal(routeRequest(get("/sw.js"), ORIGIN), "bypass");
  assert.equal(routeRequest(get("/assets/x.js", "https://evil.example"), ORIGIN), "bypass");
  assert.equal(routeRequest({ method: "POST", mode: "cors", url: `${ORIGIN}/assets/x.js` }, ORIGIN), "bypass");
});

test("kabuk: çevrimiçi ağdan gelen HTML saklanır; çevrimdışı saklanan kopya (köprü betiğiyle) verilir", async () => {
  const caches = memoryCaches();
  let online = true;
  const fetch = async () => {
    if (!online) throw new TypeError("Failed to fetch");
    return html("<html><script>/*capacitor-bridge*/</script>v1</html>");
  };
  const sw = createSwLogic({ caches, fetch, build: "100", assets: [], origin: ORIGIN });
  const r1 = await sw.handleFetch(nav("/"));
  assert.match(await r1.text(), /v1/);
  online = false;
  const r2 = await sw.handleFetch(nav("/?openRecipe=1"));
  const body = await r2.text();
  assert.match(body, /capacitor-bridge/, "native vekilin enjekte ettiği hâli saklanır");
});

test("kabuk: hiç kopya yokken çevrimdışı → ağ hatası (sahte sayfa üretilmez); 401/500 saklanmaz", async () => {
  const caches = memoryCaches();
  const sw = createSwLogic({ caches, fetch: async () => { throw new TypeError("offline"); }, build: "1", assets: [], origin: ORIGIN });
  await assert.rejects(sw.handleFetch(nav("/")));
  const sw2 = createSwLogic({ caches, fetch: async () => new Response("no", { status: 401, headers: { "content-type": "text/html" } }), build: "1", assets: [], origin: ORIGIN });
  const r = await sw2.handleFetch(nav("/"));
  assert.equal(r.status, 401);
  assert.equal(await (await caches.open(SHELL_CACHE)).match("/"), undefined);
});

test("kabuk: yavaş ağda saklanan kopyaya düşer, ağ yanıtı gelince kopya güncellenir", async () => {
  const caches = memoryCaches();
  await (await caches.open(SHELL_CACHE)).put("/", html("old"));
  let release;
  const fetch = () => new Promise((r) => (release = () => r(html("new"))));
  const sw = createSwLogic({ caches, fetch, build: "1", assets: [], origin: ORIGIN, timeoutMs: 5 });
  const res = await sw.handleFetch(nav("/"));
  assert.equal(await res.text(), "old");
  release();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(await (await (await caches.open(SHELL_CACHE)).match("/")).text(), "new");
});

test("kurulum dosyaları önceden alır; etkinleştirme bu + bir önceki sürüm dışındakileri siler", async () => {
  const caches = memoryCaches();
  await caches.open("tk-assets-50");
  await caches.open("tk-assets-90");
  await caches.open("other-lib-cache");
  const fetched = [];
  const fetch = async (req) => {
    fetched.push(new URL(req.url).pathname);
    if (req.url.endsWith("broken.js")) throw new TypeError("x");
    return new Response("js", { status: 200 });
  };
  const sw = createSwLogic({ caches, fetch, build: "100", assets: ["/assets/a.js", "/assets/broken.js"], origin: ORIGIN });
  await sw.install();
  assert.deepEqual(fetched.sort(), ["/assets/a.js", "/assets/broken.js"]);
  await sw.activate();
  const names = (await caches.keys()).sort();
  assert.deepEqual(names, ["other-lib-cache", "tk-assets-100", "tk-assets-90"]);
  // Çevrimdışı: önceden alınan dosya önbellekten.
  const off = createSwLogic({ caches, fetch: async () => { throw new TypeError("offline"); }, build: "100", assets: [], origin: ORIGIN });
  assert.equal(await (await off.handleFetch(get("/assets/a.js"))).text(), "js");
  await assert.rejects(off.handleFetch(get("/assets/missing.js")));
});

test("derlenen sw.js: dist çıktısında sabitler ve çekirdek var (build sonrası)", { skip: !safeRead("dist/sw.js") }, () => {
  const src = safeRead("dist/sw.js");
  assert.match(src, /const SW_BUILD = "\d+";/);
  assert.match(src, /const SW_ASSETS = \[/);
  assert.match(src, /function createSwLogic/);
  assert.doesNotMatch(src, /^export /m);
});

function safeRead(p) {
  try {
    return readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  } catch {
    return null;
  }
}
