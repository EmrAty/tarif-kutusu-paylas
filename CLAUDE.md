# Tarif Kutusu — Proje Durumu

Bu dosyayı her oturum başında otomatik okuyorum. Burada yalnızca **güncel kurallar, önemli kararlar ve açık işler** durur; büyük bir değişiklikten sonra bu dosyayı güncellerim. Oturum oturum ayrıntılı geçmiş: **`docs/history/`** (dizin: `docs/history/README.md`, taşımadan önceki tam dosya: `docs/history/CLAUDE.full-2026-11-13.md`). Yeni uzun oturum kayıtlarını buraya değil, `docs/history/` altına veya ilgili not dosyasına yazarım; bu dosya ~30 KB'ın altında kalmalı.

İşaretler: **[repo]** = repo/git ile doğrulandı, **[canlı]** = production'a istek atılarak doğrulandı, **[kullanıcı]** = Emre bildirdi, repodan doğrulanamaz.

## 🚦 Test / CI / yayın düzeni (Grup 5, 13 Kasım 2026)
- Yayın akışı, komutlar, zorunlu/elle korumalar ve geri dönüş: **`RELEASE.md`**. Grup 5 ayrıntısı: `GROUP5_NOTES.md`.
- `cd app && npm run check` = lint + tüm testler + build (CI'ın aynısı; ağsız, anahtarsız). Her push'ta GitHub Actions `CI / check` çalışır.
- Production'a yalnızca Preview'da test edilmiş SHA fast-forward ile çıkar: `npm run release:check -- <sha> --bypass-file …` → `git push origin <sha>:refs/heads/main` → `npm run verify:deploy -- --url https://tarifkutusu.app --commit <sha>`.
- Testlerde sabit süre bekleme yok: `test/helpers/async.mjs` (`waitFor`, `drainBackground`). Sahte Redis: `test/helpers/memoryRedis.mjs`; gerçek Lua `fengari` ile koşar.

## Ne bu proje
Kullanıcı TikTok/Instagram/YouTube yemek videosunun linkini/açıklamasını verir, Claude yapılandırılmış tarif (malzeme, yapılış, besin değeri, porsiyon) çıkarır. Kişisel + aile tarif listeleri, alışveriş listesi, kiler ("Elimde Bunlar Var" + AI önerileri), pişirme modu, aile bildirimi, Free/Plus. Web (Vite + React) + Vercel API + Upstash Redis + Firebase Auth/FCM; Android ve iOS kabuğu Capacitor.

## Canlı adresler ve hesaplar
- Production: **`https://tarifkutusu.app`** (`www.` de 200). Eski `tarif-kutusu-paylas.vercel.app` hâlâ Production'a bağlı ama artık ana domain değil (Türkiye'den erişim sorunu var). Apex www'ye yönlendirilmiyor — `ShareActivity` host'u birebir karşılaştırıyor. **[canlı]**
- Yasal sayfalar: `/privacy`, `/delete-account`, `/terms` (`app/public/*.html` + `app/vercel.json` rewrite; projede SPA fallback yok). Geliştirici TK Studio, destek `tkworkss10@gmail.com` (değişirse `mailto` dahil tüm sayfalarda). **[canlı]**
- GitHub `EmrAty/tarif-kutusu-paylas`; Vercel takım "EMRE" (emre-c391), proje `tarif-kutusu-paylas`, Root Directory `app`, Framework **Vite** ("Other" kalırsa 404). Plan Hobby, **Fluid Compute açık → fonksiyon üst sınırı 300 sn**.
- Firebase projesi `tarif-kutusu`: Email/Password, Google, Anonymous açık (Anonymous auto clean-up **kapalı** — açılırsa misafirlerin verisi silinir). Authorized domains: `tarifkutusu.app`, `www.tarifkutusu.app`, eski vercel domaini. `authDomain` `tarif-kutusu.firebaseapp.com`.
- Kullanılmayan Meta Developer app (Instagram oEmbed, App Review gerektirdiği için bırakıldı): `1030342326485605`.
- GitHub Pages shim (`emraty.github.io/tarif-kutusu-paylas/`, kökteki `index.html`/`share.html`) eski PWA paylaşım yolu.

## Klasör yapısı (özet)
- `app/src/` — React. `App.jsx` (ana uygulama), `SharePanel.jsx` (Android paylaşım paneli; `?sharePanel=1` + native köprü varsa `main.jsx` bunu render eder), `i18n.jsx` (TR/EN), `syncedBuckets.js` (sürümlü veri deposu), `updateRequired.js`, `recipeLocks.js`, `recipeLocale.js`, `servings.js`, `firebase.js`.
- `app/shared/` — istemci+sunucu ortak: `recipeExtraction.js` (prompt + `CATEGORIES`, tek kaynak), `limits.js`, `portionEstimate.js`, `recipeLocales.js`.
- `app/api/` — Vercel fonksiyonları: `extract`, `fetch-caption`, `recipe-jobs`, `data`, `families`, `profile`, `account`, `notify`, `fcm-token`, `suggest-recipes`, `translate-recipe`, `legacy`. Ortak yardımcılar `app/api/_lib/` (auth, redis, versionedBucket, bucketLimits, guestMerge, aiGuard, tiktok, transcribe, fcm, googleAuth, accountDeletion, families, profile, …).
- `app/android/` — Capacitor Android (git'te; `local.properties`, `android.keystore`, `keystore-password.txt` hariç). Elle yazılmış: `ShareActivity.java`, `ShareReceiverPlugin.java`, `NativeSplashPlugin.java`, `MainActivity.java`.
- `app/ios/` — Capacitor iOS (SPM, CocoaPods yok). Mac/Xcode işi hiç yapılmadı.
- `docs/porsiyon-hesabi.md` — porsiyon kuralları ve kaynakları. `docs/history/` — geçmiş.
- `android-twa/` ve `android-capacitor-builds/` repoda yok, yalnızca eski makinedeki proje kopyasında.

## Temel kurallar ve kararlar

**Native mi, web mi?** WebView canlı siteyi yükler (`capacitor.config.json` → `server.url = https://tarifkutusu.app`; dist gömülmez, çünkü `/api/*` uçlarında CORS yok). Bu yüzden:
- JS/React/API değişikliği → yalnızca deploy; telefonda uygulamayı kapatıp açmak yeter, **yeni APK gerekmez**.
- Native değişiklik (yeni Capacitor plugin, `capacitor.config.json`, manifest, tema/kaynak, Java) → **yeni APK/AAB şart**. Yeni bir native plugin'i çağıran JS eski APK'da "not implemented" hatası verir.

**Gizli bilgiler**
- Anahtar/şifre/token değerleri hiçbir çıktıda gösterilmez, forma Claude tarafından girilmez (Vercel env, API key adımları hep kullanıcıda).
- Vercel env: `ANTHROPIC_API_KEY`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`, `FIREBASE_SERVICE_ACCOUNT_KEY`, `OPENAI_API_KEY` (TikTok ses transkripsiyonu; hesapta bakiye de gerekir, yoksa 429). Yeni env yalnızca yeni deploy'a uygulanır → redeploy.
- İmzalama: upload keystore aynı kalır (`alias android`, SHA-256 `C1:AA:4F:2F…`, SHA-1 `66:4C:55:4E…`). `app/android/local.properties` (`RELEASE_STORE_FILE/KEY_ALIAS/STORE_PASSWORD/KEY_PASSWORD` + `sdk.dir`) ve `android.keystore` git dışında, asla commit/print edilmez. Keystore yedeği: `C:\Users\emrea\Documents\TarifKutusu-Keys\android.keystore`. `keystore-password.txt` başında UTF-8 BOM var (`tail -c +4`). Play App Signing kullanılıyor (app signing key Google'da; bizimki yalnızca upload key).

**Android build**
- JDK 21 gerekir: `JAVA_HOME=C:\Users\emrea\.bubblewrap\jdk-21.0.12.1+1` (Java 17/19 yetmez); `ANDROID_HOME=C:\Users\emrea\.bubblewrap\android_sdk`.
- AAB: `cd app/android && ./gradlew bundleRelease` → `app/build/outputs/bundle/release/app-release.aab`. Her Play build'inde `versionCode` artar (şu an 16).
- Dosya adına sürüm yaz (ör. `…-v16.apk`) — eski adla karışma yaşandı. Upload-key imzalı sideload APK, Play sürümünün üstüne kurulmaz (önce kaldır).

**Vercel fonksiyonları**
- `export const config = { maxDuration }` değerini plan sınırının altına çekme: süre aşılınca `waitUntil` iptal olur, `catch` hiç çalışmaz, job sonsuza dek `processing` kalır (17 Eylül'deki hatanın kök sebebi). Uzun işlerde `getDeadline()` ile kalan süreyi okuyup alt çağrılara zaman aşımı ver.
- `claude-sonnet-5` adaptive thinking kullanır; düşünme token'ları `max_tokens`'tan düşer → sunucu çıkarmasında `max_tokens: 16000`, json_schema ve `stop_reason` kontrolü.
- Hobby planda log aralığı en fazla "Last hour"; Request Logs için URL'ye `&datasource=legacy-logs`.

**Veri ve sürümlü kovalar** (main'de, `049df70` → merge `52e04fd`) **[repo]**
- Redis anahtarları: `user:<uid>:<bucket>`, `family:<id>:<bucket>` (`recipes`, `shopping-list`, `pantry-items`), yanında `<key>:version`. Okuma hatası asla boş liste sayılmaz (5xx). Yazım = Lua CAS (`api/_lib/versionedBucket.js`); `POST /api/data` `baseVersion` ister (yoksa 426 `client_outdated`), eski sürüm → 409 + güncel değer. Yedekler `<key>:backups` (son 5) ve `<key>:daily-backups` (7 gün), biçim `<sürüm>|<ms>|<JSON>`; geri yükleme şimdilik elle.
- İstemci `src/syncedBuckets.js`: değişiklik = niyet (updater), çakışmada güncel veriye yeniden uygulanır (≤4 deneme); yüklenemeyen kovaya yazılmaz. 426 alınırsa `appUpdateGate` kapanır ve "Tarif Kutusu güncellendi / Yenile" penceresi çıkar.
- Recipe job'ları `mutateBucket` ile yazar; eski `pendingJobRecipes`/`_lib/jobRecipes.js` kaldırıldı (eski anahtarlar silme akışlarında hâlâ temizleniyor).

**Free / Plus**
- `app/shared/limits.js`: `FREE_RECIPE_LIMIT = 15`, hata kodu `free_recipe_limit`. Sunucu `api/data.js` ve `api/recipe-jobs.js`'te uygular (Claude'dan önce). Aile listelerine limit yok.
- Limit üstü tarifler silinmez, **kilitli** görünür (en eski 15 açık; `recipeLocks.js`, türetilmiş durum, Redis'e yazılmaz). Plus'ta kilit yok. Plus durumu bilinmiyorsa kilit uygulanmaz.
- Plus: sınırsız kişisel tarif, en fazla 2 aile. Plus kapatılınca kullanıcı tüm ailelerden çıkar (aile/diğer üyelerin verisi silinmez).
- **Gerçek ödeme yok.** `PlusModal`'ın CTA'sı geçici test anahtarı (`onToggleTest` → `/api/profile` `isPlus`); fiyatlar `PLUS_PRICE_PLACEHOLDER`. RevenueCat/Play Billing/StoreKit bağlanınca test CTA'sı kaldırılacak. "Satın alımları geri yükle"/"Kodun var mı?" işlevsiz.

**Hesap ve aile**
- Misafir = Firebase anonim hesap (kalıcı uid); Hesabım'dan Google'a bağlanınca uid korunur. Google hesabı başka uid'de zaten varsa o hesaba geçilir (misafir verisi taşıma: Grup 5 notları).
- Native'de Google girişi `@capacitor-firebase/authentication` ile (`capacitor.config.json`: `skipNativeAuth: true`, `providers: ["google.com"]`), web'de `signInWithPopup`.
- Sunucu kimliği: Firebase ID token `jose` + Google JWKS ile doğrulanır (`_lib/auth.js`); `firebase-admin` yok. FCM ve hesap silme servis hesabı token'ını `_lib/googleAuth.js` ile alır.
- Hesap silme `DELETE /api/account` (ayrıntı `docs/history/01-…`): `deleted-account:<uid>` işareti (24 sa) → aile üyelikleri (tek üyeyse aile silinir, sahiplik en eski üyeye geçer) → kullanıcı anahtarları → profil → Firebase kullanıcısı. İdempotent; silinmiş hesabın token'ı her yerde 401. Production'da test edildi. **[canlı]**
- Aile hedefli kayıt (Share Panel/job) her adımda `assertFamilyMember` ile doğrulanır; başarısızsa kişisel listeye **asla** düşmez.

**Tarif çıkarma ve kaynaklar**
- Prompt + kategoriler tek yerde: `shared/recipeExtraction.js` (`recipeSystemPrompt(lang)`); hem `/api/extract` hem `/api/recipe-jobs` kullanır. Yeni tarif uygulama dilinde üretilir, `content_lang` yazılır (alan yoksa Türkçe).
- AI porsiyon uydurmaz: `servings` yalnızca kaynakta yazıyorsa; yoksa `shared/portionEstimate.js` deterministik hesaplar (aralık + tek sayı, `servings_basis`). Kurallar: `docs/porsiyon-hesabi.md`. Kural/prompt değişince sürüm numarasını artır.
- Çeviri yalnızca gösterim içindir; kayıtlı tarif değişmez. `/api/translate-recipe` tarifi istemciden almaz, sunucudan okur; önbellek içerik hash'li (`rt:v1:…`). Prompt değişirse `PROMPT_VERSION` artır. Ölçekleme her zaman asıl metin üzerinde yapılır; Türk bardak ölçüleri "cup"a çevrilmez.
- TikTok: açıklama sayfadan (`itemStruct.desc`, iPhone UA, kısa linkler redirect ile), sonra oEmbed; bulunamazsa 502. Açıklama yetersizse job altyazıya, sonra videoyu indirip OpenAI `gpt-4o-mini-transcribe`'a düşer (≤180 sn, ≤20 MB ≈ 70 sn video); ikisi de <200 karakterse job `failed`, **tarif uydurulmaz**. TikTok'a bağlı tek dosya `_lib/tiktok.js` (çerez + `Referer` olmadan video 403; masaüstü UA WAF'a takılır). Instagram yalnızca `og:description` kazıma (resmî API değil, kırılabilir). Fallback yalnızca paylaşım paneli/job yolunda; uygulama içi "Yeni Tarif Çıkar" (`/api/extract`) açıklama/not/görsel zorunlu tutar.

**Paylaşım paneli ve bildirimler**
- Android `ShareActivity` (saydam, ekranın ~%78'i, düz WebView, aynı Firebase oturumu) → `/api/recipe-jobs` → `waitUntil` → Redis'e kayıt → job `completed` → **ancak sonra** FCM. Idempotency: `job-req:` (requestId) ve `job-url:` (aynı link); başarısız job yeniden denemeyi engellemez. Panel yalnızca `jobId` gelince kapanır.
- Bildirim job başladıktan ≥5 sn sonra gönderilir (hızlı hatada panel açıkken bildirim kaybolmasın); sonuç job kaydının `notify` alanında. FCM `android.priority: "high"`. Uygulama ön plandayken sistem bildirimi görünmez (çözümü native → yeni APK).
- "Canı çekti" aile bildirimi: native FCM (`@capacitor/push-notifications`), Türkçe iyelik eki `_lib/turkish.js`; bildirime basınca `recipeId` ile tarif açılır. iOS'ta plugin ham APNs token döndürür → sunucu FCM'i iOS'ta henüz çalışmaz.

**UI kalıpları**
- Mobilde tam ekran açılan view'lar `FULLSCREEN_VIEWS` + tek `closeActiveScreen()` (Header ← ve Android geri aynı fonksiyonu çağırır; ikinci `backButton` listener ekleme). Modallar (`modalView`) önce kapanır.
- Dil: `i18n.jsx`, tercih `localStorage` `tarif-kutusu:language`, varsayılan `tr`. Kategori/zorluk değerleri depolanırken değişmez, yalnızca etiket çevrilir. Yeni dil = `LANGUAGES` + sözlük bloğu + `recipeLocale.js` birim sözlüğü.
- Uygulama adı: TR "Tarif Kutusu", EN/varsayılan "Recipe Box" (Android `values`/`values-tr`). Renk paleti `COLORS` (forest/paper/mustard).
- Güncelleme bandı: build başına `__APP_VERSION__` + `/version.json`; farklıysa "Şimdi Güncelle" (yalnızca web içeriği).

**Git / çalışma düzeni**
- Commit ve push yalnızca kullanıcı isteyince. `git push` Credential Manager yüzünden takılabilir → arka planda çalıştır. `gh` CLI bu makinede yok.
- GitHub'a web arayüzünden yükleme yapılırsa commit'in gerçekten oluştuğunu doğrula.
- Canlı API testi: Firebase Identity Toolkit `accounts:signUp` ile geçici anonim hesap → `Authorization: Bearer` → test sonunda veriyi temizle ve `accounts:delete` (silme token'ını çıktıdan filtreleme; eski testlerden 3 anonim hesap Firebase'de kaldı, uid'ler `docs/history/04-…`).
- Fable denetler, düzeltmeleri Opus yapar (hafıza notu).

## 📌 Güncel durum (13 Kasım 2026)

**Google Play** **[kullanıcı]**
- Uygulama `com.tarifkutusu.app`; mağaza kurulumu büyük ölçüde tamam (privacy, hesap silme URL'si, Data Safety, içerik derecelendirmesi, store listing, görseller — AI görseller beyanlı).
- **v16** (`versionCode 16`, `versionName "15.5"`, commit `d8f38c2`) kapalı test kanalı `alpha`'da, rollout %100. **[repo]**
- Üretime geçmek için **12 tester × 14 gün kesintisiz opt-in** gerekiyor; şu an tester toplama aşaması.

**Production'daki önemli düzeltmeler**
- TikTok açıklama regresyonu (`822af0e`, `1a77939`) ve hızlı hata bildirimi gecikmesi (`3fbd312`) canlıda. `ANTHROPIC_API_KEY` 10 Kasım'da yenilendi, tarif oluşturma telefonda çalışıyor. **[kullanıcı]**
- Kilitli kart örtüsü (`LockedOverlay`) ve yeni `PlusModal` (alt sheet, sürükleyerek kapatma) main'de (`c733130` … `f7b6646`). Ayrıntı: `docs/history/01-…`.

**Dallar (Grup çalışması)** **[repo]**
- main `52e04fd` = Grup 1 (sürümlü veri) + Grup 2 (AI güvenlikleri). Grup 3 (`group-3-legacy-fcm`), Grup 4 (`group-4-family`, canlı aile yenileme `071fec2`) ve Grup 5 (`group-5-ci-release`: testler, CI, yayın araçları, dayanıklı misafir→hesap taşıma, kova boyut/hız sınırları; Fable denetim turları B1–B6, K1–K3 ve telefon öncesi hazırlık) main'de **değil**. Grup 5 dalı Grup 4'ün üstünde ve Grup 3'ü de içeriyor.
- `preview.tarifkutusu.app` → `group-5-ci-release` (13 Kasım). Sıradaki: kullanıcının telefon testi (`GROUP5_NOTES.md` §9 listesi), bağımsız Fable denetimi, sonra `RELEASE.md` akışı. Main'e push/merge yapılmadı.
- Misafir→hesap taşıma: aynı hedefe 30 günde en çok **5** farklı misafirin taşıması başlar (`GUEST_MERGE_LIMIT`; fazlası silinmez, sıraya girer, sırada en çok 10). Bağlanan misafir donar; misafirken başlamış paylaşım job'unun tarifi hedefe yazılır (`guest-merge:moved:`); bağlı misafir kendini silemez (409). Ayrıntı ve geri dönüş: `GROUP5_NOTES.md` §7–§9, `RELEASE.md`.

**iOS:** Tamamlanmadı. Proje + `GoogleService-Info.plist` repoda; Apple Developer, Xcode imzalama, Push capability, Google URL scheme, APNs↔FCM, Share Extension, TestFlight yapılacak. Ayrıntı: `docs/history/03-ios.md`.

## Açık işler — öncelik sırası
0. Grup 5 dalını (Grup 3–4 dahil) Preview'da telefonla test et (`GROUP5_NOTES.md` §9), bağımsız Fable denetimi, sonra `RELEASE.md` akışıyla main'e al.
1. Telefonda Plus modalı: görünüm, tutamaçla sürükleyerek kapatma, Android geri tuşu, alt güvenli alan, test CTA ile Plus aç/kapat → kilitler açılıp kapanıyor mu.
2. Telefonda TikTok → Paylaş → Tarif Kutusu: başarı ve (hatalı linkle) hata bildirimi görünüyor mu; job kaydındaki `notify` alanıyla karşılaştır.
3. ⚠️ **Play App Signing SHA-1/SHA-256'sını Firebase Android app'ine ekle** (upload SHA'sıyla karıştırma; debug SHA `12:A0:B0…` ayrı), yeni `google-services.json`'ı `app/android/app/`'e koy, Play sürümünde Google Sign-In'i dene. Yapılmadı.
4. Kapalı test opt-in takibi (12 × 14 gün).
5. Telefonda henüz doğrulanmayanlar: Share Panel aile seçimi, porsiyon gösterimi, İngilizce çeviri (gerçek hesapla uçtan uca hiç denenmedi), TikTok ses yolunun konuşmalı bir videoyla happy-path'i.
6. Ürün kararları bekleyenler: gerçek ödeme altyapısı, iPhone paylaşımı (iOS Share Extension), Android `allowBackup` (öneri: true kalsın; değişirse yeni AAB), CSP `script-src` (öneri: rapor ucu olmadan ekleme), taşımada Free sınırının uygulanmaması ve kova tavanları (varsayılanlar onay bekliyor). Taşıma sınırı kararlaştırıldı: 5.
