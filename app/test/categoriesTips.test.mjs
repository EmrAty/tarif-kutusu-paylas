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

test("kategori ekle/kaldır: profilde atomik, ad olduğu gibi, tekrar eklemek değişiklik yapmaz", async () => {
  reset();
  let r = await invoke(profileHandler, { uid: "A", body: { action: "addCategory", name: "  Çorbalar  " } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.categories, ["Çorbalar"]);
  r = await invoke(profileHandler, { uid: "A", body: { action: "addCategory", name: "ÇORBALAR" } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.categories, ["Çorbalar"], "aynı ad farklı harf büyüklüğüyle ikinci kez eklenmez");
  await invoke(profileHandler, { uid: "A", body: { action: "addCategory", name: "Meal Prep" } });
  const profile = read("user:A:profile");
  assert.deepEqual(profile.categories, ["Çorbalar", "Meal Prep"]);
  assert.equal(profile.isPlus, false, "diğer profil alanları korunur");

  r = await invoke(profileHandler, { method: "GET", uid: "A" });
  assert.deepEqual(r.body.categories, ["Çorbalar", "Meal Prep"]);

  r = await invoke(profileHandler, { uid: "A", body: { action: "removeCategory", name: "çorbalar" } });
  assert.deepEqual(r.body.categories, ["Meal Prep"]);
  // Başka hesabın profili etkilenmez.
  r = await invoke(profileHandler, { method: "GET", uid: "B" });
  assert.deepEqual(r.body.categories, []);
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
  const job = await runJob({ category: "Kek & Kurabiye" });
  assert.equal(job.status, "completed");
  const [saved] = read("user:A:recipes");
  assert.equal(saved.category, "Kek & Kurabiye");
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
