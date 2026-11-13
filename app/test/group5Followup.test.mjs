// Grup 5 — Fable denetimi ikinci tur (B1–B6) regresyon testleri.
// Bellek içi Redis + sahte Firebase/FCM; gerçek ağ yok, sabit bekleme yok.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { setRoutes, invoke, resetDb, json, db } from "./helpers/fakeServices.mjs";

{
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.FIREBASE_SERVICE_ACCOUNT_KEY = JSON.stringify({
    client_email: "test@tarif-kutusu.test",
    project_id: "tarif-kutusu",
    private_key: privateKey.export({ format: "pem", type: "pkcs8" }),
  });
}

const { default: notify } = await import("../api/notify.js");
const { default: profileHandler } = await import("../api/profile.js");
const { __setNotifyClockForTests, NOTIFY_LIMITS } = await import("../api/_lib/notifyGuard.js");

const FCM_SEND = "https://fcm.googleapis.com/v1/projects/tarif-kutusu/messages:send";
const FIREBASE_DELETE = "https://identitytoolkit.googleapis.com/v1/projects/tarif-kutusu/accounts:delete";
let firebaseDeleted = [];

function reset() {
  resetDb();
  firebaseDeleted = [];
  __setNotifyClockForTests(() => Date.UTC(2026, 10, 13, 10, 0, 0));
  setRoutes([
    ["https://oauth2.googleapis.com/token", () => json(200, { access_token: "x", expires_in: 3600 })],
    [FIREBASE_DELETE, (url, init) => {
      firebaseDeleted.push(JSON.parse(init.body).localId);
      return json(200, {});
    }],
    [FCM_SEND, () => json(200, { name: "m" })],
  ]);
}

const recipe = (id, extra = {}) => ({ id, title: `Tarif ${id}`, ingredients: [], instructions: [], ...extra });

function seedFamily(members, { recipes = [recipe("r1"), recipe("r2")] } = {}) {
  for (const uid of members) db.set(`user:${uid}:profile`, JSON.stringify({ isPlus: true, families: ["F1"] }));
  db.set("family:F1:meta", JSON.stringify({ name: "Ev", ownerUid: members[0], inviteCode: "ABCDEFGHJK" }));
  db.set("family:F1:members", JSON.stringify(Object.fromEntries(members.map((uid, i) => [uid, { name: `Ad-${uid}`, joinedAt: i + 1 }]))));
  db.set("family:F1:recipes", JSON.stringify(recipes));
}

// ============ B4: bildirim sayaçları ============

test("B4: bir üyenin reddedilen istekleri aile sayacını doldurmaz; diğer üye bildirim gönderebilir", async () => {
  reset();
  seedFamily(["A", "B", "C"]);
  const codes = {};
  for (let i = 0; i < 45; i++) {
    const r = await invoke(notify, { uid: "A", body: { familyId: "F1", recipeId: "r1" } });
    codes[r.status] = (codes[r.status] || 0) + 1;
  }
  assert.deepEqual(codes, { 200: 1, 429: 44 });
  const b = await invoke(notify, { uid: "B", body: { familyId: "F1", recipeId: "r2" } });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  const familyCounter = [...db.keys()].find((k) => k.startsWith("rl:notify:f:F1:3600:"));
  assert.equal(db.get(familyCounter), "2", "aile sayacı yalnızca gönderilen 2 bildirimi sayar");
});

test("B4: gönderen kendi saatlik sınırını aştığında aile sayacı artmaz; farklı tariflerle sel aileyi kilitleyemez", async () => {
  reset();
  const recipes = Array.from({ length: 60 }, (_, i) => recipe(`r${i}`));
  seedFamily(["A", "B"], { recipes });
  let ok = 0;
  for (let i = 0; i < 60; i++) if ((await invoke(notify, { uid: "A", body: { familyId: "F1", recipeId: `r${i}` } })).status === 200) ok++;
  assert.equal(ok, NOTIFY_LIMITS.senderHourly);
  const familyCounter = [...db.keys()].find((k) => k.startsWith("rl:notify:f:F1:3600:"));
  assert.equal(db.get(familyCounter), String(NOTIFY_LIMITS.senderHourly));
  // Reddedilen tarifin aynı-tarif beklemesi kalmadı (gönderilmedi).
  const sameKeys = [...db.keys()].filter((k) => k.startsWith("rl:notify:same:"));
  assert.equal(sameKeys.length, NOTIFY_LIMITS.senderHourly);
  assert.equal((await invoke(notify, { uid: "B", body: { familyId: "F1", recipeId: "r0" } })).status, 200);
});

test("B4: aile saatlik sınırı gerçekten gönderilenleri sayar; aşan istek geri alınır ve beklemesi bırakılır", async () => {
  reset();
  const members = Array.from({ length: 6 }, (_, i) => `M${i}`);
  seedFamily(members, { recipes: Array.from({ length: 10 }, (_, i) => recipe(`r${i}`)) });
  let ok = 0;
  let limited = 0;
  for (const uid of members) {
    for (let i = 0; i < 9; i++) {
      const r = await invoke(notify, { uid, body: { familyId: "F1", recipeId: `r${i}` } });
      if (r.status === 200) ok++;
      else if (r.body.code === "notify_rate_limited") limited++;
    }
  }
  assert.equal(ok, NOTIFY_LIMITS.familyHourly);
  assert.equal(limited, members.length * 9 - NOTIFY_LIMITS.familyHourly);
  const familyCounter = [...db.keys()].find((k) => k.startsWith("rl:notify:f:F1:3600:"));
  assert.equal(db.get(familyCounter), String(NOTIFY_LIMITS.familyHourly));
});

// ============ B5: bozuk profil ============

test("B5: GET /api/profile bozuk profilde istisna fırlatmaz; 502 + profile_unreadable", async () => {
  reset();
  db.set("user:A:profile", "{bozuk");
  const r = await invoke(profileHandler, { method: "GET", uid: "A" });
  assert.equal(r.status, 502);
  assert.equal(r.body.code, "profile_unreadable");
  db.set("user:A:profile", "[1,2]");
  assert.equal((await invoke(profileHandler, { method: "GET", uid: "A" })).body.code, "profile_unreadable");
});

test("B5: Redis'e ulaşılamazsa GET /api/profile 502 döner (istisna sızmaz)", async () => {
  reset();
  const { setRedisDown } = await import("./helpers/fakeServices.mjs");
  setRedisDown(true);
  const r = await invoke(profileHandler, { method: "GET", uid: "A" });
  assert.equal(r.status, 502);
});

// ============ B3: kova boyutu, biçim ve yazım hızı ============

const { default: dataHandler } = await import("../api/data.js");
const { __setClockForTests } = await import("../api/_lib/aiGuard.js");
const { BUCKET_LIMITS } = await import("../api/_lib/bucketLimits.js");
const { DATA_WRITE_LIMITS } = await import("../api/_lib/abusePolicy.js");
const { FREE_RECIPE_LIMIT } = await import("../shared/limits.js");
const { setRedisFault } = await import("./helpers/fakeServices.mjs");

const write = (uid, bucket, value, baseVersion, { anonymous = false, ip, scope = "personal", familyId } = {}) =>
  invoke(dataHandler, {
    method: "POST",
    uid,
    anonymous,
    ...(ip ? { ip } : {}),
    body: { bucket, scope, ...(familyId ? { familyId } : {}), value: typeof value === "string" ? value : JSON.stringify(value), baseVersion },
  });
const stored = (key) => JSON.parse(db.get(key) || "null");

test("B3: 3 MB alışveriş listesi, 3 MB kiler öğesi, 501 kiler öğesi, 2001 tarif ve 2 MB üstü tarif listesi reddedilir; hiçbir şey yazılmaz", async () => {
  reset();
  let r = await write("ANON", "shopping-list", { selected: [], checked: {}, junk: "x".repeat(3_000_000) }, 0, { anonymous: true });
  assert.equal(r.status, 400, "bilinmeyen alan");
  const bigChecked = Object.fromEntries(Array.from({ length: 1999 }, (_, i) => [`m${i}-${"y".repeat(150)}`, true]));
  r = await write("ANON", "shopping-list", { selected: [], checked: bigChecked }, 0, { anonymous: true });
  assert.equal(r.status, 413, JSON.stringify(r.body));
  assert.equal(r.body.code, "bucket_too_large");
  r = await write("ANON", "pantry-items", ["y".repeat(3_000_000)], 0, { anonymous: true });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "invalid_bucket_value");
  r = await write("ANON", "pantry-items", Array.from({ length: BUCKET_LIMITS["pantry-items"].maxItems + 1 }, (_, i) => `malzeme ${i}`), 0, { anonymous: true });
  assert.equal(r.status, 413);
  db.set("user:P:profile", JSON.stringify({ isPlus: true, families: [] }));
  r = await write("P", "recipes", Array.from({ length: 2001 }, (_, i) => recipe(`m${i}`)), 0);
  assert.equal(r.status, 413);
  r = await write("P", "recipes", Array.from({ length: 1500 }, (_, i) => recipe(`m${i}`, { instructions: ["z".repeat(1500)] })), 0);
  assert.equal(r.status, 413);
  assert.equal([...db.keys()].filter((k) => k.startsWith("user:ANON:") || k.startsWith("user:P:recipes")).length, 0);
});

test("B3: gerçek biçimler kabul edilir (selected/checked/servings, metin kiler); değişmemiş eski alan engel olmaz, yeni bilinmeyen alan reddedilir", async () => {
  reset();
  const list = { selected: ["r1", 1790000000000], checked: { "un|g": true, şeker: false }, servings: { r1: 4, 1790000000000: 2.5 } };
  let r = await write("A", "shopping-list", list, 0);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await write("A", "pantry-items", ["un", "şeker", "zeytinyağı"], 0);
  assert.equal(r.status, 200);
  for (const bad of [{ selected: [{ x: 1 }] }, { checked: { a: "evet" } }, { servings: { r1: -1 } }, { servings: { r1: 5000 } }, { selected: "r1" }]) {
    assert.equal((await write("A", "shopping-list", bad, 1)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await write("A", "pantry-items", ["un", { obj: 1 }], 1)).status, 400);
  assert.equal((await write("A", "pantry-items", ["un", "   "], 1)).status, 400);
  // Eski kayıt: tanınmayan alan (ör. eski 'items') değişmeden kaldıkça yazım serbest.
  db.set("user:L:shopping-list", JSON.stringify({ items: ["süt"], selected: [] }));
  db.set("user:L:pantry-items", JSON.stringify(["un", { eski: true }]));
  r = await write("L", "shopping-list", { items: ["süt"], selected: ["r1"] }, 1);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await write("L", "pantry-items", ["un", { eski: true }, "tuz"], 1);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await write("L", "shopping-list", { items: ["süt", "ekmek"], selected: ["r1"] }, 2)).status, 400);
});

test("B3: tavanın üstündeki eski kova küçültülebilir ve aynı boyutta düzenlenebilir; büyütülemez", async () => {
  reset();
  const huge = Array.from({ length: 600 }, (_, i) => `malzeme ${i}`);
  db.set("user:A:pantry-items", JSON.stringify(huge));
  db.set("user:A:profile", JSON.stringify({ isPlus: true, families: [] }));
  db.set("user:A:recipes", JSON.stringify(Array.from({ length: 2100 }, (_, i) => recipe(`o${i}`))));
  assert.equal((await write("A", "pantry-items", [...huge, "yeni"], 1)).status, 413);
  assert.equal((await write("A", "pantry-items", huge.slice(1), 1)).status, 200);
  assert.equal(stored("user:A:pantry-items").length, 599);
  const recipes = stored("user:A:recipes");
  assert.equal((await write("A", "recipes", [recipe("new"), ...recipes], 1)).status, 413);
  const shrink = await write("A", "recipes", recipes.slice(5), 1);
  assert.equal(shrink.status, 200, JSON.stringify(shrink.body));
  const edited = stored("user:A:recipes").map((r, i) => (i === 0 ? { ...r, title: "Tarif O5" } : r));
  assert.equal((await write("A", "recipes", edited, 2)).status, 200);
});

test("B3: yazım hızı — normal art arda kullanım geçer; dakikalık sınırın üstü 429; misafirde IP başına ayrı sınır", async () => {
  reset();
  __setClockForTests(() => Date.UTC(2026, 10, 13, 10, 0, 1));
  try {
    let version = 0;
    for (let i = 0; i < 60; i++) {
      const r = await write("A", "pantry-items", [`m${i}`], version);
      assert.equal(r.status, 200);
      version = r.body.version;
    }
    const perMinute = DATA_WRITE_LIMITS[0].user;
    let limited = null;
    for (let i = 60; i < perMinute + 5 && !limited; i++) {
      const r = await write("A", "pantry-items", [`m${i}`], version);
      if (r.status === 429) limited = r;
      else version = r.body.version;
    }
    assert.ok(limited, "dakikalık sınır devreye girer");
    assert.equal(limited.body.code, "rate_limited");
    assert.ok(Number(limited.headers["retry-after"]) > 0);
    assert.equal((await write("B", "pantry-items", ["x"], 0)).status, 200, "başka hesap etkilenmez");
    __setClockForTests(() => Date.UTC(2026, 10, 13, 10, 1, 1));
    assert.equal((await write("A", "pantry-items", ["son"], version)).status, 200, "bir dakika sonra açılır");
    const ipKey = (k) => k.startsWith("rl:data-write:ip:");
    await write("G1", "pantry-items", ["x"], 0, { anonymous: true, ip: "198.51.100.9" });
    assert.ok([...db.keys()].some(ipKey), "misafir IP sayacı");
    const before = [...db.keys()].filter(ipKey).length;
    await write("REALX", "pantry-items", ["x"], 0, { ip: "198.51.100.10" });
    assert.equal([...db.keys()].filter(ipKey).length, before, "kalıcı hesapta IP sayacı yok");
  } finally {
    __setClockForTests(null);
  }
});

test("B3: Redis sayaç komutu hata verirse yazım engellenmez (fail-open, bilinçli)", async () => {
  reset();
  setRedisFault((c) => String(c[0]).toUpperCase() === "INCR");
  const r = await write("A", "pantry-items", ["un"], 0);
  assert.equal(r.status, 200);
});

// ============ B6: Free sınırı ve tekrar eden kimlik ============

test("B6: sınırın üstündeki Free hesap tek yazımda 'bir sil + bir yeni ekle' ile yeni tarif ekleyemez; gerçek geri al çalışır", async () => {
  reset();
  db.set("user:A:profile", JSON.stringify({ isPlus: false, families: [] }));
  const base = Array.from({ length: FREE_RECIPE_LIMIT + 5 }, (_, i) => recipe(`o${i}`));
  db.set("user:A:recipes", JSON.stringify(base));
  const swap = await write("A", "recipes", [recipe("NEW"), ...base.slice(1)], 1);
  assert.equal(swap.status, 403);
  assert.equal(swap.body.code, "free_recipe_limit");
  const del = await write("A", "recipes", base.slice(1), 1);
  assert.equal(del.status, 200);
  const undo = await write("A", "recipes", base, del.body.version);
  assert.equal(undo.status, 200, JSON.stringify(undo.body));
  // Bir silineni geri getirip aynı yazımda başka birini silmek (aynı uzunluk) de serbest.
  const del2 = await write("A", "recipes", base.filter((r) => r.id !== "o3"), undo.body.version);
  const mixed = await write("A", "recipes", base.filter((r) => r.id !== "o4"), del2.body.version);
  assert.equal(mixed.status, 200, JSON.stringify(mixed.body));
  const cur = stored("user:A:recipes");
  assert.equal((await write("A", "recipes", [...cur].reverse().map((r, i) => (i ? r : { ...r, title: "x" })), mixed.body.version)).status, 200);
});

test("B6: aynı listede tekrar eden kimlik 400; eski kayıttaki tekrar kullanıcıyı kilitlemez", async () => {
  reset();
  db.set("user:A:profile", JSON.stringify({ isPlus: true, families: [] }));
  let r = await write("A", "recipes", [recipe("d"), recipe("d"), recipe("d")], 0);
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "invalid_recipe");
  db.set("user:B:profile", JSON.stringify({ isPlus: true, families: [] }));
  db.set("user:B:recipes", JSON.stringify([recipe("d"), recipe("d", { title: "ikinci" }), recipe("e")]));
  r = await write("B", "recipes", [recipe("d"), recipe("d", { title: "ikinci" }), recipe("e", { title: "düzenlendi" }), recipe("f")], 1);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await write("B", "recipes", [recipe("d"), recipe("d"), recipe("d")], r.body.version);
  assert.equal(r.status, 400, "tekrar sayısı artamaz");
});
