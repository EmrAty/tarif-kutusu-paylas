// HAIKU DENEMESİ (trial/haiku-extraction): tarif çıkarma modeli ortama göre seçilir.
// - Vercel Preview (VERCEL_ENV === "preview"): Claude Haiku 5.5, varsayılan ayar (adaptive düşünme,
//   effort medium). 14–15 Kasım ücretli karşılaştırmada en iyi sonuç veren ayar budur; düşünmesiz
//   sürüm kullanılmaz (kaynakta olmayan yapılış üretti, hata oranı iki katıydı).
// - Diğer her yerde (production, yerel, testler): bugünkü Claude Sonnet 5.
// Bu dal yanlışlıkla production'a çıksa bile model değişmez. Hem sunucu (_lib/extractRecipe.js) hem
// derleme (vite.config.js → /version.json "extractModel") bu fonksiyonu kullanır; yayından sonra hangi
// modelin seçildiği ücretli çağrı yapmadan /version.json'dan okunabilir.
export const PRODUCTION_EXTRACT_MODEL = "claude-sonnet-5";
export const TRIAL_EXTRACT_MODEL = "claude-haiku-5-5";

export function extractionModel(env = process.env) {
  return env.VERCEL_ENV === "preview" ? TRIAL_EXTRACT_MODEL : PRODUCTION_EXTRACT_MODEL;
}
