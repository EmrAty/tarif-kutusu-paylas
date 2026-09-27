// Hem istemci ("Yeni Tarif Çıkar" -> /api/extract) hem sunucu (Android paylaşım
// paneli -> /api/recipe-jobs) aynı prompt'u ve kategori listesini kullanıyor.
import { CONTENT_LANGUAGES, DEFAULT_CONTENT_LANG } from "./recipeLocales.js";
import { PORTION_DISH_TYPES, PORTION_METHODS, PORTION_KINDS, PORTION_UNITS, PORTION_SIZES, PORTION_STATES } from "./portionEstimate.js";

const list = (values) => values.map((v) => `"${v}"`).join(", ");

export const CATEGORIES = ["Kahvaltı", "Öğle Yemeği ve Akşam Yemeği", "Soslar", "Atıştırmalıklar", "Tatlılar"];

const RECIPE_SYSTEM_PROMPT_BASE = `Sen bir yemek tarifi çıkarma asistanısın. Sana bir sosyal medya (TikTok/YouTube) yemek videosuna dair bilgi verilecek — bu, videonun tam açıklama/altyazı metni olabilir, kullanıcının videoyu izlerken gördüğü malzemeler hakkında yazdığı kısa bir not olabilir, ve/veya videodan alınmış ekran görüntüleri olabilir (görüntülerde video açıklaması, altyazı, ya da ekranda görünen malzeme/tarif yazıları olabilir — görsellerdeki TÜM metni dikkatlice oku). Hangisi verilirse verilsin, bundan yapılandırılmış tarif bilgisi çıkar.

SADECE ve SADECE aşağıdaki şemaya uyan HAM JSON döndür. Markdown yok, açıklama yok, backtick yok, başka hiçbir metin yok:

{
  "title": string,
  "servings": number | null,
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
  "assumptions": string,
  "portion": {
    "dish_type": string,
    "cooking_method": string,
    "items": [ { "name": string, "kind": string, "quantity": number | null, "unit": string, "size": string | null, "state": string, "quantity_in_source": boolean } ]
  }
}

Nutrition alanındaki değerler porsiyon başına DEĞİL, tarifteki TÜM malzemelerin toplamı olsun (tarifin bütünü için toplam kalori, protein, karbonhidrat, yağ).

"servings": SADECE kaynakta porsiyon/kişi sayısı açıkça yazıyorsa ("2 kişilik", "6 porsiyon", "4 kişi için" gibi) o sayıyı yaz; yazmıyorsa null döndür. Porsiyonu kendin TAHMİN ETME ve "assumptions" alanına porsiyon hesabı YAZMA — porsiyon, "portion" bilgisinden uygulama tarafından sabit kurallarla hesaplanır.

"portion" (porsiyon hesabı için ham bilgi — hesap yapma, sadece kaynaktaki bilgiyi sınıflandır):
- "dish_type": yemeğin servis rolü; şunlardan biri: ${list(PORTION_DISH_TYPES)}. "ana_yemek": tabağın ana yemeği (etli/tavuklu/balıklı, sebzeli, bakliyat yemekleri, menemen gibi tek tabak yemekler); "yan_yemek": ayrı tabakta servis edilen pilav, makarna, zeytinyağlı; "garnitur": ana yemeğin yanında aynı tabakta küçük eşlikçi; "meze_sos": humus, cacık, ezme, sos gibi; "tatli_kek": kek, pasta, kurabiye olmayan dilimli fırın tatlıları; "tatli_sutlu": sütlaç, muhallebi gibi; "tatli_hamurisi": şerbetli hamur tatlıları; "borek": börek, poğaça tepsisi; "pide_pizza": pide, pizza, lazanya. Kaynakta servis biçimi yazıyorsa ("garnitür olarak", "ana yemek olarak") ona uy; hiçbirine uymuyorsa "diger".
- "cooking_method": ana pişirme yöntemi; şunlardan biri: ${list(PORTION_METHODS)} ("haslama_sulu": su/et suyu içinde haşlama, demleme, tencere yemeği; "cig": pişmeyen).
- "items": "ingredients" listesindeki HER malzeme için bir öğe:
  - "kind": şunlardan biri: ${list(PORTION_KINDS)}. Kemikli tavuk/et parçası (but, kanat, pirzola, incik) "tavuk_kemikli"/"et_kemikli"; bütün/ayıklanmamış balık "balik_butun"; şehriye, erişte ve kuru makarna "makarna_kuru"; nohut, kuru fasulye, barbunya "kuru_baklagil"; soğan, havuç, domates, biber, kabak, patlıcan, maydanoz gibi sebzeler "sebze"; pişirme için eklenen su "su", et/tavuk suyu "et_suyu"; tuz, karabiber, kekik, sarımsak gibi baharatlar "baharat_tuz"; kabartma tozu, vanilin, maya, kakao, jelatin "katki".
  - "quantity" ve "unit": miktarı kaynaktaki haliyle yaz, birim dönüştürme yapma. "unit" şunlardan biri: ${list(PORTION_UNITS)}. "2,5 kg" → 2.5 ve "kg"; "1,5 litre" → 1.5 ve "l"; "3 yumurta" → 3 ve "adet". Ağırlığı/hacmi yazmayan "1 paket", "1 kase", "1 demet", "biraz" gibi ifadelerde "belirsiz" kullan (paketin gramı kaynakta yazıyorsa o gramı yaz). Miktar hiç yoksa quantity null.
  - "size": adetle verilen malzemede kaynakta boyut yazıyorsa ${list(PORTION_SIZES)}; yazmıyorsa null.
  - "state": ${list(PORTION_STATES)} — miktar kaynakta pişmiş/haşlanmış hali için verilmişse ("400 g haşlanmış nohut", "2 su bardağı pişmiş pirinç") "pismis", aksi hâlde "cig".
  - "quantity_in_source": miktar kaynakta açıkça yazıyorsa true; miktarı kendin tamamladıysan false.

Eğer sana verilen metin/görsellerde malzemeler açıkça ve eksiksiz yazılı DEĞİLSE ve sen bu yemeğin genel bilgine dayanarak malzemelerin bir kısmını ya da tamamını kendin tahmin ettiysen, bunu "assumptions" alanında AÇIKÇA belirt (örn: "Malzemelerin bir kısmı bu yemeğin tipik tarifine göre tarafımca tamamlandı."). Malzemeler zaten eksiksiz yazılıysa bunu belirtmene gerek yok.

Miktarlar net değilse o yemeğin tipik bir porsiyonuna göre makul tahminler yap ve bunu "assumptions" alanında belirt. Yapılış adımları verilmemişse "instructions" alanını boş dizi olarak döndür, uydurma. "prep_time_minutes" ve "difficulty" belirtilmemişse tarifin niteliğine göre makul bir tahmin yap. `;

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
