// Püf noktaları (`recipe.tips`: metin dizisi).
//
// Tarif çıkarılırken model yalnızca KAYNAKTA yazan ipuçlarını buraya koyar (aynı
// çağrı, ek AI çağrısı yok; bkz. shared/recipeExtraction.js). Modelin kendi
// tahmin/notları ayrı `assumptions` alanında kalır; ikisi karışmaz. Elle oluşturma
// ve düzenlemede kullanıcı da ekleyebilir. Alan boşsa kayda hiç yazılmaz: eski
// tariflerin çeviri önbelleği ve içerik parmak izi değişmez.

export const MAX_TIPS = 12;
export const TIP_MAX_CHARS = 400;

// Kayda girecek biçim: kırpılmış, boş olmayan, tekrarsız metinler; sınır aşılırsa kesilir.
export function normalizeTips(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    if (typeof raw !== "string") continue;
    const text = raw.replace(/\s+/g, " ").trim().slice(0, TIP_MAX_CHARS);
    const key = text.toLocaleLowerCase("tr");
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= MAX_TIPS) break;
  }
  return out;
}

// Gösterim için: kayıttaki püf noktaları (bozuk/eksik alan boş dizi).
export function tipsOf(recipe) {
  return normalizeTips(recipe && recipe.tips);
}

// Tarif nesnesine uygular: boşsa alan kaldırılır.
export function withTips(recipe, tips) {
  const clean = normalizeTips(tips);
  const out = { ...recipe };
  if (clean.length) out.tips = clean;
  else delete out.tips;
  return out;
}
