# Grup 4 — aile yönetimi (üye çıkarma, sahiplik, davet kodu, gizlilik)

Branch `group-4-family`, Grup 3'ün son commit'i `d5e447f` üzerinden (Grup 3 henüz main'de değil; main `52e04fd`).
Push / Preview / merge / deploy YOK. Production verisine dokunulmadı.

## Ne değişti

**Yeni işlemler (`POST /api/families`)** — hepsi yalnızca aile sahibi, sunucu doğrular (profil + meta + üye listesi + `ownerUid`):
- `remove {familyId, memberUid}`: önce davet kodu yenilenir, sonra üye listesinden (erişim burada biter), sonra onun profilinden çıkarılır. Kendini çıkaramaz (ayrılmalı).
- `transfer {familyId, memberUid}`: sahiplik başka bir üyeye geçer; eski sahip üye kalır.
- `rotateCode {familyId}`: yeni davet kodu; eski kod hemen geçersiz.
- `leave` artık `newOwnerUid` alabilir: sahip ayrılırken sahiplik ona (yoksa en eski katılana) geçer. Tek üye sahip ayrılamaz: 409 `sole_member` (silebilir).

**Plus şartı:** yalnızca `create` ve `join`. Ayrılma, silme, çıkarma, devir, kod yenileme Plus istemez (Plus'ı kapanan sahip de ailesini yönetebilsin). Eskiden `delete` Plus istiyordu.

**Sahipsiz aile kalmaz (`_lib/families.js`):** `handOffOwnership` (sahip ayrılmadan önce devir), `ensureOwner` (üye listesini küçülten her işlemden sonra: sahip üye değilse en eski üyeye geçer), `leaveFamily` (ayrılma / Plus kapanması ortak yolu). Hesap silme de bunları kullanıyor. Aile listesi açılınca eski kayıtlarda sahibi üye olmayan aile kendiliğinden onarılır.

**Aile kaydı (meta) atomik:** `updateMeta` = Grup 1'in karşılaştır-ve-yaz motoru (`mutateBucket`). Eskiden düz `SET` idi: hesap silmedeki sahiplik devri `deleting` işaretini ezebiliyordu; artık devir, kod yenileme ve silme işareti birbirini ezemez. Silmede `family:<id>:meta:version|backups|daily-backups` da siliniyor.

**Davet kodu (`_lib/inviteCodes.js`):** 10 karakter, 32 harfli alfabe, `crypto.randomInt` (≈1,1·10^15; eski: 6 karakter, `Math.random`, ≈10^9). Gösterim `ABCDE-FGHJK`; giriş tire/boşluk/küçük harf yok sayar. Kod `SET NX` ile ayrılır (çakışmaz). Katılma, kodun meta'daki GÜNCEL kodla eşleşmesini de ister (silinememiş eski anahtar tek başına işe yaramaz). Katılmanın son kontrolü kod değiştiyse yalnızca kendi eklediğini geri alır → çıkarılan üye eski kodla yarışarak geri giremez.

**Eski 6 karakterli kodlar** sahip yenileyene kadar çalışır (paylaşılmış davetler bozulmasın). Sahip kartında "eski kısa kod, yenilemeni öneririz" notu görür.

**Deneme sınırı (yalnızca katılma):** UID başına saatte 30 istek; yanlış kod UID başına 15 dk'da 5 / günde 20, IP başına saatte 30, sistem geneli saatte 500. Sınırda kod hiç sorgulanmaz (429 `invite_rate_limited`, `Retry-After`). Doğru kodla katılan hata sayacına girmez; biçimsiz giriş sorgulanmaz, sayılmaz. Redis hatasında katılma zaten yapılamadığı için kapalı (502). Takas: saldırı anında global tavan dolarsa o saat herkesin katılması durur.

**Gizlilik:** üye satırı yalnızca `{uid, name, isOwner, isAnonymous, joinedAt}`. E-posta hiçbir yanıtta yok (eskiden her üyenin e-postası tüm aileye dönüyordu) ve artık saklanmıyor; eski kayıtlardaki `email` alanları aile listesi ilk açıldığında üye listesinden silinir. Adı olmayan üye "İsimsiz üye" / "Misafir kullanıcı" görünür; kendi adı yoksa kartta "Ayarlar'dan ad ekle" notu çıkar. Görünen ad ve aile adı temizlenir (kontrol/yön karakterleri) ve 40 karakterle sınırlı (eskiden sınırsız). `uid` diğer üyelere görünmeye devam ediyor (çıkar/devret hedefi için; eskiden de dönüyordu).

**Plus kapanınca (mevcut ürün kararı korunarak):** kullanıcı ailelerinden çıkar, ama (1) sahipse sahiplik önce en eski üyeye geçer (eskiden aile sahipsiz kalıyordu: kimse silemiyor / yönetemiyordu), (2) ailede başka üye yoksa üyelik korunur (`keptFamilies`) — çıkılsaydı aile ve tarifleri kimsenin erişemeyeceği bir kayıt olarak kalırdı. Sıra: önce `isPlus=false`, sonra aileler (arada yeni katılım olmasın).

**Arayüz (`FamilyCard`, App.jsx):** kart başına: ad + "Sahip" rozeti, davet kodu (kopyala, "Kopyalandı", sahipte "Yenile"), üye listesi (ad, "(sen)", taç; sahipte her üyede "⋯" → "Sahip yap" / "Çıkar"), altta "Aileden Ayrıl" (sahip ise yeni sahip seçimi) ve "Aileyi Sil". Her riskli işlem satır içi onay ister, etkisini anlatır. Kart başına hata kutusu; ayrıca Plus'sızken de hatalar görünür (eskiden yalnızca "Yeni Aile" panelinde görünüyordu). Hata kodları `src/apiErrors.js` ile TR/EN.

**Eski web paketi uyumu:** `members[]` dizisi, `name`, `inviteCode`, `ownerUid` alanları korunuyor; yeni alanlar ek. Eski paket sahibe hâlâ yalnızca "Aileyi Sil", üyeye "Ayrıl" gösterir; ikisi de çalışır.

## Salt okunur denetim
`app/scripts/audit-group3-readonly.mjs` ek sayımlar: `orphanOwner`, `noMembers`, `legacyInviteCodes`, `storedMemberEmails` (yalnızca sayı/aile kimliği; e-posta yazdırmaz).

## Test
`test/group4Family.test.mjs` (28): kod biçimi/eski kod/yenileme yetkisi, yenileme↔silme yarışları (iki yön), deneme sınırları (UID, misafir+IP, sel), e-posta yokluğu ve temizliği, ad sınırı, çıkarma yetkisi ve yeniden katılma yarışları, devir yetkisi ve devir↔ayrılma yarışı (iki yön), sahip ayrılması, tek üye, eski sahipsiz kayıt onarımı, Plus kapanması (devir / tek üye korunur / katılma yarışı), hesap silme devri ve yarışı, meta yardımcı anahtarlarının silinmesi, denetim betiği.
Koruma kaldırma (mutasyon) denemesi: kod eşleşmesi, geri alma kod kontrolü, `ensureOwner`, atomik silme işareti, çıkarmada kod yenileme, tek üye koruması, deneme sınırı — her biri kaldırılınca en az bir test düşüyor. Devirden sonraki `ensureOwner` ve hesap silmedeki ön devir kaldırılınca test düşmüyor: ikinci bir koruma (özet onarımı / sonradan `ensureOwner`) aynı durumu kapatıyor.
`group3Family` Aile 16'nın araya girme noktası `SET` → `EVAL` güncellendi (meta artık atomik yazılıyor; testin amacı aynı).

## Bilinen sınırlar / açık
- Sahip ile son diğer üye TAM aynı anda ayrılırsa aile üyesiz kalabilir (veri durur, geçerli kodla ilk katılan sahip olur). Denetim `noMembers` ile görür.
- Davet kodunu sahip dışındaki üyeler de görüyor ve paylaşabiliyor (eskisi gibi).
- Davet kodunun süresi yok (ürün kararı bekliyor, bkz. rapor).
- `aiHardening` "maliyet sayacı" testleri dakika sınırına denk gelince ara sıra düşüyor (saat sabitlenmemiş; Grup 3 tabanında da görüldü; Grup 5 işi).
- Gerçek cihazda / Preview'da denenmedi. Arayüz yalnızca yerel tarayıcıda, taklit API ile 360 px'te görüldü.
