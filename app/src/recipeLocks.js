// Free hesapta kişisel tarif sayısı sınırı aşıyorsa (ör. Plus kapandıktan
// sonra) yalnızca EN ESKİ `limit` tarif erişilebilir; daha yeniler kilitli
// görünür. Kilit tarife yazılmaz, her render'da buradan türetilir: Plus geri
// gelince ya da tarif silinince kendiliğinden yeniden hesaplanır.

const ID_TIMESTAMP_RE = /^(\d{12,})-/;

// Ekleme zamanı: createdAt (ilk sürümden beri her kayıt yolu yazıyor); yoksa
// id'nin başındaki Date.now() (uid() biçimi "<ms>-<rastgele>"); o da yoksa 0 —
// tarihsiz kayıtlar yalnızca createdAt'ten önceki eski veriden gelebileceği
// için en eski sayılır.
export function recipeAddedAt(recipe) {
  const created = Number(recipe?.createdAt);
  if (Number.isFinite(created) && created > 0) return created;
  const match = typeof recipe?.id === "string" ? recipe.id.match(ID_TIMESTAMP_RE) : null;
  if (match) return Number(match[1]);
  return 0;
}

// Eskiden yeniye kararlı sıra: aynı zamanlı tariflerde id ikinci anahtar.
export function compareByAddedAt(a, b) {
  const diff = recipeAddedAt(a) - recipeAddedAt(b);
  if (diff !== 0) return diff;
  const ia = String(a?.id ?? "");
  const ib = String(b?.id ?? "");
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

// Kilitli kişisel tariflerin id'leri. Plus'ta ya da sınır aşılmadıysa boş.
export function lockedRecipeIds(personalRecipes, { isPlus, limit }) {
  const list = Array.isArray(personalRecipes) ? personalRecipes.filter((r) => r && r.id != null) : [];
  if (isPlus || list.length <= limit) return new Set();
  const sorted = [...list].sort(compareByAddedAt);
  return new Set(sorted.slice(limit).map((r) => r.id));
}
