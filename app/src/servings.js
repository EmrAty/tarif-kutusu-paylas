// Dinamik porsiyon sistemi için saf (React'siz) yardımcılar. Tarifin kayıtlı
// verisine ASLA yazmazlar: hepsi bir "ölçek katsayısı" (seçilen / kayıtlı
// porsiyon) alıp yalnızca ekranda gösterilecek metni/değeri döndürür.
//
// Malzeme miktarları tarif şemasında düz metin (`amount: "400 g"`). Güvenilir
// biçimde okunamayan hiçbir miktar ölçeklenmez, olduğu gibi gösterilir —
// yanlış miktar üretmektense orijinal metni göstermek tercih edildi.

// Ölçeklenmemesi gereken ifadeler: "bir tutam", "tuz (damak zevkine göre)",
// "servis için", "üzeri için" vb. Miktarın içinde sayı olsa bile değişmezler.
const NO_SCALE_RE = /(tutam|çimdik|için|göre|gerek|yeterli|servis|süsle|üzeri|pinch|taste|serving|garnish|needed|dash)/u;

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

function firstWord(rest) {
  const m = /^[\p{L}]+/u.exec(rest.trim().toLocaleLowerCase("tr"));
  return m ? m[0] : "";
}

// Bir malzemeyi katsayıyla ölçekler. Dönen `status`:
//  "same"     → ölçeklenmedi çünkü doğası gereği miktarı yok / ölçeklenmemeli (tutam, servis için, boş…)
//  "scaled"   → miktar ölçeklendi
//  "unparsed" → metinde sayı var ama güvenilir okunamadı, orijinal metin gösterildi
// `decimal`: ondalık ayraç ("," Türkçe için) — sadece gram/ml/kg/lt gibi ondalıkla gösterilen ölçülerde görünür.
export function scaleIngredient(ing, factor, decimal = ".") {
  const original = (ing && typeof ing.amount === "string" ? ing.amount : ing && ing.amount != null ? String(ing.amount) : "").trim();
  if (!factor || factor === 1) return { text: original, status: "same" };

  // Yapılandırılmış alan (varsa): { quantity: 400, unit: "g" } — düz metinden önceliklidir.
  if (ing && typeof ing.quantity === "number" && Number.isFinite(ing.quantity) && ing.quantity > 0) {
    const unit = typeof ing.unit === "string" ? ing.unit.trim() : "";
    if (NO_SCALE_RE.test(unit.toLocaleLowerCase("tr"))) {
      return { text: original || `${ing.quantity}${unit ? " " + unit : ""}`, status: "same" };
    }
    const value = ing.quantity * factor;
    const shown = formatValue(value, unit.toLocaleLowerCase("tr"), decimal);
    return { text: `${shown}${unit ? " " + unit : ""}`, status: "scaled" };
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
  if (/[\d½¼¾⅓⅔⅛]/u.test(rest)) return { text: original, status: "unparsed" };

  const unit = firstWord(rest);
  const [a, b] = head;
  const from = formatValue(a * factor, unit, decimal);
  const to = b != null ? formatValue(b * factor, unit, decimal) : null;
  const shown = to != null ? `${from}–${to}` : from;
  return { text: `${shown}${rest ? " " + rest.trim() : ""}`, status: "scaled" };
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
