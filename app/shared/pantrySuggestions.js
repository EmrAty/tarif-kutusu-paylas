// "Elimde Bunlar Var" AI önerilerinin şeması ve doğrulaması — TEK kaynak.
// Sunucu (api/suggest-recipes.js) model çıktısını istemciye dönmeden önce
// normalizeSuggestions ile temizler; istemci (App.jsx PantryFinder) aynı
// fonksiyonları savunma katmanı olarak tekrar uygular, çünkü bir öneri
// kaydedilince kişisel tarif listesine KALICI yazılır (dizi olmayan
// instructions gibi bir değer RecipeDetail'i her açılışta çökertebilir).
// Saf modül (ağ/i18n/React yok) — node --test ile doğrudan sınanır.

export const MAX_SUGGESTIONS = 5;
export const MAX_TITLE_CHARS = 120;
export const MAX_WHY_CHARS = 400;
export const MAX_ITEM_CHARS = 200;
export const MAX_STEP_CHARS = 1500;
export const MAX_LIST_ITEMS = 60;

const NUTRITION_KEYS = ["calories", "protein_g", "carbs_g", "fat_g"];

export const SUGGESTIONS_SCHEMA = {
  type: "object",
  properties: {
    suggestions: {
      // 3–5 öğe prompt'ta isteniyor; minItems>1/maxItems yapılandırılmış çıktıda
      // desteklenmediği (istek 400 alabilir) için şemada yok, üst sınırı
      // normalizeSuggestions uygular.
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          why: { type: "string" },
          extra_needed: { type: "array", items: { type: "string" } },
          ingredients: {
            type: "array",
            items: {
              type: "object",
              properties: { name: { type: "string" }, amount: { type: "string" } },
              required: ["name", "amount"],
              additionalProperties: false,
            },
          },
          instructions: { type: "array", items: { type: "string" } },
          nutrition: {
            type: "object",
            properties: Object.fromEntries(NUTRITION_KEYS.map((k) => [k, { type: "number" }])),
            required: NUTRITION_KEYS,
            additionalProperties: false,
          },
        },
        required: ["title", "why", "extra_needed", "ingredients", "instructions", "nutrition"],
        additionalProperties: false,
      },
    },
  },
  required: ["suggestions"],
  additionalProperties: false,
};

const text = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const list = (v) => (Array.isArray(v) ? v.slice(0, MAX_LIST_ITEMS) : []);

// Tek öneri → temiz öneri ya da null (başlıksız/biçimsiz öneri atılır).
export function normalizeSuggestion(s) {
  if (!s || typeof s !== "object" || Array.isArray(s)) return null;
  const title = text(s.title, MAX_TITLE_CHARS);
  if (!title) return null;
  const ingredients = list(s.ingredients)
    .filter((i) => i && typeof i === "object" && !Array.isArray(i))
    .map((i) => ({ name: text(i.name, MAX_ITEM_CHARS), amount: text(i.amount, MAX_ITEM_CHARS) }))
    .filter((i) => i.name);
  const instructions = list(s.instructions)
    .map((step) => text(step, MAX_STEP_CHARS))
    .filter(Boolean);
  const extra_needed = list(s.extra_needed)
    .map((x) => text(x, MAX_ITEM_CHARS))
    .filter(Boolean);
  const out = { title, why: text(s.why, MAX_WHY_CHARS), extra_needed, ingredients, instructions };
  const n = s.nutrition;
  if (n && typeof n === "object" && !Array.isArray(n)) {
    const nutrition = {};
    for (const k of NUTRITION_KEYS) if (typeof n[k] === "number" && Number.isFinite(n[k])) nutrition[k] = n[k];
    if (Object.keys(nutrition).length) out.nutrition = nutrition;
  }
  return out;
}

// Model çıktısı → geçerli önerilerin dizisi (en çok MAX_SUGGESTIONS). suggestions
// dizi değilse ya da hiç geçerli öneri yoksa boş dizi; çağıran taraf bunu hata sayar.
export function normalizeSuggestions(parsed) {
  const raw = parsed && typeof parsed === "object" ? parsed.suggestions : undefined;
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const s of raw) {
    const clean = normalizeSuggestion(s);
    if (clean) out.push(clean);
    if (out.length >= MAX_SUGGESTIONS) break;
  }
  return out;
}
