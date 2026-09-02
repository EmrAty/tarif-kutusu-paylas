export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const link = req.query.url;
  if (!link || typeof link !== "string") {
    res.status(400).json({ error: "Geçersiz istek: url alanı gerekli." });
    return;
  }

  let oembedUrl;
  if (/tiktok\.com/i.test(link)) {
    oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(link)}`;
  } else if (/youtube\.com|youtu\.be/i.test(link)) {
    oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(link)}&format=json`;
  } else {
    res.status(400).json({ error: "Desteklenmeyen link. Sadece TikTok ve YouTube linkleri destekleniyor." });
    return;
  }

  try {
    const oembedRes = await fetch(oembedUrl);
    if (!oembedRes.ok) {
      res.status(502).json({ error: "Video bilgisi alınamadı." });
      return;
    }
    const data = await oembedRes.json();
    res.status(200).json({ caption: data.title || "", authorName: data.author_name || "" });
  } catch (e) {
    res.status(502).json({ error: "Video bilgisi alınamadı." });
  }
}
