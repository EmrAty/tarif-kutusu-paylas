# Tarif Kutusu — Proje Durumu

Bu dosyayı her oturum başında otomatik okuyorum. Buradaki bilgiler güncel tutulmalı; büyük bir değişiklik yaptığımda bu dosyayı da güncellerim.

## Ne bu proje

Kullanıcı TikTok/YouTube'da gördüğü yemek videolarının linkini/açıklamasını yapıştırıyor, yapay zeka (Claude API) bundan yapılandırılmış bir tarif (malzemeler, yapılış, besin değerleri) çıkarıyor. Başlangıçta bir Claude Artifact prototipiydi, gerçek bağımsız bir web uygulamasına dönüştürüldü.

## Canlı adresler

- **Gerçek uygulama:** https://tarif-kutusu-paylas.vercel.app (Vercel, otomatik deploy)
- **Paylaşım kısayolu (PWA share-target shim):** https://emraty.github.io/tarif-kutusu-paylas/ (GitHub Pages, otomatik deploy)
- **GitHub repo:** https://github.com/EmrAty/tarif-kutusu-paylas (kullanıcı adı: EmrAty)
- **Vercel proje/takım:** "EMRE" (emre-c391), proje adı `tarif-kutusu-paylas`

## Android uygulaması (TWA)

Kullanıcının isteği üzerine `tarif-kutusu-paylas.vercel.app` sitesi, Google'ın **Trusted Web Activity (TWA)** tekniğiyle gerçek bir Android uygulamasına (APK/AAB) çevrildi — Play Store'a hiç yüklenmedi, kullanıcının telefonuna doğrudan APK olarak (sideload) kuruldu.

- **Proje klasörü:** `android-twa/` (bu repoya dahil değil — sadece bu makinede, kullanıcının Downloads klasöründeki proje kopyasında duruyor; Android Studio projesi + Gradle wrapper içeriyor).
- **Package ID:** `com.tarifkutusu.app`.
- **Nasıl oluşturuldu:** Google'ın resmi `@bubblewrap/cli` aracıyla (`app/public/manifest.json`'dan otomatik üretildi — isim, ikonlar, tema rengi, `share_target` hepsi oradan geldi). Bubblewrap'in interaktif kurulum sihirbazı bu makinede (stdin olmadığı için) çalışmadığından, `@bubblewrap/core` kütüphanesi doğrudan bir Node script'i ile programatik olarak çağrıldı; JDK 17 ve Android SDK cmdline-tools da elle indirilip `C:\Users\<kullanıcı>\.bubblewrap\` altına yerleştirildi.
- **İmzalama anahtarı (keystore):** `android-twa/android.keystore`, alias `android`. Şifre bu makinede `C:\Users\emrea\.bubblewrap\keystore-password.txt` dosyasında duruyor — **bu dosya asla GitHub'a yüklenmemeli**, kaybolursa uygulamanın imzası değişir ve mevcut kurulumun üzerine güncelleme yapılamaz (yeniden kurmak gerekir).
- **Digital Asset Links doğrulaması:** TWA'nın adres çubuğu göstermeden tam ekran çalışması için `app/public/.well-known/assetlinks.json` dosyası eklendi (bu dosya repoya dahil, canlıda). İçinde keystore'un SHA256 imza parmak izi var — keystore değişirse bu dosyanın da güncellenmesi gerekir.
- **Native paylaşım desteği:** TWA'nın `AndroidManifest.xml`'i `android.intent.action.SEND` intent-filter'ı ve `METADATA_SHARE_TARGET` içeriyor — yani ayrı bir GitHub Pages shim'ine gerek kalmadan, uygulama kurulduğunda TikTok/YouTube paylaşım menüsünde doğrudan "Tarif Kutusu" olarak çıkıyor ve linki doğrudan ana uygulamanın `share_target` (`app/public/manifest.json` → `/` adresine `?url=&text=&title=` ile GET) mekanizmasına yönlendiriyor.
- **Build çıktıları:** `android-twa/app-release-signed.apk` (kullanıcıya gönderildi, telefona kurulacak) ve `android-twa/app-release-bundle-signed.aab` (ileride Play Store'a yüklemek istenirse hazır).

## Klasör yapısı

- `app/` — gerçek Vite + React + Tailwind uygulaması. Vercel'de **Root Directory = `app`**, **Framework Preset = Vite** olarak ayarlı (bu ayar "Other" kalırsa çıktı klasörünü (`dist`) bulamayıp 404 verir — bir kere başımıza geldi).
  - `app/src/App.jsx` — tüm uygulama tek dosyada (Claude Artifact'ten miras). `recipes` / `shopping-list` / `pantry-items` artık **paylaşımlı** (bkz. `app/api/store.js`) — ailenin tamamı aynı listeyi görür. Sadece `person-name` (kimin eklediği bilgisi için, cihazda hatırlanan isim) hâlâ `localStorage`'da, kasıtlı olarak cihaza özel.
  - `app/api/extract.js` — Anthropic API'ye proxy. `ANTHROPIC_API_KEY` env variable'ı Vercel proje ayarlarında tanımlı (asla koda yazılmaz, tarayıcıya sızdırılmaz). Model: `claude-sonnet-5`, `max_tokens: 4096` (extended thinking token'ları da bu bütçeden düşüyor — 1000'de kesilme sorunu yaşandığı için 4096'ya çıkarıldı).
  - `app/api/fetch-caption.js` — TikTok/YouTube oEmbed proxy'si, video linkinden başlık/açıklama metnini otomatik çekip formu dolduruyor (kazıma değil, resmi API).
  - `app/api/store.js` — paylaşımlı anahtar-değer deposu proxy'si (Upstash Redis, "Free" plan — Vercel Storage → Upstash for Redis entegrasyonu ile bağlandı). `KV_REST_API_URL`/`KV_REST_API_TOKEN` env variable'ları Vercel'de otomatik tanımlandı. Sadece üç anahtara izin veriyor (`recipes`, `shopping-list`, `pantry-items`) — whitelist var ama gerçek bir kimlik doğrulama/giriş sistemi yok, yani linki bilen herkes teorik olarak okuyup yazabilir (aile içi kullanım için kabul edilebilir risk, ama unutulmamalı).
- Kök dizin (`index.html`, `share.html`, `manifest.json`, `icon.svg`) — ayrı, GitHub Pages'te barınan küçük bir PWA. Paylaşım menüsünden linki yakalayıp `?link=...` parametresiyle yukarıdaki Vercel uygulamasına yönlendiriyor.

## Önemli iş akışı notları

- **Bu makinede git kurulu değil, `.git` klasörü yok.** Kullanıcı GitHub'a değişiklik göndermeyi git kurmak yerine **web arayüzünden sürükle-bırak** ("Add file → Upload files" / "Create new file") ile yapmayı tercih ediyor — bu tercih kayıtlı, farklı istenmedikçe böyle devam.
- GitHub'a dosya yükledikten sonra **"Commit changes"e bastıktan sonra mutlaka sonucu doğrula** (ekran görüntüsü al / `/commits/main` sayfasına bak). Bir kere hızlı art arda iki dosya yüklerken ilk commit sessizce gitmemişti, fark edilmeden Vercel eski koddan deploy etmişti.
- Vercel, `main` branch'e her push'ta otomatik yeniden deploy ediyor (GitHub App bağlı). Yeni deploy'un bitmesini birkaç saniye bekleyip `vercel.com/emre-c391/tarif-kutusu-paylas/deployments`'tan kontrol etmek gerekiyor.
- Anthropic API anahtarı gibi gizli bilgileri tarayıcı formlarına Claude asla giremez — o adımı hep kullanıcı kendisi yapıyor.

## Giriş / hesap sistemi (Firebase Authentication)

Kullanıcının isteği üzerine uygulamaya bir **giriş kapısı** eklendi (3 Eylül 2026 sonrası): uygulama ilk açıldığında (hesap veya misafir seçimi hiç yapılmamışsa) tam ekran bir "Giriş Yap / Kaydol" ekranı çıkıyor.

- **Nasıl çalışıyor:** `app/src/firebase.js` Firebase'i başlatıyor; `app/src/App.jsx` içindeki `AuthGate` bileşeni giriş ekranını çiziyor. Seçenekler: e-posta+şifre ile **Giriş Yap** (varsayılan görünüm), "Kaydol" bağlantısına basınca **Google ile Kaydol** ve e-posta ile kaydol seçenekleri açılıyor, en altta ise hesap açmak istemeyenler için **Misafir Olarak Gir** butonu var.
- **Sadece ilk girişte sorulur:** Gerçek hesapla giriş yapıldıysa Firebase oturumu tarayıcıda kalıcı olarak saklıyor (`onAuthStateChanged`), bir daha sorulmuyor. Misafir seçilirse `localStorage`'a (`tarif-kutusu:auth-mode = "guest"`) yazılıyor, o cihazda bir daha gösterilmiyor. Bu davranış yerel `npm run dev` ile test edildi ve doğrulandı.
- **Çıkış yapma:** Gerçek hesapla giriş yapan kullanıcılar için sağ üstte küçük bir çıkış ikonu var (`Header` bileşeni, sadece `authUser` doluysa görünür). Misafir modunda çıkış butonu yok — misafirin "tekrar sorulmaması" zaten hedeflenen davranış.
- **Bu, tarif/alışveriş listesi verisine erişimi kısıtlamıyor:** Giriş ekranı sadece bir kapı; hangi hesapla girilirse girilsin (ya da misafir), herkes hâlâ aynı paylaşımlı `app/api/store.js` verisini görüyor/düzenliyor (ailenin ortak kullanımı korunuyor). Yani bu bir yetkilendirme/izolasyon sistemi değil, sadece "uygulamaya girerken bir hesap ekranı görsün" isteğini karşılıyor.
- **Firebase projesi kuruldu (4 Eylül 2026):** Kullanıcının izniyle, kullanıcının gerçek Chrome'unda (Claude in Chrome ile, kendi Google hesabı oturumu açıkken) şu adımlar tamamlandı:
  - `console.firebase.google.com`'da **tarif-kutusu** adında yeni bir Firebase projesi oluşturuldu (Spark/ücretsiz plan, Gemini in Firebase ve Google Analytics kapatıldı — bu proje için gereksizler).
  - Authentication etkinleştirildi; **Email/Password** ve **Google** sign-in sağlayıcıları açık.
  - Authentication → Settings → Authorized domains listesine `tarif-kutusu-paylas.vercel.app` eklendi (Google popup girişi için gerekli; `localhost` zaten varsayılan).
  - Bir Web app kaydedildi ("Tarif Kutusu Web") ve gerçek `firebaseConfig` değerleri `app/src/firebase.js`'e işlendi (artık placeholder değil).
  - Yerel `npm run dev` ile hem e-posta ile kayıt/giriş hem de misafir akışı gerçek Firebase'e karşı test edildi, ikisi de çalışıyor; test için oluşturulan deneme hesabı sonradan Firebase konsolundan silindi.
  - **GitHub'a yüklendi ve canlıda doğrulandı (4 Eylül 2026):** Değişen dosyalar (`app/src/firebase.js`, `app/src/App.jsx`, `app/package.json`, `app/package-lock.json`, güncellenmiş `CLAUDE.md`) GitHub web arayüzünden 3 ayrı commit ile yüklendi (`df1cf8`, `85e44cf`, `aac5986`). İlk commit'in Vercel deploy'u başarısız oldu (o an `package.json`'da henüz `firebase` paketi yoktu, sonraki commit'te eklendi) — bu beklenen bir ara durumdu, son commit'in Vercel deploy'u başarıyla tamamlandı ve `tarif-kutusu-paylas.vercel.app` canlıda giriş/kayıt ekranını doğru gösteriyor (tarayıcıdan doğrulandı).
  - Google girişi canlıda ilk denendiğinde OAuth onay ekranı "tarif-kutusu" / "unverified app" gibi görünebilir — bu normal, Google'ın uygulama doğrulama sürecinden geçmediği için (aile içi kullanım için sorun değil, "Advanced" → "Go to tarif-kutusu (unsafe)" ile geçilebilir; istenirse ileride OAuth consent screen'de "Publishing status"ü gözden geçirebiliriz). Google ile canlı giriş henüz gerçek bir hesapla denenmedi — kalıcı bir kullanıcı oluşmasını istemediğim için bilerek denemedim, kullanıcının kendi cihazında bir kere test etmesi gerekiyor.

## Bilinen eksik / yapılacaklar

1. **iPhone paylaşım entegrasyonu:** iOS Safari, Web Share Target API'yi desteklemiyor (Apple kısıtlaması, düzeltilemez). Android'de uygulama zaten yüklenince paylaşım menüsünde çıkabiliyor. iPhone için plan: kullanıcının telefonunda bir kere kuracağı bir **Kısayollar (Shortcuts) app** kısayolu — TikTok'ta paylaşırken "Tarif Kutusu" olarak çıkıp linki `?link=...` ile uygulamaya atacak. Henüz kurulmadı, kullanıcıyla adım adım yapılacak.
2. **Google ile canlı girişin gerçek bir hesapla test edilmesi bekleniyor:** Kurulum ve deploy tamamlandı (bkz. yukarısı), e-posta ile kayıt/giriş ve misafir girişi gerçek Firebase'e karşı test edildi; sadece Google butonu canlıda henüz gerçek bir hesapla denenmedi (kalıcı kullanıcı oluşturmamak için bilerek atlandı).

### Test edilip kapatılan maddeler (3 Eylül 2026)
- Android APK'nın telefonda TikTok paylaşım menüsünde "Tarif Kutusu" olarak çıkıp tam ekran açılması — kullanıcı tarafından test edildi, çalışıyor.
- Android PWA (GitHub Pages shim) paylaşım menüsü testi (icon-192/512 + `sw.js` düzeltmesi sonrası) — kullanıcı tarafından test edildi, çalışıyor.
