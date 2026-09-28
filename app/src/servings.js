// Dinamik porsiyon sistemi için saf (React'siz) yardımcılar. Tarifin kayıtlı
// verisine ASLA yazmazlar: hepsi bir "ölçek katsayısı" (seçilen / kayıtlı
// porsiyon) alıp yalnızca ekranda gösterilecek metni/değeri döndürür.
//
// Malzeme miktarları tarif şemasında düz metin (`amount: "400 g"`). Güvenilir
// biçimde okunamayan hiçbir miktar ölçeklenmez, olduğu gibi gösterilir —
// yanlış miktar üretmektense orijinal metni göstermek tercih edildi.

// Ölçeklenmemesi gereken ifadeler: "bir tutam", "tuz (damak zevkine göre)",
// "servis için", "üzeri için" vb. Miktarın içinde sayı olsa bile değişmezler.
// Tek başına "için" bilerek listede YOK: "500 g (köfte için)", "3 yemek kaşığı (sos için)"
// gibi amaç notları asıl malzemedir ve ölçeklenmelidir.
const NO_SCALE_RE = /(tutam|çimdik|göre|gerek|yeterli|servis|süsle|üzeri|pinch|taste|serving|garnish|needed|dash)/u;

export const FRACTION_GLYPHS = { "½": 0.5, "¼": 0.25, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3, "⅛": 0.125 };
const GLYPH_BY_VALUE = [
  [0.125, "⅛"],
  [0.25, "¼"],
  [1 / 3, "⅓"],
  [0.5, "½"],
  [2 / 3, "⅔"],
  [0.75, "¾"],
];
const GLYPH_CLASS = "½¼¾⅓⅔⅛";

// Gram/mililitre gibi ölçülerde kesir yerine (yuvarlanmış) ondalık gösteriyoruz.
const METRIC_UNITS = new Set(["g", "gr", "gram", "kg", "kilo", "kilogram", "ml", "cl", "dl", "l", "lt", "litre", "oz", "lb"]);

// Tek bir sayı: 1, 1.5, 1,5, 1/2, 1 1/2, ½, 1½. Ondalıkta 3 haneli ve tam kısmı
// sıfırdan farklı olan ("1.500") Türkçe'de binlik ayracı da olabilir → belirsiz, okunmaz.
const NUM = `(?:\\d+\\s+\\d+\\s*/\\s*\\d+|\\d+\\s*/\\s*\\d+|\\d+\\s*[${GLYPH_CLASS}]|[${GLYPH_CLASS}]|\\d+(?:[.,]\\d+)?)`;
const LEADING_RE = new RegExp(`^(${NUM})(?:\\s*[-–—]\\s*(${NUM}))?(?![\\d.,/])\\s*(.*)$`, "su");

function parseNumber(token) {
  const s = token.trim();
  let m;
  if ((m = /^(\d+)\s+(\d+)\s*\/\s*(\d+)$/.exec(s))) {
    const den = Number(m[3]);
    return den ? Number(m[1]) + Number(m[2]) / den : null;
  }
  if ((m = /^(\d+)\s*\/\s*(\d+)$/.exec(s))) {
    const den = Number(m[2]);
    return den ? Number(m[1]) / den : null;
  }
  if ((m = new RegExp(`^(\\d+)\\s*([${GLYPH_CLASS}])$`).exec(s))) return Number(m[1]) + FRACTION_GLYPHS[m[2]];
  if (s.length === 1 && FRACTION_GLYPHS[s] != null) return FRACTION_GLYPHS[s];
  if ((m = /^(\d+)([.,])(\d+)$/.exec(s))) {
    if (m[3].length === 3 && Number(m[1]) !== 0) return null; // "1.500": ondalık mı binlik mi belli değil
    return Number(`${m[1]}.${m[3]}`);
  }
  if (/^\d+$/.test(s)) return Number(s);
  return null;
}

function trimNumber(value, decimals) {
  return String(Number(value.toFixed(decimals)));
}

// Ölçülen büyüklük için sade gösterim (gram/ml/kg/lt).
function formatMetric(value, unit) {
  if (unit === "kg" || unit === "kilo" || unit === "kilogram" || unit === "l" || unit === "lt" || unit === "litre") {
    return trimNumber(value, 2);
  }
  if (value >= 10) return String(Math.round(value));
  return trimNumber(value, 1);
}

// Adet/kaşık/bardak gibi ölçüler için ½, ¼, 1½ gibi kullanıcı dostu gösterim.
function formatFraction(value) {
  const whole = Math.floor(value);
  const rest = value - whole;
  const candidates = [[0, ""], [1, ""], ...GLYPH_BY_VALUE.map(([v, g]) => [v, g])];
  let best = candidates[0];
  for (const c of candidates) if (Math.abs(rest - c[0]) < Math.abs(rest - best[0])) best = c;
  let w = whole;
  let glyph = best[1];
  if (best[0] === 1) {
    w += 1;
    glyph = "";
  }
  if (w === 0 && !glyph) glyph = "⅛"; // sıfıra yuvarlanıp malzeme kaybolmasın
  return `${w > 0 ? w : ""}${glyph}`;
}

function formatValue(value, unit, decimal = ".") {
  return METRIC_UNITS.has(unit) ? formatMetric(value, unit).replace(".", decimal) : formatFraction(value);
}

// Birim adının parçası olan sabit hacim notu (bkz. src/recipeLocale.js birim sözlüğü).
const UNIT_DEFINITION_RE = /^(?:glass|glasses|tea glass|tea glasses|dessert spoon|dessert spoons|kupa)\s*\(\s*(?:200|100|10|240)\s*ml\s*\)/iu;

function firstWord(rest) {
  const m = /^[\p{L}]+/u.exec(rest.trim().toLocaleLowerCase("tr"));
  return m ? m[0] : "";
}

// --- Pratik miktar: mutfakta bölünmeyen tekil ürünler ------------------------------
// Ölçeklenmiş miktar yalnızca ekranda tam adede yuvarlanır (1,5 yumurta → 2); kayıtlı
// tarif, seçilen porsiyon ve besin değerleri değişmez. Karar birime değil malzemenin
// kendisine göre verilir: 1,5 soğan/limon/domates kesirli kalır. Emin olunmayan her
// malzeme (listede olmayan) kesirli gösterilir — yanlış yuvarlamak daha tehlikeli.
//
// Eşleşme: parantez içi atılmış malzeme adının SON kelime(ler)i listedeki bir girişle
// birebir aynı olmalı (Türkçe'de baş isim sondadır). Böylece "oda sıcaklığında yumurta"
// yumurtadır; "yumurtalı erişte" (erişte) ve "yumurta büyüklüğünde tereyağı" (tereyağı) değildir.
const WHOLE_UNIT_NAMES = [
  "yumurta", "yumurta sarısı", "yumurta sarıları", "yumurtanın sarısı",
  "yumurta akı", "yumurta akları", "yumurtanın akı",
  "tavuk but", "tavuk budu", "tavuk butu", "tavuk butları", "piliç but", "piliç budu",
  "tavuk baget", "tavuk bageti", "tavuk bagetleri", "baget",
  "tavuk kanat", "tavuk kanadı", "tavuk kanatları",
  "köfte", "hamburger köftesi", "burger köftesi",
  "dolma", "sarma",
  "kurabiye", "muffin", "cupcake",
  "hamburger ekmeği", "burger ekmeği", "sandviç ekmeği",
  // İngilizce yazılmış tarifler (uygulama İngilizceyken çıkarılanlar) için aynı ürünler
  "egg", "eggs", "egg yolk", "egg yolks", "egg white", "egg whites",
  "chicken drumstick", "chicken drumsticks", "drumstick", "drumsticks",
  "chicken thigh", "chicken thighs", "chicken leg", "chicken legs", "chicken wing", "chicken wings",
  "meatball", "meatballs", "burger patty", "burger patties",
  "cookie", "cookies", "muffin", "muffins", "cupcakes",
  "hamburger bun", "hamburger buns", "burger bun", "burger buns",
];
// Adet sayısı olduğunu gösteren birim sözcükleri (ölçü birimi değil).
const COUNT_WORDS = new Set(["adet", "tane", "büyük", "orta", "küçük", "iri", "irice", "large", "medium", "small", "whole", "pc", "pcs", "piece", "pieces"]);

function normalizeName(text, locale = "tr") {
  return String(text || "")
    .toLocaleLowerCase(locale)
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^\p{L}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isWholeUnitName(name) {
  // Türkçe küçük harf "I"yı "ı" yapar ("EGG" değil ama "CHICKEN THIGH" bozulur); iki biçim de denenir.
  return [normalizeName(name, "tr"), normalizeName(name, "en")].some(
    (n) => !!n && WHOLE_UNIT_NAMES.some((entry) => n === entry || n.endsWith(" " + entry))
  );
}

// Tam adede yuvarlanacak mı: ad listede VE miktar adet biçiminde ("3", "3 adet", "3 orta boy",
// "3 yumurta") VE kaynaktaki miktar tam sayı. "100 g yumurta", "1 su bardağı" gibi ölçüler
// hiç yuvarlanmaz; kaynak zaten kesirli yazmışsa ("yarım yumurta", "1½ adet") kesirli kullanım
// kabul edilmiş demektir, o da yuvarlanmaz.
export function shouldRoundToWholeUnit(ing, unitText = "", originalQuantities = []) {
  if (!ing || !isWholeUnitName(ing.name)) return false;
  if (originalQuantities.some((q) => q != null && !Number.isInteger(q))) return false;
  const rest = normalizeName(unitText);
  if (!rest) return true;
  return COUNT_WORDS.has(rest.split(" ")[0]) || isWholeUnitName(rest);
}

// En yakın tam sayı (,5 yukarı); malzeme tariften kaybolmasın diye en az 1.
export function practicalWholeQuantity(exact) {
  if (!(exact > 0)) return exact;
  return Math.max(1, Math.round(exact));
}

// [exact alt, exact üst|null] → pratik değerler; aralık tek sayıya inerse tek değer.
function practicalRange(lo, hi, whole) {
  if (!whole) return [lo, hi];
  const pLo = practicalWholeQuantity(lo);
  const pHi = hi != null ? practicalWholeQuantity(hi) : null;
  return [pLo, pHi != null && pHi !== pLo ? pHi : null];
}

// Bir malzemeyi katsayıyla ölçekler. Dönen `status`:
//  "same"     → ölçeklenmedi çünkü doğası gereği miktarı yok / ölçeklenmemeli (tutam, servis için, boş…)
//  "scaled"   → miktar ölçeklendi
//  "unparsed" → metinde sayı var ama güvenilir okunamadı, orijinal metin gösterildi
// `decimal`: ondalık ayraç ("," Türkçe için) — sadece gram/ml/kg/lt gibi ondalıkla gösterilen ölçülerde görünür.
// `opts.wholeUnit`: tam adede yuvarlama kararı dışarıdan verilir (çevrilmiş metin ölçeklenirken
// karar asıl dildeki malzemeden gelsin diye, bkz. src/recipeLocale.js). Verilmezse burada hesaplanır.
export function scaleIngredient(ing, factor, decimal = ".", opts = {}) {
  const original = (ing && typeof ing.amount === "string" ? ing.amount : ing && ing.amount != null ? String(ing.amount) : "").trim();
  if (!factor || factor === 1) return { text: original, status: "same" };

  // Yapılandırılmış alan (varsa): { quantity: 400, unit: "g" } — düz metinden önceliklidir.
  if (ing && typeof ing.quantity === "number" && Number.isFinite(ing.quantity) && ing.quantity > 0) {
    const unit = typeof ing.unit === "string" ? ing.unit.trim() : "";
    if (NO_SCALE_RE.test(unit.toLocaleLowerCase("tr"))) {
      return { text: original || `${ing.quantity}${unit ? " " + unit : ""}`, status: "same" };
    }
    const exact = ing.quantity * factor;
    const whole = opts.wholeUnit ?? shouldRoundToWholeUnit(ing, unit, [ing.quantity]);
    const [value] = practicalRange(exact, null, whole);
    const shown = formatValue(value, unit.toLocaleLowerCase("tr"), decimal);
    const rounded = value !== exact;
    const exactText = rounded ? `${formatValue(exact, unit.toLocaleLowerCase("tr"), decimal)}${unit ? " " + unit : ""}` : undefined;
    return { text: `${shown}${unit ? " " + unit : ""}`, status: "scaled", exact: [exact, null], rounded, exactText, wholeUnit: whole };
  }

  if (!original) return { text: original, status: "same" };
  const lower = original.toLocaleLowerCase("tr");
  const hasDigit = /[\d½¼¾⅓⅔⅛]/u.test(original);

  // "yarım su bardağı" gibi yaygın Türkçe ifade — sadece bunu okuyoruz, diğer sayı sözcüklerine dokunmuyoruz.
  let head = null;
  let rest = "";
  const halfMatch = /^yarım(?![\p{L}])\s*(.*)$/su.exec(lower);
  if (halfMatch) {
    head = [0.5, null];
    rest = halfMatch[1];
  } else {
    const m = LEADING_RE.exec(original);
    if (m) {
      const a = parseNumber(m[1]);
      const b = m[2] ? parseNumber(m[2]) : null;
      if (a != null && (!m[2] || b != null)) {
        head = [a, b];
        rest = m[3];
      }
    }
  }

  if (!head) return { text: original, status: hasDigit ? "unparsed" : "same" };
  if (NO_SCALE_RE.test(rest.toLocaleLowerCase("tr"))) return { text: original, status: "same" };
  // Birimden sonra ikinci bir sayı varsa ("1 su bardağı (200 ml)") hangisinin ölçekleneceği belirsiz.
  // İstisna: birimin kendi tanımı olan sabit hacim notu ("glass (200 ml)", "tea glass (100 ml)",
  // "dessert spoon (10 ml)", "kupa (240 ml)") — bu not adet başına hacimdir, ölçeklenmez, aynen kalır.
  if (/[\d½¼¾⅓⅔⅛]/u.test(rest.replace(UNIT_DEFINITION_RE, ""))) return { text: original, status: "unparsed" };

  const unit = firstWord(rest);
  const [a, b] = head;
  const exact = [a * factor, b != null ? b * factor : null];
  const whole = opts.wholeUnit ?? shouldRoundToWholeUnit(ing, rest, [a, b]);
  const [lo, hi] = practicalRange(exact[0], exact[1], whole);
  const from = formatValue(lo, unit, decimal);
  const to = hi != null ? formatValue(hi, unit, decimal) : null;
  const shown = to != null ? `${from}–${to}` : from;
  // exact/rounded/exactText yalnızca bellekte (gösterim bilgisi); hiçbir yere yazılmaz.
  // exactText: yuvarlamadan önceki miktarın aynı biçimde yazılışı ("1½ adet"), açıklama kartı için.
  const rounded = lo !== exact[0] || hi !== exact[1];
  const suffix = rest ? " " + rest.trim() : "";
  const exactText = rounded
    ? `${formatValue(exact[0], unit, decimal)}${exact[1] != null ? "–" + formatValue(exact[1], unit, decimal) : ""}${suffix}`
    : undefined;
  return { text: `${shown}${suffix}`, status: "scaled", exact, rounded, exactText, wholeUnit: whole };
}

// Besin değerleri şemada TARİFİN TAMAMI için toplam (bkz. shared/recipeExtraction.js).
// Seçilen porsiyona göre toplam ölçeklenir; 1 porsiyon değeri ise sabittir.
export function scaleNutrition(nutrition, factor) {
  const n = nutrition || {};
  const scale = (v, decimals) => {
    if (typeof v !== "number" || !Number.isFinite(v)) return v;
    if (!factor || factor === 1) return v;
    return Number((v * factor).toFixed(decimals));
  };
  return {
    calories: scale(n.calories, 0),
    protein_g: scale(n.protein_g, 1),
    carbs_g: scale(n.carbs_g, 1),
    fat_g: scale(n.fat_g, 1),
  };
}

export function perServingNutrition(nutrition, baseServings) {
  const n = nutrition || {};
  if (!(baseServings > 0)) return null;
  const per = (v, decimals) => (typeof v === "number" && Number.isFinite(v) ? Number((v / baseServings).toFixed(decimals)) : undefined);
  const result = { calories: per(n.calories, 0), protein_g: per(n.protein_g, 1), carbs_g: per(n.carbs_g, 1), fat_g: per(n.fat_g, 1) };
  return Object.values(result).some((v) => v !== undefined) ? result : null;
}

// Kayıtlı porsiyon sayısı geçerli bir sayı mı? (eski tariflerde hiç olmayabilir)
export function baseServingsOf(recipe) {
  const s = Number(recipe && recipe.servings);
  return Number.isFinite(s) && s > 0 ? s : null;
}

export const MIN_SERVINGS = 1;
export const MAX_SERVINGS_FLOOR = 20;
export function maxServingsFor(base) {
  return Math.max(MAX_SERVINGS_FLOOR, base || 0);
}
