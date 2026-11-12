// /api/recipe-jobs yaşam döngüsü: her job "completed" ya da "failed" ile bitmeli,
// bildirim hatası sonucu değiştirmemeli, hata bildirimi paylaşım paneli
// kapanmadan gönderilmemeli (Android ön planda bildirimi göstermiyor).
// recipeJobsCaption.test.mjs ile aynı yöntem: bellek içi Redis, sahte Google
// JWKS/FCM ve sahte Anthropic. Dışarıya hiç istek gitmez.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createMemoryRedis } from "./helpers/memoryRedis.mjs";

const KV = "https://kv.test";
const NOTIFY_DELAY = 300;
process.env.KV_REST_API_URL = KV;
process.env.KV_REST_API_TOKEN = "test-token";
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.RECIPE_JOB_NOTIFY_MIN_DELAY_MS = String(NOTIFY_DELAY);
delete process.env.OPENAI_API_KEY;

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-kid", alg: "RS256", use: "sig" };
process.env.FIREBASE_SERVICE_ACCOUNT_KEY = JSON.stringify({
  client_email: "test@tarif-kutusu.test",
  project_id: "tarif-kutusu",
  private_key: privateKey.export({ format: "pem", type: "pkcs8" }),
});

// ---------- bellek içi Redis ----------
const db = new Map();
const memoryRedis = createMemoryRedis(db);
let failRedisWriteFor = null;
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
      // Sürümlü kovaların komutları (MGET, EVAL…) ortak bellek içi Redis'te.
      return memoryRedis.run([op, ...args]);
  }
}

// ---------- sahte dış servisler ----------
const URL_A = "https://www.tiktok.com/@sef/video/7247533449148402949";
const CAPTION =
  "Tenekede tavuk: 1 kg tavuk but, 2 yemek kaşığı salça, 1 su bardağı su, 3 diş sarımsak, 1 çay kaşığı tuz. Tavukları yağlayıp fırına verin, 45 dakika pişirin.";
const RECIPE = { title: "Tenekede Tavuk", ingredients: [{ name: "tavuk", amount: "1 kg" }], instructions: ["Pişir."] };

let claudeMode = "ok"; // ok | 401 | parse | network | slow
let claudeCalls = 0;
let fcmMode = "ok"; // ok | fail
let fcmMessages = [];

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  if (url.startsWith(`${KV}/get/`)) {
    const key = decodeURIComponent(url.slice(`${KV}/get/`.length));
    return json(200, { result: db.has(key) ? db.get(key) : null });
  }
  // AI koruması (Grup 2) sayaç/kira komutlarını Upstash /pipeline ile gönderir.
  if (url === `${KV}/pipeline`) return json(200, memoryRedis.pipeline(JSON.parse(init.body)));
  if (url === KV) {
    const command = JSON.parse(init.body);
    // Tarif listesi artık karşılaştır-ve-yaz (EVAL; ilk anahtar command[3]) ile yazılıyor.
    const writtenKey = command[0] === "EVAL" ? command[3] : command[1];
    if ((command[0] === "SET" || command[0] === "EVAL") && writtenKey === failRedisWriteFor) return json(500, { error: "down" });
    return json(200, { result: runRedis(command) });
  }
  if (url.includes("securetoken@system.gserviceaccount.com")) return json(200, { keys: [jwk] });
  if (url === "https://oauth2.googleapis.com/token") return json(200, { access_token: "fcm-token", expires_in: 3600 });
  if (url === "https://fcm.googleapis.com/v1/projects/tarif-kutusu/messages:send") {
    if (fcmMode === "fail") return json(500, { error: { status: "INTERNAL", message: "FCM down" } });
    fcmMessages.push({ ...JSON.parse(init.body).message, at: Date.now() });
    return json(200, { name: "msg" });
  }
  if (url === "https://api.anthropic.com/v1/messages") {
    claudeCalls++;
    if (claudeMode === "401") return json(401, { error: { message: "invalid x-api-key" } });
    if (claudeMode === "network") throw new TypeError("fetch failed");
    if (claudeMode === "parse") return json(200, { stop_reason: "end_turn", content: [{ type: "text", text: "{bozuk" }] });
    if (claudeMode === "slow") {
      // Sinyale uyan, hiç bitmeyen istek: zaman aşımı yolunu sınar.
      return new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    }
    return json(200, { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(RECIPE) }] });
  }
  throw new Error(`Testte beklenmeyen dış istek: ${url}`);
};

// ---------- yardımcılar ----------
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

async function call(method, { body, query = {} } = {}) {
  const req = { method, headers: { authorization: `Bearer ${idToken("A")}` }, body, query };
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
const post = (body) => call("POST", { body });

const read = (key) => (db.has(key) ? JSON.parse(db.get(key)) : undefined);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = (fn) => async () => {
  const { log, error } = console;
  console.log = () => {};
  console.error = () => {};
  try {
    await fn();
  } finally {
    Object.assign(console, { log, error });
  }
};
let n = 0;
const body = (extra) => ({
  requestId: `req-${++n}-abcdef`,
  sourceUrl: URL_A,
  caption: CAPTION,
  category: CATEGORIES[0],
  addedBy: "Test",
  language: "tr",
  target: "personal",
  ...extra,
});

function seed() {
  db.clear();
  claudeMode = "ok";
  claudeCalls = 0;
  fcmMode = "ok";
  fcmMessages = [];
  failRedisWriteFor = null;
  db.set("user:A:profile", JSON.stringify({ isPlus: false, families: [] }));
  db.set("user:A:recipes", JSON.stringify([]));
  // Grup 3: tarif bildirimi yalnızca "android" etiketli yeni kayda gider
  // (platformsuz eski fcmTokens listesine artık gitmez — bkz. group3Fcm.test.mjs).
  db.set("user:A:pushTargets", { type: "hash", map: new Map([["device-1", JSON.stringify({ platform: "android", installationId: "install-device-1", updatedAt: 1 })]]) });
}

// Job terminal duruma geçip bildirim sonucu kayda yazılana kadar bekler.
async function waitForSettledJob(jobId) {
  for (let i = 0; i < 500; i++) {
    const job = read(`job:A:${jobId}`);
    if ((job?.status === "failed" || job?.status === "completed") && job.notify) return job;
    await sleep(10);
  }
  throw new Error(`job bitmedi: ${JSON.stringify(read(`job:A:${jobId}`))}`);
}

const { default: handler } = await import("../api/recipe-jobs.js");
const { CATEGORIES } = await import("../shared/recipeExtraction.js");
const { extractRecipeFromCaption } = await import("../api/_lib/extractRecipe.js");

test(
  "1) Caption + Anthropic başarılı: completed, tarif kaydedildi, başarı bildirimi gitti",
  quiet(async () => {
    seed();
    const r = await post(body());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const job = await waitForSettledJob(r.body.jobId);
    assert.equal(job.status, "completed");
    const recipes = read("user:A:recipes");
    assert.equal(recipes.length, 1);
    assert.equal(recipes[0].id, job.recipeId);
    assert.equal(recipes[0].title, "Tenekede Tavuk");
    // Tarif atomik karşılaştır-ve-yaz ile yazıldı (sürümsüz eski liste örtük sürüm 1 -> 2);
    // pendingJobRecipes işaretçisine artık gerek yok.
    assert.equal(db.get("user:A:recipes:version"), "2", "tarif sürümlü yazımla kaydedildi (sürümsüz liste = 1)");
    assert.equal(db.has("user:A:pendingJobRecipes"), false);
    assert.equal(fcmMessages.length, 1);
    assert.equal(fcmMessages[0].data.type, "recipe_ready");
    assert.equal(job.notify.sent, 1);
  })
);

test(
  "2) Anthropic 401: failed, hata bildirimi panel kapanma süresinden sonra gönderilir ve kayda yazılır",
  quiet(async () => {
    seed();
    claudeMode = "401";
    const r = await post(body());
    assert.equal(r.status, 200);
    const started = Date.now();
    // 401 anında düşüyor; bildirim yine de hemen gitmemeli.
    await sleep(NOTIFY_DELAY / 3);
    assert.equal(read(`job:A:${r.body.jobId}`).status, "failed");
    assert.equal(fcmMessages.length, 0, "panel açıkken bildirim gönderilmemeli");
    const job = await waitForSettledJob(r.body.jobId);
    assert.match(job.error, /401/);
    assert.equal(fcmMessages.length, 1);
    assert.equal(fcmMessages[0].data.type, "recipe_failed");
    assert.ok(fcmMessages[0].at - started >= NOTIFY_DELAY - 50, "bildirim gecikmeli gitti");
    assert.deepEqual(job.notify, { sent: 1, attempted: 1, error: null });
    assert.deepEqual(read("user:A:recipes"), []);
  })
);

test(
  "3) Anthropic zaman aşımı: istek kesilir, açık bir hata mesajı fırlatılır",
  async () => {
    seed();
    claudeMode = "slow";
    await assert.rejects(
      extractRecipeFromCaption({ link: URL_A, caption: CAPTION, timeoutMs: 50 }),
      /sn içinde bitmedi/
    );
  }
);

test(
  "3b) Anthropic'e ulaşılamazsa job failed olur (takılı kalmaz)",
  quiet(async () => {
    seed();
    claudeMode = "network";
    const r = await post(body());
    const job = await waitForSettledJob(r.body.jobId);
    assert.equal(job.status, "failed");
    assert.match(job.error, /ulaşılamadı/);
    assert.equal(fcmMessages[0]?.data.type, "recipe_failed");
  })
);

test(
  "4) Yapılandırılmış çıktı ayrıştırılamazsa job failed olur",
  quiet(async () => {
    seed();
    claudeMode = "parse";
    const r = await post(body());
    const job = await waitForSettledJob(r.body.jobId);
    assert.equal(job.status, "failed");
    assert.match(job.error, /ayrıştırılamadı/);
    assert.equal(fcmMessages[0]?.data.type, "recipe_failed");
    assert.deepEqual(read("user:A:recipes"), []);
  })
);

test(
  "5) Redis'e tarif yazılamazsa job failed olur, completed yazılmaz",
  quiet(async () => {
    seed();
    failRedisWriteFor = "user:A:recipes";
    const r = await post(body());
    const job = await waitForSettledJob(r.body.jobId);
    assert.equal(job.status, "failed");
    assert.equal(job.recipeId, null);
    assert.equal(fcmMessages[0]?.data.type, "recipe_failed");
  })
);

test(
  "6) Başarı bildirimi gönderilemezse tarif kayıtlı ve job completed kalır",
  quiet(async () => {
    seed();
    fcmMode = "fail";
    const r = await post(body());
    const job = await waitForSettledJob(r.body.jobId);
    assert.equal(job.status, "completed");
    assert.equal(read("user:A:recipes")[0].id, job.recipeId);
    assert.equal(job.notify.sent, 0);
    assert.match(job.notify.error, /FCM down/);
  })
);

test(
  "7) Hata bildirimi gönderilemezse job yine failed kalır",
  quiet(async () => {
    seed();
    claudeMode = "401";
    fcmMode = "fail";
    const r = await post(body());
    const job = await waitForSettledJob(r.body.jobId);
    assert.equal(job.status, "failed");
    assert.equal(job.notify.sent, 0);
    assert.match(job.notify.error, /FCM down/);
  })
);

test(
  "8) processing'de takılı kalmış job okunurken failed görünür ve yeni paylaşımı engellemez",
  quiet(async () => {
    seed();
    const old = Date.now() - 7 * 60 * 1000;
    db.set(
      "job:A:stuck-1",
      JSON.stringify({ id: "stuck-1", status: "processing", sourceUrl: URL_A, createdAt: old, updatedAt: old })
    );
    const g = await call("GET", { query: { id: "stuck-1" } });
    assert.equal(g.status, 200);
    assert.equal(g.body.status, "failed");
    // Aynı video için URL kilidi takılı job'ı gösteriyor olsa bile yeni job açılır.
    const lockKey = `job-url:A:${crypto.createHash("sha1").update(URL_A).digest("hex")}`;
    db.set(lockKey, "stuck-1");
    const r = await post(body());
    assert.equal(r.status, 200);
    assert.equal(r.body.duplicate, false);
    const job = await waitForSettledJob(r.body.jobId);
    assert.equal(job.status, "completed");
  })
);

test(
  "9) Aynı paylaşım iki kez gelirse tek tarif oluşur",
  quiet(async () => {
    seed();
    const b = body();
    const [r1, r2] = await Promise.all([post(b), post(b)]);
    // Farklı requestId ile aynı video (share intent iki kez tetiklendi).
    const r3 = await post(body());
    assert.equal(r1.status, 200);
    const ids = new Set([r1.body.jobId, r2.body.jobId, r3.body.jobId]);
    assert.equal(ids.size, 1, `tek job bekleniyordu: ${[...ids]}`);
    await waitForSettledJob(r1.body.jobId);
    assert.equal(read("user:A:recipes").length, 1);
    assert.equal(claudeCalls, 1);
    assert.equal(fcmMessages.length, 1);
  })
);
