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

## Bilinen eksik / yapılacaklar

1. **iPhone paylaşım entegrasyonu:** iOS Safari, Web Share Target API'yi desteklemiyor (Apple kısıtlaması, düzeltilemez). Android'de uygulama zaten yüklenince paylaşım menüsünde çıkabiliyor. iPhone için plan: kullanıcının telefonunda bir kere kuracağı bir **Kısayollar (Shortcuts) app** kısayolu — TikTok'ta paylaşırken "Tarif Kutusu" olarak çıkıp linki `?link=...` ile uygulamaya atacak. Henüz kurulmadı, kullanıcıyla adım adım yapılacak.
3. **Android APK'nın telefonda test edilmesi bekleniyor:** Kullanıcıya `android-twa/app-release-signed.apk` gönderildi ama telefona kurulup TikTok paylaşım menüsünde "Tarif Kutusu" olarak çıktığı ve tam ekran (adres çubuğusuz) açıldığı henüz doğrulanmadı. Adres çubuğu görünüyorsa `assetlinks.json`/imza uyuşmazlığı olabilir — `android-twa`'daki keystore'dan tekrar fingerprint çıkarıp `app/public/.well-known/assetlinks.json`'daki değerle karşılaştır.
2. **Android paylaşım menüsü testi bekleniyor:** Kullanıcı "ana ekrana ekle" yapmasına rağmen TikTok paylaşım menüsünde uygulama görünmüyordu. Kök neden: Chrome, gerçek bir "WebAPK" (sistem seviyesinde paylaşım hedefi) ancak site tam installability kriterlerini karşılarsa üretiyor; `manifest.json`'da yalnızca tek bir SVG ikon vardı ve hiç service worker kayıtlı değildi — bu yüzden muhtemelen sadece düz bir yer imi (bookmark) oluşmuş, gerçek kurulum tetiklenmemişti. Düzeltme yapıldı (commit `dfa8f2e`, 3 Eylül 2026): `icon-192.png` / `icon-512.png` eklendi, manifest bunlara güncellendi, kök dizine `sw.js` (minimal service worker) eklendi ve `index.html` + `share.html` içinde register edildi. **Kullanıcının hâlâ yapması gereken:** telefonundaki eski "Tarif Kutusu'na Gönder" kısayolunu silip, `emraty.github.io/tarif-kutusu-paylas/` adresini Chrome'da tekrar açıp yeniden "Ana ekrana ekle / Yükle" yapması (menüde "Add to Home screen" değil "Install app" yazısını görmesi gerekiyor), sonra TikTok paylaşım menüsünü test etmesi. Hâlâ çıkmazsa telefonu yeniden başlatmak gerekebilir (Android'in paylaşım listesi cache'leniyor).
