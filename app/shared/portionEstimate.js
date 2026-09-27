// Porsiyon hesabı: AI'ın kaynaktan çıkardığı yapılandırılmış bilgiyi ("portion")
// sürümlü, kaynaklı tablolarla deterministik olarak porsiyon sayısına çevirir.
// Hem istemci ("Yeni Tarif Çıkar" -> /api/extract) hem sunucu (paylaşım paneli ->
// /api/recipe-jobs) bu dosyayı kullanır. Kaynaklar ve gerekçeler: docs/porsiyon-hesabi.md
//
// Aynı normalize girdi + aynı kural sürümü => her zaman aynı sonuç. Tüm adımlar
// çarpımsal olduğu için malzemeler k katına çıkınca yuvarlanmamış porsiyon da k
// katına çıkar; tam sayıya yuvarlama yalnızca en son adımda yapılır.

export const PORTION_RULES_VERSION = "2026-09-27.1";

// --- Ölçüler -------------------------------------------------------------------
// Ev ölçüsü hacimleri (mL). Türkiye'de standart değildir (TÜBER 2022: su bardakları
// 200-560 mL, yemek kaşıkları 10-15 mL); tarif sitelerinin yaygın kabulü seçildi.
const UNIT_ML = {
  ml: 1,
  l: 1000,
  su_bardagi: 200, // yaygın tarif kabulü (ikincil kaynak); TÜBER'e göre gerçek bardaklar 200-560 mL
  cay_bardagi: 100, // yaygın tarif kabulü (ikincil kaynak); TÜBER: 85-165 mL
  yemek_kasigi: 15, // FAO/INFOODS dönüşüm kılavuzu (USDA 2009): 1 tbsp = 15 mL
  tatli_kasigi: 10, // yaygın tarif kabulü (ikincil kaynak)
  cay_kasigi: 5, // FAO/INFOODS dönüşüm kılavuzu: 1 tsp = 5 mL
};
const UNIT_G = { g: 1, kg: 1000 };

// Yoğunluk (g/mL) — FAO/INFOODS Density Database v2.0 (2012).
const DENSITY = {
  su: 1.0, // "Water" 1
  et_suyu: 1.0, // su kabul edildi
  sut: 1.03, // "Milk, liquid, whole" 1.03 (TB), 1.031 (DK)
  yogurt: 1.03, // "Yoghurt, plain, unsweetened" 1.031 (DK)
  krema: 1.0, // "Cream, single" 1.00 (UK 6th)
  sivi_yag: 0.92, // "Oil, vegetable, olive" 0.918 (TB), "Oil, other" 0.92 (DK)
  tereyagi: 0.91, // "Butter" 0.911 (TB)
  un: 0.58, // "Wheat, flour": 0.48-0.67 arası 5 değerin ortancası (0.58, KEN)
  seker: 0.88, // "Sugar, white" 0.88 (FNDDS 4.1)
  pirinc: 0.82, // "Rice, white, raw" 0.82 (RC)
  mercimek: 0.89, // "Lentils, green, small, raw" 0.89 (RC) — kırmızı mercimek için vekil değer
  kuru_baklagil: 0.75, // "Kidney beans, dry, raw" 0.75 (KEN); "Beans, white" 0.69-0.77 (ASI)
  bulgur: 0.77, // "Wheat" 0.77 (TB) — bulgur için vekil değer
  makarna_kuru: 0.39, // "Pasta, short macaroni style, raw" 0.39 (RC)
  irmik: 0.78, // "Semolina, raw" 0.78 (RC)
  sebze: 0.55, // doğranmış çiğ sebze: "Onions, raw, cubed" 0.55 (RC), "Carrot, raw, chopped" 0.54 (KEN)
  patates: 0.59, // "Potato, english, raw" 0.59 (KEN)
  sos_salca: 1.0, // kaynak bulunamadı — su kabul edildi
};

// Adet ağırlıkları (g, yenebilir kısım) — USDA FoodData Central (SR Legacy) porsiyon ağırlıkları.
const PIECE_G = {
  patates: { kucuk: 170, orta: 213, buyuk: 369 }, // FDC 170026
  sogan: { kucuk: 70, orta: 110, buyuk: 150 }, // FDC 170000
  havuc: { kucuk: 50, orta: 61, buyuk: 72 }, // FDC 170393
  domates: { kucuk: 91, orta: 123, buyuk: 182 }, // FDC 170457
  yumurta: { kucuk: 38, orta: 44, buyuk: 50 }, // FDC 171287 (kabuksuz)
};

// --- Pişmiş/yenebilir verim katsayıları (pişmiş yenebilir g / çiğ g) ---------------
// "Bileşen" modunda kullanılır. Kaynaklar docs/porsiyon-hesabi.md'de.
const DRY_HEAT = new Set(["firin", "tava_izgara", "kizartma"]);
function componentFactor(kind, method, state) {
  if (state === "pismis") {
    // Kaynakta zaten pişmiş verilen malzemeye pişme katsayısı ikinci kez uygulanmaz;
    // yalnızca kemik payı düşülür: Bognár tavuk budu yenebilir/kemikli = 0.48/0.64 ≈ 0.75.
    if (kind === "tavuk_kemikli" || kind === "et_kemikli") return 0.75;
    if (kind === "su" || kind === "et_suyu") return 0;
    return 1.0;
  }
  switch (kind) {
    case "tavuk_kemikli":
    case "et_kemikli":
      return 0.49; // TÜBER: %30 kemik + %30 pişme kaybı (0.7x0.7); Bognár tavuk budu 0.48
    case "tavuk_kemiksiz":
    case "et_kemiksiz":
      return 0.7; // TÜBER: ~%30 pişme kaybı; USDA tavuk budu fırın %69
    case "kiyma":
      return DRY_HEAT.has(method) ? 0.81 : 0.7; // Bognár köfte/burger tavada 0.81; TÜBER 115 g çiğ ≈ 80 g pişmiş
    case "balik_butun":
      return 0.55; // TÜBER: 250-300 g ayıklanmamış çiğ ≈ 150 g pişmiş; Bognár bütün morina 0.51-0.57
    case "balik_fileto":
      return 0.8; // Bognár balık fileto kızartma 0.80 (n=10)
    case "pirinc":
      return 2.98; // Bognár uzun taneli pirinç haşlama 2.98 (n=140) — pişirme suyu hariç
    case "bulgur":
      return 3.58; // TÜBER'den türetildi: 25 g bulgur ile 30 g pirinç aynı pişmiş porsiyonu verir (2.98x30/25)
    case "makarna_kuru":
      return 2.1; // Bognár makarna (yumurtasız) haşlama 2.10 (n=4)
    case "kuru_baklagil":
      return 2.5; // Bognár kuru fasulye haşlama/yemek 2.50 (n=10)
    case "mercimek":
      return 2.73; // Bognár mercimek haşlama/yemek 2.73 (n=6)
    case "patates":
      if (method === "kizartma") return 0.54; // Bognár patates kızartması 0.54 (n=13)
      if (DRY_HEAT.has(method)) return 0.77; // Bognár fırın patates 0.77 (n=3)
      return 1.0; // Bognár soyulmuş haşlanmış patates 1.00 (n=272)
    case "sebze":
      if (method === "cig") return 1.0;
      return DRY_HEAT.has(method) ? 0.8 : 0.93; // Bognár: kuru ısıda soğan 0.83, biber/kabak 0.73-0.74; haşlamada havuç 0.94, taze fasulye 0.93
    case "su":
    case "et_suyu":
      return 0; // pişirme sıvısı: Bognár'a göre tarife dahil edilmez; kuru gıdaların katsayısı çektikleri suyu içerir
    default:
      return 1.0; // yağ, süt ürünleri, un, şeker, sos, yumurta, peynir, diğer: ağırlık korunur (yaklaşım)
  }
}

// Kemikli/ayıklanmamış malzemede yenebilir çiğ pay (kütle dengesi modunda).
const EDIBLE_RAW = { tavuk_kemikli: 0.7, et_kemikli: 0.7, balik_butun: 0.55 }; // TÜBER %30 kemik; balık için pişmiş oran vekil

// Kütle dengesi modunda (tüm malzemeler, su dahil) kalan oran.
const MASS_MODE = {
  corba: { keep: 0.9, note: "çorbada %10 buharlaşma varsayıldı (uygulama varsayımı; kaynaklara göre buharlaşma kaba ve süreye bağlı, öngörülemez)" },
  tatli_sutlu: { keep: 0.91, note: "sütlü tatlı katsayısı 0,91 (Bognár sütlaç, n=3)" },
};
// Hamur modunda (fırında pişen hamur/kek) tüm malzemenin kalan oranı.
const DOUGH_MODE = {
  tatli_kek: { keep: 0.92, note: "kek pişme katsayısı 0,92 (Bognár mermer kek)" },
  borek: { keep: 0.9, note: "fırın hamur işi katsayısı 0,90 (Bognár ekmek)" },
  pide_pizza: { keep: 0.9, note: "fırın hamur işi katsayısı 0,90 (Bognár ekmek)" },
};

// Kişi başı referans (pişmiş, yenebilir g). Normal bir öğünde ortalama yetişkin için
// genel tarif verimi referansıdır; kişiye özel beslenme önerisi değildir.
export const SERVING_REFERENCE_G = {
  ana_yemek: 200, // Sabancı Üniv. asgari porsiyon gramajları: tüm ana yemek türlerinde toplam 200 g
  corba: 200, // Sabancı: çorba 200 g (TÜBER: standart ¾ kupa 180 mL, çorba kasesi 240 mL)
  yan_yemek: 170, // Sabancı: pilav/makarna, zeytinyağlılar 170 g (TÜBER: ikinci kap pilav = 2 std ≈ 180-220 g)
  garnitur: 100, // TÜBER: garnitür pilav 1 standart porsiyon = 90-110 g
  salata: 150, // TÜBER: çiğ sebze/salata 1 standart porsiyon = 150 g
  meze_sos: 80, // Sabancı: garnitür yoğurt 80 g (en zayıf dayanak)
  tatli_kek: 100, // Sabancı: özel tatlılar (pastalar dahil) 100 g
  tatli_sutlu: 130, // Sabancı: sütlü tatlılar 130 g
  tatli_hamurisi: 170, // Sabancı: hamurişi tatlılar 170 g
  borek: 140, // Sabancı: börek 140 g
  pide_pizza: 250, // Sabancı: pizza, krep, lazanya, pide 250 g
};
const DISH_LABEL = {
  ana_yemek: "ana yemek",
  corba: "çorba",
  yan_yemek: "yan yemek (ayrı tabak)",
  garnitur: "garnitür",
  salata: "salata",
  meze_sos: "meze/sos",
  tatli_kek: "kek/pasta",
  tatli_sutlu: "sütlü tatlı",
  tatli_hamurisi: "hamurişi tatlı",
  borek: "börek",
  pide_pizza: "pide/pizza",
};

// AI'ın "portion" alanında kullanacağı değerler (prompt ve JSON şeması da bunları kullanır).
export const PORTION_DISH_TYPES = Object.keys(SERVING_REFERENCE_G).concat(["diger"]);
export const PORTION_METHODS = ["haslama_sulu", "firin", "tava_izgara", "kizartma", "cig", "diger"];
export const PORTION_KINDS = [
  "tavuk_kemikli", "tavuk_kemiksiz", "et_kemikli", "et_kemiksiz", "kiyma", "balik_butun", "balik_fileto",
  "pirinc", "bulgur", "makarna_kuru", "kuru_baklagil", "mercimek", "patates", "sebze", "yumurta",
  "sut", "yogurt", "krema", "peynir", "sivi_yag", "tereyagi", "un", "seker", "irmik", "sos_salca",
  "su", "et_suyu", "baharat_tuz", "katki", "diger",
];
export const PORTION_UNITS = ["g", "kg", "ml", "l", "su_bardagi", "cay_bardagi", "yemek_kasigi", "tatli_kasigi", "cay_kasigi", "adet", "belirsiz"];
export const PORTION_SIZES = ["kucuk", "orta", "buyuk"];
export const PORTION_STATES = ["cig", "pismis"];

const NEGLIGIBLE = new Set(["baharat_tuz", "katki"]);
// Porsiyonu belirleyen ana malzemeler: bunlardan birinin miktarı çözülemezse sayı üretilmez.
const MAIN_KINDS = new Set([
  "tavuk_kemikli", "tavuk_kemiksiz", "et_kemikli", "et_kemiksiz", "kiyma", "balik_butun", "balik_fileto",
  "pirinc", "bulgur", "makarna_kuru", "kuru_baklagil", "mercimek", "patates",
]);
const AI_FILLED_LIMIT = 0.25; // kaynakta olmayan miktarların verimdeki payı bunu aşarsa hesap yapılmaz

const fmt = (n, d = 0) => String(Number(n.toFixed(d))).replace(".", ",");

function toGrams(item) {
  const q = Number(item.quantity);
  if (!Number.isFinite(q) || q <= 0) return { error: "miktar yok" };
  const kind = item.kind;
  if (UNIT_G[item.unit]) return { g: q * UNIT_G[item.unit] };
  if (UNIT_ML[item.unit]) {
    const d = DENSITY[kind];
    if (d == null) return { error: `${item.unit} için yoğunluk bilinmiyor` };
    return { g: q * UNIT_ML[item.unit] * d };
  }
  if (item.unit === "adet") {
    const table = PIECE_G[kind] || (item.name && PIECE_G[pieceKey(item.name)]);
    if (!table) return { error: "adet ağırlığı bilinmiyor" };
    const size = table[item.size] ? item.size : "orta";
    return { g: q * table[size], sizeAssumed: !table[item.size] };
  }
  return { error: `birim belirsiz (${item.unit || "yok"})` };
}
function pieceKey(name) {
  const n = String(name).toLocaleLowerCase("tr");
  if (n.includes("patates")) return "patates";
  if (n.includes("soğan")) return "sogan";
  if (n.includes("havuç")) return "havuc";
  if (n.includes("domates")) return "domates";
  if (n.includes("yumurta")) return "yumurta";
  return "";
}

// portion: { dish_type, cooking_method, items:[{name, kind, quantity, unit, size, quantity_in_source}] }
// Dönen: { status: "hesaplandi" | "bilgi_yetersiz" | "desteklenmiyor", servings, raw, yieldG, perServingG, lines, notes }
export function estimateServings(portion) {
  const dishType = portion && portion.dish_type;
  const perServingG = SERVING_REFERENCE_G[dishType];
  if (!perServingG) return { status: "desteklenmiyor", notes: [`yemek türü için kişi başı referans yok (${dishType || "belirtilmedi"})`] };
  const method = portion.cooking_method || "";
  const items = Array.isArray(portion.items) ? portion.items : [];
  const mode = MASS_MODE[dishType] ? "kutle" : DOUGH_MODE[dishType] ? "hamur" : "bilesen";

  let sourceYield = 0;
  let aiYield = 0;
  const lines = [];
  const notes = [];
  const skipped = [];
  const missingMain = [];
  let sizeAssumed = false;
  let usesCup = false;

  for (const it of items) {
    if (!it || NEGLIGIBLE.has(it.kind)) continue;
    const conv = toGrams(it);
    if (conv.error) {
      skipped.push(`${it.name || it.kind} (${conv.error})`);
      if (MAIN_KINDS.has(it.kind) || (mode === "hamur" && it.kind === "un")) missingMain.push(it.name || it.kind);
      continue;
    }
    if (conv.sizeAssumed) sizeAssumed = true;
    if (it.unit === "su_bardagi" || it.unit === "cay_bardagi") usesCup = true;
    const factor =
      mode === "bilesen"
        ? componentFactor(it.kind, method, it.state)
        : mode === "kutle" && it.state !== "pismis"
          ? EDIBLE_RAW[it.kind] ?? 1
          : 1;
    const y = conv.g * factor;
    if (it.quantity_in_source === false) {
      aiYield += y;
      continue;
    }
    sourceYield += y;
    lines.push({ name: it.name || it.kind, g: conv.g, factor, y });
  }

  let yieldG = sourceYield;
  if (mode === "kutle") {
    yieldG *= MASS_MODE[dishType].keep;
    notes.push(MASS_MODE[dishType].note);
  } else if (mode === "hamur") {
    yieldG *= DOUGH_MODE[dishType].keep;
    notes.push(DOUGH_MODE[dishType].note);
  } else if (lines.some((l) => l.factor === 0)) {
    notes.push("pişirme suyu/et suyu verime ayrıca eklenmedi (kuru gıdaların katsayısı çektiği suyu içerir)");
  }
  if (sizeAssumed) notes.push("boyutu belirtilmeyen adetler orta boy kabul edildi");
  if (usesCup) notes.push("1 su bardağı = 200 mL, 1 çay bardağı = 100 mL kabul edildi (ev bardakları değişken)");
  if (skipped.length) notes.push(`hesaba katılamayanlar: ${skipped.join(", ")}`);

  if (missingMain.length) {
    return { status: "bilgi_yetersiz", notes: [`ana malzemenin miktarı belirsiz: ${missingMain.join(", ")}`, ...notes] };
  }
  const totalWithAi = sourceYield + aiYield;
  if (sourceYield <= 0 || (totalWithAi > 0 && aiYield / totalWithAi > AI_FILLED_LIMIT)) {
    return { status: "bilgi_yetersiz", notes: ["kaynakta porsiyon hesabına yetecek malzeme miktarı yok", ...notes] };
  }
  const raw = yieldG / perServingG;
  return {
    status: "hesaplandi",
    servings: Math.max(1, Math.round(raw)),
    raw,
    yieldG,
    perServingG,
    dishType,
    mode,
    lines,
    notes,
  };
}

// Kullanıcıya gösterilen gerekçe: gerçekten uygulanan hesabın aynısı.
export function describeEstimate(r) {
  if (r.status !== "hesaplandi") {
    return `Porsiyon hesaplanamadı: ${r.notes.join("; ")}.`;
  }
  const parts = r.lines
    .filter((l) => l.y > 0)
    .map((l) => (l.factor === 1 ? `${l.name} ${fmt(l.g)} g` : `${l.name} ${fmt(l.g)} g × ${fmt(l.factor, 2)} = ${fmt(l.y)} g`));
  const modeText =
    r.mode === "kutle" ? "toplam malzeme ağırlığı" : r.mode === "hamur" ? "toplam hamur ağırlığı" : "yenebilir pişmiş verim";
  return (
    `Porsiyon kaynakta yazmadığı için malzeme miktarlarından hesaplandı: ${modeText} ≈ ${fmt(r.yieldG)} g ` +
    `(${parts.join("; ")}${r.notes.length ? "; " + r.notes.join("; ") : ""}). ` +
    `${DISH_LABEL[r.dishType]} için kişi başı ${r.perServingG} g → ${fmt(r.yieldG)} ÷ ${r.perServingG} ≈ ${fmt(r.raw, 1)} → ${r.servings} porsiyon (yaklaşık).`
  );
}

// Tarif objesine uygular: kaynaktaki porsiyon > hesap > bilinmiyor.
// servings_basis: "kaynak" (kaynakta yazıyor) | "hesap" (tahmini) | "bilinmiyor" (sayı yok)
//                 | "kullanici" (Tarifi Düzenle'den elle girildi — bkz. App.jsx RecipeEditor).
// Gerekçe `assumptions`'a karıştırılmaz, ayrı `servings_note` alanında durur; böylece
// kullanıcı porsiyonu değiştirince yalnızca bu alan silinir, AI'ın diğer varsayımları kalır.
export function applyPortionEstimate(recipe) {
  if (!recipe || typeof recipe !== "object") return recipe;
  const { portion, ...rest } = recipe;
  const stated = Number(rest.servings);
  if (Number.isFinite(stated) && stated > 0) {
    return { ...rest, servings: Math.round(stated), servings_basis: "kaynak" };
  }
  if (!portion) return { ...rest, servings: null, servings_basis: "bilinmiyor" };
  const r = estimateServings(portion);
  const servings_note = describeEstimate(r);
  if (r.status !== "hesaplandi") {
    return { ...rest, servings: null, servings_basis: "bilinmiyor", servings_note };
  }
  return {
    ...rest,
    servings: r.servings,
    servings_basis: "hesap",
    servings_calc: {
      v: PORTION_RULES_VERSION,
      dish_type: r.dishType,
      yield_g: Math.round(r.yieldG),
      per_serving_g: r.perServingG,
      raw: Number(r.raw.toFixed(2)),
    },
    servings_note,
  };
}
