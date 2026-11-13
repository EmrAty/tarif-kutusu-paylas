// Yeni bir tarifi seçilen birden fazla yere (kişisel + aileler) kaydetme (Grup 5).
//
// Eskiden kişisel liste başarısız olursa aileler hiç denenmiyor, bir aile
// başarısız olursa tüm işlem "kaydedilemedi" görünüyordu; oysa tarif bazı
// yerlere yazılmış oluyordu. Kullanıcı tekrar deneyince yeni id'li bir kopya ve
// (Yeni Tarif Çıkar'da) ikinci bir ücretli AI çağrısı oluşuyordu.
// Şimdi: her hedef ayrı denenir, sonuç hedef hedef döner. Aynı tarif nesnesi
// (aynı id) tekrar kaydedilirse zaten bulunan hedefte hiçbir şey değişmez.
// Saf modül (React/Firebase yok) — node --test ile sınanır.

export const addRecipeOnce = (recipe) => (list) => (list.some((r) => r && r.id === recipe.id) ? list : [recipe, ...list]);

// mutate(scopeKey, updater) → Promise. Kişisel liste önce (Free sınırı hatası
// belirgin olsun), aileler paralel. Hiçbir hata dışarı fırlatılmaz.
export async function saveRecipeToTargets(recipe, targets, mutate, personalKey) {
  const ordered = [...new Set(targets)];
  const saved = [];
  const failed = [];
  const run = async (scopeKey) => {
    try {
      await mutate(scopeKey, addRecipeOnce(recipe));
      saved.push(scopeKey);
    } catch (error) {
      failed.push({ scopeKey, error });
    }
  };
  if (ordered.includes(personalKey)) await run(personalKey);
  await Promise.all(ordered.filter((k) => k !== personalKey).map(run));
  // Sonuç sırası seçim sırasıyla aynı olsun (mesajlar kararlı).
  const order = (k) => ordered.indexOf(k);
  saved.sort((a, b) => order(a) - order(b));
  failed.sort((a, b) => order(a.scopeKey) - order(b.scopeKey));
  return { saved, failed };
}

// "Yeni Tarif Çıkar" için: aynı girdilerle tekrar denenirse AI'a yeniden
// gidilmez, ilk çıkarılan tarif (aynı id ile) yeniden kaydedilir.
export function extractionSignature({ link, caption, notes, images, category, language }) {
  return JSON.stringify({
    link: String(link || "").trim(),
    caption: String(caption || ""),
    notes: String(notes || ""),
    category: category || "",
    language: language || "",
    images: (images || []).map((img) => [img?.name || "", img?.size || 0, img?.previewUrl || ""]),
  });
}
