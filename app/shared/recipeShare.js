// QR ile tarif paylaşımı: istemci + sunucu ortak kurallar.
//
// Paylaşılan tarif alıcıya YALNIZCA içerik alanlarıyla gider (beyaz liste):
// ad, malzemeler (bölüm/tahmini miktar bilgisiyle), yapılış, püf noktaları,
// porsiyon ve hesap ayrıntıları, besin, varsayımlar, içerik dili, kaynak link
// ve sabit kategori. Gönderenin kimliği/adı (addedBy), favori işareti, kayıt
// zamanı, kimlik, özel kategori bağı (categoryRef → gönderenin uid'i) ve
// iş/kaynak işaretleri alıcıya hiç gönderilmez. Yeni bir içerik alanı eklenirse
// buraya da eklenmeli; bilinmeyen alan varsayılan olarak taşınmaz.
import { CATEGORIES } from "./recipeExtraction.js";

export const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{22,64}$/;
export const SHARE_ID_RE = /^[A-Za-z0-9_-]{8,40}$/;
// Paylaşım bağlantısının geçerlilik süresi (sn). Kullanıcı istediği an durdurabilir.
export const SHARE_TTL_SECONDS = 7 * 24 * 3600;

const CONTENT_FIELDS = [
  "title",
  "servings",
  "servings_unit",
  "servings_basis",
  "servings_range",
  "servings_calc",
  "servings_oneri",
  "servings_note",
  "suggested_servings",
  "portion",
  "prep_time_minutes",
  "difficulty",
  "ingredients",
  "instructions",
  "tips",
  "nutrition",
  "assumptions",
  "content_lang",
  "link",
];

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function sanitizeSharedRecipe(recipe) {
  if (!isPlainObject(recipe)) return null;
  const out = {};
  for (const key of CONTENT_FIELDS) {
    if (recipe[key] !== undefined) out[key] = recipe[key];
  }
  // Özel kategori gönderenin hesabına bağlı (categoryRef.uid); yalnızca sabit
  // kategori adı taşınır. Alıcı kaydederken kendi kategorisini seçer.
  if (typeof recipe.category === "string" && CATEGORIES.includes(recipe.category)) out.category = recipe.category;
  if (!Array.isArray(out.ingredients)) out.ingredients = [];
  if (!Array.isArray(out.instructions)) out.instructions = [];
  if (typeof out.title !== "string") out.title = "";
  return out;
}

// Alıcının kaydı: bağımsız yeni bir tarif (yeni kimlik, alıcının adı/kategorisi).
// `shared_from` yalnızca paylaşım kimliğini taşır (token değil); aynı QR tekrar
// okutulunca aynı listede ikinci kopya oluşmasın diye kullanılır.
export const SHARED_FROM_FIELD = "shared_from";
export function sharedFromOf(recipe) {
  const v = recipe && recipe[SHARED_FROM_FIELD];
  return isPlainObject(v) && typeof v.shareId === "string" && SHARE_ID_RE.test(v.shareId) ? v.shareId : null;
}

export function findImportedCopy(list, shareId) {
  if (!Array.isArray(list) || !shareId) return null;
  return list.find((r) => r && sharedFromOf(r) === shareId) || null;
}
