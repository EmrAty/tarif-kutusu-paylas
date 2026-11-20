// "Elimde Bunlar Var" yerel eşleştirme: Türkçe yazım farkları, yanlış eşleşme yok, eksikler açık.
import test from "node:test";
import assert from "node:assert/strict";
import { ingredientAvailable, matchRecipes, foldText, isTapWater } from "./pantryMatch.js";

const has = (name, pantry) => ingredientAvailable([name], pantry);

test("Türkçe harf, büyük/küçük harf ve ek farkları aynı malzeme sayılır", () => {
  assert.equal(foldText("Soğan, İnce Doğranmış"), "sogan ince dogranmis");
  assert.ok(has("Soğanlar", ["sogan"]));
  assert.ok(has("İnce doğranmış kırmızı soğan", ["Soğan"]));
  assert.ok(has("Yumurtalar", ["yumurta"]));
  assert.ok(has("Tereyağı", ["tereyağ"]));
  assert.ok(has("Zeytin yağı", ["zeytinyağı"]));
  assert.ok(has("Tam buğday unu", ["un"]));
  assert.ok(has("Tavuk göğsü", ["tavuk"]));
  assert.ok(has("Tavuk", ["tavuk göğsü"]));
  assert.ok(has("eggs", ["egg"]));
});

test("farklı malzeme ya da başka ürün eşleşmez", () => {
  assert.equal(has("Biberiye", ["biber"]), false);
  assert.equal(has("Sucuk", ["su"]), false);
  assert.equal(has("Susam", ["su"]), false);
  assert.equal(has("Domates salçası", ["domates"]), false);
  assert.equal(has("Fındık unu", ["fındık"]), false);
  assert.equal(has("Tuz", ["un"]), false);
  assert.equal(has("Kimyon", ["un"]), false);
});

test("alternatifli malzemede biri yeter", () => {
  assert.ok(has("Tereyağı ya da margarin", ["margarin"]));
  assert.ok(has("Süt/krema", ["krema"]));
});

test("eşleşme: eksikler listelenir, tam eşleşme ancak hiçbir eksik yoksa", () => {
  const entries = [
    { recipe: { id: "a", title: "Menemen" }, ingredients: [{ name: "Yumurta" }, { name: "Domates" }, { name: "Sivri biber" }, { name: "Su" }] },
    { recipe: { id: "b", title: "Omlet" }, ingredients: [{ name: "Yumurtalar" }, { name: "Tereyağı" }] },
    { recipe: { id: "c", title: "Kek" }, ingredients: [{ name: "Un" }, { name: "Şeker" }] },
  ];
  const out = matchRecipes(entries, ["yumurta", "tereyağ", "domates"]);
  assert.deepEqual(out.map((r) => r.recipe.id), ["b", "a"]);
  assert.equal(out[0].complete, true);
  assert.equal(out[1].complete, false);
  // Su sayıma girmez; eksik yalnızca biber.
  assert.equal(out[1].total, 3);
  assert.deepEqual(out[1].missing.map((m) => m.name), ["Sivri biber"]);
  assert.ok(isTapWater("Ilık su"));
  assert.equal(isTapWater("Maden suyu"), false);
});

test("gösterim dilindeki ad da denenir (İngilizce arayüz, Türkçe tarif)", () => {
  const entries = [{ recipe: { id: "x" }, ingredients: [{ name: "Chicken", names: ["Chicken", "Tavuk"] }] }];
  assert.equal(matchRecipes(entries, ["tavuk"]).length, 1);
  assert.equal(matchRecipes(entries, ["chicken"]).length, 1);
});

test("eldeki malzeme yoksa ya da hiçbir malzeme eşleşmiyorsa sonuç yok", () => {
  const entries = [{ recipe: { id: "c" }, ingredients: [{ name: "Un" }] }];
  assert.deepEqual(matchRecipes(entries, []), []);
  assert.deepEqual(matchRecipes(entries, ["pirinç"]), []);
});
