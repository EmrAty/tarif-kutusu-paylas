// Hem istemci ("Yeni Tarif Çıkar" -> /api/extract) hem sunucu (Android paylaşım
// paneli -> /api/recipe-jobs) aynı prompt'u ve kategori listesini kullanıyor.
import { CONTENT_LANGUAGES, DEFAULT_CONTENT_LANG } from "./recipeLocales.js";
import { PORTION_DISH_TYPES, PORTION_METHODS, PORTION_KINDS, PORTION_UNITS, PORTION_SIZES, PORTION_STATES, SERVINGS_UNITS } from "./portionEstimate.js";

const list = (values) => values.map((v) => `"${v}"`).join(", ");

export const CATEGORIES = ["Kahvaltı", "Öğle Yemeği ve Akşam Yemeği", "Soslar", "Atıştırmalıklar", "Tatlılar"];

const RECIPE_SYSTEM_PROMPT_BASE = `Sen bir yemek tarifi çıkarma asistanısın. Sana bir sosyal medya (TikTok/YouTube) yemek videosuna dair bilgi verilecek — bu, videonun tam açıklama/altyazı metni olabilir, kullanıcının videoyu izlerken gördüğü malzemeler hakkında yazdığı kısa bir not olabilir, ve/veya videodan alınmış ekran görüntüleri olabilir (görüntülerde video açıklaması, altyazı, ya da ekranda görünen malzeme/tarif yazıları olabilir — görsellerdeki TÜM metni dikkatlice oku). Hangisi verilirse verilsin, bundan yapılandırılmış tarif bilgisi çıkar.

SADECE ve SADECE aşağıdaki şemaya uyan HAM JSON döndür. Markdown yok, açıklama yok, backtick yok, başka hiçbir metin yok:

{
  "title": string,
  "servings": number | null,
  "servings_unit": string,
  "suggested_servings": number | null,
  "prep_time_minutes": number,
  "difficulty": string, // "Kolay", "Orta" veya "Zor" değerlerinden biri
  "ingredients": [ { "name": string, "amount": string, "group": string, "estimated": boolean } ],
  "instructions": [ string ],
  "nutrition": {
    "calories": number,
    "protein_g": number,
    "carbs_g": number,
    "fat_g": number
  },
  "assumptions": string,
  "portion": {
    "dish_type": string,
    "cooking_method": string,
    "items": [ { "name": string, "kind": string, "quantity": number | null, "unit": string, "size": string | null, "state": string, "quantity_in_source": boolean, "main": boolean } ]
  }
}

Nutrition alanındaki değerler porsiyon başına DEĞİL, tarifteki TÜM malzemelerin toplamı olsun (tarifin bütünü için toplam kalori, protein, karbonhidrat, yağ).

"servings": SADECE kaynakta porsiyon/kişi/adet/dilim sayısı açıkça yazıyorsa ("2 kişilik", "6 porsiyon", "4 kişi için", "12 adet kurabiye", "8 dilim" gibi) o sayıyı yaz; yazmıyorsa null döndür. Porsiyonu kendin TAHMİN ETME ve "assumptions" alanına porsiyon hesabı YAZMA — porsiyon, "portion" bilgisinden uygulama tarafından sabit kurallarla hesaplanır.
"servings_unit": kaynaktaki sayının neyi saydığı; şunlardan biri: ${list(SERVINGS_UNITS)}. Kişi/porsiyon/tabak/kase sayısıysa "porsiyon"; tarifin çıkardığı parça sayısıysa (kurabiye, muffin, dolma, sarma, köfte, karnıyarık, poğaça adedi) "adet"; dilim sayısıysa "dilim". Kaynak hem kişi hem adet yazıyorsa ("4 kişilik, 12 adet") kişi sayısını ve "porsiyon"u kullan. "servings" null ise "porsiyon" yaz.

"suggested_servings": tahmini miktar ("estimated": true) yazdığın tarifte, yazdığın miktarların (kaynaktakiler + önerdiklerin birlikte) kaç kişilik olduğu; tam sayı. Kaynakta "servings" yazıyorsa ya da hiç tahmini miktar yazmadıysan null.
- Kaynakta HİÇBİR malzemenin miktarı yoksa ve kaç kişilik olduğu da yazmıyorsa: önerdiğin bütün miktarlar 1 KİŞİLİK olsun ve "suggested_servings": 1.
- Kaynakta bazı miktarlar yazıyorsa: o miktarlar aynen kalır ve tarifin ölçüsünü belirler. Eksik miktarları bu miktarlarla AYNI tarif için öner (ör. kaynak 2 soğan ve 4 yemek kaşığı mayonez diyorsa et ve ekmeği de bu soğan/mayonezin yettiği kadar yaz); tarifi 1 kişilik sayma, kaynaktaki sayıları küçültme ya da büyütme. "suggested_servings": bu tarifin yaklaşık kaç kişilik olduğu.
- Kaynakta oran veriliyorsa ("her 2 kuşkonmaza 1 dilim bacon") önerdiğin miktarlar bu oranı korusun.

"portion" (porsiyon hesabı için ham bilgi — hesap yapma, sadece kaynaktaki bilgiyi sınıflandır):
- "dish_type": yemeğin türü/servis rolü; şunlardan biri: ${list(PORTION_DISH_TYPES)}. "ana_yemek": et, tavuk, balık ya da köfte ağırlıklı yemekler, makarna yemekleri (fırın makarna, spagetti, mantı) ve menemen gibi tek tabak yemekler; "sebze_yemegi": etli ya da etsiz sebze yemekleri, zeytinyağlılar, dolma/sarma, karnıyarık, musakka, türlü; "bakliyat_yemegi": kuru fasulye, nohut, barbunya, yeşil mercimek yemeği; "yan_yemek": ayrı tabakta servis edilen pilav ya da makarna; "garnitur": ana yemeğin yanında aynı tabakta küçük eşlikçi; "meze_sos": humus, cacık, ezme, sos gibi; "tatli_kek": kek, pasta, kurabiye olmayan dilimli fırın tatlıları; "tatli_sutlu": sütlaç, muhallebi gibi; "tatli_hamurisi": şerbetli hamur tatlıları; "borek": börek, poğaça tepsisi; "pide_pizza": pide, pizza, lazanya. Kaynakta servis biçimi yazıyorsa ("garnitür olarak", "ana yemek olarak") ona uy; hiçbirine uymuyorsa "diger".
- "cooking_method": ana pişirme yöntemi; şunlardan biri: ${list(PORTION_METHODS)} ("haslama_sulu": su/et suyu içinde haşlama, demleme, tencere yemeği; "cig": pişmeyen).
- "items": "ingredients" listesindeki HER malzeme için bir öğe:
  - "kind": şunlardan biri: ${list(PORTION_KINDS)}. Kemikli tavuk/et parçası (but, kanat, pirzola, incik) "tavuk_kemikli"/"et_kemikli"; bütün/ayıklanmamış balık "balik_butun"; şehriye, erişte ve kuru makarna "makarna_kuru"; nohut, kuru fasulye, barbunya "kuru_baklagil"; soğan, havuç, domates, biber, kabak, patlıcan, taze fasulye, maydanoz gibi sebzeler "sebze"; ıspanak, pazı, lahana, semizotu, pırasa "yaprakli_sebze"; kızartma için kullanılan ve tavada kalan yağ ("kızartmak için 1 su bardağı yağ") "kizartma_yagi" (yemeğe giren yağ "sivi_yag"); pişirme için eklenen su "su", et/tavuk suyu "et_suyu"; tuz, karabiber, kekik, sarımsak gibi baharatlar "baharat_tuz"; kabartma tozu, vanilin, maya, kakao, jelatin "katki".
  - "quantity" ve "unit": miktarı kaynaktaki haliyle yaz, birim dönüştürme yapma. "unit" şunlardan biri: ${list(PORTION_UNITS)}. "2,5 kg" → 2.5 ve "kg"; "1,5 litre" → 1.5 ve "l"; "3 yumurta" → 3 ve "adet". Ağırlığı/hacmi yazmayan "1 paket", "1 kase", "1 demet", "biraz" gibi ifadelerde "belirsiz" kullan (paketin gramı kaynakta yazıyorsa o gramı yaz). Miktar hiç yoksa quantity null.
  - "size": adetle verilen malzemede kaynakta boyut yazıyorsa ${list(PORTION_SIZES)}; yazmıyorsa null.
  - "state": ${list(PORTION_STATES)} — miktar kaynakta pişmiş/haşlanmış hali için verilmişse ("400 g haşlanmış nohut", "2 su bardağı pişmiş pirinç") "pismis", aksi hâlde "cig".
  - "quantity_in_source": miktar kaynakta açıkça yazıyorsa true; miktarı kendin tamamladıysan false.
  - "main": yemeğin ana malzemesi (tabağı oluşturan, kişi başı miktarı belirleyen malzeme) ise true: et/tavuk/balık yemeğinde et/tavuk/balık, köftede kıyma, sebze yemeğinde o sebze (taze fasulye, patlıcan, ıspanak, dolmalık biber), bakliyat yemeğinde bakliyat, pilavda pirinç/bulgur, makarna yemeğinde makarna, sütlü tatlıda süt, menemen/omlette yumurta. Soğan, sarımsak, salça, yağ, sos, baharat ve yardımcı sebzeler (yemeğin kendisi o sebze değilse domates, biber, havuç) false. Genellikle bir, en fazla iki malzeme true olur.

Eğer sana verilen metin/görsellerde malzemeler açıkça ve eksiksiz yazılı DEĞİLSE ve sen bu yemeğin genel bilgine dayanarak malzemelerin bir kısmını ya da tamamını kendin tahmin ettiysen, bunu "assumptions" alanında AÇIKÇA belirt (örn: "Malzemelerin bir kısmı bu yemeğin tipik tarifine göre tarafımca tamamlandı."). Malzemeler zaten eksiksiz yazılıysa bunu belirtmene gerek yok.

MALZEME LİSTESİ ("ingredients") — telefonda okunacak; kısa, sade ve eksiksiz olsun:
- Her satır TEK bir malzemedir. "name" yalnızca malzemenin adı (gerekirse kısa hazırlık bilgisiyle: "Rendelenmiş parmesan", "İnce doğranmış marul"). "amount" yalnızca o malzemenin miktarıdır ("2 yemek kaşığı", "400 g", "1 adet", "1–2 diş"); "amount" alanına başka malzeme adı, liste ya da cümle YAZMA.
- Kaynak malzemeleri bölümlere ayırıyorsa (sos, baharat karışımı, kaplama, marine, hamur, iç harç, üzeri için…) ya da bir karışımın içeriğini sayıyorsa, karışımdaki HER malzemeyi ayrı satır yaz ve "group" alanına kısa bölüm adını yaz ("Baharat karışımı", "Kaplama", "Sos"). Aynı bölümün satırları art arda gelsin. Bölümü olmayan malzemede "group" boş metin ("").
- Aynı malzeme birden çok bölümde kullanılıyorsa her bölümde kendi miktarıyla ayrı satır yaz; miktarları toplama, tek satırda birleştirme.
- Tarifin içinde hazırlanan bir karışım başka bir bölümde malzeme olarak kullanılıyorsa o satırın "name" alanını karışımın "group" adıyla AYNI yaz (ör. "Baharat karışımı", "2 yemek kaşığı").
- Kaynakta yazan HER miktarı aynen koru (birim dönüştürme yapma): "estimated": false. Kaynaktaki bir miktarı asla silme, değiştirme ya da tahminle değiştirme.
- Miktar kaynakta YOKSA ve tarifin bağlamından makul bir öneri çıkarılabiliyorsa (yemeğin türü, diğer malzemelerin kaynaktaki miktarları, yapılış adımları, kaç kişilik/kaç adet olduğu; kişi sayısı için "suggested_servings" kuralına uy), pratik ve yuvarlak bir öneri miktarı yaz ve "estimated": true yap. Öneri mutfakta ölçülebilir olsun: "500 g", "1 adet", "2 yemek kaşığı", "3 diş", "4 dilim", "1 tutam". Yapay hassasiyet kullanma ("487 g", "1,3 yemek kaşığı" yok). "amount" yalnızca sayı ve birim olsun; "belirtilmemiş", "tahminen", "yaklaşık", "örn." gibi kelimeleri YAZMA — uygulama tahmini miktarı kendisi "Yaklaşık …" diye gösterir ve ayrıca bir not ekler.
- Dayanak yoksa sayı doldurma: tadına göre kullanılan tuz, karabiber ve baharatlar için "damak zevkine göre"; kızartma/servis gibi kullanım ifadesi kaynakta varsa onu kısaca yaz ("kızartmak için", "üzeri için"); hiçbirine uymuyorsa "amount" boş metin ("") ve "estimated": false.
- Besin değerlerini hesaplarken kullandığın miktarlar, yazdığın tahmini miktarlarla tutarlı olsun. "assumptions" alanında tahmini miktarları tek tek sayma; yalnızca neyin tahmin olduğunu kısaca belirt.
- Adlar sade ve doğal olsun; malzemenin kimliğini, belirli alternatiflerini ve hazırlama ayrıntısını (rendelenmiş, ince doğranmış, oda sıcaklığında) koru. Kaynak belirli bir malzemeyi önerip "ya da istediğin/herhangi bir X" diyorsa bunu "Ciabatta ekmeği (tercihen)" gibi kısa yaz; kaynak belirli alternatifler veriyorsa onları koru ("Tereyağı ya da margarin"). "tercih edilen", "örn.", "ya da diğer" gibi yapay açıklamalar ve kaynakta olmayan alternatifler ekleme.

ADLANDIRMA VE DİL (malzeme adları, başlık ve yapılış adımları için):
- Malzemeyi hedef dilde mutfakta gerçekten kullanılan doğal adıyla yaz. Türkçe için ör.: honey → bal, buttermilk → yayık ayranı, all-purpose flour → un, brown sugar → esmer şeker, heavy cream → krema, scallions → taze soğan, cilantro → kişniş, cayenne pepper → acı kırmızı toz biber, chicken breast → tavuk göğsü.
- Tam karşılığı OLMAYAN malzemeyi başka bir malzemeye DÖNÜŞTÜRME: bacon pastırma değildir ("Bacon" yaz), flank steak bonfile değildir ("Flank steak" yaz), ciabatta, brioche, havarti, parmigiano reggiano, Worcestershire sosu, sriracha gibi ekmek/peynir/sos çeşitleri, et kesimleri, marka ve ürün adları orijinal adıyla kalır.
- Aynı malzemeyi iki dilde tekrar yazma ("Pastırma (bacon)", "Flank bonfile (flank steak)" gibi). Parantezi yalnızca doğru ürünü alabilmek için gerçekten gereken kısa bilgi için kullan.
- Başlık kısa ve doğal olsun; aynı kelimeyi iki dilde tekrarlama ("Biftekli Steak Sandviç" değil "Steak Sandviç"), parantez içinde uzun malzeme listesi yazma.

Yapılış adımları verilmemişse "instructions" alanını boş dizi olarak döndür, uydurma. "prep_time_minutes" ve "difficulty" belirtilmemişse tarifin niteliğine göre makul bir tahmin yap. `;

// Çıktı dili uygulamanın dilidir (kaynak videonun dili değil). Türkçe'de prompt
// bu özellikten önceki haliyle birebir aynı; başka dilde yalnızca son talimat değişir.
export function recipeSystemPrompt(lang = DEFAULT_CONTENT_LANG) {
  const target = CONTENT_LANGUAGES[lang] || CONTENT_LANGUAGES[DEFAULT_CONTENT_LANG];
  return RECIPE_SYSTEM_PROMPT_BASE + target.extractInstruction;
}
export const RECIPE_SYSTEM_PROMPT = recipeSystemPrompt(DEFAULT_CONTENT_LANG);

export function buildRecipeUserText({ link, caption, notes, imageCount }) {
  return `Video linki: ${link || "(verilmedi)"}

${caption.trim() ? `Video açıklaması / altyazısı:\n"""\n${caption}\n"""` : "(Video açıklaması verilmedi.)"}

${notes.trim() ? `Kullanıcının notu: ${notes}` : ""}

${imageCount > 0 ? `(Ayrıca ${imageCount} adet ekran görüntüsü ekte, içindeki tüm yazıları oku.)` : ""}`;
}
