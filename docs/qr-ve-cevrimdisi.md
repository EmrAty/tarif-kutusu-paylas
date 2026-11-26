# QR ile tarif paylaşma ve internetsiz görüntüleme

Dal: `feature/qr-offline` (`feature/categories-tips-pantry` `73f1f41` üstünde; önceki
özelliklerin hepsini içerir). Tarih: 26 Kasım 2026. Main'e alınmadı, Preview'a gönderilmedi.

## 1. QR ile tarif paylaşma

**Akış.** Tarif detayı → "QR ile paylaş" → kod. Alıcı: menü → "QR ile tarif ekle" (ya da
"Yeni Tarif Çıkar" ekranındaki "QR kodundan ekle") → kamera ya da "QR'ın fotoğrafını seç" →
"Paylaşılan tarif" ekranı (özet, malzemeler, ad, kategori, kayıt yerleri) → Kaydet → tarif
detayı. AI'a hiç gidilmez. QR telefonun kendi kamerasıyla okutulursa bağlantı
(`https://tarifkutusu.app/?recipeShare=…`) uygulamanın web sürümünde aynı ekranı açar.

**Mimari.** `/api/data?resource=recipe-shares` (işleyici `api/_lib/recipeSharesHandler.js`; ayrı dosya değil çünkü Vercel Hobby dağıtım başına en fazla 12 fonksiyon kabul ediyor — 13. dosya ilk Preview dağıtımını düşürdü) + `api/_lib/recipeShares.js`, ortak kurallar
`shared/recipeShare.js`, alıcı tarafı `src/recipeShareClient.js`, tarayıcı/QR modülleri
`src/qr/` (jsQR 1.4.0, qrcode-generator 1.4.4).

| Konu | Karar |
|---|---|
| QR içeriği | Yalnızca sitenin adresi + rastgele 144 bit token (`recipe-share:<token>`). Oturum token'ı, uid, gizli anahtar yok. |
| Kayıt | Redis'te tarifin kopyası değil, işaretçi (sahip, kapsam, tarif id, süre). Her okumada kaynak yeniden doğrulanır. |
| Geçerlilik | **7 gün** (`SHARE_TTL_SECONDS`). Aynı tarif için tekrar "QR ile paylaş" aynı kodu verir (ekran görüntüsü/basılı kod süre boyunca çalışır). |
| İptal | "Paylaşımı durdur" kodu hemen geçersiz kılar; tekrar açılırsa **yeni** kod üretilir. |
| Silinen tarif | Kod artık açılmaz (tarif sahibinin listesinde aranır). |
| Hesap silme | Sahibin paylaşım kayıtları silinir (`deleteSharesOf`); ayrıca her okumada `deleted-account:` işareti ve tarifin varlığı kontrol edilir. |
| Plus kilidi | Free sınırı yüzünden kilitli tarif paylaşılamaz (403 `recipe_locked`); paylaşımdan sonra kilitlenirse kod açılmaz. |
| Aile tarifi | Paylaşan hâlâ üye + Plus olmalı (`assertFamilyAccess`); değilse kod açılmaz. Alıcıya aile erişimi verilmez, yalnızca o tarifin bağımsız kopyası. |
| Hata yanıtı | Süresi dolmuş/durdurulmuş/silinmiş/olmayan → hepsi aynı 404 `share_unavailable` (ayırt edilemez). |
| Hız sınırı | Okuma: kalıcı hesap 30/dk, 200/sa; misafir 15/dk, 80/sa. Oluşturma/durdurma: mevcut veri yazım sınırı. Kimliksiz istek 401. |
| Taşınan içerik | Beyaz liste: ad, malzemeler (bölüm, tahmini miktar işareti dahil), yapılış, püf noktaları, porsiyon ve hesap alanları (`servings*`, `portion`), süre, zorluk, besin, varsayımlar, içerik dili, kaynak link, **sabit** kategori. Gönderenin adı (`addedBy`), uid'i, favorisi, kayıt zamanı, özel kategori bağı (`categoryRef`) gönderilmez. |
| Alıcının kaydı | Yeni kimlik, alıcının adı, favori değil, kategoriyi alıcı seçer (sabit kategori önceden seçili; özel kategori taşınmaz). Kayıt normal `/api/data` yolundan → Free sınırı, aile yetkisi tek yerde. Sonradan gönderenin değişiklikleri yansımaz. |
| Tekrar okutma | Kayda `shared_from.shareId` (token değil) yazılır; aynı listede aynı paylaşımdan kopya varsa ekran "zaten eklemişsin" der ve kaydı kapatır; updater da sunucudaki güncel listede tekrar kontrol eder. Kopya silinirse yeniden eklenebilir. |
| Kendi kodu | Sahip kendi kodunu okutursa uyarı görünür ("bu tarif zaten senin listende"). |

**Kamera.** Web'de `getUserMedia` (+ `BarcodeDetector` varsa, yoksa jsQR). Android'de WebView
kamerası için `CAMERA` izni gerekir → **yeni APK** (`versionCode 17`, kamera özelliği
zorunlu değil). Eski APK'da (`build < 17`) kamera denenmez; "uygulamayı güncelle" açıklaması
ve "QR'ın fotoğrafını seç" sunulur. İzin reddi, kamera yok/meşgul, geçersiz QR ("Tarif Kutusu
paylaşım kodu değil") ve bağlantı hatası ayrı mesajlarla gösterilir. `vercel.json`
`Permissions-Policy` artık `camera=(self)`.

## 2. İnternetsiz görüntüleme

İki ayrı iş:

**a) Tariflerin cihazda saklanması** — `src/offlineCache.js` (IndexedDB `tarif-kutusu-offline`).
- Yalnızca sunucunun **onayladığı** liste yazılır (`createBucketStore({ onAccept })`: başarılı
  okuma ya da kabul edilen yazım). Bekleyen değişiklik, hata ya da boş "yüklenemedi" durumu yazılmaz.
- Kopya yalnızca **gösterim** içindir: yazma deposuna (`dataStore`) hiç girmez; çevrimdışıyken
  her değişiklik "İnternet yokken değişiklik yapılamaz" ile reddedilir. Sunucudaki liste bu kopyayla
  ezilemez (ayrıca CAS sürüm kontrolü zaten var).
- Gösterim koşulu: kişisel liste **ağ/sunucu (5xx)** hatasıyla yüklenemedi ve kopya var. 401/403/426
  çevrimdışı sayılmaz (401'de bu hesabın kopyası silinir).
- İlk kullanımda kopya yoksa: "İnternet yok ve tariflerin bu cihaza henüz indirilmedi…" bandı; boş
  liste "Kutun henüz boş" diye gösterilmez.
- Hesap ayrımı: anahtarlar `u:<uid>:…`. Oturum belli olunca başka hesapların kopyası silinir; çıkışta
  ve hesap silmede hepsi silinir.
- Aile politikası: yalnızca sunucunun son doğruladığı (üye + Plus) ailelerin kopyası tutulur; her
  başarılı aile yenilemesinde liste budanır. Çevrimdışıyken sunucudaki anlık üyelik/Plus değişikliği
  bilinemez: kullanıcı son çevrimiçi anında erişebildiği aile tariflerini görmeye devam eder (zaten
  cihazına inmiş içerik); internete dönünce (`online` olayı, açılış, resume) liste ve üyelik yeniden
  doğrulanır, erişimi biten ailenin kopyası silinir.
- Plus kilidi: kişisel kilit son bilinen Plus durumuyla (`plus-status:<uid>`) aynı şekilde uygulanır.
- Çeviri, öneri, alışveriş/kiler listeleri, paylaşım ve QR çevrimdışı çalışmaz (açık mesajla).
  Kaynak video bağlantıları açılamaz.

**b) Uygulamanın internetsiz açılabilmesi** — Service Worker (`src/sw/swLogic.js`, derlemede
`dist/sw.js` üretilir; `main.jsx` yalnızca üretimde ve paylaşım paneli dışında kaydeder).
- `/` gezinmesi: ağ önce; başarılı HTML saklanır; ağ yoksa (ya da kopya varken 4 sn'de gelmezse)
  saklanan kopya. `/assets/*` önceden ve ilk kullanımda önbelleğe; bu + bir önceki sürüm tutulur.
- Karışmadığı yerler: `/api/*`, `/version.json`, `/sw.js`, `?sharePanel=1`, başka origin'ler, POST.
- Capacitor: WebView canlı siteyi yükler; Capacitor 8 native köprüyü belge başı betiğiyle ekler,
  önbellekten açılan sayfada da çalışır (emülatörde doğrulandı). Eski WebView'lerde köprü HTML'e
  enjekte edilir; kabuk yalnızca gerçek gezinme yanıtından saklandığı için o da korunur.
- Güncelleme: `version.json` bandı ve "Şimdi Güncelle" aynen çalışır (gezinme ağdan gelir).
- **Yeni APK gerekmez** (saf web); eski APK'lar ve tarayıcı da yararlanır.
- Acil geri dönüş: `TK_DISABLE_SW=1` ile derlenip yayınlanırsa `sw.js` önbellekleri silip kendini
  kaldırır.

## 3. Yapılan doğrulamalar (26 Kasım)

- `npm run check`: lint + 617 test + build temiz. Yeni testler: `test/recipeShares.test.mjs`
  (gerçek `/api/data?resource=recipe-shares` + `/api/data` + istemci deposu), `test/offlineCache.test.mjs`,
  `test/serviceWorker.test.mjs`, `src/qr/*.test.mjs` (jsQR gidiş-dönüş), `test/localStack.test.mjs`,
  yetki sözleşmesi tablosuna yeni uç.
- **Gerçek Chrome** (başsız, iki ayrı profil = iki misafir hesap, gerçek Firebase oturumu, yerel
  yığın `scripts/local-stack.mjs`: gerçek api işleyicileri + bellek Redis): `scripts/e2e-browser.mjs`
  18/18 — QR penceresi; ekran görüntüsündeki QR uygulamanın çözücüsüyle doğru bağlantıya çözüldü;
  sunucu kapatılıp sayfa yeniden açılınca uygulama SW'den açıldı, kayıtlı liste + bant + detay +
  pişirme modu (porsiyon adımı); dönüşte bant kalktı; B bağlantıyla tarifi kaydetti (bölüm/tahmini
  miktar/porsiyon korundu, yeni kimlik), aynı kod tekrar → "zaten eklemişsin", durdurulan kod
  açılmadı; hesap değişiminde önceki hesabın cihazdaki kopyası silindi.
- **Android emülatörü** (Android 14, WebView 113, yerel yığına bağlanan geçici debug APK; commit'lenmedi):
  uygulama tamamen kapatılıp uçak modu + sunucu kapalıyken açıldı → liste, bant, detay, pişirme modu
  ve Capacitor köprüsü çalıştı, sunucuya istek gitmedi; bağlantı dönünce liste sunucudan geldi.
  Kamera: Android izin penceresi açıldı, reddedince uygulama içi açıklama + görsel seçeneği, izin
  verilince emülatör kamerasından canlı görüntü, kapatınca kamera bırakıldı. SW kayıtlıyken paylaşım
  paneli internetsiz açılınca kendi native "bağlanılamadı" ekranını gösterdi.
- **Yapılmayanlar:** gerçek telefonda hiçbir şey denenmedi; emülatörde gerçek bir QR kameraya
  okutulmadı (çözücü ekran görüntüsünden doğrulandı); galeriden görsel seçme yolu cihazda denenmedi;
  eski APK'daki "güncelle" mesajı cihazda görülmedi (yalnızca sürüm kontrolü kodu); iOS yok;
  Preview/production'da deneme yapılmadı.

## 4. Telefon test listesi (Tarif TEST v17, Preview bu dala bağlanınca)

APK: `C:\Users\emrea\tk-preview-apk\tarif-test-qr-offline-v17.apk` (dal `preview-test-apk-qr`,
`com.tarifkutusu.app.preview`, Preview koruma anahtarı local.properties'ten). Eski Tarif TEST'in
üstüne kurulur (aynı paket ve debug anahtarı). Preview şu an `feature/categories-tips-pantry`'de:
bu dala bağlanmadan yeni ekranlar görünmez.

1. İki telefon (ya da telefon + tarayıcı): A tarif detayında "QR ile paylaş"; B menüden "QR ile tarif
   ekle" → kamera izni → okut → ad/kategori/yer → Kaydet. Malzeme bölümleri, "Yaklaşık" miktarlar,
   püf noktaları, porsiyon aynı mı?
2. B aynı QR'ı tekrar okutsun → "zaten eklemişsin". A tarifini değiştirsin → B'ninki değişmesin.
3. A "Paylaşımı durdur" → B okutunca "artık geçerli değil".
4. Kamera izni reddi ve tekrar deneme; "QR'ın fotoğrafını seç" ile ekran görüntüsünden ekleme.
5. Play'deki eski sürümle (v16) "QR ile tarif ekle" → "uygulamayı güncelle" açıklaması + görsel seçeneği.
6. Uygulamayı açıp tarifler yüklendikten sonra kapat → uçak modu → aç: liste, bant, detay, pişirme modu,
   porsiyon değiştirme. Favori/düzenleme denemesi → "internet yokken değişiklik yapılamaz".
7. Uçak modunda paylaşım menüsünden TikTok linki → panel "bağlanılamadı" (değişmemeli).
8. İnternet açılınca bant kalkıyor mu; "Şimdi Güncelle" bandı yeni deploy sonrası çalışıyor mu.
9. Aile: Plus kapat ya da aileden çık → çevrimiçi aç → sonra çevrimdışı aç: o ailenin tarifleri artık görünmemeli.
10. Hesap değiştir / çıkış → çevrimdışı açılışta önceki hesabın tarifleri görünmemeli.

## 5. Bilinen sınırlamalar

- Çevrimdışı düzenleme/eşitleme kuyruğu yok (bilinçli). Görseller ve video bağlantıları çevrimdışı açılmaz.
- iOS: WKWebView'de Service Worker yalnızca App-Bound Domains ile çalışır; iOS kabuğu zaten tamamlanmadı.
- Çevrimdışı aile erişimi son çevrimiçi duruma göredir (yukarıdaki politika).
- QR okuma Android WebView'de pratikte jsQR ile (BarcodeDetector genelde yok); düşük ışıkta yavaşlayabilir.
- Paylaşım kaydında içerik kopyası tutulmaz: kod okutulduğu andaki güncel tarif gelir.
- Yeni Play sürümü (v17) kamera izni içerir: Play Console'da izin beyanı gerekmez (kamera özel izin
  değil) ama Data Safety'de veri toplanmadığı (görüntü cihazda işlenir) değişmez.
