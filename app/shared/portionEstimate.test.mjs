// Porsiyon hesabının sabit kuralları için matematiksel testler (AI çağrısı yok).
// Çalıştırma: npm test  (ya da: node --test shared/)
import test from "node:test";
import assert from "node:assert/strict";
import { estimateServings, applyPortionEstimate, describeEstimate } from "./portionEstimate.js";

const item = (name, kind, quantity, unit, extra = {}) => ({
  name, kind, quantity, unit, size: null, state: "cig", quantity_in_source: true, ...extra,
});
const scale = (portion, k) => ({
  ...portion,
  items: portion.items.map((it) => (it.quantity == null ? it : { ...it, quantity: it.quantity * k })),
});
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9 * Math.max(1, Math.abs(b)), `${msg}: ${a} != ${b}`);

const CHICKEN = {
  dish_type: "ana_yemek",
  cooking_method: "firin",
  items: [
    item("kemikli tavuk but", "tavuk_kemikli", 500, "g"),
    item("patates", "patates", 2, "adet", { size: "orta" }),
    item("zeytinyağı", "sivi_yag", 1, "yemek_kasigi"),
    item("kekik", "baharat_tuz", 1, "cay_kasigi"),
    item("tuz", "baharat_tuz", null, "belirsiz"),
  ],
};
const SOUP = {
  dish_type: "corba",
  cooking_method: "haslama_sulu",
  items: [
    item("kırmızı mercimek", "mercimek", 1, "su_bardagi"),
    item("soğan", "sebze", 1, "adet"),
    item("havuç", "sebze", 1, "adet"),
    item("tereyağı", "tereyagi", 1, "yemek_kasigi"),
    item("su", "su", 5, "su_bardagi"),
  ],
};
const PILAF = {
  dish_type: "yan_yemek",
  cooking_method: "haslama_sulu",
  items: [
    item("pirinç", "pirinc", 1, "su_bardagi"),
    item("tavuk suyu", "et_suyu", 1.5, "su_bardagi"),
    item("tereyağı", "tereyagi", 1, "yemek_kasigi"),
  ],
};
const CAKE = {
  dish_type: "tatli_kek",
  cooking_method: "firin",
  items: [
    item("yumurta", "yumurta", 3, "adet"),
    item("şeker", "seker", 1, "su_bardagi"),
    item("süt", "sut", 1, "su_bardagi"),
    item("sıvı yağ", "sivi_yag", 1, "su_bardagi"),
    item("un", "un", 2.5, "su_bardagi"),
    item("kakao", "katki", 3, "yemek_kasigi"),
  ],
};

test("aynı girdi her seferinde aynı sonucu verir", () => {
  const a = estimateServings(CHICKEN);
  const b = estimateServings(structuredClone(CHICKEN));
  assert.deepEqual(a, b);
  assert.equal(describeEstimate(a), describeEstimate(b));
});

for (const [name, portion] of Object.entries({ CHICKEN, SOUP, PILAF, CAKE })) {
  test(`${name}: yuvarlanmamış porsiyon malzemelerle doğrusal ölçeklenir (1x/2x/5x)`, () => {
    const r1 = estimateServings(portion);
    const r2 = estimateServings(scale(portion, 2));
    const r5 = estimateServings(scale(portion, 5));
    assert.equal(r1.status, "hesaplandi");
    close(r2.raw, 2 * r1.raw, "2x");
    close(r5.raw, 5 * r1.raw, "5x");
    assert.equal(r1.perServingG, r5.perServingG);
  });
}

test("tavuk/patates örneği: bilinen hesap", () => {
  const r = estimateServings(CHICKEN);
  // 500 g x 0.49 = 245; 2 x 213 g x 0.77 = 328.02; 15 mL x 0.92 = 13.8
  close(r.yieldG, 245 + 426 * 0.77 + 13.8, "verim");
  assert.equal(r.perServingG, 200);
  assert.equal(r.servings, 3);
});

test("çorba verimi yalnızca suya dayanmaz: tüm malzemeler x 0.90", () => {
  const r = estimateServings(SOUP);
  const expected = (200 * 0.89 + 110 + 61 + 15 * 0.91 + 1000) * 0.9;
  close(r.yieldG, expected, "çorba verimi");
  const waterOnly = 1000 * 0.9;
  assert.ok(r.yieldG > waterOnly);
});

test("pilav: et suyu ayrıca sayılmaz (pirinç katsayısı suyu içerir)", () => {
  const r = estimateServings(PILAF);
  close(r.yieldG, 200 * 0.82 * 2.98 + 15 * 0.91, "pilav verimi");
  const moreStock = estimateServings({ ...PILAF, items: PILAF.items.map((i) => (i.kind === "et_suyu" ? { ...i, quantity: 3 } : i)) });
  close(moreStock.yieldG, r.yieldG, "suyun miktarı verimi değiştirmez");
});

test("eşdeğer birimler aynı sonucu verir", () => {
  const g = estimateServings({ dish_type: "ana_yemek", cooking_method: "firin", items: [item("tavuk", "tavuk_kemikli", 1000, "g")] });
  const kg = estimateServings({ dish_type: "ana_yemek", cooking_method: "firin", items: [item("tavuk", "tavuk_kemikli", 1, "kg")] });
  close(g.raw, kg.raw, "g/kg");
  const soup = (unit, q) => estimateServings({ dish_type: "corba", cooking_method: "haslama_sulu", items: [item("mercimek", "mercimek", 200, "g"), item("su", "su", q, unit)] });
  close(soup("ml", 1000).raw, soup("l", 1).raw, "ml/l");
  close(soup("l", 1).raw, soup("su_bardagi", 5).raw, "l/su bardağı (200 mL kabulü)");
});

test("kemikli ağırlık kemiksizden daha az yenebilir verim verir", () => {
  const boneIn = estimateServings({ dish_type: "ana_yemek", cooking_method: "firin", items: [item("but", "tavuk_kemikli", 1000, "g")] });
  const boneless = estimateServings({ dish_type: "ana_yemek", cooking_method: "firin", items: [item("but", "tavuk_kemiksiz", 1000, "g")] });
  close(boneIn.yieldG, 490, "kemikli");
  close(boneless.yieldG, 700, "kemiksiz");
});

test("çiğ ve pişmiş girdi: pişmiş malzemeye pişme katsayısı tekrar uygulanmaz", () => {
  const raw = estimateServings({ dish_type: "meze_sos", cooking_method: "cig", items: [item("nohut", "kuru_baklagil", 160, "g")] });
  const cooked = estimateServings({ dish_type: "meze_sos", cooking_method: "cig", items: [item("haşlanmış nohut", "kuru_baklagil", 400, "g", { state: "pismis" })] });
  close(raw.yieldG, 400, "160 g kuru nohut x 2.5");
  close(cooked.yieldG, 400, "400 g haşlanmış nohut");
});

test("adet ve boyut: boyut yoksa orta kabul edilir ve not düşülür", () => {
  const withSize = estimateServings({ dish_type: "garnitur", cooking_method: "haslama_sulu", items: [item("patates", "patates", 2, "adet", { size: "buyuk" })] });
  const noSize = estimateServings({ dish_type: "garnitur", cooking_method: "haslama_sulu", items: [item("patates", "patates", 2, "adet")] });
  close(withSize.yieldG, 738, "2 büyük patates");
  close(noSize.yieldG, 426, "2 orta patates");
  assert.ok(noSize.notes.some((n) => n.includes("orta boy")));
});

test("belirsiz birim ve bilinmeyen adet sessizce gram almaz", () => {
  const r = estimateServings({
    dish_type: "tatli_kek",
    cooking_method: "firin",
    items: [item("un", "un", 300, "g"), item("margarin", "diger", 1, "belirsiz"), item("muz", "sebze", 2, "adet")],
  });
  close(r.yieldG, 300 * 0.92, "yalnızca un sayıldı");
  assert.ok(r.notes.some((n) => n.includes("margarin") && n.includes("muz")));
});

test("ana malzemenin miktarı belirsizse (1 paket makarna) sayı üretilmez", () => {
  const r = estimateServings({
    dish_type: "ana_yemek",
    cooking_method: "firin",
    items: [item("makarna", "makarna_kuru", 1, "belirsiz"), item("süt", "sut", 2, "su_bardagi"), item("tereyağı", "tereyagi", 1, "yemek_kasigi")],
  });
  assert.equal(r.status, "bilgi_yetersiz");
  assert.match(r.notes[0], /makarna/);
});

test("miktarlar kaynakta yoksa porsiyon uydurulmaz", () => {
  const r = estimateServings({
    dish_type: "ana_yemek",
    cooking_method: "firin",
    items: [item("makarna", "makarna_kuru", 500, "g", { quantity_in_source: false }), item("kaşar", "peynir", 100, "g", { quantity_in_source: false })],
  });
  assert.equal(r.status, "bilgi_yetersiz");
  const applied = applyPortionEstimate({ title: "x", servings: null, assumptions: "", portion: { dish_type: "ana_yemek", cooking_method: "firin", items: [] } });
  assert.equal(applied.servings, null);
  assert.equal(applied.servings_basis, "bilinmiyor");
});

test("kaynakta yazan porsiyon korunur (2 ve 6)", () => {
  for (const n of [2, 6]) {
    const out = applyPortionEstimate({ title: "x", servings: n, assumptions: "", portion: CHICKEN });
    assert.equal(out.servings, n);
    assert.equal(out.servings_basis, "kaynak");
    assert.equal(out.portion, undefined);
  }
});

test("desteklenmeyen yemek türünde sayı üretilmez", () => {
  const out = applyPortionEstimate({ title: "x", servings: null, assumptions: "", portion: { ...CHICKEN, dish_type: "diger" } });
  assert.equal(out.servings, null);
  assert.match(out.servings_note, /Porsiyon hesaplanamadı/);
});

test("gösterilen gerekçe uygulanan hesapla aynı sayıları içerir ve assumptions'a karışmaz", () => {
  const out = applyPortionEstimate({ title: "x", servings: null, assumptions: "Tuz eklendi.", portion: CHICKEN });
  assert.equal(out.servings_basis, "hesap");
  assert.equal(out.servings, 3);
  assert.equal(out.servings_calc.per_serving_g, 200);
  assert.equal(out.assumptions, "Tuz eklendi.");
  assert.match(out.servings_note, /^Porsiyon kaynakta yazmadığı için/);
  assert.match(out.servings_note, new RegExp(`≈ ${String(out.servings_calc.yield_g)} g`));
  assert.match(out.servings_note, /÷ 200 ≈ 2,9 → 3 porsiyon/);
});

test("kaynakta yazan porsiyonda gerekçe/hesap alanı yok", () => {
  const out = applyPortionEstimate({ title: "x", servings: 4, assumptions: "", portion: CHICKEN });
  assert.equal(out.servings_note, undefined);
  assert.equal(out.servings_calc, undefined);
});

const eggs = (name, kind = "yumurta", size = null) =>
  estimateServings({ dish_type: "tatli_kek", cooking_method: "firin", items: [item(name, kind, 4, "adet", { size })] });

test("A) 4 yumurta sarısı ≈ 68 g (17 g/adet), boyut notu düşülmez", () => {
  const r = eggs("yumurta sarısı");
  close(r.lines[0].g, 68, "4 × 17");
  assert.ok(!r.notes.some((n) => n.includes("orta boy")));
  close(eggs("Yumurta sarısı", "diger").lines[0].g, 68, "AI 'diger' dese de isimden tanınır");
});

test("B) 4 tam yumurta: mevcut ağırlıklar değişmedi (orta 44, büyük 50)", () => {
  close(eggs("yumurta").lines[0].g, 176, "4 × 44");
  close(eggs("Yumurta (tam)").lines[0].g, 176, "tam yumurta ismi");
  close(eggs("yumurta", "yumurta", "buyuk").lines[0].g, 200, "4 × 50");
  close(eggs("yumurta sarısı ve akı").lines[0].g, 176, "sarı ve ak birlikte → tam yumurta");
});

test("C) 4 yumurta akı = 132 g (33 g/adet); üçü birbirinden farklı", () => {
  close(eggs("yumurta akı").lines[0].g, 132, "4 × 33");
  close(eggs("yumurtanın akları").lines[0].g, 132, "çoğul");
  const ys = [eggs("yumurta").yieldG, eggs("yumurta sarısı").yieldG, eggs("yumurta akı").yieldG];
  assert.equal(new Set(ys).size, 3);
});
