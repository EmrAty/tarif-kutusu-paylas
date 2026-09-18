// OpenAI konuşma-metne çevirme (Whisper ailesi yerine gpt-4o-mini-transcribe:
// resmi fiyat listesinde dakikası ~$0,003 ile en ucuz transcription modeli;
// gpt-transcribe $0,0045, gpt-4o-transcribe ve Whisper $0,006).
// Uç nokta mp4'ü doğrudan kabul ettiği için sesi ayırmaya (ffmpeg) gerek yok,
// ama dosya 25 MB'ı geçemiyor - çağıran taraf bunu zaten sınırlıyor.
const MODEL = "gpt-4o-mini-transcribe";
const ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";

export const TRANSCRIBE_MODEL = MODEL;
export const OPENAI_MAX_FILE_BYTES = 25 * 1024 * 1024;

export function hasTranscriptionKey() {
  return !!process.env.OPENAI_API_KEY;
}

// Dil bilerek gönderilmiyor: uygulamada çoğunlukla Türkçe video paylaşılsa da
// sabitlemek İngilizce tarif videolarını bozardı, otomatik algılama ikisini de
// karşılıyor (tarifin kendisi zaten Claude'un prompt'u gereği Türkçe çıkıyor).
export async function transcribeMedia({ bytes, contentType, filename, timeoutMs }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Sunucu yapılandırması eksik: OPENAI_API_KEY tanımlı değil.");
  if (bytes.byteLength > OPENAI_MAX_FILE_BYTES) throw new Error("Ses dosyası transkripsiyon sınırını aşıyor.");

  const form = new FormData();
  form.append("file", new Blob([bytes], { type: contentType || "video/mp4" }), filename || "video.mp4");
  form.append("model", MODEL);
  form.append("response_format", "json");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  let data;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    data = await res.json().catch(() => null);
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`Konuşma metne çevirme ${Math.round(timeoutMs / 1000)} sn içinde bitmedi.`);
    throw new Error("Transkripsiyon servisine ulaşılamadı.");
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok || !data) {
    throw new Error(`Transkripsiyon hatası (${res.status}): ${data?.error?.message || "bilinmeyen"}`);
  }
  return { text: typeof data.text === "string" ? data.text : "", model: MODEL, usage: data.usage || null };
}
