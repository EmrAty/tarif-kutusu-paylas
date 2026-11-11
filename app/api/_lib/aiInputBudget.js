// AI sağlayıcısına gönderilecek metnin sunucu tarafı boyut bütçesi.
// Hız sınırı çağrı SAYISINI keser; bu yardımcı tek bir çağrının token/maliyetini
// keser. Sağlayıcıya, hız sayaçlarına ve maliyet sayaçlarına (aiGuard) gitmeden
// ÖNCE çağrılmalı: bütçeyi aşan istek hiçbir sayacı tüketmez, hiçbir token harcamaz.
//
// Sınırlar karakter cinsinden (Türkçe/İngilizce metinde ~3–4 karakter ≈ 1 token).

export const INPUT_TOO_LARGE_CODE = "input_too_large";

// Bir değerin (string / dizi / nesne, iç içe) içindeki tüm metinlerin toplam uzunluğu.
// Anahtar adları ve sayılar sayılmaz: yalnızca modele çevrilmek/işlenmek üzere giden metin.
export function textChars(value) {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce((n, v) => n + textChars(v), 0);
  if (value && typeof value === "object") return Object.values(value).reduce((n, v) => n + textChars(v), 0);
  return 0;
}

// limits: {
//   maxTotalChars: toplam metin bütçesi (asıl sınır),
//   fields: { alan: maxChars }   → üst düzey tek alan sınırı (ör. title),
//   arrays: { alan: maxItems }   → dizi eleman sayısı sınırı (ör. ingredients),
// }
// Bütçe içindeyse null, değilse { code, reason, field?, chars?, limit } döner.
export function checkInputBudget(input, { maxTotalChars, fields = {}, arrays = {} } = {}) {
  const source = input && typeof input === "object" ? input : {};
  for (const [field, limit] of Object.entries(fields)) {
    const chars = textChars(source[field]);
    if (chars > limit) return { code: INPUT_TOO_LARGE_CODE, reason: "field", field, chars, limit };
  }
  for (const [field, limit] of Object.entries(arrays)) {
    const count = Array.isArray(source[field]) ? source[field].length : 0;
    if (count > limit) return { code: INPUT_TOO_LARGE_CODE, reason: "items", field, count, limit };
  }
  if (maxTotalChars != null) {
    const chars = textChars(input);
    if (chars > maxTotalChars) return { code: INPUT_TOO_LARGE_CODE, reason: "total", chars, limit: maxTotalChars };
  }
  return null;
}
