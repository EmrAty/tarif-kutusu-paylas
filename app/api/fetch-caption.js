import { fetchCaptionFor } from "./_lib/caption.js";

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

  try {
    const result = await fetchCaptionFor(link);
    res.status(200).json(result);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message || "Video bilgisi alınamadı." });
  }
}
