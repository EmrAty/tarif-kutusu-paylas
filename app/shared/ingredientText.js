// Malzeme miktar METNİNİN temizliği (istemci + sunucu ortak, deterministik).
//
// Model eskiden "Miktarlar net değilse makul tahmin yap" talimatıyla "belirtilmemiş, tahminen 45 g",
// "belirtilmemiş, birkaç diş", "Derin kızartma için (miktar belirtilmemiş)" gibi kendi içinde çelişen
// metinler yazıyordu. Yeni şemada tahmin ayrı bir bayraktır (`estimated: true`, miktar yalnızca
// "45 g"); uygulama bunu "Yaklaşık 45 g" diye gösterir. Bu dosya:
//   * yeni çıkarılan tarifte (sunucu, kayıttan önce) modelin yine de yazdığı bu kalıpları,
//   * eski kayıtlı tariflerde (istemci, YALNIZCA gösterimde; kayıt değişmez)
// aynı kuralla temizler. Sayı UYDURMAZ: metinde olmayan bir sayı hiçbir zaman eklenmez.

const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));

// "Miktar yok" anlamındaki ifadeler (Türkçe + İngilizce; eski kayıtlar ve İngilizce içerik).
const UNSPECIFIED = String.raw`(?:miktar(?:ı)?\s+)?belirtilme(?:miş|di)|miktar\s+yok|not\s+specified|unspecified|amount\s+not\s+(?:specified|given)`;
// Tahmin önekleri.
const ESTIMATE = String.raw`tahminen|tahmini|yaklaşık|yak\.|approx(?:imately|\.)?|about|around|ca\.|~|≈`;
const NUM_START = String.raw`(?:\d|[½¼¾⅓⅔⅛]|yarım(?![\p{L}]))`;

const ONLY_UNSPECIFIED_RE = new RegExp(String.raw`^\(?\s*(?:${UNSPECIFIED})\s*\)?[.]?$`, "iu");
const PAREN_UNSPECIFIED_RE = new RegExp(String.raw`\s*\(\s*(?:${UNSPECIFIED})\s*\)`, "giu");
const LEADING_UNSPECIFIED_RE = new RegExp(String.raw`^(?:${UNSPECIFIED})\s*(?:[,;:–—-]\s*)?`, "iu");
const ANY_UNSPECIFIED_RE = new RegExp(String.raw`(?:${UNSPECIFIED})`, "iu");
const ALL_UNSPECIFIED_RE = new RegExp(String.raw`(?:${UNSPECIFIED})`, "giu");
const LEADING_ESTIMATE_RE = new RegExp(String.raw`^(?:${ESTIMATE})\s*(?=${NUM_START})`, "iu");

const tidy = (s) =>
  s
    .replace(/\s+/g, " ")
    .replace(/\(\s*\)/g, "")
    .replace(/^[\s,;:–—-]+|[\s,;:–—-]+$/g, "")
    .trim();

// Tek bir miktar metni → { amount, estimated }.
//   "belirtilmemiş"                         → { amount: "",          estimated: false }
//   "belirtilmemiş, tahminen 45 g"          → { amount: "45 g",      estimated: true }
//   "tahminen 2 yemek kaşığı"               → { amount: "2 yemek kaşığı", estimated: true }
//   "belirtilmemiş, birkaç diş"             → { amount: "birkaç diş", estimated: false }
//   "Derin kızartma için (miktar belirtilmemiş)" → { amount: "Derin kızartma için", estimated: false }
//   "2 lb (yaklaşık 907 g)"                 → değişmez (kaynakta verilmiş miktar + dönüşüm notu)
// `estimated` girdisi (yeni şemadaki bayrak) korunur.
export function cleanAmount(amount, estimated = false) {
  const raw = str(amount).trim();
  let est = estimated === true;
  if (!raw) return { amount: "", estimated: false };
  if (ONLY_UNSPECIFIED_RE.test(raw)) return { amount: "", estimated: false };
  let text = raw.replace(PAREN_UNSPECIFIED_RE, "");
  text = tidy(text.replace(LEADING_UNSPECIFIED_RE, ""));
  // Ortada kalmış "belirtilmemiş" ("belirtilmemiş (soğan için) ve 2 çay kaşığı (sos için)").
  if (ANY_UNSPECIFIED_RE.test(text)) text = tidy(text.replace(ALL_UNSPECIFIED_RE, ""));
  // Baştaki tek parantezi aç: "(soğan için) ve 2 çay kaşığı" → "soğan için ve 2 çay kaşığı".
  text = tidy(text.replace(/^\(([^()]*)\)/, "$1"));
  text = tidy(text.replace(/^(?:ve|and)\s+/iu, ""));
  if (LEADING_ESTIMATE_RE.test(text)) {
    text = tidy(text.replace(LEADING_ESTIMATE_RE, ""));
    est = true;
  }
  if (!text) return { amount: "", estimated: false };
  return { amount: text, estimated: est && /[\d½¼¾⅓⅔⅛]|yarım/iu.test(text) };
}

// Yeni çıkarılan tarifin malzemeleri (sunucu, kayıttan önce). Şema alanları:
// { name, amount, group, estimated }. Kayda yalnızca dolu `group` ve `estimated: true` yazılır
// (eski kayıtlarla aynı biçim kalsın, boş alan birikmesin).
export function normalizeExtractedIngredients(ingredients) {
  if (!Array.isArray(ingredients)) return [];
  const out = [];
  for (const ing of ingredients) {
    if (!ing || typeof ing !== "object") continue;
    const name = str(ing.name).trim();
    if (!name) continue;
    const { amount, estimated } = cleanAmount(ing.amount, ing.estimated === true);
    const group = str(ing.group).replace(/\s+/g, " ").trim().replace(/[:：]$/, "").trim();
    out.push({ name, amount, ...(group ? { group } : {}), ...(estimated ? { estimated: true } : {}) });
  }
  return out;
}
