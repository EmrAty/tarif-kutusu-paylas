# Grup 3 — FCM token yaşam döngüsü + legacy veri + aile üyeliği

Branch `group-3-legacy-fcm`, production main `52e04fd` üzerinden. Main'e merge / push / deploy YOK.
İlk sürüm `73d9338` Fable tarafından denetlendi; bu notlar denetim sonrası revizyonu anlatır.

## Aile üyeliği (Fable D1)

**Kök neden:** `family:<id>:members` ve `user:<uid>:profile` "oku → değiştir → geri yaz" ile yazılıyordu (katılma, ayrılma, görünen ad senkronu, Plus kapatma, hesap silme). Eşzamanlı iki yazımda biri diğerini eziyordu; katılan üye listeden düşüp profilde aile kalabiliyordu. Grup 3'ün sıkı üyelik kontrolü bunu 403 olarak görünür kıldı.

**Düzeltme:** üye listesi ve profil artık Grup 1'in karşılaştır-ve-yaz motoruyla (`mutateBucket`, Lua, sürüm + yedek) yazılıyor: `updateMembers`, `updateProfile`. Düz `SET` ile profil yazan yol kalmadı (`setProfile` kaldırıldı). Çakışmada güncel değer yeniden okunup niyet tekrar uygulanıyor.

**Mevcut tutarsız kayıtlar:** otomatik üyelik verilmez. Profilde olup üye listesinde olmayan aile:
- veri / bildirim / çeviri: 403;
- `GET /api/families`: yalnızca `{id, name, membership: "unverified"}` (davet kodu ve üye listesi gösterilmez);
- onarım: geçerli davet koduyla tekrar katılma (`repaired: true`, eski katılma tarihi korunur) ya da ayrılma.
Ters durum (üye listesinde var, profilde yok) da aynı kodla onarılır. Katılmada profil yazılamazsa üye listesine eklenen geri alınır.

**Silme ↔ katılma yarışı (ikinci denetim):** ortak `deleteFamilyCompletely` (kurucu silmesi ve hesap silmede son üye): 1) meta'ya `deleting` işareti, 2) davet kodu silinir, 3) üye listesi işaretten SONRA okunup her üyenin profilinden aile çıkarılır (kurucu en son), 4) veri + üye listesi, 5) meta en son. Katılma, üye listesi + profil yazımından SONRA meta'yı yeniden okur; yoksa ya da `deleting` ise kendini geri alır (404) ve yeniden yarattığı boş üye listesini siler. Biri mutlaka yarışı görür. `deleting` aileye veri erişimi/katılma/job yok (404). Yarıda kalan silme: özet `membership: "deleting"`; kurucu "Silmeyi Tamamla", üyeler "Aileden Ayrıl".

**Hayalet kayıtlar:** profilde olup aile kaydı (meta) BAŞARILI bir okumada (`MGET`, `null`) gerçekten bulunmayan kimlikler, aile listesi açılınca ve katılma/oluşturma öncesi kullanıcının kendi profilinden (atomik) çıkarılır. Okuma hatası fırlar, hiçbir şey silinmez.

**Eski web paketi uyumu:** erişilemeyen özetler `members: []`, `inviteCode: null`, `ownerUid: null` taşır (production paketi `f.members.map(...)` çağırıyor). Kurucu kimliği yalnızca `deleting` durumunda ve yalnızca üyeye/kurucuya.

**React hook düzeltmesi:** `FamiliesView`'de `repairCodes` hook'u erken dönüşten önceye alındı; Plus'sız ama yalnızca erişilemeyen ailesi olan kullanıcı da kartı görür (ayrılabilir).

## Push (Fable D2, D3, D4)

**Şema:** `user:<uid>:pushTargets` (HASH: token → {platform, installationId, updatedAt}), `push-owner:<sha256(token)>` = uid. Eski `user:<uid>:fcmTokens` okunur, silinmez; token platformla kaydolunca oradan çıkar.

**Tarif hazır / başarısız:** yalnızca bu hesaba ait `android` kayıtları. Platformu bilinmeyen eski token'lara artık GİTMEZ (geri dönüş yok). Sebep: eski listede Android ve Chrome token'ı sunucuda ayırt edilemez (ikisi aynı FCM biçimi); ayırt etmenin tek yolu cihazın kendisinin platformla kaydolması. Bedel: ana uygulama deploy sonrası yeni web paketiyle bir kez açılana kadar o cihaza tarif bildirimi gitmez; tarif yine kaydedilir, paylaşım paneli "bu cihaz için bildirim kaydı yok" notunu gösterir.

**Paylaşım paneli / APK:** `ShareActivity` düz WebView; köprüde yalnızca `getSharedText/ready/close/jobAccepted/openInApp` var, FCM token'ına erişimi yok. Ana uygulama (`server.url` ile canlı web paketi) her açılışta token'ı `android` olarak kaydediyor → yeni APK GEREKMİYOR. Paneli token kaydedebilir yapmak native değişiklik (yeni APK) ister; bu turda yapılmadı, gerekli değil.

**Sahiplik (D2):** başka hesabın elindeki token'ı devralmak sahiplik kanıtı ister. Sunucu token'a sessiz (data-only) `push_verify` mesajı gönderir; Android'de sistem bildirimi çıkmaz, ön plandaki uygulama `pushNotificationReceived` ile alır (Capacitor kaynağından doğrulandı); web'de sayfa açıkken `onMessage`. İstemci kodu yalnızca doğrulama bekliyorsa ve kendi oturumuyla geri yollar; kod isteyen hesaba bağlı, tek kullanımlık, 5 dk. Doğrulama push'u token+hesap başına 30 sn'de bir. Sahiplik bayatsa (eski sahip token'ı artık tutmuyor) kanıt istenmez. Normal çıkış → giriş yolunda (çıkış kaydı silindiyse) kanıt gerekmez.

**Çıkış:** `POST /api/fcm-token {action: "unregister"}` (gövdeli DELETE yerine; DELETE geriye uyumlu kabul ediliyor).

**Aile "canı çekti" (D7):** platformdan bağımsız kaldı (Android + web) — ürün kararı bekliyor. Aynı platformda tek mesajın iki kez gösterimi (SW) düzeltildi; farklı kayıtlı cihazlara teslimat ayrı konu.

**Web:** `firebase-messaging-sw.js` notification'lı mesajı kendisi göstermiyor (Firebase SDK zaten gösteriyor — `@firebase/messaging` SW kaynağında doğrulandı: `onPush` önce `showNotification`, sonra `onBackgroundMessage`). İkon artık yükte `webpush.notification.icon`. `push_verify` asla gösterilmez.

**Tekrar engeli:** `push-sent:<uid>:<jobId>:ready|failed` (SET NX, 7 gün) gönderimden önce. Redis hatasında gönderilir (çift ancak aynı job iki kez işlenir VE iki seferde de Redis hata verirse). İşaretten sonra süreç ölürse o bildirim kaybolur. Hesap silmede `push-sent:<uid>:*` de silinir.

## Legacy veri (Fable D5)

Erişim: yalnızca `LEGACY_DATA_OWNER_UIDS` (anonim olmayan). Biçim: repo geçmişinde legacy döneminde (3 Eylül → `42a31ed`) yazılan biçim bugünkü kovalarla aynı: tarif `[{id: "<ms>-xxxxxx"}]` (id metin), alışveriş `{selected: [id], checked: {}}`, kiler `["metin"]`. Dönüşüm yok. Her kova için `missing / empty / ok / invalid(reason)` ayrı raporlanır; `invalid` kısmen aktarılmaz, eski veri yerinde kalır. Kullanıcıya kova başına sonuç gösterilir (aktarıldı / hedefte kayıt var, üzerine yazılmadı / eski veri yok / biçim tanınmadı). Dolu (daha önce yazılmış) hedefe aktarım yok. Production'daki gerçek biçim bilinmiyor → aşağıdaki salt okunur denetimle bakılmalı.

## Salt okunur denetim

`app/scripts/audit-group3-readonly.mjs` — yalnızca SCAN/GET/MGET/HLEN (diğer komutları reddeder), içerik yazdırmaz. Raporlar: tutarsız aile kayıtları, legacy biçim sınıfı, eski/yeni push kayıt sayıları.

## Test
`group3Fcm` (24), `group3Family` (28), `group3Legacy` (12). `npm test` 270/270, `vite build` temiz. Hook sırası testi paket dışında: eslint `react-hooks/rules-of-hooks` + jsdom ile gerçek `FamiliesView` render geçişi (repoya bağımlılık eklenmedi).
