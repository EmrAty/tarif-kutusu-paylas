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

## Kalan işler
1. Kullanıcı: Anthropic Console + OpenAI'da aylık harcama limiti.
2. Telefonda doğrulama: TikTok paylaş → caption → job → bildirim; Yeni Tarif Çıkar + ekran görüntüsü.
3. Grup 1 main'e alındıktan sonra entegrasyon. Beklenen çakışmalar: `app/package.json` (test script, kesin), `app/api/recipe-jobs.js` (Grup 1 `jobRecipes.js`'i sildi), `app/src/App.jsx`, `app/src/i18n.jsx`, olası `app/api/_lib/redis.js`. Grup 1'in Redis test taklidi `/pipeline` desteklemiyorsa koruma testlerde fail-open olur.
4. Entegrasyondan sonra `CLAUDE.md` güncellenecek (çakışma olmasın diye şimdi yazılmadı).
5. İleride değerlendirilebilir: Firebase App Check / Play Integrity (native + yeni APK gerekir).
