// Audit F5 (15 Kasım 2026): kaynakta "yaklaşık 1 kg" yazan miktar modelin önerisi sayılmamalı.
// estimated: true → miktar kaynakta yok, model önerdi ("Yaklaşık …" + "kaynakta yok" notu).
// approx: true    → miktar kaynakta var, kaynak "yaklaşık" diyor ("Yaklaşık …", not yok).
// Model yanıtı sahte (ağsız, ücretsiz); gerçek sunucu çıkarma yolu + gerçek gösterim yardımcıları.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.ANTHROPIC_API_KEY = "test-key";
let nextModelRecipe = null;
globalThis.fetch = async (url) => {
  assert.equal(String(url), "https://api.anthropic.com/v1/messages");
  return new Response(
    JSON.stringify({ stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: JSON.stringify(nextModelRecipe) }] }),
    { status: 200 }
  );
};

const { cleanAmount, normalizeExtractedIngredients, amountFlagsAfterEdit } = await import("../shared/ingredientText.js");
const { extractRecipeFromCaption } = await import("../api/_lib/extractRecipe.js");
const { applyPortionEstimate, hasSourceAmounts, hasEstimatedIngredientAmounts, PORTION_RULES_VERSION } = await import("../shared/portionEstimate.js");
const { displayIngredient, contentFingerprint, localizeRecipe } = await import("../src/recipeLocale.js");
const { presentIngredients, hasEstimatedAmounts } = await import("../src/ingredientPresentation.js");

const ing = (name, amount, estimated, group = "") => ({ name, amount, group, estimated });

// ---------- (a) sunucu: kayıttan önce normalize ----------

test("sunucu: estimated:false + kaynağın 'yaklaşık' öneki → öneksiz miktar + approx, estimated yok", () => {
  const out = normalizeExtractedIngredients(
    [ing("Et", "yaklaşık 1 kg", false), ing("Flour", "about 2 lbs", false), ing("Pirinç", "~500 g", false), ing("Süt", "tahminen 1 su bardağı", false)],
    "tr"
  );
  assert.deepEqual(out, [
    { name: "Et", amount: "1 kg", approx: true },
    { name: "Flour", amount: "2 lbs", approx: true },
    { name: "Pirinç", amount: "500 g", approx: true },
    { name: "Süt", amount: "1 su bardağı", approx: true },
  ]);
});

test("sunucu: estimated:true her zaman estimated (önekli ya da öneksiz); approx yazılmaz", () => {
  const out = normalizeExtractedIngredients([ing("Tuz", "tahminen 45 g", true), ing("Yağ", "2 yemek kaşığı", true), ing("Et", "yaklaşık 1 kg", true)], "tr");
  assert.deepEqual(out, [
    { name: "Tuz", amount: "45 g", estimated: true },
    { name: "Yağ", amount: "2 yemek kaşığı", estimated: true },
    { name: "Et", amount: "1 kg", estimated: true },
  ]);
});

test("sunucu: 'belirtilmemiş, tahminen 45 g' bayrak false olsa da estimated (kaynakta yok diyor)", () => {
  const out = normalizeExtractedIngredients([ing("Tuz", "belirtilmemiş, tahminen 45 g", false), ing("Biber", "not specified, about 2 tsp", false)], "tr");
  assert.deepEqual(out, [
    { name: "Tuz", amount: "45 g", estimated: true },
    { name: "Biber", amount: "2 tsp", estimated: true },
  ]);
});

test("sunucu: düz miktar ve sayısız önek bayraksız kalır", () => {
  const out = normalizeExtractedIngredients(
    [ing("Et", "1 kg", false), ing("Tuz", "damak zevkine göre", false), ing("Yağ", "yaklaşık bir miktar", false), ing("Un", "2 lb (yaklaşık 907 g)", false)],
    "tr"
  );
  assert.deepEqual(out, [
    { name: "Et", amount: "1 kg" },
    { name: "Tuz", amount: "damak zevkine göre" },
    { name: "Yağ", amount: "yaklaşık bir miktar" },
    { name: "Un", amount: "2 lb (yaklaşık 907 g)" },
  ]);
});

test("cleanAmount: bayrak verilmezse eski kural (önek = tahmin) aynen; dönüş biçimi değişmez", () => {
  assert.deepEqual(cleanAmount("yaklaşık 2 kg"), { amount: "2 kg", estimated: true });
  assert.deepEqual(cleanAmount("tahminen 45 g"), { amount: "45 g", estimated: true });
  assert.deepEqual(cleanAmount("yaklaşık 2 kg", false, { sourcePrefixIsApprox: true }), { amount: "2 kg", estimated: false, approx: true });
  assert.deepEqual(cleanAmount("2 kg", false, { sourcePrefixIsApprox: true }), { amount: "2 kg", estimated: false });
});

// ---------- (b) porsiyon tabanı ----------

const modelRecipe = (ingredients, over = {}) => ({
  title: "Fırında Et",
  servings: null,
  servings_unit: "porsiyon",
  suggested_servings: 4,
  prep_time_minutes: 90,
  difficulty: "Orta",
  ingredients,
  instructions: ["Pişir."],
  nutrition: { calories: 2000, protein_g: 200, carbs_g: 10, fat_g: 120 },
  assumptions: "",
  portion: { dish_type: "ana_yemek", cooking_method: "firin", items: [] },
  ...over,
});
const extract = async (recipe) => {
  nextModelRecipe = recipe;
  return (await extractRecipeFromCaption({ link: "https://www.tiktok.com/@x/video/1", caption: "Fırında et", timeoutMs: 5000, language: "tr" })).recipe;
};

test("porsiyon: tek kaynak miktarı 'yaklaşık 1 kg' olan tarif 'tamami' öneri tabanına düşmez; kaynak miktarı sayılır", async () => {
  const r = await extract(modelRecipe([ing("Et", "yaklaşık 1 kg", false), ing("Soğan", "1 adet", true), ing("Tuz", "damak zevkine göre", false)]));
  assert.deepEqual(r.ingredients[0], { name: "Et", amount: "1 kg", approx: true });
  assert.equal(hasSourceAmounts(r), true);
  assert.equal(r.servings_basis, "oneri");
  assert.equal(r.servings_oneri, "eksikler", "kaynak miktarı var: eksikler önerildi");
  assert.equal(r.servings, 4);
});

test("porsiyon: yalnız approx miktarlı tarif öneri tabanı almaz (tahmin yok)", () => {
  const r = applyPortionEstimate(modelRecipe([{ name: "Et", amount: "1 kg", approx: true }]));
  assert.equal(hasEstimatedIngredientAmounts(r), false);
  assert.notEqual(r.servings_basis, "oneri");
});

test("porsiyon kural sürümü artırıldı ve belgelendi", () => {
  assert.equal(PORTION_RULES_VERSION, "2026-11-15.2");
  const doc = fs.readFileSync(new URL("../../docs/porsiyon-hesabi.md", import.meta.url), "utf8");
  assert.match(doc, /`2026-11-15\.2`/);
  assert.match(doc, /approx: true/);
});

// ---------- (c) gösterim ----------

test("gösterim: approx satır 'Yaklaşık 1 kg', ×2 'Yaklaşık 2 kg', EN 'About …'; not yok", () => {
  const list = presentIngredients([{ name: "Et", amount: "1 kg", approx: true }, { name: "Tuz", amount: "1 çay kaşığı" }], "tr");
  assert.deepEqual(list[0], { name: "Et", amount: "1 kg", approx: true });
  assert.equal(displayIngredient(list[0], 1, "tr").text, "Yaklaşık 1 kg");
  assert.equal(displayIngredient(list[0], 2, "tr").text, "Yaklaşık 2 kg");
  assert.equal(displayIngredient(list[0], 2, "tr").estimated, undefined);
  assert.equal(displayIngredient(list[1], 1, "tr").text, "1 çay kaşığı");
  assert.match(displayIngredient(list[0], 1, "en").text, /^About 1 kg$/);
  assert.equal(hasEstimatedAmounts(list), false, "kaynağın 'yaklaşık'ı 'kaynakta yok' notu üretmez");
});

test("gösterim: approx kayıtta önek metinde kalmışsa da estimated'a çevrilmez", () => {
  const [a] = presentIngredients([{ name: "Et", amount: "yaklaşık 1 kg", approx: true }], "tr");
  assert.deepEqual(a, { name: "Et", amount: "1 kg", approx: true });
  assert.equal(hasEstimatedAmounts([a]), false);
});

test("gösterim: estimated satır varsa not var; approx ile karışık listede de", () => {
  const list = presentIngredients([{ name: "Et", amount: "1 kg", approx: true }, { name: "Soğan", amount: "1 adet", estimated: true }], "tr");
  assert.equal(hasEstimatedAmounts(list), true);
  assert.equal(displayIngredient(list[1], 1, "tr").text, "Yaklaşık 1 adet");
});

test("gösterim: çevrilmiş tarifte approx önek gösterim dilinde kalır", () => {
  const recipe = { id: "r1", content_lang: "tr", title: "Et", ingredients: [{ name: "Et", amount: "1 kg", approx: true }], instructions: [] };
  const loc = localizeRecipe(recipe, "en", { translation: { title: "Meat", ingredients: [{ name: "Meat", amount: "1 kg" }], instructions: [] } });
  const [shown] = presentIngredients(loc.ingredients, "en");
  assert.equal(displayIngredient(shown, 1, "en").text, "About 1 kg");
});

test("çeviri parmak izi: bayraksız/bölümsüz tariflerin anahtarı değişmez; approx true iken değişir", () => {
  const base = { id: "r1", title: "T", ingredients: [{ name: "Et", amount: "1 kg" }], instructions: [] };
  const withGroup = { ...base, ingredients: [{ name: "Et", amount: "1 kg", group: "Ana", estimated: true }] };
  // Eski formül (bu değişiklikten önceki contentFingerprint) ile birebir aynı metin.
  const legacy = (recipe) => {
    const text = JSON.stringify([
      recipe.content_lang || "",
      recipe.title || "",
      (recipe.ingredients || []).map((i) => (i && (i.group || i.estimated) ? [i.name, i.amount, i.group || "", !!i.estimated] : [i && i.name, i && i.amount])),
      recipe.instructions || [],
      recipe.assumptions || "",
      recipe.servings_note || "",
    ]);
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return `${recipe.id}:${(h >>> 0).toString(36)}:${text.length}`;
  };
  assert.equal(contentFingerprint(base), legacy(base));
  assert.equal(contentFingerprint(withGroup), legacy(withGroup));
  const approx = { ...base, ingredients: [{ name: "Et", amount: "1 kg", approx: true }] };
  assert.notEqual(contentFingerprint(approx), contentFingerprint(base));
});

// ---------- (e) düzenleme ----------

test("düzenleme: approx/estimated miktar değişmediyse korunur, değişince kalkar; estimated kazanır", () => {
  assert.deepEqual(amountFlagsAfterEdit({ amount: "1 kg", origAmount: "1 kg", approx: true }), { approx: true });
  assert.deepEqual(amountFlagsAfterEdit({ amount: " 1 kg ", origAmount: "1 kg", approx: true }), { approx: true });
  assert.deepEqual(amountFlagsAfterEdit({ amount: "2 kg", origAmount: "1 kg", approx: true }), {});
  assert.deepEqual(amountFlagsAfterEdit({ amount: "", origAmount: "", approx: true }), {});
  assert.deepEqual(amountFlagsAfterEdit({ amount: "45 g", origAmount: "45 g", estimated: true }), { estimated: true });
  assert.deepEqual(amountFlagsAfterEdit({ amount: "45 g", origAmount: "45 g", estimated: true, approx: true }), { estimated: true });
  assert.deepEqual(amountFlagsAfterEdit({ amount: "45 g", origAmount: "45 g" }), {});
});

test("App.jsx: düzenleme formu approx'u taşır ve amountFlagsAfterEdit kullanır; alışveriş toplamı approx'u da önekler", () => {
  const app = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(app, /_approx: ing\.approx === true,/);
  assert.match(app, /\.\.\.amountFlagsAfterEdit\(\{ amount: i\.amount, origAmount: i\._origAmount, estimated: i\._estimated, approx: i\._approx \}\)/);
  assert.match(app, /approx: !!shown\.estimated \|\| !!shown\.approx/);
  assert.match(app, /return g\.approx \? approxText\(total, lang\) : total;/);
});
