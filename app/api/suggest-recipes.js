import { requireUser } from "./_lib/auth.js";

export default async function handler(req, res) {
  try {
    await requireUser(req);
  } catch (e) {
    res.status(e.status || 401).json({ error: e.message });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "Sunucu yapılandırması eksik: ANTHROPIC_API_KEY tanımlı değil." });
    return;
  }

  const items = Array.isArray(req.body?.items) ? req.body.items.filter((i) => typeof i === "string" && i.trim()) : [];
  if (items.length === 0) {
    res.status(400).json({ error: "En az bir malzeme gerekli." });
    return;
  }

  const system = `Sen bir yemek önerisi asistanısın. Kullanıcının kilerinde/buzdolabında bulunan malzemelerin listesi verilecek. Bu malzemelerle (ya da çoğunlukla bu malzemelerle, ev mutfağında zaten bulunması muhtemel tuz/yağ/su gibi temel şeyler dışında fazladan 1-2 malzeme daha gerekebilir) yapılabilecek 3 ila 5 yemek fikri öner.

SADECE ve SADECE aşağıdaki şemaya uyan HAM JSON döndür. Markdown yok, açıklama yok, backtick yok, başka hiçbir metin yok:

{
  "suggestions": [
    {
      "title": string,
      "why": string, // kullanıcının malzemeleriyle neden uyduğuna dair kısa bir cümle
      "extra_needed": [string], // kullanıcının listesinde olmayan, ekstra alması gereken malzemeler (yoksa boş dizi)
      "ingredients": [ { "name": string, "amount": string } ],
      "instructions": [ string ]
    }
  ]
}

Tüm metinler Türkçe olsun. Gerçekçi ve ev mutfağında yapılabilecek yemekler öner.`;

  try {
    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 4096,
        system,
        messages: [{ role: "user", content: `Elimdeki malzemeler: ${items.join(", ")}` }],
      }),
    });

    const data = await anthropicRes.json();
    if (!anthropicRes.ok) {
      res.status(anthropicRes.status).json(data);
      return;
    }
    const text = (data.content || []).map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    const clean = text.replace(/^```json\s*|^```\s*|```$/g, "").trim();
    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (e) {
      res.status(502).json({ error: "Öneriler ayrıştırılamadı, tekrar dener misin?" });
      return;
    }
    res.status(200).json(parsed);
  } catch (e) {
    res.status(502).json({ error: "Anthropic API isteği başarısız oldu." });
  }
}
