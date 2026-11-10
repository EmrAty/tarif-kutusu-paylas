// /api/recipe-jobs açıklama doğrulaması: TikTok linkinde açıklama boş gelebilir
// (sunucu altyazı/konuşma metnine düşer), Instagram/YouTube'da açıklama şart.
// accountDeletion.test.mjs ile aynı yöntem: bellek içi Redis, sahte Google JWKS,
// sahte TikTok sayfası/altyazısı ve sahte Anthropic. Dışarıya hiç istek gitmez.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

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

// ---------- bellek içi Redis ----------
const db = new Map();
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
      throw new Error(`Test Redis'i bu komutu desteklemiyor: ${op}`);
  }
}

// ---------- sahte dış servisler ----------
const FULL_URL = "https://www.tiktok.com/@sef/video/7247533449148402949";
const SHORT_URL = "https://vt.tiktok.com/ZSAbc123/";
const SUBTITLE_URL = "https://v16-webapp.tiktok.com/subtitle.vtt";
const TRANSCRIPT_LINE = "Önce iki yemek kaşığı tereyağını eritiyoruz, bir su bardağı un ekleyip kavuruyoruz.";
let claudeBodies = [];
let tiktokPageHits = 0;
let pageCaption = "";
let fcmMessages = [];

function tiktokPage() {
  const data = {
    __DEFAULT_SCOPE__: {
      "webapp.video-detail": {
        itemInfo: {
          itemStruct: {
            desc: pageCaption,
            author: { uniqueId: "sef" },
            video: {
              duration: 46,
              subtitleInfos: [{ LanguageCodeName: "tur-TR", Format: "webvtt", Source: "ASR", Url: SUBTITLE_URL }],
            },
          },
        },
      },
    },
  };
  return `<html><body><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(
    data
  )}</script></body></html>`;
}

function vtt() {
  const cues = [];
  for (let i = 0; i < 6; i++) cues.push(`${i + 1}\n00:00:0${i}.000 --> 00:00:0${i + 1}.000\n${TRANSCRIPT_LINE} (${i})`);
  return `WEBVTT\n\n${cues.join("\n\n")}\n`;
}

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  if (url.startsWith(`${KV}/get/`)) {
    const key = decodeURIComponent(url.slice(`${KV}/get/`.length));
    return json(200, { result: db.has(key) ? db.get(key) : null });
  }
  if (url === KV) return json(200, { result: runRedis(JSON.parse(init.body)) });
  if (url.includes("securetoken@system.gserviceaccount.com")) return json(200, { keys: [jwk] });
  if (url === FULL_URL || url === SHORT_URL) {
    tiktokPageHits++;
    const res = new Response(tiktokPage(), {
      status: 200,
      headers: { "Content-Type": "text/html", "Set-Cookie": "ttwid=abc; Path=/" },
    });
    Object.defineProperty(res, "url", { value: FULL_URL });
    return res;
  }
  if (url === SUBTITLE_URL) return new Response(vtt(), { status: 200 });
  if (url === "https://oauth2.googleapis.com/token") {
    return json(200, { access_token: "test-fcm-access-token", expires_in: 3600 });
  }
  if (url === "https://fcm.googleapis.com/v1/projects/tarif-kutusu/messages:send") {
    fcmMessages.push(JSON.parse(init.body).message);
    return json(200, { name: "test-fcm-message" });
  }
  if (url === "https://api.anthropic.com/v1/messages") {
    claudeBodies.push(JSON.parse(init.body));
    const recipe = { title: "Altyazıdan Tarif", ingredients: [], instructions: [] };
    return json(200, { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(recipe) }] });
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

async function post(body) {
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
  category: CATEGORIES[0],
  addedBy: "Test",
  language: "tr",
  target: "personal",
  ...extra,
});

function seed() {
  db.clear();
  claudeBodies = [];
  tiktokPageHits = 0;
  pageCaption = "";
  fcmMessages = [];
  db.set("user:A:profile", JSON.stringify({ isPlus: false, families: [] }));
  db.set("user:A:recipes", JSON.stringify([]));
}

async function waitForJob(jobId, { waitForNotification = false } = {}) {
  for (let i = 0; i < 300; i++) {
    const job = read(`job:A:${jobId}`);
    if (job?.status === "failed" || (job?.status === "completed" && (!waitForNotification || job.notify))) return job;
    await sleep(10);
  }
  throw new Error("job bitmedi");
}

const { default: handler } = await import("../api/recipe-jobs.js");
const { CATEGORIES } = await import("../shared/recipeExtraction.js");

test(
  "TikTok + boş açıklama kabul edilir; tarif altyazıdan çıkarılır",
  quiet(async () => {
    seed();
    const r = await post(body({ sourceUrl: FULL_URL, caption: "" }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.jobId);
    const job = await waitForJob(r.body.jobId);
    assert.equal(job.status, "completed", JSON.stringify(job));
    assert.equal(job.transcriptMeta.method, "subtitle");
    assert.equal(read("user:A:recipes")[0].title, "Altyazıdan Tarif");
    // Claude'a boş açıklama değil, altyazı metni gitti.
    const userText = JSON.stringify(claudeBodies[0].messages);
    assert.match(userText, /Videonun konuşma metni/);
    assert.match(userText, /tereyağını eritiyoruz/);
  })
);

test(
  "vt.tiktok.com kısa link + boş açıklama: redirect çözülür, aynı yol çalışır",
  quiet(async () => {
    seed();
    const r = await post(body({ sourceUrl: SHORT_URL, caption: "   " }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const job = await waitForJob(r.body.jobId);
    assert.equal(job.status, "completed", JSON.stringify(job));
    assert.equal(job.sourceUrl, SHORT_URL);
    assert.equal(tiktokPageHits, 1);
  })
);

test(
  "Panel açıklamayı boş gönderirse job TikTok sayfasındaki tarif metnini kullanır ve bildirim gönderir",
  quiet(async () => {
    seed();
    pageCaption = "Fit Tavuk Tantuni: 600 g tavuk göğsü, 2 yemek kaşığı zeytinyağı, 1 çay kaşığı tuz. Tavuğu küp doğrayın, suyunu çekene kadar pişirin ve lavaşa sarın.";
    db.set("user:A:fcmTokens", JSON.stringify(["test-device"]));
    const r = await post(body({ sourceUrl: SHORT_URL, caption: "" }));
    assert.equal(r.status, 200);
    assert.equal(r.body.notifyDevices, 1);
    const job = await waitForJob(r.body.jobId, { waitForNotification: true });
    assert.equal(job.status, "completed", JSON.stringify(job));
    assert.equal(job.transcriptMeta.method, "caption");
    assert.equal(tiktokPageHits, 1);
    assert.match(JSON.stringify(claudeBodies[0].messages), /Fit Tavuk Tantuni/);
    assert.equal(read("user:A:recipes")[0].id, job.recipeId);
    assert.equal(fcmMessages[0]?.token, "test-device");
    assert.deepEqual(fcmMessages[0]?.data, { type: "recipe_ready", recipeId: job.recipeId });
    assert.equal(job.notify.sent, 1);
  })
);

test(
  "TikTok + yeterli açıklama: eski hızlı yol, sayfa hiç istenmez",
  quiet(async () => {
    seed();
    const caption =
      "Tenekede tavuk: 1 kg tavuk but, 2 yemek kaşığı salça, 1 su bardağı su, 3 diş sarımsak, 1 çay kaşığı tuz. Tavukları yağlayıp fırına verin, 45 dakika pişirin.";
    const r = await post(body({ sourceUrl: FULL_URL, caption }));
    assert.equal(r.status, 200);
    const job = await waitForJob(r.body.jobId);
    assert.equal(job.status, "completed");
    assert.equal(job.transcriptMeta, null);
    assert.equal(tiktokPageHits, 0);
  })
);

test(
  "YouTube ve Instagram'da boş açıklama hâlâ 400",
  quiet(async () => {
    seed();
    for (const sourceUrl of ["https://youtu.be/dQw4w9WgXcQ", "https://www.instagram.com/p/ABC123/"]) {
      const r = await post(body({ sourceUrl, caption: "" }));
      assert.equal(r.status, 400, sourceUrl);
      assert.equal(r.body.error, "Açıklama boş olamaz.");
    }
    assert.equal(claudeBodies.length, 0);
    assert.equal([...db.keys()].filter((k) => k.startsWith("job:")).length, 0);
  })
);

test(
  "tiktok.com olmayan ama adında tiktok geçen alan adı boş açıklamayla geçmez",
  quiet(async () => {
    seed();
    const r = await post(body({ sourceUrl: "https://nottiktok.com/@x/video/1", caption: "" }));
    assert.equal(r.status, 400);
  })
);
