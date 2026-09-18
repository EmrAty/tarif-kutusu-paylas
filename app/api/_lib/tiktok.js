import { transcribeMedia, TRANSCRIBE_MODEL, OPENAI_MAX_FILE_BYTES, hasTranscriptionKey } from "./transcribe.js";

// TikTok'un kendi HTML/JSON yapısına bağlı TEK dosya burası. TikTok yapısını
// değiştirdiğinde sadece bu fallback çalışmaz; caption'ı yeterli olan normal
// tarif akışı, /api/extract, Instagram ve YouTube yolları etkilenmez. Bu yüzden
// buradaki her adım hata fırlatmak yerine null dönebiliyor.
//
// Ölçülen gerçekler (17 Eylül 2026, gerçek videolarla):
// - Masaüstü User-Agent'ı TikTok'un WAF'ına ("Please wait...") takılıyor;
//   iPhone UA'sı ile sayfa normal geliyor.
// - Mobil sayfada video verisi <script id="api-data"> içinde
//   videoDetail.itemInfo.itemStruct yolunda; masaüstü sayfada aynı yapı
//   __UNIVERSAL_DATA_FOR_REHYDRATION__ içinde geliyor. İkisi de destekleniyor.
// - playAddr/downloadAddr yalnızca sayfanın Set-Cookie'si VE Referer birlikte
//   gönderilirse iniyor; biri eksikse 403 "Access Denied".
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const REFERER = "https://www.tiktok.com/";

// Sınırlar: ~30 sn'lik bir TikTok 6 MB geliyor, yani 20 MB kabaca 100 sn'lik
// videoya denk. OpenAI'ın 25 MB dosya sınırının altında kalmak şart.
const MAX_VIDEO_SECONDS = 180;
const MAX_VIDEO_BYTES = Math.min(20 * 1024 * 1024, OPENAI_MAX_FILE_BYTES);
const PAGE_TIMEOUT_MS = 15_000;
const SUBTITLE_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const MIN_TRANSCRIPT_CHARS = 200;

export function isTikTokLink(url) {
  return /(^|\.)tiktok\.com/i.test((() => {
    try {
      return new URL(url).hostname;
    } catch (e) {
      return "";
    }
  })());
}

async function fetchWithTimeout(url, { timeoutMs, ...init }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function readSetCookies(headers) {
  const list = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : null;
  if (list && list.length) return list.map((c) => c.split(";")[0]).join("; ");
  const single = headers.get("set-cookie");
  return single ? single.split(";")[0] : "";
}

// Sayfadaki JSON script'lerinden itemStruct'ı bulur. Yolu sabitlemek yerine
// aranmasının sebebi: mobil ve masaüstü sayfalar aynı nesneyi farklı yollarda
// taşıyor ve TikTok bu yolu geçmişte değiştirdi.
function findItemStruct(html) {
  for (const match of html.matchAll(/<script id="([^"]+)" type="application\/json">([\s\S]*?)<\/script>/g)) {
    if (!match[2].includes("itemStruct")) continue;
    let data;
    try {
      data = JSON.parse(match[2]);
    } catch (e) {
      continue;
    }
    const stack = [{ node: data, depth: 0 }];
    while (stack.length) {
      const { node, depth } = stack.pop();
      if (!node || typeof node !== "object" || depth > 12) continue;
      if (!Array.isArray(node) && node.itemStruct && node.itemStruct.video) return node.itemStruct;
      for (const value of Object.values(node)) {
        if (value && typeof value === "object") stack.push({ node: value, depth: depth + 1 });
      }
    }
  }
  return null;
}

async function loadVideoPage(url) {
  const res = await fetchWithTimeout(url, {
    timeoutMs: PAGE_TIMEOUT_MS,
    redirect: "follow",
    headers: { "User-Agent": IPHONE_UA, "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8", Accept: "text/html" },
  });
  if (!res.ok) return null;
  const cookie = readSetCookies(res.headers);
  const item = findItemStruct(await res.text());
  if (!item) return null;

  const video = item.video || {};
  return {
    cookie,
    desc: typeof item.desc === "string" ? item.desc : "",
    durationSeconds: Number(video.duration) || 0,
    subtitles: Array.isArray(video.subtitleInfos) ? video.subtitleInfos : [],
    mediaUrls: [video.playAddr, video.downloadAddr].filter((u) => typeof u === "string" && u),
  };
}

// WEBVTT -> düz metin: zaman damgaları, cue numaraları, <c>/<00:00:01.000>
// etiketleri atılıyor; ASR altyazıları aynı satırı üst üste tekrarladığı için
// ardışık tekrarlar da teke indiriliyor.
function vttToPlainText(vtt) {
  const lines = [];
  for (const rawLine of vtt.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line === "WEBVTT") continue;
    if (line.includes("-->")) continue;
    if (/^\d+$/.test(line)) continue;
    if (/^(NOTE|STYLE|REGION|Kind:|Language:)/i.test(line)) continue;
    const clean = line.replace(/<[^>]*>/g, "").trim();
    if (!clean) continue;
    if (lines[lines.length - 1] === clean) continue;
    lines.push(clean);
  }
  return lines.join(" ").replace(/\s+/g, " ").trim();
}

function pickSubtitle(subtitles) {
  const vtt = subtitles.filter((s) => /webvtt/i.test(s?.Format || "") && s?.Url);
  if (!vtt.length) return null;
  return vtt.find((s) => /^tur/i.test(s.LanguageCodeName || "")) || vtt[0];
}

async function fetchSubtitle(subtitle, cookie) {
  const res = await fetchWithTimeout(subtitle.Url, {
    timeoutMs: SUBTITLE_TIMEOUT_MS,
    headers: { "User-Agent": IPHONE_UA, Referer: REFERER, ...(cookie ? { Cookie: cookie } : {}) },
  });
  if (!res.ok) return "";
  return vttToPlainText(await res.text());
}

// Boyut sınırı hem Content-Length'ten hem akarken sayarak uygulanıyor: sunucu
// uzunluğu bildirmese de fonksiyonun belleği kontrolsüz büyümesin.
async function downloadVideo(mediaUrls, cookie) {
  let lastStatus = 0;
  for (const url of mediaUrls) {
    const res = await fetchWithTimeout(url, {
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      headers: { "User-Agent": IPHONE_UA, Referer: REFERER, Accept: "*/*", ...(cookie ? { Cookie: cookie } : {}) },
    });
    if (!res.ok || !res.body) {
      lastStatus = res.status;
      continue;
    }
    const declared = Number(res.headers.get("content-length")) || 0;
    if (declared > MAX_VIDEO_BYTES) {
      await res.body.cancel().catch(() => {});
      return { tooLarge: true, bytes: declared };
    }
    const chunks = [];
    let total = 0;
    let tooLarge = false;
    // break, async iterator'ın return()'ünü tetikleyip akışı kapatıyor; kilitli
    // bir akışta cancel() çağırmak yerine bu tercih edildi.
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > MAX_VIDEO_BYTES) {
        tooLarge = true;
        break;
      }
      chunks.push(chunk);
    }
    if (tooLarge) return { tooLarge: true, bytes: total };
    return { bytes: Buffer.concat(chunks), contentType: res.headers.get("content-type") || "video/mp4" };
  }
  return { error: `video indirilemedi (${lastStatus || "yanıt yok"})` };
}

// Caption yetersiz kaldığında çağrılıyor. Sırayla: TikTok altyazısı -> videoyu
// indirip konuşmayı metne çevirme. Hiçbiri yeterli metin vermezse null döner,
// çağıran taraf job'ı "failed" yapar (tarif uydurulmaz).
export async function tiktokTranscript(url, { budgetMs, log }) {
  const timings = {};
  const meta = {};
  const note = (step, ms, extra) => {
    timings[step] = ms;
    if (log) log(step, ms, extra);
  };

  let t = Date.now();
  let page;
  try {
    page = await loadVideoPage(url);
  } catch (e) {
    page = null;
    meta.pageError = e.name === "AbortError" ? "zaman aşımı" : e.message;
  }
  note("tiktokPage", Date.now() - t, { found: !!page, subtitles: page?.subtitles.length ?? 0 });
  if (!page) return { transcript: "", method: "none", timings, meta };

  meta.durationSeconds = page.durationSeconds;

  const subtitle = pickSubtitle(page.subtitles);
  if (subtitle) {
    t = Date.now();
    let text = "";
    try {
      text = await fetchSubtitle(subtitle, page.cookie);
    } catch (e) {
      meta.subtitleError = e.name === "AbortError" ? "zaman aşımı" : e.message;
    }
    note("tiktokSubtitle", Date.now() - t, { lang: subtitle.LanguageCodeName, source: subtitle.Source, chars: text.length });
    if (text.length >= MIN_TRANSCRIPT_CHARS) {
      return { transcript: text, method: "subtitle", timings, meta: { ...meta, subtitleLanguage: subtitle.LanguageCodeName } };
    }
    meta.subtitleChars = text.length;
  }

  if (!hasTranscriptionKey()) {
    meta.transcribeSkipped = "OPENAI_API_KEY yok";
    return { transcript: "", method: "none", timings, meta };
  }
  if (page.durationSeconds > MAX_VIDEO_SECONDS) {
    meta.transcribeSkipped = `video ${page.durationSeconds} sn (sınır ${MAX_VIDEO_SECONDS} sn)`;
    return { transcript: "", method: "none", timings, meta };
  }
  if (!page.mediaUrls.length) {
    meta.transcribeSkipped = "video adresi yok";
    return { transcript: "", method: "none", timings, meta };
  }

  t = Date.now();
  let download;
  try {
    download = await downloadVideo(page.mediaUrls, page.cookie);
  } catch (e) {
    download = { error: e.name === "AbortError" ? "indirme zaman aşımı" : e.message };
  }
  note("tiktokDownload", Date.now() - t, {
    bytes: Buffer.isBuffer(download.bytes) ? download.bytes.byteLength : download.bytes,
    tooLarge: !!download.tooLarge,
    error: download.error,
  });
  if (!Buffer.isBuffer(download.bytes)) {
    meta.transcribeSkipped = download.tooLarge ? `video ${download.bytes} bayt (sınır ${MAX_VIDEO_BYTES})` : download.error;
    return { transcript: "", method: "none", timings, meta };
  }
  meta.videoBytes = download.bytes.byteLength;

  const spent = (timings.tiktokPage || 0) + (timings.tiktokSubtitle || 0) + (timings.tiktokDownload || 0);
  const transcribeBudget = Math.max(15_000, (budgetMs || 120_000) - spent);
  t = Date.now();
  let result;
  try {
    result = await transcribeMedia({
      bytes: download.bytes,
      contentType: download.contentType,
      filename: "tiktok.mp4",
      timeoutMs: transcribeBudget,
    });
  } catch (e) {
    note("transcribe", Date.now() - t, { model: TRANSCRIBE_MODEL, error: e.message });
    meta.transcribeError = e.message;
    return { transcript: "", method: "none", timings, meta };
  }
  const text = (result.text || "").replace(/\s+/g, " ").trim();
  note("transcribe", Date.now() - t, {
    model: result.model,
    videoSeconds: page.durationSeconds,
    videoBytes: download.bytes.byteLength,
    chars: text.length,
    usage: result.usage,
  });
  meta.transcribeModel = result.model;
  meta.transcribeUsage = result.usage;

  if (text.length < MIN_TRANSCRIPT_CHARS) {
    meta.transcriptChars = text.length;
    return { transcript: "", method: "none", timings, meta };
  }
  return { transcript: text, method: "audio", timings, meta };
}
