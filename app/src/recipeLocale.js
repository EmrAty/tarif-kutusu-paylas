// Tarif içeriğinin uygulama dilinde gösterimi (bkz. shared/recipeLocales.js, api/translate-recipe.js).
//
// Kural: kayıtlı (asıl dildeki) tarif tek doğru kaynaktır. Porsiyon ölçekleme ve pratik
// yuvarlama HER ZAMAN asıl metin üzerinde yapılır (servings.js), sonra sonuç gösterim
// diline çevrilir. Birimler önce buradaki sabit sözlükle (deterministik) çevrilir;
// sözlüğün tanımadığı ifadelerde yapay zekânın çevirdiği miktar metni kullanılır.
import { scaleIngredient } from "./servings.js";
import { contentLangOf } from "../shared/recipeLocales.js";

// --- Birim sözlüğü -------------------------------------------------------------------
// Her giriş: [kaynak ifade(ler)i, { dil: [tekil, çoğul] }]. Türk bardak ölçüleri "cup"a
// ÇEVRİLMEZ: miktarın gerçek hacmi (servings/portionEstimate'teki 200/100 mL kabulü) yazılır.
const UNITS = [
  [["adet", "tane"], { tr: ["adet", "adet"], en: ["", ""] }],
  [["pc", "pcs", "piece", "pieces"], { tr: ["adet", "adet"], en: ["", ""] }],
  [["yemek kaşığı", "tablespoon", "tablespoons", "tbsp"], { tr: ["yemek kaşığı", "yemek kaşığı"], en: ["tbsp", "tbsp"] }],
  [["tatlı kaşığı", "dessert spoon (10 ml)", "dessert spoons (10 ml)", "dessert spoon", "dessert spoons"], { tr: ["tatlı kaşığı", "tatlı kaşığı"], en: ["dessert spoon (10 ml)", "dessert spoons (10 ml)"] }],
  [["çay kaşığı", "teaspoon", "teaspoons", "tsp"], { tr: ["çay kaşığı", "çay kaşığı"], en: ["tsp", "tsp"] }],
  [["su bardağı", "glass (200 ml)", "glasses (200 ml)"], { tr: ["su bardağı", "su bardağı"], en: ["glass (200 ml)", "glasses (200 ml)"] }],
  [["çay bardağı", "tea glass (100 ml)", "tea glasses (100 ml)"], { tr: ["çay bardağı", "çay bardağı"], en: ["tea glass (100 ml)", "tea glasses (100 ml)"] }],
  [["cup", "cups"], { tr: ["kupa (240 ml)", "kupa (240 ml)"], en: ["cup", "cups"] }],
  [["diş", "clove", "cloves"], { tr: ["diş", "diş"], en: ["clove", "cloves"] }],
  [["demet", "bunch", "bunches"], { tr: ["demet", "demet"], en: ["bunch", "bunches"] }],
  [["dal", "sprig", "sprigs"], { tr: ["dal", "dal"], en: ["sprig", "sprigs"] }],
  [["dilim", "slice", "slices"], { tr: ["dilim", "dilim"], en: ["slice", "slices"] }],
  [["paket", "pack", "packs", "package", "packages"], { tr: ["paket", "paket"], en: ["pack", "packs"] }],
  [["tutam", "pinch", "pinches"], { tr: ["tutam", "tutam"], en: ["pinch", "pinches"] }],
  [["avuç", "handful", "handfuls"], { tr: ["avuç", "avuç"], en: ["handful", "handfuls"] }],
  [["kase", "bowl", "bowls"], { tr: ["kase", "kase"], en: ["bowl", "bowls"] }],
  [["şişe", "bottle", "bottles"], { tr: ["şişe", "şişe"], en: ["bottle", "bottles"] }],
  [["kavanoz", "jar", "jars"], { tr: ["kavanoz", "kavanoz"], en: ["jar", "jars"] }],
  [["g", "gr", "gram", "grams"], { tr: ["g", "g"], en: ["g", "g"] }],
  [["kg", "kilo", "kilogram", "kilograms"], { tr: ["kg", "kg"], en: ["kg", "kg"] }],
  [["ml", "mililitre", "milliliter", "milliliters"], { tr: ["ml", "ml"], en: ["ml", "ml"] }],
  [["l", "lt", "litre", "liter", "liters"], { tr: ["l", "l"], en: ["l", "l"] }],
];
// Boy / ek ifadeler (birimden sonra ya da tek başına gelebilir).
const MODIFIERS = [
  [["orta boy", "orta", "medium"], { tr: "orta boy", en: "medium" }],
  [["büyük boy", "büyük", "iri", "large"], { tr: "büyük boy", en: "large" }],
  [["küçük boy", "küçük", "small"], { tr: "küçük boy", en: "small" }],
  [["isteğe bağlı", "optional"], { tr: "isteğe bağlı", en: "optional" }],
];
// Sayısız, tek başına ifadeler.
const PHRASES = [
  [["damak zevkine göre", "to taste"], { tr: "damak zevkine göre", en: "to taste" }],
  [["bir tutam", "a pinch"], { tr: "bir tutam", en: "a pinch" }],
  [["yeteri kadar", "yeterince", "gerektiği kadar", "as needed"], { tr: "gerektiği kadar", en: "as needed" }],
  [["üzeri için", "for topping"], { tr: "üzeri için", en: "for topping" }],
  [["servis için", "for serving"], { tr: "servis için", en: "for serving" }],
  [["süslemek için", "for garnish"], { tr: "süslemek için", en: "for garnish" }],
  [["biraz", "az", "a little"], { tr: "biraz", en: "a little" }],
];

const norm = (s) => String(s || "").toLocaleLowerCase("tr").replace(/\s+/g, " ").trim();
function lookup(table, text) {
  const n = norm(text);
  for (const [keys, value] of table) if (keys.some((k) => norm(k) === n)) return value;
  return null;
}
// Metnin BAŞINDAKİ en uzun birim ifadesi.
function leadingUnit(text) {
  const n = norm(text);
  let best = null;
  for (const [keys, value] of UNITS) {
    for (const k of keys) {
      const kn = norm(k);
      if ((n === kn || n.startsWith(kn + " ") || n.startsWith(kn + "(")) && (!best || kn.length > best.len)) best = { value, len: kn.length };
    }
  }
  return best;
}

const NUM = "(?:\\d+\\s+\\d+\\s*/\\s*\\d+|\\d+\\s*/\\s*\\d+|\\d+\\s*[½¼¾⅓⅔⅛]|[½¼¾⅓⅔⅛]|\\d+(?:[.,]\\d+)?)";
const QTY_RE = new RegExp(`^(${NUM}(?:\\s*[-–—]\\s*${NUM})?)\\s*(.*)$`, "su");
const GLYPH_VALUE = { "½": 0.5, "¼": 0.25, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3, "⅛": 0.125 };
function quantityValue(q) {
  // Çoğul kararı için: aralıkta üst sınır, "1½" gibi karışık sayılarda toplam.
  const last = q.split(/[-–—]/).pop().trim();
  let v = 0;
  for (const part of last.split(/\s+/)) {
    if (/^\d+\s*\/\s*\d+$/.test(part)) {
      const [a, b] = part.split("/").map(Number);
      v += b ? a / b : 0;
    } else if (/^\d+[½¼¾⅓⅔⅛]$/.test(part)) v += Number(part.slice(0, -1)) + GLYPH_VALUE[part.slice(-1)];
    else if (GLYPH_VALUE[part] != null) v += GLYPH_VALUE[part];
    else v += Number(part.replace(",", ".")) || 0;
  }
  return v;
}
const swapDecimal = (q, to) => (to === "tr" ? q.replace(/(\d)\.(\d)/g, "$1,$2") : q.replace(/(\d),(\d)/g, "$1.$2"));

// "2 yemek kaşığı" → "2 tbsp", "1 adet (orta boy)" → "1 (medium)", "damak zevkine göre" → "to taste".
// Sözlükte olmayan bir kelime kalırsa null (çağıran taraf yapay zekâ çevirisine düşer).
export function localizeAmount(text, from, to) {
  const raw = String(text || "").trim();
  if (!raw || from === to) return raw;
  const phrase = lookup(PHRASES, raw);
  if (phrase) return phrase[to] ?? null;
  const yarim = /^yarım(?![\p{L}])\s*(.*)$/su.exec(raw);
  const m = yarim ? ["", "½", yarim[1]] : QTY_RE.exec(raw);
  const qty = m ? swapDecimal(m[1], to) : "";
  let rest = m ? m[2].trim() : raw;
  const parts = [];
  const unit = leadingUnit(rest);
  const plural = qty ? quantityValue(qty) > 1 : false;
  if (unit) {
    const forms = unit.value[to];
    if (!forms) return null;
    const word = forms[plural ? 1 : 0];
    if (word) parts.push(word);
    rest = rest.slice(unit.len).trim();
  }
  // Kalan: boy/ek ifadeler, parantez içindeki ek ifadeler ya da "(200 ml)" gibi metrik notlar.
  while (rest) {
    const paren = /^\(([^)]*)\)\s*(.*)$/s.exec(rest);
    if (paren) {
      const inner = paren[1].trim();
      const metric = QTY_RE.exec(inner);
      let innerOut = null;
      if (metric && leadingUnit(metric[2]) && !metric[2].slice(leadingUnit(metric[2]).len).trim()) {
        innerOut = `${swapDecimal(metric[1], to)} ${leadingUnit(metric[2]).value[to][0]}`;
      } else {
        const mod = lookup(MODIFIERS, inner) || lookup(PHRASES, inner);
        innerOut = mod ? mod[to] : null;
      }
      if (innerOut == null) return null;
      // "1 su bardağı (200 ml)": birim zaten "glass (200 ml)" olarak hacmi yazıyorsa tekrar etme.
      if (!parts.some((p) => p.endsWith(`(${innerOut})`))) parts.push(`(${innerOut})`);
      rest = paren[2].trim();
      continue;
    }
    // En uzun eşleşen ek ifade
    const n = norm(rest);
    let best = null;
    for (const table of [MODIFIERS, PHRASES]) {
      for (const [keys, value] of table) {
        for (const k of keys) {
          const kn = norm(k);
          if ((n === kn || n.startsWith(kn + " ") || n.startsWith(kn + "(")) && (!best || kn.length > best.len)) best = { value, len: kn.length };
        }
      }
    }
    if (!best) return null;
    parts.push(best.value[to]);
    rest = rest.slice(best.len).trim();
  }
  return [qty, ...parts].filter(Boolean).join(" ");
}

// --- Gösterim tarifi ------------------------------------------------------------------
// Çevirinin bağlı olduğu içerik: bunlardan biri değişince (tarif düzenlendi) önbellek anahtarı değişir.
export function contentFingerprint(recipe) {
  const text = JSON.stringify([
    recipe.content_lang || "",
    recipe.title || "",
    (recipe.ingredients || []).map((i) => [i && i.name, i && i.amount]),
    recipe.instructions || [],
    recipe.assumptions || "",
    recipe.servings_note || "",
  ]);
  let h = 2166136261; // FNV-1a
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return `${recipe.id}:${(h >>> 0).toString(36)}:${text.length}`;
}

// Kayıtlı tarif + (varsa) çeviri → ekranda gösterilecek tarif. Asıl tarif nesnesi değişmez;
// dönen nesnede her malzemenin asıl hali `_canon` altında durur (ölçekleme/birleştirme onu kullanır).
export function localizeRecipe(recipe, lang, { translation, title } = {}) {
  const from = contentLangOf(recipe);
  if (!recipe || !translation) {
    const t = title && from !== lang ? title : null;
    return t ? { ...recipe, title: t, _origTitle: recipe.title } : recipe;
  }
  const ingredients = recipe.ingredients || [];
  const contentTranslated = !!translation.title || (translation.ingredients || []).length > 0;
  const out = { ...recipe, _origTitle: recipe.title, _displayLang: lang };
  if (contentTranslated) {
    out.title = translation.title || title || recipe.title;
    out.ingredients = ingredients.map((ing, i) => {
      const tr = (translation.ingredients || [])[i] || {};
      return { ...ing, name: tr.name || ing.name, _canon: { name: ing.name, amount: ing.amount }, _from: from, _aiAmount: tr.amount || null };
    });
    if ((translation.instructions || []).length === (recipe.instructions || []).length) out.instructions = translation.instructions;
    if (translation.assumptions) out.assumptions = translation.assumptions;
  }
  if (translation.servings_note) out.servings_note = translation.servings_note;
  return out;
}

// Bir malzemenin gösterim adı ve (ölçeklenmiş) miktarı. Tarif Detay, Pişirme modu ve
// Alışveriş Listesi hep bunu kullanır: ölçek → pratik yuvarlama → dil.
export function displayIngredient(ing, factor, lang) {
  const decimal = lang === "tr" ? "," : ".";
  const canon = ing && ing._canon;
  // canonText/from: asıl dildeki (ölçeklenmiş) miktar — alışveriş listesi toplamayı bunun üzerinden yapar.
  if (!canon) {
    const own = scaleIngredient(ing, factor, decimal);
    return { name: ing.name, ...own, canonText: own.text, from: lang };
  }
  const from = ing._from;
  const base = scaleIngredient(canon, factor, decimal);
  const text = localizeAmount(base.text, from, lang);
  if (text != null) {
    const exactText = base.exactText != null ? localizeAmount(base.exactText, from, lang) ?? base.exactText : undefined;
    return { ...base, name: ing.name, text, exactText, canonText: base.text, from };
  }
  if (ing._aiAmount) {
    // Sözlük yetmedi: yapay zekânın çevirdiği miktar metni (sayıları asılla aynı, sunucuda doğrulandı)
    // aynı katsayıyla ölçeklenir; tam adet kararı asıl malzemeden gelir.
    const scaled = scaleIngredient({ name: canon.name, amount: ing._aiAmount }, factor, decimal, { wholeUnit: base.wholeUnit });
    return { ...scaled, name: ing.name, canonText: base.text, from };
  }
  return { ...base, name: ing.name, canonText: base.text, from };
}
