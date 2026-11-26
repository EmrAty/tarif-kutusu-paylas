// QR ile gelen tarifi alıcının kaydına dönüştürme (saf modül; node --test ile sınanır).
//
// Alıcının kaydı BAĞIMSIZDIR: yeni kimlik, alıcının adı (addedBy), kendi seçtiği
// kategori, favori değil. Gönderenin sonraki değişiklikleri buna yansımaz (kayıt
// anında içerik kopyalanır; sonradan sunucudan tekrar okunmaz).
// `shared_from.shareId` aynı QR'ın tekrar okutulmasında aynı listeye ikinci kopya
// yazılmasını önler (bkz. addSharedRecipeOnce). Token kayda yazılmaz.
import { sanitizeSharedRecipe, findImportedCopy, SHARED_FROM_FIELD } from "../shared/recipeShare.js";
import { familyCopyId } from "../shared/recipeIds.js";

// categoryFields: App'teki shared/categories.js categoryFields(desc) sonucu
// ({ category, categoryRef? }); verilmezse paylaşılan sabit kategori (varsa) kalır.
export function buildImportedRecipe(shared, { shareId, id, now = Date.now(), title, categoryFields, addedBy = "" }) {
  const content = sanitizeSharedRecipe(shared);
  if (!content) throw new Error("invalid_shared_recipe");
  const cleanTitle = String(title ?? content.title ?? "").replace(/\s+/g, " ").trim() || content.title;
  const { category: sharedCategory, ...rest } = content;
  return {
    id,
    createdAt: now,
    ...rest,
    title: cleanTitle,
    ...(categoryFields ? categoryFields : sharedCategory ? { category: sharedCategory } : {}),
    isFavorite: false,
    addedBy,
    [SHARED_FROM_FIELD]: { shareId, at: now },
  };
}

// Hedef listede bu paylaşımdan gelmiş bir kopya varsa liste değişmez (updater;
// çakışmada sunucunun güncel listesine yeniden uygulanır, yine kopya oluşmaz).
export const addSharedRecipeOnce = (recipe, shareId) => (list) =>
  findImportedCopy(list, shareId) || list.some((r) => r && r.id === recipe.id) ? list : [recipe, ...list];

// Kaydetmeden önce: seçilen hedeflerden hangilerinde bu paylaşım zaten var.
// buckets: { [scopeKey]: recipe[] } (yalnızca yüklenmiş kovalar).
export function existingImports(buckets, targets, shareId) {
  const out = {};
  for (const key of targets) {
    const hit = findImportedCopy(buckets[key], shareId);
    if (hit) out[key] = hit.id;
  }
  return out;
}

// Kişisel kopya asıl kimliği, aile kopyası türetilmiş kimliği alır (çoklu kayıtla aynı kural).
export const importedIdFor = (recipe, scopeKey, personalKey) => (scopeKey === personalKey ? recipe.id : familyCopyId(recipe.id, scopeKey));
