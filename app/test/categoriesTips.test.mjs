// Özel kategoriler (profil + paylaşım job'u) ve püf noktaları (çıkarma şeması, kayıt,
// çeviri). Bellek içi Redis + sahte Anthropic/Google; dış ağ yok.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { setRoutes, invoke, resetDb, json, db, calls, waitFor, drainBackground } from "./helpers/fakeServices.mjs";

process.env.RECIPE_JOB_NOTIFY_MIN_DELAY_MS = "0";
process.env.ANTHROPIC_API_KEY = "test-key";
{
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.FIREBASE_SERVICE_ACCOUNT_KEY = JSON.stringify({
    client_email: "test@tarif-kutusu.test",
    project_id: "tarif-kutusu",
    private_key: privateKey.export({ format: "pem", type: "pkcs8" }),
  });
}

const { default: profileHandler } = await import("../api/profile.js");
const { default: recipeJobs } = await import("../api/recipe-jobs.js");
const { default: translateHandler } = await import("../api/translate-recipe.js");
const { extractRecipeFromCaption } = await import("../api/_lib/extractRecipe.js");
const { RECIPE_SYSTEM_PROMPT } = await import("../shared/recipeExtraction.js");
const { translationPayload } = await import("../shared/recipeLocales.js");
const { validateTranslation } = await import("../api/translate-recipe.js");
const { localizeRecipe, contentFingerprint } = await import("../src/recipeLocale.js");

const ANTHROPIC = "https://api.anthropic.com/v1/messages";
const read = (key) => (db.has(key) ? JSON.parse(db.get(key)) : undefined);

let extracted;
let requests = [];
function routes() {
  requests = [];
  setRoutes([
    [
      ANTHROPIC,
      (url, init) => {
        requests.push(JSON.parse(init.body));
        return json(200, { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(extracted) }], usage: { output_tokens: 10 } });
      },
    ],
    ["https://oauth2.googleapis.com/token", () => json(200, { access_token: "fcm-access", expires_in: 3600 })],
    ["https://fcm.googleapis.com/v1/projects/tarif-kutusu/messages:send", () => json(200, { name: "projects/x/messages/1" })],
  ]);
}

const BASE = {
  title: "Kek",
  servings: 8,
  servings_unit: "dilim",
  suggested_servings: null,
  prep_time_minutes: 50,
  difficulty: "Kolay",
  ingredients: [{ name: "Un", amount: "2 su bardağı", group: "", estimated: false }],
  instructions: ["Karıştır.", "180 derecede 35 dakika pişir."],
  nutrition: { calories: 2000, protein_g: 30, carbs_g: 300, fat_g: 80 },
  assumptions: "",
  portion: { dish_type: "tatli_kek", cooking_method: "firin", items: [] },
};

function reset() {
  resetDb();
  routes();
  db.set("user:A:profile", JSON.stringify({ isPlus: false, families: [] }));
  db.set("user:A:recipes", JSON.stringify([]));
  extracted = { ...BASE, tips: ["  Fırını önceden ısıtın.  ", "", "Fırını önceden ısıtın.", "Kek 2 gün taze kalır."] };
}

// ---- Özel kategoriler: profil ----

test("kategori ekle/kaldır: kimlik sunucuda üretilir, ad olduğu gibi, dil saklanır; aynı ad ikinci kez eklenmez", async () => {
  reset();
  let r = await invoke(profileHandler, { uid: "A", body: { action: "addCategory", name: "  Çorbalar  ", lang: "tr" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const soups = r.body.created;
  assert.match(soups.id, /^c[0-9a-f]{16}$/);
  assert.deepEqual(r.body.categories, [{ id: soups.id, name: "Çorbalar", lang: "tr" }]);
  r = await invoke(profileHandler, { uid: "A", body: { action: "addCategory", name: "ÇORBALAR" } });
  assert.equal(r.status, 200);
  assert.equal(r.body.created.id, soups.id, "aynı ad: mevcut kategori döner, yenisi açılmaz");
  assert.equal(r.body.categories.length, 1);
  r = await invoke(profileHandler, { uid: "A", body: { action: "addCategory", name: "Meal Prep", lang: "en" } });
  const prep = r.body.created;
  const profile = read("user:A:profile");
  assert.deepEqual(profile.categories, [{ id: soups.id, name: "Çorbalar", lang: "tr" }, { id: prep.id, name: "Meal Prep", lang: "en" }]);
  assert.equal(profile.isPlus, false, "diğer profil alanları korunur");

  r = await invoke(profileHandler, { method: "GET", uid: "A" });
  assert.deepEqual(r.body.categories.map((c) => c.name), ["Çorbalar", "Meal Prep"]);

  r = await invoke(profileHandler, { uid: "A", body: { action: "removeCategory", id: soups.id } });
  assert.deepEqual(r.body.categories.map((c) => c.id), [prep.id]);
  r = await invoke(profileHandler, { uid: "A", body: { action: "removeCategory", id: soups.id } });
  assert.equal(r.status, 200, "tekrar kaldırma hata vermez");
  // Başka hesabın profili etkilenmez.
  r = await invoke(profileHandler, { method: "GET", uid: "B" });
  assert.deepEqual(r.body.categories, []);
});

test("d2254df profili (düz metin kategoriler) okunurken kimlik kazanır, veri yeniden yazılmaz", async () => {
  reset();
  db.set("user:A:profile", JSON.stringify({ isPlus: false, families: [], categories: ["Çorbalar"] }));
  const r = await invoke(profileHandler, { method: "GET", uid: "A" });
  assert.equal(r.body.categories[0].name, "Çorbalar");
  assert.match(r.body.categories[0].id, /^l[0-9a-z]{7}$/);
  assert.deepEqual(read("user:A:profile").categories, ["Çorbalar"]);
});

function familyWith(recipes) {
  db.set("user:A:profile", JSON.stringify({ isPlus: true, families: ["F1"] }));
  db.set("user:B:profile", JSON.stringify({ isPlus: true, families: ["F1"] }));
  db.set("user:C:profile", JSON.stringify({ isPlus: true, families: [] }));
  db.set("family:F1:meta", JSON.stringify({ name: "Ev", ownerUid: "A", inviteCode: "ABCDEFGHJK" }));
  db.set("family:F1:members", JSON.stringify({ A: { joinedAt: 1, name: "Emre" }, B: { joinedAt: 2, name: "Ayşe" } }));
  db.set("family:F1:recipes", JSON.stringify(recipes));
}
const EMRE_SOUPS = { id: "c00000000000000a1", uid: "A", by: "Emre", lang: "tr" };

test("aile kategorileri: üyenin aile tariflerinde kullandığı kategori diğer üyeye döner; aileyle paylaşılmayan dönmez", async () => {
  reset();
  familyWith([
    { id: "r1-fam-F1", title: "Ezogelin", category: "Çorbalar", categoryRef: EMRE_SOUPS },
    { id: "r2-fam-F1", title: "Menemen", category: "Kahvaltı" },
  ]);
  const prof = JSON.parse(db.get("user:A:profile"));
  db.set("user:A:profile", JSON.stringify({ ...prof, categories: [{ id: "c00000000000000a1", name: "Çorbalar", lang: "tr" }, { id: "c00000000000000a2", name: "Gizli", lang: "tr" }] }));
  let r = await invoke(profileHandler, { method: "GET", uid: "B", query: { familyCategories: "1" } });
  assert.deepEqual(r.body.familyCategories, [{ familyId: "F1", name: "Çorbalar", ref: EMRE_SOUPS }]);
  assert.ok(!JSON.stringify(r.body).includes("Gizli"), "aileyle paylaşılmamış kategori başka hesaba açılmaz");
  // Sahibin kendisine kendi kategorisi "aile kategorisi" olarak dönmez.
  r = await invoke(profileHandler, { method: "GET", uid: "A", query: { familyCategories: "1" } });
  assert.deepEqual(r.body.familyCategories, []);
  // Üye olmayan hesaba hiçbir şey dönmez.
  r = await invoke(profileHandler, { method: "GET", uid: "C", query: { familyCategories: "1" } });
  assert.deepEqual(r.body.familyCategories, []);
  // Sahip aileden ayrıldıktan sonra da aile tariflerindeki kategori seçenek olarak kalır.
  db.set("family:F1:members", JSON.stringify({ B: { joinedAt: 2, name: "Ayşe" } }));
  r = await invoke(profileHandler, { method: "GET", uid: "B", query: { familyCategories: "1" } });
  assert.deepEqual(r.body.familyCategories.map((c) => c.ref.by), ["Emre"]);
});

test("kategori çevirisi: yalnızca farklı dildeki özel adlar, tek AI çağrısı, sonra önbellek; kişi adı gönderilmez", async () => {
  reset();
  familyWith([{ id: "r1-fam-F1", title: "Ezogelin", category: "Çorbalar", categoryRef: EMRE_SOUPS }]);
  db.set("user:B:profile", JSON.stringify({ isPlus: true, families: ["F1"], categories: [{ id: "c00000000000000b1", name: "Meal Prep", lang: "en" }] }));
  extracted = { titles: ["Soups"] };
  let r = await invoke(translateHandler, { uid: "B", body: { mode: "categories", target: "en" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.categories, { "tr\nÇorbalar": "Soups" });
  assert.equal(requests.length, 1);
  const sent = JSON.stringify(requests[0].messages);
  assert.ok(sent.includes("Çorbalar") && !sent.includes("Meal Prep") && !sent.includes("Emre"));
  r = await invoke(translateHandler, { uid: "B", body: { mode: "categories", target: "en" } });
  assert.deepEqual(r.body.categories, { "tr\nÇorbalar": "Soups" });
  assert.equal(requests.length, 1, "ikinci istek önbellekten");
  // Türkçe arayüzde yalnızca İngilizce adlı kategori çevrilir.
  extracted = { titles: ["Haftalık Hazırlık"] };
  r = await invoke(translateHandler, { uid: "B", body: { mode: "categories", target: "tr" } });
  assert.deepEqual(r.body.categories, { "en\nMeal Prep": "Haftalık Hazırlık" });
  // Kayıtlar değişmedi.
  assert.equal(read("family:F1:recipes")[0].category, "Çorbalar");
});

test("kategori: hazır adlarla (iki dilde), Diğer ve boş adla çakışan istek 400 + kod", async () => {
  reset();
  for (const [name, code] of [
    ["Tatlılar", "category_reserved"],
    ["desserts", "category_reserved"],
    ["Diğer", "category_reserved"],
    ["   ", "category_empty"],
    ["x".repeat(41), "category_too_long"],
  ]) {
    const r = await invoke(profileHandler, { uid: "A", body: { action: "addCategory", name } });
    assert.equal(r.status, 400, name);
    assert.equal(r.body.code, code, name);
  }
  assert.equal(read("user:A:profile").categories, undefined);
});

test("Plus bayrağı yolu değişmedi", async () => {
  reset();
  const r = await invoke(profileHandler, { uid: "A", body: { isPlus: true } });
  assert.equal(r.status, 200);
  assert.equal(read("user:A:profile").isPlus, true);
});

// ---- Paylaşım job'u: özel kategori + püf noktaları ----

let n = 0;
async function runJob(extra) {
  const r = await invoke(recipeJobs, {
    uid: "A",
    body: { requestId: `ct-${++n}-abcdef`, sourceUrl: `https://www.instagram.com/p/CT${n}/`, caption: "2 su bardağı un, 180 derecede 35 dakika. Püf noktası: fırını önceden ısıtın.", category: "Kahvaltı", language: "tr", ...extra },
  });
  if (r.status !== 200) return r;
  await drainBackground();
  return waitFor(() => {
    const j = read(`job:A:${r.body.jobId}`);
    return (j?.status === "completed" || j?.status === "failed") && j.notify && j;
  }, { message: "job bitmeli" });
}

test("paylaşım job'u özel kategoriyi kabul eder; tarif kaynağın püf noktalarıyla (temiz) kaydedilir", async () => {
  reset();
  const ref = { id: "c00000000000000c1", uid: "A", by: "Emre", lang: "tr", junk: "<x>" };
  const job = await runJob({ category: "Kek & Kurabiye", categoryRef: ref });
  assert.equal(job.status, "completed");
  const [saved] = read("user:A:recipes");
  assert.equal(saved.category, "Kek & Kurabiye");
  assert.deepEqual(saved.categoryRef, { id: "c00000000000000c1", uid: "A", by: "Emre", lang: "tr" }, "bağ temizlenerek yazılır");
  assert.deepEqual(saved.tips, ["Fırını önceden ısıtın.", "Kek 2 gün taze kalır."]);
  assert.equal(calls.filter((c) => c.url === ANTHROPIC).length, 1, "püf noktaları için ek AI çağrısı yok");
});

test("paylaşım job'u: hazır adla çakışan ya da temizlenmemiş kategori 400 (AI'a gidilmez)", async () => {
  reset();
  for (const category of ["Breakfast", " Çorbalar", "", "x".repeat(41)]) {
    const r = await runJob({ category });
    assert.equal(r.status, 400, category);
  }
  assert.equal(requests.length, 0);
});

// ---- Çıkarma şeması ----

test("çıkarma: şema ve prompt tips alanını içerir; kaynakta yoksa alan kayda yazılmaz", async () => {
  reset();
  extracted = { ...BASE, tips: [] };
  const { recipe } = await extractRecipeFromCaption({ link: "", caption: "un", timeoutMs: 5000 });
  assert.equal("tips" in recipe, false);
  const schema = requests[0].output_config.format.schema;
  assert.deepEqual(schema.properties.tips, { type: "array", items: { type: "string" } });
  assert.ok(schema.required.includes("tips"));
  assert.match(RECIPE_SYSTEM_PROMPT, /PÜF NOKTALARI \("tips"\)/);
  assert.match(RECIPE_SYSTEM_PROMPT, /"tips" alanına asla/);
});

// ---- Çeviri ----

test("çeviri: püf noktası olmayan tarifin çeviri isteği ve parmak izi değişmez", () => {
  const old = { id: "r1", title: "Kek", content_lang: "tr", ingredients: [{ name: "Un", amount: "1" }], instructions: ["Karıştır."] };
  const payload = translationPayload(old, "en");
  assert.equal("tips" in payload, false);
  assert.equal(contentFingerprint({ ...old, tips: [] }), contentFingerprint(old));
  assert.notEqual(contentFingerprint({ ...old, tips: ["X"] }), contentFingerprint(old));
});

test("çeviri: püf noktaları çevrilir; sayısı ya da rakamı değişen öğe asıl metinle kalır", () => {
  const recipe = { id: "r1", title: "Kek", content_lang: "tr", ingredients: [], instructions: [], tips: ["Fırını 180 dereceye ısıtın.", "Soğumadan kesmeyin."] };
  const payload = translationPayload(recipe, "en");
  assert.deepEqual(payload.tips, recipe.tips);
  const ok = validateTranslation(payload, { title: "Cake", ingredients: [], instructions: [], assumptions: "", servings_note: "", tips: ["Preheat the oven to 200 degrees.", "Do not cut before it cools."] });
  assert.deepEqual(ok.tips, ["Fırını 180 dereceye ısıtın.", "Do not cut before it cools."]);
  const shown = localizeRecipe(recipe, "en", { translation: ok });
  assert.deepEqual(shown.tips, ok.tips);
  assert.deepEqual(recipe.tips, ["Fırını 180 dereceye ısıtın.", "Soğumadan kesmeyin."], "kayıtlı tarif değişmez");
  const wrongCount = validateTranslation(payload, { title: "Cake", ingredients: [], instructions: [], assumptions: "", servings_note: "", tips: ["Only one"] });
  assert.deepEqual(wrongCount.tips, recipe.tips);
});

// ---- 21 Kasım dipnotları: bağsız eski aile tarifleri, tekil/çoğul çeviri ----

test("aile kategorileri: bağsız (d2254df) aile tarifinde sahip, ekleyenin üye listesindeki tek eşleşmesi", async () => {
  reset();
  familyWith([
    { id: "old1-fam-F1", title: "Tarhana", category: "Çorba", addedBy: "Emre" },
    { id: "old2-fam-F1", title: "Kısır", category: "Mezeler", addedBy: "Ayşe" },
    { id: "old3-fam-F1", title: "Bilinmez", category: "Garip", addedBy: "Kimse" },
  ]);
  const r = await invoke(profileHandler, { method: "GET", uid: "B", query: { familyCategories: "1" } });
  assert.equal(r.status, 200);
  // Ayşe'ye yalnız Emre'nin kategorisi döner (kendi eklediği ve sahibi bulunamayan dönmez).
  assert.equal(r.body.familyCategories.length, 1);
  const [fc] = r.body.familyCategories;
  assert.equal(fc.name, "Çorba");
  assert.equal(fc.ref.uid, "A");
  assert.equal(fc.ref.by, "Emre");
  assert.match(fc.ref.id, /^l[a-z0-9]+$/, "d2254df metin kategorisinin sabit kimliği");
  // Aynı adlı bağlı tarif varsa onun bağı kullanılır (ayrı bölüm olmasın).
  familyWith([
    { id: "old1-fam-F1", title: "Tarhana", category: "Çorbalar", addedBy: "Emre" },
    { id: "new1-fam-F1", title: "Ezogelin", category: "Çorbalar", categoryRef: EMRE_SOUPS },
  ]);
  const r2 = await invoke(profileHandler, { method: "GET", uid: "B", query: { familyCategories: "1" } });
  assert.deepEqual(r2.body.familyCategories, [{ familyId: "F1", name: "Çorbalar", ref: EMRE_SOUPS }]);
  // Kayıtlar değişmez.
  assert.equal(read("family:F1:recipes")[0].categoryRef, undefined);
});

test("kategori çevirisi: tekil/çoğul korunur (prompt), önbellek sürümü v3; bağsız özel adlar da çevrilir", async () => {
  reset();
  familyWith([
    { id: "r1-fam-F1", title: "Ezogelin", category: "Çorba", categoryRef: { ...EMRE_SOUPS } },
    { id: "old-fam-F1", title: "Tarhana", category: "Mezeler", addedBy: "Emre" },
  ]);
  extracted = { titles: ["Soup", "Appetizers"] };
  const r = await invoke(translateHandler, { uid: "B", body: { mode: "categories", target: "en" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.categories, { "tr\nÇorba": "Soup", "tr\nMezeler": "Appetizers" });
  assert.equal(requests.length, 1);
  assert.match(requests[0].system, /singular name stays singular/);
  assert.match(requests[0].system, /"Çorba" → "Soup"/);
  const fields = [...db.get("user:B:translations:en").map.keys()];
  assert.ok(fields.length > 0 && fields.every((k) => k.startsWith("c:v3:")), "yeni sürüm anahtarı (v2'nin çoğullaştırdığı kayıt kullanılmaz)");
  // İkinci istek önbellekten.
  await invoke(translateHandler, { uid: "B", body: { mode: "categories", target: "en" } });
  assert.equal(requests.length, 1);
});
