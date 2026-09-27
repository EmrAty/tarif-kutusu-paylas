// Tarif içeriği yerelleştirme: birim sözlüğü, ölçekle-sonra-çevir, pratik yuvarlama.
import test from "node:test";
import assert from "node:assert/strict";
import { localizeAmount, localizeRecipe, displayIngredient, contentFingerprint } from "./recipeLocale.js";
import { translationPayload, sameNumbers, contentLangOf } from "../shared/recipeLocales.js";
import { validateTranslation } from "../api/translate-recipe.js";

const en = (t) => localizeAmount(t, "tr", "en");

test("TR → EN birimler (deterministik), sayılar aynı", () => {
  assert.equal(en("300 g"), "300 g");
  assert.equal(en("1 adet"), "1");
  assert.equal(en("2 adet"), "2");
  assert.equal(en("2 diş"), "2 cloves");
  assert.equal(en("1 diş"), "1 clove");
  assert.equal(en("1 yemek kaşığı"), "1 tbsp");
  assert.equal(en("1½ yemek kaşığı"), "1½ tbsp");
  assert.equal(en("1 çay kaşığı"), "1 tsp");
  assert.equal(en("1,5 kg"), "1.5 kg");
  assert.equal(en("2-3 adet"), "2-3");
  assert.equal(en("yarım demet"), "½ bunch");
  assert.equal(en("2 demet"), "2 bunches");
  assert.equal(en("1 paket"), "1 pack");
  assert.equal(en("½ paket"), "½ pack");
});

test("Türk bardak ölçüleri 'cup' olmaz, hacim korunur", () => {
  assert.equal(en("1 su bardağı"), "1 glass (200 ml)");
  assert.equal(en("2 su bardağı"), "2 glasses (200 ml)");
  assert.equal(en("½ su bardağı"), "½ glass (200 ml)");
  assert.equal(en("1 çay bardağı"), "1 tea glass (100 ml)");
  assert.equal(en("1 tatlı kaşığı"), "1 dessert spoon (10 ml)");
  assert.equal(en("1 su bardağı (200 ml)"), "1 glass (200 ml)");
  assert.ok(!/cup/.test(en("3 su bardağı")));
});

test("boy ve ek ifadeler; tanınmayan metin null (AI'a düşer)", () => {
  assert.equal(en("1 adet (orta boy)"), "1 (medium)");
  assert.equal(en("2 orta boy"), "2 medium");
  assert.equal(en("damak zevkine göre"), "to taste");
  assert.equal(en("bir tutam"), "a pinch");
  assert.equal(en("1 tutam"), "1 pinch");
  assert.equal(en("servis için"), "for serving");
  assert.equal(en("1 kutu (400 g)"), null);
  assert.equal(en("3 adet közlenmiş"), null);
});

test("EN → TR ters yön", () => {
  const tr = (t) => localizeAmount(t, "en", "tr");
  assert.equal(tr("2 tbsp"), "2 yemek kaşığı");
  assert.equal(tr("1.5 kg"), "1,5 kg");
  assert.equal(tr("2 cloves"), "2 diş");
  assert.equal(tr("1 cup"), "1 kupa (240 ml)");
  assert.equal(tr("to taste"), "damak zevkine göre");
});

const RECIPE = {
  id: "r1", title: "Tavuklu Noodle", servings: 2,
  ingredients: [
    { name: "tavuk göğsü", amount: "300 g" },
    { name: "havuç", amount: "1 adet" },
    { name: "sarımsak", amount: "2 diş" },
    { name: "soya sosu", amount: "1 yemek kaşığı" },
    { name: "yumurta", amount: "3 adet" },
    { name: "domates", amount: "1 kutu (400 g)" },
  ],
  instructions: ["Tavuğu küçük parçalar halinde doğrayın.", "180°C fırında 20 dakika pişirin."],
  assumptions: "", servings_note: "",
};
const TRANSLATION = {
  title: "Chicken Noodles",
  ingredients: [
    { name: "Chicken breast", amount: "300 g" }, { name: "Carrot", amount: "1" }, { name: "Garlic", amount: "2 cloves" },
    { name: "Soy sauce", amount: "1 tbsp" }, { name: "Eggs", amount: "3" }, { name: "Tomatoes", amount: "1 can (400 g)" },
  ],
  instructions: ["Cut the chicken into small pieces.", "Bake at 180°C for 20 minutes."],
  assumptions: "", servings_note: "",
};

test("localizeRecipe: asıl tarif değişmez, gösterim İngilizce", () => {
  const before = JSON.stringify(RECIPE);
  const d = localizeRecipe(RECIPE, "en", { translation: TRANSLATION });
  assert.equal(JSON.stringify(RECIPE), before);
  assert.equal(d.title, "Chicken Noodles");
  assert.equal(d.instructions[1], "Bake at 180°C for 20 minutes.");
  assert.equal(d.servings, 2);
  assert.deepEqual(d.ingredients[0]._canon, { name: "tavuk göğsü", amount: "300 g" });
  // TR'de çeviri uygulanmaz
  assert.equal(localizeRecipe(RECIPE, "tr", {}), RECIPE);
});

test("displayIngredient: ölçek asıl metinde, sonra İngilizce; pratik yuvarlama korunur", () => {
  const d = localizeRecipe(RECIPE, "en", { translation: TRANSLATION });
  const row = (i, f) => displayIngredient(d.ingredients[i], f, "en");
  assert.equal(row(0, 1).text, "300 g");
  assert.equal(row(0, 0.5).text, "150 g");
  assert.equal(row(2, 0.5).text, "1 clove");
  assert.equal(row(3, 0.5).text, "½ tbsp");
  const egg = row(4, 0.5);
  assert.equal(egg.name, "Eggs");
  assert.equal(egg.text, "2");
  assert.equal(egg.rounded, true);
  assert.equal(egg.exactText, "1½");
  // sözlüğün tanımadığı miktar: AI metni aynı katsayıyla ölçeklenir
  assert.equal(row(5, 1).text, "1 can (400 g)");
  assert.equal(row(5, 0.5).status, "unparsed"); // "(400 g)" ikinci sayı: ölçeklenmez, olduğu gibi
});

test("İngilizce içerikli tarifte pratik yuvarlama (İngilizce adlar)", () => {
  const r = { id: "e", content_lang: "en", ingredients: [{ name: "Eggs", amount: "3" }, { name: "Egg yolks", amount: "5" }, { name: "Onion", amount: "3" }] };
  assert.equal(displayIngredient(r.ingredients[0], 0.5, "en").text, "2");
  assert.equal(displayIngredient(r.ingredients[1], 0.5, "en").text, "3");
  assert.equal(displayIngredient(r.ingredients[2], 0.5, "en").text, "1½");
});

test("translationPayload: sadece gereken alanlar; sayısal alan yok", () => {
  assert.equal(translationPayload(RECIPE, "tr"), null);
  const p = translationPayload({ ...RECIPE, servings_calc: { raw: 2.3 }, nutrition: { calories: 900 }, link: "https://x" }, "en");
  assert.deepEqual(Object.keys(p).sort(), ["assumptions", "ingredients", "instructions", "servings_note", "title"]);
  assert.ok(!JSON.stringify(p).includes("900") && !JSON.stringify(p).includes("https://x"));
  // İngilizce tarif İngilizcede: yalnızca (Türkçe üretilen) porsiyon notu çevrilir
  const p2 = translationPayload({ ...RECIPE, content_lang: "en", servings_note: "Porsiyon hesaplandı: 400 g" }, "en");
  assert.deepEqual([p2.title, p2.ingredients.length, p2.servings_note], ["", 0, "Porsiyon hesaplandı: 400 g"]);
  assert.equal(contentLangOf({}), "tr");
});

test("validateTranslation: sayısı değişen alan kullanılmaz, uzunluk bozuksa reddedilir", () => {
  const payload = translationPayload(RECIPE, "en");
  const bad = { ...TRANSLATION, ingredients: TRANSLATION.ingredients.map((x, i) => (i === 0 ? { ...x, amount: "500 g" } : x)), instructions: ["Cut.", "Bake at 350°F for 20 minutes."] };
  const v = validateTranslation(payload, bad);
  assert.equal(v.ingredients[0].amount, null);
  assert.equal(v.ingredients[0].name, "Chicken breast");
  assert.equal(v.instructions[1], RECIPE.instructions[1]);
  assert.equal(validateTranslation(payload, { ...TRANSLATION, ingredients: TRANSLATION.ingredients.slice(1) }), null);
  assert.ok(sameNumbers("1,5 kg", "1.5 kg") && !sameNumbers("300 g", "500 g"));
});

test("contentFingerprint: düzenleme anahtarı değiştirir", () => {
  const a = contentFingerprint(RECIPE);
  const b = contentFingerprint({ ...RECIPE, ingredients: [{ name: "hindi göğsü", amount: "300 g" }, ...RECIPE.ingredients.slice(1)] });
  assert.notEqual(a, b);
  assert.equal(a, contentFingerprint({ ...RECIPE, isFavorite: true }));
});

test("validateTranslation: sözlükteki hacim notu yeni sayı sayılmaz, gerçek sayı değişimi yine yakalanır", () => {
  const payload = { title: "", ingredients: [{ name: "süt", amount: "1 su bardağı" }, { name: "un", amount: "2 su bardağı" }], instructions: [], assumptions: "", servings_note: "" };
  const v = validateTranslation(payload, { title: "", ingredients: [{ name: "milk", amount: "1 glass (200 ml)" }, { name: "flour", amount: "3 glasses (200 ml)" }], instructions: [], assumptions: "", servings_note: "" });
  assert.equal(v.ingredients[0].amount, "1 glass (200 ml)");
  assert.equal(v.ingredients[1].amount, null);
});

test("İngilizce içerikte sabit hacim notlu birimler ölçeklenir, not aynen kalır", () => {
  const row = (amount, f) => displayIngredient({ name: "Water", amount }, f, "en").text;
  assert.equal(row("6 glasses (200 ml)", 0.5), "3 glasses (200 ml)");
  assert.equal(row("1 glass (200 ml)", 0.5), "½ glass (200 ml)");
  assert.equal(row("1 tea glass (100 ml)", 2), "2 tea glass (100 ml)");
  // Türkçe'de "1 su bardağı (200 ml)" hâlâ belirsiz: ölçeklenmez
  assert.equal(displayIngredient({ name: "Su", amount: "1 su bardağı (200 ml)" }, 0.5, "tr").status, "unparsed");
  assert.equal(localizeAmount("1 dessert spoon", "en", "tr"), "1 tatlı kaşığı");
});
