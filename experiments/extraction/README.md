# Ucuz tarif çıkarma denemesi (14 Kasım 2026)

Dal: `experiment/cheap-extraction` (worktree `C:\Users\emrea\tk-clone-extract-exp`, taban `712dfc8`).
Main / production / Preview'a dokunulmadı; commit yok.

## Ne ölçüldü, ne ölçülemedi
- **Ölçüldü (ücretsiz):** gerçek TikTok açıklamaları (uygulamanın kendi `tiktokCaption` kodu), kural tabanlı
  ayrıştırıcı + deterministik kapı, kaynak-temelli doğrulayıcının mantığı (yapay hatalarla).
- **Ölçülemedi:** hiçbir model çağrısı yapılmadı. Bu makinede `ANTHROPIC_API_KEY` yok, hesabın kredisi bitmiş
  (bkz. GROUP5_NOTES §10) ve tanımlı bir test bütçesi yok. Haiku/Sonnet kalite, süre ve token sayıları
  aşağıda **tahmin** olarak işaretli.

## Veri
- Geliştirme kümesi `corpus.json` (33): madde işaretli, numaralı, işaretsiz düz liste, çok bölümlü,
  İngilizce, düzyazı, tarifsiz. Gold etiketler `gold.mjs` (Claude bu oturumda elle etiketledi).
- **Ayrı test kümesi** `corpus-test.json` (27, 1'inin sayfası okunamadı): ayrıştırıcı dondurulduktan sonra
  toplandı, etiketleri (`gold-test.mjs`) ayrıştırıcı çalıştırılmadan yazıldı. Dondurulan sürümün özeti
  `codeParser.frozen.sha256`.
- **Kaynak kısıtı:** 60/60 açıklamada satır sonu yok. TikTok `itemStruct.desc` alanı satırları kaynakta
  siliyor (ham sayfada da yok); izi yalnızca çift boşluk (25/33).

## Kod katmanı (AI'sız) sonuçları
| | Geliştirme (33) | Ayrı test (27) |
|---|---|---|
| Kapıdan bağımsız tam doğru ayrıştırma (liste tarifleri) | 19/27 | **8/24** |
| Ortalama malzeme recall | 0,98 | 0,87 |
| Katı kapı kabulü (uygulama dili = açıklama dili) | 9/33, yanlış kabul 0 | **2/27, yanlış kabul 0** |
| Gevşek kapı kabulü | 15/33, yanlış kabul 2 | 3/27, yanlış kabul 1 |
| Süre | ~3–4 ms / açıklama | aynı |

Geliştirme ile test arasındaki fark ezberi gösteriyor: kurallar görülmemiş biçimlere genellenmiyor.
Test kümesindeki tipik red nedenleri:
- bardak ölçüsü / verim notları ("Kullandığım su bardağı 200 ml", "12 adet çıkıyor"),
- tek satırda virgülle sayılan baharatlar,
- "Birer yemek kaşığı", "Bir baş", "1 silme çay kaşığı" gibi ifadeler,
- 📌 madde işareti,
- tanıtım ve indirim metinleri,
- başlıksız yapılış.

Kod katmanının mevcut davranıştan farkları:
- Besin değeri yok.
- `portion` sınıflaması yok, dolayısıyla porsiyon hesabı yok (`servings_basis: "bilinmiyor"`).
- Başlık sezgisel ya da boş.
- Zorluk ve süre yok.
- Uygulama diline çeviri yok (dil farkında kapı reddeder).
- Yalnız yapılışta geçen malzemeler (ör. c01 çikolata, t09 başlıktaki salça) eklenmez.
- Bardak ölçüsü notu `assumptions`'a gitmez.

## Doğrulayıcı (ucuz model güvenlik ağı) — yalnız mantık testi
Doğru çıktılar olarak, kod ayrıştırıcısının tam doğru çıkardığı 27 tarif kullanıldı (kaynaktan birebir).
Bunlara yapay hatalar eklendi. Sonuçlar gerçek model çıktısı DEĞİL.
- Doğru çıktıya gereksiz alarm: 6/27. Çoğu, çıktının düşürdüğü gerçek bilgi (bardak ölçüsü, verim notu,
  püf noktasındaki ölçü).
- Yakalama oranları (doğru hâlini geçirdiği tarifler üzerinden):

| Yapay hata | Yakalanan |
|---|---|
| Uydurma malzeme | 21/21 |
| Yapılış silinmesi | 16/16 |
| Miktar değişimi | 18–19/21 |
| Miktar silinmesi | 16/21 |
| Malzeme düşmesi | **14/21** |

- Gerçek model adımları yeniden yazdığı için V4 eşiğinin (%50 kelime örtüşmesi) gereksiz yükseltme oranı
  bilinmiyor; ücretli denemede kalibre edilmeli.

## Maliyet ve süre (TAHMİN)
Fiyatlar: Sonnet 5 için $2 / $10, Haiku 5.5 için $0,10 / $0,50 (MTok başına).
Girdi token'ı ≈ karakter / 3 (ölçülmedi). Sonnet çıktısı canlıda ölçülen 1709 token (986'sı düşünme).

| Yöntem | Tarif başı | Not |
|---|---|---|
| Bugünkü (Sonnet 5, adaptive) | ~$0,024 | 11–15 sn (canlı ölçüm) |
| Sonnet 5, düşünme kapalı | ~$0,014 | tek model, yönlendirme yok; kalite ölçülmedi |
| Haiku 5.5 | ~$0,001 | süre/kalite ölçülmedi |
| Haiku → doğrulayıcı → gerekirse Sonnet | $0,001 + p × $0,024 | p = yükseltme oranı; başa baş p ≈ %96 |

Yükseltilen tariflerde süre Haiku + Sonnet olur (iki çağrı arka arkaya).
Kod katmanını öne koymak, %8 kapsamla tarif başına ~$0,0001–0,002 kazandırır. Besin değeri, porsiyon
ve başlık kaybına değmez.

## Ücretli denemeyi çalıştırmak (bütçe onayıyla)
```
node runModels.mjs --dry-run                      # ~$2,3 (59 açıklama × 4 yapılandırma, tahmin)
ANTHROPIC_API_KEY=… node runModels.mjs --budget-usd 5
```
- Çıktılar `results-models.json` ve `report-models.json` dosyalarına yazılır.
- Rapor şunları içerir: otomatik doğruluk, doğrulayıcı geçiş oranı, yükseltme oranı, p50/p90 süre,
  başarılı tarif başına $.
- `scoreModel` otomatiktir ve adımların içeriğini puanlamaz. Adımlar, besin değeri ve porsiyon için
  `results-models.json` elle gözden geçirilmeli.
