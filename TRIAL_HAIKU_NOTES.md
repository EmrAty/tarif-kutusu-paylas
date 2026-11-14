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
| 1 | | | | | | | | | |
