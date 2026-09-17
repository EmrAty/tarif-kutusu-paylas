// Instagram'ın herkese açık oEmbed API'si yok (Meta'nın resmi oEmbed API'si App
// Review onayı istiyor). Bunun yerine, gönderi sayfasının HTML'indeki
// og:description meta etiketi genelde girişsiz de görünüyor — onu okuyoruz.
// Instagram istediği an bunu engelleyebilir; bu yüzden TikTok/YouTube kadar
// garantili değil.
//
// Bu dosya app/api/fetch-caption.js'ten (istemcinin "Yeni Tarif Çıkar"
// ekranında açıklamayı otomatik doldurmak için çağırdığı uç nokta) çıkarıldı,
// aynı mantık artık app/api/recipe-jobs.js'in server-side arka plan akışından
// da (Android share intent) çağrılabiliyor. Davranış/hata mesajları değişmedi.
function decodeHtmlEntities(text) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', "#039": "'", apos: "'", nbsp: " " };
  return text.replace(/&(#\d+|#x[0-9a-f]+|[a-z0-9]+);/gi, (match, entity) => {
    if (entity[0] === "#") {
      const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      if (!Number.isNaN(code)) return String.fromCodePoint(code);
      return match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

async function fetchInstagramCaption(link) {
  const pageRes = await fetch(link, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    },
  });
  if (!pageRes.ok) return null;
  const html = await pageRes.text();
  const match = html.match(/<meta property="og:description" content="([^"]*)"/);
  if (!match) return null;
  const raw = decodeHtmlEntities(match[1]);

  // Tipik biçim: `123 likes, 4 comments - kullaniciadi on 1 Ocak 2026: "asıl açıklama". `
  const captionMatch = raw.match(/:\s*"([\s\S]*)"\.?\s*$/);
  const authorMatch = raw.match(/-\s*([^\s]+)\s+on\s+/);
  return {
    caption: captionMatch ? captionMatch[1] : raw,
    authorName: authorMatch ? authorMatch[1] : "",
  };
}

export async function fetchCaptionFor(link) {
  if (/instagram\.com/i.test(link)) {
    const result = await fetchInstagramCaption(link);
    if (!result) {
      const err = new Error("Video bilgisi alınamadı.");
      err.status = 502;
      throw err;
    }
    return result;
  }

  let oembedUrl;
  if (/tiktok\.com/i.test(link)) {
    oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(link)}`;
  } else if (/youtube\.com|youtu\.be/i.test(link)) {
    oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(link)}&format=json`;
  } else {
    const err = new Error("Desteklenmeyen link. Sadece TikTok, YouTube ve Instagram linkleri destekleniyor.");
    err.status = 400;
    throw err;
  }

  const oembedRes = await fetch(oembedUrl);
  if (!oembedRes.ok) {
    const err = new Error("Video bilgisi alınamadı.");
    err.status = 502;
    throw err;
  }
  const data = await oembedRes.json();
  return { caption: data.title || "", authorName: data.author_name || "" };
}
