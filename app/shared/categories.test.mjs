// Özel kategoriler: ad doğrulama, çakışmalar, bölüm sırası.
import test from "node:test";
import assert from "node:assert/strict";
import {
  CATEGORIES,
  validateNewCategory,
  normalizeCustomCategories,
  isAcceptableRecipeCategory,
  categorySections,
  sectionOf,
  cleanCategoryName,
} from "./categories.js";

test("ad olduğu gibi korunur, yalnızca boşluk/kontrol karakteri temizlenir", () => {
  assert.equal(cleanCategoryName("  Çorbalar\u0000  ve   Yahniler "), "Çorbalar ve Yahniler");
  assert.equal(cleanCategoryName("Meal Prep"), "Meal Prep");
});

test("sabit kategorilerle (iki dildeki adıyla), Diğer ve eski adlarla çakışan ad reddedilir", () => {
  for (const name of ["Kahvaltı", "kahvaltı", "BREAKFAST", "Desserts", "Diğer", "Other", "Öğle Yemeği", "Atıştırmalık & Soslar"]) {
    assert.equal(validateNewCategory(name, []), "category_reserved", name);
  }
  assert.equal(validateNewCategory("Çorbalar", []), null);
  assert.equal(validateNewCategory("çorbalar", ["Çorbalar"]), "category_exists");
  assert.equal(validateNewCategory("   ", []), "category_empty");
  assert.equal(validateNewCategory("x".repeat(41), []), "category_too_long");
  assert.equal(validateNewCategory("Yeni", Array.from({ length: 30 }, (_, i) => `K${i}`)), "category_limit");
});

test("profil listesi okunurken bozuk/tekrarlı kayıtlar ayıklanır", () => {
  assert.deepEqual(normalizeCustomCategories(["Çorbalar", "çorbalar", "", 5, "Tatlılar", "Salatalar"]), ["Çorbalar", "Salatalar"]);
  assert.deepEqual(normalizeCustomCategories(null), []);
});

test("tarife yazılabilecek kategori: sabit ya da temiz özel ad", () => {
  assert.ok(isAcceptableRecipeCategory("Kahvaltı"));
  assert.ok(isAcceptableRecipeCategory("Çorbalar"));
  assert.equal(isAcceptableRecipeCategory(""), false);
  assert.equal(isAcceptableRecipeCategory("  Çorbalar"), false);
  assert.equal(isAcceptableRecipeCategory("Breakfast"), false);
  assert.equal(isAcceptableRecipeCategory(null), false);
});

test("bölümler: sabitler, kendi kategorilerim, sonra tariflerde geçen diğer adlar", () => {
  const recipes = [{ category: "Kahvaltı" }, { category: "Zeynep'in Tarifleri" }, { category: "çorbalar" }, { category: "" }, {}];
  const sections = categorySections(["Çorbalar", "Salatalar"], recipes);
  assert.deepEqual(sections, [...CATEGORIES, "Çorbalar", "Salatalar", "Zeynep'in Tarifleri"]);
  assert.equal(sectionOf({ category: "çorbalar" }, sections), "Çorbalar");
  assert.equal(sectionOf({ category: "" }, sections), null);
});
