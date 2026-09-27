# Porsiyon hesabı — kurallar ve kaynaklar

Kural sürümü: `2026-09-27.1` (`app/shared/portionEstimate.js` → `PORTION_RULES_VERSION`).
Bu kurallar genel bir **tarif verimi tahmini** içindir; kişiye özel diyet ya da tıbbi beslenme önerisi değildir.

## Nasıl çalışıyor

1. **AI çıkarır, hesap yapmaz.** Prompt (`app/shared/recipeExtraction.js`) AI'dan şunları ister:
   - `servings`: yalnızca kaynakta açıkça yazan porsiyon ("2 kişilik"). Yoksa `null`.
   - `portion.dish_type`: servis rolü (ana yemek, çorba, yan yemek, garnitür, salata, meze/sos, kek, sütlü tatlı, hamurişi tatlı, börek, pide/pizza, diğer).
   - `portion.cooking_method`: haşlama/sulu, fırın, tava/ızgara, kızartma, çiğ.
   - `portion.items[]`: her malzeme için tür (`kind`), kaynaktaki miktar ve birim (dönüştürmeden), boyut, çiğ/pişmiş durumu ve miktarın kaynakta yazıp yazmadığı.
2. **Kod hesaplar** (`app/shared/portionEstimate.js`, hem `src/App.jsx` hem `api/_lib/extractRecipe.js` aynı `applyPortionEstimate` fonksiyonunu çağırır):
   1. Birim → gram: kütle doğrudan; hacim × yoğunluk (FAO/INFOODS); adet × USDA adet ağırlığı.
   2. Verim: yemek türüne göre üç moddan biri (aşağıda).
   3. `porsiyon = verim ÷ kişi başı referans`; tam sayıya yuvarlama **yalnızca en son adımda**.
3. **Öncelik:** kaynaktaki porsiyon (`servings_basis: "kaynak"`) > hesap (`"hesap"`) > bilinmiyor (`"bilinmiyor"`, `servings: null`).
4. Hesabın gerekçesi `assumptions`'a karıştırılmaz, ayrı `servings_note` alanına yazılır (Tarif Detay'da ayrı kutuda görünür; hesaplanan porsiyon "Tahmini N porsiyon" olarak gösterilir). Kullanıcının gördüğü gerekçe, uygulanan hesapla birebir aynı sayılardan üretilir. Kullanıcı Tarifi Düzenle'den porsiyonu değiştirirse `servings_basis: "kullanici"` olur, `servings_calc` ve `servings_note` silinir. `servings_calc` alanı sürümü, verimi, kişi başı referansı ve yuvarlanmamış değeri saklar. AI'ın ham `portion` alanı kayda yazılmaz.

Tüm katsayılar çarpımsaldır. Bu nedenle aynı normalize girdi her zaman aynı sonucu verir. Malzemeler k katına çıktığında yuvarlanmamış porsiyon da tam k katına çıkar (`npm test` bunu doğrular).

### Verim modları

| Mod | Hangi yemekler | Hesap |
|---|---|---|
| Bileşen | ana yemek, yan yemek, garnitür, salata, meze/sos, hamurişi tatlı | Σ (çiğ g × malzeme katsayısı). Pişirme suyu ve et suyu **eklenmez** (katsayı 0); kuru gıdaların katsayısı çektikleri suyu zaten içerir. |
| Kütle dengesi | çorba, sütlü tatlı | Σ tüm malzemeler (su/süt dahil, kuru gıdalar çiğ ağırlıkla; kemik payı düşülür) × kalan oran. Kuru gıdaya ayrıca katsayı uygulanmaz, böylece aynı su iki kez sayılmaz. |
| Hamur | kek, börek, pide/pizza | Σ tüm hamur/iç malzemesi × fırın katsayısı. |

## Referans tabloları

### Kişi başı referans (pişmiş, yenebilir g)

| Servis rolü | g | Kaynak ve gerekçe |
|---|---|---|
| ana yemek | 200 | Sabancı Ek-2: parça et, sebzeli et, etli bakliyat, köfte, tavuk ve fileto yemeklerinin hepsinde "toplam porsiyon ağırlığı" 200 g. Kemikli tavuk için 250 g yazıyor ama bu kemik dahil; yenebilir kısmı yaklaşık 200 g'a denk düşüyor. |
| çorba | 200 | Sabancı Ek-2: çorba 200 g. TÜBER: çorbanın standart porsiyonu ¾ kupa (180 mL), çorba kasesi 240 mL. |
| yan yemek (ayrı tabak) | 170 | Sabancı: pilavlar/makarnalar ve zeytinyağlılar 170 g. TÜBER: ana yemekten sonra ikinci kap olarak servis edilen pilav = 2 standart porsiyon (≈180–220 g); pişmiş sebze 150 g. |
| garnitür (aynı tabak) | 100 | TÜBER: pirinç/bulgur pilavı 1 standart porsiyon = 90–110 g ("garnitür porsiyonu"). Makarna garnitürü 75 g; bu fark modellenmedi. |
| salata | 150 | TÜBER: çiğ sebze/salata 1 standart porsiyon = 150 g (yeşil yapraklılar 75 g; bu fark modellenmedi). |
| meze/sos | 80 | Sabancı: garnitür yoğurt 80 g. **En zayıf dayanak:** meze için doğrudan bir kaynak bulunamadı. |
| kek/pasta | 100 | Sabancı: "özel tatlılar (pastalar dahil)" 100 g. |
| sütlü tatlı | 130 | Sabancı: sütlü tatlılar 130 g. |
| hamurişi tatlı | 170 | Sabancı: hamurişi tatlılar 170 g. |
| börek | 140 | Sabancı: börek 140 g (milföy 100 g ayrılmadı). |
| pide/pizza | 250 | Sabancı: pizza, krep, lazanya, pide 250 g. |
| diğer | — | Referans yok; porsiyon hesaplanmaz. |

Notlar:
- TÜBER'in "standart porsiyonları" besin grubu eşdeğerleridir ve öğün porsiyonu değildir. Örneğin et için 80 g pişmiş et 150–200 kcal eşdeğeridir. Bu yüzden ana yemek referansı kurum menülerindeki servis ağırlığından alındı; TÜBER yalnızca rehberin kendisinin servis miktarıyla eşleştirdiği yerlerde kullanıldı (garnitür pilav, ikinci kap, pişmiş sebze, çorba kasesi).
- Sabancı listesi "asgari" (minimum) değerler içerir. Ev porsiyonları bundan büyük olabilir.
- MSB 2017–2018 teknik şartnamesi kişi başı çiğ girdileri veriyor (ör. pilavda 70 g pirinç, garnitürde 50 g, kemikli tavukta 250 g, kırmızı mercimek çorbasında 35 g). Bu liste askerî beslenme içindir ve porsiyonları büyüktür; yalnızca çapraz kontrol için kullanıldı, hesapta kullanılmadı.

### Pişme / yenebilir verim katsayıları (pişmiş yenebilir g ÷ çiğ g)

| Malzeme | Katsayı | Kaynak |
|---|---|---|
| kemikli tavuk/et | 0,49 | TÜBER: %30 kemik + %30 pişme kaybı (0,7×0,7); 165 g çiğ kemikli et ≈ 80 g pişmiş. Bognár: tavuk budu tavada, yenebilir 0,48 (n=6). |
| kemiksiz tavuk/et | 0,70 | TÜBER: yaklaşık %30 pişme kaybı. USDA (AH-102 verisi): tavuk budu fırında %69 (58–79). |
| kıyma — tava/ızgara/fırın | 0,81 | Bognár: köfte/burger tavada 0,81 (n=10). |
| kıyma — sulu | 0,70 | TÜBER: 115 g çiğ kıyma ≈ 80 g pişmiş. |
| bütün balık | 0,55 | TÜBER: 250–300 g ayıklanmamış çiğ ≈ 150 g pişmiş. Bognár: bütün morina, yenebilir 0,51–0,57. |
| balık fileto | 0,80 | Bognár: fileto kızartma 0,80 (n=10). |
| pirinç | 2,98 | Bognár: uzun taneli pirinç haşlama 2,98 (n=140), pişirme suyu hariç. |
| bulgur | 3,58 | **Türetilmiş değer.** TÜBER'e göre 25 g bulgur ile 30 g pirinç aynı pişmiş porsiyonu veriyor (2,98 × 30/25). |
| kuru makarna/şehriye/erişte | 2,10 | Bognár: yumurtasız makarna haşlama 2,10 (n=4). |
| kuru fasulye/nohut | 2,50 | Bognár: fasulye haşlama/yemek 2,50 (n=10). Nohut için ayrı veri yok. |
| mercimek | 2,73 | Bognár: mercimek 2,73 (n=6). |
| patates — haşlama | 1,00 | Bognár: soyulmuş haşlanmış patates 1,00 (n=272). |
| patates — fırın/tava | 0,77 | Bognár: fırın patates 0,77 (n=3). |
| patates — kızartma | 0,54 | Bognár: patates kızartması 0,54 (n=13). |
| sebze — haşlama/sulu | 0,93 | Bognár: havuç 0,94 (n=103), taze fasulye 0,93 (n=120). |
| sebze — fırın/tava | 0,80 | **Yaklaşık.** Bognár: soğan 0,83; biber ve kabak yahnisi 0,73–0,74. |
| pişmiş verilen kemikli et | 0,75 | Bognár: yenebilir ÷ kemikli pişmiş = 0,48 / 0,64. |
| diğer (yağ, süt ürünü, un, şeker, yumurta, sos) | 1,00 | Ağırlık korunur varsayımı. |
| su, et suyu | 0 | Bognár: pişirme suyu tarife dahil edilmez, çünkü buharlaşma öngörülemez. |
| çorba kalan oran | 0,90 | **Uygulamanın kendi varsayımı, kaynağı yok.** Bognár'a göre buharlaşma kaba, süre ve kapağa bağlı ve öngörülemez. |
| sütlü tatlı kalan oran | 0,91 | Bognár: sütlaç 0,91 (n=3). |
| kek | 0,92 | Bognár: mermer kek 0,92. |
| börek, pide/pizza | 0,90 | Bognár: ekmek 0,90 (vekil değer). |

### Ölçü → gram

- **Hacim (mL):** su bardağı 200, çay bardağı 100 (yemek.com, 30 Eylül 2025; ikincil kaynak), yemek kaşığı 15, çay kaşığı 5 (FAO/INFOODS dönüşüm kılavuzu), tatlı kaşığı 10 (**kaynak açılmadı, uygulamanın kabulü**).
  - TÜBER'e göre Türkiye'de satılan su bardakları 200–560 mL, yemek kaşıkları 10–15 mL arasında değişiyor. Bu ölçüler standart değildir.
- **Yoğunluk (g/mL), FAO/INFOODS Density DB v2.0:**
  - su 1,00; süt 1,03; yoğurt 1,03; krema 1,00; sıvı yağ 0,92; tereyağı 0,91; toz şeker 0,88; pirinç 0,82; irmik 0,78; patates 0,59; kuru makarna 0,39.
  - un 0,58: veritabanındaki 5 buğday unu değerinin ortancası (değerler 0,48–0,67 arasında).
  - **Vekil değerler:** mercimek 0,89 (yeşil mercimek), kuru fasulye/nohut 0,75 (kuru barbunya), bulgur 0,77 (buğday tanesi), doğranmış sebze 0,55.
  - sos/salça 1,00: kaynak yok.
  - Karşılaştırma (yemek.com): 1 su bardağı un 120 g (bizde 116), pirinç 160 g (164), şeker 160 g (176).
- **Adet (g), USDA FoodData Central SR Legacy, yenebilir kısım:**
  - patates 170 / 213 / 369 (FDC 170026); soğan 70 / 110 / 150 (170000); havuç 50 / 61 / 72 (170393); domates 91 / 123 / 182 (170457); yumurta 38 / 44 / 50, kabuksuz (171287).
  - Boyut yazmıyorsa **orta** kabul edilir ve gerekçeye not düşülür.
  - Bunlar ABD ölçüleridir. Türk Gıda Kodeksi'ne göre M boy yumurta kabuklu 53–63 g'dır (TÜBER'den), bu da USDA medium'dan biraz büyük.
  - Tabloda olmayan adetler ("4 tavuk but", "1 limon", "1 diş sarımsak") gram almaz; hesap dışı kalır ve listelenir.

### Bilgi yetersizliği kuralları

- `unit: "belirsiz"` ("1 paket", "1 kase", "biraz"), yoğunluğu bilinmeyen hacim ve ağırlığı bilinmeyen adet **sessizce grama çevrilmez**. Gerekçede "hesaba katılamayanlar" olarak listelenir.
- Porsiyonu belirleyen bir ana malzemenin miktarı çözülemezse porsiyon hesaplanmaz. Ana malzemeler: et, tavuk, kıyma, balık, pirinç, bulgur, makarna, kuru baklagil, mercimek, patates; hamur modunda un da buna dahil.
- Miktarı kaynakta yazmayıp AI'ın tamamladığı malzemeler hesaba girmez. Bunların verimdeki payı %25'i aşarsa porsiyon hesaplanmaz.
- Baharat, tuz ve katkı maddeleri (kabartma tozu, vanilin, kakao…) ihmal edilir.

## Bilinen sınırlar

- **AI tarafı deterministik değildir.** Yemek türü, servis rolü, pişirme yöntemi ve malzeme türü sınıflandırması denemeden denemeye değişebilir. Örneğin pilav "garnitür" (100 g) ya da "yan yemek" (170 g) olarak sınıflanabilir; bu fark sonucu 1,7 kat değiştirir. Deterministik olan yalnızca aynı normalize girdiden sonrasıdır.
- **Sulu ana yemeklerde sos payı eksik kalır.** Tas kebabı gibi yemeklerde eklenen su verime sayılmaz, bu yüzden verim düşük tahmin edilebilir.
- **Çok bileşenli yemekler** (ör. ana yemek + içindeki garnitür) tek bir kişi başı referansla bölünür; bileşenlerin ayrı porsiyonları toplanmaz.
- **Mercimek çorbası gibi çok sulu tariflerde** porsiyon sayısı eklenen suyla büyür. Bu fiziksel olarak doğrudur (daha fazla çorba), ama kıvam farkı modellenmez.
- **Kapsam dışı ya da zayıf kalan konular:**
  - Adetle servis edilen yiyecekler (kurabiye, köfte adedi, dolma/sarma adedi): referans yok, "diğer" olarak hesaplanmaz.
  - Kahvaltılıklar, içecekler.
  - Meze referansı zayıf.
  - Tahin gibi yoğunluğu veritabanında olmayan malzemeler hesap dışı kalır.
  - Nohut, bulgur ve kırmızı mercimek için doğrudan ölçüm yok; vekil değerler kullanıldı.
- **Doğrulanamayan kaynak:** FDA 21 CFR 101.12 (RACC) tabloları incelendi, ancak PDF'ten değerler güvenilir biçimde okunamadı. Hesapta kullanılmadı.
- **Kullanıcı düzenlemesi:** Kullanıcı Tarifi Düzenle'den porsiyonu değiştirirse `assumptions` içindeki eski hesap metni olduğu gibi kalır.

## Kaynaklar

1. T.C. Sağlık Bakanlığı HSGM — *Türkiye Beslenme Rehberi (TÜBER) 2022*, Bölüm 10.2 (s. 228–232): standart ölçü araçları, kemik/pişme kaybı, standart porsiyonlar, garnitür ve ikinci kap. https://hsgm.saglik.gov.tr/depo/birimler/saglikli-beslenme-ve-hareketli-hayat-db/Dokumanlar/Rehberler/Turkiye_Beslenme_Rehber_TUBER_2022_min.pdf
2. Sabancı Üniversitesi Satınalma — *Ek-2 Asgari Yemek Porsiyon Gramajları* (tarih belirtilmemiş). https://mysu.sabanciuniv.edu/purchasing/sites/mysu.sabanciuniv.edu.purchasing/files/ek_a_ek-2_asgari_yemek_porsiyon_gramajlari_2.pdf
3. MSB — *Yemek 2017–2018 Teknik Şartname Ekleri, Ek 1-a* (kişi başı çiğ girdi gramajları; yalnızca çapraz kontrol). https://ms.hmb.gov.tr/uploads/2019/02/yemek2017-2018tekniksartnameekleri.pdf
4. Bognár, A. (2002) — *Tables on weight yield of food and retention factors of food constituents for the calculation of nutrient composition of cooked foods (dishes)*, BFE-R-02-03, Bundesforschungsanstalt für Ernährung, Karlsruhe. https://www.fao.org/uploads/media/bognar_bfe-r-02-03.pdf
5. USDA ARS — *USDA Table of Cooking Yields for Meat and Poultry* (Release 1 tablosu: tavuk budu fırında %69, 58–79). https://www.ars.usda.gov/ARSUserFiles/80400525/data/retn/usda_cookingyields_meatpoultry.pdf ; Release 2 (2014) yöntem açıklaması: https://www.ars.usda.gov/ARSUserFiles/80400535/Data/retn/USDA_CookingYields_MeatPoultry02.pdf
6. FAO/INFOODS — *Density Database Version 2.0* (2012). https://www.fao.org/fileadmin/templates/food_composition/documents/density_DB_v2_0_final-1__1_.xlsx
7. FAO/INFOODS — *Guidelines for Converting Units, Denominators and Expressions*, v1.0 (2012): hacim × yoğunluk, 1 tbsp = 15 mL, 1 tsp = 5 mL, yenebilir kısım. https://www.fao.org/fileadmin/templates/food_composition/documents/1nutrition/Conversion_Guidelines-V1.0.pdf
8. USDA FoodData Central (SR Legacy) porsiyon ağırlıkları: FDC 170026, 170000, 170393, 170457, 171287. https://fdc.nal.usda.gov/
9. yemek.com — *Bardak Ölçüleri: Su Bardağı, Çay Bardağı ve Gram Karşılıkları* (30 Eylül 2025; ikincil kaynak). https://yemek.com/bardak-olculeri/
