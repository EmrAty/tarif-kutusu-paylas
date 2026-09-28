// Porsiyon hesabının sabit kuralları için matematiksel testler (AI çağrısı yok).
// Çalıştırma: npm test  (ya da: node --test shared/)
import test from "node:test";
import assert from "node:assert/strict";
import { estimateServings, applyPortionEstimate, describeEstimate, servingsUnitOf, PORTION_RULES_VERSION } from "./portionEstimate.js";

const item = (name, kind, quantity, unit, extra = {}) => ({
  name, kind, quantity, unit, size: null, state: "cig", quantity_in_source: true, main: false, ...extra,
});
const scale = (portion, k) => ({
  ...portion,
  items: portion.items.map((it) => (it.quantity == null ? it : { ...it, quantity: it.quantity * k })),
});
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9 * Math.max(1, Math.abs(b)), `${msg}: ${a} != ${b}`);

// yemek.com "İzmir Köfte" (4 kişilik) — kızartma yağı dahil.
const KOFTE = {
  dish_type: "ana_yemek",
  cooking_method: "firin",
  items: [
    item("dana kıyma", "kiyma", 500, "g", { main: true }),
    item("kuru soğan", "sebze", 1, "adet"),
    item("sıvı yağ (kızartmak için)", "kizartma_yagi", 2, "su_bardagi"),
    item("patates", "patates", 4, "adet"),
    item("domates", "sebze", 2, "adet"),
    item("tuz", "baharat_tuz", 1, "cay_kasigi"),
  ],
};
// yemek.com "Mercimek Çorbası" (6 kişilik).
const SOUP = {
  dish_type: "corba",
  cooking_method: "haslama_sulu",
  items: [
    item("kırmızı mercimek", "mercimek", 1.5, "su_bardagi", { main: true }),
    item("soğan", "sebze", 1, "adet", { size: "buyuk" }),
    item("havuç", "sebze", 1, "adet"),
    item("patates", "patates", 1, "adet", { size: "buyuk" }),
    item("tereyağı", "tereyagi", 2, "yemek_kasigi"),
    item("su", "su", 6, "su_bardagi"),
  ],
};
// yemek.com "Pirinç Pilavı" (5 kişilik).
const PILAF = {
  dish_type: "yan_yemek",
  cooking_method: "haslama_sulu",
  items: [
    item("pirinç", "pirinc", 2, "su_bardagi", { main: true }),
    item("sıcak su", "su", 2, "su_bardagi"),
    item("tereyağı", "tereyagi", 2, "yemek_kasigi"),
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
const SUTLAC = {
  dish_type: "tatli_sutlu",
  cooking_method: "haslama_sulu",
  items: [
    item("süt", "sut", 1, "l", { main: true }),
    item("pirinç", "pirinc", 40, "g"),
    item("şeker", "seker", 180, "g"),
    item("su", "su", 400, "ml"),
  ],
};
const BEANS = {
  dish_type: "bakliyat_yemegi",
  cooking_method: "haslama_sulu",
  items: [
    item("kuru fasulye", "kuru_baklagil", 500, "g", { main: true }),
    item("kuşbaşı et", "et_kemiksiz", 300, "g"),
    item("soğan", "sebze", 1, "adet"),
    item("salça", "sos_salca", 1, "yemek_kasigi"),
    item("su", "su", 3, "su_bardagi"),
  ],
};

test("aynı girdi her seferinde aynı sonucu verir", () => {
  for (const p of [KOFTE, SOUP, PILAF, CAKE]) {
    const a = estimateServings(p);
    const b = estimateServings(structuredClone(p));
    assert.deepEqual(a, b);
    assert.equal(describeEstimate(a), describeEstimate(b));
  }
});

for (const [name, portion] of Object.entries({ KOFTE, SOUP, PILAF, CAKE, SUTLAC, BEANS })) {
  test(`${name}: yuvarlanmamış aralık malzemelerle doğrusal ölçeklenir (1x/2x/5x)`, () => {
    const r1 = estimateServings(portion);
    const r2 = estimateServings(scale(portion, 2));
    const r5 = estimateServings(scale(portion, 5));
    assert.equal(r1.status, "hesaplandi");
    for (const [r, k] of [[r2, 2], [r5, 5]]) {
      close(r.lo, k * r1.lo, `${k}x alt`);
      close(r.hi, k * r1.hi, `${k}x üst`);
      close(r.raw, k * r1.raw, `${k}x orta`);
      assert.equal(r.method, r1.method);
    }
  });
}

test("köfte: porsiyon ana malzemeden (kişi başı 130–150 g çiğ kıyma) hesaplanır", () => {
  const r = estimateServings(KOFTE);
  close(r.anchor.amount, 500, "kıyma");
  close(r.lo, 500 / 150, "alt");
  close(r.hi, 500 / 130, "üst");
  assert.equal(r.servings, 4);
  assert.equal(r.loInt, 3);
  assert.equal(r.hiInt, 4);
});

test("kızartma yağı verime eklenmez (eski hesapta 2 su bardağı yağ = 368 g verim sayılıyordu)", () => {
  const r = estimateServings(KOFTE);
  const oil = r.yield.lines.find((l) => l.name.includes("kızartmak"));
  assert.equal(oil.y, 0);
  assert.ok(r.notes.some((n) => n.includes("kızartma yağı")));
  const withoutOil = estimateServings({ ...KOFTE, items: KOFTE.items.filter((i) => i.kind !== "kizartma_yagi") });
  close(withoutOil.yield.lo, r.yield.lo, "yağlı ve yağsız verim aynı");
});

test("pilav: pişmiş verim pirinç + tarifteki suyu aşamaz (kütle korunumu)", () => {
  const r = estimateServings(PILAF);
  const rice = r.yield.lines.find((l) => l.name === "pirinç");
  const dry = 2 * 200 * 0.82;
  assert.ok(rice.y <= dry + 400 + 1e-9, `pirinç verimi ${rice.y}`);
  close(rice.y, dry + 400, "sınır uygulandı");
  assert.ok(dry * 2.98 > dry + 400, "sınırsız Bognár katsayısı fiziksel olarak imkânsız verim verirdi");
  // Su artarsa sınır gevşer ama Bognár katsayısını geçemez.
  const wet = estimateServings({ ...PILAF, items: PILAF.items.map((i) => (i.kind === "su" ? { ...i, quantity: 10 } : i)) });
  close(wet.yield.lines.find((l) => l.name === "pirinç").y, dry * 2.98, "bol suda Bognár katsayısı");
});

test("pilav: iki yöntemin örtüşen aralığı; 2 su bardağı pirinç kaynaktaki 5 kişiyi kapsar", () => {
  const r = estimateServings(PILAF);
  assert.equal(r.method, "ikisi");
  assert.ok(r.loInt <= 5 && r.hiInt >= 5, `${r.loInt}–${r.hiInt}`);
});

test("çorba: su dahil toplam kütle, buharlaşma aralığı 0,76–0,92 ile", () => {
  const r = estimateServings(SOUP);
  const total = 1.5 * 200 * 0.89 + 150 + 61 + 369 + 2 * 15 * 0.91 + 1200;
  close(r.yield.lo, total * 0.76, "alt verim");
  close(r.yield.hi, total * 0.92, "üst verim");
  assert.equal(r.method, "ikisi");
  assert.equal(r.servings, 6);
});

test("sütlü tatlı: 1 litre süt, kişi başı 150–200 g süt (MSB, AGU) → 5–7", () => {
  const r = estimateServings(SUTLAC);
  close(r.anchor.amount, 1030, "süt g");
  assert.equal(r.method, "A");
  assert.equal(r.servings, 6);
});

test("bakliyat: ikincil et ana malzeme olmaz; kuru fasulye belirler", () => {
  const r = estimateServings(BEANS);
  assert.deepEqual(r.anchor.names, ["kuru fasulye"]);
  close(r.anchor.lo, 500 / 100, "alt");
  close(r.anchor.hi, 500 / 70, "üst");
});

test("eşdeğer birimler aynı sonucu verir", () => {
  const chicken = (q, unit) => estimateServings({ dish_type: "ana_yemek", cooking_method: "firin", items: [item("tavuk", "tavuk_kemikli", q, unit, { main: true })] });
  close(chicken(1000, "g").raw, chicken(1, "kg").raw, "g/kg");
  const soup = (unit, q) => estimateServings({ dish_type: "corba", cooking_method: "haslama_sulu", items: [item("mercimek", "mercimek", 200, "g"), item("su", "su", q, unit)] });
  close(soup("ml", 1000).raw, soup("l", 1).raw, "ml/l");
  close(soup("l", 1).raw, soup("su_bardagi", 5).raw, "l/su bardağı (200 mL kabulü)");
});

test("kemikli tavuk: kişi başı 250 g çiğ kemikli (MSB, AGU) — 500 g iki kişilik", () => {
  const r = estimateServings({ dish_type: "ana_yemek", cooking_method: "firin", items: [item("tavuk but", "tavuk_kemikli", 500, "g", { main: true }), item("patates", "patates", 2, "adet")] });
  assert.equal(r.servings, 2);
});

test("çiğ ve pişmiş girdi: pişmiş verilen ana malzeme çiğ eşdeğerine döndürülür", () => {
  const dish = (it) => estimateServings({ dish_type: "bakliyat_yemegi", cooking_method: "haslama_sulu", items: [it] });
  const raw = dish(item("nohut", "kuru_baklagil", 160, "g", { main: true }));
  const cooked = dish(item("haşlanmış nohut", "kuru_baklagil", 400, "g", { main: true, state: "pismis" }));
  close(cooked.anchor.amount, 160, "400 g haşlanmış = 160 g kuru");
  close(raw.lo, cooked.lo, "aynı porsiyon");
});

test("sebze yalnızca AI ana malzeme dediyse porsiyonu belirler (soğan/domates belirlemez)", () => {
  const items = [item("taze fasulye", "sebze", 750, "g", { main: true }), item("domates", "sebze", 750, "g"), item("soğan", "sebze", 3, "adet")];
  const r = estimateServings({ dish_type: "sebze_yemegi", cooking_method: "haslama_sulu", items });
  assert.deepEqual(r.anchor.names, ["taze fasulye"]);
  close(r.anchor.lo, 3, "750/250");
  close(r.anchor.hi, 5, "750/150");
  const noMain = estimateServings({ dish_type: "sebze_yemegi", cooking_method: "haslama_sulu", items: items.map((i) => ({ ...i, main: false })) });
  assert.equal(noMain.anchor, null);
});

test("ana malzemesi ölçülemeyen yemekte sayı üretilmez (3 adet tavuk budu)", () => {
  const r = estimateServings({
    dish_type: "ana_yemek",
    cooking_method: "firin",
    items: [item("tavuk budu", "tavuk_kemikli", 3, "adet", { main: true }), item("soğan", "sebze", 1, "adet"), item("sıvı yağ", "sivi_yag", 1, "yemek_kasigi")],
  });
  assert.equal(r.status, "bilgi_yetersiz");
  assert.match(r.notes[0], /tavuk budu/);
});

test("karnıyarık: patlıcan adet ağırlığı bilinmiyor, kıymadan (sebze yemeğinde 40–100 g) hesaplanır ve not düşülür", () => {
  const r = estimateServings({
    dish_type: "sebze_yemegi",
    cooking_method: "firin",
    items: [item("patlıcan", "sebze", 6, "adet", { main: true }), item("kıyma", "kiyma", 350, "g"), item("domates", "sebze", 2, "adet"), item("kızartma yağı", "kizartma_yagi", 1, "su_bardagi")],
  });
  assert.equal(r.status, "hesaplandi");
  assert.equal(r.method, "A");
  assert.equal(r.yield, null, "ana malzemesiz toplam verim kullanılmaz");
  close(r.lo, 3.5, "350/100");
  close(r.hi, 8.75, "350/40");
  assert.ok(r.notes.some((n) => n.includes("patlıcan")));
});

test("ana malzemenin miktarı belirsizse (1 paket makarna) sayı üretilmez", () => {
  const r = estimateServings({
    dish_type: "ana_yemek",
    cooking_method: "firin",
    items: [item("makarna", "makarna_kuru", 1, "belirsiz", { main: true }), item("süt", "sut", 2, "su_bardagi"), item("tereyağı", "tereyagi", 1, "yemek_kasigi")],
  });
  assert.equal(r.status, "bilgi_yetersiz");
  assert.match(r.notes[0], /makarna/);
});

test("miktarlar kaynakta yoksa porsiyon uydurulmaz", () => {
  const r = estimateServings({
    dish_type: "ana_yemek",
    cooking_method: "firin",
    items: [item("makarna", "makarna_kuru", 500, "g", { quantity_in_source: false, main: true }), item("kaşar", "peynir", 100, "g", { quantity_in_source: false })],
  });
  assert.equal(r.status, "bilgi_yetersiz");
  const applied = applyPortionEstimate({ title: "x", servings: null, assumptions: "", portion: { dish_type: "ana_yemek", cooking_method: "firin", items: [] } });
  assert.equal(applied.servings, null);
  assert.equal(applied.servings_basis, "bilinmiyor");
});

test("eski biçimdeki portion (main alanı yok) çalışmaya devam eder", () => {
  const legacy = { dish_type: "ana_yemek", cooking_method: "haslama_sulu", items: [{ name: "kuşbaşı et", kind: "et_kemiksiz", quantity: 800, unit: "g", size: null, state: "cig", quantity_in_source: true }] };
  const r = estimateServings(legacy);
  assert.equal(r.status, "hesaplandi");
  close(r.anchor.lo, 800 / 200, "alt");
  close(r.anchor.hi, 800 / 150, "üst");
});

test("kaynakta yazan porsiyon ve birimi korunur", () => {
  for (const n of [2, 6]) {
    const out = applyPortionEstimate({ title: "x", servings: n, servings_unit: "porsiyon", assumptions: "", portion: KOFTE });
    assert.equal(out.servings, n);
    assert.equal(out.servings_basis, "kaynak");
    assert.equal(out.portion, undefined);
    assert.equal(out.servings_unit, undefined, "varsayılan birim kayda yazılmaz");
    assert.equal(out.servings_note, undefined);
    assert.equal(out.servings_calc, undefined);
    assert.equal(out.servings_range, undefined);
  }
  const pieces = applyPortionEstimate({ title: "x", servings: 10, servings_unit: "adet", portion: KOFTE });
  assert.equal(pieces.servings_unit, "adet");
  assert.equal(servingsUnitOf(pieces), "adet");
  const slices = applyPortionEstimate({ title: "x", servings: 8, servings_unit: "dilim", portion: CAKE });
  assert.equal(slices.servings_unit, "dilim");
  const weird = applyPortionEstimate({ title: "x", servings: 4, servings_unit: "kase" });
  assert.equal(weird.servings_unit, undefined);
  assert.equal(servingsUnitOf({}), "porsiyon");
});

test("hesaplanan tahminde birim yazılmaz (AI 'adet' dese bile sayı kaynaktan gelmiyorsa porsiyondur)", () => {
  const out = applyPortionEstimate({ title: "x", servings: null, servings_unit: "adet", assumptions: "", portion: KOFTE });
  assert.equal(out.servings_basis, "hesap");
  assert.equal(out.servings_unit, undefined);
});

test("desteklenmeyen yemek türünde sayı üretilmez", () => {
  const out = applyPortionEstimate({ title: "x", servings: null, assumptions: "", portion: { ...KOFTE, dish_type: "diger" } });
  assert.equal(out.servings, null);
  assert.match(out.servings_note, /Porsiyon hesaplanamadı/);
});

test("gösterilen gerekçe uygulanan hesapla aynı sayıları içerir, aralık kaydedilir ve assumptions'a karışmaz", () => {
  const out = applyPortionEstimate({ title: "x", servings: null, assumptions: "Tuz eklendi.", portion: KOFTE });
  assert.equal(out.servings_basis, "hesap");
  assert.equal(out.servings, 4);
  assert.deepEqual(out.servings_range, [3, 4]);
  assert.equal(out.servings_calc.v, PORTION_RULES_VERSION);
  assert.equal(out.servings_calc.method, "A");
  assert.deepEqual(out.servings_calc.anchor_per_person, [130, 150]);
  assert.equal(out.assumptions, "Tuz eklendi.");
  assert.match(out.servings_note, /^Porsiyon kaynakta yazmadığı için/);
  assert.match(out.servings_note, /kişi başı 130–150 g/);
  assert.match(out.servings_note, /3,3–3,8 → tahmini 4 porsiyon \(makul aralık 3–4\)/);
});

test("aralık tek sayıya inerse servings_range kaydedilmez", () => {
  const out = applyPortionEstimate({ title: "x", servings: null, portion: { dish_type: "ana_yemek", cooking_method: "firin", items: [item("tavuk", "tavuk_kemikli", 500, "g", { main: true })] } });
  assert.equal(out.servings, 2);
  assert.equal(out.servings_range, undefined);
});

test("adet ve boyut: boyut yoksa orta kabul edilir ve not düşülür", () => {
  const dish = (size) => estimateServings({ dish_type: "garnitur", cooking_method: "haslama_sulu", items: [item("patates", "patates", 2, "adet", { size, main: true })] });
  close(dish("buyuk").anchor.amount, 738, "2 büyük patates");
  close(dish(null).anchor.amount, 426, "2 orta patates");
  assert.ok(dish(null).notes.some((n) => n.includes("orta boy")));
});

test("belirsiz birim ve bilinmeyen adet sessizce gram almaz", () => {
  const r = estimateServings({
    dish_type: "tatli_kek",
    cooking_method: "firin",
    items: [item("un", "un", 300, "g"), item("margarin", "diger", 1, "belirsiz"), item("muz", "sebze", 2, "adet")],
  });
  close(r.yield.lo, 300 * 0.92, "yalnızca un sayıldı");
  assert.ok(r.notes.some((n) => n.includes("margarin") && n.includes("muz")));
});

const eggs = (name, kind = "yumurta", size = null) =>
  estimateServings({ dish_type: "tatli_kek", cooking_method: "firin", items: [item(name, kind, 4, "adet", { size })] });

test("A) 4 yumurta sarısı ≈ 68 g (17 g/adet), boyut notu düşülmez", () => {
  const r = eggs("yumurta sarısı");
  close(r.yield.lines[0].g, 68, "4 × 17");
  assert.ok(!r.notes.some((n) => n.includes("orta boy")));
  close(eggs("Yumurta sarısı", "diger").yield.lines[0].g, 68, "AI 'diger' dese de isimden tanınır");
});

test("B) 4 tam yumurta: ağırlıklar değişmedi (orta 44, büyük 50)", () => {
  close(eggs("yumurta").yield.lines[0].g, 176, "4 × 44");
  close(eggs("Yumurta (tam)").yield.lines[0].g, 176, "tam yumurta ismi");
  close(eggs("yumurta", "yumurta", "buyuk").yield.lines[0].g, 200, "4 × 50");
  close(eggs("yumurta sarısı ve akı").yield.lines[0].g, 176, "sarı ve ak birlikte → tam yumurta");
});

test("C) 4 yumurta akı = 132 g (33 g/adet); üçü birbirinden farklı", () => {
  close(eggs("yumurta akı").yield.lines[0].g, 132, "4 × 33");
  close(eggs("yumurtanın akları").yield.lines[0].g, 132, "çoğul");
  const ys = [eggs("yumurta").yield.lo, eggs("yumurta sarısı").yield.lo, eggs("yumurta akı").yield.lo];
  assert.equal(new Set(ys).size, 3);
});

test("menemen: yumurta ana malzeme, kişi başı 1 adet (AGU)", () => {
  const r = estimateServings({
    dish_type: "ana_yemek",
    cooking_method: "tava_izgara",
    items: [item("yumurta", "yumurta", 3, "adet", { main: true }), item("domates", "sebze", 3, "adet"), item("tereyağı", "tereyagi", 2, "yemek_kasigi")],
  });
  assert.equal(r.anchor.amount, 3);
  assert.equal(r.servings, 3);
  // Yumurta sarısı ana malzeme olamaz (tam yumurta değildir).
  const yolks = estimateServings({ dish_type: "ana_yemek", cooking_method: "firin", items: [item("yumurta sarısı", "yumurta", 3, "adet", { main: true })] });
  assert.equal(yolks.anchor, null);
});
