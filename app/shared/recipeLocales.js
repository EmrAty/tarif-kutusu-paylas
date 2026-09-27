// Tarif İÇERİĞİ dilleri (arayüz dilinden ayrı): kayıtlı tarif hangi dilde yazıldı,
// hangi alanları çevrilebilir, çeviride hangi sayılar korunmalı. Hem istemci
// (src/recipeLocale.js) hem sunucu (api/translate-recipe.js) buradan okur.
//
// Yeni dil eklemek (ör. "es"): CONTENT_LANGUAGES'e bir satır + src/recipeLocale.js'teki
// birim sözlüğüne o dilin karşılıkları. Başka yerde dil listesi yok.

export const CONTENT_LANGUAGES = {
  tr: { name: "Turkish", extractInstruction: "Tüm metinler Türkçe olsun." },
  en: {
    name: "English",
    extractInstruction:
      "Kullanıcıya görünen TÜM metinler (başlık, malzeme adları, malzeme miktarlarının yazılışı, yapılış adımları, assumptions) İngilizce olsun; kaynak başka dilde olsa bile İngilizceye çevir. Sayıları ASLA değiştirme. Birimleri doğal İngilizceyle yaz (\"yemek kaşığı\" → \"tbsp\", \"çay kaşığı\" → \"tsp\", \"diş\" → \"clove\"); \"adet\" kelimesini hiç yazma (\"2 adet\" → \"2\"); Türk bardak ölçülerini \"cup\" diye YAZMA, \"glass (200 ml)\" (su bardağı) ve \"tea glass (100 ml)\" (çay bardağı) yaz.",
  },
};
export const DEFAULT_CONTENT_LANG = "tr";
export const isContentLanguage = (lang) => Object.prototype.hasOwnProperty.call(CONTENT_LANGUAGES, lang);

// Kayıtlı tarifin içerik dili. `content_lang` alanı bu özellikten önce yoktu; o
// tariflerin hepsi Türkçe üretildi (prompt "Tüm metinler Türkçe olsun" diyordu),
// bu yüzden alan yoksa Türkçe sayılır.
export function contentLangOf(recipe) {
  return recipe && isContentLanguage(recipe.content_lang) ? recipe.content_lang : DEFAULT_CONTENT_LANG;
}

// Porsiyon gerekçesi (servings_note) içerik dilinden bağımsız olarak her zaman
// shared/portionEstimate.js tarafından Türkçe üretilir.
export const SERVINGS_NOTE_LANG = "tr";

const str = (v) => (typeof v === "string" ? v : "");

// Hedef dile çevrilmesi gereken alanlar. Çevrilecek bir şey yoksa null.
// Sayısal alanlar (porsiyon, besin değerleri, kimlikler, linkler) hiç dahil değil.
export function translationPayload(recipe, target) {
  if (!recipe || !isContentLanguage(target)) return null;
  const contentNeeds = contentLangOf(recipe) !== target;
  const noteNeeds = !!str(recipe.servings_note).trim() && SERVINGS_NOTE_LANG !== target;
  if (!contentNeeds && !noteNeeds) return null;
  const ingredients = Array.isArray(recipe.ingredients) ? recipe.ingredients : [];
  const instructions = Array.isArray(recipe.instructions) ? recipe.instructions : [];
  return {
    title: contentNeeds ? str(recipe.title) : "",
    ingredients: contentNeeds ? ingredients.map((i) => ({ name: str(i && i.name), amount: str(i && i.amount) })) : [],
    instructions: contentNeeds ? instructions.map(str) : [],
    assumptions: contentNeeds ? str(recipe.assumptions) : "",
    servings_note: noteNeeds ? str(recipe.servings_note) : "",
  };
}

// Metindeki sayılar (sıralı, ondalık virgül/nokta aynı sayılır, kesir glifleri dahil).
// Çeviri bir alanda sayıları değiştirmişse o alan kullanılmaz, asıl metin gösterilir.
const GLYPHS = { "½": "0.5", "¼": "0.25", "¾": "0.75", "⅓": "0.333", "⅔": "0.667", "⅛": "0.125" };
export function numbersOf(text) {
  const out = [];
  const re = /\d+(?:[.,]\d+)?|[½¼¾⅓⅔⅛]/g;
  let m;
  while ((m = re.exec(str(text)))) out.push(GLYPHS[m[0]] || String(Number(m[0].replace(",", "."))));
  return out.join("|");
}
export const sameNumbers = (a, b) => numbersOf(a) === numbersOf(b);
