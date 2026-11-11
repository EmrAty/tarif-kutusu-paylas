import { requireUser } from "./_lib/auth.js";
import { extractRecipe, ExtractError } from "./_lib/extractRecipe.js";
import { guardAiRequest, sendGuardError } from "./_lib/aiGuard.js";
import { validateImageBatch, IMAGE_ERROR_CODES } from "../shared/imageLimits.js";
import { DEFAULT_CONTENT_LANG, isContentLanguage } from "../shared/recipeLocales.js";

// "Yeni Tarif Çıkar". Kasım 2026'ya kadar bu uç genel bir Claude proxy'siydi:
// istemcinin gönderdiği system/messages/max_tokens doğrudan Anthropic'e
// gidiyordu, yani giriş yapmış (misafir dahil) herkes bizim anahtarımızla
// istediği isteği atabiliyordu. Artık istemci yalnızca tarif girdilerini
// gönderiyor; model, prompt, JSON şeması ve token sınırı _lib/extractRecipe.js'te
// (paylaşım paneli job'uyla aynı yol).
//
// Gövde: { link?, caption?, notes?, images?: [{ mediaType, data }], language? }
// Yanıt: { recipe } — porsiyon hesabı ve content_lang uygulanmış.
export const config = { maxDuration: 180 };

const CLAUDE_TIMEOUT_MS = 160_000;
const MAX_LINK_CHARS = 2000;
const MAX_CAPTION_CHARS = 20000;
const MAX_NOTES_CHARS = 4000;

// Eski istemcinin (ya da birinin elle) gönderebileceği, artık KABUL EDİLMEYEN
// Anthropic parametreleri. Sessizce yok saymak yerine reddediliyor: eski
// sürümdeki istemci "uygulamayı yenile" mesajı görsün.
const FORBIDDEN_FIELDS = [
  "system",
  "messages",
  "model",
  "max_tokens",
  "temperature",
  "top_p",
  "top_k",
  "tools",
  "tool_choice",
  "thinking",
  "output_config",
  "stop_sequences",
  "metadata",
  "stream",
];

const IMAGE_MESSAGES = {
  [IMAGE_ERROR_CODES.tooMany]: "Çok fazla görsel seçildi.",
  [IMAGE_ERROR_CODES.tooLarge]: "Görsellerden biri çok büyük.",
  [IMAGE_ERROR_CODES.totalTooLarge]: "Görsellerin toplam boyutu çok büyük.",
  [IMAGE_ERROR_CODES.unsupported]: "Bu görsel biçimi desteklenmiyor.",
  [IMAGE_ERROR_CODES.invalid]: "Görsel okunamadı.",
};

function bad(res, status, code, error) {
  res.status(status).json({ error, code });
}

function textField(value, max) {
  if (value == null) return { ok: true, value: "" };
  if (typeof value !== "string") return { ok: false };
  if (value.length > max) return { ok: false, tooLong: true };
  return { ok: true, value };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
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

  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : null;
  if (!body) return bad(res, 400, "invalid_request", "Geçersiz istek.");
  if (FORBIDDEN_FIELDS.some((field) => field in body)) {
    return bad(res, 400, "client_update_required", "Uygulama güncellendi. Lütfen sayfayı yenileyip tekrar dene.");
  }

  const link = textField(body.link, MAX_LINK_CHARS);
  const caption = textField(body.caption, MAX_CAPTION_CHARS);
  const notes = textField(body.notes, MAX_NOTES_CHARS);
  if (!link.ok || !caption.ok || !notes.ok) {
    const tooLong = link.tooLong || caption.tooLong || notes.tooLong;
    return bad(res, 400, tooLong ? "input_too_long" : "invalid_request", tooLong ? "Metin çok uzun." : "Geçersiz istek.");
  }
  const images = body.images == null ? [] : body.images;
  const imageError = validateImageBatch(images);
  if (imageError) {
    const sizeError = imageError.code === IMAGE_ERROR_CODES.tooLarge || imageError.code === IMAGE_ERROR_CODES.totalTooLarge;
    return bad(res, sizeError ? 413 : 400, imageError.code, IMAGE_MESSAGES[imageError.code]);
  }
  if (!caption.value.trim() && !notes.value.trim() && images.length === 0) {
    return bad(res, 400, "missing_input", "Açıklama, not ya da ekran görüntüsü gerekli.");
  }
  const language = isContentLanguage(body.language) ? body.language : DEFAULT_CONTENT_LANG;

  let release;
  try {
    release = await guardAiRequest({ action: "extract", user, req });
  } catch (e) {
    if (sendGuardError(res, e)) return;
    return bad(res, 500, "internal", "İstek tamamlanamadı.");
  }

  const startedAt = Date.now();
  try {
    const { recipe, usage, stopReason } = await extractRecipe({
      link: link.value.trim(),
      caption: caption.value,
      notes: notes.value,
      images: images.map((img) => ({ mediaType: img.mediaType, data: img.data })),
      language,
      timeoutMs: CLAUDE_TIMEOUT_MS,
    });
    console.log(
      JSON.stringify({ tag: "extract", ms: Date.now() - startedAt, images: images.length, outputTokens: usage?.output_tokens, stopReason })
    );
    res.status(200).json({ recipe });
  } catch (e) {
    const kind = e instanceof ExtractError ? e.kind : "unknown";
    console.log(JSON.stringify({ tag: "extract", ms: Date.now() - startedAt, failed: kind, providerStatus: e.providerStatus }));
    if (kind === "config") return bad(res, 500, "server_config", "Sunucu yapılandırması eksik.");
    if (kind === "refused" || kind === "parse" || kind === "too_long") {
      return bad(res, 422, "extract_failed", "Bu içerikten tarif çıkarılamadı.");
    }
    if (kind === "provider" && (e.providerStatus === 429 || e.providerStatus === 529)) {
      return bad(res, 503, "ai_capacity", "Tarif servisi şu anda çok yoğun. Lütfen biraz sonra tekrar dene.");
    }
    return bad(res, 502, "extract_failed", "Tarif çıkarılamadı. Lütfen tekrar dene.");
  } finally {
    await release();
  }
}
