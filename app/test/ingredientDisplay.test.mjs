// Malzeme listesinin okunabilirliği (Haiku telefon denemesi, 15 Kasım 2026):
// kaynak metin → tarif çıkarma (prompt + şema + kayıt öncesi temizlik) → çeviri → gösterim.
// Gerçek kayıtlar: test/fixtures/trialRecipes.mjs. Ağsız.
import test from "node:test";
import assert from "node:assert/strict";

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

const { cleanAmount, normalizeExtractedIngredients } = await import("../shared/ingredientText.js");
const { recipeSystemPrompt } = await import("../shared/recipeExtraction.js");
const { translationPayload } = await import("../shared/recipeLocales.js");
const { extractRecipeFromCaption } = await import("../api/_lib/extractRecipe.js");
const { validateTranslation } = await import("../api/translate-recipe.js");
const { presentIngredients, splitCompoundAmount, groupRuns } = await import("../src/ingredientPresentation.js");
const { displayIngredient, localizeRecipe, splitQuantityPrefix } = await import("../src/recipeLocale.js");
const { NASHVILLE_INGREDIENTS, STEAK_INGREDIENTS } = await import("./fixtures/trialRecipes.mjs");

const digits = (s) => (String(s).match(/\d+/g) || []).join("|");
const CONTRADICTION = /belirtilme|tahminen|not specified|unspecified/i;

// ---------------------------------------------------------------------------------------------
// 1. Miktar metni: çelişkili ifadeler temizlenir, sayı uydurulmaz.
test("cleanAmount: 'belirtilmemiş, tahminen 45 g' → '45 g' + tahmini; yalnız 'belirtilmemiş' → boş", () => {
  const cases = [
    ["belirtilmemiş", "", false],
    ["Miktar belirtilmemiş", "", false],
    ["not specified", "", false],
    ["belirtilmemiş, tahminen 45 g", "45 g", true],
    ["belirtilmemiş, tahminen 2 yemek kaşığı", "2 yemek kaşığı", true],
    ["tahminen yarım çay kaşığı", "yarım çay kaşığı", true],
    ["about 1 cup", "1 cup", true],
    ["belirtilmemiş, birkaç diş", "birkaç diş", false],
    ["Derin kızartma için (miktar belirtilmemiş)", "Derin kızartma için", false],
    // Kaynakta verilen miktar + dönüşüm notu: dokunulmaz (tahmin değil).
    ["2 lb (yaklaşık 907 g)", "2 lb (yaklaşık 907 g)", false],
    ["Tadına göre", "Tadına göre", false],
    // Sayısız "yaklaşık …" tahmin sayılmaz, olduğu gibi kalır.
    ["Yaklaşık olarak bol", "Yaklaşık olarak bol", false],
  ];
  for (const [input, amount, estimated] of cases) {
    assert.deepEqual(cleanAmount(input), { amount, estimated }, input);
  }
  // Yeni şemadaki bayrak korunur; miktarsız tahmin olmaz.
  assert.deepEqual(cleanAmount("45 g", true), { amount: "45 g", estimated: true });
  assert.deepEqual(cleanAmount("", true), { amount: "", estimated: false });
  assert.deepEqual(cleanAmount("damak zevkine göre", true), { amount: "damak zevkine göre", estimated: false });
});

test("temizlik hiçbir zaman metinde olmayan bir sayı eklemez (gerçek kayıtlar)", () => {
  for (const ing of [...STEAK_INGREDIENTS, ...NASHVILLE_INGREDIENTS]) {
    const { amount } = cleanAmount(ing.amount);
    for (const n of digits(amount).split("|").filter(Boolean)) assert.ok(digits(ing.amount).split("|").includes(n), `${ing.name}: ${amount}`);
  }
});

// ---------------------------------------------------------------------------------------------
// 2. Çıkarma: prompt kuralları, şema, kayıttan önce temizlik.
test("prompt: tek satır = tek malzeme, bölüm (group), sayı uydurmama, tahmin bayrağı, doğru eşdeğer kuralları", () => {
  const p = recipeSystemPrompt("tr");
  assert.doesNotMatch(p, /Miktarlar net değilse o yemeğin tipik bir porsiyonuna göre makul tahminler yap/, "eski 'makul tahmin yap' talimatı kalkmalı");
  assert.match(p, /"ingredients": \[ \{ "name": string, "amount": string, "group": string, "estimated": boolean \} \]/);
  assert.match(p, /Her satır TEK bir malzemedir/);
  assert.match(p, /"group" alanına kısa bölüm adını/);
  assert.match(p, /Aynı malzeme birden çok bölümde/);
  assert.match(p, /sayı UYDURMA/);
  assert.match(p, /"belirtilmemiş", "tahminen", "yaklaşık", "örn\." gibi kelimeleri "amount" alanına YAZMA/);
  assert.match(p, /honey → bal/);
  assert.match(p, /buttermilk → yayık ayranı/);
  assert.match(p, /bacon pastırma değildir/);
  assert.match(p, /flank steak bonfile değildir/);
  assert.match(p, /Aynı malzemeyi iki dilde tekrar yazma/);
  assert.match(p, /yalnızca kaynakta gerçekten alternatif varsa/);
  // Dil talimatı yine en sonda (İngilizce içerik de aynı kuralları alır).
  assert.ok(recipeSystemPrompt("en").includes("Her satır TEK bir malzemedir"));
});

test("şema: malzemede group ve estimated zorunlu; model sızıntısı kayıttan önce temizlenir", async () => {
  nextModelRecipe = {
    title: "Nashville Hot Tavuk Sandviç",
    servings: null,
    servings_unit: "porsiyon",
    prep_time_minutes: 60,
    difficulty: "Orta",
    ingredients: [
      { name: "Tavuk göğsü", amount: "2 lb", group: "", estimated: false },
      { name: "Tereyağı", amount: "belirtilmemiş, tahminen 45 g", group: "", estimated: false },
      { name: "Maydanoz", amount: "belirtilmemiş", group: "", estimated: true },
      { name: "Acı kırmızı toz biber", amount: "1 yemek kaşığı", group: "Baharat karışımı ", estimated: false },
      { name: "Tuz", amount: "2 çay kaşığı", group: "Baharat karışımı", estimated: false },
      { name: "Un", amount: "2 su bardağı", group: "Kaplama", estimated: false },
      { name: "Baharat karışımı", amount: "2 yemek kaşığı", group: "Kaplama", estimated: false },
      { name: "Tuz", amount: "", group: "Sos", estimated: false },
      { name: "  ", amount: "1", group: "", estimated: false },
    ],
    instructions: ["Karıştır."],
    nutrition: { calories: 1, protein_g: 1, carbs_g: 1, fat_g: 1 },
    assumptions: "",
    portion: { dish_type: "ana_yemek", cooking_method: "kizartma", items: [] },
  };
  sentBodies.length = 0;
  const { recipe } = await extractRecipeFromCaption({ link: "https://www.tiktok.com/@a/video/1", caption: "x", timeoutMs: 5000 });
  const schema = sentBodies[0].output_config.format.schema.properties.ingredients.items;
  assert.deepEqual(Object.keys(schema.properties).sort(), ["amount", "estimated", "group", "name"]);
  assert.deepEqual([...schema.required].sort(), ["amount", "estimated", "group", "name"]);
  assert.deepEqual(recipe.ingredients, [
    { name: "Tavuk göğsü", amount: "2 lb" },
    { name: "Tereyağı", amount: "45 g", estimated: true },
    { name: "Maydanoz", amount: "" },
    { name: "Acı kırmızı toz biber", amount: "1 yemek kaşığı", group: "Baharat karışımı" },
    { name: "Tuz", amount: "2 çay kaşığı", group: "Baharat karışımı" },
    { name: "Un", amount: "2 su bardağı", group: "Kaplama" },
    { name: "Baharat karışımı", amount: "2 yemek kaşığı", group: "Kaplama" },
    { name: "Tuz", amount: "", group: "Sos" },
  ]);
});

test("normalizeExtractedIngredients: geçersiz girdi düşer, boş grup/false bayrak kayda yazılmaz", () => {
  assert.deepEqual(normalizeExtractedIngredients(null), []);
  assert.deepEqual(normalizeExtractedIngredients([null, 5, { name: "Un", amount: "1 su bardağı", group: "", estimated: false }]), [
    { name: "Un", amount: "1 su bardağı" },
  ]);
});

// ---------------------------------------------------------------------------------------------
// 3. Eski kayıtların gösterimi (kayıt değişmez).
test("eski kayıt (Nashville): karışım satırları bölüm başlığı + ayrı malzemelere ayrılır, miktarlar kaybolmaz", () => {
  const before = JSON.stringify(NASHVILLE_INGREDIENTS);
  const shown = presentIngredients(NASHVILLE_INGREDIENTS);
  assert.equal(JSON.stringify(NASHVILLE_INGREDIENTS), before, "kayıtlı dizi değişmemeli");

  const runs = groupRuns(shown).map((r) => [r.group, r.items.map(({ ing }) => `${ing.name}=${ing.amount}`)]);
  const byGroup = Object.fromEntries(runs.filter(([g]) => g));
  assert.deepEqual(byGroup["Nashville hot baharat karışımı"], [
    "Acı kırmızı biber (cayenne)=1 yemek kaşığı",
    "Esmer şeker=2 yemek kaşığı",
    "Füme kırmızı biber=1 yemek kaşığı",
    "Karabiber=1 çay kaşığı",
    "Sarımsak tozu=1 yemek kaşığı",
    "Soğan tozu=1 yemek kaşığı",
    "Tuz=2 çay kaşığı",
  ]);
  assert.deepEqual(byGroup["Kaplama unu"], ["Çok amaçlı un=2 su bardağı", "Mısır nişastası=1/2 su bardağı", "Kabartma tozu=1 çay kaşığı", "Baharat karışımı=2 yemek kaşığı"]);
  assert.deepEqual(byGroup["Buttermilk karışımı"], ["Buttermilk=2 su bardağı", "Yumurta=2 büyük", "Baharat karışımı=1 yemek kaşığı"]);
  assert.equal(byGroup["Sezar sosu"].length, 9);
  assert.ok(byGroup["Sezar sosu"].includes("Tuz="), "miktarsız 'tuz' da ayrı malzeme");

  // Aynı malzeme farklı bölümlerde kendi miktarıyla kalır.
  const salt = shown.filter((i) => i.name === "Tuz").map((i) => [i.group || "", i.amount]);
  assert.deepEqual(salt, [["", "Tadına göre"], ["Nashville hot baharat karışımı", "2 çay kaşığı"], ["Sezar sosu", ""]]);

  // Tarifte hazırlanan karışıma atıf satın alınacak malzeme sayılmaz.
  const refs = shown.filter((i) => i._ref).map((i) => `${i.group}:${i.name}`);
  assert.deepEqual(refs, ["Kaplama unu:Baharat karışımı", "Buttermilk karışımı:Baharat karışımı", "Nashville hot yağ sosu:Baharat karışımı", "Sezar salata:Sezar sosu"]);

  // Tek parçalı uzun miktar bölünmez (yanlış ayırma yerine olduğu gibi, sarılarak gösterilir).
  assert.equal(shown.find((i) => i.name === "Servis ekmeği").amount, "5–6 adet tost edilmiş brioche veya rustik ekmek");
  for (const i of shown) assert.doesNotMatch(i.amount, CONTRADICTION, i.name);
});

test("eski kayıt (steak): 'belirtilmemiş, tahminen …' → tahmini miktar; sayı yoksa boş; yeni sayı yok", () => {
  const shown = presentIngredients(STEAK_INGREDIENTS);
  assert.equal(shown.length, STEAK_INGREDIENTS.length, "bölünecek karışım yok");
  const by = Object.fromEntries(shown.map((i) => [i.name, [i.amount, !!i.estimated]]));
  assert.deepEqual(by["Tereyağı"], ["45 g", true]);
  assert.deepEqual(by["Havarti peyniri"], ["100 g", true]);
  assert.deepEqual(by["Sarımsak"], ["birkaç diş", false]);
  assert.deepEqual(by["Maydanoz"], ["", false]);
  assert.deepEqual(by["Pastırma (bacon)"], ["en az 4 dilim", false]);
  assert.deepEqual(by["Kuru soğan"], ["2 adet", false]);
  for (const i of shown) {
    assert.doesNotMatch(i.amount, CONTRADICTION, i.name);
    for (const n of digits(i.amount).split("|").filter(Boolean)) {
      const src = STEAK_INGREDIENTS.find((s) => s.name === i.name);
      assert.ok(digits(src.amount).split("|").includes(n), `${i.name}: ${n} uydurulmuş`);
    }
  }
});

test("bölme temkinli: tek parça, ondalık virgül ya da cümle bölünmez", () => {
  assert.equal(splitCompoundAmount("1,5 su bardağı süt"), null);
  assert.equal(splitCompoundAmount("2 adet, ince doğranmış"), null);
  assert.equal(splitCompoundAmount("soğan için ve 2 çay kaşığı (sos için)"), null);
  assert.equal(splitCompoundAmount("Kızartmak için, bol miktarda ve sıcak olarak kullanılan yağ"), null);
  assert.deepEqual(splitCompoundAmount("1 su bardağı (200 ml) süt, 2 yemek kaşığı şeker"), [
    { amount: "1 su bardağı (200 ml)", name: "süt" },
    { amount: "2 yemek kaşığı", name: "şeker" },
  ]);
  assert.deepEqual(splitQuantityPrefix("1 küçük diş sarımsak"), { amount: "1 küçük diş", name: "sarımsak" });
  assert.deepEqual(splitQuantityPrefix("2 large eggs"), { amount: "2 large", name: "eggs" });
  assert.equal(splitQuantityPrefix("2 yemek kaşığı"), null, "adı olmayan parça malzeme değil");
});

// ---------------------------------------------------------------------------------------------
// 4. Gösterim metni: "Yaklaşık", ölçekleme, dil.
test("tahmini miktar 'Yaklaşık 45 g' / 'About 45 g' gösterilir ve porsiyonla ölçeklenir; boş miktara önek yok", () => {
  const ing = { name: "Tereyağı", amount: "45 g", estimated: true };
  assert.equal(displayIngredient(ing, 1, "tr").text, "Yaklaşık 45 g");
  assert.equal(displayIngredient(ing, 2, "tr").text, "Yaklaşık 90 g");
  assert.equal(displayIngredient(ing, 2, "tr").canonText, "90 g", "alışveriş toplamı öneksiz metinle yapılır");
  assert.equal(displayIngredient({ ...ing, _canon: { name: "Tereyağı", amount: "45 g" }, _from: "tr" }, 1, "en").text, "About 45 g");
  assert.equal(displayIngredient({ name: "Maydanoz", amount: "", estimated: true }, 1, "tr").text, "");
  assert.equal(displayIngredient({ name: "Un", amount: "2 su bardağı" }, 1, "tr").text, "2 su bardağı");
});

test("İngilizce arayüz: eski Türkçe karışım satırı çeviriyle eşleşirse bölünür, eşleşmezse karışık dil üretmeden aynen kalır", () => {
  const recipe = { id: "r1", content_lang: "tr", title: "Kaplama", ingredients: [{ name: "Kaplama unu", amount: "2 su bardağı un, 1 çay kaşığı kabartma tozu" }] };
  const good = localizeRecipe(recipe, "en", {
    translation: { title: "Coating", ingredients: [{ name: "Coating flour", amount: "2 glasses (200 ml) flour, 1 tsp baking powder" }], instructions: [] },
  });
  const shown = presentIngredients(good.ingredients, "en");
  assert.deepEqual(
    shown.map((i) => [i.group, i.name, displayIngredient(i, 1, "en").text]),
    [
      ["Coating flour", "Flour", "2 glasses (200 ml)"],
      ["Coating flour", "Baking powder", "1 tsp"],
    ]
  );
  // Ölçekleme asıl (Türkçe) miktar üzerinden yapılır.
  assert.equal(displayIngredient(shown[0], 2, "en").text, "4 glasses (200 ml)");

  const bad = localizeRecipe(recipe, "en", {
    translation: { title: "Coating", ingredients: [{ name: "Coating flour", amount: "2 glasses flour with 1 tsp baking powder" }], instructions: [] },
  });
  const kept = presentIngredients(bad.ingredients, "en");
  assert.equal(kept.length, 1);
  assert.equal(kept[0].name, "Coating flour");
});

// ---------------------------------------------------------------------------------------------
// 5. Çeviri: bölüm adları; eski tariflerin önbellek anahtarı değişmez.
test("çeviri yükü: bölümsüz (eski) tarifte 'groups' anahtarı yok; bölümlü tarifte sırayla tekrarsız", () => {
  const old = translationPayload({ content_lang: "tr", title: "T", ingredients: [{ name: "Un", amount: "1 su bardağı" }], instructions: [] }, "en");
  assert.deepEqual(Object.keys(old), ["title", "ingredients", "instructions", "assumptions", "servings_note"]);
  const grouped = translationPayload(
    {
      content_lang: "tr",
      title: "T",
      ingredients: [
        { name: "Un", amount: "1", group: "Kaplama" },
        { name: "Tuz", amount: "", group: "Sos" },
        { name: "Biber", amount: "", group: "Kaplama" },
      ],
      instructions: [],
    },
    "en"
  );
  assert.deepEqual(grouped.groups, ["Kaplama", "Sos"]);
  assert.deepEqual(grouped.ingredients[0], { name: "Un", amount: "1" }, "malzeme biçimi aynı");
});

test("çeviri doğrulama + gösterim: bölüm adları çevrilir; sayısı tutmazsa asıl adlar kalır", () => {
  const payload = { title: "T", ingredients: [{ name: "Un", amount: "1" }], groups: ["Kaplama", "Sos"], instructions: [], assumptions: "", servings_note: "" };
  const ok = validateTranslation(payload, { title: "T", ingredients: [{ name: "Flour", amount: "1" }], groups: ["Coating", "Sauce"], instructions: [], assumptions: "", servings_note: "" });
  assert.deepEqual(ok.groups, ["Coating", "Sauce"]);
  const wrong = validateTranslation(payload, { title: "T", ingredients: [{ name: "Flour", amount: "1" }], groups: ["Coating"], instructions: [], assumptions: "", servings_note: "" });
  assert.deepEqual(wrong.groups, ["Kaplama", "Sos"]);
  const noGroups = validateTranslation({ ...payload, groups: undefined }, { title: "T", ingredients: [{ name: "Flour", amount: "1" }], instructions: [], assumptions: "", servings_note: "" });
  assert.equal("groups" in noGroups, false);

  const recipe = { id: "r2", content_lang: "tr", title: "T", ingredients: [{ name: "Un", amount: "1 su bardağı", group: "Kaplama" }, { name: "Tuz", amount: "", group: "Sos" }] };
  const d = localizeRecipe(recipe, "en", { translation: { title: "T", ingredients: [{ name: "Flour", amount: "" }, { name: "Salt", amount: "" }], groups: ["Coating", "Sauce"], instructions: [] } });
  assert.deepEqual(d.ingredients.map((i) => [i.group, i.name]), [["Coating", "Flour"], ["Sauce", "Salt"]]);
  assert.equal(recipe.ingredients[0].group, "Kaplama", "kayıtlı tarif değişmez");
});
