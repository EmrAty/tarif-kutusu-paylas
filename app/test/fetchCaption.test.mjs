// /api/fetch-caption regresyon testleri. Kasım 2026'da TikTok'un oEmbed yanıtı
// title/author_name alanlarını bıraktı; açıklama artık video sayfasındaki
// itemStruct.desc'ten okunuyor. Bu testler dış ağa çıkmaz: fetch taklit ediliyor,
// beklenmeyen her istek testi düşürür.
//
// Kasım 2026 (Grup 2): uç artık giriş istiyor ve redirect'leri kendisi doğrulayarak
// izliyor (redirect: "manual"); testler sahte Firebase token'ı ve bellek içi Redis
// (hız sınırı) ile çalışıyor. SSRF senaryoları: test/socialUrl.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { setRoutes, calls as allCalls, invoke, resetDb } from "./helpers/fakeServices.mjs";

const IPHONE_UA_RE = /iPhone/;
const FULL_URL = "https://www.tiktok.com/@lezzetormanda/video/7247533449148402949";
const SHORT_URL = "https://vt.tiktok.com/ZSAbc123/";
const CAPTION = "Teneke de tavuğun pratik hali 😋 1 kg tavuk, 2 yemek kaşığı salça #tarif";

function tiktokPage({ desc = CAPTION, author = { uniqueId: "lezzetormanda", nickname: "Lezzet Ormanda" } } = {}) {
  const data = {
    __DEFAULT_SCOPE__: {
      "webapp.video-detail": { itemInfo: { itemStruct: { desc, author, video: { duration: 59, subtitleInfos: [] } } } },
    },
  };
  return `<!doctype html><html><head><title>TikTok</title></head><body>
<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(data)}</script>
</body></html>`;
}

// TikTok'un bugünkü oEmbed yanıtı: title/author_name yok.
const OEMBED_WITHOUT_TITLE = {
  version: "1.0",
  type: "video",
  html: "<iframe></iframe>",
  provider_name: "TikTok",
  embed_product_id: "7247533449148402949",
};

const calls = allCalls;

const html = (body, finalUrl) => {
  const res = new Response(body, { status: 200, headers: { "Content-Type": "text/html" } });
  if (finalUrl) Object.defineProperty(res, "url", { value: finalUrl });
  return res;
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const { default: handler } = await import("../api/fetch-caption.js");

async function get(url, opts = {}) {
  return invoke(handler, { method: "GET", query: { url }, ...opts });
}

function reset(newRoutes) {
  resetDb();
  setRoutes(Object.entries(newRoutes));
}

test("TikTok tam link: açıklama sayfadan gelir, oEmbed hiç çağrılmaz", async () => {
  reset({
    "https://www.tiktok.com/@": () => html(tiktokPage(), FULL_URL),
    "https://www.tiktok.com/oembed": () => json(200, OEMBED_WITHOUT_TITLE),
  });
  const r = await get(FULL_URL);
  assert.equal(r.status, 200);
  assert.equal(r.body.caption, CAPTION);
  assert.equal(r.body.authorName, "lezzetormanda");
  assert.equal(r.body.resolvedUrl, FULL_URL);
  assert.equal(calls.find((c) => c.url === FULL_URL).init.redirect, "manual");
  assert.ok(!calls.some((c) => c.url.includes("/oembed")), "oEmbed çağrılmamalı");
  const page = calls.find((c) => c.url === FULL_URL);
  assert.match(page.init.headers["User-Agent"], IPHONE_UA_RE);
});

test("vt.tiktok.com kısa link: redirect doğrulanarak elle izlenir, açıklama son sayfadan okunur", async () => {
  const target = FULL_URL + "?_r=1&utm_source=short_fallback";
  reset({
    // Kısa link gerçek TikTok gibi 301 + Location döndürür; sunucu Location'ı
    // doğrulayıp kendisi devam eder.
    "https://vt.tiktok.com/": () => new Response(null, { status: 301, headers: { Location: target } }),
    "https://www.tiktok.com/@": () => html(tiktokPage()),
  });
  const r = await get(SHORT_URL);
  assert.equal(r.status, 200);
  assert.equal(r.body.caption, CAPTION);
  assert.equal(r.body.authorName, "lezzetormanda");
  assert.equal(r.body.resolvedUrl, target);
  const short = calls.find((c) => c.url === SHORT_URL);
  assert.equal(short.init.redirect, "manual");
  assert.ok(calls.some((c) => c.url === target));
});

test("regresyon: sayfa alınamaz ve oEmbed title taşımazsa 200+boş caption DEĞİL, hata döner", async () => {
  reset({
    "https://www.tiktok.com/@": () => new Response("Please wait...", { status: 200 }),
    "https://www.tiktok.com/oembed": () => json(200, OEMBED_WITHOUT_TITLE),
  });
  const r = await get(FULL_URL);
  assert.equal(r.status, 502);
  assert.equal(r.body.error, "Video bilgisi alınamadı.");
  assert.equal(r.body.caption, undefined);
});

test("TikTok 200 yanıtında video verisi yoksa sayfa bir kez daha denenir", async () => {
  reset({
    "https://www.tiktok.com/@": (_url, init) =>
      init.headers.Accept === "text/html"
        ? html('<script id="api-data" type="application/json">{"videoDetail":{"statusCode":10204}}</script>')
        : html(tiktokPage(), FULL_URL),
  });
  const r = await get(FULL_URL);
  assert.equal(r.status, 200);
  assert.equal(r.body.caption, CAPTION);
  assert.deepEqual(calls.map(({ init }) => init.headers.Accept), ["text/html", "*/*"]);
});

test("sayfa alınamazsa eski oEmbed yanıtı (title'lı) hâlâ yedek olarak çalışır", async () => {
  reset({
    "https://www.tiktok.com/@": () => new Response("", { status: 403 }),
    "https://www.tiktok.com/oembed": () => json(200, { title: "oEmbed açıklaması", author_name: "biri" }),
  });
  const r = await get(FULL_URL);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { caption: "oEmbed açıklaması", authorName: "biri" });
});

test("sayfa isteği hata fırlatsa bile handler çökmez, oEmbed denenir", async () => {
  reset({
    "https://www.tiktok.com/@": () => {
      throw new TypeError("fetch failed");
    },
    "https://www.tiktok.com/oembed": () => json(400, { message: "Something went wrong", code: 400 }),
  });
  const r = await get(FULL_URL);
  assert.equal(r.status, 502);
});

test("sayfadaki açıklama boşsa oEmbed'e düşülür", async () => {
  reset({
    "https://www.tiktok.com/@": () => html(tiktokPage({ desc: "" }), FULL_URL),
    "https://www.tiktok.com/oembed": () => json(200, OEMBED_WITHOUT_TITLE),
  });
  const r = await get(FULL_URL);
  assert.equal(r.status, 502);
  assert.ok(calls.some((c) => c.url.includes("/oembed")));
});

test("YouTube akışı değişmedi: oEmbed title döner, TikTok sayfası hiç istenmez", async () => {
  reset({
    "https://www.youtube.com/oembed": () => json(200, { title: "Kek tarifi", author_name: "Kanal" }),
  });
  const r = await get("https://youtu.be/dQw4w9WgXcQ");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { caption: "Kek tarifi", authorName: "Kanal" });
  assert.equal(calls.length, 1);
});

test("Instagram akışı değişmedi: og:description okunur", async () => {
  reset({
    "https://www.instagram.com/": () =>
      html(
        `<html><head><meta property="og:description" content="12 likes, 3 comments - sef on January 1, 2026: &quot;Mercimek çorbası: 1 su bardağı mercimek&quot;." /></head></html>`
      ),
  });
  const r = await get("https://www.instagram.com/p/ABC123/");
  assert.equal(r.status, 200);
  assert.equal(r.body.caption, "Mercimek çorbası: 1 su bardağı mercimek");
  assert.equal(r.body.authorName, "sef");
});

test("desteklenmeyen link 400, GET dışı 405, url yoksa 400", async () => {
  reset({});
  assert.equal((await get("https://example.com/video")).status, 400);
  assert.equal((await get("")).status, 400);
  const out = {};
  await handler({ method: "POST", query: {} }, { status: (c) => ((out.status = c), { json() {} }) });
  assert.equal(out.status, 405);
  assert.equal(calls.length, 0);
});

test("giriş yoksa 401 ve dışarıya hiç istek gitmez; misafir (anonim) hesap kabul edilir", async () => {
  reset({ "https://www.tiktok.com/@": () => html(tiktokPage(), FULL_URL) });
  const noAuth = await get(FULL_URL, { token: null });
  assert.equal(noAuth.status, 401);
  assert.equal(calls.length, 0);
  const guest = await get(FULL_URL, { anonymous: true, uid: "GUEST1" });
  assert.equal(guest.status, 200);
  assert.equal(guest.body.caption, CAPTION);
});

test("http:// ile yapıştırılan desteklenen link https'e yükseltilir (sunucu http'ye gitmez)", async () => {
  reset({ "https://www.tiktok.com/@": () => html(tiktokPage()) });
  const r = await get("http://www.tiktok.com/@lezzetormanda/video/7247533449148402949");
  assert.equal(r.status, 200);
  assert.ok(calls.every((c) => c.url.startsWith("https://")));
});
