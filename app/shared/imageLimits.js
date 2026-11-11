// "Yeni Tarif Çıkar" ekran görüntüleri için ortak sınırlar. İstemci
// (src/imageCompress.js) görselleri göndermeden önce bunlara göre küçültür,
// sunucu (/api/extract) aynı kurallarla yeniden doğrular.
//
// Uzun kenar 1568 px: Claude görselleri zaten bu boyuta (~1,15 MP) indiriyor;
// daha büyüğünü göndermek okunabilirliği artırmadan yalnızca yükü büyütür.
// Telefon ekran görüntüsünde (ör. 1080×2400 → 706×1568) altyazı/malzeme
// yazıları rahatça okunur. JPEG kalite 0.85 metin kenarlarını bozmuyor.
//
// Toplam sınır Vercel'in 4,5 MB istek gövdesi sınırının güvenli altında
// (base64 ~%33 büyütür; JSON ve metin alanlarına pay bırakıldı).

export const MAX_IMAGES = 6;
export const MAX_IMAGE_EDGE = 1568;
export const FALLBACK_IMAGE_EDGE = 1280;
export const JPEG_QUALITY = 0.85;
export const JPEG_QUALITY_STEPS = [0.85, 0.75, 0.65];
export const MAX_IMAGE_BASE64_CHARS = 1_200_000; // ~0,9 MB görsel
export const MAX_TOTAL_BASE64_CHARS = 3_400_000; // ~2,5 MB görsel toplamı
export const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

export const IMAGE_ERROR_CODES = {
  tooMany: "too_many_images",
  tooLarge: "image_too_large",
  totalTooLarge: "images_total_too_large",
  unsupported: "image_unsupported",
  invalid: "image_invalid",
};

// En boy oranı korunarak uzun kenar maxEdge'e indirilir; küçük görsel büyütülmez.
export function targetDimensions(width, height, maxEdge = MAX_IMAGE_EDGE) {
  const w = Math.max(1, Math.round(Number(width) || 0));
  const h = Math.max(1, Math.round(Number(height) || 0));
  const longest = Math.max(w, h);
  if (longest <= maxEdge) return { width: w, height: h, scaled: false };
  const scale = maxEdge / longest;
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)), scaled: true };
}

// Base64 metninin çözülmüş bayt sayısı (yaklaşık değil, kesin).
export function base64Bytes(base64) {
  const len = base64.length;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((len * 3) / 4) - padding;
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

// images: [{ mediaType, data }] (sunucu) — istemci de aynı kontrolü yapar.
// Hata varsa { code, index? } döner, yoksa null.
export function validateImageBatch(images) {
  if (images == null) return null;
  if (!Array.isArray(images)) return { code: IMAGE_ERROR_CODES.invalid };
  if (images.length > MAX_IMAGES) return { code: IMAGE_ERROR_CODES.tooMany };
  let total = 0;
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    if (!img || typeof img !== "object" || typeof img.data !== "string" || typeof img.mediaType !== "string") {
      return { code: IMAGE_ERROR_CODES.invalid, index: i };
    }
    if (!ALLOWED_IMAGE_TYPES.includes(img.mediaType)) return { code: IMAGE_ERROR_CODES.unsupported, index: i };
    if (!img.data || img.data.length % 4 !== 0 || !BASE64_RE.test(img.data)) return { code: IMAGE_ERROR_CODES.invalid, index: i };
    if (img.data.length > MAX_IMAGE_BASE64_CHARS) return { code: IMAGE_ERROR_CODES.tooLarge, index: i };
    total += img.data.length;
  }
  if (total > MAX_TOTAL_BASE64_CHARS) return { code: IMAGE_ERROR_CODES.totalTooLarge };
  return null;
}
