# Grup 3 — FCM token yaşam döngüsü + legacy veri erişimi

Branch `group-3-legacy-fcm`, production main `52e04fd` üzerinden. Main'e merge / deploy YOK.

## Problem 8 — FCM

**Kök neden (koddan doğrulandı):**
- Tek liste `user:<uid>:fcmTokens` (JSON dizi). Native Android token'ı ile Chrome web-push token'ı aynı `/api/fcm-token`'a, platform bilgisi olmadan yazılıyordu (`App.jsx` web'de `requestFcmToken`, native'de `nativeFcmToken`).
- `recipe-jobs.js` → `notifyUserDevices` listedeki HER token'a gönderiyordu → Chrome da tarif bildirimi alıyordu.
- Chrome'da tek mesajın iki bildirim olması: `firebase-messaging-sw.js` `onBackgroundMessage` içinde `showNotification` çağırıyordu; mesajda `notification` alanı olduğu için Firebase SDK bildirimi zaten kendisi gösteriyor → aynı mesaj 2 kez. (Diğer olasılık: aynı hesapta birden çok web token'ı — eski token'lar hiç silinmiyordu. Production verisi okunmadı; Preview'da doğrulanmalı.)
- Ayrıca: token birden çok hesapta kalabiliyordu, çıkışta silinmiyordu, yenilenen token eskisini silmiyordu, `INVALID_ARGUMENT` (yük hatası da olabilir) token'ı siliyordu.

**Yeni şema (`api/_lib/fcm.js`):**
- `user:<uid>:pushTargets` HASH: token → `{platform, installationId, updatedAt}`.
- `push-owner:<sha256(token)>` = uid (270 gün TTL): token'ın tek sahibi. Okumada sahibi başka olan kayıt hedeflenmez ve tembel silinir.
- Aynı `installationId` yeni token kaydederse eskisi silinir; hesap başına en çok 10 kayıt.
- Tarif hazır/başarısız: `nativeOnly` → yalnızca `android`. Hiç android kaydı yoksa geçiş için yalnızca eski listedeki, sahibi başka olmayan token'lar (web etiketliler asla).
- Job başına dedupe: `push-sent:<uid>:<jobId>:ready|failed` (SET NX, 7 gün). Redis hatasında gönderilir.
- Kalıcı geçersiz: `UNREGISTERED`, `SENDER_ID_MISMATCH`, `NOT_FOUND`, ya da mesajı "registration token" diyen `INVALID_ARGUMENT`.
- Aile "canı çekti" (`notify.js`) platformdan bağımsız kalır (Android + web), yinelenmesiz.
- Çıkış: `DELETE /api/fcm-token {token, installationId}` (istemci `signOut`'tan önce, 3 sn zaman aşımı).
- Hesap silme: `pushTargets` silinir, sahiplik işaretleri yalnızca hâlâ bu hesaptaysa bırakılır.

**Geçiş:** eski liste silinmez; token platformla yeniden kaydedildikçe oradan çıkar. Android uygulaması web paketini canlı sunucudan yüklediği için, deploy sonrası her uygulama açılışında token `android` etiketiyle yeniden kaydolur — yeni APK gerekmez.

## Problem 4 — Legacy veri

**Kaynak:** `api/legacy.js` UID'siz global `recipes` / `shopping-list` / `pantry-items` anahtarlarını giriş yapmış HERKESE (anonim misafir dahil) veriyordu; `App.jsx` `importLegacyInto` bunu kişisel listeye ya da aileye aktarabiliyordu.

**Düzeltme:** varsayılan kapalı. Yalnızca `LEGACY_DATA_OWNER_UIDS` (Vercel env, virgülle) içindeki anonim olmayan hesaplar okuyabilir; diğerleri 403 `legacy_not_eligible` ("aktarılacak eski veri yok"). Bozuk/kısmi veri `null`. Global anahtarlar silinmez. Aktarım yine boş kovaya `baseVersion 0` ile (dolu kova 409, ezilmez).

**Aile erişimi:** `assertFamilyAccess` (profil + `family:<id>:meta` + üye listesi birlikte) artık `data.js`, `notify.js`, `translate-recipe.js`'te. Eskiden yalnızca profildeki liste kontrol ediliyordu.

Taranan diğer yerler: kişisel veri her yerde token uid'siyle (`user:<uid>:*`); "yeni boşsa eskiyi oku" fallback'i, migration-on-login, anonim→hesap otomatik veri taşıma kodu YOK (`googleLink` bilerek taşımıyor).

## Test
`test/group3Fcm.test.mjs` (17), `test/group3Legacy.test.mjs` (11). `npm test` 234/234, `vite build` temiz.
