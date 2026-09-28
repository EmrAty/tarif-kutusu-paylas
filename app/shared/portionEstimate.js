// Porsiyon hesabı: AI'ın kaynaktan çıkardığı yapılandırılmış bilgiyi ("portion")
// sürümlü, kaynaklı tablolarla deterministik olarak porsiyon ARALIĞINA çevirir.
// Hem istemci ("Yeni Tarif Çıkar" -> /api/extract) hem sunucu (paylaşım paneli ->
// /api/recipe-jobs) bu dosyayı kullanır. Kaynaklar ve gerekçeler: docs/porsiyon-hesabi.md
//
// İki bağımsız yöntem var:
//  A) Ana malzeme: yemeğin ana malzemesinin miktarı ÷ Türk kurum şartnamelerindeki
//     kişi başı çiğ miktar (MSB, AGU; garnitürde TÜBER).
//  B) Toplam verim: pişmiş yenebilir verim ÷ kişi başı tüketilen porsiyon (Türk kurum
//     porsiyonu ile gözlenen tüketimin — NNPAS 2011-12 — arası).
// İkisi de hesaplanabiliyorsa ve aralıkları örtüşüyorsa kesişimleri alınır; örtüşmüyorsa
// yemek türünün birincil yöntemi kullanılır. Sonuç bir aralıktır; tek sayı (ölçekleme için)
// aralığın geometrik ortasıdır. Tam sayıya yuvarlama yalnızca en son adımda yapılır.
//
// Aynı normalize girdi + aynı kural sürümü => her zaman aynı sonuç. Tüm adımlar çarpımsal
// olduğu için malzemeler k katına çıkınca yuvarlanmamış aralık da k katına çıkar.

export const PORTION_RULES_VERSION = "2026-09-28.1";

// --- Ölçüler -------------------------------------------------------------------
// Ev ölçüsü hacimleri (mL). Türkiye'de standart değildir (TÜBER 2022: su bardakları
// 200-560 mL; MSB şartnamesi su bardağını 250 mL sayar); tarif sitelerinin kabulü seçildi.
const UNIT_ML = {
  ml: 1,
  l: 1000,
  su_bardagi: 200, // tarif sitelerinin kabulü (yemek.com); MSB 250 mL sayar
  cay_bardagi: 100, // tarif sitelerinin kabulü; TÜBER: 85-165 mL
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
  kizartma_yagi: 0.92, // sıvı yağ ile aynı
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
// Türk çeşitleri ABD çeşitlerinden belirgin farklı olan sebzeler (patlıcan, sivri/dolmalık biber,
// salatalık, kabak) bilerek eklenmedi: USDA'nın 548 g'lık patlıcanı ya da 301 g'lık salatalığı
// burada sahte kesinlik olurdu. Bunlar adetle verilirse gram almaz, hesap dışı kalır.
const PIECE_G = {
  patates: { kucuk: 170, orta: 213, buyuk: 369 }, // FDC 170026
  sogan: { kucuk: 70, orta: 110, buyuk: 150 }, // FDC 170000
  havuc: { kucuk: 50, orta: 61, buyuk: 72 }, // FDC 170393
  domates: { kucuk: 91, orta: 123, buyuk: 182 }, // FDC 170457
  yumurta: { kucuk: 38, orta: 44, buyuk: 50 }, // FDC 171287 (kabuksuz)
  // Sarı ve ak: USDA yalnızca büyük boy veriyor; boyuttan bağımsız bu değer kullanılır.
  yumurta_sarisi: { orta: 17 }, // FDC 172184 "Egg, yolk, raw" 1 large = 17 g
  yumurta_aki: { orta: 33 }, // FDC 172183 "Egg, white, raw" 1 large = 33 g
};

// --- Pişmiş/yenebilir verim katsayıları (pişmiş yenebilir g / çiğ g) ---------------
// B yönteminin "bileşen" modunda ve ana malzemelerin baskınlık karşılaştırmasında kullanılır.
const DRY_HEAT = new Set(["firin", "tava_izgara", "kizartma"]);
function componentFactor(kind, method, state) {
  if (state === "pismis") {
    // Kaynakta zaten pişmiş verilen malzemeye pişme katsayısı ikinci kez uygulanmaz;
    // yalnızca kemik payı düşülür: Bognár tavuk budu yenebilir/kemikli = 0.48/0.64 ≈ 0.75.
    if (kind === "tavuk_kemikli" || kind === "et_kemikli") return 0.75;
    if (kind === "su" || kind === "et_suyu" || kind === "kizartma_yagi") return 0;
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
    case "yaprakli_sebze": // yapraklı sebze için ayrı verim verisi kullanılmadı (sebze ile aynı yaklaşım)
      if (method === "cig") return 1.0;
      return DRY_HEAT.has(method) ? 0.8 : 0.93; // Bognár: kuru ısıda soğan 0.83, biber/kabak 0.73-0.74; haşlamada havuç 0.94, taze fasulye 0.93
    case "su":
    case "et_suyu":
      return 0; // pişirme sıvısı: Bognár'a göre tarife dahil edilmez; kuru gıdaların katsayısı çektikleri suyu içerir
    case "kizartma_yagi":
      return 0; // kızartma yağının çoğu tavada kalır; emilen miktar bilinmediği için verime eklenmez
    default:
      return 1.0; // yağ, süt ürünleri, un, şeker, sos, yumurta, peynir, diğer: ağırlık korunur (yaklaşım)
  }
}

// Suyu kendi tarifindeki sıvıdan çeken tahıllar (pilav usulü). Bunların pişmiş verimi, tarifte
// yazan kuru ağırlık + sıvıyı AŞAMAZ (kütle korunumu); Bognár katsayısı süzmeli haşlama içindir.
const ABSORBING = new Set(["pirinc", "bulgur"]);
// Kemikli/ayıklanmamış malzemede yenebilir çiğ pay (kütle modunda).
const EDIBLE_RAW = { tavuk_kemikli: 0.7, et_kemikli: 0.7, balik_butun: 0.55 }; // TÜBER %30 kemik; balık için pişmiş oran vekil

// Su dahil pişirmede kalan oran aralığı. Bognár (2002) buharlaşmanın öngörülemediğini yazar ve
// su dahil hesaplanan risotto örneğinde verimi 0,76 (küçük parti) ile 0,92 (büyük parti) arasında
// ölçer; sütlaç (0,91) ve irmik tatlısı (0,88) ölçümleri de bu aralıktadır.
const WET_KEEP = [0.76, 0.92];
const MASS_MODE = new Set(["corba", "tatli_sutlu", "tatli_hamurisi"]);
// Fırında pişen hamur/kek: tüm malzemenin kalan oranı (tek değer).
const DOUGH_MODE = {
  tatli_kek: { keep: 0.92, note: "kek pişme katsayısı 0,92 (Bognár mermer kek)" },
  borek: { keep: 0.9, note: "fırın hamur işi katsayısı 0,90 (Bognár ekmek)" },
  pide_pizza: { keep: 0.9, note: "fırın hamur işi katsayısı 0,90 (Bognár ekmek)" },
};

// --- A) Ana malzeme: kişi başı ÇİĞ miktar (g) -------------------------------------
// Türk kurumlarının planlı öğün girdileri: MSB 2017-2018 Yemek Teknik Şartname Ek 1-a (yetişkin)
// ve Abdullah Gül Üniversitesi (AGU) yemek teknik şartnamesi; garnitürde TÜBER 2022.
// [alt, üst] = kaynakların en küçüğü ve en büyüğü. Aynı malzeme yemeğin türüne göre farklı
// miktardadır (MSB: kuşbaşı et yemeğinde 160 g, sebze/bakliyat yemeğinde 80 g et).
const PP = {
  et_ana: { lo: 150, hi: 200, label: "et ağırlıklı yemekte çiğ kemiksiz et", src: "AGU 150; MSB kuşbaşı 160, tek parça 180, çoban kavurma 200" },
  tavuk_ana: { lo: 175, hi: 180, label: "tavuk ağırlıklı yemekte çiğ kemiksiz tavuk", src: "AGU tavuk göğsü 175; MSB kemiksiz tavuk 180" },
  kiyma_ana: { lo: 130, hi: 150, label: "köfte/kıyma ağırlıklı yemekte çiğ kıyma", src: "MSB köfte 130, pirinçli köfte 140; AGU köfteler 150" },
  et_kemikli: { lo: 200, hi: 200, label: "çiğ kemikli et", src: "AGU kapama (kemikli kuzu) 200" },
  tavuk_kemikli: { lo: 250, hi: 250, label: "çiğ kemikli tavuk", src: "MSB kemikli tavuk 250; AGU fırın tavuk (but) 250" },
  balik_butun: { lo: 250, hi: 300, label: "çiğ bütün balık", src: "MSB temizlenmiş balık 250-300; AGU balık 250" },
  balik_fileto: { lo: 180, hi: 180, label: "çiğ balık fileto", src: "MSB fileto 180" },
  yumurta: { lo: 1, hi: 1, count: true, label: "yumurta yemeğinde yumurta (adet)", src: "AGU menemen ve yumurtalı ıspanak 1 adet" },
  makarna_ana: { lo: 100, hi: 100, label: "makarna yemeğinde kuru makarna", src: "AGU fırın makarna ve spagetti 100" },
  pirinc_pilav: { lo: 70, hi: 100, label: "pilavda çiğ pirinç", src: "MSB pilav 70; AGU pilav 100" },
  bulgur_pilav: { lo: 60, hi: 100, label: "pilavda çiğ bulgur", src: "MSB pilav 60; AGU pilav 100" },
  makarna_yan: { lo: 60, hi: 100, label: "yan yemek makarnada kuru makarna", src: "MSB makarna 60; AGU makarna 100" },
  baklagil: { lo: 70, hi: 100, label: "bakliyat yemeğinde kuru baklagil", src: "MSB kuru fasulye/nohut 70; AGU 100" },
  mercimek_yemek: { lo: 100, hi: 100, label: "mercimek yemeğinde yeşil mercimek", src: "MSB etli yemekte yeşil mercimek 100; AGU kıymalı yeşil mercimek 100" },
  sebze: { lo: 150, hi: 250, label: "sebze yemeğinde ana sebze", src: "MSB zeytinyağlı taze fasulye 150, etli sebze yemeği 175; AGU 200-250" },
  yaprakli: { lo: 200, hi: 400, label: "yapraklı sebze yemeğinde sebze", src: "AGU ıspanak/pırasa 200-250, semizotu 250; MSB pazı/lahana 300, semizotu 400" },
  patates: { lo: 200, hi: 200, label: "patates (garnitür/ana)", src: "MSB patates garnitür 200, kızartma 200" },
  kiyma_sebze: { lo: 40, hi: 100, label: "sebze yemeğinde/dolmada kıyma", src: "MSB kabak dolma 40, karışık dolma 50, karnıyarık/musakka/oturtma 60; AGU 70-100" },
  et_sebze: { lo: 60, hi: 90, label: "sebze/bakliyat yemeğinde et", src: "AGU etli türlü 60; MSB sebze/bakliyat 80, etli türlü 90" },
  tavuk_sebze: { lo: 70, hi: 100, label: "sebze/bakliyat yemeğinde tavuk", src: "MSB sebze/bakliyat 70, tavuklu karnıyarık 100" },
  pirinc_dolma: { lo: 25, hi: 50, label: "dolmada pirinç", src: "MSB biber dolma/sarma 25; AGU biber dolma 50" },
  kiyma_bakliyat: { lo: 30, hi: 60, label: "bakliyat yemeğinde kıyma", src: "AGU kıymalı nohut 30, kıymalı kuru fasulye 60" },
  pirinc_garnitur: { lo: 30, hi: 50, label: "garnitür pilavda çiğ pirinç", src: "TÜBER garnitür 1 standart porsiyon ≈ 30; MSB garnitür 50" },
  bulgur_garnitur: { lo: 25, hi: 30, label: "garnitür pilavda çiğ bulgur", src: "TÜBER 25; MSB garnitür 30" },
  makarna_garnitur: { lo: 36, hi: 60, label: "garnitür makarnada kuru makarna", src: "TÜBER makarna garnitürü 75 g pişmiş ÷ 2,10 ≈ 36; MSB makarna 60" },
  sut_tatli: { lo: 150, hi: 200, label: "sütlü tatlıda süt", src: "MSB sütlü tatlılar 150; AGU fırın sütlaç 200" },
  un_hamurisi: { lo: 50, hi: 80, sum: ["un", "irmik"], label: "hamur tatlısında un + irmik", src: "MSB tatlılar için un (asgari) 50-80" },
  kuru_corba: { lo: 35, hi: 50, sum: ["mercimek", "pirinc", "bulgur", "makarna_kuru", "kuru_baklagil"], label: "çorbada kuru tahıl/baklagil", src: "MSB kırmızı mercimek 35; AGU mercimek ve ezogelin çorbası 50" },
};
const SEBZE_ANCHORS = { sebze: PP.sebze, yaprakli_sebze: PP.yaprakli, patates: PP.patates };
const ANCHORS = {
  ana_yemek: {
    et_kemiksiz: PP.et_ana, tavuk_kemiksiz: PP.tavuk_ana, kiyma: PP.kiyma_ana, et_kemikli: PP.et_kemikli, tavuk_kemikli: PP.tavuk_kemikli,
    balik_butun: PP.balik_butun, balik_fileto: PP.balik_fileto, yumurta: PP.yumurta, makarna_kuru: PP.makarna_ana,
    pirinc: PP.pirinc_pilav, bulgur: PP.bulgur_pilav, kuru_baklagil: PP.baklagil, mercimek: PP.mercimek_yemek, ...SEBZE_ANCHORS,
  },
  sebze_yemegi: {
    ...SEBZE_ANCHORS, kiyma: PP.kiyma_sebze, et_kemiksiz: PP.et_sebze, tavuk_kemiksiz: PP.tavuk_sebze, pirinc: PP.pirinc_dolma,
  },
  bakliyat_yemegi: {
    kuru_baklagil: PP.baklagil, mercimek: PP.mercimek_yemek, et_kemiksiz: PP.et_sebze, tavuk_kemiksiz: PP.tavuk_sebze, kiyma: PP.kiyma_bakliyat,
  },
  yan_yemek: {
    pirinc: PP.pirinc_pilav, bulgur: PP.bulgur_pilav, makarna_kuru: PP.makarna_yan, kuru_baklagil: PP.baklagil, ...SEBZE_ANCHORS,
  },
  garnitur: { pirinc: PP.pirinc_garnitur, bulgur: PP.bulgur_garnitur, makarna_kuru: PP.makarna_garnitur, patates: PP.patates },
  corba: { _sum: PP.kuru_corba },
  tatli_sutlu: { sut: PP.sut_tatli },
  tatli_hamurisi: { _sum: PP.un_hamurisi },
};
// Sebze türleri yalnızca AI "ana malzeme" (main: true) dediyse ana malzeme sayılır; aksi hâlde
// soğan/domates/biber gibi yardımcı sebzeler porsiyonu belirlerdi.
const NEEDS_MAIN_FLAG = new Set(["sebze", "yaprakli_sebze", "patates"]);

// --- B) Toplam verim: kişi başı TÜKETİLEN pişmiş miktar (g) -----------------------
// [alt, üst] = Türk kurum porsiyonu (Sabancı Ek-2 asgari gramajlar, TÜBER, MSB) ile gözlenen
// tüketimin (NNPAS 2011-12, Avustralya, 19+ yaş, öğün başı medyan) kadın ve erkek değerlerinin
// kapsadığı aralık. Yaş gruplarına ayrılmış tablolarda her cinsiyet için yaş gruplarının medyanı alındı.
const CONSUMED = {
  ana_yemek: { lo: 200, hi: 310, src: "Sabancı ana yemek 200; NNPAS karışık yemek (makarna/pirinç yemekleri) kadın 266, erkek 310" },
  sebze_yemegi: { lo: 200, hi: 310, src: "Sabancı ana yemek 200; NNPAS karışık yemek kadın 266, erkek 310" },
  bakliyat_yemegi: { lo: 200, hi: 310, src: "Sabancı ana yemek 200; NNPAS karışık yemek kadın 266, erkek 310" },
  yan_yemek: { lo: 137, hi: 201, src: "NNPAS pişmiş pirinç kadın 137, erkek 201; Sabancı pilav/makarna/zeytinyağlı 170" },
  garnitur: { lo: 90, hi: 149, src: "TÜBER garnitür 90-110; MSB garnitür pirinci 50 g çiğ ≈ 149 g pişmiş" },
  corba: { lo: 200, hi: 420, src: "Sabancı ve AGU çorba asgari 200; NNPAS çorba kadın 333, erkek 420" },
  salata: { lo: 150, hi: 210, src: "TÜBER çiğ sebze 1 standart porsiyon 150; MSB çoban salata sebzeleri toplamı 210" },
  meze_sos: { lo: 80, hi: 180, src: "Sabancı garnitür yoğurt 80; MSB cacık (yoğurt 130 + salatalık 50) 180" },
  tatli_kek: { lo: 88, hi: 103, src: "NNPAS kek/çörek/muffin kadın 88, erkek 103; Sabancı pasta dahil özel tatlılar 100" },
  tatli_sutlu: { lo: 104, hi: 130, src: "NNPAS sütlü tatlı 104 (Eldridge 2025); Sabancı sütlü tatlı 130" },
  tatli_hamurisi: { lo: 88, hi: 170, src: "NNPAS kek/çörek kadın 88; Sabancı hamurişi tatlı 170" },
  borek: { lo: 140, hi: 175, src: "Sabancı börek 140; NNPAS tuzlu hamur işi kadın 149, erkek 175" },
  pide_pizza: { lo: 185, hi: 290, src: "NNPAS pizza kadın 185, erkek 290; Sabancı pizza/pide 250" },
};
// Birincil yöntem: iki yöntemin aralıkları örtüşmezse bu kullanılır.
const PRIMARY = {
  ana_yemek: "A", sebze_yemegi: "A", bakliyat_yemegi: "A", yan_yemek: "A", garnitur: "A", tatli_sutlu: "A", tatli_hamurisi: "A",
  corba: "B", salata: "B", meze_sos: "B", tatli_kek: "B", borek: "B", pide_pizza: "B",
};

const DISH_LABEL = {
  ana_yemek: "ana yemek",
  sebze_yemegi: "sebze yemeği",
  bakliyat_yemegi: "bakliyat yemeği",
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
export const PORTION_DISH_TYPES = Object.keys(DISH_LABEL).concat(["diger"]);
export const PORTION_METHODS = ["haslama_sulu", "firin", "tava_izgara", "kizartma", "cig", "diger"];
export const PORTION_KINDS = [
  "tavuk_kemikli", "tavuk_kemiksiz", "et_kemikli", "et_kemiksiz", "kiyma", "balik_butun", "balik_fileto",
  "pirinc", "bulgur", "makarna_kuru", "kuru_baklagil", "mercimek", "patates", "sebze", "yaprakli_sebze", "yumurta",
  "sut", "yogurt", "krema", "peynir", "sivi_yag", "kizartma_yagi", "tereyagi", "un", "seker", "irmik", "sos_salca",
  "su", "et_suyu", "baharat_tuz", "katki", "diger",
];
export const PORTION_UNITS = ["g", "kg", "ml", "l", "su_bardagi", "cay_bardagi", "yemek_kasigi", "tatli_kasigi", "cay_kasigi", "adet", "belirsiz"];
export const PORTION_SIZES = ["kucuk", "orta", "buyuk"];
export const PORTION_STATES = ["cig", "pismis"];
// Kaynakta yazan sayının neyi saydığı: kişi/porsiyon, adet (kurabiye, dolma, karnıyarık) ya da dilim.
export const SERVINGS_UNITS = ["porsiyon", "adet", "dilim"];

const NEGLIGIBLE = new Set(["baharat_tuz", "katki"]);
// Porsiyonu belirleyen ana malzemeler: bunlardan birinin miktarı çözülemezse sayı üretilmez.
const MAIN_KINDS = new Set([
  "tavuk_kemikli", "tavuk_kemiksiz", "et_kemikli", "et_kemiksiz", "kiyma", "balik_butun", "balik_fileto",
  "pirinc", "bulgur", "makarna_kuru", "kuru_baklagil", "mercimek", "patates",
]);
const AI_FILLED_LIMIT = 0.25; // kaynakta olmayan miktarların verimdeki payı bunu aşarsa hesap yapılmaz

const fmt = (n, d = 0) => String(Number(n.toFixed(d))).replace(".", ",");
const fmtRange = (lo, hi, d = 1) => (fmt(lo, d) === fmt(hi, d) ? fmt(lo, d) : `${fmt(lo, d)}–${fmt(hi, d)}`);

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
    // "yumurta sarısı"/"yumurta akı" şemada ayrı bir tür değil (AI "yumurta" ya da "diger" döndürür);
    // tam yumurta ağırlığı almasınlar diye önce isimden ayırt edilir.
    const table = PIECE_G[eggPart(item.name)] || PIECE_G[kind] || (item.name && PIECE_G[pieceKey(item.name)]);
    if (!table) return { error: "adet ağırlığı bilinmiyor" };
    const fixed = Object.keys(table).length === 1; // boyuta göre ayrılmayan ağırlık (yumurta sarısı/akı)
    const size = table[item.size] ? item.size : "orta";
    return { g: q * table[size], sizeAssumed: !fixed && !table[item.size] };
  }
  return { error: `birim belirsiz (${item.unit || "yok"})` };
}
// Yalnızca sarı ya da yalnızca ak geçiyorsa o parça; ikisi birden ya da hiçbiri → tam yumurta (null).
function eggPart(name) {
  const n = String(name || "").toLocaleLowerCase("tr");
  let yolk;
  let white;
  if (n.includes("yumurta")) {
    yolk = /sarı/u.test(n);
    white = /(^|[^\p{L}])akı?(ları|leri)?(?![\p{L}])/u.test(n);
  } else if (/(^|[^\p{L}])eggs?(?![\p{L}])/u.test(n)) {
    // Uygulama İngilizceyken çıkarılan tarifler ("egg yolks", "egg whites")
    yolk = /yolk/u.test(n);
    white = /whites?(?![\p{L}])/u.test(n);
  } else {
    return null;
  }
  if (yolk === white) return null;
  return yolk ? "yumurta_sarisi" : "yumurta_aki";
}
function pieceKey(name) {
  const n = String(name).toLocaleLowerCase("tr");
  if (n.includes("patates")) return "patates";
  if (n.includes("soğan")) return "sogan";
  if (n.includes("havuç")) return "havuc";
  if (n.includes("domates")) return "domates";
  if (n.includes("yumurta")) return "yumurta";
  // İngilizce adlar: yalnızca son kelime (baş isim) sayılır — "eggplant" ve "egg noodles" yumurta değil.
  const head = n.replace(/\([^)]*\)/g, " ").trim();
  const en = [["potato", "patates"], ["onion", "sogan"], ["carrot", "havuc"], ["tomato", "domates"], ["egg", "yumurta"]];
  for (const [word, key] of en) if (head === word || head === `${word}s` || head === `${word}es` || head.endsWith(` ${word}`) || head.endsWith(` ${word}s`) || head.endsWith(` ${word}es`)) return key;
  return "";
}

const label = (it) => it.name || it.kind;

// Ölçülebilen bir malzemenin çiğ eşdeğeri (g). Kaynakta pişmiş verilmişse pişme katsayısıyla
// çiğe döndürülür (kemikli ette yalnızca %30 pişme kaybı: TÜBER).
function rawEquivalent(it, g, method) {
  if (it.state !== "pismis") return g;
  if (it.kind === "tavuk_kemikli" || it.kind === "et_kemikli") return g / 0.7;
  const f = componentFactor(it.kind, method, "cig");
  return f > 0 ? g / f : g;
}

// A) Ana malzeme yöntemi. Dönen: null (yöntem uygulanamaz) | { lo, hi, anchor, missing }
function anchorMethod(dishType, method, items) {
  const table = ANCHORS[dishType];
  if (!table) return null;
  const hasMainFlag = items.some((it) => it && it.main === true);
  const candidates = [];
  const missing = [];
  const sumEntry = table._sum;
  if (sumEntry) {
    let g = 0;
    const names = [];
    for (const it of items) {
      if (!it || !sumEntry.sum.includes(it.kind)) continue;
      const conv = toGrams(it);
      if (conv.error || it.quantity_in_source === false) {
        missing.push(label(it));
        continue;
      }
      g += rawEquivalent(it, conv.g, method);
      names.push(label(it));
    }
    if (g > 0) candidates.push({ entry: sumEntry, amount: g, mass: g, names });
  }
  for (const it of items) {
    if (!it) continue;
    const entry = table[it.kind];
    if (!entry) continue;
    if (NEEDS_MAIN_FLAG.has(it.kind) && it.main !== true) continue;
    // Yumurta ancak AI onu ana malzeme saydıysa (ya da hiç işaret yoksa) porsiyonu belirler.
    if (it.kind === "yumurta" && hasMainFlag && it.main !== true) continue;
    if (it.kind === "yumurta" && eggPart(it.name)) continue;
    const conv = toGrams(it);
    if (conv.error || it.quantity_in_source === false) {
      missing.push(label(it));
      continue;
    }
    const raw = rawEquivalent(it, conv.g, method);
    const amount = entry.count ? (it.unit === "adet" ? Number(it.quantity) : raw / PIECE_G.yumurta.orta) : raw;
    candidates.push({ entry, amount, mass: raw * componentFactor(it.kind, method, "cig"), names: [label(it)] });
  }
  if (!candidates.length) return { missing };
  // Tabağın büyük kısmını oluşturan (pişmiş kütlesi en büyük) ana malzeme porsiyonu belirler.
  const best = candidates.reduce((a, b) => (b.mass > a.mass ? b : a));
  return { lo: best.amount / best.entry.hi, hi: best.amount / best.entry.lo, anchor: best, missing };
}

// B) Toplam verim yöntemi. Dönen: { yieldLo, yieldHi, lines, notes, skipped, sourceYield, aiYield, missingMain }
function yieldMethod(dishType, method, items) {
  const mode = MASS_MODE.has(dishType) ? "kutle" : DOUGH_MODE[dishType] ? "hamur" : "bilesen";
  let sourceYield = 0;
  let aiYield = 0;
  let liquidG = 0;
  const absorbing = [];
  const lines = [];
  const skipped = [];
  const missingMain = [];
  let sizeAssumed = false;
  let usesCup = false;
  let fryingOil = false;

  for (const it of items) {
    if (!it || NEGLIGIBLE.has(it.kind)) continue;
    const conv = toGrams(it);
    if (conv.error) {
      skipped.push(`${label(it)} (${conv.error})`);
      // AI'ın ana malzeme dediği (ör. karnıyarıkta "6 adet patlıcan") ölçülemiyorsa toplam verim eksik kalır.
      if (MAIN_KINDS.has(it.kind) || it.main === true || (mode === "hamur" && it.kind === "un")) missingMain.push(label(it));
      continue;
    }
    if (conv.sizeAssumed) sizeAssumed = true;
    if (it.unit === "su_bardagi" || it.unit === "cay_bardagi") usesCup = true;
    if (it.kind === "kizartma_yagi") fryingOil = true;
    let factor;
    if (mode === "bilesen") factor = componentFactor(it.kind, method, it.state);
    else if (it.kind === "kizartma_yagi") factor = 0;
    else if (mode === "kutle" && it.state !== "pismis") factor = EDIBLE_RAW[it.kind] ?? 1;
    else factor = 1;
    const y = conv.g * factor;
    if (it.quantity_in_source === false) {
      aiYield += y;
      continue;
    }
    if (mode === "bilesen" && (it.kind === "su" || it.kind === "et_suyu") && it.state !== "pismis") liquidG += conv.g;
    if (mode === "bilesen" && ABSORBING.has(it.kind) && it.state !== "pismis") absorbing.push({ g: conv.g, line: lines.length });
    sourceYield += y;
    lines.push({ name: label(it), g: conv.g, factor, y });
  }

  const notes = [];
  // Kütle korunumu: pilav usulü pişen tahılın verimi kuru ağırlık + tarifteki sıvıyı aşamaz.
  if (absorbing.length && liquidG > 0) {
    const dry = absorbing.reduce((s, a) => s + a.g, 0);
    const cooked = absorbing.reduce((s, a) => s + lines[a.line].y, 0);
    if (cooked > dry + liquidG) {
      const k = (dry + liquidG) / cooked;
      for (const a of absorbing) {
        const l = lines[a.line];
        sourceYield -= l.y * (1 - k);
        l.y *= k;
        l.factor *= k;
      }
      notes.push(`pilav usulü pişen tahılın verimi, kuru ağırlığı ile tarifteki sıvının toplamıyla (${fmt(dry + liquidG)} g) sınırlandı`);
    }
  }
  let keep = [1, 1];
  if (mode === "kutle") {
    keep = WET_KEEP;
    notes.push("su dahil pişirmede kalan oran 0,76–0,92 alındı (Bognár: buharlaşma öngörülemez)");
  } else if (mode === "hamur") {
    keep = [DOUGH_MODE[dishType].keep, DOUGH_MODE[dishType].keep];
    notes.push(DOUGH_MODE[dishType].note);
  } else if (lines.some((l) => l.factor === 0 && l.g > 0 && !/kızart/u.test(l.name))) {
    notes.push("pişirme suyu/et suyu verime ayrıca eklenmedi (kuru gıdaların katsayısı çektiği suyu içerir)");
  }
  if (fryingOil) notes.push("kızartma yağı verime eklenmedi (çoğu tavada kalır)");
  if (sizeAssumed) notes.push("boyutu belirtilmeyen adetler orta boy kabul edildi");
  if (usesCup) notes.push("1 su bardağı = 200 mL, 1 çay bardağı = 100 mL kabul edildi (ev bardakları değişken)");
  if (skipped.length) notes.push(`hesaba katılamayanlar: ${skipped.join(", ")}`);
  return { mode, yieldLo: sourceYield * keep[0], yieldHi: sourceYield * keep[1], sourceYield, aiYield, lines, notes, skipped, missingMain };
}

// portion: { dish_type, cooking_method, items:[{name, kind, quantity, unit, size, state, quantity_in_source, main}] }
// Dönen: { status: "hesaplandi" | "bilgi_yetersiz" | "desteklenmiyor", servings, lo, hi, raw, method, ... notes }
export function estimateServings(portion) {
  const dishType = portion && portion.dish_type;
  const consumed = CONSUMED[dishType];
  if (!consumed) return { status: "desteklenmiyor", notes: [`yemek türü için kişi başı referans yok (${dishType || "belirtilmedi"})`] };
  const method = portion.cooking_method || "";
  const items = Array.isArray(portion.items) ? portion.items : [];

  const a = anchorMethod(dishType, method, items);
  const b = yieldMethod(dishType, method, items);
  const notes = [...b.notes];

  // A için: ana malzeme bulundu mu? B için: ana malzemeler çözüldü mü, kaynak miktarları yeterli mi?
  const aOk = !!(a && a.anchor);
  const totalWithAi = b.sourceYield + b.aiYield;
  const bOk = !b.missingMain.length && b.sourceYield > 0 && !(totalWithAi > 0 && b.aiYield / totalWithAi > AI_FILLED_LIMIT);
  const bRange = bOk ? { lo: b.yieldLo / consumed.hi, hi: b.yieldHi / consumed.lo } : null;
  const aRange = aOk ? { lo: a.lo, hi: a.hi } : null;

  // Ana malzemesi ölçülemeyen yemekte (ör. "3 adet tavuk budu") sayı üretilmez; toplam verim o
  // malzeme olmadan hesaplanırsa yanıltıcı olur. Ölçülebilen başka bir ana malzeme varsa A onu kullanır.
  if (!aOk && b.missingMain.length) {
    return { status: "bilgi_yetersiz", notes: [`ana malzemenin miktarı belirsiz: ${b.missingMain.join(", ")}`, ...notes] };
  }
  if (!aRange && !bRange) {
    return { status: "bilgi_yetersiz", notes: ["kaynakta porsiyon hesabına yetecek malzeme miktarı yok", ...notes] };
  }

  let range;
  let used;
  if (aRange && bRange) {
    const lo = Math.max(aRange.lo, bRange.lo);
    const hi = Math.min(aRange.hi, bRange.hi);
    if (lo <= hi) {
      range = { lo, hi };
      used = "ikisi";
    } else {
      used = PRIMARY[dishType] || "A";
      range = used === "A" ? aRange : bRange;
    }
  } else {
    used = aRange ? "A" : "B";
    range = aRange || bRange;
  }
  if (aOk && a.missing.length) notes.push(`ölçülemeyen ana malzeme: ${a.missing.join(", ")}`);

  const raw = Math.sqrt(range.lo * range.hi);
  const servings = Math.max(1, Math.round(raw));
  const loInt = Math.max(1, Math.round(range.lo));
  const hiInt = Math.max(loInt, Math.round(range.hi));
  return {
    status: "hesaplandi",
    servings,
    lo: range.lo,
    hi: range.hi,
    loInt,
    hiInt,
    raw,
    method: used,
    dishType,
    anchor: aOk ? { names: a.anchor.names, amount: a.anchor.amount, entry: a.anchor.entry, lo: a.lo, hi: a.hi } : null,
    yield: bOk ? { mode: b.mode, lo: b.yieldLo, hi: b.yieldHi, lines: b.lines, consumed, rangeLo: bRange.lo, rangeHi: bRange.hi } : null,
    notes,
  };
}

// Kullanıcıya gösterilen gerekçe: gerçekten uygulanan hesabın aynısı (Türkçe; EN'de ayrıca çevrilir).
export function describeEstimate(r) {
  if (r.status !== "hesaplandi") {
    return `Porsiyon hesaplanamadı: ${r.notes.join("; ")}.`;
  }
  const parts = [];
  if (r.anchor) {
    const { entry, amount, names } = r.anchor;
    const unit = entry.count ? " adet" : " g";
    parts.push(
      `Ana malzeme: ${names.join(" + ")} ${fmt(amount)}${unit}; ${entry.label} kişi başı ${entry.lo === entry.hi ? entry.lo : `${entry.lo}–${entry.hi}`}${unit} ` +
        `(${entry.src}) → ${fmtRange(r.anchor.lo, r.anchor.hi)} porsiyon.`
    );
  }
  if (r.yield) {
    const y = r.yield;
    const modeText = y.mode === "kutle" ? "toplam malzeme (su dahil)" : y.mode === "hamur" ? "toplam hamur" : "pişmiş yenebilir verim";
    const lines = y.lines
      .filter((l) => l.y > 0)
      .map((l) => (l.factor === 1 ? `${l.name} ${fmt(l.g)} g` : `${l.name} ${fmt(l.g)} g × ${fmt(l.factor, 2)} = ${fmt(l.y)} g`));
    parts.push(
      `Toplam verim: ${modeText} ≈ ${fmtRange(y.lo, y.hi, 0)} g (${lines.join("; ")}); kişi başı tüketilen ${y.consumed.lo}–${y.consumed.hi} g ` +
        `(${y.consumed.src}) → ${fmtRange(y.rangeLo, y.rangeHi)} porsiyon.`
    );
  }
  const how =
    r.method === "ikisi"
      ? "İki yöntemin örtüşen kısmı alındı"
      : r.anchor && r.yield
        ? `İki yöntem örtüşmedi; ${r.method === "A" ? "ana malzeme" : "toplam verim"} esas alındı`
        : r.method === "A"
          ? "Ana malzemeden hesaplandı"
          : "Toplam verimden hesaplandı";
  const range = r.loInt === r.hiInt ? `${r.servings}` : `${r.loInt}–${r.hiInt}`;
  return (
    `Porsiyon kaynakta yazmadığı için ${DISH_LABEL[r.dishType]} olarak malzeme miktarlarından tahmin edildi; gerçek tüketim kişiye, yaşa ve öğüne göre değişir. ` +
    `${parts.join(" ")} ${how}: ${fmtRange(r.lo, r.hi)} → tahmini ${r.servings} porsiyon (makul aralık ${range})` +
    `${r.notes.length ? ". Notlar: " + r.notes.join("; ") : ""}.`
  );
}

// Kaynakta yazan sayının birimi: bilinmeyen/boş değer "porsiyon" sayılır (eski tarifler).
export function servingsUnitOf(recipe) {
  const u = recipe && recipe.servings_unit;
  return u === "adet" || u === "dilim" ? u : "porsiyon";
}

// Tarif objesine uygular: kaynaktaki porsiyon > hesap > bilinmiyor.
// servings_basis: "kaynak" (kaynakta yazıyor) | "hesap" (tahmini) | "bilinmiyor" (sayı yok)
//                 | "kullanici" (Tarifi Düzenle'den elle girildi — bkz. App.jsx RecipeEditor).
// servings_unit: yalnızca kaynakta adet/dilim yazıyorsa kaydedilir ("porsiyon" varsayılandır).
// servings_range: hesaplanan tahminin makul aralığı [alt, üst] (tam sayı; alt ≠ üst ise).
// Gerekçe `assumptions`'a karıştırılmaz, ayrı `servings_note` alanında durur; böylece
// kullanıcı porsiyonu değiştirince yalnızca bu alan silinir, AI'ın diğer varsayımları kalır.
export function applyPortionEstimate(recipe) {
  if (!recipe || typeof recipe !== "object") return recipe;
  const { portion, servings_unit, ...rest } = recipe;
  const stated = Number(rest.servings);
  if (Number.isFinite(stated) && stated > 0) {
    const unit = servingsUnitOf({ servings_unit });
    return { ...rest, servings: Math.max(1, Math.round(stated)), ...(unit !== "porsiyon" ? { servings_unit: unit } : {}), servings_basis: "kaynak" };
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
    ...(r.loInt !== r.hiInt ? { servings_range: [r.loInt, r.hiInt] } : {}),
    servings_calc: {
      v: PORTION_RULES_VERSION,
      dish_type: r.dishType,
      method: r.method,
      raw: Number(r.raw.toFixed(2)),
      range: [Number(r.lo.toFixed(2)), Number(r.hi.toFixed(2))],
      ...(r.anchor ? { anchor_amount: Number(r.anchor.amount.toFixed(1)), anchor_per_person: [r.anchor.entry.lo, r.anchor.entry.hi] } : {}),
      ...(r.yield ? { yield_g: [Math.round(r.yield.lo), Math.round(r.yield.hi)], per_serving_g: [r.yield.consumed.lo, r.yield.consumed.hi] } : {}),
    },
    servings_note,
  };
}
