// Tarif çıkarma modeli — TEK kaynak. Her ortamda (Production, Preview, yerel, testler) aynı model.
//
// Karar (15 Kasım 2026): yayın adayında Claude Haiku 5.5. Dayanak: ücretli karşılaştırma
// (experiment/cheap-extraction, Haiku varsayılan ayar 48/51 liste tarifi tam doğru, uydurma adım/porsiyon
// yok, ~%96 ucuz) ve kullanıcının Preview'daki telefon denemesi (trial/haiku-extraction). Deneme dalındaki
// "yalnız VERCEL_ENV=preview iken Haiku" kuralı kaldırıldı: Preview'da test edilen model, onaydan sonra
// Production'da çalışacak modelin aynısı olmalı.
//
// Haiku varsayılan ayarla çağrılır (adaptive düşünme, effort medium). thinking/effort parametresi
// gönderilmez; düşünmesiz sürüm kullanılmaz (karşılaştırmada kaynakta olmayan yapılış üretti).
//
// YALNIZCA tarif çıkarma (/api/extract + paylaşım job'u, _lib/extractRecipe.js). Çeviri
// (api/translate-recipe.js) ve kiler önerileri (api/suggest-recipes.js) kendi modelinde (Sonnet 5) kalır;
// test/extractModel.test.mjs bunu da sabitler.
//
// Gözlem: /version.json → "extractModel" (derleme bu fonksiyonu çağırır; verify:deploy beklenenle karşılaştırır),
// job kaydı timings.extractModel, loglarda "model".
export const EXTRACT_MODEL = "claude-haiku-5-5";

export function extractionModel() {
  return EXTRACT_MODEL;
}
