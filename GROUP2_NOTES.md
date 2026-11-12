# Grup 2 — AI güvenliği (Problem 3 + 7 + 9) — devir notu

Durum (11 Kasım 2026): kod tamam, **commit/push YOK**. Değişiklikler bu worktree'de commit edilmemiş olarak duruyor.

- Worktree: `C:\Users\emrea\tk-clone-group2`, branch `group-2-ai-security`, başlangıç `origin/main` = `59e17da`.
- Branch'in upstream'i bilerek kaldırıldı (yanlışlıkla main'e push gitmesin).
- `cd app && npm test` → 146/146, `npx vite build` temiz. `node_modules` bu worktree'de `npm ci` ile kuruldu.
- Grup 1 (`C:\Users\emrea\tk-clone`, main) paralel çalışıyor; ona dokunulmadı. Plan: önce Grup 1 main'e, sonra Grup 2 onun üstüne kontrollü entegre.

## Ne yapıldı
- **P3:** `/api/extract` proxy değil; istemci yalnızca link/caption/notes/images/language gönderir (system/model/max_tokens vb. → 400 `client_update_required`). Ortak sunucu yolu `api/_lib/extractRecipe.js`. Koruma `api/_lib/aiGuard.js`, sınırlar `api/_lib/abusePolicy.js` (dakika/saat/gün, eşzamanlılık kirası, misafir IP tavanı, global tavan, `AI_KILL_SWITCH`, `AI_GLOBAL_HOURLY_LIMIT`, `AI_GLOBAL_DAILY_LIMIT`). Redis yoksa fail-open.
- **P7:** `api/_lib/socialUrl.js` — gerçek URL parser + alan adı allowlist, manuel redirect (her adım doğrulanır, maks 5), zaman aşımı/boyut sınırı, CDN için DNS özel-IP kontrolü. fetch-caption artık auth istiyor; recipe-jobs ve tiktok.js aynı helper'ı kullanıyor.
- **P9:** `shared/imageLimits.js` (istemci+sunucu ortak), `src/imageCompress.js` (1568 px, JPEG 0.85→0.65, 1280 px yedek; maks 6 görsel, ~2,5 MB toplam).
- Testler: `test/aiAbuse.test.mjs`, `test/socialUrl.test.mjs`, `test/imageLimits.test.mjs`, `test/helpers/fakeServices.mjs`; `test/fetchCaption.test.mjs` güncellendi.

## Fable denetimi sonrası sertleştirme (11 Kasım 2026, commit yok)
- Çeviri girdi bütçesi: `api/_lib/aiInputBudget.js` (`checkInputBudget`, `textChars`); `translate-recipe.js` toplam 16.000 karakter, başlık 300, assumptions 4.000, servings_note 2.000, en çok 150 malzeme / 120 adım → 413 `input_too_large`, Claude'a ve hiçbir sayaca gitmeden. Başlık listesi modunda 300+ karakterlik başlık gönderilmez (`skipped`), tek çağrı ≤ 8.000 karakter.
- Maliyet sayacı (`reserveAiBudget`, aiGuard): UID toplamı + global tek pipeline'da, sağlayıcı çağrısından hemen önce; aşılırsa DECR ile geri alınır. Uç hız sayaçları (`checkRateLimit`) ayrı ve denemeleri saymaya devam eder.
- UID toplam tavanı: kalıcı 120/saat, 600/gün; misafir 60/saat, 200/gün; global tavanın en çok %20'si. Env: `AI_USER_HOURLY_LIMIT`, `AI_USER_DAILY_LIMIT`, `AI_ANON_HOURLY_LIMIT`, `AI_ANON_DAILY_LIMIT`.
- recipe-jobs: kira `try/finally` + `handedOff`; maliyet sayacı yalnızca yeni job açılırken (tekrar paylaşım sayılmaz).
- socialUrl: IPv6 kanonik ayrıştırma (`parseIPv6`).
- Fail-open bilerek değişmedi. Testler: `test/aiHardening.test.mjs` (24), toplam 170/170.

## Grup 1 ile entegrasyon (11 Kasım 2026, branch `integrate/group1-group2`, push YOK)
- `5d9862b` (production main) üzerinden branch; Grup 2 (`50b18a7`) normal merge ile alındı (`83103af`), rebase yok.
- Tek git çakışması: `app/package.json` test script'i (iki tarafın test dosyaları birlikte; `fengari` korundu).
- `recipe-jobs.js`: Grup 1 `mutateBucket` (karşılaştır-ve-yaz + çakışmada yeniden deneme) ile Grup 2 kira `try/finally` + `handedOff` + `reserveAiBudget` birlikte; `jobRecipes.js` geri gelmedi.
- `redis.js`: Grup 1 `redisEval` + sıkı `redisCommand`/`redisGet` hata işleme + Grup 2 `redisPipeline` birlikte.
- `client_update_required` artık merkezi güncelleme kapısını da tetikliyor (`src/updateRequired.js`); `extractRecipe` hata yanıtı `src/apiErrors.js` → `classifyErrorResponse` üzerinden kapıya gidiyor, `err.code` korunuyor.
- Test Redis'i tek motor: `test/helpers/memoryRedis.mjs` (gerçek Lua EVAL, MGET, DECR, sıralı küme, `/pipeline`, yanlış türde WRONGTYPE); `fakeServices.mjs` bunu kullanıyor; Grup 1 job testlerine `/pipeline` eklendi (koruma artık orada fail-open'a düşmüyor).
- Yeni `test/integration.test.mjs` (11 test). `npm test` 205/205, `vite build` temiz.

## Preview doğrulaması (12 Kasım 2026, `preview.tarifkutusu.app` → `integrate/group1-group2`)
- Redis izolasyonu: production KV yalnız Production, test KV yalnız Preview; Preview yazımı test Redis'te var, production'da yok.
- Gerçek Upstash: pipeline, hız/kullanıcı/genel sayaçlar ve TTL'ler doğru; loglarda "failing open" yok.
- **Bulunan hata → `2c30ea1`:** kira yanıttan sonra bırakılıyordu (Vercel yanıttan sonraki kodu garanti etmiyor). `deferResponse` ile önce bırak, sonra yanıtla (extract, suggest, recipe-jobs). Fable: SAFE TO PRODUCTION.
- Kill switch (yalnız Preview/branch) 503 verdi, kaldırıldı. Hız sınırı 429 + Retry-After. Job + arayüz yarışında 409 → yeniden deneme, veri kaybı yok. `client_update_required` → kapatılamaz Yenile penceresi, yazımlar duruyor. `input_too_large` → 413, mesaj doğru, pencere yok. Sosyal link doğrulaması ve görsel sıkıştırma (9,7 MB → 1176×1568, EXIF yönü doğru) geçti.
- `a0ca9da`/`b82c6d1` boş commit: Vercel redeploy e-posta kodu istediği için push ile yeniden build.
- `npm test` 206/206, `vite build` temiz. Test hesabı: Preview misafir `syta9…`, test Redis'te.

## Kalan işler
1. Kullanıcı: Anthropic Console + OpenAI'da aylık harcama limiti.
2. Telefonda doğrulama: TikTok paylaş → caption → job → bildirim; Yeni Tarif Çıkar + ekran görüntüsü.
3. ~~Grup 1 ile entegrasyon~~ ve ~~Preview doğrulaması~~ tamam. Sırada: harcama limitleri + Upstash kotası kontrolü, sonra kullanıcı onayıyla main'e merge + production deploy, ardından telefonda 5 smoke test (TikTok kısa link, Instagram, kamera fotoğrafı, art arda 6 çıkarma, paylaşım sırasında favori/silme).
4. Entegrasyondan sonra `CLAUDE.md` güncellenecek (çakışma olmasın diye şimdi yazılmadı).
5. İleride değerlendirilebilir: Firebase App Check / Play Integrity (native + yeni APK gerekir).
