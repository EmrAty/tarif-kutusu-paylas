// "Elimde Bunlar Var": kayıtlı tarifleri eldeki malzemelerle eşleştirme.
// Saf modül (React yok), tamamen cihazda çalışır — AI çağrısı yok.
//
// Hedef: Türkçe malzeme adlarında basit yazım farklarını tolere etmek
// ("soğan" = "Soğanlar" = "sogan", "zeytinyağı" = "zeytin yağı", "domates" ↔
// "2 adet doğranmış domates"), ama farklı malzemeyi aynı saymamak ("biber" ≠
// "biberiye", "su" ≠ "sucuk", "domates" ≠ "domates salçası"). Eşleşmeyen her
// malzeme "eksik" olarak döner; tarif hiçbir zaman eksiksizmiş gibi sunulmaz.
// Tek istisna musluk suyu: her evde var sayılır ve sayıma girmez.

// Türkçe harfleri sadeleştir (ç→c, ğ→g, ı→i, ö→o, ş→s, ü→u), küçük harf, noktalama yok.
export function foldText(text) {
  return String(text || "")
    .toLocaleLowerCase("tr")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Malzeme adında malzemenin kimliğini değiştirmeyen sözcükler (hazırlık, boyut, miktar).
const DESCRIPTORS = new Set(
  [
    "taze", "ince", "kalin", "iri", "kucuk", "buyuk", "orta", "boy", "boyutta", "adet", "yarim", "ceyrek", "tane",
    "dogranmis", "dogranmış", "kiyilmis", "rendelenmis", "dilimlenmis", "haslanmis", "pismis", "cig", "ezilmis",
    "soyulmus", "cekirdeksiz", "cekilmis", "erimis", "oda", "sicakliginda", "sicakliginda", "soguk", "sicak", "ilik",
    "kup", "kuplere", "halka", "seritler", "julyen", "istege", "bagli", "tercihen", "gore", "icin", "ve", "ile",
    "biraz", "az", "bir", "iki", "kadar", "fresh", "chopped", "diced", "sliced", "minced", "grated", "large", "small",
    "medium", "whole", "optional", "to", "taste", "of", "a", "the", "for",
  ].map(foldText)
);

// Bu sözcükler malzemeyi başka bir ürüne çevirir: "domates salçası" domates değildir,
// "fındık unu" fındık değildir. Eldeki malzeme yalnızca baş sözcükse eşleşmez.
const PRODUCT_WORDS = new Set(
  ["salca", "salcasi", "sos", "sosu", "unu", "ezmesi", "puresi", "sirkesi", "likoru", "aromasi", "cipsi", "tozu", "kremasi", "yaprak", "yapragi", "paste", "sauce", "flour", "powder", "extract", "vinegar"].map(foldText)
);

// Türkçe/İngilizce çoğul, iyelik ve hâl ekleri (kökten sonra gelen kalan).
const SUFFIXES = new Set(["ler", "lar", "leri", "lari", "i", "u", "si", "su", "yi", "yu", "ni", "nu", "in", "un", "nin", "nun", "e", "a", "ye", "ya", "s", "es"]);

function tokensOf(text) {
  return foldText(text)
    .split(" ")
    .filter((w) => w && !DESCRIPTORS.has(w) && !/^\d+$/.test(w));
}

// İki sözcük aynı malzeme kökü mü: eşit ya da kısa olan uzunun başı ve kalan bir ek.
function sameWord(a, b) {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 2 || !long.startsWith(short)) return false;
  return SUFFIXES.has(long.slice(short.length));
}

// "zeytin yağı" ↔ "zeytinyağı": bitişik yazılmış hâli de karşılaştırılır.
function joined(tokens) {
  return tokens.join("");
}

// Bir eldeki malzeme (pantry) bir tarif malzemesi adıyla eşleşiyor mu?
function itemMatchesName(pantryTokens, nameTokens) {
  if (!pantryTokens.length || !nameTokens.length) return false;
  if (sameWord(joined(pantryTokens), joined(nameTokens))) return true;
  // Eldeki malzemenin her sözcüğü tarif adında geçiyor ("soğan" → "kırmızı soğan").
  const used = [];
  for (const p of pantryTokens) {
    const i = nameTokens.findIndex((n, idx) => !used.includes(idx) && sameWord(p, n));
    if (i < 0) return pantryAllInName(pantryTokens, nameTokens);
    used.push(i);
  }
  // Tarif adında eldekinden SONRA ürün sözcüğü geliyorsa başka bir ürün ("domates salçası").
  const last = Math.max(...used);
  if (nameTokens.slice(last + 1).some((w) => PRODUCT_WORDS.has(w))) return false;
  return true;
}

// Tarif adının tüm sözcükleri eldekinde geçiyor ("tavuk" tarifte, "tavuk göğsü" elde).
function pantryAllInName(pantryTokens, nameTokens) {
  return nameTokens.every((n) => pantryTokens.some((p) => sameWord(p, n)));
}

// "Tereyağı ya da margarin", "süt/krema": alternatiflerden biri yeter.
function alternativesOf(name) {
  return String(name || "")
    .split(/\s+(?:ya da|yada|veya|or)\s+|\/|,/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

const WATER = new Set(["su", "water", "ilik su", "sicak su", "soguk su", "kaynar su", "kaynamis su", "warm water", "hot water", "cold water"].map(foldText));
export function isTapWater(name) {
  return WATER.has(foldText(name));
}

// Bir malzeme eldekilerden biriyle karşılanıyor mu? names: aynı malzemenin olası adları
// (asıl dil + gösterim dili).
export function ingredientAvailable(names, pantryItems) {
  const pantry = (pantryItems || []).map(tokensOf).filter((t) => t.length);
  return (Array.isArray(names) ? names : [names]).some((name) =>
    alternativesOf(name).some((alt) => {
      const nameTokens = tokensOf(alt);
      return pantry.some((p) => itemMatchesName(p, nameTokens));
    })
  );
}

// recipes: erişilebilir (kilitsiz) tarifler; her biri { recipe, ingredients: [{ name, names[] }] }
// biçimine getirilmiş olmalı (çağıran taraf grup atıflarını vb. ayıklar).
// Dönen: en az bir malzemesi eşleşen tarifler; önce eksik sayısı az olan, sonra oran.
export function matchRecipes(entries, pantryItems, { limit = 20 } = {}) {
  if (!pantryItems || pantryItems.length === 0) return [];
  const out = [];
  for (const entry of entries || []) {
    const ingredients = (entry.ingredients || []).filter((ing) => ing && ing.name && !isTapWater(ing.name));
    if (ingredients.length === 0) continue;
    const matched = [];
    const missing = [];
    for (const ing of ingredients) {
      (ingredientAvailable(ing.names || [ing.name], pantryItems) ? matched : missing).push(ing);
    }
    if (matched.length === 0) continue;
    out.push({ recipe: entry.recipe, total: ingredients.length, matchedCount: matched.length, missing, complete: missing.length === 0 });
  }
  out.sort(
    (a, b) =>
      a.missing.length - b.missing.length ||
      b.matchedCount / b.total - a.matchedCount / a.total ||
      b.matchedCount - a.matchedCount ||
      String(a.recipe.title || "").localeCompare(String(b.recipe.title || ""), "tr")
  );
  return out.slice(0, limit);
}
