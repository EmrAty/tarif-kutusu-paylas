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
