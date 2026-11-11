import { tiktokCaption } from "./_lib/tiktok.js";
import { requireUser } from "./_lib/auth.js";
import { checkRateLimit, clientIp, sendGuardError } from "./_lib/aiGuard.js";
import { parseSocialUrl, safeFetch, readTextLimited, SUPPORTED_LINK_MESSAGE } from "./_lib/socialUrl.js";

// Güvenlik (Kasım 2026): eskiden link içinde "instagram.com" geçmesi yetiyordu
// ve fetch redirect'leri kendisi izliyordu — "http://10.0.0.5/?x=instagram.com"
// gibi bir adres sunucudan çekilebiliyordu (SSRF). Artık link gerçek URL
// ayrıştırmasıyla yalnızca TikTok/YouTube/Instagram alan adlarına izin veriyor,
// her redirect yeniden doğrulanıyor (socialUrl.js) ve uç giriş istiyor (misafir
// hesap da giriş sayılır). İstemciler (AddForm, SharePanel) token gönderiyor.
const PAGE_TIMEOUT_MS = 10_000;
const MAX_PAGE_BYTES = 5 * 1024 * 1024;
const MAX_OEMBED_BYTES = 256 * 1024;

// Instagram'ın herkese açık oEmbed API'si yok (Meta'nın resmi oEmbed API'si App
// Review onayı istiyor). Bunun yerine, gönderi sayfasının HTML'indeki
// og:description meta etiketi genelde girişsiz de görünüyor — onu okuyoruz.
// Instagram istediği an bunu engelleyebilir; bu yüzden TikTok/YouTube kadar
// garantili değil.
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
  const html = await safeFetch(
    link,
    {
      policy: "social",
      timeoutMs: PAGE_TIMEOUT_MS,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      },
    },
    async (res) => (res.ok ? readTextLimited(res, MAX_PAGE_BYTES) : null)
  );
  if (html == null) return null;
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

async function fetchOembed(oembedUrl) {
  return safeFetch(oembedUrl, { policy: "social", timeoutMs: PAGE_TIMEOUT_MS }, async (res) => {
    if (!res.ok) return null;
    try {
      return JSON.parse(await readTextLimited(res, MAX_OEMBED_BYTES));
    } catch (e) {
      return null;
    }
  });
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    res.status(e.status || 401).json({ error: e.message });
    return;
  }

  const raw = req.query.url;
  if (!raw || typeof raw !== "string") {
    res.status(400).json({ error: "Geçersiz istek: url alanı gerekli." });
    return;
  }
  const parsed = parseSocialUrl(raw);
  if (!parsed) {
    res.status(400).json({ error: SUPPORTED_LINK_MESSAGE });
    return;
  }
  const link = parsed.url;

  try {
    await checkRateLimit({ action: "caption", uid: user.uid, isAnonymous: user.isAnonymous, ip: clientIp(req) });
  } catch (e) {
    if (sendGuardError(res, e)) return;
    throw e;
  }

  try {
    if (parsed.platform === "instagram") {
      const result = await fetchInstagramCaption(link);
      if (!result) {
        res.status(502).json({ error: "Video bilgisi alınamadı." });
        return;
      }
      res.status(200).json(result);
      return;
    }

    let oembedUrl;
    if (parsed.platform === "tiktok") {
      // TikTok'un oEmbed yanıtı artık açıklamayı (title) taşımıyor; açıklama
      // doğrudan video sayfasından okunuyor (kısa vt.tiktok.com linkleri de
      // burada, doğrulanan redirect zinciriyle çözülüyor). oEmbed yalnızca
      // sayfa alınamazsa son çare.
      const page = await tiktokCaption(link);
      if (page && page.caption) {
        res.status(200).json({ caption: page.caption, authorName: page.authorName, resolvedUrl: page.resolvedUrl });
        return;
      }
      oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(link)}`;
    } else {
      oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(link)}&format=json`;
    }

    const data = await fetchOembed(oembedUrl);
    // Açıklama yoksa 200 + boş caption yerine hata: istemciler (AddForm, Share
    // Panel) "alınamadı" notunu ancak hata yanıtında gösteriyor.
    if (!data || !data.title) {
      res.status(502).json({ error: "Video bilgisi alınamadı." });
      return;
    }
    res.status(200).json({ caption: data.title, authorName: data.author_name || "" });
  } catch (e) {
    res.status(502).json({ error: "Video bilgisi alınamadı." });
  }
}
