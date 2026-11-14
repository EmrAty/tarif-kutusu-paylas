# Haiku 5.5 telefon denemesi (trial/haiku-extraction)

Bu dosya **yalnızca** Haiku denemesinin kaydıdır; Grup 5 yayın testlerinin kaydı `GROUP5_NOTES.md` §9'da kalır
ve buraya karışmaz. Kalıcı model kararı bu denemeden sonra verilecek. Main'e merge edilmez.

## Ne değişti (Grup 5 `712dfc8` üzerine)
- `app/shared/extractModel.js`: tarif çıkarma modeli **yalnızca `VERCEL_ENV=preview`** iken `claude-haiku-5-5`,
  aksi hâlde (production, yerel, testler) `claude-sonnet-5`. Haiku varsayılan ayarla çağrılır: adaptive düşünme,
  effort `medium`. Düşünmesiz sürüm kullanılmıyor.
- `_lib/extractRecipe.js` modeli bu fonksiyondan alır. Prompt, json_schema, `max_tokens: 16000`, `stop_reason`
  kontrolü, zaman aşımı, porsiyon hesabı aynı. Hem paylaşım paneli job'u hem "Yeni Tarif Çıkar" (görselli dahil)
  bu yolu kullanır.
- Değişmeyenler: AI koruması/kotalar, Free limiti, aile hedefi doğrulaması, tarif kaydı (sürümlü kova), bildirim,
  TikTok altyazı/ses yolu, çeviri ve kiler önerileri (bunlar Sonnet'te kalır).
- Gözlem: job kaydının `timings.extractModel` alanı ve loglardaki `model` alanı (`recipe-job` / `extract`
  satırları) hangi modelin kullanıldığını gösterir. Tarif kaydının biçimi değişmedi.
- `/version.json` → `extractModel`: derlemenin seçtiği model (sunucuyla aynı kural).

## Ortam
- `preview.tarifkutusu.app` → `trial/haiku-extraction` (deneme süresince; Grup 5 telefon testleri bu sürede
  bu adreste yapılamaz). Geri dönüş: Vercel → Domains → preview.tarifkutusu.app → Git Branch: `group-5-ci-release`.
- Redis: Preview'a özel `tk-preview-test` (production'dan ayrı). Eski test hesaplarının verisi burada yok.
- Koruma: Vercel Authentication (Tarif TEST APK'nın mevcut erişimi).

## Telefon denemesi kaydı
Her tarif için: kaynak link, yol (paylaşım paneli / Yeni Tarif Çıkar), sonuç. Besin değeri ve porsiyon modelin
**tahminidir**; doğrulanmış ölçüm değildir, burada yalnızca "makul mü" notu düşülür.

| # | Tarih | Link | Yol | Malzemeler + miktar/birim kaynakla aynı mı | Alternatifler korunmuş mu | Yapılış kaynakla uyumlu mu (kaynakta yoksa boş mu) | Kaynakta olmayan ekleme | Süre (sn) | Not |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 15 Kas 00:31 | tiktok.com/@rainyycook/video/7575869460007947538 | paylaşım paneli | kullanıcı karşılaştırdı, sorun yok | — | uyumlu (kullanıcı) | görülmedi | 15,7 (Haiku) | "Tarifin hazır" bildirimi gelmedi — aşağıda |
| 2 | | | | | | | | | |

### #1 bildirimi neden gelmedi (15 Kasım, Upstash `tk-preview-test` CLI'dan salt okunur doğrulandı)
- Job `1794691906383-qi2eyh`: `status: completed`, `timings.extractModel: "claude-haiku-5-5"`, `claude: 15681 ms`,
  `notify: {sent: 0, attempted: 0, error: null}`, `timings.fcm: 6 ms` → **hedef bulunamadı, FCM'e hiç istek gitmedi.**
- Zaman çizelgesi (TR): istek 00:31:41 · job başladı 00:31:46 · tamamlandı 00:32:02 · **Android cihaz kaydı 00:36:11**
  (`user:<uid>:pushTargets`, platform `android`, tek kayıt; `push-owner` aynı uid'ye ait = job'un hesabı).
- Kök neden: yeni test Redis'i boş başladı; cihaz kaydı yalnızca **ana uygulama** açılınca yapılır (paylaşım paneli
  düz WebView, push plugin'i yok). Paylaşım ana uygulama bu hesapla hiç açılmadan yapıldı → o anda 0 hedef.
  Tasarım gereği (bkz. `_lib/fcm.js` "Bedeli"); panelin `noNotifyNote` uyarısı bu durumda gösterilir.
  "Zorla durdur" bu job'u etkilemedi (gönderim denenmedi bile). Kod değişikliği yapılmadı.
- Kayıt artık var; sonraki paylaşımda `notify.attempted` 1 olmalı.

## Malzeme listesi okunabilirliği (15 Kasım, telefon ekran görüntüleri: Nashville + steak sandviç)
Kaynak tarifler İngilizce, uygulama Türkçe. Zincirdeki kök nedenler (Haiku'ya özgü değil; prompt/şema/arayüz):
- **Prompt** "Miktarlar net değilse makul tahminler yap" diyordu → "belirtilmemiş, tahminen 45 g". Adlandırma
  kuralı yoktu → "Pastırma (bacon)", "Flank bonfile (flank steak)" (yanlış eşdeğer + iki dil), "(veya tercih edilen ekmek)".
- **Şema** malzemede yalnız `{name, amount}` → karışımın bütün içeriği tek satırın `amount`'una yazılıyordu.
- **Arayüz** miktar `nowrap` + `flexShrink: 0` → ad kelime kelime aşağı uzuyor, miktar karttan taşıp kesiliyordu.

Değişiklikler:
- Yeni çıkarılanlar: prompt'a malzeme listesi + adlandırma kuralları; şemaya `group` (bölüm adı) ve `estimated`
  (tahmini miktar, ekranda "Yaklaşık"); kayıttan önce `shared/ingredientText.js` ile deterministik temizlik.
- Eski kayıtlar (YALNIZCA gösterimde, kayıt değişmez): "belirtilmemiş…" temizliği, tahmin → "Yaklaşık …", tek satıra
  yazılmış karışımın bölüm başlığı + ayrı malzemelere bölünmesi (`src/ingredientPresentation.js`). Eski adlar
  ("Pastırma (bacon)", "Flank bonfile") ve alternatif metinleri DEĞİŞMEZ — anlamı yalnız yeniden çıkarma düzeltir.
- Ekran: ad + miktar aynı satırda; sığmazsa miktar alt satıra sağa yaslı geçer (kesilmez, taşmaz). Bölüm başlıkları
  Tarif Detay + Pişirme modunda; bir bölümden sonraki bölümsüz satırlar "Diğer malzemeler" altında.
- Alışveriş listesi: bölümlerdeki aynı malzeme toplanır; karışıma atıf ("Baharat karışımı") listeye girmez; tahmini
  miktar içeren toplam "Yaklaşık". "Elimde Bunlar Var" bölünmüş satırlarla eşleştirir. Düzenleme formu `group`/
  `estimated`'ı korur (miktar elle değişirse tahmin işareti kalkar).
- Çeviri: bölüm adları `groups` ile çevrilir (bölümsüz eski tarifin çeviri yükü aynı biçimde kalır);
  adlandırma kuralları çeviri prompt'unda da. Prompt değiştiği için `PROMPT_VERSION` v2: önbellek anahtarı değişir,
  İngilizce arayüzde açılan her tarif bir kez yeniden çevrilir (Sonnet, ücretli; yalnız açılınca).
- Testler: `test/ingredientDisplay.test.mjs` (gerçek kayıtlar `test/fixtures/trialRecipes.mjs`). Görünüm: gerçek
  `RecipeDetail`/`CookMode` 360 px genişlikte (yerel başsız Chrome) kontrol edildi; geçici sayfa repoda yok.

## Miktarlar fazla boşaldı (15 Kasım, steak sandviçin yeniden çıkarılması, tarif `1794696884886-v1d2bx`)
Kaynak (kaithompson "STEAK SANDWICH" açıklaması, uygulamanın caption okuyucusuyla alındı) yalnızca 5 miktar veriyor:
2 onions, 4 tbsp mayo, 2 tbsp grainy Dijon, 2 tsp Worcestershire, 1 tbsp hot sauce. Beşi de kayıtta ve ekranda var
→ **temizlik/gösterim hiçbir miktarı silmedi.** Diğer 15 satır kaynakta miktarsız; bunları **model boş döndürdü**, çünkü
bir önceki düzeltmede prompt "kaynakta yoksa boş bırak, tahmini yalnız kaynak açıkça ima ediyorsa ver" diyordu
(fazla katı). "Ciabatta ekmeği ya da başka bir ekmek" adı da o prompt'taki örnekten geldi.
Ayrıca Haiku hatası: kaynak "Wrap 2 asparagus with 1 slice of bacon", kayıtlı adım "Her kuşkonmazı bir dilim bacon ile sarın".

Değişiklik:
- Prompt: kaynak miktarı aynen (estimated false); kaynakta yoksa bağlamdan pratik/yuvarlak öneri + `estimated: true`
  (yapay hassasiyet yok); dayanak yoksa tuz/baharat "damak zevkine göre", aksi hâlde boş. Besin hesabı tahminlerle tutarlı.
- Ad: genel tercih "ya da istediğin/başka bir/herhangi bir X" ve "(veya tercih edilen X)" → "X (tercihen)";
  "(örn. Y)" → "(Y gibi)"; belirli alternatif ("Tereyağı ya da margarin"), hazırlama ayrıntısı korunur
  (`simplifyIngredientName`; yeni kayıtta sunucuda, eski kayıtta yalnız Türkçe gösterimde).
- Ekran: tahmin içeren tarifte listenin altında tek ortak not ("Yaklaşık" yazanlar kaynakta yok; tarife göre önerildi),
  Tarif Detay + Pişirme modu. Ölçeklemede "Yaklaşık" etiketi her katsayıda kalır (test).
- Zaten kayıtlı `1794696884886-v1d2bx` tarifinin boş miktarları geri gelmez (kayıtta sayı yok); yeniden çıkarma gerekir.
