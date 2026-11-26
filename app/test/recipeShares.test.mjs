// QR ile tarif paylaşımı: gerçek /api/recipe-shares + /api/data işleyicileri,
// gerçek istemci depo (src/syncedBuckets.js) ve kayıt yardımcıları
// (src/recipeShareClient.js, src/saveTargets.js) bellek içi Redis üzerinde.
// AI'a hiç gidilmez (sahte fetch tanımsız isteği düşürür).
import test from "node:test";
import assert from "node:assert/strict";
import { invoke, resetDb, db } from "./helpers/fakeServices.mjs";

const { default: shares } = await import("../api/recipe-shares.js");
const { default: dataHandler } = await import("../api/data.js");
const { createBucketStore, createDataTransport } = await import("../src/syncedBuckets.js");
const { buildImportedRecipe, addSharedRecipeOnce, existingImports } = await import("../src/recipeShareClient.js");
const { saveRecipeToTargets } = await import("../src/saveTargets.js");
const { deleteAccount } = await import("../api/_lib/accountDeletion.js");
const { shareKey } = await import("../api/_lib/recipeShares.js");
const { SHARE_TTL_SECONDS } = await import("../shared/recipeShare.js");

const RECIPE = {
  id: "1700000000000-abc123",
  title: "Mercimek Çorbası",
  category: "Çorbalar",
  categoryRef: { id: "corba1", uid: "A", by: "Ayşe", lang: "tr" },
  createdAt: 1700000000000,
  addedBy: "Ayşe",
  isFavorite: true,
  source: "share",
  link: "https://www.instagram.com/p/X1/",
  servings: 5,
  servings_basis: "hesap",
  servings_range: [4, 6],
  servings_calc: { v: 3, dish_type: "ana_yemek" },
  servings_note: "Tahmini",
  servings_unit: "adet",
  prep_time_minutes: 30,
  difficulty: "Kolay",
  ingredients: [
    { group: "Çorba", name: "kırmızı mercimek", amount: "1 su bardağı" },
    { group: "Sos", name: "tereyağı", amount: "1 yemek kaşığı", estimated: true },
  ],
  instructions: ["Haşla.", "Blenderdan geçir."],
  tips: ["Limonla servis et."],
  nutrition: { calories: 180, protein_g: 9 },
  assumptions: "Tuz göz kararı.",
  content_lang: "tr",
};

function seed({ ownerPlus = true, receiverPlus = false } = {}) {
  resetDb();
  db.set("user:A:profile", JSON.stringify({ isPlus: ownerPlus, families: ["F1"] }));
  db.set("user:A:recipes", JSON.stringify([RECIPE, { id: "1700000000001-keep01", title: "Diğer", category: "Tatlılar" }]));
  db.set("family:F1:meta", JSON.stringify({ name: "Ev", ownerUid: "A", inviteCode: "ABCDEF" }));
  db.set("family:F1:members", JSON.stringify({ A: { joinedAt: 1 } }));
  db.set("family:F1:recipes", JSON.stringify([{ ...RECIPE, id: `${RECIPE.id}-fam-F1`, title: "Aile Mercimeği" }]));
  db.set("user:B:profile", JSON.stringify({ isPlus: receiverPlus, families: [] }));
}

const create = (uid, body) => invoke(shares, { uid, body: { action: "create", ...body } });
const resolve = (uid, token, extra = {}) => invoke(shares, { method: "GET", uid, query: { token }, ...extra });

function storeFor(uid) {
  const request = async (method, { query, body }) => invoke(dataHandler, { method, uid, query: query || {}, body });
  return createBucketStore({ transport: createDataTransport(request) });
}

async function importAs(uid, token, { targets = ["personal"], title, idSeed = "1800000000000-zzz999" } = {}) {
  const r = await resolve(uid, token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const store = storeFor(uid);
  for (const t of targets) await store.load("recipes", t);
  const recipe = buildImportedRecipe(r.body.recipe, { shareId: r.body.shareId, id: idSeed, title, addedBy: "Bora", now: 1800000000000 });
  const result = await saveRecipeToTargets(recipe, targets, (scope, updater) => store.mutate("recipes", scope, updater), "personal", {
    addOnce: (rec) => addSharedRecipeOnce(rec, r.body.shareId),
  });
  return { resolved: r.body, recipe, result, store };
}

const listOf = (key) => JSON.parse(db.get(key) || "[]");

test("paylaşım oluşturma: tahmin edilmesi güç token, aynı tarif için aynı QR, AI yok", async () => {
  seed();
  const a = await create("A", { scope: "personal", recipeId: RECIPE.id });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.match(a.body.token, /^[A-Za-z0-9_-]{24}$/);
  assert.ok(a.body.expiresAt > Date.now() + (SHARE_TTL_SECONDS - 60) * 1000);
  const b = await create("A", { scope: "personal", recipeId: RECIPE.id });
  assert.equal(b.body.token, a.body.token, "aynı tarif için açık paylaşım yeniden kullanılır");
  assert.equal(b.body.reused, true);
  // Kayıt tarifi değil, yalnızca ona işaretçiyi tutar; token kaydın anahtarında.
  const record = JSON.parse(db.get(shareKey(a.body.token)));
  assert.equal(record.ownerUid, "A");
  assert.equal(record.recipeId, RECIPE.id);
  assert.equal(record.ingredients, undefined);
});

test("başkasının tarifi ya da olmayan tarif paylaşılamaz", async () => {
  seed();
  const r1 = await create("B", { scope: "personal", recipeId: RECIPE.id });
  assert.equal(r1.status, 404);
  const r2 = await create("B", { scope: "family", familyId: "F1", recipeId: `${RECIPE.id}-fam-F1` });
  assert.equal(r2.status, 403, "üye olmayan aile tarifini paylaşamaz");
  const r3 = await create("A", { scope: "nope", recipeId: RECIPE.id });
  assert.equal(r3.status, 400);
});

test("alıcı içeriği eksiksiz alır; gönderenin kimliği, favorisi, özel kategorisi gelmez", async () => {
  seed();
  const { body } = await create("A", { scope: "personal", recipeId: RECIPE.id });
  const r = await resolve("B", body.token);
  assert.equal(r.status, 200);
  const got = r.body.recipe;
  for (const key of ["title", "ingredients", "instructions", "tips", "servings", "servings_basis", "servings_range", "servings_calc", "servings_note", "servings_unit", "prep_time_minutes", "difficulty", "nutrition", "assumptions", "content_lang", "link"]) {
    assert.deepEqual(got[key], RECIPE[key], key);
  }
  assert.equal(got.ingredients[1].estimated, true, "tahmini miktar işareti korunur");
  assert.equal(got.ingredients[0].group, "Çorba", "bölümler korunur");
  for (const key of ["id", "createdAt", "addedBy", "isFavorite", "categoryRef", "category", "source"]) {
    assert.equal(got[key], undefined, `${key} gönderilmemeli`);
  }
  assert.equal(r.body.own, false);
  assert.ok(!JSON.stringify(r.body).includes('"A"'), "sahibin uid'i yanıtta yok");
  // Sabit kategori taşınır.
  db.set("user:A:recipes", JSON.stringify([{ ...RECIPE, category: "Tatlılar", categoryRef: undefined }]));
  const r2 = await resolve("B", body.token);
  assert.equal(r2.body.recipe.category, "Tatlılar");
});

test("alıcının kaydı bağımsız; aynı QR tekrar okutulunca kopya birikmez", async () => {
  seed();
  const { body } = await create("A", { scope: "personal", recipeId: RECIPE.id });
  const first = await importAs("B", body.token, { title: "Annemin Mercimeği" });
  assert.deepEqual(first.result.saved, ["personal"]);
  let mine = listOf("user:B:recipes");
  assert.equal(mine.length, 1);
  assert.equal(mine[0].title, "Annemin Mercimeği");
  assert.equal(mine[0].addedBy, "Bora");
  assert.equal(mine[0].isFavorite, false);
  assert.equal(mine[0].shared_from.shareId, first.resolved.shareId);
  assert.notEqual(mine[0].id, RECIPE.id, "alıcıya yeni kimlik");
  assert.ok(!JSON.stringify(mine).includes(body.token), "token alıcının kaydına yazılmaz");

  // Aynı QR ikinci kez (yeni kimlik üretilse bile) → değişiklik yok.
  const second = await importAs("B", body.token, { idSeed: "1800000000001-yyy888" });
  assert.deepEqual(second.result.saved, ["personal"]);
  mine = listOf("user:B:recipes");
  assert.equal(mine.length, 1);
  assert.deepEqual(existingImports({ personal: mine }, ["personal"], first.resolved.shareId), { personal: mine[0].id });

  // Gönderen tarifini değiştirir/siler: alıcının kaydı aynı kalır.
  db.set("user:A:recipes", JSON.stringify([{ ...RECIPE, ingredients: [], title: "Değişti" }]));
  db.set("user:A:recipes", JSON.stringify([]));
  assert.equal(listOf("user:B:recipes")[0].ingredients.length, 2);
});

test("durdurma, silinen tarif, süre dolması ve hesap silme paylaşımı geçersiz kılar", async () => {
  seed();
  const { body } = await create("A", { scope: "personal", recipeId: RECIPE.id });
  const revoke = await invoke(shares, { uid: "A", body: { action: "revoke", scope: "personal", recipeId: RECIPE.id } });
  assert.equal(revoke.body.revoked, true);
  const r1 = await resolve("B", body.token);
  assert.equal(r1.status, 404);
  assert.equal(r1.body.code, "share_unavailable");

  const again = await create("A", { scope: "personal", recipeId: RECIPE.id });
  assert.notEqual(again.body.token, body.token, "durdurulan paylaşım yeniden açılırsa yeni kod");
  db.set("user:A:recipes", JSON.stringify([]));
  assert.equal((await resolve("B", again.body.token)).status, 404, "silinen tarif");

  seed();
  const c = await create("A", { scope: "personal", recipeId: RECIPE.id });
  const rec = JSON.parse(db.get(shareKey(c.body.token)));
  db.set(shareKey(c.body.token), JSON.stringify({ ...rec, expiresAt: Date.now() - 1 }));
  assert.equal((await resolve("B", c.body.token)).status, 404, "süresi dolmuş");

  seed();
  const d = await create("A", { scope: "personal", recipeId: RECIPE.id });
  db.set("deleted-account:A", String(Date.now()));
  assert.equal((await resolve("B", d.body.token)).status, 404, "silinmiş hesap");
});

test("hesap silme sahibin paylaşım kayıtlarını da temizler", async () => {
  seed();
  const { body } = await create("A", { scope: "personal", recipeId: RECIPE.id });
  assert.ok(db.has(shareKey(body.token)));
  // Firebase silme çağrısı sahte ortamda yok; yalnızca Redis temizliğini sına.
  await deleteAccount("A").catch(() => {});
  assert.equal(db.has(shareKey(body.token)), false);
  assert.equal(db.has("user:A:recipe-shares"), false);
});

test("Plus kilidi paylaşımla aşılamaz", async () => {
  // Free sahibin 16. (en yeni) tarifi kilitli: paylaşım açılamaz.
  resetDb();
  const many = Array.from({ length: 16 }, (_, i) => ({ id: `${1700000000000 + i}-r${i}`, title: `T${i}`, createdAt: 1700000000000 + i, ingredients: [], instructions: [] }));
  db.set("user:A:profile", JSON.stringify({ isPlus: false, families: [] }));
  db.set("user:A:recipes", JSON.stringify(many));
  const locked = await create("A", { scope: "personal", recipeId: many[15].id });
  assert.equal(locked.status, 403);
  assert.equal(locked.body.code, "recipe_locked");
  assert.equal((await create("A", { scope: "personal", recipeId: many[0].id })).status, 200, "açık tarif paylaşılır");

  // Plus'lıyken paylaşılan yeni tarif, Plus kapanınca kilitlenir → paylaşım da kapanır.
  db.set("user:A:profile", JSON.stringify({ isPlus: true, families: [] }));
  const ok = await create("A", { scope: "personal", recipeId: many[15].id });
  assert.equal(ok.status, 200);
  db.set("user:A:profile", JSON.stringify({ isPlus: false, families: [] }));
  assert.equal((await resolve("B", ok.body.token)).status, 404);
});

test("alıcının Free sınırı paylaşımla aşılamaz (kayıt normal /api/data yolundan)", async () => {
  seed();
  const full = Array.from({ length: 15 }, (_, i) => ({ id: `${1700000000000 + i}-b${i}`, title: `B${i}`, createdAt: 1700000000000 + i }));
  db.set("user:B:recipes", JSON.stringify(full));
  const { body } = await create("A", { scope: "personal", recipeId: RECIPE.id });
  const out = await importAs("B", body.token);
  assert.deepEqual(out.result.saved, []);
  assert.equal(out.result.failed[0].error.code, "free_recipe_limit");
  assert.equal(listOf("user:B:recipes").length, 15);
});

test("aile tarifi: üyelik paylaşımla verilmez; sahip aileden çıkınca paylaşım kapanır", async () => {
  seed();
  const famId = `${RECIPE.id}-fam-F1`;
  const { status, body } = await create("A", { scope: "family", familyId: "F1", recipeId: famId });
  assert.equal(status, 200);
  const r = await resolve("B", body.token);
  assert.equal(r.status, 200);
  assert.equal(r.body.recipe.title, "Aile Mercimeği");
  // Alıcı aileye yazamaz (üye değil, Plus değil): kişisel listeye düşmez.
  const out = await importAs("B", body.token, { targets: ["F1"] }).catch((e) => ({ error: e }));
  const famList = listOf("family:F1:recipes");
  assert.equal(famList.length, 1, "aile listesine yabancı yazamaz");
  assert.ok(out.error || out.result.failed.length === 1);
  assert.equal(listOf("user:B:recipes").length, 0);

  // Sahip aileden çıkarıldı → paylaşım geçersiz.
  db.set("family:F1:members", JSON.stringify({ C: { joinedAt: 1 } }));
  assert.equal((await resolve("B", body.token)).status, 404);
  // Sahip Plus'ı kapattı → aile içeriği kilitli → geçersiz.
  seed({ ownerPlus: true });
  const again = await create("A", { scope: "family", familyId: "F1", recipeId: famId });
  db.set("user:A:profile", JSON.stringify({ isPlus: false, families: ["F1"] }));
  assert.equal((await resolve("B", again.body.token)).status, 404);
});

test("geçersiz token, oturumsuz istek, kendi QR'ı ve okuma hız sınırı", async () => {
  seed();
  assert.equal((await resolve("B", "kisa")).status, 404);
  assert.equal((await resolve("B", "x".repeat(24))).status, 404);
  const { body } = await create("A", { scope: "personal", recipeId: RECIPE.id });
  assert.equal((await resolve("B", body.token, { token: null })).status, 401);
  const own = await resolve("A", body.token);
  assert.equal(own.status, 200);
  assert.equal(own.body.own, true);
  let last;
  for (let i = 0; i < 31; i++) last = await resolve("B", body.token);
  assert.equal(last.status, 429);
});

test("paylaşım durumu yalnızca sahibine görünür", async () => {
  seed();
  const none = await invoke(shares, { method: "GET", uid: "A", query: { status: "1", scope: "personal", recipeId: RECIPE.id } });
  assert.equal(none.body.active, false);
  const { body } = await create("A", { scope: "personal", recipeId: RECIPE.id });
  const st = await invoke(shares, { method: "GET", uid: "A", query: { status: "1", scope: "personal", recipeId: RECIPE.id } });
  assert.equal(st.body.active, true);
  assert.equal(st.body.token, body.token);
  const other = await invoke(shares, { method: "GET", uid: "B", query: { status: "1", scope: "personal", recipeId: RECIPE.id } });
  assert.equal(other.body.active, false);
});
