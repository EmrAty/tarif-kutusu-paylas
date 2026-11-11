// Veri kaybı regresyon testleri (bağımsız denetimde doğrulanan iki sorun):
//   1) okuma hatası "boş liste" sanılıp mevcut verinin üzerine yazılması
//   2) iki cihaz / aile üyesi / arka plan job'u aynı listeyi değiştirince son
//      yazanın diğerinin değişikliğini silmesi
// Gerçek istemci deposu (src/syncedBuckets.js) + gerçek istemci taşıyıcısı +
// gerçek api/data.js + gerçek api/recipe-jobs.js + gerçek Lua betiği (fengari).
// Redis bellek içi; Google/FCM/Anthropic sahte. Dışarıya hiç istek gitmez.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createMemoryRedis } from "./helpers/memoryRedis.mjs";

const KV = "https://kv.test";
process.env.KV_REST_API_URL = KV;
process.env.KV_REST_API_TOKEN = "test-token";
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.RECIPE_JOB_NOTIFY_MIN_DELAY_MS = "0";
delete process.env.OPENAI_API_KEY;

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-kid", alg: "RS256", use: "sig" };
process.env.FIREBASE_SERVICE_ACCOUNT_KEY = JSON.stringify({
  client_email: "test@tarif-kutusu.test",
  project_id: "tarif-kutusu",
  private_key: privateKey.export({ format: "pem", type: "pkcs8" }),
});

// ---------- bellek içi Redis + hata/yarış enjeksiyonu ----------
const db = new Map();
const redis = createMemoryRedis(db);
let failReads = null; // (key) => true ise o anahtarın okuması 500 döner
let failWrites = null; // (key) => true ise yazım 500 döner
let beforeEval = null; // async (key) => void : EVAL'den hemen önce araya girmek için
const evalKey = (command) => (command[0] === "EVAL" ? command[3] : null);

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  if (url.startsWith(`${KV}/get/`)) {
    const key = decodeURIComponent(url.slice(`${KV}/get/`.length));
    if (failReads && failReads(key)) return json(500, { error: "down" });
    return json(200, { result: redis.run(["GET", key]) });
  }
  if (url === KV) {
    const command = JSON.parse(init.body);
    const op = command[0];
    if (op === "MGET" && failReads && command.slice(1).some((k) => failReads(k))) return json(500, { error: "down" });
    if ((op === "EVAL" || op === "SET") && failWrites && failWrites(evalKey(command) ?? command[1])) {
      return json(500, { error: "down" });
    }
    if (op === "EVAL" && beforeEval) {
      const hook = beforeEval;
      await hook(evalKey(command));
    }
    try {
      return json(200, { result: redis.run(command) });
    } catch (e) {
      return json(400, { error: e.message });
    }
  }
  if (url.includes("securetoken@system.gserviceaccount.com")) return json(200, { keys: [jwk] });
  if (url === "https://oauth2.googleapis.com/token") return json(200, { access_token: "t", expires_in: 3600 });
  if (url.startsWith("https://fcm.googleapis.com/")) return json(200, { name: "msg" });
  if (url === "https://api.anthropic.com/v1/messages") {
    return json(200, {
      stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify({ title: "Job Tarifi", ingredients: [{ name: "un", amount: "1 kg" }], instructions: ["Pişir."] }) }],
    });
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

async function invoke(handler, uid, method, { body, query = {} } = {}) {
  const req = { method, headers: { authorization: `Bearer ${idToken(uid)}` }, body, query };
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

const { default: dataHandler } = await import("../api/data.js");
const { default: jobsHandler } = await import("../api/recipe-jobs.js");
const { listBackups } = await import("../api/_lib/versionedBucket.js");
const { createBucketStore, createDataTransport, BUCKET_STATUS, NOT_LOADED, CONFLICT_EXHAUSTED } = await import(
  "../src/syncedBuckets.js"
);
const { CATEGORIES } = await import("../shared/recipeExtraction.js");

// Bir cihaz: gerçek istemci deposu + gerçek taşıyıcı, api/data.js'e bağlı.
function device(uid, opts = {}) {
  const transport = createDataTransport((method, { query, body }) => invoke(dataHandler, uid, method, { query, body }));
  return createBucketStore({ transport, ...opts });
}

const recipesOf = (n, prefix = "r") =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i + 1}`, title: `Tarif ${i + 1}`, isFavorite: false, createdAt: i + 1 }));
const readJSON = (key) => (db.has(key) ? JSON.parse(db.get(key)) : undefined);
const ids = (list) => list.map((r) => r.id);
const addRecipe = (recipe) => (list) => (list.some((r) => r.id === recipe.id) ? list : [recipe, ...list]);
const setFavorite = (id, value) => (list) =>
  list.some((r) => r.id === id) ? list.map((r) => (r.id === id ? { ...r, isFavorite: value } : r)) : list;
const removeRecipe = (id) => (list) => (list.some((r) => r.id === id) ? list.filter((r) => r.id !== id) : list);
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function seed() {
  db.clear();
  failReads = null;
  failWrites = null;
  beforeEval = null;
  for (const uid of ["A", "B"]) {
    db.set(`user:${uid}:profile`, JSON.stringify({ isPlus: true, families: ["F1"] }));
  }
  db.set("family:F1:meta", JSON.stringify({ name: "Ev", ownerUid: "A", inviteCode: "ABCDEF" }));
  db.set("family:F1:members", JSON.stringify({ A: { joinedAt: 1 }, B: { joinedAt: 2 } }));
}

// ======================= PROBLEM 1: okuma hatası ≠ boş =======================

test("1) Gerçekten kayıt yok: boş + yüklendi sayılır, tarif eklenebilir", async () => {
  seed();
  const store = device("A");
  await store.load("recipes", "personal");
  const snap = store.get("recipes", "personal");
  assert.equal(snap.status, BUCKET_STATUS.READY);
  assert.deepEqual(snap.data, []);
  assert.equal(snap.version, 0);
  await store.mutate("recipes", "personal", addRecipe({ id: "new", title: "Yeni" }));
  assert.deepEqual(ids(readJSON("user:A:recipes")), ["new"]);
  assert.equal(db.get("user:A:recipes:version"), "1");
});

test("2) Geçici okuma hatası: boş liste sayılmaz, yazım engellenir, 12 tarif korunur (12 -> 1 senaryosu)", async () => {
  seed();
  db.set("user:A:recipes", JSON.stringify(recipesOf(12)));
  failReads = (key) => key === "user:A:recipes";

  // Sunucu: okuma hatası 5xx, asla { value: null }.
  const raw = await invoke(dataHandler, "A", "GET", { query: { bucket: "recipes", scope: "personal" } });
  assert.equal(raw.status, 502);
  assert.equal(raw.body.value, undefined);

  // İstemci: durum "error", veri yok (boş liste DEĞİL).
  const store = device("A");
  await store.load("recipes", "personal");
  const snap = store.get("recipes", "personal");
  assert.equal(snap.status, BUCKET_STATUS.ERROR);
  assert.equal(snap.data, null);

  // Kullanıcı yeni tarif eklemeye çalışır: işlem reddedilir, sunucuya yazılmaz.
  await assert.rejects(store.mutate("recipes", "personal", addRecipe({ id: "new" })), (e) => e.code === NOT_LOADED);
  assert.equal(readJSON("user:A:recipes").length, 12);
  assert.equal(store.get("recipes", "personal").data, null, "iyimser görünüm de geri alındı");

  // Bağlantı düzelince "tekrar dene" ile yüklenir ve ekleme çalışır, hiçbir tarif kaybolmaz.
  failReads = null;
  await store.load("recipes", "personal");
  assert.equal(store.get("recipes", "personal").data.length, 12);
  await store.mutate("recipes", "personal", addRecipe({ id: "new" }));
  assert.equal(readJSON("user:A:recipes").length, 13);
});

test("2b) Okuma hatasından sonra yapılan değişiklik önce yüklemeyi dener; yükleme başarılıysa güvenle uygulanır", async () => {
  seed();
  db.set("user:A:recipes", JSON.stringify(recipesOf(12)));
  failReads = (key) => key === "user:A:recipes";
  const store = device("A");
  await store.load("recipes", "personal");
  failReads = null;
  await store.mutate("recipes", "personal", addRecipe({ id: "new" }));
  assert.equal(readJSON("user:A:recipes").length, 13);
});

test("2c) Bozuk (ayrıştırılamayan) veri de boş sayılmaz; üzerine yazılmaz", async () => {
  seed();
  db.set("user:A:recipes", "{bozuk");
  const store = device("A");
  await store.load("recipes", "personal");
  assert.equal(store.get("recipes", "personal").status, BUCKET_STATUS.ERROR);
  await assert.rejects(store.mutate("recipes", "personal", addRecipe({ id: "x" })), (e) => e.code === NOT_LOADED);
  assert.equal(db.get("user:A:recipes"), "{bozuk");
});

test("2d) Aile kapsamı: aile listesi okunamazsa aynı koruma", async () => {
  seed();
  db.set("family:F1:recipes", JSON.stringify(recipesOf(5, "f")));
  failReads = (key) => key === "family:F1:recipes";
  const store = device("B");
  await store.load("recipes", "F1");
  assert.equal(store.get("recipes", "F1").status, BUCKET_STATUS.ERROR);
  await assert.rejects(store.mutate("recipes", "F1", addRecipe({ id: "x" })), (e) => e.code === NOT_LOADED);
  assert.equal(readJSON("family:F1:recipes").length, 5);
});

test("3) Yüklenmiş veri + yenileme hatası: son bilinen veri silinmez, stale işaretlenir, sunucu ezilmez", async () => {
  seed();
  db.set("user:A:recipes", JSON.stringify(recipesOf(12)));
  const store = device("A");
  await store.load("recipes", "personal");
  failReads = (key) => key === "user:A:recipes";
  await store.refresh("recipes", "personal");
  let snap = store.get("recipes", "personal");
  assert.equal(snap.status, BUCKET_STATUS.READY);
  assert.equal(snap.stale, true);
  assert.equal(snap.data.length, 12);

  // Hata sürerken yapılan değişiklik güvenli biçimde başarısız olur; veri aynen durur.
  await assert.rejects(store.mutate("recipes", "personal", setFavorite("r1", true)));
  assert.equal(readJSON("user:A:recipes").length, 12);
  assert.equal(store.get("recipes", "personal").data.find((r) => r.id === "r1").isFavorite, false, "yalnızca o değişiklik geri alındı");

  failReads = null;
  await store.mutate("recipes", "personal", setFavorite("r1", true));
  snap = store.get("recipes", "personal");
  assert.equal(snap.stale, false);
  assert.equal(readJSON("user:A:recipes").find((r) => r.id === "r1").isFavorite, true);
  assert.equal(readJSON("user:A:recipes").length, 12);
});

test("4) Alışveriş listesi ve kiler: okuma hatasında boş sayılmaz, yazım engellenir", async () => {
  seed();
  const shopping = { selected: ["r1", "r2"], checked: { a: true }, servings: {} };
  const pantry = ["un", "şeker", "yumurta"];
  db.set("user:A:shopping-list", JSON.stringify(shopping));
  db.set("family:F1:pantry-items", JSON.stringify(pantry));
  failReads = () => true;
  const store = device("A");
  await store.load("shopping-list", "personal");
  await store.load("pantry-items", "F1");
  assert.equal(store.get("shopping-list", "personal").status, BUCKET_STATUS.ERROR);
  assert.equal(store.get("pantry-items", "F1").status, BUCKET_STATUS.ERROR);
  await assert.rejects(
    store.mutate("shopping-list", "personal", (d) => ({ ...d, selected: [...(d.selected || []), "r9"] })),
    (e) => e.code === NOT_LOADED
  );
  await assert.rejects(store.mutate("pantry-items", "F1", (l) => [...l, "süt"]), (e) => e.code === NOT_LOADED);
  assert.deepEqual(readJSON("user:A:shopping-list"), shopping);
  assert.deepEqual(readJSON("family:F1:pantry-items"), pantry);

  // Gerçekten kayıt yoksa: alışveriş listesi {} ve kiler [] olarak yüklenir, eklenebilir.
  failReads = null;
  await store.load("pantry-items", "personal");
  assert.deepEqual(store.get("pantry-items", "personal").data, []);
  await store.mutate("pantry-items", "personal", (l) => [...l, "süt"]);
  assert.deepEqual(readJSON("user:A:pantry-items"), ["süt"]);
});

// ===================== PROBLEM 2: eşzamanlı yazım / son yazan =====================

test("5) İki cihaz aynı sürümü okur: A tarif ekler, B eski state'ten favori değiştirir -> ikisi de korunur", async () => {
  seed();
  db.set("user:A:recipes", JSON.stringify(recipesOf(10)));
  const phone = device("A");
  const tablet = device("A");
  await phone.load("recipes", "personal");
  await tablet.load("recipes", "personal");

  await phone.mutate("recipes", "personal", addRecipe({ id: "fromA", title: "A'nın tarifi" }));
  assert.equal(readJSON("user:A:recipes").length, 11);

  // Tablet hâlâ 10 tariflik eski state'te.
  assert.equal(tablet.get("recipes", "personal").data.length, 10);
  await tablet.mutate("recipes", "personal", setFavorite("r3", true));

  const server = readJSON("user:A:recipes");
  assert.equal(server.length, 11, "A'nın tarifi kaybolmadı");
  assert.ok(server.some((r) => r.id === "fromA"));
  assert.equal(server.find((r) => r.id === "r3").isFavorite, true, "B'nin favorisi korundu");
  assert.equal(tablet.get("recipes", "personal").data.length, 11, "tablet güncel listeyi görüyor");
});

test("6) İki aile üyesi aynı anda değişiklik yapar: ikisinin niyeti de korunur", async () => {
  seed();
  db.set("family:F1:recipes", JSON.stringify(recipesOf(10, "f")));
  const a = device("A");
  const b = device("B");
  await a.load("recipes", "F1");
  await b.load("recipes", "F1");
  await Promise.all([
    a.mutate("recipes", "F1", addRecipe({ id: "a-new" })),
    b.mutate("recipes", "F1", removeRecipe("f4")),
    b.mutate("recipes", "F1", setFavorite("f2", true)),
    a.mutate("recipes", "F1", setFavorite("f7", true)),
  ]);
  const server = readJSON("family:F1:recipes");
  assert.equal(server.length, 10);
  assert.ok(server.some((r) => r.id === "a-new"));
  assert.ok(!server.some((r) => r.id === "f4"));
  assert.equal(server.find((r) => r.id === "f2").isFavorite, true);
  assert.equal(server.find((r) => r.id === "f7").isFavorite, true);
});

async function waitForJob(uid, jobId) {
  for (let i = 0; i < 500; i++) {
    const job = readJSON(`job:${uid}:${jobId}`);
    if (job?.status === "completed" || job?.status === "failed") {
      if (job.notify) return job;
    }
    await sleep(10);
  }
  throw new Error("job bitmedi");
}

for (const [label, scope, key] of [
  ["kişisel", "personal", "user:A:recipes"],
  ["aile", "F1", "family:F1:recipes"],
]) {
  test(
    `7) Kullanıcı değişikliği + arka plan tarif job'u aynı anda (${label}): ikisi de korunur`,
    quiet(async () => {
      seed();
      db.set(key, JSON.stringify(recipesOf(10)));
      const store = device("A");
      await store.load("recipes", scope);

      // Job güncel listeyi okuyup karşılaştır-ve-yaz'a geldiği anda kullanıcı
      // (bayat state'ten) hem tarif ekliyor hem favori değiştiriyor.
      beforeEval = async (k) => {
        if (k !== key) return;
        beforeEval = null;
        await store.mutate("recipes", scope, addRecipe({ id: "manual" }));
        await store.mutate("recipes", scope, setFavorite("r5", true));
      };
      const r = await invoke(jobsHandler, "A", "POST", {
        body: {
          requestId: `req-${scope}-123456`,
          sourceUrl: "https://www.youtube.com/watch?v=abc",
          caption: "Kek: 3 yumurta, 1 su bardağı şeker, 2 su bardağı un, 1 paket kabartma tozu. Karıştırıp 40 dakika pişirin.",
          category: CATEGORIES[0],
          target: scope === "personal" ? "personal" : "family",
          familyId: scope === "personal" ? undefined : scope,
        },
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const job = await waitForJob("A", r.body.jobId);
      assert.equal(job.status, "completed", job.error);
      assert.equal(beforeEval, null, "yarış gerçekten oluştu");

      const server = readJSON(key);
      assert.equal(server.length, 12);
      assert.ok(server.some((x) => x.id === job.recipeId), "job'un tarifi korundu");
      assert.ok(server.some((x) => x.id === "manual"), "kullanıcının tarifi korundu");
      assert.equal(server.find((x) => x.id === "r5").isFavorite, true);

      // İstemci daha sonra eski state'inden bir değişiklik daha yapsa da job tarifi silinmez.
      await store.mutate("recipes", scope, setFavorite("r6", true));
      assert.ok(readJSON(key).some((x) => x.id === job.recipeId));
      assert.equal(db.has(`${key.replace(/:recipes$/, "")}:pendingJobRecipes`), false, "pendingJobRecipes artık yazılmıyor");
    })
  );
}

test("8a) Sunucu: eski sürümle yazım 409 + güncel değer/sürüm döner, hiçbir şey yazılmaz", async () => {
  seed();
  db.set("user:A:recipes", JSON.stringify(recipesOf(3)));
  db.set("user:A:recipes:version", "7");
  const r = await invoke(dataHandler, "A", "POST", {
    body: { bucket: "recipes", scope: "personal", value: "[]", baseVersion: 6 },
  });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "version_conflict");
  assert.equal(r.body.version, 7);
  assert.equal(JSON.parse(r.body.value).length, 3);
  assert.equal(readJSON("user:A:recipes").length, 3);
});

test("8b) Sunucu: okuma ile yazım arasına giren yazım atomik olarak yakalanır (okuma-kontrol-yazma yarışı yok)", async () => {
  seed();
  db.set("user:A:recipes", JSON.stringify(recipesOf(3)));
  // İstemci sürüm 1'i okudu ve [] yazmak istiyor; sunucu sürümü kontrol ettikten
  // sonra, EVAL'den hemen önce başka biri tarif ekliyor.
  beforeEval = async () => {
    beforeEval = null;
    const list = readJSON("user:A:recipes");
    db.set("user:A:recipes", JSON.stringify([{ id: "other" }, ...list]));
    db.set("user:A:recipes:version", "2");
  };
  const r = await invoke(dataHandler, "A", "POST", {
    body: { bucket: "recipes", scope: "personal", value: JSON.stringify(recipesOf(2)), baseVersion: 1 },
  });
  assert.equal(r.status, 409);
  assert.equal(readJSON("user:A:recipes").length, 4, "araya giren yazım korunmuş");
});

test("8c) İstemci: çakışmada güncel veriyi alır, niyeti yeniden uygular, tekrar dener", async () => {
  seed();
  db.set("user:A:recipes", JSON.stringify(recipesOf(3)));
  let sets = 0;
  const base = createDataTransport((method, { query, body }) => invoke(dataHandler, "A", method, { query, body }));
  const transport = { get: base.get, set: (...a) => (sets++, base.set(...a)) };
  const store = createBucketStore({ transport });
  await store.load("recipes", "personal");
  const other = device("A");
  await other.mutate("recipes", "personal", addRecipe({ id: "other" }));
  await store.mutate("recipes", "personal", addRecipe({ id: "mine" }));
  assert.equal(sets, 2, "bir çakışma + bir başarılı deneme");
  assert.deepEqual(ids(readJSON("user:A:recipes")).slice(0, 2), ["mine", "other"]);
});

test("8d) Sürekli çakışma: sınırlı deneme sonrası anlaşılır hata, başkasının verisi korunur, görünüm geri döner", async () => {
  seed();
  db.set("user:A:recipes", JSON.stringify(recipesOf(3)));
  const store = device("A", { maxAttempts: 3 });
  await store.load("recipes", "personal");
  let interference = 0;
  beforeEval = async function hook() {
    // Her yazım denemesinden hemen önce başka bir cihaz yazıyor.
    interference++;
    beforeEval = null;
    const list = readJSON("user:A:recipes");
    const version = Number(db.get("user:A:recipes:version") || 1);
    db.set("user:A:recipes", JSON.stringify([{ id: `other-${interference}` }, ...list]));
    db.set("user:A:recipes:version", String(version + 1));
    beforeEval = hook;
  };
  await assert.rejects(store.mutate("recipes", "personal", addRecipe({ id: "mine" })), (e) => {
    assert.equal(e.code, CONFLICT_EXHAUSTED);
    assert.match(e.message, /tekrar dene/);
    return true;
  });
  beforeEval = null;
  assert.equal(interference, 3, "tam olarak maxAttempts kez denendi");
  const server = readJSON("user:A:recipes");
  assert.ok(!server.some((r) => r.id === "mine"));
  assert.equal(server.filter((r) => r.id.startsWith("other-")).length, 3);
  assert.ok(!store.get("recipes", "personal").data.some((r) => r.id === "mine"));
});

test("9) Sürümsüz eski veri: veri kaybı olmadan okunur (örtük sürüm 1) ve ilk yazımla sürümlenir", async () => {
  seed();
  const legacy = recipesOf(12);
  db.set("user:A:recipes", JSON.stringify(legacy));
  assert.equal(db.has("user:A:recipes:version"), false);
  const store = device("A");
  await store.load("recipes", "personal");
  const snap = store.get("recipes", "personal");
  assert.equal(snap.version, 1);
  assert.deepEqual(snap.data, legacy);
  assert.equal(db.has("user:A:recipes:version"), false, "okuma hiçbir şey yazmaz");
  await store.mutate("recipes", "personal", setFavorite("r1", true));
  assert.equal(db.get("user:A:recipes:version"), "2");
  assert.equal(readJSON("user:A:recipes").length, 12);
});

test("10) Sürüm göndermeyen (eski) istemci yazımı reddedilir; sürüm 0 mevcut veriyi ezemez", async () => {
  seed();
  db.set("user:A:recipes", JSON.stringify(recipesOf(12)));
  const old = await invoke(dataHandler, "A", "POST", {
    body: { bucket: "recipes", scope: "personal", value: JSON.stringify([{ id: "only" }]) },
  });
  assert.equal(old.status, 426);
  assert.equal(old.body.code, "client_outdated");
  assert.equal(readJSON("user:A:recipes").length, 12);

  const zero = await invoke(dataHandler, "A", "POST", {
    body: { bucket: "recipes", scope: "personal", value: "[]", baseVersion: 0 },
  });
  assert.equal(zero.status, 409, "0 yalnızca hiç verisi olmayan kovayı oluşturabilir");
  assert.equal(readJSON("user:A:recipes").length, 12);

  for (const bad of ['{"a":1}', "[1,2]", "bozuk"]) {
    const r = await invoke(dataHandler, "A", "POST", {
      body: { bucket: "recipes", scope: "personal", value: bad, baseVersion: 1 },
    });
    assert.equal(r.status, 400, bad);
  }
  assert.equal(readJSON("user:A:recipes").length, 12);
});

test("11) Yedek: her başarılı yazımdan önceki veri geri alınabilir şekilde saklanır, sınırlıdır", async () => {
  seed();
  const original = recipesOf(12);
  db.set("user:A:recipes", JSON.stringify(original));
  const store = device("A");
  await store.load("recipes", "personal");
  await store.mutate("recipes", "personal", (list) => list.slice(0, 1)); // "mantık hatası": 12 -> 1
  assert.equal(readJSON("user:A:recipes").length, 1);

  const backups = await listBackups("user:A:recipes");
  assert.equal(backups.recent[0].version, 1);
  assert.deepEqual(JSON.parse(backups.recent[0].raw), original, "12 tariflik hâl kurtarılabilir");
  assert.equal(backups.daily.length, 1);
  assert.deepEqual(JSON.parse(backups.daily[0].raw), original);

  for (let i = 0; i < 10; i++) await store.mutate("recipes", "personal", addRecipe({ id: `n${i}` }));
  const after = await listBackups("user:A:recipes");
  assert.equal(after.recent.length, 5, "son 5 yazım tutuluyor");
  assert.equal(after.daily.length, 1, "gün başına tek kayıt");
  assert.deepEqual(JSON.parse(after.daily[0].raw), original, "günün ilk hâli korunuyor");
});

test("12) Free limiti sürümlü yazımda da çalışır; limit hatası çakışma sayılmaz", async () => {
  seed();
  db.set("user:A:profile", JSON.stringify({ isPlus: false, families: [] }));
  db.set("user:A:recipes", JSON.stringify(recipesOf(15)));
  const store = device("A");
  await store.load("recipes", "personal");
  await assert.rejects(store.mutate("recipes", "personal", addRecipe({ id: "16th" })), (e) => e.code === "free_recipe_limit");
  assert.equal(readJSON("user:A:recipes").length, 15);
  // Silme + geri al: limitin üstünde değilken bile akış bozulmuyor.
  await store.mutate("recipes", "personal", removeRecipe("r15"));
  await store.mutate("recipes", "personal", addRecipe(recipesOf(15)[14]));
  assert.equal(readJSON("user:A:recipes").length, 15);
});

test("13) Oturum değişince eski kullanıcının bekleyen değişikliği yeni oturuma uygulanmaz", async () => {
  seed();
  db.set("user:A:recipes", JSON.stringify(recipesOf(2)));
  const store = device("A");
  await store.load("recipes", "personal");
  const pending = store.mutate("recipes", "personal", addRecipe({ id: "late" }));
  store.reset();
  await assert.rejects(pending, (e) => e.code === "session_changed");
  assert.equal(readJSON("user:A:recipes").length, 2);
});

// ============ Geçiş güvenliği: sunucuyla uyumsuz (eski) istemci -> 426 ============
const { createUpdateGate, reloadForUpdate, reloadDidNotHelp, isClientOutdatedResponse, CLIENT_OUTDATED } = await import(
  "../src/updateRequired.js"
);

// Eski istemciyi taklit eder: aynı istemci kodu ama baseVersion göndermiyor.
function staleDevice(uid, gate) {
  let posts = 0;
  const request = (method, { query, body }) => {
    if (method === "POST") posts++;
    const stripped = body ? (({ baseVersion, ...rest }) => rest)(body) : body;
    return invoke(dataHandler, uid, method, { query, body: stripped });
  };
  const store = createBucketStore({ transport: createDataTransport(request), updateGate: gate });
  return { store, posts: () => posts };
}

test("14) Yazım 426 -> başarısız sayılır, iyimser değişiklik geri alınır, güncelleme gerekli olur", async () => {
  seed();
  db.set("user:A:recipes", JSON.stringify(recipesOf(3)));
  const gate = createUpdateGate();
  let notified = 0;
  gate.subscribe(() => notified++);
  const { store } = staleDevice("A", gate);
  await store.load("recipes", "personal");

  const pending = store.mutate("recipes", "personal", removeRecipe("r1"));
  assert.equal(store.get("recipes", "personal").data.length, 2, "iyimser görünüm");
  await assert.rejects(pending, (e) => e.code === CLIENT_OUTDATED && e.status === 426);

  assert.equal(gate.isRequired(), true);
  assert.equal(notified, 1, "arayüze bir kez bildirildi");
  assert.equal(store.get("recipes", "personal").data.length, 3, "silme kalıcıymış gibi görünmüyor");
  assert.equal(readJSON("user:A:recipes").length, 3, "sunucu verisi aynen duruyor");
});

test("15) 426 sonrası sonraki değişiklikler sunucuya hiç gönderilmeden engellenir (tüm kovalar)", async () => {
  seed();
  db.set("user:A:recipes", JSON.stringify(recipesOf(3)));
  const gate = createUpdateGate();
  const { store, posts } = staleDevice("A", gate);
  await store.load("recipes", "personal");
  await store.mutate("recipes", "personal", setFavorite("r1", true)).catch(() => {});
  assert.equal(posts(), 1);

  for (const [bucket, updater] of [
    ["recipes", setFavorite("r2", true)],
    ["shopping-list", (d) => ({ ...d, selected: ["r1"] })],
    ["pantry-items", (l) => [...l, "süt"]],
  ]) {
    const before = store.get(bucket, "personal")?.data;
    await assert.rejects(store.mutate(bucket, "personal", updater), (e) => e.code === CLIENT_OUTDATED);
    assert.deepEqual(store.get(bucket, "personal")?.data, before, `${bucket}: görünüm değişmedi`);
  }
  assert.equal(posts(), 1, "ek POST yok");
  assert.equal(readJSON("user:A:recipes").find((r) => r.id === "r1").isFavorite, false);

  // Okuma (yeniden yükleme) engellenmez: kullanıcı güncel veriyi görmeye devam eder.
  await store.refresh("recipes", "personal");
  assert.equal(store.get("recipes", "personal").stale, false);
});

test("16) Normal 409 çakışması ve diğer 4xx/5xx hataları güncelleme gerekli sayılmaz", async () => {
  seed();
  db.set("user:A:profile", JSON.stringify({ isPlus: false, families: [] }));
  db.set("user:A:recipes", JSON.stringify(recipesOf(15)));
  const gate = createUpdateGate();
  const store = createBucketStore({
    transport: createDataTransport((method, { query, body }) => invoke(dataHandler, "A", method, { query, body })),
    updateGate: gate,
  });
  await store.load("recipes", "personal");

  // 409: başka cihaz önce yazdı -> yeniden uygulanıp kaydedilir
  await device("A").mutate("recipes", "personal", setFavorite("r9", true));
  await store.mutate("recipes", "personal", setFavorite("r1", true));
  assert.equal(readJSON("user:A:recipes").find((r) => r.id === "r1").isFavorite, true);

  // 403 (Free limiti)
  await assert.rejects(store.mutate("recipes", "personal", addRecipe({ id: "16th" })), (e) => e.code === "free_recipe_limit");
  // 5xx (Redis yazılamadı)
  failWrites = (key) => key === "user:A:recipes";
  await assert.rejects(store.mutate("recipes", "personal", setFavorite("r2", true)), (e) => e.status === 502);
  failWrites = null;
  // 5xx okuma hatasıyla yükleme
  failReads = (key) => key === "user:A:shopping-list";
  await store.load("shopping-list", "personal");
  failReads = null;
  assert.equal(gate.isRequired(), false, "hiçbiri güncelleme gerekli sayılmadı");

  // Taşıyıcı düzeyinde: 400 / 401 / 403 / 500 eski istemci sayılmaz, 426 sayılır
  for (const status of [400, 401, 403, 404, 409, 500, 502]) {
    assert.equal(isClientOutdatedResponse(status, { error: "x" }), false, String(status));
  }
  assert.equal(isClientOutdatedResponse(426, {}), true);
  assert.equal(isClientOutdatedResponse(426, null), true);
  const t = createDataTransport(async () => ({ status: 426, body: null }));
  await assert.rejects(t.set("recipes", "personal", "[]", 1), (e) => e.code === CLIENT_OUTDATED);
});

test("17) Yenile: tek bir reload yapar; otomatik yenileme döngüsü yok; yenileme işe yaramazsa fark edilir", () => {
  const storage = new Map();
  const fakeStorage = { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, v) };
  let reloads = 0;
  const location = { reload: () => reloads++ };

  // Kapının kapanması kendi başına yenileme yapmaz.
  const gate = createUpdateGate();
  gate.markRequired();
  gate.markRequired();
  assert.equal(reloads, 0);

  assert.equal(reloadDidNotHelp({ version: "100", storage: fakeStorage }), false);
  reloadForUpdate({ version: "100", location, storage: fakeStorage });
  assert.equal(reloads, 1);
  // Yenilemeden sonra yine aynı (eski) paket çalışıyorsa:
  assert.equal(reloadDidNotHelp({ version: "100", storage: fakeStorage }), true);
  // Yeni paket geldiyse:
  assert.equal(reloadDidNotHelp({ version: "200", storage: fakeStorage }), false);

  // Depolama yoksa/hata atarsa yine yenilenir, uyarı çıkmaz.
  const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  reloadForUpdate({ version: "100", location, storage: broken });
  assert.equal(reloads, 2);
  assert.equal(reloadDidNotHelp({ version: "100", storage: broken }), false);
});
