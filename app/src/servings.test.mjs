// Dinamik porsiyonda "pratik miktar" (tam adede yuvarlama) testleri.
// Çalıştırma: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { scaleIngredient, isWholeUnitName, practicalWholeQuantity } from "./servings.js";

const scale = (name, amount, factor, decimal = ",") => scaleIngredient({ name, amount }, factor, decimal);
const text = (name, amount, factor) => scale(name, amount, factor).text;

test("tam adet: yumurta ,5 yukarı ve en az 1", () => {
  const r = scale("Yumurta", "3 adet", 0.5);
  assert.equal(r.text, "2 adet");
  assert.deepEqual(r.exact, [1.5, null]);
  assert.equal(r.rounded, true);
  assert.equal(text("Yumurta", "5 adet", 0.5), "3 adet");
  assert.equal(text("Yumurta", "1 adet", 0.5), "1 adet");
  assert.equal(text("Yumurta", "1 adet", 0.25), "1 adet");
  assert.equal(text("yumurta", "3", 0.5), "2");
  assert.equal(text("Yumurta", "3 yumurta", 0.5), "2 yumurta");
  assert.equal(text("Yumurta", "2 orta boy", 1.5), "3 orta boy");
  assert.equal(text("Oda sıcaklığında yumurta", "3 adet", 0.5), "2 adet");
});

test("tam adet: yumurta sarısı ve akı", () => {
  assert.equal(text("Yumurta sarısı", "5 adet", 0.5), "3 adet");
  assert.equal(text("Yumurta akı", "3 adet", 0.5), "2 adet");
  assert.equal(text("Yumurta sarısı", "3", 0.5), "2");
});

test("tam adet: tavuk but, baget ve köfte", () => {
  assert.equal(text("Tavuk but", "5 adet", 0.5), "3 adet");
  assert.equal(text("Tavuk baget", "5 adet", 0.5), "3 adet");
  assert.equal(text("Köfte", "5 adet", 0.5), "3 adet");
  assert.equal(text("İçli köfte", "5 adet", 0.5), "3 adet");
});

test("bölünebilir: soğan, limon, domates, avokado kesirli kalır", () => {
  assert.equal(text("Soğan", "3 adet", 0.5), "1½ adet");
  assert.equal(text("Limon", "1 adet", 0.5), "½ adet");
  assert.equal(text("Domates", "3 adet", 0.5), "1½ adet");
  assert.equal(text("Avokado", "1 adet", 0.5), "½ adet");
  assert.equal(scale("Soğan", "3 adet", 0.5).rounded, false);
});

test("ölçü: g, bardak, kaşık, paket mevcut biçimde ölçeklenir", () => {
  assert.equal(text("Tavuk", "300 g", 0.5), "150 g");
  assert.equal(text("Süt", "1 su bardağı", 0.5), "½ su bardağı");
  assert.equal(text("Sıvı yağ", "3 yemek kaşığı", 0.5), "1½ yemek kaşığı");
  assert.equal(text("Krema", "1 paket", 0.5), "½ paket");
  // tam adet listesindeki bir malzeme ölçüyle yazılmışsa da yuvarlanmaz
  assert.equal(text("Yumurta", "100 g", 0.25), "25 g");
  assert.equal(text("Köfte", "500 g", 0.5), "250 g");
  assert.equal(text("Yumurta", "1 su bardağı", 0.5), "½ su bardağı");
});

test("false positive: yumurtalı erişte, yumurta büyüklüğünde tereyağı, bilinmeyen adet", () => {
  assert.equal(isWholeUnitName("yumurtalı erişte"), false);
  assert.equal(isWholeUnitName("yumurta büyüklüğünde tereyağı"), false);
  assert.equal(isWholeUnitName("bıldırcın yumurtası"), false);
  assert.equal(isWholeUnitName("köfte harcı"), false);
  assert.equal(isWholeUnitName("kuzu but"), false);
  assert.equal(isWholeUnitName("baget ekmek"), false);
  assert.equal(text("Yumurtalı erişte", "3 adet", 0.5), "1½ adet");
  assert.equal(text("Tereyağı", "1 yumurta büyüklüğünde", 0.5), "½ yumurta büyüklüğünde");
  assert.equal(text("Karnabahar", "3 adet", 0.5), "1½ adet");
  assert.equal(text("Kuzu but", "1 adet", 0.5), "½ adet");
});

test("aralık: alt ve üst ayrı yuvarlanır, ters dönmez, eşitse tek sayı", () => {
  assert.equal(text("Yumurta", "2-3 adet", 0.5), "1–2 adet");
  assert.equal(text("Yumurta", "1-2 adet", 0.25), "1 adet");
  assert.equal(text("Soğan", "2-3 adet", 0.5), "1–1½ adet");
});

test("belirsiz miktarlar ve katsayı 1 dokunulmadan kalır", () => {
  assert.equal(scale("Tuz", "bir tutam", 0.5).status, "same");
  assert.equal(text("Tuz", "1 tutam", 0.5), "1 tutam");
  assert.equal(text("Maydanoz", "servis için", 0.5), "servis için");
  assert.equal(text("Yumurta", "3 adet", 1), "3 adet");
  assert.equal(text("Yumurta", "", 0.5), "");
});

test("yapılandırılmış quantity/unit alanı da aynı kurala uyar", () => {
  assert.equal(scaleIngredient({ name: "Yumurta", quantity: 3, unit: "adet" }, 0.5).text, "2 adet");
  assert.equal(scaleIngredient({ name: "Soğan", quantity: 3, unit: "adet" }, 0.5).text, "1½ adet");
  assert.equal(scaleIngredient({ name: "Yumurta", quantity: 100, unit: "g" }, 0.5).text, "50 g");
});

test("practicalWholeQuantity", () => {
  assert.deepEqual([1.2, 1.4, 1.5, 1.6, 2.5, 3.5, 0.25, 0.4].map(practicalWholeQuantity), [1, 1, 2, 2, 3, 4, 1, 1]);
});

test("kaynak kesirliyse (yarım/½/1½ yumurta) yuvarlanmaz", () => {
  assert.equal(text("Yumurta", "yarım", 0.5), "¼");
  assert.equal(text("Yumurta", "1½ adet", 0.5), "¾ adet");
  assert.equal(text("Tavuk but", "1/2 adet", 2), "1 adet");
  assert.equal(scaleIngredient({ name: "Yumurta", quantity: 1.5, unit: "adet" }, 0.5).text, "¾ adet");
});

test("exactText: yalnızca yuvarlanan satırda, yuvarlamadan önceki miktar", () => {
  assert.equal(scale("Yumurta", "3 adet", 0.5).exactText, "1½ adet");
  assert.equal(scale("Yumurta sarısı", "5 adet", 0.5).exactText, "2½ adet");
  assert.equal(scale("Yumurta", "2-3 adet", 0.5).exactText, "1–1½ adet");
  assert.equal(scale("Yumurta", "1 adet", 0.25).exactText, "¼ adet");
  assert.equal(scaleIngredient({ name: "Yumurta", quantity: 3, unit: "adet" }, 0.5).exactText, "1½ adet");
  assert.equal(scale("Yumurta", "4 adet", 0.5).exactText, undefined); // 2 zaten tam sayı
  assert.equal(scale("Soğan", "3 adet", 0.5).exactText, undefined);
  assert.equal(scale("Yumurta", "3 adet", 1).rounded, undefined);
});
