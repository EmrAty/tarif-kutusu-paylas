// DELETE /api/account entegrasyon testleri. Gerçek endpoint kodu (api/account.js,
// api/data.js, api/families.js, api/recipe-jobs.js) çalışıyor; Upstash Redis
// bellek içinde taklit ediliyor, Google (JWKS, OAuth, Identity Toolkit) ve
// Anthropic uçları sahte. Hiçbir gerçek Firebase/Redis sistemine istek gitmez:
// beklenmeyen her fetch testi düşürür.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createMemoryRedis } from "./helpers/memoryRedis.mjs";

const KV = "https://kv.test";
process.env.KV_REST_API_URL = KV;
process.env.KV_REST_API_TOKEN = "test-token";
process.env.ANTHROPIC_API_KEY = "test-key";

// Test token'larını imzalayan ve sahte JWKS'te yayımlanan anahtar; aynı anahtar
// sahte servis hesabının da anahtarı.
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-kid", alg: "RS256", use: "sig" };
process.env.FIREBASE_SERVICE_ACCOUNT_KEY = JSON.stringify({
  client_email: "test@tarif-kutusu.test",
  project_id: "tarif-kutusu",
  private_key: privateKey.export({ format: "pem", type: "pkcs8" }),
});

// ---------- bellek içi Redis (Upstash REST) ----------
const db = new Map();
const memoryRedis = createMemoryRedis(db);
const ttl = new Map();

function globToRegExp(pattern) {
  return new RegExp("^" + pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
}

function runRedis([op, ...args]) {
  switch (op.toUpperCase()) {
    case "SET": {
      const [key, value, ...opts] = args;
      if (opts.includes("NX") && db.has(key)) return null;
      db.set(key, value);
      const ex = opts.indexOf("EX");
      if (ex >= 0) ttl.set(key, Number(opts[ex + 1]));
      else ttl.delete(key);
      return "OK";
    }
    case "DEL":
      return args.reduce((n, key) => (ttl.delete(key), n + (db.delete(key) ? 1 : 0)), 0);
    case "SCAN": {
      const re = globToRegExp(args[args.indexOf("MATCH") + 1]);
      return ["0", [...db.keys()].filter((k) => re.test(k))];
    }
    default:
      // Sürümlü kovaların komutları (MGET, EVAL…) ortak bellek içi Redis'te.
      return memoryRedis.run([op, ...args]);
  }
}

// ---------- sahte dış servisler ----------
const firebaseDeleted = [];
let firebaseFailure = false;
let claudeCalls = 0;
let releaseClaude = () => {};
let claudeGate = Promise.resolve();

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  if (url.startsWith(`${KV}/get/`)) {
    const key = decodeURIComponent(url.slice(`${KV}/get/`.length));
    return json(200, { result: db.has(key) ? db.get(key) : null });
  }
  // AI koruması (Grup 2) sayaç/kira komutlarını Upstash /pipeline ile gönderir.
  if (url === `${KV}/pipeline`) return json(200, memoryRedis.pipeline(JSON.parse(init.body)));
  if (url === KV) return json(200, { result: runRedis(JSON.parse(init.body)) });
  if (url.includes("securetoken@system.gserviceaccount.com")) return json(200, { keys: [jwk] });
  if (url === "https://oauth2.googleapis.com/token") return json(200, { access_token: "test-access", expires_in: 3600 });
  if (url === "https://identitytoolkit.googleapis.com/v1/projects/tarif-kutusu/accounts:delete") {
    if (firebaseFailure) return json(500, { error: { message: "INTERNAL_ERROR" } });
    const { localId } = JSON.parse(init.body);
    if (firebaseDeleted.includes(localId)) return json(400, { error: { message: "USER_NOT_FOUND" } });
    firebaseDeleted.push(localId);
    return json(200, {});
  }
  if (url === "https://api.anthropic.com/v1/messages") {
    claudeCalls++;
    await claudeGate;
    const recipe = { title: "Test Tarifi", ingredients: [], instructions: [] };
    return json(200, { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(recipe) }] });
  }
  throw new Error(`Testte beklenmeyen dış istek: ${url}`);
};

// ---------- yardımcılar ----------
function idToken(uid, provider = "password") {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const header = enc({ alg: "RS256", kid: "test-kid", typ: "JWT" });
  const payload = enc({
    iss: "https://securetoken.google.com/tarif-kutusu",
    aud: "tarif-kutusu",
    sub: uid,
    iat: now,
    exp: now + 3600,
    ...(provider === "anonymous" ? {} : { email: `${uid.toLowerCase()}@example.test` }),
    firebase: { sign_in_provider: provider },
  });
  const sig = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
  return `${header}.${payload}.${sig}`;
}

async function call(handler, { method, uid, provider, body, query }) {
  const req = { method, headers: uid ? { authorization: `Bearer ${idToken(uid, provider)}` } : {}, body, query: query || {} };
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

const put = (key, value, ex) => runRedis(ex ? ["SET", key, JSON.stringify(value), "EX", String(ex)] : ["SET", key, JSON.stringify(value)]);
const read = (key) => (db.has(key) ? JSON.parse(db.get(key)) : undefined);
const keysOf = (re) => [...db.keys()].filter((k) => re.test(k)).sort();
const ownedByA = () => keysOf(/^(user|job|job-req|job-url):A:/);
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

// A: Plus kullanıcısı.
//   F1: A tek üye ve sahip            -> aile tamamen silinmeli
//   F2: A sahip, B (20) ve C (30) üye -> A çıkmalı, sahiplik B'ye (en eski) geçmeli
//   F3: sahip B, A üye                -> A çıkmalı, sahip değişmemeli
// B, C, AB: dokunulmaması gereken başka kullanıcılar (AB, A ile önek çakışması).
function seed() {
  db.clear();
  ttl.clear();
  firebaseDeleted.length = 0;
  firebaseFailure = false;

  put("user:A:profile", { isPlus: true, families: ["F1", "F2", "F3"] });
  put("user:A:recipes", [{ id: "a-1" }]);
  put("user:A:shopping-list", [{ id: "a-s" }]);
  put("user:A:pantry-items", [{ id: "a-p" }]);
  put("user:A:fcmTokens", ["token-a"]);
  put("user:A:pendingJobRecipes", ["a-1"], 600);
  put("user:A:recentlyRemovedRecipes", ["a-0"], 120);
  put("user:A:unlistedFutureKey", "x");
  put("job:A:j1", { id: "j1", sourceUrl: "https://www.tiktok.com/@x/video/1" }, 600);
  put("job-req:A:req-1", "j1", 600);
  put("job-url:A:hash", "j1", 300);

  put("family:F1:meta", { name: "Tek", ownerUid: "A", inviteCode: "AAA111" });
  put("family:F1:members", { A: { joinedAt: 1 } });
  for (const b of ["recipes", "shopping-list", "pantry-items", "pendingJobRecipes"]) put(`family:F1:${b}`, ["f1"]);
  put("invite:AAA111:family", "F1");

  put("family:F2:meta", { name: "Ev", ownerUid: "A", inviteCode: "BBB222" });
  put("family:F2:members", { A: { joinedAt: 1 }, C: { joinedAt: 30 }, B: { joinedAt: 20 } });
  put("family:F2:recipes", [{ id: "shared", addedBy: "A" }]);
  put("family:F2:shopping-list", [{ id: "f2-s" }]);
  put("invite:BBB222:family", "F2");

  put("family:F3:meta", { name: "Kardeş", ownerUid: "B", inviteCode: "CCC333" });
  put("family:F3:members", { B: { joinedAt: 1 }, A: { joinedAt: 5 } });
  put("family:F3:recipes", [{ id: "f3" }]);
  put("invite:CCC333:family", "F3");

  put("user:B:profile", { isPlus: true, families: ["F2", "F3"] });
  put("user:B:recipes", [{ id: "b-1" }]);
  put("user:B:fcmTokens", ["token-b"]);
  put("user:C:profile", { isPlus: true, families: ["F2"] });
  put("user:AB:profile", { isPlus: false, families: [] });
  put("user:AB:recipes", [{ id: "ab-1" }]);
  put("job:AB:j9", { id: "j9" }, 600);
  put("job-url:AB:hash", "j9", 300);
  put("recipes", ["eski ortak liste"]);
}

const { default: account } = await import("../api/account.js");
const { default: data } = await import("../api/data.js");
const { default: families } = await import("../api/families.js");
const { default: recipeJobs } = await import("../api/recipe-jobs.js");
const { CATEGORIES } = await import("../shared/recipeExtraction.js");

const deleteA = (extra = {}) => call(account, { method: "DELETE", uid: "A", ...extra });

test("yalnızca kimliği doğrulanmış DELETE kabul edilir", quiet(async () => {
  seed();
  assert.equal((await call(account, { method: "GET", uid: "A" })).status, 405);
  assert.equal((await call(account, { method: "POST", uid: "A" })).status, 405);
  assert.equal((await call(account, { method: "DELETE" })).status, 401);
  assert.ok(db.has("user:A:profile"));
  assert.deepEqual(firebaseDeleted, []);
}));

test("kişisel veri, job kayıtları ve Firebase kullanıcısı silinir", quiet(async () => {
  seed();
  const r = await deleteA();
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
  assert.deepEqual(ownedByA(), []);
  assert.deepEqual(firebaseDeleted, ["A"]);
  assert.ok(db.has("deleted-account:A"));
  assert.equal(ttl.get("deleted-account:A"), 24 * 3600);
}));

test("aile: tek üyesi olduğu aile ve tüm aile verisi silinir", quiet(async () => {
  seed();
  await deleteA();
  assert.deepEqual(keysOf(/F1|AAA111/), []);
}));

test("aile: sahip silinince aile kalır, sahiplik en eski katılan üyeye geçer", quiet(async () => {
  seed();
  await deleteA();
  assert.deepEqual(Object.keys(read("family:F2:members")).sort(), ["B", "C"]);
  assert.equal(read("family:F2:meta").ownerUid, "B");
  assert.equal(read("family:F2:meta").name, "Ev");
  assert.deepEqual(read("family:F2:recipes"), [{ id: "shared", addedBy: "A" }]);
  assert.deepEqual(read("family:F2:shopping-list"), [{ id: "f2-s" }]);
  assert.equal(read("invite:BBB222:family"), "F2");
  assert.deepEqual(read("user:C:profile").families, ["F2"]);
}));

test("aile: sahip olmayan üye yalnızca üyelikten çıkar", quiet(async () => {
  seed();
  await deleteA();
  assert.deepEqual(Object.keys(read("family:F3:members")), ["B"]);
  assert.equal(read("family:F3:meta").ownerUid, "B");
  assert.deepEqual(read("family:F3:recipes"), [{ id: "f3" }]);
  assert.equal(read("invite:CCC333:family"), "F3");
}));

test("başka kullanıcıların verisine dokunulmaz (A / AB önek çakışması dahil)", quiet(async () => {
  seed();
  const others = keysOf(/^(user|job|job-req|job-url):(B|C|AB):|^recipes$/);
  const before = new Map(others.map((k) => [k, db.get(k)]));
  await deleteA();
  for (const [k, v] of before) assert.equal(db.get(k), v, k);
  assert.deepEqual(read("user:B:profile"), { isPlus: true, families: ["F2", "F3"] });
}));

test("uid istekten değil token'dan alınır", quiet(async () => {
  seed();
  await deleteA({ body: { uid: "B" }, query: { uid: "B" } });
  assert.deepEqual(firebaseDeleted, ["A"]);
  assert.ok(db.has("user:B:profile"));
  assert.ok(db.has("user:B:recipes"));
}));

test("silinen hesabın eski token'ı veri yazamaz, job açamaz, aile kuramaz", quiet(async () => {
  seed();
  await deleteA();
  const write = await call(data, { method: "POST", uid: "A", body: { bucket: "recipes", scope: "personal", value: [] } });
  assert.equal(write.status, 401);
  const job = await call(recipeJobs, {
    method: "POST",
    uid: "A",
    body: { requestId: "req-after", sourceUrl: "https://www.youtube.com/watch?v=x", caption: "x", category: CATEGORIES[0] },
  });
  assert.equal(job.status, 401);
  const family = await call(families, { method: "POST", uid: "A", body: { action: "create", name: "Yeni" } });
  assert.equal(family.status, 401);
  assert.deepEqual(ownedByA(), []);
  assert.equal((await call(data, { method: "GET", uid: "B", query: { bucket: "recipes", scope: "personal" } })).status, 200);
}));

test("endpoint tekrar çağrılabilir (idempotent)", quiet(async () => {
  seed();
  assert.equal((await deleteA()).status, 200);
  // Silme işareti her çağrıda yeni zaman damgasıyla yenileniyor; geri kalan
  // her şey birebir aynı kalmalı.
  const snapshot = () => [...db.entries()].filter(([k]) => k !== "deleted-account:A").sort();
  const after = snapshot();
  const second = await deleteA();
  assert.equal(second.status, 200);
  assert.deepEqual(snapshot(), after);
  assert.ok(db.has("deleted-account:A"));
  assert.deepEqual(firebaseDeleted, ["A"]);
}));

test("Firebase hatasında genel mesaj döner, tekrar deneme tamamlar", quiet(async () => {
  seed();
  firebaseFailure = true;
  const failed = await deleteA();
  assert.equal(failed.status, 500);
  assert.equal(failed.body.code, "account_delete_failed");
  assert.ok(!JSON.stringify(failed.body).includes("INTERNAL_ERROR"), "iç hata ayrıntısı istemciye gitmemeli");
  assert.deepEqual(firebaseDeleted, []);
  assert.deepEqual(ownedByA(), [], "Redis verisi Firebase'den önce silinmiş olmalı");

  firebaseFailure = false;
  const retried = await deleteA();
  assert.equal(retried.status, 200);
  assert.deepEqual(firebaseDeleted, ["A"]);
}));

test("verisi ve ailesi olmayan misafir (anonim) hesap silinir", quiet(async () => {
  seed();
  put("user:G:recipes", [{ id: "g-1" }]);
  const r = await call(account, { method: "DELETE", uid: "G", provider: "anonymous" });
  assert.equal(r.status, 200);
  assert.deepEqual(firebaseDeleted, ["G"]);
  assert.deepEqual(keysOf(/^user:G:/), []);
  assert.ok(db.has("user:A:profile"));
}));

async function startPersonalJob(uid) {
  claudeCalls = 0;
  claudeGate = new Promise((r) => (releaseClaude = r));
  const r = await call(recipeJobs, {
    method: "POST",
    uid,
    body: {
      requestId: `req-${Math.random().toString(36).slice(2, 10)}`,
      sourceUrl: "https://www.youtube.com/watch?v=abc",
      caption: "Malzemeler: un, şeker. Yapılışı: karıştır ve pişir.",
      category: CATEGORIES[0],
    },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  for (let i = 0; i < 100 && claudeCalls === 0; i++) await sleep(10);
  assert.equal(claudeCalls, 1, "job Claude çağrısına ulaşmalı");
}

test("kontrol: hesap silinmezse paylaşım job'u tarifi kişisel listeye yazar", quiet(async () => {
  seed();
  await startPersonalJob("A");
  releaseClaude();
  for (let i = 0; i < 100 && read("user:A:recipes")?.[0]?.title !== "Test Tarifi"; i++) await sleep(10);
  assert.equal(read("user:A:recipes")[0].title, "Test Tarifi");
}));

test("job sürerken hesap silinirse tarif yazılmaz, job kaydı kalmaz", quiet(async () => {
  seed();
  await startPersonalJob("A");
  assert.equal((await deleteA()).status, 200);
  releaseClaude();
  await sleep(300);
  assert.deepEqual(ownedByA(), []);
}));
