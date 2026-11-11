import { requireUser } from "./_lib/auth.js";
import { guardAiRequest, sendGuardError } from "./_lib/aiGuard.js";

export const config = { maxDuration: 90 };

// Kiler listesi normalde birkaç düzine malzeme; sınırlar yalnızca keyfi uzun
// girdiyle token şişirmeyi engelliyor.
const MAX_ITEMS = 80;
const MAX_ITEM_CHARS = 80;
const CLAUDE_TIMEOUT_MS = 75_000;

export default async function handler(req, res) {
  let user;
  try {
    user = await requireUser(req);
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

  const items = Array.isArray(req.body?.items)
    ? [...new Set(req.body.items.filter((i) => typeof i === "string" && i.trim()).map((i) => i.trim().slice(0, MAX_ITEM_CHARS)))]
    : [];
  if (items.length === 0) {
    res.status(400).json({ error: "En az bir malzeme gerekli." });
    return;
  }
  if (items.length > MAX_ITEMS) {
    res.status(400).json({ error: "Çok fazla malzeme seçildi.", code: "input_too_long" });
    return;
  }

  let release;
  try {
    release = await guardAiRequest({ action: "suggest", user, req });
  } catch (e) {
    if (sendGuardError(res, e)) return;
    res.status(500).json({ error: "İstek tamamlanamadı." });
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
      "instructions": [ string ],
      "nutrition": {
        "calories": number,
        "protein_g": number,
        "carbs_g": number,
        "fat_g": number
      }
    }
  ]
}

Nutrition alanındaki değerler porsiyon başına DEĞİL, tarifteki TÜM malzemelerin toplamı olsun (tarifin bütünü için toplam kalori, protein, karbonhidrat, yağ). Bunlar kesin laboratuvar ölçümü değil, makul birer tahmin olabilir; ama kalori ile makrolar arasında matematiksel olarak tutarlı ol (yaklaşık: protein ve karbonhidrat 4 kcal/g, yağ 9 kcal/g) — aşırı mantıksız bir fark oluşturma.

Tüm metinler Türkçe olsun. Gerçekçi ve ev mutfağında yapılabilecek yemekler öner.`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLAUDE_TIMEOUT_MS);
  try {
    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
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

    const data = await anthropicRes.json().catch(() => null);
    if (!anthropicRes.ok || !data) {
      // Sağlayıcının hata gövdesi istemciye iletilmiyor (hesap/anahtar ayrıntısı içerebilir).
      console.log(JSON.stringify({ tag: "suggest-recipes", providerStatus: anthropicRes.status }));
      const busy = anthropicRes.status === 429 || anthropicRes.status === 529;
      res.status(busy ? 503 : 502).json(
        busy
          ? { error: "Tarif servisi şu anda çok yoğun. Lütfen biraz sonra tekrar dene.", code: "ai_capacity" }
          : { error: "Öneriler alınamadı, tekrar dener misin?" }
      );
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
  } finally {
    clearTimeout(timer);
    await release();
  }
}
