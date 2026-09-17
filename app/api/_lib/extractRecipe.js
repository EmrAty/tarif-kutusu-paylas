// app/src/App.jsx'teki extractRecipe()'in (manuel "Yeni Tarif Çıkar" ekranı)
// server-side eşdeğeri — Android share-intent arka plan job'ı (recipe-jobs.js)
// için. AYNI system prompt, AYNI model, AYNI JSON şema/ayrıştırma; sadece görsel
// (ekran görüntüsü) desteği yok, çünkü Android share intent'i (ACTION_SEND,
// text/plain) hiç görsel taşımıyor. /api/extract.js'e (istemcinin kendi prompt'unu
// gönderdiği ham proxy) dokunulmadı — bu, ondan tamamen ayrı, paralel bir yol.
const SYSTEM_PROMPT = `Sen bir yemek tarifi çıkarma asistanısın. Sana bir sosyal medya (TikTok/YouTube) yemek videosuna dair bilgi verilecek — bu, videonun tam açıklama/altyazı metni olabilir, kullanıcının videoyu izlerken gördüğü malzemeler hakkında yazdığı kısa bir not olabilir, ve/veya videodan alınmış ekran görüntüleri olabilir (görüntülerde video açıklaması, altyazı, ya da ekranda görünen malzeme/tarif yazıları olabilir — görsellerdeki TÜM metni dikkatlice oku). Hangisi verilirse verilsin, bundan yapılandırılmış tarif bilgisi çıkar.

SADECE ve SADECE aşağıdaki şemaya uyan HAM JSON döndür. Markdown yok, açıklama yok, backtick yok, başka hiçbir metin yok:

{
  "title": string,
  "servings": number,
  "prep_time_minutes": number,
  "difficulty": string, // "Kolay", "Orta" veya "Zor" değerlerinden biri
  "ingredients": [ { "name": string, "amount": string } ],
  "instructions": [ string ],
  "nutrition": {
    "calories": number,
    "protein_g": number,
    "carbs_g": number,
    "fat_g": number
  },
  "assumptions": string
}

Nutrition alanındaki değerler porsiyon başına DEĞİL, tarifteki TÜM malzemelerin toplamı olsun (tarifin bütünü için toplam kalori, protein, karbonhidrat, yağ).

Eğer sana verilen metin/görsellerde malzemeler açıkça ve eksiksiz yazılı DEĞİLSE ve sen bu yemeğin genel bilgine dayanarak malzemelerin bir kısmını ya da tamamını kendin tahmin ettiysen, bunu "assumptions" alanında AÇIKÇA belirt (örn: "Malzemelerin bir kısmı bu yemeğin tipik tarifine göre tarafımca tamamlandı."). Malzemeler zaten eksiksiz yazılıysa bunu belirtmene gerek yok.

Miktarlar net değilse o yemeğin tipik bir porsiyonuna göre makul tahminler yap ve bunu "assumptions" alanında belirt. Yapılış adımları verilmemişse "instructions" alanını boş dizi olarak döndür, uydurma. "prep_time_minutes" ve "difficulty" belirtilmemişse tarifin niteliğine göre makul bir tahmin yap. Tüm metinler Türkçe olsun.`;

export async function extractRecipeFromText({ link, caption, notes }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const err = new Error("Sunucu yapılandırması eksik: ANTHROPIC_API_KEY tanımlı değil.");
    err.status = 500;
    throw err;
  }

  const captionText = (caption || "").trim();
  const notesText = (notes || "").trim();
  const textSection = `Video linki: ${link || "(verilmedi)"}

${captionText ? `Video açıklaması / altyazısı:\n"""\n${captionText}\n"""` : "(Video açıklaması verilmedi.)"}

${notesText ? `Kullanıcının notu: ${notesText}` : ""}`;

  const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: [{ type: "text", text: textSection }] }],
    }),
  });

  const data = await anthropicRes.json().catch(() => null);
  if (!anthropicRes.ok || !data) {
    const err = new Error("Tarif oluşturulamadı: Claude API isteği başarısız oldu.");
    err.status = 502;
    throw err;
  }

  const text = (data.content || [])
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();
  const clean = text.replace(/^```json\s*|^```\s*|```$/g, "").trim();
  try {
    return JSON.parse(clean);
  } catch (e) {
    const err = new Error("Tarif ayrıştırılamadı.");
    err.status = 502;
    throw err;
  }
}
