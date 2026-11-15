// 14 Kasım 2026 telefon testi: @rainyycook/7575869460007947538 (açıklamada
// malzemeler + yapılış eksiksiz) hem production'da hem Preview'da tarif
// oluşturmadı. Kanıt (geçici anonim hesapla canlı deneme): açıklama sunucuya
// tam ulaşıyor (2001 karakter), job Claude'a gidiyor; Anthropic 400
// "Your credit balance is too low…" döndürüyor. Kullanıcıya ise "Paylaştığın
// videodan tarif çıkarılamadı" bildirimi gidiyordu — sorun videodaymış gibi.
// Bu test: aynı açıklama + aynı sağlayıcı yanıtı → servis tarafı hata olarak
// sınıflanır (job.errorCode, bildirim metni, /api/extract 503 ai_unavailable).
// Ağsız: bellek içi Redis, sahte JWKS/TikTok/Anthropic/FCM.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createMemoryRedis } from "./helpers/memoryRedis.mjs";
import { waitFor } from "./helpers/async.mjs";

const KV = "https://kv.test";
process.env.KV_REST_API_URL = KV;
process.env.KV_REST_API_TOKEN = "test-token";
process.env.ANTHROPIC_API_KEY = "test-key";
delete process.env.OPENAI_API_KEY;
process.env.RECIPE_JOB_NOTIFY_MIN_DELAY_MS = "0";

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-kid", alg: "RS256", use: "sig" };
process.env.FIREBASE_SERVICE_ACCOUNT_KEY = JSON.stringify({
  client_email: "test@tarif-kutusu.test",
  project_id: "tarif-kutusu",
  private_key: privateKey.export({ format: "pem", type: "pkcs8" }),
});

// Videonun gerçek açıklaması (TikTok sayfasındaki itemStruct.desc, 14 Kasım 2026).
const REAL_CAPTION = "🍪✨ CHOCOLATE CHİP COOKİE TARİFİ ✨🍪 ──────────────────────────── • 125 gr Margarin/Tereyağ • 1 Çay Bardağı Esmer Şeker • 2 Yemek Kaşığı Beyaz Şeker • 1 Yumurta • 2 Çay Bardağı Un • 1 Tatlı Kaşığı Nişasta • Yarım Çay Kaşığı Tuz • 1 Paket Vanilya • Yarım Çay Kaşığı Kabartma Tozu ──────────────────────────── 🍪 Yapılışı 🍪 ──────────────────────────── • Yağ tavada (yanmadan) rengi koyulaşıncaya kadar kızdırılır. • Farklı bir kaba şekerler alınır, üzerine parmağımız yanmayacak kadar soğuyan yağ dökülür ve şekerler güzelce eriyene kadar çırpılır. • Üzerine yumurta kırıldıktan sonra tekrar çırpılır. • Un, nişasta, tuz, vanilya, kabartma tozu eklenir ve videodaki kıvama gelene kadar karıştırılır. • Çok küçük olmayacak şekilde doğranan çikolatalar eklenir. 🍫 • Hamur kaşıkla, aralarında boşluk olacak şekilde yağlı kağıt serilen tepsiye dizilir. • Önceden ısıtılmış fırında 180 derecede yaklaşık 10 dakika pişirilir. • Ve soğuk sütle servis edilir. 🥛✨ ──────────────────────────── 🍪 PÜF NOKTALAR 🍪 ──────────────────────────── • Evde esmer şekeriniz yoksa bir su bardağı beyaz şekere 1 yemek kaşığı pekmez ekleyerek elde edebilirsiniz. Rengi çok önemli değil; önemli olan kurabiye hamuruna verdiği sakızımsı kıvam. Çok pekmez koyarsanız tadı kaçabilir. • Mısır nişastası kurabiyeyi daha pofuduk yapar. Yoksa buğday nişastası da olur. Ben bu tarifi buğday nişastasıyla yaptım ve çok güzel oldu. • Kabartma tozu çay kaşığının ucu kadar olmalı, fazla konmamalı. • Un ölçüsü herkese uymayabilir, videodaki kıvama gelmesi önemli. Ne çok katı ne çok sıvı olmalı. Hamur kek gibi fazla çırpılmamalı. • Fırında pişme süresi değişiklik gösterebilir. Kontrollü pişirmelisiniz. Sıcakken hafif çiğ gibi görünse bile soğuduğunda normal kıvamına gelecektir. Çok pişerse videodakinden daha sert olur. ──────────────────────────── 🍪✨ Tarifi deneyecek herkese şimdiden afiyet olsun, umarım kurabiyeleriniz mis gibi olur! ✨🍪 ────────────────────────────   #cookies #chocolate #recipe #fyppppppppppppppppppppppp ";
const VIDEO_URL = "https://www.tiktok.com/@rainyycook/video/7575869460007947538";
// Anthropic'in canlıda döndürdüğü hata gövdesi.
const CREDIT_ERROR = {
  type: "error",
  error: {
    type: "invalid_request_error",
    message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
  },
};

const db = new Map();
const memoryRedis = createMemoryRedis(db);
function runRedis([op, ...args]) {
  switch (op.toUpperCase()) {
    case "SET": {
      const [key, value, ...opts] = args;
      if (opts.includes("NX") && db.has(key)) return null;
      db.set(key, value);
      return "OK";
    }
    case "DEL":
      return args.reduce((n, key) => n + (db.delete(key) ? 1 : 0), 0);
    default:
      return memoryRedis.run([op, ...args]);
  }
}

let claudeBodies = [];
let claudeResponse = () => ({ status: 400, body: CREDIT_ERROR });
let fcmMessages = [];
let tiktokPageHits = 0;

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  if (url.startsWith(`${KV}/get/`)) {
    const key = decodeURIComponent(url.slice(`${KV}/get/`.length));
    return json(200, { result: db.has(key) ? db.get(key) : null });
  }
  if (url === `${KV}/pipeline`) return json(200, memoryRedis.pipeline(JSON.parse(init.body)));
  if (url === KV) return json(200, { result: runRedis(JSON.parse(init.body)) });
  if (url.includes("securetoken@system.gserviceaccount.com")) return json(200, { keys: [jwk] });
  if (url.startsWith(VIDEO_URL)) {
    tiktokPageHits++;
    return new Response("<html></html>", { status: 200 });
  }
  if (url === "https://oauth2.googleapis.com/token") return json(200, { access_token: "test-fcm-access-token", expires_in: 3600 });
  if (url === "https://fcm.googleapis.com/v1/projects/tarif-kutusu/messages:send") {
    fcmMessages.push(JSON.parse(init.body).message);
    return json(200, { name: "test-fcm-message" });
  }
  if (url === "https://api.anthropic.com/v1/messages") {
    claudeBodies.push(JSON.parse(init.body));
    const { status, body } = claudeResponse();
    return json(status, body);
  }
  throw new Error(`Testte beklenmeyen dış istek: ${url}`);
};

function idToken(uid) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const header = enc({ alg: "RS256", kid: "test-kid", typ: "JWT" });
  const payload = enc({
    iss: "https://securetoken.google.com/tarif-kutusu",
    aud: "tarif-kutusu",
    sub: uid,
    iat: now,
    exp: now + 3600,
    email: `${uid.toLowerCase()}@example.test`,
    firebase: { sign_in_provider: "password" },
  });
  const sig = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
  return `${header}.${payload}.${sig}`;
}

async function invoke(handler, body) {
  const req = { method: "POST", headers: { authorization: `Bearer ${idToken("A")}` }, body, query: {} };
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
    setHeader() {},
  };
  await handler(req, res);
  return out;
}

const read = (key) => (db.has(key) ? JSON.parse(db.get(key)) : undefined);
const quiet = (fn) => async () => {
  const { log, error } = console;
  const logged = [];
  console.log = (...a) => logged.push(a.join(" "));
  console.error = (...a) => logged.push(a.join(" "));
  try {
    await fn(logged);
  } finally {
    Object.assign(console, { log, error });
  }
};
let n = 0;

function seed() {
  db.clear();
  claudeBodies = [];
  fcmMessages = [];
  tiktokPageHits = 0;
  claudeResponse = () => ({ status: 400, body: CREDIT_ERROR });
  db.set("user:A:profile", JSON.stringify({ isPlus: false, families: [] }));
  db.set("user:A:recipes", JSON.stringify([]));
  db.set("user:A:pushTargets", { type: "hash", map: new Map([["test-device", JSON.stringify({ platform: "android", installationId: "install-test-device", updatedAt: 1 })]]) });
}

const { default: jobsHandler } = await import("../api/recipe-jobs.js");
const { default: extractHandler } = await import("../api/extract.js");
const { isProviderUnavailable, isServiceSideError, ExtractError } = await import("../api/_lib/extractRecipe.js");

async function runJob() {
  const r = await invoke(jobsHandler, {
    requestId: `req-${++n}-provider`,
    sourceUrl: VIDEO_URL,
    caption: REAL_CAPTION.trim(),
    category: "Tatlılar",
    addedBy: "Test",
    language: "tr",
    target: "personal",
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return waitFor(() => {
    const job = read(`job:A:${r.body.jobId}`);
    return (job?.status === "failed" || job?.status === "completed") && job.notify && job;
  }, { message: "job bitmeli" });
}

test(
  "eksiksiz açıklama + Anthropic kredi hatası: job servis hatası olarak biter, bildirim videoyu suçlamaz",
  quiet(async (logged) => {
    seed();
    const job = await runJob();
    assert.equal(job.status, "failed");
    assert.equal(job.errorCode, "ai_unavailable", JSON.stringify(job));
    assert.match(job.error, /credit balance/);
    // Açıklama yeterli sayıldı: TikTok sayfasına/altyazıya düşülmedi, Claude'a açıklamanın TAMAMI gitti.
    assert.equal(job.transcriptMeta, null);
    assert.equal(tiktokPageHits, 0);
    assert.equal(claudeBodies.length, 1);
    const sent = claudeBodies[0].messages[0].content.map((c) => c.text || "").join("");
    assert.ok(sent.includes(REAL_CAPTION.trim()), "Claude'a açıklamanın tamamı gitmeli");
    assert.match(sent, /125 gr Margarin/);
    assert.match(sent, /180 derecede yaklaşık 10 dakika/);
    // Kullanıcıya giden bildirim: sorun videoda değil.
    assert.equal(fcmMessages.length, 1);
    const sentNotification = JSON.stringify(fcmMessages[0]);
    assert.match(sentNotification, /sorun videoda değil/);
    assert.doesNotMatch(sentNotification, /videodan tarif çıkarılamadı/);
    // Loglarda aranabilir alarm satırı; anahtar yazılmaz.
    assert.ok(logged.some((l) => l.includes('"tag":"ai-provider-unavailable"') && l.includes('"status":400')), logged.join("\n"));
    assert.ok(!logged.some((l) => l.includes("test-key")));
    // Tarif yazılmadı, aynı link yeniden denenebilir (URL kilidi bırakıldı).
    assert.deepEqual(read("user:A:recipes"), []);
    assert.equal([...db.keys()].filter((k) => k.startsWith("job-url:A:")).length, 0);
  })
);

test(
  "içerik kaynaklı hata (ayrıştırılamayan yanıt) eskisi gibi genel bildirimle biter, errorCode yok",
  quiet(async () => {
    seed();
    claudeResponse = () => ({ status: 200, body: { stop_reason: "end_turn", content: [{ type: "text", text: "tarif değil" }] } });
    const job = await runJob();
    assert.equal(job.status, "failed");
    assert.equal(job.errorCode, undefined);
    assert.match(JSON.stringify(fcmMessages[0]), /videodan tarif çıkarılamadı/);
  })
);

test(
  "/api/extract: kredi hatası 503 ai_unavailable döner (\"açıklamayı kontrol et\" değil)",
  quiet(async () => {
    seed();
    const r = await invoke(extractHandler, { link: VIDEO_URL, caption: REAL_CAPTION, language: "tr" });
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.code, "ai_unavailable");
    assert.equal(claudeBodies.length, 1);
  })
);

test("sağlayıcı hata sınıflaması", () => {
  assert.equal(isProviderUnavailable(400, CREDIT_ERROR.error.message), true);
  assert.equal(isProviderUnavailable(401, "invalid x-api-key"), true);
  assert.equal(isProviderUnavailable(403, "permission"), true);
  assert.equal(isProviderUnavailable(400, "messages: field required"), false);
  assert.equal(isProviderUnavailable(500, "internal"), false);
  const busy = new ExtractError("x", "provider");
  busy.providerStatus = 529;
  assert.equal(isServiceSideError(busy), true);
  assert.equal(isServiceSideError(new ExtractError("x", "parse")), false);
  assert.equal(isServiceSideError(new Error("x")), false);
});
