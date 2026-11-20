// Özel kategoriler: ad doğrulama, kimlikli model, aile kategorileri, eski (d2254df) kayıtlar.
import test from "node:test";
import assert from "node:assert/strict";
import {
  CATEGORIES,
  validateNewCategory,
  normalizeCustomCategories,
  isAcceptableRecipeCategory,
  cleanCategoryName,
  cleanCategoryRef,
  categoryOf,
  categoryOptions,
  categoryFields,
  legacyCategoryId,
  legacyCategoryRef,
} from "./categories.js";

const SOUPS = { id: "c0011aa22bb33cc44", name: "Çorbalar", lang: "tr" };
const ME = { uid: "uidEmre", name: "Emre" };
const ctx = { me: ME, mine: [SOUPS] };

test("ad olduğu gibi korunur, yalnızca boşluk/kontrol karakteri temizlenir", () => {
  assert.equal(cleanCategoryName("  Çorbalar\u0000  ve   Yahniler "), "Çorbalar ve Yahniler");
  assert.equal(cleanCategoryName("Meal Prep"), "Meal Prep");
});

test("sabit kategorilerle (iki dildeki adıyla), Diğer ve eski adlarla çakışan ad reddedilir", () => {
  for (const name of ["Kahvaltı", "kahvaltı", "BREAKFAST", "Desserts", "Diğer", "Other", "Öğle Yemeği", "Atıştırmalık & Soslar"]) {
    assert.equal(validateNewCategory(name, []), "category_reserved", name);
  }
  assert.equal(validateNewCategory("Çorbalar", []), null);
  assert.equal(validateNewCategory("çorbalar", [SOUPS]), "category_exists");
  assert.equal(validateNewCategory("   ", []), "category_empty");
  assert.equal(validateNewCategory("x".repeat(41), []), "category_too_long");
  assert.equal(validateNewCategory("Yeni", Array.from({ length: 30 }, (_, i) => ({ id: `c000${i}x`, name: `K${i}` }))), "category_limit");
});

test("profil listesi: eski metin girdiler addan türeyen sabit kimlik alır; bozuk/tekrarlı ayıklanır", () => {
  const out = normalizeCustomCategories(["Çorbalar", "çorbalar", "", 5, "Tatlılar", { id: "c1234abcd", name: "Salatalar", lang: "en" }]);
  assert.deepEqual(out, [
    { id: legacyCategoryId("Çorbalar"), name: "Çorbalar", lang: "tr" },
    { id: "c1234abcd", name: "Salatalar", lang: "en" },
  ]);
  assert.equal(legacyCategoryId("Çorbalar"), legacyCategoryId("  çorbalar "));
  assert.deepEqual(normalizeCustomCategories(null), []);
});

test("tarife yazılabilecek kategori adı ve bağ (categoryRef) temizliği", () => {
  assert.ok(isAcceptableRecipeCategory("Kahvaltı"));
  assert.ok(isAcceptableRecipeCategory("Çorbalar"));
  assert.equal(isAcceptableRecipeCategory("  Çorbalar"), false);
  assert.equal(isAcceptableRecipeCategory("Breakfast"), false);
  assert.deepEqual(cleanCategoryRef({ id: "c1234abcd", uid: "u_1", by: " Emre ", lang: "xx", extra: 1 }), { id: "c1234abcd", uid: "u_1", by: "Emre", lang: "tr" });
  assert.equal(cleanCategoryRef({ id: "<script>", uid: "u" }), null);
  assert.equal(cleanCategoryRef(null), null);
});

test("kategori kimlikle belirlenir: kendi kategorim, eski adla kayıt, aynı adlı başka üye ayrı", () => {
  const mine = categoryOf({ category: "Çorbalar", categoryRef: { id: SOUPS.id, uid: ME.uid, lang: "tr" } }, ctx);
  assert.equal(mine.key, `u:${ME.uid}:${SOUPS.id}`);
  assert.equal(mine.mine, true);
  // d2254df: bağsız ama aynı adlı → benim kategorim.
  assert.equal(categoryOf({ category: "çorbalar" }, ctx).key, mine.key);
  // Başka üyenin aynı adlı kategorisi ayrı kalır.
  const ayse = categoryOf({ category: "Çorbalar", categoryRef: { id: "c9999zz", uid: "uidAyse", by: "Ayşe", lang: "tr" } }, ctx);
  assert.equal(ayse.key, "u:uidAyse:c9999zz");
  assert.equal(ayse.mine, false);
  assert.equal(ayse.ref.by, "Ayşe");
  assert.equal(categoryOf({ category: "Kahvaltı" }, ctx).fixed, true);
  assert.equal(categoryOf({ category: "" }, ctx), null);
  // Dil değişse de kayıt aynı: alanlar yalnızca ad + bağ.
  assert.deepEqual(categoryFields(mine), { category: "Çorbalar", categoryRef: { id: SOUPS.id, uid: ME.uid, by: "Emre", lang: "tr" } });
  assert.deepEqual(categoryFields(categoryOf({ category: "Tatlılar" }, ctx)), { category: "Tatlılar", categoryRef: undefined });
});

test("seçenekler: sabitler + kendi kategorilerim (boş olsa da) + verilen tariflerdeki diğer üyelerin kategorileri", () => {
  const familyRecipes = [
    { category: "Çorbalar", categoryRef: { id: "c9999zz", uid: "uidAyse", by: "Ayşe", lang: "tr" } },
    { category: "Çorbalar", categoryRef: { id: SOUPS.id, uid: ME.uid, lang: "tr" } },
    { category: "Kahvaltı" },
  ];
  const keys = categoryOptions(ctx, familyRecipes).map((d) => d.key);
  assert.deepEqual(keys, [...CATEGORIES.map((c) => `f:${c}`), `u:${ME.uid}:${SOUPS.id}`, "u:uidAyse:c9999zz"]);
  // Kişisel kayıtta (aile tarifleri verilmezse) üyelerin kategorileri yok.
  assert.equal(categoryOptions(ctx, []).length, CATEGORIES.length + 1);
});

// ---- Bağsız (d2254df) aile tarifleri: sahip ekleyenden çözülür ----
const legacyId = legacyCategoryId;
const describeOf = categoryOf;

const MEMBERS = [
  { uid: "EMRE", name: "Emre" },
  { uid: "AYSE", name: "Ayşe" },
];

test("legacyCategoryRef: tek eşleşen üye sahip; belirsiz/eşleşmeyen/sabit/bağlı tarifte null", () => {
  const r = { id: "x-fam-F", category: "Çorba", addedBy: "Emre" };
  assert.deepEqual(legacyCategoryRef(r, MEMBERS), { id: legacyId("Çorba"), uid: "EMRE", by: "Emre", lang: "tr" });
  assert.equal(legacyCategoryRef({ ...r, addedBy: "Kimse" }, MEMBERS), null);
  assert.equal(legacyCategoryRef(r, [...MEMBERS, { uid: "E2", name: "emre" }]), null, "aynı adlı iki üye: belirsiz");
  assert.equal(legacyCategoryRef({ ...r, category: "Tatlılar" }, MEMBERS), null, "sabit kategori");
  assert.equal(legacyCategoryRef({ ...r, categoryRef: { id: "c1234", uid: "EMRE", by: "Emre", lang: "tr" } }, MEMBERS), null);
  // Aynı listede o üyenin aynı adlı BAĞLI tarifi varsa onun bağı.
  const sibling = { category: "çorba", categoryRef: { id: "cabcdef12", uid: "EMRE", by: "Emre", lang: "tr" } };
  assert.deepEqual(legacyCategoryRef(r, MEMBERS, [sibling]), sibling.categoryRef);
});

test("categoryOf: başka üyenin bağsız aile tarifi izleyenin aynı adlı kendi kategorisine bağlanmaz", () => {
  const ayseCtx = {
    me: { uid: "AYSE", name: "Ayşe" },
    mine: [{ id: "cayse0001", name: "Çorba", lang: "tr" }],
    legacyRefOf: (r) => (r._scopes.includes("personal") ? null : legacyCategoryRef(r, MEMBERS)),
  };
  const emresOld = { id: "x-fam-F", category: "Çorba", addedBy: "Emre", _scopes: ["F"] };
  const d = describeOf(emresOld, ayseCtx);
  assert.equal(d.key, `u:EMRE:${legacyId("Çorba")}`);
  assert.equal(d.ref.by, "Emre");
  assert.equal(d.mine, false);
  // Ayşe'nin kendi eklediği bağsız tarif kendi kategorisine bağlanır (eski davranış).
  const ayses = { id: "y-fam-F", category: "Çorba", addedBy: "Ayşe", _scopes: ["F"] };
  assert.equal(describeOf(ayses, ayseCtx).key, "u:AYSE:cayse0001");
  // Emre'nin kendisinde: kendi adlı kategorisine bağlanır.
  const emreCtx = { me: { uid: "EMRE", name: "Emre" }, mine: [{ id: legacyId("Çorba"), name: "Çorba", lang: "tr" }], legacyRefOf: ayseCtx.legacyRefOf };
  assert.equal(describeOf(emresOld, emreCtx).key, `u:EMRE:${legacyId("Çorba")}`);
  assert.equal(describeOf(emresOld, emreCtx).mine, true);
});
