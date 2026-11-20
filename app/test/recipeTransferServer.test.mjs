// Kişisel tarifi aileye taşı/kopyala: istemci yardımcısı (src/recipeTransfer.js)
// gerçek /api/data işleyicisine karşı. Aile yetkisi, Plus kilidi ve sürümlü
// yazım sunucuda; reddedilen aile yazımında kişisel tarif asla silinmez.
import test from "node:test";
import assert from "node:assert/strict";
import { invoke, resetDb, db } from "./helpers/fakeServices.mjs";

const { default: dataHandler } = await import("../api/data.js");
const { transferRecipe } = await import("../src/recipeTransfer.js");

const RECIPE = {
  id: "1700000000000-abc123",
  title: "Mercimek Çorbası",
  category: "Çorba",
  createdAt: 1700000000000,
  addedBy: "Ayşe",
  isFavorite: true,
  link: "https://www.instagram.com/p/X1/",
  servings: 5,
  servings_basis: "hesap",
  servings_range: [4, 6],
  ingredients: [
    { group: "Çorba", name: "kırmızı mercimek", amount: "1 su bardağı" },
    { group: "Sos", name: "tereyağı", amount: "1 yemek kaşığı", approx: true },
  ],
  instructions: ["Haşla.", "Blenderdan geçir."],
  tips: ["Limonla servis et."],
  nutrition: { calories: 180, protein_g: 9 },
  assumptions: "Tuz göz kararı.",
  content_lang: "tr",
};

function seed({ isPlus = true, families = ["F1"] } = {}) {
  resetDb();
  db.set("user:A:profile", JSON.stringify({ isPlus, families }));
  db.set("user:A:recipes", JSON.stringify([RECIPE, { id: "1700000000001-keep01", title: "Diğer" }]));
  db.set("family:F1:meta", JSON.stringify({ name: "Ev", ownerUid: "A", inviteCode: "ABCDEF" }));
  db.set("family:F1:members", JSON.stringify({ A: { joinedAt: 1 } }));
  db.set("family:F1:recipes", JSON.stringify([]));
  db.set("family:F9:meta", JSON.stringify({ name: "Başka", ownerUid: "B", inviteCode: "ZZZZZZ" }));
  db.set("family:F9:members", JSON.stringify({ B: { joinedAt: 1 } }));
  db.set("family:F9:recipes", JSON.stringify([]));
}

const scopeQuery = (key) => (key === "personal" ? { scope: "personal" } : { scope: "family", familyId: key });

// syncedBuckets'in yaptığı gibi: oku → updater → baseVersion ile yaz. Hata fırlatır.
async function mutate(scopeKey, updater) {
  const got = await invoke(dataHandler, { method: "GET", uid: "A", query: { bucket: "recipes", ...scopeQuery(scopeKey) } });
  if (got.status !== 200) throw Object.assign(new Error(got.body?.error || "read"), { status: got.status, code: got.body?.code });
  const list = JSON.parse(got.body.value || "[]");
  const next = updater(list);
  if (next === list) return;
  const put = await invoke(dataHandler, {
    uid: "A",
    body: { bucket: "recipes", ...scopeQuery(scopeKey), value: JSON.stringify(next), baseVersion: got.body.version },
  });
  if (put.status !== 200) throw Object.assign(new Error(put.body?.error || "write"), { status: put.status, code: put.body?.code });
}

// Taşımadan önce aile kopyasının sunucuda gerçekten var ve erişilebilir olduğu
// (istemcideki gibi) taze bir GET ile doğrulanır.
async function verify(familyId, id) {
  const got = await invoke(dataHandler, { method: "GET", uid: "A", query: { bucket: "recipes", scope: "family", familyId } });
  if (got.status !== 200) return false;
  return JSON.parse(got.body.value || "[]").some((r) => r && r.id === id);
}

const read = (key) => JSON.parse(db.get(key));
const FAM_COPY = { ...RECIPE, id: `${RECIPE.id}-fam-F1` };
// İstemcide tarif görünüm alanlarıyla gelir; bunlar kayda girmemeli.
const shown = { ...RECIPE, _scopes: ["personal"], _origTitle: RECIPE.title, _translation: { status: "idle" } };

test("Taşı: aileye bütün alanlarıyla yazılır, kişisel kopya kalkar, diğer tarifler kalır", async () => {
  seed();
  const out = await transferRecipe({ recipe: shown, familyIds: ["F1"], mode: "move", mutate, verify, personalKey: "personal" });
  assert.deepEqual(out.saved, ["F1"]);
  assert.equal(out.removedFromPersonal, true);
  assert.deepEqual(read("family:F1:recipes"), [FAM_COPY]);
  assert.deepEqual(read("user:A:recipes").map((r) => r.title), ["Diğer"]);
});

test("Kopyala: aile kopyası bağımsız (ayrı kimlik, aynı içerik); tekrar kopyalama ikinci kopya yaratmaz", async () => {
  seed();
  await transferRecipe({ recipe: shown, familyIds: ["F1"], mode: "copy", mutate, verify, personalKey: "personal" });
  await transferRecipe({ recipe: shown, familyIds: ["F1"], mode: "copy", mutate, verify, personalKey: "personal" });
  assert.deepEqual(read("family:F1:recipes"), [FAM_COPY]);
  assert.equal(read("user:A:recipes").length, 2);
});

test("Bağımsızlık: ailede düzenleme/silme kişiseli, kişiselde düzenleme/silme aileyi etkilemez", async () => {
  seed();
  await transferRecipe({ recipe: shown, familyIds: ["F1"], mode: "copy", mutate, verify, personalKey: "personal" });
  // Uygulamanın düzenlemesi: tarifin bulunduğu kapsamlarda o kimliği günceller.
  const edit = (id, patch) => (list) => (list.some((r) => r.id === id) ? list.map((r) => (r.id === id ? { ...r, ...patch } : r)) : list);
  const remove = (id) => (list) => list.filter((r) => r.id !== id);
  await mutate("F1", edit(FAM_COPY.id, { title: "Ailenin Çorbası" }));
  assert.equal(read("user:A:recipes")[0].title, "Mercimek Çorbası");
  await mutate("personal", edit(RECIPE.id, { servings: 2 }));
  assert.equal(read("family:F1:recipes")[0].servings, 5);
  await mutate("personal", remove(RECIPE.id));
  assert.equal(read("family:F1:recipes").length, 1, "kişisel silme aile kopyasını silmez");
  await transferRecipe({ recipe: { ...RECIPE, id: "1700000000002-other1" }, familyIds: ["F1"], mode: "copy", mutate, verify, personalKey: "personal" });
  await mutate("F1", remove(FAM_COPY.id));
  assert.equal(read("user:A:recipes").length, 1, "aile silmesi kişisel listeye dokunmaz");
});

test("Üyesi olunmayan aile: sunucu reddeder, kişisel tarif silinmez", async () => {
  seed();
  const out = await transferRecipe({ recipe: shown, familyIds: ["F9"], mode: "move", mutate, verify, personalKey: "personal" });
  assert.equal(out.failed.length, 1);
  assert.equal(out.failed[0].error.status, 403);
  assert.equal(out.removedFromPersonal, false);
  assert.equal(read("user:A:recipes").length, 2);
  assert.deepEqual(read("family:F9:recipes"), []);
});

test("Plus kapalı (aile kilitli): taşıma reddedilir, kişisel tarif korunur", async () => {
  seed({ isPlus: false, families: ["F1"] });
  const out = await transferRecipe({ recipe: shown, familyIds: ["F1"], mode: "move", mutate, verify, personalKey: "personal" });
  assert.equal(out.failed.length, 1);
  assert.equal(out.failed[0].error.status, 403);
  assert.equal(out.removedFromPersonal, false);
  assert.equal(read("user:A:recipes").length, 2);
  assert.deepEqual(read("family:F1:recipes"), []);
});

test("Kısmi taşıma (izinli + izinsiz aile): izinli aileye yazılır, kişisel kopya kalır", async () => {
  seed();
  const out = await transferRecipe({ recipe: shown, familyIds: ["F1", "F9"], mode: "move", mutate, verify, personalKey: "personal" });
  assert.deepEqual(out.saved, ["F1"]);
  assert.equal(out.failed[0].scopeKey, "F9");
  assert.equal(out.removedFromPersonal, false);
  assert.deepEqual(read("family:F1:recipes"), [FAM_COPY]);
  assert.equal(read("user:A:recipes").length, 2);
});
