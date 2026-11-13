# Grup 5 — güvenilir testler, CI ve kontrollü yayın

Dal `group-5-ci-release`, Grup 4'ün son commit'i `071fec2` üzerinden (Grup 4 worktree'si temizdi ve origin ile aynıydı; Grup 3–4 main'de değil, main `52e04fd`).
Commit'ler: `98822c3` (testler), `ab5f413` (CI + yayın araçları), ardından bu not.
Main'e merge / push ve production yayını YOK. Production verisine dokunulmadı (yalnızca kimliksiz, salt okunur `verify:deploy` istekleri).
Yayın akışı ve komutlar: **[RELEASE.md](RELEASE.md)**.

## 1. AI maliyet sayacı testlerindeki kararsızlık — sebep ve çözüm

**Düşen testler:** `aiHardening` → "maliyet sayacı: eşzamanlılık reddi global sayacı artırmaz" ve hemen ardından "maliyet sayacı: doğrulama, eski istemci, giriş ve hız sınırı redleri sayılmaz".

**Sebep (yeniden üretildi):** Dakika sınırı değildi — bu testlerde AI korumasının saati zaten sabit. İlk test 5 isteği başlatıp **sabit 50 ms** bekliyor, sonra "5'i de Anthropic'e ulaştı" diye sayıyordu. Makine yüklüyken (CI, paralel çalışan test dosyaları) ilk JWT doğrulaması ve Redis adımları 50 ms'ye sığmıyor → `0 !== 5`. Test yarıda düşünce geride kalan istekler devam edip **bir sonraki testin** sayaçlarına yazıyordu → ikinci test de düşüyordu. Yük altında 12 paralel koşuda 2–4 hata ile tekrarlanabildi.

**Çözüm (test tarafı; üretim kodu değişmedi):**
- `test/helpers/async.mjs`: `waitFor(koşul)` (süre sınırlı, açıklayıcı hata) ve `drainBackground()`. İkincisi Vercel `waitUntil()` işlerini, `@vercel/functions`'ın okuduğu istek bağlamı üzerinden izler.
- Sabit beklemeler ve "N kez dene" döngüleri duruma göre beklemeye çevrildi (aiHardening, aiAbuse, integration, group3Fcm, recipeJobs*, dataConsistency, accountDeletion). Her test önceki testin arka plan işleri bitince başlar; asılı istekler `finally` içinde serbest bırakılır.
- Aynı taramada bulunan iki gizli kırılganlık daha:
  - `accountDeletion`: önceki testin job'u 5 sn bildirim gecikmesinden sonra yeni testin temizlenmiş verisine yazıyordu; eski 300 ms bekleme bunu tesadüfen görmüyordu (artık iş bitene kadar beklenip sonuç doğrulanıyor).
  - `recipeJobsLifecycle` 2: bildirim gecikmesi job'un kendi `startedAt`'ine göre değil, yanıtın teste dönüş anına göre ölçülüyordu → yükte düşüyordu.
- Hiçbir test silinmedi, hiçbir doğrulama gevşetilmedi.

## 2. Test kapsamı

Mevcut kapsam veri kaybı (sürümlü kovalar), aile/Plus kilidi, FCM kayıtları ve legacy erişim için zaten geniş. Eklenen:
- `test/authContract.test.mjs` (15 test): tüm `api/*.js` uçları × yöntemleri için token yok / Bearer'sız / bozuk / süresi geçmiş / başka proje (aud) / başka yayıncı / tanınmayan anahtar / bilinmeyen kid / `alg: none` / uid'siz → 401, Redis'e tek komut ve dış servise tek istek yok. Silinmiş hesabın token'ı yalnızca `DELETE /api/account`'ta kabul. Gövde/sorgudaki `uid` başkasının verisine erişim sağlamıyor; Plus test anahtarı yalnızca kendi profilini değiştiriyor; üye olmayan aile verisini okuyamıyor/yazamıyor/özet alamıyor/bildirim gönderemiyor. Yeni bir API dosyası tabloya yazılmazsa test düşer.
- Mutasyonla doğrulandı: `auth.js`'ten audience kontrolü kaldırılınca test kırmızıya döndü.
- `npm test` artık `test/`, `src/`, `shared/` altındaki tüm `*.test.mjs`'leri glob ile çalıştırıyor (eskiden elle liste; listeye eklenmeyen dosya sessizce atlanırdı).
- Testler gizli anahtar, gerçek kullanıcı verisi ve ücretli AI çağrısı olmadan çalışıyor; tanımsız dış istek testi düşürüyor.

## 3. CI ve lint
- `.github/workflows/ci.yml`: her push'ta ve main'e PR'da Node 24 + `npm ci` + lint + test + build + `version.json` commit kontrolü. Anahtar yok, yalnızca okuma yetkisi. Repo herkese açık → Actions ücretsiz.
- `app/eslint.config.js` (eslint 9.39.4, react-hooks 7.1.1, globals 16.5.0 — sabit sürüm): yalnızca çökme türü kurallar (`rules-of-hooks`, `no-undef`, birkaç `eslint:recommended` hata kuralı). Mevcut kodda 0 bulgu; Grup 3'teki FamiliesView hook hatasını (eski `d96cb1d` App.jsx) yakaladığı doğrulandı. Var olan paket sürümleri değişmedi (kilit dosyası karşılaştırıldı).

## 4. Yayın düzeni
- `version.json` artık `commit`, `ref`, `env` de taşıyor (Vercel'in `VERCEL_GIT_*` değişkenleri; yerelde git). İstemci yalnızca `version`'ı okuyor → güncelleme bandı davranışı aynı.
- `npm run verify:deploy`: salt okunur yayın kontrolü (sürüm/commit, ana sayfa, paket, yasal sayfalar, API'lerin kimliksiz 401'i). Preview anahtarı dosyadan okunur, yazdırılmaz.
- `npm run release:check -- <sha>`: origin'de mi, main'e fast-forward mı, CI yeşil mi, Preview aynı commit'i mi yayınlıyor; ardından elle adımları sorar ve tam push komutunu yazar. Kendisi push etmez.
- Yayın: `git push origin <sha>:refs/heads/main` (yalnızca fast-forward → production'a test edilen SHA çıkar; GitHub "Merge" düğmesi kullanılmaz). Geri dönüş: veri biçimi uyumluysa Vercel Instant Rollback, değilse önce rapor (RELEASE.md).

**Zorunlu / elle ayrımı:** RELEASE.md'deki tabloda. Kısaca: CI ve Preview derlemesi otomatik; "CI kırmızıyken main'e giremez" kuralı **henüz açık değil** (GitHub ayarı, aşağıda öneri); telefon testi, denetim, `release:check` ve yayın sonrası kontrol elle.

## 5. Doğrulama

**Yerelde:**
- `npm run check` (lint + 349 test + build) temiz.
- Kararlılık: AI test dosyaları 14'erli paralel gruplarla 84 kez → 0 hata (değişiklik öncesi aynı yükte ~%5 hata). Tüm paket 6'şarlı paralel 24 kez → 0 hata.
- `verify:deploy` production'a karşı (yalnızca kimliksiz okuma): 13/13 geçti; `version.json`'da commit yok (production Grup 5 öncesi derleme — beklenen).
- `verify:deploy` mevcut Preview'a (Grup 4, `071fec2`) bypass anahtarıyla: 12/13; tek kırmızı "commit yok" (Grup 5 öncesi derleme — beklenen). Anahtarsız istek 302 (koruma açık).
- `release:check 071fec2`: CI yok ve Preview commit'i doğrulanamıyor diye doğru şekilde reddetti.

**GitHub / Vercel'de gerçekten denenen:**
- Yalnızca `group-5-ci-release` push edildi (main `52e04fd` değişmedi).
- GitHub Actions `CI / check` (`ab5f413`): **success**, run 43382863000 (~26 sn: npm ci 7 sn, lint 1 sn, testler 6 sn, build 3 sn, version.json commit kontrolü geçti). Bu, iş akışının GitHub'da gerçekten çalıştığı ilk koşu.
- `release:check ab5f413`: origin ✔, main'e fast-forward ✔ (14 commit ileri), CI ✔, Preview ✖ (Preview adresi henüz bu dala bağlı değil) → kapı doğru şekilde kapalı.
- Vercel Preview derlemesi (`ab5f413`): GitHub deployment 7759356121 → `success` ("Deployment has completed", `tarif-kutusu-paylas-qvhqkmu7m-emre-c391.vercel.app`). `*.vercel.app` bu makineden erişilemediği için (TLS/fetch failed, eskiden bilinen engel) içerik doğrudan kontrol edilemedi.
- `preview.tarifkutusu.app` **Grup 5 dalına bağlanmadı**: Chrome eklentisi bağlı değildi ve Vercel CLI/gh kurulu değil. Adres hâlâ `group-4-family`'yi yayınlıyor; test APK'sı ve erişim anahtarı etkilenmedi.

## 6. Kalan işler
1. **Vercel → Domains:** `preview.tarifkutusu.app`'i `group-5-ci-release` dalına bağla (ya da Grup 3+4+5 birleşik dalına). Sonra:
   `cd app && npm run verify:deploy -- --url https://preview.tarifkutusu.app --commit <sha> --bypass-file C:\Users\emrea\tk-clone-group3-apk\app\android\local.properties`
2. Telefonla kısa duman testi (RELEASE.md listesi) — Grup 5 uygulama davranışını değiştirmiyor; yalnızca `version.json`'a alan eklendi.
3. Fable denetimi (Grup 3–4–5 birleşik + tüm uygulama).
4. Grup 5 main'e alındıktan **hemen sonra** önerilen GitHub kuralı (RELEASE.md → "Önerilen GitHub ayarı"): main'e force-push/silme yasak + `check` zorunlu. Bu, production'a çıkışı değiştirdiği için uygulanmadı; kullanıcı onayı bekliyor.
5. Bilinen, bu grubun dışında: Play App Signing SHA → Firebase kontrolü; ödeme entegrasyonu yok (Plus test düğmesi korunuyor).

## 7. Fable denetimi ikinci tur (B1–B6) — 13 Kasım 2026

Commit'ler (yalnızca `group-5-ci-release`): `a7f1339` (önceki çalışma ağacı: güvenlik başlıkları, verify-deploy, notify guard, auth yorumu + denetim testi), `3bb9a67` (B4/B5), `a81ee3d` (B3/B6), `26f12f8` (B1/B2 sunucu), `038cdf7` (B1 istemci). Testler: `test/group5Followup.test.mjs` (B3–B6), `test/group5GuestMerge.test.mjs` (B1/B2), `src/guestMergeClient.test.mjs`. `npm run check`: lint temiz, **411/411**, build temiz.

### B1/B2 — dayanıklı misafir → mevcut hesap taşıma
- **Eski sorun:** misafir ID token'ı yalnızca bileşen state'indeydi; taşıma isteği başarısız olup uygulama kapanırsa / 1 saat geçerse misafir verisi erişilemez anonim uid'de kalıyordu.
- **Yeni akış:** (1) misafirken `POST /api/account {action:"createGuestMergeTicket"}` → rastgele bilet; cihazda `localStorage["tarif-kutusu:guest-merge-ticket"]`'a yazılıp geri okunarak doğrulanır, yazılamazsa hesaba geçilmez. (2) Hesaba geçilir (başarısızsa misafir kalır, bilet zararsız). (3) Uygulama her açılışta/oturum değişiminde bileti talep eder (`claimGuestMergeTicket`) ve `resumeGuestMerges` ile sunucudaki yarım taşımaları bitirir — başka cihazda da. Üst bantta (Hesabım dışında) durum görünür.
- **Adımlar:** tarifler → kiler → alışveriş listesi → aile üyelikleri → temizlik (misafir Redis verisi + anonim Firebase kullanıcısı `deleteAccount` ile). Her adım tekrar çalıştırılabilir; her yazım noktasında kesinti + devam testi var (kopya yok, aile hiçbir an sahipsiz değil).
- **Aile:** misafirin üyeliği + sahipliği hedefe geçer (kıdem `joinedAt` korunur; Plus şart değil, aile kilitli görünür). Hedef zaten üyeyse misafir çıkar, sahiplik hedefe. Hedef 2 aile sınırındaysa: başka üye varsa sahiplik o üyeye (en eski), misafir ayrılır; misafir tek üyeyse ailenin tarifleri/kileri hedefin kişisel listesine kopyalanır (alışveriş listesi kişiseldeki kuralla: hedefinki boşsa), sonra aile silinir. Her aile sonucu yanıtta `families[<id>].result`.
- **Bağlama anında misafir dondurulur** (`deleted-account:<misafir>` TTL'siz): misafirin başka cihazdaki açık oturumu artık yazamaz (401 "Bu hesap silindi."). Temizlik bu işareti olağan 24 saatlik işaretle değiştirir.
- **Hesap silme:** hedef silinirken bağlı/bekleyen misafirlerin kalıntıları, durum kayıtları ve bilet kayıtları da silinir; misafir kendi hesabını silerse açık bileti silinir.
- Eski yol (`mergeGuest` + guestToken) aynı motoru kullanır (eski paketler için).

**Yeni Redis anahtarları**
| Anahtar | İçerik | TTL |
|---|---|---|
| `guest-merge:ticket:<sha256(bilet)>` | `{guestUid, createdAt}`; tamamlanınca `{status:"done", targetUid, report}` | açıkken YOK; tamamlanınca 30 gün |
| `guest-merge:state:<misafir>` (+ `:version/:backups/:daily-backups`) | bağlı hedef, adım durumu, rapor | yok; taşıma bitince silinir |
| `guest-merge:lock:<misafir>` | eşzamanlı çalıştırma kirası | 120 sn |
| `user:<hedef>:guestMerges` (+ sürüm/yedek) | `{<misafir>: {boundAt, status, completedAt?, report?, ticketHash?}}` | yok; hesapla silinir; 90 günden eski "done" kayıtları budanır |
| `user:<misafir>:mergedInto` | Grup 5 ilk sürümüyle uyum (artık TTL'siz) | misafir silinince gider |
| `rl:data-write:u:<uid>:*`, `rl:data-write:ip:<hash>:*` | veri yazım hız sayaçları | pencere + 5 sn |

### B3 — kova boyutu ve yazım hızı (`api/_lib/bucketLimits.js`)
- Tarifler ≤2 MB / ≤2000 kayıt; alışveriş listesi ≤200 KB, yalnızca `selected` (id dizisi), `checked` (anahtar→bool), `servings` (id→0<n≤1000), ≤2000 giriş; kiler ≤100 KB / ≤500 öğe, her öğe boş olmayan ≤200 karakter metin. Yalnızca **büyüten** yazım reddedilir (413 `bucket_too_large`; biçim hatası 400 `invalid_bucket_value`); tavanın üstündeki eski kova küçültülebilir/aynı boyutta düzenlenebilir; değişmemiş eski alan/öğe engel olmaz.
- Hız: hesap başına dakikada 240 / saatte 4000 (misafir 2000) yazım; misafirde ayrıca IP başına 1200/dk, 20000/sa. Redis sayaçları çalışmazsa **geçirilir** (yazımın kendisi zaten Redis'e gidiyor).
- `recipe-jobs` aynı tarif tavanını uygular. Misafir taşıması kullanıcının kendi verisi olduğu için tavanın **2 katına** kadar büyütebilir; onu da aşarsa durur (`blocked`), misafir verisi silinmez, yer açılınca devam eder.

### B4/B5/B6
- B4: aynı-tarif beklemesi önce (reddedilirse hiçbir sayaç artmaz), sonra gönderenin sayaçları, en son aile sayacı (aşılırsa geri alınır). Eski testteki "çift dokunma da sayılır" beklentisi buna göre güncellendi.
- B5: `GET /api/profile` bozuk profilde/Redis hatasında 502 + kod. Diğer uçlar zaten try/catch içindeydi (tarandı); `recipe-jobs` hata yanıtına kod eklendi.
- B6: sınırın üstündeki Free hesapta önceki listede olmayan her id gerçek "geri al" olmalı (uzunluk aynı kalsa da). Aynı listede tekrar eden id 400 `invalid_recipe`; eski kayıtta zaten tekrar varsa kilitlenmez.

### Geri dönüş (rollback) uyumu
- Önceki sunucuya dönülürse: yeni anahtarlar yok sayılır (zararsız). Bağlanmış ama bitmemiş taşımada misafir donmuş kalır ve eski sunucu taşımayı sürdüremez → yeni sunucu geri gelince kaldığı yerden devam eder. Eski sunucunun `mergeGuest` yolu `user:<misafir>:mergedInto` işaretini okur (yeni kod da yazıyor), başka hedefe taşıma yapamaz.
- Yeni istemci eski sunucuda: `createGuestMergeTicket` 400 alır → "Geçiş hazırlanamadı", misafir kalır (veri kaybı yok).
- B3 sınırları yalnızca yeni sunucuda; eski sunucuya dönmek sınırları kaldırır, veri bozmaz.

### Telefonda doğrulanacaklar (yapılmadı)
1. Misafir → "Giriş Yap" (mevcut hesap) → onay → geçiş; üst bantta "taşınıyor/taşındı"; tarifler/kiler/aile hedefte.
2. Onaydan sonra internet kesilip uygulama kapatılınca: tekrar açınca taşıma kendiliğinden bitiyor mu.
3. Aynı hesapla ikinci cihazdan açılışta yarım taşımanın bitmesi.
4. Google ile bağlanmada (native) aynı akış; giriş iptalinde misafir verisinin değişmediği.
5. Çok hızlı işaretlemede alışveriş listesinde 429 görülmemesi.

### Açık ürün kararları
- Hedef başına 30 günde en çok 3 taşıma (`GUEST_MERGE_LIMIT`) — **ürün kararı bekliyor.**
- Taşımada Free sınırı uygulanmıyor (sınırın üstü kilitli görünür) — varsayılan karar, onay bekliyor.
- Kova tavanları (2 MB / 200 KB / 100 KB / 500 öğe) ve taşımanın 2 kat payı — gözden geçirilmeli.
- CSP `script-src` (Report-Only): **eklenmedi.** Rapor toplayacak uç yok (yalnızca tarayıcı konsoluna düşerdi), Firebase Auth popup'ı `apis.google.com` ve iframe kullanıyor; değeri düşük, yanlış ayarın Enforce'a dönüşmesi riskli. Rapor ucu kurulursa yeniden değerlendirilmeli.
- `android:allowBackup` (native): dokunulmadı, açık iş.

## 8. Fable denetimi üçüncü tur (K1–K3) — 13 Kasım 2026

Commit'ler: `2eef55a` (sunucu), `59a99db` (istemci). `npm run check`: lint temiz, **419/419**, build temiz. §7'deki "sınırda bilet bağlanmaz" davranışı aşağıdaki K1 ile **değişti**.

- **K1 — sınırda ertelenmiş bağlama.** 30 günlük pencere doluyken claim misafiri yine KALICI bağlar: dizinde `status:"deferred"` kaydı, durum kaydı hedefe bağlı, misafir donuk. Adımlar çalışmaz; yanıt `{status:"deferred", startAfter:<ms>}` döner ve bantta "sıraya alındı, en erken <tarih>" yazar. Pencere açılınca `resumeGuestMerges` (herhangi bir cihaz, biletsiz) ertelenmişleri **ertelenme sırasıyla** başlatır. Pencereye yalnızca başlatılmış/tamamlanmış taşımalar sayılır (`startedAt`; eski kayıtlarda `boundAt`). Hedef başına en çok **10** ertelenmiş kayıt (`GUEST_MERGE_DEFERRED_MAX`); aşılırsa 429 `guest_merge_limit` döner, misafir bağlanmaz/dondurulmaz, bilet geçerli kalır. Hedef silinince ertelenmiş misafirler de silinir. İstemci artık tek yuva yerine **bilet listesi** tutar (`tarif-kutusu:guest-merge-ticket`, eski tek-nesne biçimi de okunur); her bileti sırayla talep eder, sunucuda bağlananı siler.
- **K2 — alışveriş listesi birleştirme.** Hedefin listesi doluysa liste artık atlanmaz, birleştirilir: `selected` birleşimi (önce hedefinkiler), `checked`/`servings` alanlarında hedefin değeri korunur, yalnızca misafirde olan anahtarlar eklenir; bilinmeyen eski alanlarda çakışmada hedefinki korunur. Dağıtılan tek üyeli ailenin listesi için de aynısı geçerli. İdempotent; tavan için mevcut "blocked" kuralı. Rapor değeri `"merged"` (`kept_existing` / `not_copied_target_list_not_empty` artık yok). Onay ve sonuç metinleri (TR/EN) güncellendi.
- **K3 — dondurma garantisi.** `runMerge` (adımlardan önce, aile adımı bitmemişse) ve ertelenmiş kayıtlar için `startOrDefer`, `deleted-account:<misafir>` ve `user:<misafir>:mergedInto` işaretlerini idempotent olarak yeniden yazar.
- **Okunamayan misafir profili:** aile adımı tamamlanmaz, taşıma `blocked` (`guest_profile_unreadable`) kalır, misafir silinmez (aile öksüz kalmaz); profil düzelince resume bitirir. Üyelikleri aile üye listelerini tarayarak bulmak seçilmedi: tüm aileleri taramayı gerektirir.
- Yeni anahtar yok; `user:<hedef>:guestMerges` kayıtlarına `startedAt` alanı ve `"deferred"` durumu eklendi. Geri dönüşte eski sunucu `deferred` kaydı tanımaz: misafir donuk kalır, veri kaybolmaz, yeni sunucu geri gelince devam eder.
- **Telefonda doğrulanacak (ek):** sıraya alınmış taşıma bandı ve tarih biçimi; iki misafir hesabından art arda geçiş.
- **Ürün kararı (ek):** ertelenmiş üst sınırı 10.
