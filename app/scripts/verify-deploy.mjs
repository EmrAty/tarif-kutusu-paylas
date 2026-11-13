#!/usr/bin/env node
// Grup 5: yayın sonrası (Preview ya da Production) SALT OKUNUR kontrol.
//
//   npm run verify:deploy -- --url https://tarifkutusu.app --commit <sha>
//   npm run verify:deploy -- --url https://preview.tarifkutusu.app --commit <sha> \
//        --bypass-file ../../tk-clone-group3-apk/app/android/local.properties
//
// Ne yapar: yalnızca GET/OPTIONS benzeri, kimliksiz istekler atar. Hiçbir veri
// yazmaz, AI/ücretli servis çağırmaz, giriş yapmaz.
//  1. /version.json → 200 ve (verildiyse) commit onaylanan commit ile aynı
//  2. Ana sayfa ve JS paketi açılıyor
//  3. Yasal sayfalar (/privacy, /terms, /delete-account) 200
//  4. API fonksiyonları ayakta: kimliksiz istek 401 (404/500 değil)
//  5. Güvenlik başlıkları (vercel.json) yerinde
// Bir kontrol bile düşerse çıkış kodu 1.
//
// Preview, Vercel Authentication ile korunuyor: anahtar --bypass-file (içinde
// PREVIEW_BYPASS=... satırı olan dosya) ya da VERCEL_PROTECTION_BYPASS ortam
// değişkeniyle verilir. Anahtar hiçbir çıktıya yazılmaz.
import fs from "node:fs";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const base = String(args.url || "").replace(/\/+$/, "");
if (!/^https:\/\/[^/]+$/.test(base)) {
  console.error("Kullanım: npm run verify:deploy -- --url https://tarifkutusu.app [--commit <sha>] [--bypass-file <dosya>]");
  process.exit(2);
}
const expectedCommit = typeof args.commit === "string" ? args.commit.toLowerCase() : null;
if (expectedCommit && !/^[0-9a-f]{7,40}$/.test(expectedCommit)) {
  console.error("--commit bir git SHA'sı olmalı (en az 7 karakter).");
  process.exit(2);
}

function readBypass() {
  if (process.env.VERCEL_PROTECTION_BYPASS) return process.env.VERCEL_PROTECTION_BYPASS.trim();
  if (typeof args["bypass-file"] === "string") {
    const text = fs.readFileSync(args["bypass-file"], "utf8");
    const line = text.split(/\r?\n/).find((l) => /^\s*PREVIEW_BYPASS\s*=/.test(l));
    if (!line) throw new Error("Dosyada PREVIEW_BYPASS satırı yok.");
    return line.split("=").slice(1).join("=").trim();
  }
  return null;
}
const bypass = readBypass();
const headers = { "user-agent": "tarif-kutusu-verify-deploy", ...(bypass ? { "x-vercel-protection-bypass": bypass } : {}) };
// Anahtar kazara bir hata mesajında görünürse diye maskeleme.
const mask = (s) => (bypass ? String(s).split(bypass).join("***") : String(s));

async function get(path, { method = "GET" } = {}) {
  const res = await fetch(base + path, { method, headers, redirect: "manual", signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  return { status: res.status, text, type: res.headers.get("content-type") || "", headers: res.headers };
}

const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ ok: true, name, detail });
  } catch (e) {
    results.push({ ok: false, name, detail: mask(e.message) });
  }
}
function expect(cond, message) {
  if (!cond) throw new Error(message);
}

let version = null;
await check("version.json", async () => {
  const r = await get(`/version.json?t=${Date.now()}`);
  if (r.status === 302 || r.status === 401) throw new Error(`${r.status}: koruma açık, bypass anahtarı gerekli/yanlış`);
  expect(r.status === 200, `HTTP ${r.status}`);
  version = JSON.parse(r.text);
  expect(version.version, "version alanı yok");
  return `version=${version.version} commit=${version.commit || "?"} ref=${version.ref || "?"} env=${version.env || "?"}`;
});

await check("onaylanan commit yayında", async () => {
  if (!expectedCommit) return "atlandı (--commit verilmedi)";
  expect(version?.commit, "version.json commit içermiyor (bu sürüm Grup 5 öncesi derlenmiş olabilir)");
  expect(version.commit.toLowerCase().startsWith(expectedCommit), `yayında ${version.commit.slice(0, 12)}, beklenen ${expectedCommit}`);
  return version.commit.slice(0, 12);
});

let bundlePath = null;
await check("ana sayfa", async () => {
  const r = await get("/");
  expect(r.status === 200, `HTTP ${r.status}`);
  expect(r.type.includes("text/html"), `içerik türü ${r.type}`);
  bundlePath = (r.text.match(/src="(\/assets\/[^"]+\.js)"/) || [])[1];
  expect(bundlePath, "JS paketi bağlantısı bulunamadı");
  return bundlePath;
});

// Grup 5: vercel.json güvenlik başlıkları (Grup 5 öncesi derlemelerde yok).
await check("güvenlik başlıkları", async () => {
  const r = await get("/");
  const h = (k) => r.headers.get(k) || "";
  expect(h("x-content-type-options") === "nosniff", "X-Content-Type-Options yok");
  expect(h("x-frame-options") === "DENY", "X-Frame-Options yok");
  expect(h("content-security-policy").includes("object-src 'none'"), "CSP yok");
  const api = await get("/api/profile");
  expect((api.headers.get("cache-control") || "").includes("no-store"), "API yanıtı no-store değil");
  return "nosniff, DENY, CSP (object/base/frame/form), API no-store";
});

await check("JS paketi", async () => {
  expect(bundlePath, "ana sayfa okunamadı");
  const r = await get(bundlePath);
  expect(r.status === 200, `HTTP ${r.status}`);
  expect(r.text.length > 100_000, `paket beklenenden küçük (${r.text.length} bayt)`);
  if (version?.version) expect(r.text.includes(version.version), "paket ile version.json farklı derlemelerden (önbellek?)");
  return `${Math.round(r.text.length / 1024)} KB`;
});

for (const page of ["/privacy", "/terms", "/delete-account"]) {
  await check(`yasal sayfa ${page}`, async () => {
    const r = await get(page);
    expect(r.status === 200, `HTTP ${r.status}`);
    return "200";
  });
}

// Kimliksiz istek: fonksiyon çalışıyor ve yetkiyi uyguluyor olmalı (401).
// 404 = fonksiyon yok/yanlış dal, 500 = ortam değişkeni/çalışma zamanı hatası.
for (const [method, path] of [
  ["GET", "/api/profile"],
  ["GET", "/api/data?bucket=recipes&scope=personal"],
  ["GET", "/api/families"],
  ["POST", "/api/extract"],
  ["POST", "/api/recipe-jobs"],
  ["DELETE", "/api/account"],
]) {
  await check(`API ${method} ${path.split("?")[0]} → 401`, async () => {
    const r = await get(path, { method });
    expect(r.status === 401, `HTTP ${r.status} ${r.text.slice(0, 120)}`);
    return "401";
  });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${base}`);
for (const r of results) console.log(`${r.ok ? "✔" : "✖"} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
console.log(failed.length ? `\n${failed.length} kontrol BAŞARISIZ.` : "\nTüm kontroller geçti.");
process.exit(failed.length ? 1 : 0);
