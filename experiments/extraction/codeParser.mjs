// Kural tabanlı (AI'sız) tarif ayrıştırıcı + deterministik kabul kapısı — DENEME (v2).
// Çıktı yalnızca kaynakta GEÇEN metindir: malzeme adı/miktarı ve yapılış cümleleri birebir
// kopyalanır, hiçbir şey çevrilmez/tamamlanmaz. Kapı reddederse tarif modele gider.
//
// Ölçülen gerçek: TikTok sayfasındaki açıklama (itemStruct.desc) satır sonlarını KAYNAKTA
// siliyor (33/33 açıklamada \n yok); satır izleri yalnızca çift boşluk olarak kalıyor (25/33).
// Bu yüzden malzeme sınırları madde işaretinden, çift boşluktan, "miktar + birim"
// başlangıcından ya da (tahmin) büyük harfle başlayan kelimeden çıkarılıyor.

const UNITS_TR = [
  "türk kahve fincanı", "kahve fincanı", "su bardağından", "su bardağı", "çay bardağından", "çay bardağı", "yemek kaşığı",
  "çorba kaşığı", "tatlı kaşığın", "tatlı kaşığı", "çay kaşığından", "çay kaşığı", "kahve kaşığı", "orta boy", "büyük boy",
  "küçük boy", "fincan", "bardak", "kaşık", "kase", "gram", "gr", "g", "kilo", "kg", "litre", "lt", "ml", "cl", "l", "adet",
  "tane", "diş", "dal", "demet", "tutam", "paket", "poşet", "dilim", "kutu", "avuç", "parmak", "buçuk",
];
const UNITS_EN = [
  "tablespoons", "tablespoon", "teaspoons", "teaspoon", "tbsps", "tbsp", "tsp", "cups", "cup", "grams", "gram", "g", "kg",
  "ml", "l", "oz", "ounces", "lb", "lbs", "pounds", "pinch", "cloves", "clove", "large", "medium", "small", "slices", "cans", "can",
];
const ALL_UNITS = [...new Set([...UNITS_TR, ...UNITS_EN])].sort((a, b) => b.length - a.length);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const UNIT_RE = `(?:${ALL_UNITS.map(esc).join("|")})(?![\\p{L}])`;
const NUM = `(?:\\d+\\/\\d+|\\d+(?:[.,]\\d+)?(?:\\s*[½¼¾⅓⅔⅛])?|[½¼¾⅓⅔⅛])`;
const WORD_NUM = `(?:yarım|bir|iki|üç|dört|beş|altı|çeyrek|a pinch of|pinch of|pinch|one|two|three|half)`;
const RANGE = `(?:\\s*(?:-|–|veya|ya da|or|to)\\s*${NUM})`;
const APPROX = `(?:yaklaşık|about|approx\\.?|around|en az|~)\\s*`;
const QTY = `(?:${APPROX})?(?:${NUM}${RANGE}?|${WORD_NUM}(?=\\s*${UNIT_RE}))`;
const UNIT_TAIL = `(?:\\s*${UNIT_RE})?(?:\\s+${UNIT_RE})?(?:\\s*(?:dolusu|kadar|of))?`;
// "3 cups or 400g", "1 su bardağından 1 parmak az", "yarım su bardağından biraz fazla"
const ALT = `(?:\\s+(?:or|veya|ya da)\\s+${NUM}\\s*${UNIT_RE})?(?:\\s+${NUM}\\s+parmak\\s+az|\\s+biraz\\s+fazla)?`;
const LEADING_AMOUNT = new RegExp(`^(${QTY}${UNIT_TAIL}${ALT})(?=\\s|$|[,(])`, "iu");
const TRAILING_AMOUNT = new RegExp(`(${NUM}\\s*(?:g|gr|ml|kg)(?![\\p{L}])(?:\\s*\\([^)]*\\))?)\\s*$`, "iu");
const QTY_UNIT_ANYWHERE = new RegExp(`${NUM}\\s*${UNIT_RE}`, "giu");
const INVERTED_PAIR = new RegExp(`${NUM}\\s*(?:g|gr|ml)\\s*\\([^)]*\\)`, "giu");

// Başlıklar yalnızca büyük harfle ya da ardından ":" / ";" geliyorsa sayılır ("Tüm malzemeler bir
// tencereye…" cümlesi başlık değildir).
const ING_HEADER = /(?:^|[\s¦¶])((?:Gerekli malzemeler|Malzemeler|MALZEMELER|Malzeme listesi|Hadi malzemelere…?|Ingredients|INGREDIENTS)(?=[\s:;¦]|$)|(?:gerekli malzemeler|malzemeler|ingredients)\s*(?=[:;])|(?<=\p{L} )(?:tarifi|TARİFİ|recipe)\s*[:;])\s*[:;…]*/gu;
const METHOD_HEADER = /(?:^|[\s¦¶])((?:Tarifin yapılışı|Yapılışı|YAPILIŞI|Yapılış|Hazırlanışı|Hazırlanısı|Hazırlanış|Hadi yapalım|Instructions|INSTRUCTIONS|Directions|Method)(?=[\s:;¦]|$)|(?:yapılışı|hazırlanışı|instructions|directions)\s*(?=[:;])|[\p{Lu}][\p{L}]+ın Yapılışı)\s*[:;]*/gu;
const TIPS_HEADER = /(?:^|[\s¦¶])(Püf noktalar[ıi]?|PÜF NOKTALAR[Iİ]?|Notlar\s*:|Not\s*:|Pro Tip\s*:|💡|To Serve)/gu;
const BULLET_SRC = `(?:[•●▪◾◽▫🔸🔹✅✔⭐]|(?<=\\s|^)[*](?=\\s|\\p{L}|\\d)|(?<=\\s|^)-{1,2}(?=\\s))`;
const TR_CHARS = /[ğışçöüĞİŞÇÖÜ]/g;
const TR_WORDS = /(?<![\p{L}])(ve|bir|için|ile|su|bardağı|kaşığı|tuz|şeker|un|yapılışı|malzemeler)(?![\p{L}])/giu;
const EN_WORDS = /(?<![\p{L}])(and|the|of|with|cup|cups|tbsp|tsp|salt|sugar|flour|ingredients|instructions)(?![\p{L}])/giu;
// Tarif adımı olmayan cümleler: tanıtım / çağrı / kaynak belirtme
const NON_STEP = /(takip et|beğen(meyi|ip)|kaydet(meyi|in)|abone ol|yorum(lara|ları)|afiyet olsun|deneyecek|deneyenlere|kitabında yer alan|tarif(i)? denenmiştir|video sahibi|follow (me|for)|like and|save (this|for))/iu;
const VERB_HINT = /(iyoruz|ıyoruz|uyoruz|üyoruz|alım|elim|ılır|ilir|ulur|ülür|yın|yin|yun|yün|edin|ekleyin|karıştırın|pişirin|doğrayın|alın|koyun|bekletin|^(mix|add|stir|bake|cook|heat|soak|knead|combine|place|in a))(?![\p{L}])/iu;

export function detectLang(text) {
  const tr = (text.match(TR_CHARS)?.length || 0) + 2 * (text.match(TR_WORDS)?.length || 0);
  const en = 2 * (text.match(EN_WORDS)?.length || 0);
  if (tr === 0 && en === 0) return "unknown";
  return tr >= en ? "tr" : "en";
}

function clean(caption) {
  return caption
    .replace(/#[^\s#]*/gu, " ")
    .replace(/(?<![\p{L}\d])@[\w.]+/gu, " ")
    .replace(/[─━_]{2,}|⸻/g, " ¶ ")
    .replace(/\t/g, "  ")
    .replace(/ {2,}/g, " ¦ ")
    .replace(/[\u{1F300}-\u{1F5FF}\u{1F600}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{2704}\u{2706}-\u{27BF}\u{FE0F}\u{200D}\u{1F1E6}-\u{1F1FF}❗]/gu, " ")
    .replace(/[ ]+/g, " ")
    .trim();
}

const wordCount = (s) => s.split(/\s+/).filter(Boolean).length;
const stripDecor = (s) => s.replace(/[¦¶]/g, " ").replace(/^[\s,;:.\-–*•]+|[\s,;:.\-–*•]+$/g, "").replace(/\s+/g, " ").trim();
const noParens = (s) => s.replace(/\([^)]*\)?/g, " ");
const isLowerEnd = (s) => /[\p{Ll}]\s*$/u.test(s);
const isTitleCase = (s) => {
  const words = s.split(/\s+/).filter((w) => /^\p{L}/u.test(w));
  return words.length >= 4 && words.filter((w) => /^\p{Lu}/u.test(w)).length / words.length > 0.5;
};

// Parantez derinliğine bakarak, verilen ayırıcıda böler (parantez içi bölünmez).
function splitOutsideParens(text, sepRe) {
  const out = [];
  let depth = 0;
  let cur = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth === 0) {
      sepRe.lastIndex = i;
      const m = sepRe.exec(text);
      if (m && m.index === i && m[0].length) {
        out.push(cur);
        cur = "";
        i += m[0].length;
        continue;
      }
    }
    cur += ch;
    i++;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

// Bir parçayı "miktar başlangıcı"ndan ve (isteğe bağlı) büyük harfli kelimeden böler.
function splitPieces(chunk, { capitalSplit }) {
  const pieces = [];
  const depthAt = [];
  let depth = 0;
  for (let i = 0; i < chunk.length; i++) {
    if (chunk[i] === "(") depth++;
    if (chunk[i] === ")") depth = Math.max(0, depth - 1);
    depthAt[i] = depth;
  }
  const cuts = new Set();
  const qtyRe = new RegExp(`(?<=\\s)(${QTY})(?=\\s*(?:${UNIT_RE}|\\p{L}))`, "giu");
  for (const m of chunk.matchAll(qtyRe)) {
    const i = m.index;
    if (depthAt[i] > 0) continue;
    const before = chunk.slice(0, i).trim();
    if (!before) continue;
    if (/(veya|ya da|or|ile|to|-|–|\/|ndan|ından|inden|dan|den|tan|ten|yaklaşık|about|en az|warmed|around)$/iu.test(before)) continue;
    cuts.add(i);
  }
  if (capitalSplit) {
    for (const m of chunk.matchAll(/(?<=[\p{Ll}\d)] )(\p{Lu}[\p{Ll}]+)/gu)) {
      const i = m.index;
      if (depthAt[i] > 0) continue;
      if (/[.!?:]\s*$/.test(chunk.slice(0, i))) continue;
      cuts.add(i);
    }
  }
  const sorted = [...cuts].sort((a, b) => a - b);
  let start = 0;
  const guessed = [];
  for (const i of sorted) {
    const before = chunk.slice(start, i).trim();
    // yalnızca miktar/birim olan bir parçadan sonra bölme ("1 Türk kahve fincanı")
    const lead = before.match(LEADING_AMOUNT);
    if (!before || (lead && !stripDecor(before.slice(lead[0].length)))) continue;
    pieces.push(before);
    guessed.push(!new RegExp(`^${QTY}`, "iu").test(chunk.slice(i)));
    start = i;
  }
  pieces.push(chunk.slice(start).trim());
  return { pieces: pieces.filter(Boolean), capitalCuts: guessed.filter(Boolean).length };
}

function parseIngredient(raw, section) {
  const text = stripDecor(raw);
  if (!text) return null;
  const lead = text.match(LEADING_AMOUNT);
  if (lead && stripDecor(text.slice(lead[0].length))) {
    return { name: stripDecor(text.slice(lead[0].length)), amount: lead[1].trim(), section, quantified: true, raw: text };
  }
  const trail = text.match(TRAILING_AMOUNT);
  if (trail && stripDecor(text.slice(0, trail.index))) {
    return { name: stripDecor(text.slice(0, trail.index)), amount: trail[1].trim(), section, quantified: true, raw: text };
  }
  return { name: text, amount: "", section, quantified: false, raw: text };
}

function splitSteps(text) {
  const t = text.trim();
  let steps;
  if (/(?:^|\s)\d+[.)]\s/.test(t)) steps = t.split(/(?:^|\s)\d+[.)]\s+/u);
  else if (new RegExp(BULLET_SRC, "u").test(t)) steps = t.split(new RegExp(`\\s*${BULLET_SRC}\\s*`, "gu"));
  else steps = t.split(/(?<=[.!])\s*(?=\p{Lu})|(?<=[.!])\s+|¦|¶/u);
  return steps
    .flatMap((s) => s.split(/¦|¶/))
    .map((s) => s.split(/(?<=[.!])\s+/u).filter((x) => !NON_STEP.test(x)).join(" "))
    .map(stripDecor)
    .filter((s) => s && /\p{L}/u.test(s));
}

// Başlıklara göre bölümler: [{mode: "pre"|"ing"|"method"|"tips", text}]
function sections(text) {
  const marks = [];
  for (const [re, mode] of [[ING_HEADER, "ing"], [METHOD_HEADER, "method"], [TIPS_HEADER, "tips"]]) {
    for (const m of text.matchAll(re)) {
      const at = m.index + m[0].indexOf(m[1]);
      marks.push({ at, end: m.index + m[0].length, mode });
    }
  }
  marks.sort((a, b) => a.at - b.at);
  const out = [];
  let pos = 0;
  let mode = "pre";
  for (const mk of marks) {
    if (mk.at < pos) continue;
    out.push({ mode, text: text.slice(pos, mk.at) });
    mode = mk.mode;
    pos = mk.end;
  }
  out.push({ mode, text: text.slice(pos) });
  return out.filter((s) => s.text.trim() || s.mode !== "pre");
}

const SUBHEAD = /(?:^|\s)((?:\p{Lu}[\p{L}']*\s){0,3}\p{L}[\p{L}']*|[\p{Ll}]+)\s+(?:için|İçin|için)\s*[:;]?\s*(?:\([^)]*\))?\s*|(?:^|\s)((?:Optional|For the)[^:]{0,25}):\s*/gu;

function parseIngSegment(segText, { headed, signals }) {
  const bulletCount = (segText.match(new RegExp(BULLET_SRC, "gu")) || []).length;
  const bulleted = bulletCount >= 3;
  if (bulleted) signals.bullets = true;
  // Madde işaretli listede çift boşluk madde içinde de olabilir; sınır yalnızca madde işareti.
  const sep = bulleted ? new RegExp(`\\s*${BULLET_SRC}\\s*|¶`, "gyu") : new RegExp(`\\s*${BULLET_SRC}\\s*|¦|¶`, "gyu");
  let coarse = splitOutsideParens(segText, sep);
  // İngilizce ters biçim: "Whole milk 240g (1 cup) Salted butter 42g (3 tbsp)…" → her "(…)" sonrası sınır
  const inverted = (segText.match(INVERTED_PAIR) || []).length >= 3;
  if (inverted) coarse = coarse.flatMap((c) => c.split(new RegExp(`(?<=${NUM}\\s*(?:g|gr|ml)\\s*\\([^)]*\\))\\s*`, "gu")));
  const capitalSplit = !bulleted && !inverted && !isTitleCase(segText);

  const ingredients = [];
  const method = [];
  let section = "";
  let pre = [];
  for (const [ci, chunk] of coarse.entries()) {
    const capHere = capitalSplit || (bulleted && ci === coarse.length - 1);
    // alt başlıklar ("Kek için;", "Sosu için", "Üzeri İçin:", "Optional fillings:") → bölüm adı
    const parts = [];
    let last = 0;
    for (const m of chunk.matchAll(SUBHEAD)) {
      const label = (m[1] || m[2] || "").trim();
      if (!label || new RegExp(`^${QTY}$`, "iu").test(label)) continue;
      parts.push({ text: chunk.slice(last, m.index), section });
      section = label;
      last = m.index + m[0].length;
    }
    parts.push({ text: chunk.slice(last), section });
    for (const part of parts) {
      if (method.length) {
        method.push(part.text);
        continue;
      }
      const { pieces, capitalCuts } = inverted ? { pieces: [part.text], capitalCuts: 0 } : splitPieces(part.text, { capitalSplit: capHere });
      signals.capitalCuts += capitalCuts;
      for (const p of pieces) {
        const s = stripDecor(p);
        if (!s) continue;
        if (method.length) {
          method.push(s);
          continue;
        }
        const ing = parseIngredient(s, part.section);
        const parenNote = /^\(.*\)$/su.test(s) && wordCount(s) > 5;
        const longSentence = parenNote || (!ing.quantified && wordCount(noParens(s)) > 5 && (VERB_HINT.test(s) || /[.!]/.test(s)));
        if (longSentence && ingredients.length >= 2) {
          signals.implicitMethod = true;
          method.push(s);
          continue;
        }
        if (!headed && !ingredients.some((x) => x.quantified) && !ing.quantified) {
          pre.push(s); // başlıksız listede ilk miktarlı malzemeden önceki metin = başlık/tanıtım
          continue;
        }
        if (/^(?:tarif[iı]?|malzemeler|ingredients)$/iu.test(s)) continue;
        ingredients.push(ing);
      }
    }
  }
  return { ingredients, method: method.join(" ¦ "), pre: pre.join(" ") };
}

export function parseCaption(caption) {
  const text = clean(caption);
  const signals = { ingHeader: false, methodHeader: false, implicitMethod: false, bullets: false, tipsHeader: false, capitalCuts: 0 };
  const segs = sections(text);
  signals.ingHeader = segs.some((s) => s.mode === "ing");
  signals.methodHeader = segs.some((s) => s.mode === "method");
  signals.tipsHeader = segs.some((s) => s.mode === "tips");

  const ingredients = [];
  const methodTexts = [];
  const tips = [];
  let preamble = "";
  for (const [k, s] of segs.entries()) {
    if (s.mode === "ing" || (s.mode === "pre" && !signals.ingHeader && k === 0)) {
      const r = parseIngSegment(s.text, { headed: s.mode === "ing", signals });
      ingredients.push(...r.ingredients);
      if (r.method) methodTexts.push(r.method);
      if (r.pre) preamble += ` ${r.pre}`;
    } else if (s.mode === "method") methodTexts.push(s.text);
    else if (s.mode === "tips") tips.push(s.text);
    else preamble += ` ${s.text}`;
  }
  const instructions = methodTexts.flatMap(splitSteps);
  const title = stripDecor(stripDecor(preamble).split(/[.!?¦¶]/)[0].replace(/\b(için\s+tarif|tarifi|tarif|recipe)\b\s*[:;]?/giu, " "));
  return {
    title: title && title.length <= 60 && wordCount(title) <= 8 ? title : null,
    ingredients,
    instructions,
    lang: detectLang(text),
    signals,
    leftovers: { preamble: preamble.trim(), tips: tips.join(" ") },
  };
}

// Deterministik kabul kapısı. Model güven puanı yok; yalnızca kaynağa karşı ölçülebilir kontroller.
// strict: başlıksız yapılış ve büyük harfle tahmin edilen sınır kabul edilmez.
export function gate(parsed, { appLang = "tr", mode = "strict" } = {}) {
  const reasons = [];
  const ings = parsed.ingredients;
  if (parsed.lang !== appLang) reasons.push(`dil ${parsed.lang} ≠ uygulama ${appLang} (çeviri gerekir)`);
  if (!parsed.signals.ingHeader && !parsed.signals.bullets) reasons.push("malzeme başlığı/madde işareti yok");
  if (ings.length < 3) reasons.push(`malzeme sayısı ${ings.length} < 3`);
  const unq = ings.filter((i) => !i.quantified);
  if (ings.length && unq.length / ings.length > 0.4) reasons.push(`miktarsız malzeme oranı ${unq.length}/${ings.length}`);
  for (const i of unq) if (wordCount(noParens(i.name)) > 4) reasons.push(`miktarsız uzun parça: "${i.name.slice(0, 40)}"`);
  for (const i of ings) {
    if (noParens(i.raw).length > 60) reasons.push(`uzun malzeme (birleşmiş olabilir): "${i.raw.slice(0, 40)}…"`);
    const inner = noParens(i.name).replace(/,?\s*(?:or|veya|ya da)\s+.*$/iu, "").match(QTY_UNIT_ANYWHERE) || [];
    if (inner.length) reasons.push(`adın içinde ikinci miktar: "${i.raw.slice(0, 40)}"`);
  }
  if (mode === "strict" && parsed.signals.implicitMethod) reasons.push("yapılış başlıksız (sınırı tahmin)");
  if (mode === "strict" && parsed.signals.capitalCuts > 0) reasons.push(`büyük harften tahmin edilen ${parsed.signals.capitalCuts} sınır`);
  // Yapılışta, listedeki hiçbir miktarla eşleşmeyen ölçülü malzeme → listede eksik malzeme olabilir
  const norm = (s) => s.toLocaleLowerCase("tr").replace(/,/g, ".").replace(/\s+/g, " ").trim();
  const amounts = new Set(ings.map((i) => norm(i.amount)).filter(Boolean));
  const names = ings.map((i) => norm(i.name));
  const mq = parsed.instructions.join(" ").matchAll(new RegExp(`(${NUM}\\s*(?:paket|su bardağı|yemek kaşığı|tatlı kaşığı|gr|g|ml|cup|cups|tbsp))(?![\\p{L}])\\s+([\\p{L}]+)`, "giu"));
  for (const m of mq) {
    const word = norm(m[2]).slice(0, 3);
    if (!amounts.has(norm(m[1])) && !names.some((n) => n.includes(word))) reasons.push(`yapılışta listede olmayan ölçülü malzeme: "${m[0]}"`);
  }
  // Yapılışta "X eklenir / ekleyin / ilave / add X" ile eklenen ama listede olmayan malzeme (ör. "çikolatalar eklenir")
  const GENERIC = /^(malzeme|karışı|hamur|harç|sos|kek|krema|tüm|kalan|diğer|bütün|üzer|iç|kuru|sıvı|hepsi|ingredi|mixture|dough|batter|rest|remain|all|the|them|it|half|sauce|toppings|filling|kaynay|pişen|doğra|soğuy|çok|biraz|ve|ile|edip|ekleyip|sonra|tekrar|yavaş|azar|ayrıca|then|also|any|more|extra|remaining|in|to|de|da|su$|suyu)/iu;
  const stems = names.flatMap((n) => n.split(/[\s,/()]+/).filter((w) => w.length >= 3).map((w) => w.slice(0, 4)));
  const text = parsed.instructions.join(" ").toLocaleLowerCase("tr");
  const addedTr = [...text.matchAll(/([\p{L}]+)\s+(?:eklenir|ekleyin|ekleyip|ilave|katıp|katın|ekliyoruz|ekleyelim)(?![\p{L}])/gu)].map((m) => m[1]);
  const addedEn = [...text.matchAll(/(?:add|stir in|fold in|top with)\s+(?:the\s+|in\s+|some\s+)?([\p{L}]+)/gu)].map((m) => m[1]);
  for (const w of [...addedTr, ...addedEn]) {
    if (w.length < 3 || GENERIC.test(w)) continue;
    if (!stems.some((st) => w.startsWith(st) || st.startsWith(w.slice(0, 4)))) reasons.push(`yapılışta eklenen, listede olmayan: "${w}"`);
  }
  return { accept: reasons.length === 0, reasons };
}
