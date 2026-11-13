// Grup 4 — iki cihaz: bir cihazdaki aile değişikliği, diğer cihazın aile
// yenilemesinde (src/familySync.js + gerçek api/families.js) görünür.
// Bellek içi Redis (gerçek Lua ile EVAL); dış ağ yok.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { setRoutes, invoke, resetDb, json, db, redisLog } from "./helpers/fakeServices.mjs";

{
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.FIREBASE_SERVICE_ACCOUNT_KEY = JSON.stringify({
    client_email: "test@tarif-kutusu.test",
    project_id: "tarif-kutusu",
    private_key: privateKey.export({ format: "pem", type: "pkcs8" }),
  });
}

const { default: families } = await import("../api/families.js");
const { default: profileHandler } = await import("../api/profile.js");
const { createFamilySync } = await import("../src/familySync.js");

function reset() {
  resetDb();
  setRoutes([
    ["https://oauth2.googleapis.com/token", () => json(200, { access_token: "x", expires_in: 3600 })],
    ["https://", () => json(200, {})],
  ]);
}

const plus = (uid) => db.set(`user:${uid}:profile`, JSON.stringify({ isPlus: true, families: [] }));
const post = (uid, body) => invoke(families, { uid, body });

// Bir cihaz: kendi hesabıyla GET /api/families yapan sync + son görülen durum.
function device(uid) {
  const view = { last: null };
  const sync = createFamilySync({
    request: async (name) => {
      const r = await invoke(families, { method: "GET", uid, query: name ? { name } : {} });
      if (r.status !== 200) throw Object.assign(new Error("http"), { status: r.status });
      return r.body;
    },
    apply: (split) => (view.last = split),
    timers: { setInterval: () => 0, clearInterval: () => {} },
  });
  sync.setAccount(uid);
  return { sync, view };
}

async function setup() {
  reset();
  plus("A");
  plus("B");
  const created = await post("A", { action: "create", name: "Ev", memberName: "Ayşe" });
  assert.equal(created.status, 200);
  const fam = created.body;
  const joined = await post("B", { action: "join", code: fam.inviteCode, memberName: "Bora" });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  const a = device("A");
  const b = device("B");
  await a.sync.load({ name: "Ayşe" });
  await b.sync.load({ name: "Bora" });
  return { fam, a, b };
}

test("Canlı 1: üye çıkarılınca çıkarılan cihazda aile arka plan yenilemesiyle kalkar; diğer cihazda üye listesi ve yeni kod gelir", async () => {
  const { fam, a, b } = await setup();
  assert.deepEqual(b.view.last.families.map((f) => f.id), [fam.id]);
  const oldCode = a.view.last.families[0].inviteCode;

  const r = await post("A", { action: "remove", familyId: fam.id, memberUid: "B" });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  assert.equal((await b.sync.load({ background: true })).status, "applied");
  assert.deepEqual(b.view.last.families, []);
  assert.deepEqual(b.view.last.locked, []);
  assert.deepEqual(b.view.last.unverified, []);

  await a.sync.load({ background: true });
  const fa = a.view.last.families[0];
  assert.deepEqual(fa.members.map((m) => m.uid), ["A"]);
  assert.notEqual(fa.inviteCode, oldCode, "çıkarma kodu yeniler");
});

test("Canlı 2: sahiplik devri iki cihazda: aile reisi etiketi, yönetim yetkisi ve davet kodu birlikte", async () => {
  const { fam, a, b } = await setup();
  assert.equal(b.view.last.families[0].isOwner, false);

  const r = await post("A", { action: "transfer", familyId: fam.id, memberUid: "B" });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  await b.sync.load({ background: true });
  await a.sync.load({ background: true });
  const fb = b.view.last.families[0];
  const fa = a.view.last.families[0];
  assert.equal(fb.ownerUid, "B");
  assert.equal(fb.isOwner, true);
  assert.equal(fa.isOwner, false);
  assert.deepEqual(fb.members.filter((m) => m.isOwner).map((m) => m.uid), ["B"]);
  assert.deepEqual(fa.members.filter((m) => m.isOwner).map((m) => m.uid), ["B"]);
  assert.equal(fb.inviteCode, fa.inviteCode);

  // Yeni reis kodu yeniler; eski reis (artık üye) yeni kodu görür.
  const rot = await post("B", { action: "rotateCode", familyId: fam.id });
  assert.equal(rot.status, 200, JSON.stringify(rot.body));
  await a.sync.load({ background: true });
  assert.equal(a.view.last.families[0].inviteCode, rot.body.inviteCode);
  // Eski reisin yönetim isteği sunucuda reddedilir.
  const denied = await post("A", { action: "rotateCode", familyId: fam.id });
  assert.equal(denied.status, 403);
});

test("Canlı 3: Plus başka cihazda kapanınca aile kilitli görünür (kod gizli); açılınca geri gelir", async () => {
  const { fam, b } = await setup();
  const off = await invoke(profileHandler, { uid: "B", body: { isPlus: false } });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  await b.sync.load({ background: true });
  assert.equal(b.view.last.isPlus, false);
  assert.deepEqual(b.view.last.families, []);
  assert.deepEqual(b.view.last.locked.map((f) => f.id), [fam.id]);
  assert.equal(b.view.last.locked[0].inviteCode, null);

  const on = await invoke(profileHandler, { uid: "B", body: { isPlus: true } });
  assert.equal(on.status, 200);
  await b.sync.load({ background: true });
  assert.equal(b.view.last.isPlus, true);
  assert.deepEqual(b.view.last.families.map((f) => f.id), [fam.id]);
  assert.ok(b.view.last.families[0].inviteCode);
});

test("Canlı 4: arka plan yenilemesi sunucuda hiçbir şey yazmaz (yalnızca okuma)", async () => {
  const { b } = await setup();
  redisLog.length = 0;
  await b.sync.load({ background: true });
  await b.sync.load({ name: "Bora" }); // ad zaten senkron: yine yazım yok
  const writes = redisLog.filter((c) => ["SET", "DEL", "EVAL", "EVALSHA", "HSET", "INCR", "EXPIRE"].includes(String(c[0]).toUpperCase()));
  assert.deepEqual(writes, []);
  assert.ok(redisLog.length > 0);
});

test("Canlı 5: sunucu hatası son bilinen durumu silmez", async () => {
  const { a } = await setup();
  const before = a.view.last;
  const broken = createFamilySync({
    request: async () => {
      throw new Error("503");
    },
    apply: () => assert.fail("hata yanıtı uygulanmamalı"),
  });
  broken.setAccount("A");
  assert.equal((await broken.load({ background: true })).status, "error");
  assert.equal(a.view.last, before);
});
