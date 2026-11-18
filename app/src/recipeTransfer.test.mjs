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

const stored = storableRecipe(RECIPE);

test("storableRecipe görünüm alanlarını atar, diğer her alanı aynen korur", () => {
  assert.deepEqual(Object.keys(stored).filter((k) => k.startsWith("_")), []);
  const { _scopes, _translation, _origTitle, ...rest } = RECIPE;
  assert.deepEqual(stored, rest);
});

test("Taşı: aileye yazılır, sonra kişisel kopya kalkar; tüm alanlar korunur", async () => {
  const s = store({ personal: [stored, { id: "r2" }], F1: [] });
  const out = await transferRecipe({ recipe: RECIPE, familyIds: ["F1"], mode: "move", mutate: s.mutate, personalKey: "personal" });
  assert.deepEqual(out.saved, ["F1"]);
  assert.equal(out.removedFromPersonal, true);
  assert.deepEqual(s.lists.get("F1"), [stored]);
  assert.deepEqual(s.lists.get("personal"), [{ id: "r2" }]);
  assert.deepEqual(s.writes, ["F1", "personal"], "önce aile, sonra kişisel silme");
});

test("Taşı: aileye yazım başarısızsa kişisel tarif korunur", async () => {
  const s = store({ personal: [stored], F1: [] }, new Set(["F1"]));
  const out = await transferRecipe({ recipe: RECIPE, familyIds: ["F1"], mode: "move", mutate: s.mutate, personalKey: "personal" });
  assert.equal(out.failed[0].scopeKey, "F1");
  assert.equal(out.removedFromPersonal, false);
  assert.deepEqual(s.lists.get("personal"), [stored]);
});

test("Taşı (iki aile): biri başarısızsa kişisel kopya silinmez; tekrar deneme kopya üretmez", async () => {
  const fail = new Set(["F2"]);
  const s = store({ personal: [stored], F1: [], F2: [] }, fail);
  let out = await transferRecipe({ recipe: RECIPE, familyIds: ["F1", "F2"], mode: "move", mutate: s.mutate, personalKey: "personal" });
  assert.deepEqual(out.saved, ["F1"]);
  assert.equal(out.removedFromPersonal, false);
  assert.deepEqual(s.lists.get("personal"), [stored]);
  fail.clear();
  out = await transferRecipe({ recipe: RECIPE, familyIds: ["F1", "F2"], mode: "move", mutate: s.mutate, personalKey: "personal" });
  assert.equal(out.removedFromPersonal, true);
  assert.equal(s.lists.get("F1").length, 1, "F1'de ikinci kopya yok");
  assert.equal(s.lists.get("F2").length, 1);
  assert.deepEqual(s.lists.get("personal"), []);
});

test("Kopyala: aileye eklenir, kişisel kopya kalır", async () => {
  const s = store({ personal: [stored], F1: [] });
  const out = await transferRecipe({ recipe: RECIPE, familyIds: ["F1"], mode: "copy", mutate: s.mutate, personalKey: "personal" });
  assert.equal(out.removedFromPersonal, false);
  assert.deepEqual(s.lists.get("personal"), [stored]);
  assert.deepEqual(s.lists.get("F1"), [stored]);
});

test("Taşı: aileye yazıldı ama kişisel silme başarısız → removeError döner, tarif iki yerde de kalır", async () => {
  const s = store({ personal: [stored], F1: [] }, new Set());
  const original = s.mutate;
  const mutate = (k, u) => (k === "personal" ? Promise.reject(new Error("ağ")) : original(k, u));
  const out = await transferRecipe({ recipe: RECIPE, familyIds: ["F1"], mode: "move", mutate, personalKey: "personal" });
  assert.equal(out.removedFromPersonal, false);
  assert.match(out.removeError.message, /ağ/);
  assert.deepEqual(s.lists.get("F1"), [stored]);
});

test("Hedef yoksa ya da yalnızca kişisel verildiyse hiçbir şey yazılmaz/silinmez", async () => {
  const s = store({ personal: [stored] });
  const out = await transferRecipe({ recipe: RECIPE, familyIds: ["personal"], mode: "move", mutate: s.mutate, personalKey: "personal" });
  assert.equal(out.removedFromPersonal, false);
  assert.deepEqual(s.writes, []);
});
