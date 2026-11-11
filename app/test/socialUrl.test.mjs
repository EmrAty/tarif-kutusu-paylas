// Problem 7 — sosyal medya URL'si / SSRF regresyon testleri.
// Eskiden "/instagram\.com/i.test(link)" yetiyordu ve fetch redirect'leri kendisi
// izliyordu: "http://10.0.0.5:8080/...?x=instagram.com" sunucudan çekilebiliyordu.
// Dış ağa ve gerçek DNS'e çıkılmaz.
import test from "node:test";
import assert from "node:assert/strict";
import { setRoutes, calls, invoke, resetDb, json } from "./helpers/fakeServices.mjs";

const { parseSocialUrl, isTikTokUrl, isPrivateAddress, safeFetch, readTextLimited, __setDnsLookupForTests } = await import(
  "../api/_lib/socialUrl.js"
);
const { isTikTokLink } = await import("../api/_lib/tiktok.js");
const { default: fetchCaption } = await import("../api/fetch-caption.js");
const { default: recipeJobs } = await import("../api/recipe-jobs.js");

const REJECTED = [
  "http://10.0.0.5/?x=instagram.com",
  "http://10.0.0.5:8080/a?x=instagram.com",
  "https://instagram.com.evil.com/p/abc",
  "https://www.tiktok.com.evil.com/@a/video/1",
  "https://evil.com/?instagram.com",
  "https://evil.com/instagram.com/p/abc",
  "https://instagram.com@evil.com/p/abc",
  "https://user:pass@www.instagram.com/p/abc",
  "https://eviltiktok.com/@a/video/1",
  "https://notyoutube.com/watch?v=1",
  "https://localhost/instagram.com",
  "https://127.0.0.1/",
  "https://[::1]/",
  "https://2130706433/",
  "https://0x7f000001/",
  "https://169.254.169.254/latest/meta-data/",
  "https://www.tiktok.com:8080/@a/video/1",
  "ftp://www.tiktok.com/x",
  "javascript:alert(1)//tiktok.com",
  "file:///etc/passwd?tiktok.com",
  "tiktok.com/@a/video/1",
  "",
];

const ACCEPTED = [
  ["https://www.tiktok.com/@sef/video/7247533449148402949", "tiktok"],
  ["https://tiktok.com/@sef/video/7247533449148402949", "tiktok"],
  ["https://m.tiktok.com/v/7247533449148402949.html", "tiktok"],
  ["https://vt.tiktok.com/ZSAbc123/", "tiktok"],
  ["https://vm.tiktok.com/ZMabc123/", "tiktok"],
  ["https://WWW.TIKTOK.COM/@sef/video/1", "tiktok"],
  ["https://www.tiktok.com./@sef/video/1", "tiktok"],
  ["https://www.instagram.com/reel/ABC123/?igsh=xyz", "instagram"],
  ["https://instagram.com/p/ABC123/", "instagram"],
  ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "youtube"],
  ["https://youtube.com/shorts/dQw4w9WgXcQ?si=abc", "youtube"],
  ["https://m.youtube.com/watch?v=dQw4w9WgXcQ", "youtube"],
  ["https://youtu.be/dQw4w9WgXcQ?si=abc", "youtube"],
  ["http://youtu.be/dQw4w9WgXcQ", "youtube"],
];

test("parseSocialUrl: kelime aramayla geçen kötü/özel adresler reddedilir", () => {
  for (const url of REJECTED) assert.equal(parseSocialUrl(url), null, url);
});

test("parseSocialUrl: gerçek TikTok/Instagram/YouTube ve kısa linkler kabul edilir, https'e normalize edilir", () => {
  for (const [url, platform] of ACCEPTED) {
    const parsed = parseSocialUrl(url);
    assert.ok(parsed, url);
    assert.equal(parsed.platform, platform, url);
    assert.ok(parsed.url.startsWith("https://"), url);
  }
});

test("isTikTokLink artık tiktok.com.evil.com'u TikTok saymıyor", () => {
  assert.equal(isTikTokLink("https://tiktok.com.evil.com/x"), false);
  assert.equal(isTikTokLink("https://evil.com/?tiktok.com"), false);
  assert.equal(isTikTokLink("https://vt.tiktok.com/ZSAbc/"), true);
  assert.equal(isTikTokUrl("https://www.tiktok.com/@a/video/1"), true);
});

test("isPrivateAddress: loopback/özel/link-local/CGNAT/ULA/IPv4-mapped yakalanır, genel adres geçer", () => {
  for (const ip of ["127.0.0.1", "10.0.0.5", "172.16.3.4", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.5"]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ["142.250.185.78", "157.240.1.35", "2a03:2880:f12f:83:face:b00c:0:25de"]) assert.equal(isPrivateAddress(ip), false, ip);
});

test("fetch-caption: Fable'ın bulduğu adresler ve hileli linkler 400, sunucu dışarıya hiç istek atmaz", async () => {
  for (const url of REJECTED.filter(Boolean)) {
    resetDb();
    setRoutes([]);
    const r = await invoke(fetchCaption, { method: "GET", query: { url } });
    assert.equal(r.status, 400, url);
    assert.equal(calls.length, 0, url);
  }
});

test("fetch-caption: güvenli kısa linkin özel IP'ye redirect'i izlenmez", async () => {
  resetDb();
  setRoutes([
    ["https://vt.tiktok.com/", () => new Response(null, { status: 302, headers: { Location: "http://10.0.0.5:8080/admin?x=tiktok.com" } })],
    ["https://www.tiktok.com/oembed", () => json(200, {})],
  ]);
  const r = await invoke(fetchCaption, { method: "GET", query: { url: "https://vt.tiktok.com/ZSAbc123/" } });
  assert.equal(r.status, 502);
  assert.ok(!calls.some((c) => c.url.includes("10.0.0.5")), "özel IP'ye istek gitmemeli");
});

test("fetch-caption: Instagram linkinin başka host'a (evil.com) redirect'i izlenmez", async () => {
  resetDb();
  setRoutes([["https://www.instagram.com/", () => new Response(null, { status: 301, headers: { Location: "https://instagram.com.evil.com/steal" } })]]);
  const r = await invoke(fetchCaption, { method: "GET", query: { url: "https://www.instagram.com/p/ABC/" } });
  assert.equal(r.status, 502);
  assert.ok(!calls.some((c) => c.url.includes("evil.com")));
});

test("fetch-caption: göreli Location doğru host'a çözülür; sonsuz redirect döngüsü sınırla kesilir", async () => {
  resetDb();
  let hops = 0;
  setRoutes([
    ["https://www.youtube.com/oembed", () => (hops++, new Response(null, { status: 307, headers: { Location: "/oembed?again=1" } }))],
  ]);
  const r = await invoke(fetchCaption, { method: "GET", query: { url: "https://youtu.be/dQw4w9WgXcQ" } });
  assert.equal(r.status, 502);
  assert.equal(hops, 6, "ilk istek + en fazla 5 redirect");
});

test("fetch-caption: çok büyük yanıt gövdesi okunmaz (bellek koruması)", async () => {
  resetDb();
  setRoutes([
    [
      "https://www.instagram.com/",
      () => new Response("x", { status: 200, headers: { "Content-Type": "text/html", "Content-Length": String(50 * 1024 * 1024) } }),
    ],
  ]);
  const r = await invoke(fetchCaption, { method: "GET", query: { url: "https://www.instagram.com/p/ABC/" } });
  assert.equal(r.status, 502);
});

test("readTextLimited: Content-Length yoksa da akarken sınır uygulanır", async () => {
  const big = new Response(new ReadableStream({
    start(controller) {
      for (let i = 0; i < 20; i++) controller.enqueue(new Uint8Array(1024));
      controller.close();
    },
  }));
  await assert.rejects(readTextLimited(big, 4096), /çok büyük/);
});

test("recipe-jobs: aynı doğrulama — hileli/özel adresli link job açmadan 400", async () => {
  for (const url of ["http://10.0.0.5/?x=instagram.com", "https://instagram.com.evil.com/p/a", "https://instagram.com@evil.com/p/a", "https://evil.com/?tiktok.com"]) {
    resetDb();
    setRoutes([]);
    const r = await invoke(recipeJobs, {
      body: { requestId: "req-123456", sourceUrl: url, caption: "1 kg tavuk, 2 yemek kaşığı salça", category: "Kahvaltı" },
    });
    assert.equal(r.status, 400, url);
    assert.equal(calls.length, 0, url);
  }
});

test("public politika (TikTok CDN): DNS'i özel adrese çözülen host'a istek atılmaz; IP literal ve http reddedilir", async () => {
  setRoutes([["https://cdn.example-tiktokcdn.com/", () => new Response("WEBVTT", { status: 200 })]]);
  __setDnsLookupForTests(async () => [{ address: "10.1.2.3", family: 4 }]);
  await assert.rejects(safeFetch("https://cdn.example-tiktokcdn.com/sub.vtt", { policy: "public" }), /İç ağ/);
  await assert.rejects(safeFetch("https://10.1.2.3/sub.vtt", { policy: "public" }), /Güvensiz/);
  await assert.rejects(safeFetch("http://cdn.example-tiktokcdn.com/sub.vtt", { policy: "public" }), /Güvensiz/);
  assert.equal(calls.length, 0);

  __setDnsLookupForTests(async () => [{ address: "142.250.185.78", family: 4 }]);
  const text = await safeFetch("https://cdn.example-tiktokcdn.com/sub.vtt", { policy: "public" }, (res) => res.text());
  assert.equal(text, "WEBVTT");
});

test("public politika: genel CDN'den özel host'a redirect izlenmez", async () => {
  setRoutes([["https://cdn.example-tiktokcdn.com/", () => new Response(null, { status: 302, headers: { Location: "https://metadata.internal/latest" } })]]);
  __setDnsLookupForTests(async () => [{ address: "142.250.185.78", family: 4 }]);
  await assert.rejects(safeFetch("https://cdn.example-tiktokcdn.com/v.mp4", { policy: "public" }), /İç ağ/);
  assert.equal(calls.length, 1);
});
