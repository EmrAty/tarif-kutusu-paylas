// /api/fetch-caption regresyon testleri. Kasım 2026'da TikTok'un oEmbed yanıtı
// title/author_name alanlarını bıraktı; açıklama artık video sayfasındaki
// itemStruct.desc'ten okunuyor. Bu testler dış ağa çıkmaz: fetch taklit ediliyor,
// beklenmeyen her istek testi düşürür.
import test from "node:test";
import assert from "node:assert/strict";

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

let calls = [];
let routes = {};

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  calls.push({ url, init });
  for (const [prefix, respond] of Object.entries(routes)) {
    if (url.startsWith(prefix)) return respond(url, init);
  }
  throw new Error(`Testte beklenmeyen dış istek: ${url}`);
};

const html = (body, finalUrl) => {
  const res = new Response(body, { status: 200, headers: { "Content-Type": "text/html" } });
  if (finalUrl) Object.defineProperty(res, "url", { value: finalUrl });
  return res;
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const { default: handler } = await import("../api/fetch-caption.js");

async function get(url) {
  const out = { status: 200, body: undefined };
  const res = {
    status(code) {
      out.status = code;
      return this;
    },
    json(payload) {
      out.body = payload;
      return this;
    },
  };
  await handler({ method: "GET", query: { url } }, res);
  return out;
}

function reset(newRoutes) {
  calls = [];
  routes = newRoutes;
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
  assert.ok(!calls.some((c) => c.url.includes("/oembed")), "oEmbed çağrılmamalı");
  const page = calls.find((c) => c.url === FULL_URL);
  assert.match(page.init.headers["User-Agent"], IPHONE_UA_RE);
});

test("vt.tiktok.com kısa link: redirect takip edilir, açıklama son sayfadan okunur", async () => {
  reset({
    // Gerçek fetch redirect'i kendisi izler; taklitte kısa link doğrudan son sayfayı döndürür.
    "https://vt.tiktok.com/": () => html(tiktokPage(), FULL_URL + "?_r=1&utm_source=short_fallback"),
  });
  const r = await get(SHORT_URL);
  assert.equal(r.status, 200);
  assert.equal(r.body.caption, CAPTION);
  assert.equal(r.body.authorName, "lezzetormanda");
  assert.ok(r.body.resolvedUrl.startsWith(FULL_URL));
  const short = calls.find((c) => c.url === SHORT_URL);
  assert.equal(short.init.redirect, "follow");
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
