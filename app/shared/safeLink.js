// Tarif kaynağı linki için TEK kural (sunucu ve istemci aynı modülü kullanır).
//
// Tarif listeleri (kişisel ve aile) istemciden yazılıyor; aile üyesi başka bir
// üyenin göreceği tarife link koyabiliyor. Link <a href> içine girdiği için
// `javascript:`, `data:`, `vbscript:`, `file:`, `intent:` gibi şemalar uygulama
// içinde (WebView) kod çalıştırabilir ya da başka uygulamayı açabilir.
// Kural: yalnızca kimlik bilgisi içermeyen, makul uzunlukta http(s) adresleri.
// Hangi sitenin olduğu SINIRLANMAZ (kullanıcı kendi blog linkini de koyabilir);
// paylaşım job'ları ayrıca socialUrl.js ile yalnızca desteklenen sitelere izin verir.

export const MAX_LINK_CHARS = 2048;

// Güvenliyse normalleştirilmiş adresi, değilse "" döndürür. Boş girdi → "".
export function safeRecipeLink(raw) {
  if (typeof raw !== "string") return "";
  const text = raw.trim();
  if (!text || text.length > MAX_LINK_CHARS) return "";
  // Kontrol karakterleri/boşluk içeren adresler (ör. "java\nscript:") reddedilir;
  // URL ayrıştırıcısı bunları sessizce silip şemayı değiştirebilir.
  if (/[\u0000-\u001F\u007F\s]/.test(text)) return "";
  let url;
  try {
    url = new URL(text);
  } catch {
    return "";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "";
  if (url.username || url.password) return "";
  if (!url.hostname) return "";
  return url.href;
}

export const isSafeRecipeLink = (raw) => safeRecipeLink(raw) !== "";
