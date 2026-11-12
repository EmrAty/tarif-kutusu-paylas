// Grup 3 — legacy/paylaşımlı verinin yanlış hesaba açılma riski ve aile kapsamı.
// Eski sürümde /api/legacy, UID içermeyen global "recipes"/"shopping-list"/
// "pantry-items" anahtarlarını giriş yapmış HERKESE (anonim misafir dahil)
// veriyordu; istemci de bunu kişisel listeye ya da aileye aktarabiliyordu.
import test from "node:test";
import assert from "node:assert/strict";
import { setRoutes, invoke, resetDb, json, db, calls } from "./helpers/fakeServices.mjs";

const { default: legacy, sanitizeLegacyValue } = await import("../api/legacy.js");
const { default: dataHandler } = await import("../api/data.js");
const { default: notify } = await import("../api/notify.js");
const { default: translate } = await import("../api/translate-recipe.js");
const { assertFamilyAccess, verifiedFamilyIds } = await import("../api/_lib/families.js");
const { listBackups, versionKey } = await import("../api/_lib/versionedBucket.js");

const OWNER = "legacyOwner01";
const GLOBAL_RECIPES = [
  { id: "g1", title: "Eski Ortak Tarif 1" },
  { id: "g2", title: "Eski Ortak Tarif 2" },
];

function reset({ owners = OWNER } = {}) {
  resetDb();
  setRoutes([["https://api.anthropic.com/", () => json(500, { error: { message: "çağrılmamalı" } })]]);
  if (owners == null) delete process.env.LEGACY_DATA_OWNER_UIDS;
  else process.env.LEGACY_DATA_OWNER_UIDS = owners;
  db.set("recipes", JSON.stringify(GLOBAL_RECIPES));
  db.set("shopping-list", JSON.stringify({ items: ["süt"] }));
  db.set("pantry-items", JSON.stringify(["un"]));
}

const getData = (uid, query, opts = {}) => invoke(dataHandler, { method: "GET", uid, query, ...opts });
const postData = (uid, body) => invoke(dataHandler, { method: "POST", uid, body });

function seedFamily() {
  db.set("user:M1:profile", JSON.stringify({ isPlus: true, families: ["F1"] }));
  db.set("user:M2:profile", JSON.stringify({ isPlus: false, families: ["F1"] }));
  db.set("user:X:profile", JSON.stringify({ isPlus: true, families: [] }));
  db.set("family:F1:meta", JSON.stringify({ name: "Ev", ownerUid: "M1", inviteCode: "ABCDEF" }));
  db.set("family:F1:members", JSON.stringify({ M1: { joinedAt: 1 }, M2: { joinedAt: 2 } }));
  db.set("family:F1:recipes", JSON.stringify([{ id: "f1", title: "Aile Tarifi" }]));
}

// ---------------------------------------------------------------------------

test("Legacy 1: User A, User B'nin kişisel verisini okuyamaz (uid yalnızca token'dan)", async () => {
  reset();
  db.set("user:B:recipes", JSON.stringify([{ id: "b1", title: "B'nin tarifi" }]));
  db.set("user:A:recipes", JSON.stringify([{ id: "a1", title: "A'nın tarifi" }]));
  const r = await getData("A", { bucket: "recipes", scope: "personal", uid: "B", familyId: "B" });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body.value).map((x) => x.id), ["a1"]);
  // Yazım da yalnızca kendi kovasına gider.
  const w = await postData("A", { bucket: "recipes", scope: "personal", uid: "B", value: "[]", baseVersion: 1 });
  assert.equal(w.status, 200);
  assert.deepEqual(JSON.parse(db.get("user:B:recipes")).map((x) => x.id), ["b1"]);
});

test("Legacy 2: UID'siz global anahtar boş kişisel kovaya otomatik verilmez (fallback yok)", async () => {
  reset();
  const r = await getData("NEWUSER", { bucket: "recipes", scope: "personal" });
  assert.equal(r.status, 200);
  assert.equal(r.body.value, null);
  assert.equal(r.body.version, 0);
  const s = await getData("NEWUSER", { bucket: "shopping-list", scope: "personal" });
  assert.equal(s.body.value, null);
});

test("Legacy 3: giriş yapmış ama sahibi olmayan hesap (gerçek ya da anonim) eski veriyi göremez", async () => {
  reset();
  const other = await invoke(legacy, { method: "GET", uid: "someoneElse" });
  assert.equal(other.status, 403);
  assert.equal(other.body.code, "legacy_not_eligible");
  assert.equal(other.body.recipes, undefined);
  // Sahip uid'si anonim token'la gelirse de reddedilir.
  const anon = await invoke(legacy, { method: "GET", uid: OWNER, anonymous: true });
  assert.equal(anon.status, 403);
});

test("Legacy 4: sahiplik belirsizse (izinli uid tanımlı değil) hiç kimseye açılmaz", async () => {
  reset({ owners: null });
  const r = await invoke(legacy, { method: "GET", uid: OWNER });
  assert.equal(r.status, 403);
  reset({ owners: " , ,bad uid!" });
  assert.equal((await invoke(legacy, { method: "GET", uid: OWNER })).status, 403);
  // Global veri hiçbir durumda silinmedi.
  assert.deepEqual(JSON.parse(db.get("recipes")), GLOBAL_RECIPES);
});

test("Legacy 5: sahipliği doğrulanmış aktarım yalnızca o hesaba, boş kovaya; global veri yerinde kalır; sürüm/yedek çalışır", async () => {
  reset();
  const r = await invoke(legacy, { method: "GET", uid: OWNER });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body.recipes), GLOBAL_RECIPES);
  // İstemcinin yaptığı gibi: boş hedefe baseVersion 0 ile yazım.
  const w = await postData(OWNER, { bucket: "recipes", scope: "personal", value: r.body.recipes, baseVersion: 0 });
  assert.equal(w.status, 200, JSON.stringify(w.body));
  assert.equal(db.get(versionKey(`user:${OWNER}:recipes`)), "1");
  assert.deepEqual(JSON.parse(db.get("recipes")), GLOBAL_RECIPES, "global anahtar silinmedi");
  assert.equal(db.has("user:someoneElse:recipes"), false);

  // Grup 1: sonraki yazım önceki hâli yedekler.
  const next = JSON.stringify([...GLOBAL_RECIPES, { id: "n1", title: "Yeni" }]);
  const w2 = await postData(OWNER, { bucket: "recipes", scope: "personal", value: next, baseVersion: 1 });
  assert.equal(w2.status, 200);
  const backups = await listBackups(`user:${OWNER}:recipes`);
  assert.ok(backups.recent.some((b) => b.version === 1 && JSON.parse(b.raw).length === 2), JSON.stringify(backups));
});

test("Legacy 6: yeni kişisel veri, eski veri aktarımıyla ezilmez (sürüm çakışması)", async () => {
  reset();
  db.set(`user:${OWNER}:recipes`, JSON.stringify([{ id: "mine", title: "Benim" }]));
  const r = await invoke(legacy, { method: "GET", uid: OWNER });
  const w = await postData(OWNER, { bucket: "recipes", scope: "personal", value: r.body.recipes, baseVersion: 0 });
  assert.equal(w.status, 409);
  assert.equal(w.body.code, "version_conflict");
  assert.deepEqual(JSON.parse(db.get(`user:${OWNER}:recipes`)).map((x) => x.id), ["mine"]);
});

test("Legacy 7: bozuk/kısmi eski veri reddedilir (null), kısmen aktarılmaz", async () => {
  reset();
  db.set("recipes", "{bozuk json");
  db.set("shopping-list", JSON.stringify(["dizi ama nesne olmalı"]));
  db.set("pantry-items", JSON.stringify([]));
  const r = await invoke(legacy, { method: "GET", uid: OWNER });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { recipes: null, shoppingList: null, pantryItems: null });

  assert.equal(sanitizeLegacyValue("recipes", JSON.stringify([{ id: "ok" }, { title: "id yok" }])), null, "id'siz tarif içeren liste reddedilir");
  assert.equal(sanitizeLegacyValue("recipes", JSON.stringify([{ id: "ok" }, "metin"])), null);
  assert.equal(sanitizeLegacyValue("recipes", JSON.stringify({ id: "x" })), null);
  assert.equal(sanitizeLegacyValue("shopping-list", JSON.stringify({})), null);
  assert.ok(sanitizeLegacyValue("recipes", JSON.stringify([{ id: "ok" }])));
});

test("Legacy 8: aile üyesi yalnız üyesi olduğu aileyi okur; üye olmayan erişemez", async () => {
  reset();
  seedFamily();
  const m2 = await getData("M2", { bucket: "recipes", scope: "family", familyId: "F1" });
  assert.equal(m2.status, 200, "Plus olmayan üye de ailesini okuyabilir (mevcut davranış)");
  assert.deepEqual(JSON.parse(m2.body.value).map((x) => x.id), ["f1"]);

  const x = await getData("X", { bucket: "recipes", scope: "family", familyId: "F1" });
  assert.equal(x.status, 403);
  const xw = await postData("X", { bucket: "recipes", scope: "family", familyId: "F1", value: "[]", baseVersion: 1 });
  assert.equal(xw.status, 403);
  assert.deepEqual(JSON.parse(db.get("family:F1:recipes")).map((r) => r.id), ["f1"]);
});

test("Legacy 9: üyelik gerçekten doğrulanır — profil tek başına yetmez, üye listesi tek başına yetmez, silinmiş aile 404", async () => {
  reset();
  seedFamily();
  // Profil aileyi listeliyor ama üye listesinde yok (çıkarılmış / tutarsız kayıt).
  db.set("user:GHOST:profile", JSON.stringify({ isPlus: true, families: ["F1"] }));
  assert.equal((await getData("GHOST", { bucket: "recipes", scope: "family", familyId: "F1" })).status, 403);
  // Üye listesinde var ama profili aileyi listelemiyor.
  db.set("family:F1:members", JSON.stringify({ M1: { joinedAt: 1 }, M2: { joinedAt: 2 }, LIST: { joinedAt: 3 } }));
  db.set("user:LIST:profile", JSON.stringify({ isPlus: true, families: [] }));
  assert.equal((await getData("LIST", { bucket: "recipes", scope: "family", familyId: "F1" })).status, 403);
  // Aile kaydı (meta) silinmiş: eski veri anahtarı dursa bile okunmaz.
  db.delete("family:F1:meta");
  assert.equal((await getData("M1", { bucket: "recipes", scope: "family", familyId: "F1" })).status, 404);
  // Geçersiz aile kimliği.
  assert.equal((await getData("M1", { bucket: "recipes", scope: "family", familyId: "../x" })).status, 400);

  db.set("family:F1:meta", JSON.stringify({ name: "Ev", ownerUid: "M1", inviteCode: "ABCDEF" }));
  assert.deepEqual(await verifiedFamilyIds("M1"), ["F1"]);
  assert.deepEqual(await verifiedFamilyIds("GHOST"), []);
  await assert.rejects(assertFamilyAccess("X", "F1"), (e) => e.status === 403);
});

test("Legacy 10: misafir/hesap geçişi başka kullanıcının verisini çekemez (aile ve eski veri yolu)", async () => {
  reset();
  seedFamily();
  // Anonim misafir, başka bir ailenin kimliğini bilse bile okuyamaz.
  const anon = await getData("GUEST1", { bucket: "recipes", scope: "family", familyId: "F1" }, { anonymous: true });
  assert.equal(anon.status, 403);
  // Misafir eski global veriyi de çekemez.
  assert.equal((await invoke(legacy, { method: "GET", uid: "GUEST1", anonymous: true })).status, 403);
  // Kendi kişisel kovası boş: başkasının verisi gelmez.
  const own = await getData("GUEST1", { bucket: "recipes", scope: "personal" }, { anonymous: true });
  assert.equal(own.body.value, null);
});

test("Legacy 11: aile bildirimi ve çeviri de gerçek üyelik ister (Anthropic'e gidilmeden)", async () => {
  reset();
  seedFamily();
  const n = await invoke(notify, { uid: "X", body: { familyId: "F1", recipeTitle: "Menemen" } });
  assert.equal(n.status, 403);
  db.set("user:GHOST:profile", JSON.stringify({ isPlus: true, families: ["F1"] }));
  const n2 = await invoke(notify, { uid: "GHOST", body: { familyId: "F1", recipeTitle: "Menemen" } });
  assert.equal(n2.status, 403);

  const t = await invoke(translate, { uid: "GHOST", body: { recipeId: "f1", scope: "F1", target: "en" } });
  assert.equal(t.status, 403);
  // Başlık listesi: doğrulanamayan aile sessizce dışarıda kalır (aile tarifi Claude'a gitmez).
  const titles = await invoke(translate, { uid: "GHOST", body: { mode: "titles", target: "en" } });
  assert.equal(titles.status, 200, JSON.stringify(titles.body));
  assert.equal(calls.filter((c) => c.url.startsWith("https://api.anthropic.com/")).length, 0);
});
