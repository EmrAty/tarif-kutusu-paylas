import test from "node:test";
import assert from "node:assert/strict";
import { transferRecipe, storableRecipe } from "./recipeTransfer.js";

const RECIPE = {
  id: "r1",
  title: "Mercimek Çorbası",
  servings: null,
  servings_estimate: { min: 4, max: 6, value: 5 },
  servings_basis: "estimated",
  ingredients: [
    { group: "Çorba", name: "mercimek", amount: "1 su bardağı" },
    { group: "Sos", name: "tereyağı", amount: "1 yemek kaşığı", approx: true },
  ],
  instructions: ["Haşla.", "Blenderdan geçir."],
  tips: ["Limonla servis et."],
  nutrition: { calories: 180 },
  content_lang: "tr",
  isFavorite: true,
  _scopes: ["personal"],
  _translation: { status: "ready" },
  _origTitle: "Mercimek Çorbası",
};

// Sürümlü kova taklidi: scopeKey -> liste; fail kümesindeki kapsam yazımı reddeder.
function store(initial, fail = new Set()) {
  const lists = new Map(Object.entries(initial));
  const writes = [];
  const mutate = async (scopeKey, updater) => {
    if (fail.has(scopeKey)) throw Object.assign(new Error("403"), { status: 403 });
    const next = updater(lists.get(scopeKey) || []);
    lists.set(scopeKey, next);
    writes.push(scopeKey);
  };
  return { lists, writes, mutate };
}

// Taze okuma taklidi: aile listesinde kopya gerçekten var mı.
const verifyIn = (s) => async (familyId, id) => (s.lists.get(familyId) || []).some((r) => r && r.id === id);

const stored = storableRecipe(RECIPE);
const famCopy = (id) => ({ ...stored, id: `r1-fam-${id}` });

test("storableRecipe görünüm alanlarını atar, diğer her alanı aynen korur", () => {
  assert.deepEqual(Object.keys(stored).filter((k) => k.startsWith("_")), []);
  const { _scopes, _translation, _origTitle, ...rest } = RECIPE;
  assert.deepEqual(stored, rest);
});

test("Taşı: aileye yazılır, sonra kişisel kopya kalkar; tüm alanlar korunur", async () => {
  const s = store({ personal: [stored, { id: "r2" }], F1: [] });
  const out = await transferRecipe({ recipe: RECIPE, familyIds: ["F1"], mode: "move", mutate: s.mutate, verify: verifyIn(s), personalKey: "personal" });
  assert.deepEqual(out.saved, ["F1"]);
  assert.equal(out.removedFromPersonal, true);
  assert.deepEqual(s.lists.get("F1"), [famCopy("F1")], "aile kopyası kendi kimliğiyle, diğer bütün alanlar aynı");
  assert.deepEqual(s.lists.get("personal"), [{ id: "r2" }]);
  assert.deepEqual(s.writes, ["F1", "personal"], "önce aile, sonra kişisel silme");
});

test("Taşı: aileye yazım başarısızsa kişisel tarif korunur", async () => {
  const s = store({ personal: [stored], F1: [] }, new Set(["F1"]));
  const out = await transferRecipe({ recipe: RECIPE, familyIds: ["F1"], mode: "move", mutate: s.mutate, verify: verifyIn(s), personalKey: "personal" });
  assert.equal(out.failed[0].scopeKey, "F1");
  assert.equal(out.removedFromPersonal, false);
  assert.deepEqual(s.lists.get("personal"), [stored]);
});

test("Taşı (iki aile): biri başarısızsa kişisel kopya silinmez; tekrar deneme kopya üretmez", async () => {
  const fail = new Set(["F2"]);
  const s = store({ personal: [stored], F1: [], F2: [] }, fail);
  let out = await transferRecipe({ recipe: RECIPE, familyIds: ["F1", "F2"], mode: "move", mutate: s.mutate, verify: verifyIn(s), personalKey: "personal" });
  assert.deepEqual(out.saved, ["F1"]);
  assert.equal(out.removedFromPersonal, false);
  assert.deepEqual(s.lists.get("personal"), [stored]);
  fail.clear();
  out = await transferRecipe({ recipe: RECIPE, familyIds: ["F1", "F2"], mode: "move", mutate: s.mutate, verify: verifyIn(s), personalKey: "personal" });
  assert.equal(out.removedFromPersonal, true);
  assert.equal(s.lists.get("F1").length, 1, "F1'de ikinci kopya yok");
  assert.equal(s.lists.get("F2").length, 1);
  assert.deepEqual(s.lists.get("personal"), []);
});

test("Kopyala: aileye eklenir, kişisel kopya kalır", async () => {
  const s = store({ personal: [stored], F1: [] });
  const out = await transferRecipe({ recipe: RECIPE, familyIds: ["F1"], mode: "copy", mutate: s.mutate, verify: verifyIn(s), personalKey: "personal" });
  assert.equal(out.removedFromPersonal, false);
  assert.deepEqual(s.lists.get("personal"), [stored]);
  assert.deepEqual(s.lists.get("F1"), [famCopy("F1")]);
  assert.notEqual(s.lists.get("F1")[0].id, stored.id, "kopya bağımsız: ayrı kimlik");
});

test("Kopyala iki kez / tekrar dene: türetilmiş kimlik aynı, ailede tek kopya", async () => {
  const s = store({ personal: [stored], F1: [] });
  await transferRecipe({ recipe: RECIPE, familyIds: ["F1"], mode: "copy", mutate: s.mutate, verify: verifyIn(s), personalKey: "personal" });
  await transferRecipe({ recipe: RECIPE, familyIds: ["F1"], mode: "copy", mutate: s.mutate, verify: verifyIn(s), personalKey: "personal" });
  assert.deepEqual(s.lists.get("F1"), [famCopy("F1")]);
});

test("Taşı: aileye yazıldı ama kişisel silme başarısız → removeError döner, tarif iki yerde de kalır", async () => {
  const s = store({ personal: [stored], F1: [] }, new Set());
  const original = s.mutate;
  const mutate = (k, u) => (k === "personal" ? Promise.reject(new Error("ağ")) : original(k, u));
  const out = await transferRecipe({ recipe: RECIPE, familyIds: ["F1"], mode: "move", mutate, verify: verifyIn(s), personalKey: "personal" });
  assert.equal(out.removedFromPersonal, false);
  assert.match(out.removeError.message, /ağ/);
  assert.deepEqual(s.lists.get("F1"), [famCopy("F1")]);
});

test("Hedef yoksa ya da yalnızca kişisel verildiyse hiçbir şey yazılmaz/silinmez", async () => {
  const s = store({ personal: [stored] });
  const out = await transferRecipe({ recipe: RECIPE, familyIds: ["personal"], mode: "move", mutate: s.mutate, verify: verifyIn(s), personalKey: "personal" });
  assert.equal(out.removedFromPersonal, false);
  assert.deepEqual(s.writes, []);
});

test("Yeni kayıt (kişisel + aile): kopyalar bağımsız; tekrar dene yalnızca eksik yere yazar, kopya üretmez", async () => {
  const { saveRecipeToTargets, savedRecipeId } = await import("./saveTargets.js");
  const fail = new Set(["F1"]);
  const s = store({ personal: [], F1: [] }, fail);
  const recipe = { id: "n1", title: "Yeni ad", servings: 3 };
  let out = await saveRecipeToTargets(recipe, ["personal", "F1"], s.mutate, "personal");
  assert.deepEqual(out.saved, ["personal"]);
  fail.clear();
  out = await saveRecipeToTargets(recipe, ["F1"], s.mutate, "personal");
  await saveRecipeToTargets(recipe, ["personal", "F1"], s.mutate, "personal");
  assert.deepEqual(s.lists.get("personal"), [recipe]);
  assert.deepEqual(s.lists.get("F1"), [{ ...recipe, id: "n1-fam-F1" }]);
  assert.equal(savedRecipeId(recipe, "F1", "personal"), "n1-fam-F1");
  assert.equal(savedRecipeId(recipe, "personal", "personal"), "n1");
});

test("Kopyala: ailede zaten (sonradan düzenlenmiş) kopya varsa üzerine yazılmaz, çoğalmaz", async () => {
  const edited = { ...famCopy("F1"), title: "Ailede değiştirildi" };
  const s = store({ personal: [stored], F1: [edited] });
  const out = await transferRecipe({ recipe: RECIPE, familyIds: ["F1"], mode: "copy", mutate: s.mutate, verify: verifyIn(s), personalKey: "personal" });
  assert.deepEqual(out.existing, ["F1"]);
  assert.deepEqual(s.lists.get("F1"), [edited]);
  assert.deepEqual(s.lists.get("personal"), [stored]);
});

test("Taşımayı tamamla: kopyası olan ailede mevcut kopya korunur, kişisel kopya ancak doğrulanınca kalkar", async () => {
  const edited = { ...famCopy("F1"), title: "Ailede değiştirildi" };
  const s = store({ personal: [stored], F1: [edited] });
  const out = await transferRecipe({ recipe: RECIPE, familyIds: ["F1"], mode: "move", mutate: s.mutate, verify: verifyIn(s), personalKey: "personal" });
  assert.deepEqual(out.existing, ["F1"]);
  assert.equal(out.removedFromPersonal, true);
  assert.deepEqual(s.lists.get("F1"), [edited]);
  assert.deepEqual(s.lists.get("personal"), []);
});

test("Taşı: doğrulama başarısızsa (kopya sunucuda yok ya da okunamadı) kişisel tarif silinmez", async () => {
  for (const verify of [async () => false, async () => { throw new Error("403"); }, undefined]) {
    const s = store({ personal: [stored], F1: [] });
    const out = await transferRecipe({ recipe: RECIPE, familyIds: ["F1"], mode: "move", mutate: s.mutate, verify, personalKey: "personal" });
    assert.deepEqual(out.verifyFailed, ["F1"]);
    assert.equal(out.removedFromPersonal, false);
    assert.deepEqual(s.lists.get("personal"), [stored]);
  }
});
