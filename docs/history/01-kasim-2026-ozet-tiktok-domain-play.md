# Kasım 2026 özeti, TikTok açıklama regresyonu, custom domain + hesap silme, Google Play hazırlığı (25 Ekim – 11 Kasım 2026)

> CLAUDE.md'den 13 Kasım 2026'da birebir taşındı (satır 11–139). Tarihsel kayıttır; güncel kurallar için kökteki `CLAUDE.md`. Burada yazan durumlar o tarihteki durumdur.

## 📌 GÜNCEL ÖZET (10 Kasım 2026) — aşağıdaki eski bölümlerle çelişirse bu geçerlidir

İşaretler: **[repo]** = repo/git ile doğrulandı, **[canlı]** = production'a istek atılarak doğrulandı, **[kullanıcı]** = Emre bildirdi, repodan doğrulanamaz.

**Domain**
- Production: `https://tarifkutusu.app`, `www.tarifkutusu.app` de ayarlı ve 200 dönüyor. **[canlı]** Capacitor `server.url` ve `ShareActivity` `PANEL_URL`/`PANEL_HOST` yeni domainde. **[repo]**
- `tarif-kutusu-paylas.vercel.app` artık production değil. Kaynak kodda geçmiyor, yalnızca bu dosyadaki eski notlarda ve eski build çıktılarında var. **[repo]**

**Yasal sayfalar** (`app/public/*.html`, `app/vercel.json` rewrite'ları; geliştirici TK Studio, destek `tkworkss10@gmail.com`)
- https://tarifkutusu.app/privacy, /delete-account, /terms → üçü de 200. **[canlı]** Terms `0e087b0` ile eklendi. **[repo]**

**Google Play**
- Developer hesabı açık, uygulama `com.tarifkutusu.app` oluşturuldu. **[kullanıcı]**
- Mağaza kurulumu büyük ölçüde tamam: privacy, hesap silme URL'si, review giriş bilgileri, reklam beyanı, içerik derecelendirmesi, hedef kitle, Data Safety, Advertising ID, sağlık beyanı, kategori, iletişim, trader beyanı, terms, store listing, ikon, feature graphic, telefon ekran görüntüleri. **[kullanıcı]**
- **v16 hazırlandı ve Play'e yüklendi.** `build.gradle`: `versionCode 16`, `versionName "15.5"` (commit `d8f38c2` "Prepare Android 15.5 closed-test release"). **[repo]** Play Console: kapalı test kanalı `alpha`, durum "mevcut", rollout %100. **[kullanıcı]**
- Şu anki aşama: **kapalı test, tester opt-in.** Yeni kişisel hesap olduğu için üretime geçmek için **en az 12 tester × 14 gün kesintisiz opt-in** gerekiyor. Tester'ların her gün açması zorunlu değil ama gerçek kullanım ve geri bildirim tercih ediliyor. **[kullanıcı]**

**İmzalama**
- Upload keystore aynı kalıyor. `local.properties` ve `android.keystore` git dışında (`app/android/.gitignore`). **[repo]** İçerikleri asla yazdırılmaz veya commit edilmez.
- Play App Signing kullanılıyor.
- ⚠️ **AÇIK İŞ (yapılmadı):** Play App Signing ekranındaki SHA-1/SHA-256 değerlerinin Firebase Android uygulamasına eklendiği **doğrulanmadı**. Play'den kurulan uygulamada Google Sign-In buna bağlı. Ayrıntılar aşağıdaki "Google Play hazırlığı" TODO'sunda.

**Hesap silme:** ✅ Tamamlandı. Production'da tek kullanımlık hesapla gerçek test geçti (ayrıntı: aşağıdaki 31 Ekim bölümü).

**Free/Plus:** Free kişisel tarif limiti 15 (`app/shared/limits.js`), Plus sınırsız. Limitin üstündeki tarifler silinmez, kilitli görünür; Plus açılınca kilit kalkar. Backend'de `api/data.js` ve `api/recipe-jobs.js` (`_lib/profile.js` üzerinden) uyguluyor. **[repo]**

**TikTok açıklama düzeltmesi:** `822af0e` + `1a77939` canlıda. `tiktok.js` `tiktokCaption` (sayfadaki `itemStruct.desc` + `author.uniqueId`, kısa linkler redirect ile çözülüyor), `fetch-caption.js` önce sayfa sonra oEmbed, bulunamazsa 502. `recipe-jobs.js` ve `SharePanel.jsx` TikTok'ta boş açıklamaya izin veriyor; Instagram/YouTube aynı. `npm test` **94/94** (10 Kasım'da yeniden koşuldu). **[repo]** Ayrıntı aşağıdaki TikTok bölümünde.

**`ANTHROPIC_API_KEY` (Vercel production):** 10 Kasım sabahına kadar (son 401: job `rpw64u`, ~09:41 TR) tüm job'lar `401 invalid x-api-key` ile düşüyordu; Vercel'de anahtar o sırada hâlâ "Added Sep 2" görünüyordu. Sonradan kullanıcı anahtarı yeniledi ve telefonda tarif oluşturmanın yeniden çalıştığını bildirdi. **[kullanıcı]** Anahtar değeri hiçbir çıktıda gösterilmez.

**Bildirimler — `3fbd312` (10 Kasım, push'lu):** Kök sebep: 401 gibi hızlı hatalarda job ~0,1 sn'de `failed` oluyor, "Tarif oluşturulamadı" bildirimi paylaşım paneli hâlâ açıkken gidiyordu. Uygulama ön planda sayıldığı için Android bildirimi göstermiyordu (Capacitor'da `presentationOptions` yok). Düzeltme (yalnızca sunucu, yeni APK gerekmez): `recipe-jobs.js` bildirimi job başladıktan en az 5 sn sonra gönderiyor (başarı ve hata yolu), hata yolunda FCM sonucu da job kaydının `notify` alanına yazılıyor; `tiktok.js` zaman aşımları artık gövde okumayı/video indirmesini de kapsıyor (takılan indirme job'ı `processing`'de bırakamaz). FCM hatası job sonucunu değiştirmiyor. Testler: `test/recipeJobsLifecycle.test.mjs`, `npm test` 104/104. Kalan bilinen sınır: kullanıcı ana uygulamanın içindeyken gelen bildirim yine sistem çubuğunda görünmez (çözümü native → yeni APK).

**Veri kaybı düzeltmesi — sürümlü veri kovaları (11 Kasım 2026, COMMIT EDİLMEDİ, kullanıcı onayı bekliyor) [repo]:**
- Sorunlar (Fable denetimi): (1) okuma hatası boş liste sanılıp mevcut tariflerin üzerine yazılıyordu (12 → 1), (2) iki cihaz/aile üyesi/arka plan job'u aynı listeyi yazınca son yazan diğerini siliyordu. İkisi de eski kodla yeniden üretildi, yeni kodla oluşmuyor.
- Sunucu: `api/_lib/versionedBucket.js` — veri eski anahtarında (`user:<uid>:recipes` vb.), yanında `<key>:version` sayacı. Sayaç yoksa veri varsa sürüm 1, yoksa 0 (tembel geçiş, okuma hiçbir şey yazmaz). Yazım = Lua betiğiyle atomik karşılaştır-ve-yaz (Upstash `EVAL`); aynı betik önceki hâli `<key>:backups` (son 5) ve `<key>:daily-backups` (günün ilk hâli, son 7 gün, hash) içine yedekler (8 gün TTL). `api/data.js`: GET `{value, version}` (okuma hatası 5xx, asla `null`), POST `baseVersion` zorunlu (yoksa 426 `client_outdated`), eski sürüm → 409 `version_conflict` + güncel değer/sürüm. Recipe job'ları `mutateBucket` ile (oku → niyeti uygula → CAS, çakışmada tekrar). `_lib/jobRecipes.js` / `pendingJobRecipes` kaldırıldı (eski anahtarlar hâlâ aile/hesap silmede temizleniyor).
- İstemci: `src/syncedBuckets.js` (React'ten bağımsız depo): durum `idle/loading/ready/error` + `stale`; değişiklikler niyet (updater), kova başına sıralı, çakışmada güncel veriye yeniden uygulanıp en çok 4 deneme. Yüklenemeyen kovada değişiklik yapılmaz (`not_loaded`). Tarifler, alışveriş listesi, kiler, eski veri aktarımı bu depoyu kullanıyor; listede "Tekrar dene" kutuları.
- Geçiş güvenliği (`src/updateRequired.js`): herhangi bir yazım 426/`client_outdated` alırsa uygulama genelinde `appUpdateGate` kapanır → değişiklik geri alınır, sonraki tüm yazımlar (depo + `authedFetch` POST/DELETE) sunucuya gitmeden reddedilir, kapatılamayan "Tarif Kutusu güncellendi / Yenile" penceresi çıkar (Android geri tuşu yalnızca arka plana alır). Mevcut "güncelleme var" bandıyla aynı `reloadApp`; yenileme yalnızca dokununca, aynı paket yine reddedilirse "kapatıp aç" uyarısı (döngü yok). ⚠️ Şu an telefonlarda çalışan ESKİ paket bu kodu içermez; onu yalnızca sunucunun 426'sı (veri kaybı yok) + mevcut bant korur.
- Testler: `test/dataConsistency.test.mjs` (24 senaryo, gerçek Lua `fengari` ile — yeni devDependency), `test/helpers/memoryRedis.mjs`. `npm test` 128/128, `vite build` temiz. Yalnızca web/sunucu → yeni APK gerekmez. Yedekten geri yükleme şimdilik elle (Redis'te `<key>:backups` / `<key>:daily-backups`, biçim `<sürüm>|<ms>|<JSON>`).

**Telefonda henüz doğrulanmayanlar (tamamlanmış sayılmaz):** Share Panel aile seçimi, porsiyon gösterimi, İngilizce çeviri, TikTok job sonrası push bildirimi.

**Store görselleri:** İkon, feature graphic, telefon ekran görüntüleri hazırlandı (aynı iPhone tarzı çerçeve; koyu orman yeşili / krem / hardal-altın palet). AI ile üretilen/düzenlenen görseller Play'de AI beyanıyla etiketlendi. Bloklayıcı değil. **[kullanıcı]**

**iOS:** Tamamlanmadı. Capacitor iOS projesi repoda var (`app/ios/App`, `GoogleService-Info.plist` dosyası da mevcut) ama Mac/Xcode işlemi hiç yapılmadı. **[repo]** Yapılacaklar: Apple Developer Program, App Store Connect, Xcode build + imzalama, Firebase iOS yapılandırmasının doğrulanması, APNs/FCM, Google Sign-In iOS, gerekirse Sign in with Apple, iOS Share Extension, TestFlight. Apple'da 12 tester / 14 gün şartı yok. (iOS uygulama adı notu için 26 Eylül bölümüne bak.)

**Kilitli kartlar + Plus modalı (10 Kasım 2026, hepsi main'de, yalnızca web → yeni APK gerekmez) [repo]:**
- `c733130` Kilitli tarif kartları: soluklaştırma yerine kartın üstüne `COLORS.forest` örtü (opaklık 0.78) + ortada hardal `Lock`. Ortak `LockedOverlay` bileşeni; kenar çubuğu (liste/arama/kategoriler/favoriler grubu), Favoriler ekranı ve Elimde Bunlar Var aynı bileşeni kullanıyor. Kilitli satırda çöp kutusu örtünün üstünde, çalışıyor. Kilit mantığı (`recipeLocks.js`) değişmedi.
- `506f6f7` Yeni `PlusModal` (eski `PlusView` ve onun Plus ekranı kaldırıldı). Kilitli karta dokunma, yan menü Plus, ücretsiz limit penceresi ve Aileler'deki "Plus'a Geç" aynı modalı açar (`modalView === "plus"`, kapanış `closeModal()`; X / arka plan / Escape / Android geri). Aylık/Yıllık yalnızca modal state'i; fiyatlar `PLUS_PRICE_PLACEHOLDER` (`₺XX,XX` / `₺XXX,XX`), gerçek fiyat değil. "Satın alımları geri yükle" ve "Kodun var mı?" işlevsiz (`plusNotConnected`). Metinler `i18n.jsx` → `plusModal.*`.
- **GEÇİCİ — CLOSED TEST:** ana CTA eski test anahtarını çalıştırıyor (`onToggleTest` → `setPlusFlag` + `rememberPlusStatus` + `loadFamiliesState`; `/api/profile` `isPlus`). Free'de "Plus’a Geç", Plus'ta "Plus’ı Kapat (test)". Gerçek ödeme (RevenueCat / Play Billing / StoreKit) bağlanınca bu kaldırılıp CTA satın almaya bağlanacak. Ödeme altyapısı HENÜZ YOK.
- `a103880` + `fe9e275` Modal kenardan kenara alt sheet: sol/sağ/alt 0, yalnızca üst köşeler 28 px, `maxHeight: 90dvh`, alt güvenli alan içeriğin padding'inde, `scrollbarGutter: stable both-edges`. Tutamaçtan sürükleyerek kapatma (Pointer Events; eşik yüksekliğin %22'si veya ≥0,6 px/ms ve ≥24 px; açılış/kapanış animasyonu dış sarmalayıcıda, sürükleme iç sheet'te). X yalnızca ikon, 44×44 dokunma alanı; açılışta odak diyalogda.
- `429d089` Avantaj ikonları iki renkli (`PlusDuoIcon`: forest gövde + mustard vurgu).
- `f7b6646` Üst ikon artık kullanıcının verdiği PNG: `app/public/tarif-kutusu-plus-sef-sapkasi.png` (205×178, şapka + 2 yıldız). 88 px; şapka gövdesi PNG'de x 3–171 olduğundan `translateX(7.561%)` ile gövde merkezi sheet merkezine hizalı (360/390 px'te 0 px fark ölçüldü).
- Telefonda doğrulanmayanlar: tutamaçla sürükleyerek kapatma (yalnızca tarayıcıda sentetik olaylarla denendi), Android geri tuşu ile modal kapanışı, en alttaki güvenli alan boşluğu.

### Açık işler — öncelik sırası
0. Deploy sonrası telefonda Plus modalı: görünüm, sürükleyerek kapatma, geri tuşu, test CTA ile Plus aç/kapat → kilitler açılıp kapanıyor mu.
1. ~~Vercel `ANTHROPIC_API_KEY`~~ → kullanıcı yeniledi, tarif oluşturma telefonda çalışıyor **[kullanıcı]**. `3fbd312` deploy edildikten sonra hızlı hata bildiriminin telefonda göründüğü henüz doğrulanmadı.
2. Telefonda TikTok → Paylaş → Tarif Kutusu: başarı bildirimi ve (bilerek hatalı bir linkle) hata bildirimi görünüyor mu, job kaydındaki `notify` alanıyla birlikte kontrol et.
3. Play App Signing SHA-1/SHA-256 değerleri Firebase'de mi, doğrula. Sonra Play sürümünde Google Sign-In'i dene.
4. Kapalı testte tester opt-in durumunu takip et (12 tester × 14 gün).
5. Share Panel aile seçimi / porsiyon / İngilizce davranışını telefonda doğrula.

## 🔖 TikTok paylaşımında açıklama regresyonu düzeltildi (9–10 Kasım 2026) — CANLIDA (`822af0e`, `1a77939`); o sıradaki 401 engeli sonradan kullanıcı tarafından giderildi (bkz. Güncel Özet)

**KALDIĞIMIZ YER (10 Kasım 2026, 00:45 TR) — bir sonraki oturumun ilk işi:**
- İki commit main'de ve production'da: `822af0e` (sayfadan caption, 502, panel/job boş açıklama izni) ve `1a77939` (TikTok boş 200 sayfasında bir kez daha deneme; panel boş açıklama gönderdiyse job sayfadaki açıklamayı kullanır; `tiktokTranscript` → `method: "caption"`). `npm test` 94/94.
- Canlı `/api/fetch-caption` (`@dyt.eminolcekci/video/7683866855714376978`): 5 istekte 3×200 (1118 karakter), 2×502 — TikTok aynı video için aralıklı olarak video verisi olmayan 200 sayfa döndürüyor; ikinci deneme her zaman kurtarmıyor.
- **Kullanıcının telefon testi (Play kapalı test, 00:34 TR) başarısız oldu ve sebebi caption DEĞİL:** `POST /api/recipe-jobs` 200 ile kabul edildi (job `1794260043992-afygu1`), 122 ms sonra `Claude API hatası (401): invalid x-api-key` ile `failed`. 00:08–00:36 arası 6 job'ın hepsi ve bir `/api/extract` çağrısı aynı 401'i aldı. Kod anahtara dokunmadı → **Vercel'deki `ANTHROPIC_API_KEY` geçersiz/iptal; kullanıcı yenileyip redeploy etmeli (Claude anahtar girmez).** Anahtar yenilenmeden hiçbir tarif job'ı tamamlanamaz.
- FCM: hesapta 1 kayıtlı cihaz. Başarısız job'da gönderilen "Tarif oluşturulamadı" bildiriminin sonucu loglara/job kaydına yazılmıyor (yalnızca başarılı yolda `notify` var) — ulaşıp ulaşmadığı doğrulanamadı; istenirse küçük bir teşhis eklenebilir.
- Vercel Hobby: log aralığı en fazla "Last hour"; Request Logs için URL'ye `&datasource=legacy-logs` eklenir. Redis job kaydı Storage → Browse data → `*afygu1*` ile okundu.
- Sonraki adım: anahtar yenilenince aynı videoyla telefon testi; başarılı olursa bu bölüm "tamamlandı" yapılacak. Yeni APK gerekmiyor.


**Kök sebep:** TikTok'un oEmbed ucu (`https://www.tiktok.com/oembed?url=…`) artık `title`/`author_name` döndürmüyor (yalnızca embed HTML'i; üç ayrı videoyla doğrulandı). `app/api/fetch-caption.js` `data.title || ""` ile **200 + boş caption** dönüyordu; Share Panel ve "Yeni Tarif Çıkar" bunu "açıklama alınamadı" sayıp alanı boş bırakıyordu → kullanıcı "Tarifi Çıkar"da ekran görüntüsü/not isteyen hatayı görüyordu. Bizim kodda değişiklik yoktu, TikTok tarafı değişti.

**Düzeltme (sunucu + web, native değişiklik YOK → yeni APK gerekmez):**
- `app/api/_lib/tiktok.js`: yeni `tiktokCaption(url)` — mevcut `loadVideoPage` (iPhone UA, `redirect: "follow"`) ile sayfadaki `itemStruct.desc` + `author.uniqueId` okunur; `vt.tiktok.com`/`vm.tiktok.com` kısa linkleri redirect ile çözülür (`resolvedUrl`). Sayfa alınamazsa null.
- `app/api/fetch-caption.js`: TikTok'ta önce sayfa, sonra oEmbed (yalnızca `title` varsa). Açıklama bulunamazsa artık **502** (eskiden 200 + boş). Instagram/YouTube yolları aynı.
- `app/api/recipe-jobs.js`: TikTok linkinde boş açıklama kabul ediliyor (job zaten altyazı/konuşma metnine düşüyor, ikisi de yoksa `failed`; uydurma yok). Instagram/YouTube'da "Açıklama boş olamaz." aynen.
- `app/src/SharePanel.jsx`: TikTok linkinde açıklama boşken de "Tarife Ekle" gönderilebiliyor; diğer kaynaklarda eski hata mesajı.
- **Yapılmayan:** uygulama içi "Yeni Tarif Çıkar" (`/api/extract`) için açıklama/not/görüntü zorunluluğu korundu — o uçta link üzerinden içerik çeken bir fallback yok, boş girdiyle Claude tarif uydururdu.
- Testler: `app/test/fetchCaption.test.mjs`, `app/test/recipeJobsCaption.test.mjs` (`npm test` → 92/92). Canlı doğrulama (yerelden): tam link 1,1 sn, `vm.tiktok.com` kısa link 1,7 sn ile açıklama geldi; YouTube oEmbed değişmedi.

## 🔖 Custom domain + hesap silme + gizlilik sayfaları (31 Ekim 2026)

**Production domain artık `https://tarifkutusu.app`** (commit `9981d58`, push'lu). `app/capacitor.config.json` `server.url`, `ShareActivity.java` `PANEL_URL`/`PANEL_HOST` ve kökteki GitHub Pages shim'i (`share.html`) yeni domainde. API çağrıları zaten relative; Firebase `authDomain` (`tarif-kutusu.firebaseapp.com`) ve FCM linkleri (relative) değişmedi. Vercel'de `tarifkutusu.app`, `www.tarifkutusu.app` ve eski `tarif-kutusu-paylas.vercel.app` üçü de Production'a bağlı (apex www'ye yönlendirmiyor — ShareActivity host'u birebir karşılaştırdığı için yönlendirme paneli bozardı). Firebase Authorized Domains: `tarifkutusu.app` + `www.tarifkutusu.app` eklendi. Aşağıdaki notlarda geçen `tarif-kutusu-paylas.vercel.app` **eski production domain**dir.

**v15 / v16 (Play):** _(⚠️ ESKİ: v16 artık hazırlandı ve Play `alpha` kanalında, bkz. en üstteki Güncel Özet.)_
- v15 (`versionCode 15`, mevcut imzalı AAB ve sideload APK) hâlâ eski `tarif-kutusu-paylas.vercel.app`'i açıyor. Bu domain Türkiye'de erişim sorunu yaşıyor (bu makineden de "connection reset"), yani v15 yeni production web sürümüne güvenilir şekilde erişemez.
- Custom domain native config'de (Capacitor `server.url` + ShareActivity) olduğu için **yeni Android AAB şart.** Bir sonraki Play build'i **`versionCode 16`** olmalı (henüz yapılmadı; AAB komutu aşağıdaki Google Play bölümünde).
- Uygulama içeriği sunucudan yüklendiği için hesap silme / gizlilik linki gibi web değişiklikleri v16 kurulu her telefona push ile gelir.

**Hesap silme (Google Play account deletion şartı):**
- `DELETE /api/account` (`app/api/account.js`, mantık `app/api/_lib/accountDeletion.js`). uid yalnızca doğrulanmış ID token'dan. Sıra: `deleted-account:<uid>` işareti (24 saat TTL) → aile üyelikleri → `user:<uid>:*` (sabit liste + SCAN) ve `job:`/`job-req:`/`job-url:` kayıtları → profil en son → Firebase kullanıcısı en son (Identity Toolkit `accounts:delete`, servis hesabı token'ı `app/api/_lib/googleAuth.js` — FCM de artık bunu kullanıyor). Tekrar çağrılabilir; `USER_NOT_FOUND` başarı sayılır. Hata → 500 `account_delete_failed`, genel mesaj.
- Aile kuralı: tek üyeyse aile + tüm aile verisi + davet kodu silinir; başka üyeler varsa aile ve ortak listeler kalır, kullanıcı üyelikten çıkar; sahipse sahiplik **en eski katılan** üyeye (`joinedAt`, eşitlikte uid) geçer.
- `requireUser` silinmiş hesabın hâlâ geçerli token'ını reddeder (`allowDeleted` yalnızca `/api/account`'ta). `recipe-jobs.js` job sürerken silinen hesaba tarif yazmaz, yazdıysa geri alır, job kaydını siler.
- Uygulama: Hesabım ekranının altında "Hesabı Sil / Delete Account" kartı + onay penceresi (`DeleteAccountModal`); başarıda cihazdaki hesap kayıtları (plus-status, person-name, share-panel-has-families) temizlenir, oturum kapanır, sayfa yeniden yüklenir. Ayarlar'da "Gizlilik Politikası / Privacy Policy" linki (`PRIVACY_POLICY_URL`).
- Testler: `app/test/accountDeletion.test.mjs` (`npm test`'e dahil; bellek içi Redis + sahte Google/Anthropic, gerçek sisteme istek atmaz).

**Gizlilik / hesap silme sayfaları:** `app/public/privacy.html`, `app/public/delete-account.html` (+ sonradan `terms.html`, `0e087b0`), ortak `legal.css`; `app/vercel.json` `/privacy` ve `/delete-account`'u bu dosyalara rewrite eder (projede SPA fallback yok). Statik HTML, JS yok, giriş istemez. Geliştirici: TK Studio, destek e-postası `tkworkss10@gmail.com` (geçici; değişirse iki sayfada `mailto` dahil 4 yerde).

**✅ TAMAMLANDI — production hesap silme testi (31 Ekim 2026, commit `8846efc` canlıdayken):**
- Tek kullanımlık misafir (anonim) hesapla gerçek uçtan uca silme testi geçti (gerçek kullanıcılarla test yapılmadı).
- Firebase kullanıcısı gerçek sunucu çağrısıyla silindi (`USER_NOT_FOUND` ile doğrulandı) — servis hesabının kullanıcı silme yetkisi var.
- Test hesabına ait Redis kullanıcı verisi tamamen temizlendi (profile, recipes, shopping-list, pantry-items, fcmTokens); yalnızca 24 saatlik `deleted-account:<uid>` işareti kaldı.
- Tek üyeli test ailesi (meta, members, recipes, shopping-list) ve davet kodu tamamen silindi.
- Başka kullanıcı verisine dokunulmadı (Redis 92 → 83 anahtar: test hesabının 10 anahtarı silindi, 1 işaret eklendi).
- Eski token bütün ilgili API'lerde (data okuma/yazma, profile, families, aile verisi, recipe-jobs) 401 "Bu hesap silindi." aldı.
- İkinci `DELETE /api/account` çağrısı güvenli/idempotent şekilde 200 döndü (`firebase: "already_deleted"`).
- `/privacy` ve `/delete-account` production'da 200, doğrudan açılış/yenileme çalışıyor.
- `npm test` 78/78, `vite build` temiz.
- **Google Play account deletion şartı production'da doğrulandı.**
- Doğrulanmayanlar: başka üyeleri olan ailede sahiplik devri yalnızca otomatik testlerle doğrulandı (gerçek production testi yok); Android native görünüm testi henüz yapılmadı.
- ~~versionCode hâlâ 15; sonraki Play build 16 olacak.~~ → v16 yapıldı (`d8f38c2`), Play `alpha` kanalında.

## 🔖 Google Play hazırlığı (25 Ekim 2026) — imzalı AAB üretildi _(güncel: hesap açık, v16 `alpha`'da; aşağıdaki SHA→Firebase TODO'su hâlâ AÇIK)_

- **Karar: Play App Signing "A" seçeneği.** App signing key'i Google üretecek; mevcut v15 keystore (`alias android`, SHA-1 `66:4C:55:4E…`, SHA-256 `C1:AA:4F:2F…`) **yalnızca UPLOAD KEY**. Yeni keystore yok.
- **İmzalı build kurulumu:** `app/android/local.properties` (`RELEASE_STORE_FILE/KEY_ALIAS/STORE_PASSWORD/KEY_PASSWORD` + `sdk.dir`) ve `app/android/android.keystore` — ikisi de git dışında (`app/android/.gitignore` + kök `.gitignore`). Keystore yerel yedeği: `C:\Users\emrea\Documents\TarifKutusu-Keys\android.keystore`.
- **AAB komutu:** JDK 21 ile (`JAVA_HOME=C:\Users\emrea\.bubblewrap\jdk-21.0.12.1+1`; sistemdeki Java 19 yetmez) `cd app/android && ./gradlew bundleRelease` → `app/android/app/build/outputs/bundle/release/app-release.aab`. İlk AAB: `versionCode 15`, `versionName 15.0`, targetSdk 36.
- `jarsigner -verify` "jar verified, with signer errors" der: self-signed sertifika ve AGP'nin MANIFEST.MF sırası yüzünden — Android imzası için normal, sertifika upload key ile aynı.
- **TODO (CRITICAL) — ilk Play release hazırlanırken:**
  1. Play Console → App integrity → **App signing key certificate** SHA-1 ve SHA-256 alınacak.
  2. Bu değerler Firebase'deki Android app `com.tarifkutusu.app`'e eklenecek (yoksa Play'den indirilen uygulamada native Google Sign-In çalışmaz).
  3. Güncel `google-services.json` indirilip `app/android/app/`'e konacak (mevcut dosyada Android OAuth/SHA kaydı görünmüyor).
  4. Play dağıtımından (internal testing) Google Sign-In gerçek cihazda test edilecek.
  - Play birden fazla sertifika gösterirse dikkat: **upload key** (C1:AA… / 66:4C…) ile **app signing key** karıştırılmayacak; Firebase'e Play'in app signing SHA'ları eklenecek (upload SHA'sı da kalabilir). Debug SHA (`12:A0:B0…`) ayrı.
  - Telefona sideload edilmiş v15 (upload key imzalı) Play sürümüyle aynı imzayı taşımaz → Play'den kurmak için önce kaldırmak gerekir.

