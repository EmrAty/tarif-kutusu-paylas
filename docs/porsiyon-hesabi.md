# Porsiyon hesabı — araştırma, kurallar ve kaynaklar

Kural sürümü: **`2026-09-28.1`** (`app/shared/portionEstimate.js` → `PORTION_RULES_VERSION`). Önceki sürüm `2026-09-27.3`.

Bu hesap bir **tarif verimi tahminidir**. Kişiye özel diyet ya da tıbbi beslenme önerisi değildir. Bir öğünde ne kadar yenildiği kişiye, yaşa, cinsiyete, iştaha ve öğünün geri kalanına göre değişir. Bu yüzden hiçbir kural her kişi için %100 doğru porsiyon veremez. Uygulama bunu gizlemez: kesin bilinen (kaynakta yazan) sayıyı ayrı tutar, hesapladığı sayıyı "Tahmini" olarak gösterir ve makul bir aralık verir. Hesaplanamayan tarifte sayı üretmez.

---

## 1. Sonuç özeti

- **Eski hesap porsiyonu sistematik olarak fazla gösteriyordu.** Porsiyonu kaynakta yazan 23 yemek.com tarifinde eski hesabın medyan sapması **%67** idi. Örnekler: mercimek çorbası 10 (kaynak 6), sütlaç 13 (6), İzmir köfte 9 (4), zeytinyağlı taze fasulye 11 (4). Yeni hesapta medyan sapma **%25**. Kaynaktaki sayıya ±1 yakınlık 8/29'dan 15/29'a çıktı. Kaynaktaki sayı, hesaplanan aralığın içinde 17/29 tarifte.
- **Başlıca nedenler (§3):**
  - Kurumların "asgari" (en az) porsiyonları ev porsiyonu gibi kullanılmıştı.
  - Kızartma yağı yemeğin ağırlığına ekleniyordu.
  - Pilavda verim, pirinç ile suyun toplamını aşıyordu (fiziksel olarak imkânsız).
  - Çorbada sabit ve kaynaksız bir buharlaşma oranı kullanılıyordu.
  - "8 dilim" ya da "10 adet" kişi sayısı sanılıyordu.
- **Yeni model iki bağımsız yöntemle aralık hesaplar (§4):**
  - **A — ana malzeme:** Türk kurum şartnamelerindeki kişi başı çiğ miktar.
  - **B — toplam verim:** Pişmiş yemek ağırlığı, gözlenen tüketime göre bölünür.
  - İki yöntemin aralıkları örtüşüyorsa kesişim alınır. Tek sayı, aralığın ortasıdır.

## 2. Porsiyon kavramları (birbirine karıştırılmamalı)

| Kavram | Ne anlatır | Örnek | Bu hesapta kullanımı |
|---|---|---|---|
| **Beslenme standart porsiyonu** | Besin grubu eşdeğeri; enerji ve besin ögesi açısından denk miktar | TÜBER: 30 g çiğ pirinç, 100 g çiğ et, 2 yumurta = 1 standart porsiyon | Öğün porsiyonu olarak **kullanılmaz**. Yalnızca TÜBER'in servis miktarıyla eşlediği yerlerde kullanılır: garnitür = 1 standart porsiyon, ikinci kap pilav = 2 standart porsiyon. |
| **Etiket porsiyonu** | Paket üzerindeki beyan (ABD'de RACC, AB'de üretici beyanı) | 21 CFR 101.12 | Kullanılmaz. |
| **Önerilen porsiyon** | Sağlıklı beslenme hedefi | Eldridge 2025 "Global Portion Values": pişmiş pirinç 140 g, çorba 250 mL | Yalnızca çapraz kontrol için; aralık sınırı değildir. |
| **Kurumsal planlı porsiyon** | Toplu beslenmede kişi başı çiğ girdi ya da en az servis ağırlığı | MSB: pilavda 70 g pirinç; Sabancı: ana yemek en az 200 g | **A yöntemi** (çiğ girdi) ve **B'nin alt ucu** (servis ağırlığı). Çok kaplı menü için planlanmıştır. |
| **Gözlenen tüketim** | İnsanların bir öğünde gerçekten yediği miktar (anket, öğün başı medyan) | NNPAS 2011-12: çorba kadın 333 g, erkek 420 g | **B'nin diğer ucu.** |
| **Tarif yazarı beyanı** | "4 kişilik" | yemek.com | Hesapta kullanılmaz. Kaynakta yazıyorsa aynen korunur. Doğrulamada karşılaştırma olarak kullanılır (§6). |

## 3. Eski hesaptaki (2026-09-27.3) hatalar — somut örnekler

Aşağıdaki sayılar, `app/scripts/portion-validation.mjs` doğrulama setinde eski ve yeni kodun çıktılarıdır.

1. **Kurum "asgari" porsiyonları ev porsiyonu gibi kullanılmıştı.** Kişi başı referanslar Sabancı Üniversitesi Ek-2 "Asgari Yemek Porsiyon Gramajları" listesindendi (ana yemek 200 g, çorba 200 g, sütlü tatlı 130 g). Bunlar ihale şartnamesindeki **en az** değerlerdir. Ayrıca çorba, ana yemek, pilav ve tatlıdan oluşan çok kaplı bir menü için planlanmışlardır. Tek başına pişirilen ev yemeğinin porsiyonu bundan büyüktür. Gözlenen tüketim de büyüktür: NNPAS'ta karışık yemekler 266–310 g, çorba 333–420 g.
   - Sonuç: **mercimek çorbası 10 porsiyon** (kaynak 6), **sütlaç 13** (6), **muhallebi 9** (4), **kuru fasulye 7** (4).
2. **Kızartma yağı verime ekleniyordu.** "2 su bardağı sıvı yağ (kızartmak için)" 368 g yemek sayılıyordu. Yağın çoğu tavada kalır.
   - Sonuç: **İzmir köfte 9 porsiyon** (kaynak 4). Karnıyarıkta da aynı hata vardı.
3. **Pilavda kütle korunumu ihlali.** Bognár'ın 2,98 pirinç katsayısı, bol suda haşlanıp süzülen pirinç içindir. Pilav usulünde pirinç yalnızca tarifteki suyu çekebilir.
   - Örnek: 2 su bardağı pirinç (328 g) + 2 su bardağı su (400 g) = 728 g. Eski hesap 977 g pilav buluyordu; bu, giren her şeyden 250 g fazladır.
   - Bulgurda da aynı hata vardı: kısırda 2 su bardağı bulgur, 1,5 su bardağı sıcak suyla 1103 g sayılıyordu.
4. **Çorbada kaynaksız buharlaşma oranı.** %10 buharlaşma (0,90) belgede de "uygulama varsayımı, kaynağı yok" diye işaretliydi. Bognár buharlaşmanın öngörülemeyeceğini yazar.
5. **Adet ve dilim, kişi sayısı sanılıyordu.** Prompt yalnızca "kişi/porsiyon" diyordu.
   - "10 adet biber dolması", "6 adet karnıyarık" ya da "8 dilim revani" ya 10/6/8 **porsiyon** olarak kaydediliyor ya da atlanıyordu.
6. **Tek bir kişi başı referansla bölme.** Etli türlüde et ile patates aynı 200 g havuzuna toplanıyordu.
   - Oysa kurum şartnameleri aynı eti yemeğin türüne göre farklı miktarda planlar: MSB kuşbaşı yemekte 160 g, sebze/bakliyat yemeğinde 80 g, karnıyarıkta 60 g kıyma.
7. **Pişirme modunda ölçekleme hatası (`app/src/servings.js`).** Ölçeklenmeyecek ifadeleri yakalayan desende çıplak "için" kelimesi vardı.
   - Bu yüzden "500 g (köfte için)" ya da "3 yemek kaşığı (sos için)" gibi asıl malzemeler porsiyon değişince hiç ölçeklenmiyordu.

## 4. Yeni model (2026-09-28.1)

### 4.1 Akış

1. **AI çıkarır, hesap yapmaz** (`app/shared/recipeExtraction.js` prompt'u, sunucuda `api/_lib/extractRecipe.js` JSON şeması). AI'dan istenenler:
   - `servings` + `servings_unit`: yalnızca kaynakta yazıyorsa. `servings_unit` şunlardan biridir:
     - `porsiyon`: kişi/porsiyon/tabak/kase.
     - `adet`: kurabiye, dolma, köfte, karnıyarık gibi parça sayısı.
     - `dilim`.
   - `portion.dish_type`: `ana_yemek`, `sebze_yemegi`, `bakliyat_yemegi`, `corba`, `yan_yemek`, `garnitur`, `salata`, `meze_sos`, `tatli_kek`, `tatli_sutlu`, `tatli_hamurisi`, `borek`, `pide_pizza`, `diger`.
   - `portion.items[]`: her malzeme için şunlar:
     - `kind`: yeni türler `yaprakli_sebze` ve `kizartma_yagi`.
     - Kaynaktaki `quantity` ve `unit` (dönüştürmeden).
     - `size`, `state` (çiğ/pişmiş), `quantity_in_source`.
     - `main`: tabağı oluşturan ana malzeme mi? (Yeni.)
2. **Kod hesaplar** (`app/shared/portionEstimate.js`). İstemci ve sunucu aynı `applyPortionEstimate` fonksiyonunu kullanır.
3. **Öncelik:** kaynaktaki sayı (`servings_basis: "kaynak"`, birimiyle birlikte) > hesap (`"hesap"`) > bilinmiyor (`"bilinmiyor"`, `servings: null`). Kullanıcı Tarifi Düzenle'den porsiyonu değiştirirse:
   - `servings_basis` "kullanici" olur.
   - `servings_calc`, `servings_note` ve `servings_range` silinir.

### 4.2 A yöntemi — ana malzeme

`porsiyon aralığı = ana malzemenin çiğ miktarı ÷ [kişi başı üst, kişi başı alt]`

- **Kişi başı miktarlar:** Türk kurumlarının yetişkin öğünü için planladığı çiğ girdilerdir (§5.1). Aynı malzemenin miktarı yemek türüne göre değişir. Örnek: kıyma köftede 130–150 g, sebze yemeğinde 40–100 g, bakliyatta 30–60 g.
- **Birden çok aday varsa:** pişmiş kütlesi en büyük olan porsiyonu belirler (tabağın çoğunu oluşturan malzeme). Etli kuru fasulyede kuru fasulye belirler, et belirlemez.
- **Ana malzeme işareti:** Sebze, yapraklı sebze ve patates yalnızca AI `main: true` dediyse ana malzeme sayılır. Böylece soğan, domates ve biber porsiyonu belirlemez.
- **Pişmiş verilen ana malzeme** (ör. "400 g haşlanmış nohut") çiğ eşdeğerine döndürülür: 400 ÷ 2,5 = 160 g.
- **Yumurta yemeklerinde** kişi başı 1 adet sayılır: AGU menemen ve yumurtalı ıspanak şartnamesi; TÜBER: "Türkiye'de yumurtanın servis miktarı genelde 1 adettir".
- **Toplanan malzemeler:** Çorbada kuru bileşenler (mercimek + pirinç + bulgur + şehriye) ve hamur tatlısında un + irmik toplanır.

### 4.3 B yöntemi — toplam verim

`porsiyon aralığı = [verim alt ÷ tüketim üst, verim üst ÷ tüketim alt]`

- **Verim**, yemek türüne göre üç moddan biriyle hesaplanır:
  - **Bileşen:** ana, sebze ve bakliyat yemekleri, yan yemek, garnitür, salata, meze. Hesap: Σ çiğ g × pişme/yenebilir katsayısı.
    - Pişirme suyu, et suyu ve kızartma yağı eklenmez.
    - Kuru gıdaların katsayısı çektikleri suyu zaten içerir.
    - **Yeni:** pilav usulü pişen pirinç ve bulgurun verimi, kuru ağırlık + tarifteki sıvıyla sınırlıdır.
  - **Kütle:** çorba, sütlü tatlı, hamurişi (şerbetli) tatlı. Hesap: Σ tüm malzeme (su dahil, kemik payı düşülmüş) × **0,76–0,92** kalan oran.
  - **Hamur:** kek ×0,92, börek ve pide/pizza ×0,90.
- **Tüketim aralığı** (§5.2): alt ve üst uç, Türk kurum porsiyonu ile gözlenen tüketimin (NNPAS; kadın ve erkek yetişkin medyanları) kapsadığı aralıktır.
- **Ana malzeme ölçülemiyorsa B kullanılmaz.** Örnek: "6 adet patlıcan"da patlıcanın gram karşılığı bilinmez; o malzeme olmadan hesaplanan verim yanıltıcı olur.

### 4.4 Birleştirme, yuvarlama, gösterim

1. İki yöntem de hesaplanabiliyor ve aralıkları örtüşüyorsa **kesişim** alınır (`method: "ikisi"`).
2. Örtüşmüyorsa yemek türünün birincil yöntemi kullanılır:
   - **A:** ana, sebze, bakliyat, yan, garnitür, sütlü tatlı, hamurişi.
   - **B:** çorba, salata, meze, kek, börek, pide/pizza.
3. Tek sayı (`servings`, ölçekleme için) aralığın **geometrik ortasıdır**. Tam sayıya yuvarlama yalnızca en son yapılır. Alt ve üst uç ayrı ayrı yuvarlanır (`servings_range`).
4. Tarif Detay'da "Tahmini 6 porsiyon (5–8)" görünür. Aralık tek sayıya inerse "Tahmini 2 porsiyon" görünür. Kaynaktaki sayı düz gösterilir: "4 porsiyon", "10 adet", "8 dilim". Pişirme modu birim neyse onu sorar ("Kaç adet hazırlayacaksın?").
5. `servings_note`, uygulanan hesabın aynı sayılarını ve kaynaklarını içerir. Her zaman Türkçe üretilir; İngilizce gösterimde çeviri katmanı çevirir, sayılar değişirse çeviri kullanılmaz. `assumptions` alanına karışmaz.
6. Besin değerleri her zaman **tarifin tamamı** içindir. Porsiyon tahmini besin toplamını değiştirmez.

### 4.5 Sayı üretilmeyen durumlar

- Yemek türü `diger`. Kahvaltılık pankek, krep, kurabiye gibi referansı olmayanlar buraya girer; kaynakta sayı yoksa porsiyon bilinmiyor kalır.
- Ana malzemenin miktarı ölçülemiyorsa (ör. "3 adet tavuk budu", "1 paket makarna", "1 paket yufka") ve ölçülebilen başka bir ana malzeme yoksa.
- Kaynakta yazmayıp AI'ın tamamladığı miktarlar hesaba girmez. Bunların verimdeki payı %25'i aşarsa sayı üretilmez. AI'ın tamamladığı ana malzeme de sayılmaz.
- `belirsiz` birimler ("1 paket", "1 demet", "biraz"), yoğunluğu bilinmeyen hacimler ve ağırlığı bilinmeyen adetler grama **sessizce çevrilmez**. Gerekçede "hesaba katılamayanlar" diye listelenir.

## 5. Tablolar

### 5.1 A — kişi başı çiğ miktar (g)

Aralık = kaynakların en küçüğü ile en büyüğü. MSB = Millî Savunma Bakanlığı 2017-2018 Yemek Teknik Şartname Ek 1-a. AGU = Abdullah Gül Üniversitesi yemek teknik şartnamesi.

| Yemek türü | Malzeme | Kişi başı | Kaynak |
|---|---|---|---|
| ana yemek | kemiksiz et | 150–200 | AGU et yemekleri 150; MSB kuşbaşı 160, tek parça 180, çoban kavurma 200 |
| ana yemek | kemiksiz tavuk | 175–180 | AGU tavuk göğsü 175; MSB 180 |
| ana yemek | kıyma (köfte) | 130–150 | MSB köfte 130, pirinçli köfte 140; AGU 150 |
| ana yemek | kemikli et | 200 | AGU kapama (kemikli kuzu) 200 |
| ana yemek | kemikli tavuk | 250 | MSB 250; AGU fırın tavuk (but) 250 |
| ana yemek | bütün balık | 250–300 | MSB temizlenmiş balık 250–300; AGU 250 |
| ana yemek | balık fileto | 180 | MSB 180 |
| ana yemek | yumurta | 1 adet | AGU menemen 1; TÜBER servis miktarı 1 adet |
| ana yemek | kuru makarna | 100 | AGU fırın makarna, spagetti 100 |
| ana / yan yemek | pirinç (pilav) | 70–100 | MSB 70; AGU 100 |
| ana / yan yemek | bulgur (pilav) | 60–100 | MSB 60; AGU 100 |
| yan yemek | kuru makarna | 60–100 | MSB 60; AGU 100 |
| ana / bakliyat / yan | kuru baklagil | 70–100 | MSB kuru fasulye, nohut 70; AGU 100 |
| ana / bakliyat | yeşil mercimek | 100 | MSB 100; AGU 100 |
| sebze / ana / yan | ana sebze | 150–250 | MSB zeytinyağlı taze fasulye 150, etli sebze 175; AGU 200–250 |
| sebze / ana / yan | yapraklı sebze | 200–400 | AGU ıspanak, pırasa 200–250, semizotu 250; MSB pazı, lahana 300, semizotu 400 |
| ana / sebze / yan / garnitür | patates | 200 | MSB patates garnitür 200, kızartma 200 |
| sebze yemeği | kıyma | 40–100 | MSB kabak dolma 40, karışık dolma 50, karnıyarık, musakka, oturtma 60; AGU 70–100 |
| sebze / bakliyat | kemiksiz et | 60–90 | AGU etli türlü 60; MSB 80, etli türlü 90 |
| sebze / bakliyat | kemiksiz tavuk | 70–100 | MSB 70, tavuklu karnıyarık 100 |
| sebze yemeği | pirinç (dolma) | 25–50 | MSB biber dolma, sarma 25; AGU biber dolma 50 |
| bakliyat yemeği | kıyma | 30–60 | AGU kıymalı nohut 30, kıymalı kuru fasulye 60 |
| garnitür | pirinç | 30–50 | TÜBER 1 standart porsiyon = garnitür = 30 g çiğ; MSB garnitür 50 |
| garnitür | bulgur | 25–30 | TÜBER 25; MSB garnitür 30 |
| garnitür | kuru makarna | 36–60 | TÜBER garnitür 75 g pişmiş ÷ 2,10 ≈ 36; MSB 60 |
| çorba | kuru tahıl/baklagil toplamı | 35–50 | MSB kırmızı mercimek 35; AGU mercimek ve ezogelin çorbası 50 |
| sütlü tatlı | süt | 150–200 | MSB sütlü tatlılar 150; AGU fırın sütlaç 200 |
| hamurişi tatlı | un + irmik | 50–80 | MSB tatlılar için un (asgari) 50–80 |

Kurum girdileri, çok kaplı menülerin kişi başı planıdır. Evde tek yemek pişiriliyorsa porsiyon büyüyebilir. Bu fark §6'da açıkça görülüyor (bakliyat).

### 5.2 B — kişi başı tüketilen pişmiş miktar (g)

Alt ve üst uç = Türk kurum porsiyonu ile gözlenen tüketimin küçüğü ve büyüğü. Gözlenen değerler **NNPAS 2011-12** (Avustralya, 19+ yaş, n = 9341, 24 saatlik hatırlatma, öğün başı medyan) verisidir. Yaş gruplarına ayrılmış tablolarda her cinsiyet için yaş gruplarının medyanı alındı.

| Yemek türü | Kişi başı | Türk kurum değeri | Gözlenen (NNPAS) |
|---|---|---|---|
| ana / sebze / bakliyat (B yedek) | 200–310 | Sabancı ana yemekler toplam 200 | karışık yemek (makarna + pirinç yemekleri): kadın 266, erkek 310 |
| yan yemek | 137–201 | Sabancı pilav/makarna, zeytinyağlı 170 | pişmiş pirinç (19+): kadın 137, erkek 201 |
| garnitür | 90–149 | TÜBER garnitür pilav 90–110; MSB garnitür 50 g çiğ ≈ 149 g pişmiş | — |
| çorba | 200–420 | Sabancı, AGU çorba asgari 200 (TÜBER küçük kase 240 mL) | çorba: kadın 333, erkek 420 |
| salata | 150–210 | TÜBER çiğ sebze 1 standart porsiyon 150; MSB çoban salata sebzeleri toplamı 210 | (yeşil yapraklı yan salata 62–86 g; farklı yemek, kullanılmadı) |
| meze/sos | 80–180 | Sabancı garnitür yoğurt 80; MSB cacık (yoğurt 130 + salatalık 50) | — |
| kek/pasta | 88–103 | Sabancı pasta dahil özel tatlılar 100 | kek/çörek/muffin: kadın 88, erkek 103 |
| sütlü tatlı | 104–130 | Sabancı 130 | sütlü tatlı 104 (NNPAS, Eldridge 2025'te) |
| hamurişi tatlı | 88–170 | Sabancı 170 | (kek/çörek kadın 88; doğrudan veri yok) |
| börek | 140–175 | Sabancı börek 140 | tuzlu hamur işi: kadın 149, erkek 175 |
| pide/pizza | 185–290 | Sabancı 250 | pizza: kadın 185, erkek 290 |

### 5.3 Pişme / yenebilir verim katsayıları (pişmiş yenebilir g ÷ çiğ g)

| Malzeme | Katsayı | Kaynak |
|---|---|---|
| kemikli tavuk/et | 0,49 | TÜBER: %30 kemik + %30 pişme kaybı; Bognár tavuk budu tavada, yenebilir 0,48 |
| kemiksiz tavuk/et | 0,70 | TÜBER ~%30 pişme kaybı; USDA tavuk budu fırın %69 |
| kıyma — tava/ızgara/fırın | 0,81 | Bognár köfte/burger 0,81 (n=10) |
| kıyma — sulu | 0,70 | TÜBER: 115 g çiğ kıyma ≈ 80 g pişmiş |
| bütün balık | 0,55 | TÜBER; Bognár bütün morina 0,51–0,57 |
| balık fileto | 0,80 | Bognár fileto 0,80 (n=10) |
| pirinç | 2,98 | Bognár uzun taneli pirinç haşlama 2,98 (n=140). **Pilavda kuru + sıvı ile sınırlı.** |
| bulgur | 3,58 | **Türetilmiş:** TÜBER'e göre 25 g bulgur ile 30 g pirinç aynı pişmiş porsiyonu verir. **Pilavda kuru + sıvı ile sınırlı.** |
| kuru makarna | 2,10 | Bognár 2,10 (n=4) |
| kuru fasulye/nohut | 2,50 | Bognár 2,50 (n=10) |
| mercimek | 2,73 | Bognár 2,73 (n=6) |
| patates — haşlama / fırın / kızartma | 1,00 / 0,77 / 0,54 | Bognár (n=272 / 3 / 13) |
| sebze, yapraklı sebze — haşlama / kuru ısı / çiğ | 0,93 / 0,80 / 1,00 | Bognár havuç 0,94, taze fasulye 0,93; soğan 0,83, biber/kabak 0,73–0,74. Yapraklı sebze için ayrı veri kullanılmadı. |
| pişmiş verilen kemikli et | 0,75 | Bognár 0,48 / 0,64 |
| su, et suyu, **kızartma yağı** | 0 | Bognár: pişirme suyu tarife katılmaz. Kızartma yağının çoğu tavada kalır. |
| diğer (yağ, süt ürünü, un, şeker, yumurta, sos) | 1,00 | Ağırlık korunur varsayımı |
| su dahil pişirme (çorba, sütlü, şerbetli) kalan oran | 0,76–0,92 | Bognár su dahil risotto ölçümü: 0,76 (küçük parti) – 0,92 (büyük parti). Sütlaç 0,91 ve irmik tatlısı 0,88 bu aralıkta. |
| kek / börek, pide, pizza | 0,92 / 0,90 | Bognár mermer kek / ekmek (vekil) |

### 5.4 Ölçü → gram

- **Hacim (mL):**
  - su bardağı 200, çay bardağı 100: tarif siteleri. MSB şartnamesi su bardağını 250 mL sayar; TÜBER'e göre ev bardakları değişken.
  - yemek kaşığı 15, çay kaşığı 5: FAO/INFOODS.
  - tatlı kaşığı 10: kaynak açılmadı, uygulamanın kabulü.
- **Yoğunluk (g/mL), FAO/INFOODS Density DB v2.0:**
  - su 1,00; süt 1,03; yoğurt 1,03; krema 1,00; sıvı yağ 0,92; tereyağı 0,91; şeker 0,88; pirinç 0,82; irmik 0,78; patates 0,59; kuru makarna 0,39.
  - un 0,58: 5 değerin ortancası, 0,48–0,67 arası.
  - Vekiller: mercimek 0,89, kuru baklagil 0,75, bulgur 0,77, doğranmış sebze 0,55.
  - sos/salça 1,00: kaynak yok.
- **Adet (g), USDA FoodData Central SR Legacy, yenebilir kısım:**
  - patates 170/213/369; soğan 70/110/150; havuç 50/61/72; domates 91/123/182.
  - yumurta 38/44/50 (kabuksuz); sarı 17; ak 33.
  - Boyut yazmıyorsa orta kabul edilir ve not düşülür.
- **Bilerek eklenmeyen adet ağırlıkları:** patlıcan, sivri/dolmalık biber, salatalık, kabak, tavuk but/budu, balık fileto adedi.
  - Türk çeşitleri ABD'dekinden belirgin farklıdır. Örnek: USDA patlıcan 548 g, salatalık 301 g.
  - "Tavuk budu" Türkçede hem üst but hem bütün but anlamında kullanılır.
  - Bunlara sayı vermek sahte kesinlik olurdu. Adetle verilirlerse hesap dışı kalırlar ve listelenirler.

## 6. Doğrulama

**Kontrol yöntemi:** yemek.com'dan porsiyonu kaynakta yazan 33 tarif (erişim 2026-09-28). Her tarif, AI'ın yeni şemayla vereceği biçimde **elle** kodlandı: tür, miktar, ana malzeme. Kodlanmış hâller `app/scripts/portion-validation.mjs` içinde; `node scripts/portion-validation.mjs` ile tekrar çalıştırılır. Eski sürüm aynı tariflerin eski şemaya göre kodlanmış hâliyle çalıştırıldı.

> Kaynaktaki sayı **yazarın beyanıdır**, ölçülmüş tüketim değildir. Sapma her zaman hesabın hatası değildir. Örnek: "8 dilim" ıslak kek, yaklaşık 220 g'lık dilimler demektir. Gözlenen kek tüketiminin medyanı ise 88–103 g'dır.

| Tarif | Tür | Kaynak | Eski | Yeni (aralık) | Yöntem |
|---|---|---|---|---|---|
| mercimek çorbası | çorba | 6 kişilik | 10 | 6 (5–8) | ikisi |
| kuru fasulye | bakliyat | 4 kişilik | 7 | 6 (5–7) | ikisi |
| tavuk sote | ana | 2 kişilik | 2 | 2 | ikisi |
| pirinç pilavı | yan | 5 kişilik | 6 | 4 (4–5) | ikisi |
| karnıyarık | sebze | 6 adet | 4 | 6 (4–9) | A |
| sütlaç | sütlü tatlı | 6 kişilik | 13 | 6 (5–7) | A |
| menemen | ana | 4 kişilik | 2 | 3 | A |
| tas kebabı | ana | 5 kişilik | 6 | 5 (4–5) | ikisi |
| İzmir köfte | ana | 4 kişilik | 9 | 4 (3–4) | A |
| zeytinyağlı taze fasulye | sebze | 4 kişilik | 11 | 4 (3–5) | A |
| yoğurtlu kek | kek | 6 kişilik | 9 | 9 (9–10) | B |
| bulgur pilavı | yan | 4 kişilik | 9 | 4 (3–5) | A |
| fırında tavuk but ("3 adet tavuk budu") | ana | 4 kişilik | — | — (bilinmiyor) | |
| nohut yemeği | bakliyat | 4 kişilik | 8 | 6 (5–7) | ikisi |
| humus | meze | 4 porsiyon | 10 | 7 (4–10) | B |
| ezogelin çorbası | çorba | 6 kişilik | 10 | 6 (5–7) | ikisi |
| çoban salatası | salata | 4 kişilik | 5 | 4 (3–5) | B |
| kısır | salata | 6 kişilik | 8 | 4 (4–5) | B |
| patates yemeği | sebze | 2 tabak | 5 | 4 | ikisi |
| revani | hamurişi | 8 dilim | 8 | 5 (4–7) | A |
| muhallebi | sütlü tatlı | 4 kişilik | 9 | 6 (5–7) | A |
| ıspanaklı börek ("1 paket yufka") | börek | 8 kişilik | — | — (bilinmiyor) | |
| kıymalı taze fasulye | sebze | 4 kişilik | 6 | 5 (4–6) | ikisi |
| yayla çorbası | çorba | 6 kişilik | 8 | 5 (3–8) | B |
| tarhana çorbası | çorba | 6 kişilik | 6 | 4 (3–7) | B |
| şekerpare | hamurişi | 1 tepsi (~8) | 9 | 10 | ikisi |
| fırında levrek ("2 adet fileto") | ana | 4 kişilik | — | — (bilinmiyor) | |
| piyaz | salata | 4 kişilik | 5 | 5 (4–5) | B |
| pizza | pide/pizza | 8 dilim | 6 | 6 (5–7) | B |
| ıslak kek | kek | 8 dilim | 17 | 18 (17–20) | B |
| pankek | diğer | 6 kişilik | — | — (desteklenmiyor) | |
| patates salatası | salata | 4 kişilik | 12 | 10 (8–12) | B |
| zeytinyağlı biber dolması | sebze | 10 adet | 7 | 7 (5–10) | A |

**Özet:**

- Kaynağa ±1 yakınlık: eski 8/29, yeni 15/29. Kaynak aralık içinde: 17/29.
- Kişi sayısı beyanlı ve iki sürümde de hesaplanan 23 tarifte medyan |oran hatası|: eski **%67**, yeni **%25**.
- Kaynakta adet/dilim yazan tarifler (karnıyarık, biber dolması, revani, pizza, ıslak kek) artık hesaplanmaz. Kaynaktaki sayı birimiyle birlikte korunur ("10 adet", "8 dilim"). Tablodaki hesap yalnızca karşılaştırma içindir.

**Kalan sapmaların yorumu:**

- **Kuru fasulye ve nohut (6'ya karşı 4):** Ev tarifleri kişi başı yaklaşık 125 g kuru baklagil kullanıyor. Kurum şartnameleri 70–100 g kullanıyor (çok kaplı menü). Evde tek başına yenen bakliyat için hesap fazla porsiyon gösterebilir. Kurum dışı güvenilir bir tüketim verisi bulunamadığı için aralık genişletilmedi.
- **Kek ve ıslak kek:** Hesap, gözlenen kek tüketimine göre dilim sayısı verir. Yazarlar daha iri dilim sayıyor. Bu, ölçülen tüketimle yazar beyanı arasındaki gerçek bir farktır.
- **Patates yemeği ("2 tabak") ve patates salatası:** Tarif kişi başı 400 g'dan fazla patates içeriyor. Hesap kurum ve tüketim verisine göre daha fazla porsiyon görür.
- **Kısır ve çoban salatası:** Demetle verilen yeşillikler ve adetle verilen salatalık/biber ölçülemediği için verim eksik kalır. Hesap porsiyonu olduğundan az gösterebilir; gerekçede listelenir.
- **Menemen (3'e karşı 4):** Kişi başı 1 yumurta (kurum) ile yazarın 3 yumurtayı 4 kişiye paylaştırması arasındaki fark.

**Otomatik testler** (`cd app && npm test`, 58 test, hepsi geçiyor):

- Belirlenimcilik (aynı girdi, aynı sonuç).
- Doğrusal ölçekleme: 1x/2x/5x'te alt, üst ve orta değerler tam k katına çıkar.
- İzmir köfte hesabı; kızartma yağının verime girmemesi.
- Pilav kütle sınırı.
- Çorbada su dahil kütle aralığı; sütlaç süt hesabı.
- Bakliyatta etin ana malzeme olmaması; ana malzeme işareti.
- Pişmiş girdi (400 g haşlanmış nohut = 160 g kuru).
- Eşdeğer birimler.
- Ölçülemeyen ana malzeme (sayı yok); karnıyarık.
- AI'ın tamamladığı miktarlar; eski biçimdeki `portion`.
- Kaynaktaki porsiyonun ve adet/dilim biriminin korunması.
- Gerekçe metninin uygulanan sayılarla aynı olması; `servings_range`.
- Yumurta sarısı ve akı; menemen.
- `servings.js`'te amaç notlu miktarın ölçeklenmesi.

## 7. Bilinen sınırlar ve belirsizlikler

- **AI sınıflandırması belirlenimci değildir.** Yemek türü, ana malzeme ve malzeme türü denemeden denemeye değişebilir; doğrulama seti elle kodlandığı için bu fark ölçülmedi. **Yeni prompt ve şema gerçek bir AI çağrısıyla denenmedi:** yerelde API anahtarı yok; canlı API'yi kullanmak kullanıcı onayı gerektirir.
- **Gözlenen tüketim verisi Türkiye'den değil**, Avustralya'dandır (NNPAS). Türkiye için yemek düzeyinde öğün başı tüketim verisi erişilebilir biçimde bulunamadı. TBSA 2017 günlük toplamları verir. Hacettepe "Yemek ve Besin Fotoğraf Kataloğu" basılı kitaptır, çevrim içi değildir. Türk bağlamı kurum şartnameleri ve TÜBER ile temsil edildi.
- **Kurum şartnameleri çok kaplı menü içindir** ve kurumdan kuruma değişir: pilavda MSB 70 g, AGU 100 g. Aralıklar bu farkı taşır.
- **Ev bardağı ve kaşığı standart değildir.** 200 mL kabulü tarif sitelerinindir; MSB 250 mL sayar. Bu belirsizlik aralığa ayrıca eklenmedi.
- **Adet boyutu yazmıyorsa orta kabul edilir.** Küçük ve büyük arasındaki fark aralığa eklenmedi.
- **Bulgur katsayısı türetilmiş değerdir** ve pilavda kütle sınırıyla kırpılır.
- **Yapraklı sebze, nohut, bulgur, kırmızı mercimek** için doğrudan verim ya da yoğunluk ölçümü yok; vekil değerler kullanıldı.
- **Kapsam dışı:** kahvaltılıklar, pankek, krep, kurabiye (kaynakta sayı yoksa porsiyon bilinmiyor kalır), içecekler, çocuk porsiyonu.
- **Eski kayıtlar değişmez.** `2026-09-27.3` ile hesaplanmış tarifler eski sayı ve gerekçeyle kalır: aralık yok, "Tahmini N porsiyon". Toplu yeniden hesap yapılmadı (bilerek; production verisine dokunulmaz). Yeni kurallar yalnızca yeni çıkarılan tariflere uygulanır.
- **"Elimde Bunlar Var" (AI öneri) tariflerine porsiyon hesabı uygulanmaz.** O akış `portion` üretmiyor; bu iş kapsamında değiştirilmedi.

## 8. Kaynaklar

Hepsine 2026-09-28'de erişildi.

1. T.C. Sağlık Bakanlığı HSGM — *Türkiye Beslenme Rehberi (TÜBER) 2022*, Bölüm 10.2 (s. 228–232): kepçe ve kase ölçüleri; garnitür porsiyonu = 1 standart porsiyon (pilav 90–110 g, makarna 75 g; çiğ 30 g pirinç/makarna, 25 g bulgur); ikinci kap = 2 standart porsiyon; %30 kemik + %30 pişme kaybı; "Türkiye'de yumurtanın servis miktarı genelde 1 adettir". https://hsgm.saglik.gov.tr/depo/birimler/saglikli-beslenme-ve-hareketli-hayat-db/Dokumanlar/Rehberler/Turkiye_Beslenme_Rehber_TUBER_2022_min.pdf
2. T.C. Millî Savunma Bakanlığı — *Yemek 2017–2018 Teknik Şartname Ekleri, Ek 1-a* (yemek türüne göre kişi başı çiğ girdi gramajları). https://ms.hmb.gov.tr/uploads/2019/02/yemek2017-2018tekniksartnameekleri.pdf
3. Abdullah Gül Üniversitesi — *Yemek İhalesi Teknik Şartnamesi* (çorba, ana yemek, pilav/makarna, börek, tatlı gruplarında kişi başı girdi; "servis edilen porsiyon en az …"). http://www.agu.edu.tr/userfiles//Teknik_S%CC%A7artname.pdf
4. Sabancı Üniversitesi Satınalma — *Ek-2 Asgari Yemek Porsiyon Gramajları* (tarih yok). https://mysu.sabanciuniv.edu/purchasing/sites/mysu.sabanciuniv.edu.purchasing/files/ek_a_ek-2_asgari_yemek_porsiyon_gramajlari_2.pdf
5. Zheng M, Wu JHY, Louie JCY, Flood VM, Gill T, Thomas B, Cleanthous X, Neal B, Rangan A. *Typical food portion sizes consumed by Australian adults: results from the 2011–12 Australian National Nutrition and Physical Activity Survey.* Sci Rep. 2016;6:19596. doi:10.1038/srep19596. https://pmc.ncbi.nlm.nih.gov/articles/PMC4726402/ (Tablo 1–3: öğün başı medyan ve IQR, yaş/cinsiyet grupları.)
6. Eldridge AL, Kotzakioulafi E, Debras C, et al. *Method to define recommended portion sizes for consumer guidance.* Eur J Nutr. 2025;64(1):62. doi:10.1007/s00394-024-03573-x. https://pmc.ncbi.nlm.nih.gov/articles/PMC11698800/ (Önerilen "Global Portion Values"; NNPAS sütlü tatlı medyanı 104 g.)
7. Bognár A. (2002) *Tables on weight yield of food and retention factors of food constituents for the calculation of nutrient composition of cooked foods (dishes).* BFE-R-02-03, Karlsruhe. https://www.fao.org/uploads/media/bognar_bfe-r-02-03.pdf (Tablo 14 çorbalar, Tablo 29–30 tahıllar; su dahil risotto örneği ve "buharlaşma öngörülemez" açıklaması.)
8. USDA ARS — *USDA Table of Cooking Yields for Meat and Poultry.* https://www.ars.usda.gov/ARSUserFiles/80400525/data/retn/usda_cookingyields_meatpoultry.pdf
9. FAO/INFOODS — *Density Database Version 2.0* (2012). https://www.fao.org/fileadmin/templates/food_composition/documents/density_DB_v2_0_final-1__1_.xlsx
10. FAO/INFOODS — *Guidelines for Converting Units, Denominators and Expressions*, v1.0 (2012). https://www.fao.org/fileadmin/templates/food_composition/documents/1nutrition/Conversion_Guidelines-V1.0.pdf
11. USDA FoodData Central (SR Legacy) porsiyon ağırlıkları: FDC 170026, 170000, 170393, 170457, 171287, 172183, 172184. Eklenmeyenlerin karşılaştırması için 169228, 168409, 169291, 170108, 168576 (FDC API ile sorgulandı). https://fdc.nal.usda.gov/
12. yemek.com tarifleri (doğrulama seti; porsiyon beyanı ve malzeme listeleri), ör. https://yemek.com/tarif/mercimek-corbasi/ — tam liste `app/scripts/portion-validation.mjs` içinde.

## 9. Değişiklik geçmişi

- `2026-09-28.1`:
  - İki yöntemli aralık modeli (A ana malzeme + B toplam verim).
  - Yeni yemek türleri: `sebze_yemegi`, `bakliyat_yemegi`. Yeni malzeme türleri: `yaprakli_sebze`, `kizartma_yagi`. Yeni alanlar: `main`, `servings_unit` (`adet`/`dilim`), `servings_range`.
  - Kızartma yağı verime girmiyor. Pilavda kütle sınırı var. Su dahil pişirmede 0,76–0,92 aralığı. Kişi başı referanslar kurum + gözlenen tüketim aralığı.
  - `servings.js`: amaç notlu miktarlar ("köfte için") ölçekleniyor.
- `2026-09-27.3`: yumurta sarısı ve akı eşleştirmesi İngilizce adlarda.
- `2026-09-27.2`: yumurta sarısı ve akı ayrı ağırlık.
- `2026-09-27.1`: ilk deterministik hesap (kaynak / hesap / bilinmiyor ayrımı).
