// Malzeme listesinin EKRANDA gösterilecek hali. Kayıtlı tarif hiç değişmez; bu dönüşüm
// yalnızca bellekte, her açılışta yeniden yapılır (eski tarifler de böylece düzgün görünür).
//
// 1. Miktar metni temizlenir: "belirtilmemiş, tahminen 45 g" → "45 g" + estimated (ekranda
//    "Yaklaşık 45 g"); yalnızca "belirtilmemiş" olan miktar boş gösterilir. Sayı eklenmez.
// 2. Eski kayıtlarda bir karışımın bütün malzemeleri tek satırın miktarına yazılmışsa
//    ("Kaplama unu" → "2 su bardağı un, 1/2 su bardağı mısır nişastası, …") satır bölünür:
//    satırın adı bölüm başlığı olur, her parça kendi miktarıyla ayrı malzeme olur. Bölme
//    yalnızca parçaların çoğu "miktar + ad" biçimindeyse yapılır; emin olunamazsa satır aynen kalır.
// 3. Bölüm adıyla aynı adı taşıyan malzeme (tarifte hazırlanan karışımın başka bölümde
//    kullanılması: "Baharat karışımı — 2 yemek kaşığı") `_ref` işaretlenir; alışveriş listesine
//    ve "Elimde Bunlar Var" eşleştirmesine girmez (satın alınacak bir şey değil).
import { cleanAmount } from "../shared/ingredientText.js";
import { splitQuantityPrefix } from "./recipeLocale.js";

const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
const key = (s) => str(s).toLocaleLowerCase("tr").replace(/\s+/g, " ").trim();
const capitalize = (s, lang) => (s ? s.charAt(0).toLocaleUpperCase(lang === "tr" ? "tr" : "en") + s.slice(1) : s);

// Parantez dışındaki ", " ve ";" ile ayırır ("1,5 su bardağı" ondalık virgülü bölünmez).
function topLevelSegments(text) {
  const out = [];
  let depth = 0;
  let cur = "";
  const s = str(text);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && (c === ";" || (c === "," && /\s/.test(s[i + 1] || "")))) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur.trim());
  return out.filter(Boolean);
}

// Tek satıra yazılmış karışım → [{ amount, name }] ya da null (bölünemez/emin değil).
export function splitCompoundAmount(text) {
  const segments = topLevelSegments(text);
  if (segments.length < 2) return null;
  const parts = [];
  let withQty = 0;
  for (const seg of segments) {
    const p = splitQuantityPrefix(seg);
    if (p) {
      parts.push(p);
      withQty++;
      continue;
    }
    // Miktarsız kısa parça ("tuz", "karabiber"): yalnızca adsa kabul edilir.
    if (!/\d/.test(seg) && seg.split(/\s+/).length <= 3) {
      parts.push({ amount: "", name: seg });
      continue;
    }
    return null;
  }
  return withQty >= 2 && withQty >= Math.ceil(parts.length / 2) ? parts : null;
}

function cleanOne(ing) {
  const canon = ing._canon;
  const { amount, estimated } = cleanAmount(canon ? canon.amount : ing.amount, ing.estimated === true);
  const out = { ...ing, ...(estimated ? { estimated: true } : {}) };
  if (!estimated) delete out.estimated;
  if (canon) {
    out._canon = { ...canon, amount };
    out._aiAmount = ing._aiAmount ? cleanAmount(ing._aiAmount).amount || null : null;
  } else {
    out.amount = amount;
  }
  return out;
}

// ingredients: kayıtlı ya da localizeRecipe'ten geçmiş (çevrilmişse `_canon`/`_aiAmount` taşır).
// lang: gösterim dili (yalnızca büyük harf için).
export function presentIngredients(ingredients, lang = "tr") {
  const list = Array.isArray(ingredients) ? ingredients.filter((i) => i && typeof i === "object") : [];
  const out = [];
  for (const raw of list) {
    const ing = cleanOne(raw);
    const canon = ing._canon;
    const sourceText = canon ? canon.amount : ing.amount;
    const parts = ing.group ? null : splitCompoundAmount(sourceText);
    if (!parts) {
      out.push(ing);
      continue;
    }
    const group = str(ing.name).trim();
    if (!canon) {
      for (const p of parts) out.push({ name: capitalize(p.name, lang), amount: p.amount, group });
      continue;
    }
    // Çevrilmiş gösterim: çevrilen metin de aynı sayıda parçaya bölünebiliyorsa eşleştirilir;
    // bölünemiyorsa satır hiç bölünmez (yarısı bir dilde, yarısı öteki dilde görünmesin).
    const trParts = ing._aiAmount ? splitCompoundAmount(ing._aiAmount) : null;
    if (!trParts || trParts.length !== parts.length) {
      out.push(ing);
      continue;
    }
    parts.forEach((p, i) => {
      out.push({
        name: capitalize(trParts[i].name, lang),
        amount: p.amount,
        group,
        _canon: { name: p.name, amount: p.amount },
        _from: ing._from,
        _aiAmount: trParts[i].amount || null,
      });
    });
  }
  // İç referans: adı bir bölümün adıyla aynı ya da bölüm adının sonu ("Baharat karışımı" ↔
  // "Nashville hot baharat karışımı"; en az iki kelime, tek kelimelik "tuz" gibi adlar sayılmaz)
  // olan ve o bölümün içinde olmayan satır.
  const groupKeys = [...new Set(out.map((i) => key(i.group)).filter(Boolean))];
  const refersTo = (name) =>
    !!name && groupKeys.find((g) => g === name || (name.includes(" ") && g.endsWith(" " + name)));
  return out.map((i) => {
    const target = refersTo(key(i._canon ? i._canon.name : i.name)) || refersTo(key(i.name));
    return target && target !== key(i.group) ? { ...i, _ref: true } : i;
  });
}

// Tarif nesnesi için kısayol (asıl nesne değişmez).
export function presentRecipe(recipe, lang = "tr") {
  if (!recipe || !Array.isArray(recipe.ingredients)) return recipe;
  return { ...recipe, ingredients: presentIngredients(recipe.ingredients, lang) };
}

// Ardışık aynı bölümdeki satırlar → [{ group, items: [{ ing, index }] }]. index, düz listedeki
// sıradır (pişirme modundaki işaretler bu sırayla tutulur).
export function groupRuns(ingredients) {
  const runs = [];
  (ingredients || []).forEach((ing, index) => {
    const group = str(ing && ing.group).trim();
    const last = runs[runs.length - 1];
    if (last && last.group === group) last.items.push({ ing, index });
    else runs.push({ group, items: [{ ing, index }] });
  });
  return runs;
}
