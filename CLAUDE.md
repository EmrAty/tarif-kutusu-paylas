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

## Uygulama ikonu (4 Eylül 2026)

Kullanıcının verdiği logo görseli (`C:\Users\emrea\Downloads\ikon.jpeg` — koyu yeşil zemin, altın çerçeve, tencere kapağı + kutu + ayraç sembolü, "Tarif Kutusu" yazısı) artık uygulamanın gerçek ikonu:

- Kaynak görsel ortadan kare kırpılıp (887×887) 512×512 ve 192×192 PNG'ler üretildi (tarayıcı canvas ile — bu makinede ImageMagick/sharp/PIL gibi bir görsel işleme aracı kurulu değil, bulunursa iş kolaylaşır).
- Hem kök dizindeki hem `app/public/` altındaki `icon-192.png`, `icon-512.png` ve `icon.svg` (artık 512'lik PNG'yi saran bir SVG sarmalayıcı, orijinal vektör değil) bu yeni görselle değiştirildi.
- Her iki `manifest.json`'da icon `purpose` alanı `"any maskable"` yerine `"any"` yapıldı — orijinal tasarımda çerçeve ve yazı kenara çok yakın durduğu için Android'in maskable güvenli alan kırpması (`daire/squircle` maskesi) bunları keserdi.
- **Android APK'nın ikonu da güncellendi (4 Eylül 2026):** `android-twa/app/src/main/res/mipmap-*/ic_launcher.png` (köşeleri yuvarlatılmış, legacy launcher için) ve `ic_maskable.png` (kenardan kenara, adaptive icon XML'i zaten 8.5dp iç boşluk + beyaz arka plan ekliyor) her yoğunlukta (mdpi/hdpi/xhdpi/xxhdpi/xxxhdpi) yeni logoyla yeniden üretildi; `store_icon.png` da güncellendi. `versionCode`/`versionName` `1`'den `2`'ye çıkarıldı (`app/build.gradle` ve `twa-manifest.json`). Proje `./gradlew assembleRelease` ile derlenip (`JAVA_HOME` = `C:\Users\emrea\.bubblewrap\jdk\jdk-17.0.11+9`), Android SDK build-tools'daki `zipalign` ve `apksigner` ile mevcut `android.keystore`'la **doğrudan komut satırından, bubblewrap CLI'ın interaktif sihirbazına hiç girmeden** imzalandı (`apksigner sign --ks-pass pass:... --key-pass pass:...` — şifre `C:\Users\emrea\.bubblewrap\keystore-password.txt`'ten okunuyor). Yeni `app-release-signed.apk`'nın imza sertifikası (SHA-256: `c1aa4f2f...b4882e1`) eskisiyle birebir aynı doğrulandı — yani telefondaki mevcut kurulumun **üzerine güncelleme olarak kurulabilir**, kaldırıp yeniden kurmaya gerek yok. Eski APK `android-twa/app-release-signed.OLD.apk.bak` olarak yedeklendi. `app-release-bundle-signed.aab` (Play Store paketi) bu turda güncellenmedi, sadece sideload edilen APK güncellendi.
- **Bubblewrap CLI'ın `build` komutu da `init` gibi interaktif stdin istiyor ve bu makinede çöküyor** (`ERR_USE_AFTER_CLOSE`, şifre piped stdin ile verilse bile) — bu yüzden `bubblewrap build` yerine yukarıdaki gibi ham Gradle + zipalign + apksigner adımları elle çalıştırıldı. İleride APK'yı tekrar build etmek gerekirse aynı yöntem kullanılmalı.
- **Telefonlarda zaten "Ana ekrana eklenmiş" PWA kısayolları eski ikonu göstermeye devam eder** — yeni ikonun görünmesi için o kısayolun silinip sitenin tekrar "Install app" ile eklenmesi gerekir (tarayıcı/OS ikon önbelleği).
- **Android APK güncellemesi kullanıcı tarafından test edildi, yeni ikon telefonda görünüyor (4 Eylül 2026).** İlk denemede kullanıcı yanlışlıkla telefonunda zaten duran **eski** `app-release-signed.apk` dosyasını açıp kurmuştu (Ayarlar'da sürüm hâlâ "1" görünüyordu) — dosya adı eskisiyle aynı olduğu için karışmıştı. Claude'un bu sohbette gönderdiği güncel dosyayı (tarihine bakarak en yeni olanı) bulup kurunca sürüm "2" oldu ve yeni logo çıktı. **Ders:** ileride yeni bir APK gönderilecekse dosya adına sürüm eklemek (örn. `app-release-signed-v2.apk`) kullanıcının telefonundaki eski kopyayla karışmasını önler.

### İkinci ikon revizyonu — "pin" ederken zoom/kırpma sorunu düzeltildi (4 Eylül 2026, v3)

Kullanıcı ilk ikonu (kenara kadar dolu, boşluksuz) telefona "pin" edince (ana ekrana ekleme / launcher ikonu) Android'in kendi adaptive-icon maskesinin (daire/squircle) görseli otomatik büyütüp kenarları (altın çerçeve + "Tarif Kutusu" yazısı) kırptığını fark etti. Kullanıcı yeni bir kaynak görseli Gemini'de kendisi ürettirdi (aynı tasarım, ama logo artık karenin ortasında küçük, etrafında aynı koyu yeşil kumaş dokusuyla dolu bolca boşluk bırakılmış — `C:\Users\emrea\Downloads\Gemini_Generated_Image_ju8rqsju8rqsju8r.jpg`, 1024×1024) ve "her iki işi de (web ikonları + APK ikonları) aynı anda yap" dedi:

- **Görsel işleme aracı bulundu:** Önceki notların aksine ("bu makinede ImageMagick/sharp/PIL yok"), `npm install sharp` **scratchpad'de** sorunsuz kuruldu (Windows için önceden derlenmiş ikili indiriyor, derleyici gerekmiyor) — artık kare kırpma/yeniden boyutlandırma/köşe yuvarlama için tarayıcı canvas yerine bunu kullanabiliriz.
- **Web ikonları:** Kaynak görsel zaten kare ve güvenli boşluklu olduğu için doğrudan 512×512 ve 192×192'ye küçültülüp hem kök dizindeki hem `app/public/` altındaki `icon-512.png`, `icon-192.png`, `icon.svg` (512 PNG'yi saran wrapper) dosyaları değiştirildi. Her iki `manifest.json`'da icon `purpose` alanı tekrar **`"any maskable"`** yapıldı (artık görsel gerçekten maskeye uygun olduğu için).
- **Android APK ikonları:** Her yoğunlukta (mdpi 48px / hdpi 72px / xhdpi 96px / xxhdpi 144px / xxxhdpi 192px) `ic_maskable.png` (tam kare, kırpmasız — adaptive icon XML zaten kendi 8.5dp iç boşluğunu ekliyor) ve `ic_launcher.png` (legacy launcher için, eski dosyalardan ölçülen ~%6 köşe yarıçapıyla yuvarlatılmış) yeniden üretildi; `store_icon.png` (512×512) da güncellendi.
- **Sürüm artırıldı:** `android-twa/app/build.gradle` (`versionCode`/`versionName`) ve `android-twa/twa-manifest.json` (`appVersionCode`/`appVersionName`/`appVersion`) `2`'den `3`'e çıkarıldı.
- **Build + imzalama:** `./gradlew assembleRelease` → `zipalign` → `apksigner sign` (aynı `android.keystore`, alias `android`) ile önceki oturumdaki yöntem tekrar kullanıldı. **Yeni bir tuzak bulundu ve çözüldü:** `keystore-password.txt` dosyasının başında bir UTF-8 BOM (`EF BB BF`) var — dosyayı düz `cat`/`$(cat ...)` ile okuyup `apksigner`'a vermek "Password is not ASCII" hatası veriyordu; çözüm dosyayı `tail -c +4` ile (ilk 3 baytı atlayarak) okumaktı. İleride bu şifre dosyası okunacaksa bu BOM'a dikkat edilmeli.
- **İmza doğrulandı:** Yeni APK'nın sertifika SHA-256'sı (`c1aa4f2f...b4882e1`) öncekiyle birebir aynı — yani telefondaki mevcut kurulumun üzerine güncelleme olarak kurulabilir.
- **Çıktı dosyası, geçmişteki "dosya adı karışıklığı" dersine uyularak `app-release-signed-v3.apk` olarak adlandırıldı** (`android-twa/` altında). Eski `v2` dosyası `app-release-signed-v2.OLD.apk.bak` olarak yedeklendi, silinmedi.
- **Henüz kullanıcıya gönderilip telefonda test edilmedi ve GitHub'a yüklenmedi.**

### Üçüncü ikon revizyonu — çerçeve/yazı/ışık kaldırıldı, sade logo (4 Eylül 2026, v4)

Kullanıcı v3'ü de beğenmedi: hâlâ soldan bir ışık/parlama vardı, altın ikon tek tonda değildi (gölgeli görünüyordu) ve ikon tam ortalanmamıştı. Ayrıca bu turda tasarımı da sadeleştirmeye karar verdi — **altın kare çerçeve ve alttaki "Tarif Kutusu" yazısı tamamen kaldırıldı**, sadece tencere kapağı + kitap/ayraç ikonu kaldı. Kullanıcı Gemini'de görseli birkaç kez daha revize ettirdi (Claude'un yazdığı promptlarla: önce çerçeve+yazı+genel ışıklandırma kaldırıldı, sonra kalan sol üst köşedeki parlama da kaldırılıp ikon tek tonda + ortalı hale getirildi) ve son hâlini onayladı: `Gemini_Generated_Image_a8tntsa8tntsa8tn.jpg` — düz koyu yeşil kumaş dokusu, ortada tek tonlu altın ikon, çerçevesiz, yazısız, ışıksız.

- Aynı script (`sharp` ile resize + `ic_launcher.png` için ~%6 köşe yuvarlama) bu yeni kaynak görsele karşı tekrar çalıştırıldı — hem web ikonları (`icon-512.png`, `icon-192.png`, `icon.svg`, kök + `app/public/`) hem Android launcher ikonları (`ic_launcher`/`ic_maskable` her yoğunlukta, `store_icon.png`) güncellendi.
- Sürüm `3`'ten `4`'e çıkarıldı (`build.gradle`, `twa-manifest.json`), APK yeniden derlenip aynı keystore ile imzalandı; sertifika SHA-256 yine `c1aa4f2f...b4882e1` — üzerine güncelleme olarak kurulabilir. Çıktı: `android-twa/app-release-signed-v4.apk`. Eski `v3` dosyası `app-release-signed-v3.OLD.apk.bak` olarak yedeklendi.
- **Henüz kullanıcıya gönderilip telefonda test edilmedi ve GitHub'a yüklenmedi.** (v3 de hiç test edilmeden v4 ile değiştirildi.)

### Dördüncü ikon revizyonu (4 Eylül 2026, v5)

Kullanıcı aynı görseli tekrar gönderdi (`Gemini_Generated_Image_a8tntsa8tntsa8tn (1).jpg`) — piksel karşılaştırmasında ikonun kendisi v4'teki ile birebir aynı konumdaydı, sadece kanvas 1024×1024'ten 894×899'a kırpılmış/küçültülmüştü (dolayısıyla kenar boşluğu oranı biraz azalmıştı — yine de güvenli, ~%19-23 aralığında). Claude bunu fark edip kullanıcıya sordu; kullanıcı "bu biraz daha farklı" diyerek bu görselin gerçekten kullanılmasını istedi, o yüzden **bu daha dar kırpılmış versiyon** v5 için kaynak olarak kullanıldı.

- Aynı üretim script'i bu kaynakla tekrar çalıştırıldı (web ikonları + Android launcher ikonları + `store_icon.png`).
- Sürüm `4`'ten `5`'e çıkarıldı, APK yeniden derlenip imzalandı; sertifika yine aynı (`c1aa4f2f...b4882e1`). Çıktı: `android-twa/app-release-signed-v5.apk`. Eski `v4` dosyası `app-release-signed-v4.OLD.apk.bak` olarak yedeklendi.
- **Henüz kullanıcıya gönderilip telefonda test edilmedi ve GitHub'a yüklenmedi.**
- **Not:** v2'den beri (icon değişikliği + güncelleme bandı özelliği) hiçbir şey GitHub'a yüklenmedi — hepsi bu makinede birikti. Bir sonraki adımda muhtemelen hepsini tek seferde yüklemek gerekecek.

## Uygulama içi güncelleme bildirimi (4 Eylül 2026)

Yeni bir deploy yayına çıktığında, uygulamayı zaten açık/kurulu tutan kullanıcılara (özellikle Android TWA'da, sekme hiç kapanmadığı için) "Güncelleme mevcut" bandı çıkıp tek tıkla güncelleme yapabilsinler diye eklendi. Servis worker'a değil, basit bir sürüm-karşılaştırma yöntemine dayanıyor:

- `app/vite.config.js` her `vite build` çalıştığında `Date.now()` ile bir `buildVersion` üretiyor; bunu hem JS bundle'ının içine `__APP_VERSION__` global sabiti olarak gömüyor (Vite `define`), hem de build çıktısına ayrı bir `dist/version.json` (`{"version": "..."}`) dosyası olarak yazıyor (`closeBundle` hook'u). Yani her deploy'da ikisi de aynı, yeni bir değer alıyor.
- `app/src/App.jsx` içindeki `useUpdateAvailable()` hook'u sayfa açıldığında ve her 5 dakikada bir (+ sekme/uygulama tekrar görünür olduğunda `visibilitychange`) `/version.json`'ı `cache: "no-store"` ile çekip bundle'daki `__APP_VERSION__` ile karşılaştırıyor. Farklıysa `updateAvailable` true oluyor.
- Farklıysa ana ekranda `Header`'ın hemen üstünde sarı `UpdateBanner` çıkıyor ("Yeni bir güncelleme mevcut" + "Şimdi Güncelle" butonu); butona basınca `window.location.reload()` çalışıyor — servis worker/cache katmanı olmadığı için düz bir reload yeni `index.html` + yeni hash'li JS/CSS dosyalarını indirmeye yetiyor.
- **Henüz canlıda test edilmedi** — yerelde `npm run build` ile `dist/version.json`'ın doğru üretildiği ve `__APP_VERSION__`'ın bundle'a gömüldüğü doğrulandı, ama gerçek bir "eski sürüm açıkken yeni deploy yapılınca banner çıkıyor mu" testi kullanıcı tarafından canlıda yapılmalı.
- Bu değişiklik henüz GitHub'a yüklenmedi (`app/vite.config.js`, `app/src/App.jsx`).

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

### Test edilip kapatılan maddeler
- Android APK'nın telefonda TikTok paylaşım menüsünde "Tarif Kutusu" olarak çıkıp tam ekran açılması — kullanıcı tarafından test edildi, çalışıyor (3 Eylül 2026).
- Android PWA (GitHub Pages shim) paylaşım menüsü testi (icon-192/512 + `sw.js` düzeltmesi sonrası) — kullanıcı tarafından test edildi, çalışıyor (3 Eylül 2026).
- Google ile canlı giriş — kullanıcı kendi Google hesabıyla `tarif-kutusu-paylas.vercel.app` üzerinde test etti, çalışıyor (4 Eylül 2026).
