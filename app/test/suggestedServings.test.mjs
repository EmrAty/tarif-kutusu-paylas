// Miktarı ve porsiyonu eksik tarifler (15 Kasım 2026): önerilen miktarların bir kişi sayısı
// tabanı kaydedilir (servings_basis "oneri"), böylece Pişirme modundaki mevcut porsiyon seçici
// bu tariflerde de çalışır. Kaynak miktarları ve oranları değişmez; tahminler "Yaklaşık" kalır.
// Model yanıtı sahte (ağsız, ücretsiz); gerçek sunucu çıkarma yolu + gerçek gösterim yardımcıları.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.ANTHROPIC_API_KEY = "test-key";
let nextModelRecipe = null;
const sentBodies = [];
globalThis.fetch = async (url, init = {}) => {
  assert.equal(String(url), "https://api.anthropic.com/v1/messages");
  sentBodies.push(JSON.parse(init.body));
  return new Response(
    JSON.stringify({ stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: JSON.stringify(nextModelRecipe) }] }),
    { status: 200 }
  );
};

const { extractRecipeFromCaption } = await import("../api/_lib/extractRecipe.js");
const { applyPortionEstimate, hasSourceAmounts } = await import("../shared/portionEstimate.js");
const { recipeSystemPrompt } = await import("../shared/recipeExtraction.js");
const { baseServingsOf, maxServingsFor } = await import("../src/servings.js");
const { displayIngredient, localizeRecipe } = await import("../src/recipeLocale.js");
const { hasEstimatedAmounts } = await import("../src/ingredientPresentation.js");

const pItem = (name, kind, quantity, unit, inSource, extra = {}) => ({
  name, kind, quantity, unit, size: null, state: "cig", quantity_in_source: inSource, main: false, ...extra,
});
const modelRecipe = (over) => ({
  title: "Steak Sandviç",
  servings: null,
  servings_unit: "porsiyon",
  suggested_servings: null,
  prep_time_minutes: 30,
  difficulty: "Orta",
  instructions: ["Soğanları karamelize et.", "2 kuşkonmazı 1 dilim bacon ile sar."],
  nutrition: { calories: 900, protein_g: 50, carbs_g: 60, fat_g: 45 },
  assumptions: "",
  ...over,
});
const extract = async (recipe) => {
  nextModelRecipe = recipe;
  return (await extractRecipeFromCaption({ link: "https://www.tiktok.com/@x/video/1", caption: "STEAK SANDWICH", timeoutMs: 5000, language: "tr" })).recipe;
};
// Pişirme modundaki ölçek katsayısı (App.jsx CookMode ile aynı formül).
const factorFor = (recipe, selected) => selected / baseServingsOf(recipe);
const shown = (recipe, selected) => recipe.ingredients.map((i) => displayIngredient(i, factorFor(recipe, selected), "tr").text);

// --- 1. Kaynakta hiç miktar yok ------------------------------------------------------------
const NO_AMOUNTS = modelRecipe({
  suggested_servings: 1,
  ingredients: [
    { name: "Flank steak", amount: "200 g", group: "", estimated: true },
    { name: "Ciabatta ekmeği", amount: "1 adet", group: "", estimated: true },
    { name: "Bacon", amount: "1 dilim", group: "", estimated: true },
    { name: "Kuşkonmaz", amount: "2 adet", group: "", estimated: true },
    { name: "Mayonez", amount: "1 yemek kaşığı", group: "Sos", estimated: true },
    { name: "Tuz, karabiber", amount: "damak zevkine göre", group: "Sos", estimated: false },
  ],
  portion: {
    dish_type: "ana_yemek",
    cooking_method: "tava_izgara",
    items: [
      pItem("Flank steak", "et_kemiksiz", 200, "g", false, { main: true }),
      pItem("Ciabatta ekmeği", "diger", 1, "adet", false),
      pItem("Tuz, karabiber", "baharat_tuz", null, "belirsiz", false),
    ],
  },
});

test("miktarsız tarif: 1 kişilik öneri olarak kaydedilir; öneri sayısı kayda yazılmaz", async () => {
  const r = await extract(NO_AMOUNTS);
  assert.equal(r.servings, 1);
  assert.equal(r.servings_basis, "oneri");
  assert.equal(r.servings_oneri, "tamami");
  assert.equal("suggested_servings" in r, false);
  assert.equal("portion" in r, false);
  assert.equal(r.servings_note, undefined, "uzun hesap notu yok; arayüz kısa not gösterir");
  assert.equal(baseServingsOf(r), 1, "Pişirme modu oran kurabilir → porsiyon seçici görünür");
  assert.ok(maxServingsFor(1) >= 2);
  assert.ok(hasEstimatedAmounts(r.ingredients));
});

test("miktarsız tarif: 2 kişi seçilince tahminler iki katına çıkar, 'Yaklaşık' kalır; sayısız miktar sayıya çevrilmez", async () => {
  const r = await extract(NO_AMOUNTS);
  const saved = JSON.stringify(r);
  assert.deepEqual(shown(r, 1), ["Yaklaşık 200 g", "Yaklaşık 1 adet", "Yaklaşık 1 dilim", "Yaklaşık 2 adet", "Yaklaşık 1 yemek kaşığı", "damak zevkine göre"]);
  assert.deepEqual(shown(r, 2), ["Yaklaşık 400 g", "Yaklaşık 2 adet", "Yaklaşık 2 dilim", "Yaklaşık 4 adet", "Yaklaşık 2 yemek kaşığı", "damak zevkine göre"]);
  assert.deepEqual(shown(r, 3)[0], "Yaklaşık 600 g");
  assert.equal(JSON.stringify(r), saved, "seçim kayıtlı tarifi değiştirmez");
  assert.equal(r.ingredients.find((i) => i.name === "Tuz, karabiber").estimated, undefined);
});

test("miktarsız tarif: model öneri sayısı vermezse 1; geçersiz sayılar (0, 2.5, 50) da 1", () => {
  for (const s of [null, 0, 2.5, 50, "3"]) {
    const r = applyPortionEstimate({ ...NO_AMOUNTS, suggested_servings: s });
    assert.equal(r.servings, 1, String(s));
    assert.equal(r.servings_basis, "oneri");
  }
});

// --- 2. Kısmen miktarlı: kaithompson "STEAK SANDWICH" (kaynak: 2 onions, 4 tbsp mayo, 2 tbsp Dijon,
// 2 tsp Worcestershire, 1 tbsp hot sauce; "Wrap 2 asparagus with 1 slice of bacon") ---------------
const SOURCE = {
  Soğan: "2 adet",
  Mayonez: "4 yemek kaşığı",
  "Tane hardallı Dijon hardal": "2 yemek kaşığı",
  "Worcestershire sosu": "2 çay kaşığı",
  "Acı sos": "1 yemek kaşığı",
};
const PARTIAL = modelRecipe({
  suggested_servings: 4,
  ingredients: [
    { name: "Flank steak", amount: "800 g", group: "", estimated: true },
    { name: "Ciabatta ekmeği", amount: "4 adet", group: "", estimated: true },
    { name: "Soğan", amount: "2 adet", group: "", estimated: false },
    { name: "Bacon", amount: "4 dilim", group: "", estimated: true },
    { name: "Kuşkonmaz", amount: "8 adet", group: "", estimated: true },
    { name: "Parmigiano reggiano", amount: "", group: "", estimated: false },
    { name: "Mayonez", amount: "4 yemek kaşığı", group: "Sos", estimated: false },
    { name: "Tane hardallı Dijon hardal", amount: "2 yemek kaşığı", group: "Sos", estimated: false },
    { name: "Worcestershire sosu", amount: "2 çay kaşığı", group: "Sos", estimated: false },
    { name: "Acı sos", amount: "1 yemek kaşığı", group: "Sos", estimated: false },
    { name: "Sarımsak tozu, tuz ve karabiber", amount: "damak zevkine göre", group: "Sos", estimated: false },
  ],
  portion: {
    dish_type: "ana_yemek",
    cooking_method: "tava_izgara",
    items: [
      pItem("Flank steak", "et_kemiksiz", 800, "g", false, { main: true }),
      pItem("Soğan", "sebze", 2, "adet", true),
      pItem("Mayonez", "sos_salca", 4, "yemek_kasigi", true),
    ],
  },
});

test("kısmen miktarlı: tarif 1 kişilik sayılmaz; taban kaynak miktarlarına göre önerilen sayı, kaynak sayıları aynen", async () => {
  const r = await extract(PARTIAL);
  assert.equal(r.servings_basis, "oneri");
  assert.equal(r.servings_oneri, "eksikler");
  assert.equal(r.servings, 4);
  for (const [name, amount] of Object.entries(SOURCE)) {
    const ing = r.ingredients.find((i) => i.name === name);
    assert.equal(ing.amount, amount, name);
    assert.equal(ing.estimated, undefined, `${name} kaynak miktarı tahmin sayılmaz`);
  }
  assert.equal(r.ingredients.find((i) => i.name === "Parmigiano reggiano").amount, "", "dayanaksız boş miktar boş kalır");
  assert.equal(r.ingredients.find((i) => i.name === "Soğan").group, undefined);
  assert.equal(r.ingredients.find((i) => i.name === "Mayonez").group, "Sos", "bölüm başlığı korunur");
});

test("kısmen miktarlı: her katsayıda 2 kuşkonmaz : 1 dilim bacon oranı ve kaynak oranları korunur", async () => {
  const r = await extract(PARTIAL);
  const at = (sel, name) => displayIngredient(r.ingredients.find((i) => i.name === name), factorFor(r, sel), "tr").text;
  assert.equal(at(4, "Soğan"), "2 adet", "kayıtlı tabanda kaynak metni aynen");
  assert.equal(at(4, "Kuşkonmaz"), "Yaklaşık 8 adet");
  assert.equal(at(2, "Kuşkonmaz"), "Yaklaşık 4 adet");
  assert.equal(at(2, "Bacon"), "Yaklaşık 2 dilim");
  assert.equal(at(1, "Kuşkonmaz"), "Yaklaşık 2 adet");
  assert.equal(at(1, "Bacon"), "Yaklaşık 1 dilim");
  assert.equal(at(8, "Soğan"), "4 adet");
  assert.equal(at(8, "Mayonez"), "8 yemek kaşığı", "kaynak miktarı ölçeklenir ama 'Yaklaşık' almaz");
  assert.equal(at(8, "Flank steak"), "Yaklaşık 1600 g");
  assert.equal(at(8, "Sarımsak tozu, tuz ve karabiber"), "damak zevkine göre");
});

test("kısmen miktarlı: model taban vermezse sayı uydurulmaz (porsiyon bilinmiyor, eski davranış)", () => {
  for (const s of [null, 0, 1.5, 99]) {
    const r = applyPortionEstimate({ ...PARTIAL, suggested_servings: s });
    assert.equal(r.servings, null, String(s));
    assert.equal(r.servings_basis, "bilinmiyor");
    assert.match(r.servings_note, /Porsiyon hesaplanamadı/);
  }
});

test("kısmen miktarlı: ana malzeme kaynakta ölçülüyse deterministik hesap önceliklidir, model sayısı yok sayılır", () => {
  const r = applyPortionEstimate({
    ...PARTIAL,
    suggested_servings: 9,
    portion: { ...PARTIAL.portion, items: [pItem("Dana kıyma", "kiyma", 500, "g", true, { main: true }), pItem("Soğan", "sebze", 1, "adet", false)] },
  });
  assert.equal(r.servings_basis, "hesap");
  assert.notEqual(r.servings, 9);
  assert.equal(r.servings_oneri, undefined);
});

// --- 3. Tam miktarlı ----------------------------------------------------------------------
test("tam miktarlı + kaynakta porsiyon: davranış değişmez (kaynak), model öneri sayısı yok sayılır", async () => {
  const r = await extract(
    modelRecipe({
      servings: 2,
      suggested_servings: 5,
      ingredients: [
        { name: "Kıyma", amount: "300 g", group: "", estimated: false },
        { name: "Soğan", amount: "1 adet", group: "", estimated: false },
      ],
      portion: { dish_type: "ana_yemek", cooking_method: "tava_izgara", items: [pItem("Kıyma", "kiyma", 300, "g", true, { main: true })] },
    })
  );
  assert.equal(r.servings, 2);
  assert.equal(r.servings_basis, "kaynak");
  assert.equal(r.servings_oneri, undefined);
  assert.equal("suggested_servings" in r, false);
  assert.deepEqual(shown(r, 4), ["600 g", "2 adet"]);
});

test("tam miktarlı, porsiyon yok ve hesaplanamıyor: tahmini miktar olmadığından öneri tabanı uygulanmaz", () => {
  const r = applyPortionEstimate(
    modelRecipe({
      suggested_servings: 3,
      ingredients: [{ name: "Elma", amount: "3 adet", estimated: false }],
      portion: { dish_type: "diger", cooking_method: "cig", items: [pItem("Elma", "diger", 3, "adet", true)] },
    })
  );
  assert.equal(r.servings, null);
  assert.equal(r.servings_basis, "bilinmiyor");
});

test("hasSourceAmounts: sayısız ifadeler ve tahminler kaynak miktarı sayılmaz", () => {
  assert.equal(hasSourceAmounts({ ingredients: [{ amount: "damak zevkine göre" }, { amount: "kızartmak için" }, { amount: "200 g", estimated: true }] }), false);
  assert.equal(hasSourceAmounts({ ingredients: [{ amount: "yarım su bardağı" }] }), true);
  assert.equal(hasSourceAmounts({ ingredients: [{ amount: "" }], portion: { items: [{ quantity: 2, quantity_in_source: true }] } }), true);
});

// --- 4. Eski kayıtlar, çeviri, düzenleme, prompt/şema ----------------------------------------
test("eski kayıt (porsiyon bilinmiyor, boş miktar): gösterimde sayı uydurulmaz, porsiyon tabanı yok", () => {
  const old = { id: "old", servings: null, servings_basis: "bilinmiyor", ingredients: [{ name: "Bacon", amount: "" }, { name: "Soğan", amount: "2 adet" }] };
  assert.equal(baseServingsOf(old), null);
  assert.deepEqual(old.ingredients.map((i) => displayIngredient(i, 1, "tr").text), ["", "2 adet"]);
});

test("çeviri: öneri tabanı ve tahmin işaretleri gösterim tarifinde korunur, İngilizcede 'About'", async () => {
  const r = { ...(await extract(PARTIAL)), id: "r1", content_lang: "tr" };
  const translation = { title: "Steak Sandwich", ingredients: r.ingredients.map((i) => ({ name: `EN ${i.name}` })), instructions: r.instructions, groups: ["Sauce"] };
  const en = localizeRecipe(r, "en", { translation });
  assert.equal(en.servings, 4);
  assert.equal(en.servings_basis, "oneri");
  assert.equal(en.servings_oneri, "eksikler");
  const asparagus = en.ingredients.find((i) => i.name === "EN Kuşkonmaz");
  assert.equal(displayIngredient(asparagus, 2 / 4, "en").text, "About 4", "İngilizcede adet sözcüğü düşer; sayı ölçeklenir");
  assert.equal(en.ingredients.find((i) => i.name === "EN Mayonez").group, "Sauce");
});

test("prompt ve şema: suggested_servings zorunlu; miktarsızda 1 kişilik, kısmide kaynak ölçüsü ve oran kuralı", async () => {
  sentBodies.length = 0;
  await extract(NO_AMOUNTS);
  const body = sentBodies[0];
  const schema = body.output_config.format.schema;
  assert.ok(schema.required.includes("suggested_servings"));
  assert.deepEqual(schema.properties.suggested_servings, { anyOf: [{ type: "integer" }, { type: "null" }] });
  const p = recipeSystemPrompt("tr");
  assert.match(p, /miktarlar 1 KİŞİLİK olsun ve "suggested_servings": 1/);
  assert.match(p, /tarifi 1 kişilik sayma, kaynaktaki sayıları küçültme ya da büyütme/);
  assert.match(p, /her 2 kuşkonmaza 1 dilim bacon/);
});

test("arayüz: 'oneri' tahmini sayılır, kısa not iki dilde var, düzenlemede porsiyon değişince işaret silinir", () => {
  const app = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  const i18n = fs.readFileSync(new URL("../src/i18n.jsx", import.meta.url), "utf8");
  assert.match(app, /const isSuggestedServings = \(recipe\) => !!recipe && recipe\.servings_basis === "oneri"/);
  assert.match(app, /isEstimatedServings = \(recipe\) => [^\n]*isSuggestedServings\(recipe\)/);
  assert.match(app, /servings_range: undefined, servings_oneri: undefined/);
  for (const k of ["detail.servingsSuggestedOne", "detail.servingsSuggested", "detail.suggestedNoteOne", "detail.suggestedNote", "servings.originalSuggested"]) {
    assert.equal(i18n.split(`"${k}":`).length - 1, 2, `${k} tr+en`);
  }
});
