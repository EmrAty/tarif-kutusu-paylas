const ALLOWED_KEYS = new Set(["recipes", "shopping-list", "pantry-items"]);

export default async function handler(req, res) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    res.status(500).json({ error: "Sunucu yapılandırması eksik: veritabanı bağlantısı tanımlı değil." });
    return;
  }

  if (req.method === "GET") {
    const key = req.query.key;
    if (!ALLOWED_KEYS.has(key)) {
      res.status(400).json({ error: "Geçersiz anahtar." });
      return;
    }
    try {
      const kvRes = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await kvRes.json();
      res.status(200).json({ value: data.result ?? null });
    } catch (e) {
      res.status(502).json({ error: "Veritabanına erişilemedi." });
    }
    return;
  }

  if (req.method === "POST") {
    const { key, value } = req.body || {};
    if (!ALLOWED_KEYS.has(key) || typeof value !== "string") {
      res.status(400).json({ error: "Geçersiz istek." });
      return;
    }
    try {
      const kvRes = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(["SET", key, value]),
      });
      if (!kvRes.ok) {
        res.status(502).json({ error: "Veritabanına yazılamadı." });
        return;
      }
      res.status(200).json({ ok: true });
    } catch (e) {
      res.status(502).json({ error: "Veritabanına yazılamadı." });
    }
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
}
