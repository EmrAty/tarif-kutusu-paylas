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
