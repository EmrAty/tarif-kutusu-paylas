// Ucuz modelin (ör. Haiku) tarif çıktısını KAYNAK METNE karşı denetleyen deterministik doğrulayıcı.
// Modelin kendi güven puanı kullanılmaz. Başarısızsa tarif güçlü modele (bugünkü Sonnet) gider.
//
// Kontroller (hepsi kaynak açıklamaya karşı):
//  V1 miktar dayanağı: her malzeme miktarındaki sayılar kaynakta geçiyor mu ("yarım"=1/2, "bir"=1)
//  V2 ad dayanağı: her malzeme adının en az bir anlamlı kelimesi (4 harflik kök) kaynakta geçiyor mu
//     — geçmiyorsa ve "assumptions" tamamlandığını söylemiyorsa uydurma; söylüyorsa "karmaşık" → güçlü model
//  V3 kayıp ölçü: kaynaktaki her "sayı + birim (+ ad)" ifadesi çıktıda aynı sayı ve ad köküyle var mı
//     (malzemede, adımda, varsayımda ya da porsiyonda)
//  V4 yapılış: kaynakta yapılış varken instructions boş mu; adımlar kaynakla örtüşüyor mu (aynı dilde)
//  V5 kaynakta sayıyla yazılan malzeme çıktıda miktarsız kalmış mı
// Dil farklıysa (çeviri) V2/V4 metin ve V3 ad kontrolleri atlanır, yalnız sayısal kontroller çalışır.
import { detectLang } from "./codeParser.mjs";

const lower = (s) => String(s ?? "").toLocaleLowerCase("tr");
const WORDNUM = { yarım: "1/2", yarim: "1/2", bir: "1", iki: "2", üç: "3", dört: "4", beş: "5", altı: "6", çeyrek: "1/4", half: "1/2", one: "1", two: "2", three: "3" };
const FRAC = { "½": "1/2", "¼": "1/4", "¾": "3/4", "⅓": "1/3", "⅔": "2/3", "⅛": "1/8" };

export function numbersIn(text) {
  let t = lower(text);
  for (const [k, v] of Object.entries(FRAC)) t = t.split(k).join(` ${v} `);
  t = t.replace(/(?<![\p{L}])(yarım|yarim|bir|iki|üç|dört|beş|altı|çeyrek|half|one|two|three)(?![\p{L}])/gu, (m) => ` ${WORDNUM[m]} `);
  return (t.match(/\d+\/\d+|\d+(?:[.,]\d+)?/g) || []).map((n) => n.replace(",", "."));
}
const STOP = new Set(["için", "veya", "ile", "olarak", "kadar", "bir", "the", "and", "for", "with", "fresh", "taze", "ince", "doğranmış", "kıyılmış", "rendelenmiş", "oda", "sıcaklığında", "isteğe", "bağlı", "optional", "chopped", "minced", "dolusu", "silme", "tepeleme", "kullandım", "large", "small", "medium"]);
const tokens = (s) => lower(s).split(/[^\p{L}]+/u).filter((w) => w.length >= 3 && !STOP.has(w));
const UNIT_WORDS = "su bardağı|çay bardağı|yemek kaşığı|tatlı kaşığı|çay kaşığı|kahve fincanı|fincan|bardak|gr|g|gram|kg|ml|litre|lt|adet|tane|diş|paket|tutam|dal|demet|cups?|tbsps?|tsp|grams?|oz";
const QTY_UNIT = new RegExp(`(\\d+\\/\\d+|\\d+(?:[.,]\\d+)?|[½¼¾])\\s*(?:${UNIT_WORDS})(?![\\p{L}])(?:\\s+([\\p{L}]{3,}))?`, "giu");
const VERBS = /(ekleyin|karıştır|pişir|ekleyip|çırp|ekliyoruz|ekleyelim|kavur|doğra|yoğur|haşla|kaynat|dinlendir|\badd\b|\bmix\b|\bbake\b|\bstir\b|\bcook\b|\bknead\b)/gu;

export function verify(source, recipe, { appLang = "tr" } = {}) {
  const srcNums = new Set(numbersIn(source));
  const srcStems = new Set(tokens(source).map((w) => w.slice(0, 4)));
  const sameLang = detectLang(source) === appLang;
  const failures = [];
  const complex = [];
  const ings = Array.isArray(recipe.ingredients) ? recipe.ingredients : [];
  const steps = Array.isArray(recipe.instructions) ? recipe.instructions : [];
  const assumptions = lower(recipe.assumptions);
  const declaresCompletion = /tamamland|tahmin|varsay|eklendi|assum|estimat|typical|tipik/u.test(assumptions);

  if (!ings.length) failures.push("malzeme yok");
  for (const ing of ings) {
    for (const n of numbersIn(ing.amount)) if (!srcNums.has(n)) failures.push(`V1 kaynakta olmayan sayı "${n}" (${ing.amount} ${ing.name})`);
    if (sameLang) {
      const ts = tokens(ing.name);
      if (ts.length && !ts.some((w) => srcStems.has(w.slice(0, 4)))) {
        (declaresCompletion ? complex : failures).push(`V2 kaynakta geçmeyen malzeme "${ing.name}"`);
      }
    }
  }

  const extraText = lower([...steps, recipe.assumptions || "", recipe.servings ?? ""].join(" | "));
  const extraNums = new Set(numbersIn(extraText));
  for (const m of source.matchAll(QTY_UNIT)) {
    const n = numbersIn(m[1])[0];
    if (!n) continue;
    const word = m[2] ? lower(m[2]) : "";
    const stem = sameLang && word && !STOP.has(word) ? word.slice(0, 4) : null;
    const inIngs = ings.some((i) => numbersIn(`${i.amount} ${i.name}`).includes(n) &&(!stem || lower(`${i.amount} ${i.name}`).includes(stem)));
    const inExtra = extraNums.has(n) && (!stem || extraText.includes(stem));
    if (!inIngs && !inExtra) failures.push(`V3 kaynaktaki ölçü çıktıda yok: "${m[0]}"`);
  }

  const verbHits = new Set(lower(source).match(VERBS) || []);
  const srcHasMethod = /(yapılışı|hazırlanışı|hazırlanısı|instructions|directions)/iu.test(source) || verbHits.size >= 2;
  if (srcHasMethod && !steps.length) failures.push("V4 kaynakta yapılış var, çıktıda yok");
  if (!srcHasMethod && steps.length) complex.push("V4 kaynakta yapılış yokken adım üretilmiş");
  if (sameLang && steps.length) {
    const ungrounded = steps.filter((s) => {
      const ts = tokens(s);
      return ts.length >= 3 && ts.filter((w) => srcStems.has(w.slice(0, 4))).length / ts.length < 0.5;
    });
    if (ungrounded.length) failures.push(`V4 kaynakla örtüşmeyen ${ungrounded.length} adım`);
  }

  for (const ing of ings) {
    if (String(ing.amount || "").trim()) continue;
    const stem = tokens(ing.name)[0]?.slice(0, 4);
    if (!stem) continue;
    if (ings.some((o) => o !== ing && String(o.amount || "").trim() && lower(o.name).includes(stem))) continue;
    const re = new RegExp(`(?:\\d+(?:[.,]\\d+)?|[½¼¾])\\s*(?:(?:${UNIT_WORDS})\\s+)?${stem}`, "iu");
    if (re.test(lower(source))) failures.push(`V5 kaynakta miktarı olan malzeme miktarsız: "${ing.name}"`);
  }
  return { pass: failures.length === 0 && complex.length === 0, failures, complex };
}
