# Grup 4 — aile yönetimi (üye çıkarma, sahiplik, davet kodu, gizlilik, Plus kilidi)

Branch `group-4-family`, Grup 3'ün son commit'i `d5e447f` üzerinden (Grup 3 henüz main'de değil; main `52e04fd`).
Commit'ler: `3fee9bd` (ilk tur), ardından ürün kararları turu (Plus kilidi, "aile reisi", süresiz kod).
Push / Preview / merge / deploy YOK. Production verisine dokunulmadı.

## Ürün kararları (kullanıcı, 12 Kasım 2026)
1. Plus kapanınca kullanıcı aileden ÇIKARILMAZ, sahiplik devredilmez; aile KİLİTLENİR. Plus açılınca her şey olduğu gibi geri gelir.
2. Aile sahibi üye çıkarabilir; Plus'ı kapalı sahip yönetemez.
3. Aileler ekranındaki üye listesinde mevcut sahibin adının yanında "(aile reisi)" / "(head of family)".
4. Davet kodu süresiz; sahibi yenileyene kadar geçerli.

## Plus kapalıyken aile kilidi

**Sunucu (asıl kural):**
- `assertFamilyAccess` (veri, çeviri, bildirim) üyelik doğrulandıktan sonra Plus da ister → 403 `family_locked`. `verifiedFamilyIds` (çeviri başlıkları) kilitli aileleri dışarıda bırakır. Paylaşım paneli job'u zaten `assertFamilyMember` ile Plus istiyordu (kabulde ve kayıttan önce). Eski veri aktarımı istemcide `/api/data` yazımı olduğu için aynı kilide takılır.
- `/api/data`: aile kovalarında (tarif, alışveriş listesi, kiler) okuma ve yazma kapalı. Tek istisna `GET ...&summary=1` (yalnızca `recipes`): kilitli kart için `{id, title, category, createdAt, addedBy, isFavorite}`. Malzeme, yapılış, besin, link, görsel istemciye hiç gitmez. Üye olmayan / çıkarılan kişi özeti de alamaz.
- `/api/notify`: Plus'sız gönderen 403 `family_locked`; alıcılardan Plus'ı kapalı olanlar çıkarılır (profil okunamazsa da gönderilmez). Yalnız Android kuralı aynen.
- `/api/families`:
  - GET: Plus'sız üyeye aile `membership: "locked"`, `locked: true`, `inviteCode: null`; üye listesi ve "aile reisi" bilgisi görünür. Ayrı bir değer olduğu için eski paketler bu aileyi "kullanılabilir" sanıp verisini istemez.
  - POST: Plus'sız kullanıcı yalnızca `leave` yapabilir (sahipse güvenli devir; tek üye sahip 409 `sole_member`, mesajda "silmek için Plus'ı açman gerekir"). `remove / transfer / rotateCode / delete` → 403 `family_locked`. Tek istisna: yarıda kalmış bir silmeyi (`deleting`) sahibin tamamlaması (aile zaten erişilemez; yalnızca temizlik).
- `/api/profile` Plus kapatma/açma: yalnızca `isPlus` bayrağı (atomik). Aile kayıtlarına dokunulmaz. (İlk turdaki "Plus kapanınca ayrıl / devret / tek üyede koru" mantığı kaldırıldı.)

**İstemci (App.jsx):**
- `lockedFamilies` ayrı tutulur; tam verileri yüklenmez, bellekteki eski kopyaları `dataStore.dropScope` ile atılır, yalnızca özet istenir.
- Kilitli aile tarifleri listede, kişisel sınır kilidiyle AYNI `LockedOverlay` (yeşil örtü + hardal kilit) ile görünür; `isRecipeLocked` ikisini birlikte kapsar → detay, pişirme modu, bildirimden / `?openRecipe=` ile açılış engelli, dokununca Plus modalı. Kilitli aile kartında yıldız ve çöp kutusu yok, uzun basma (bildirim) yok.
- Aynı tarif kişisel listede de varsa erişilebilir kopya kullanılır ve kilitli ailenin kapsamı ona eklenmez (değişiklik kilitli aileye yazılmaya çalışılmaz).
- Alışveriş listesi ve "Elimde Bunlar Var" kilitli kartları hiç almaz; kayıt yeri seçici ve liste sekmeleri zaten yalnızca Plus'ta aile gösteriyordu.
- Free sayaç "x/15" artık yalnızca kişisel tarifleri sayar (önceden Free kullanıcının ailesi olmadığı için tüm listeyi sayıyordu).
- Aileler ekranı: kilitli kartta "Kilitli" etiketi, açıklama + "Plus'ı İncele", üye listesi ve yalnızca "Aileden Ayrıl" (sahipse yeni sahip seçimi). Davet kodu, yönetim, eski veri aktarımı gizli.

**Plus yeniden açılınca:** aynı üyelik, sahiplik, davet kodu ve içerik; kilitli aileler `families` listesine geçer, veri normal yüklenir. Taşıma veya yeni davet yok.

## Aile yönetimi (ilk tur, korunuyor)

**İşlemler (`POST /api/families`)** — yalnızca Plus'lı aile sahibi, sunucu doğrular (profil + meta + üye listesi + `ownerUid` + Plus):
- `remove {familyId, memberUid}`: önce davet kodu yenilenir, sonra üye listesinden (erişim burada biter), sonra onun profilinden çıkarılır. Kendini çıkaramaz. Diğer üyelerin erişimi ve ortak veri etkilenmez.
- `transfer {familyId, memberUid}`: sahiplik başka bir üyeye geçer; eski sahip üye kalır.
- `rotateCode {familyId}`: yeni kod; eski kod hemen geçersiz.
- `leave {familyId, newOwnerUid?}`: sahip ayrılırken sahiplik seçilene (yoksa en eski katılana) geçer. Tek üye sahip ayrılamaz (409 `sole_member`).
- `create` / `join` Plus ister.

**Sahipsiz aile kalmaz (`_lib/families.js`):** `handOffOwnership` (sahip ayrılmadan önce devir), `ensureOwner` (üye listesini küçülten her işlemden sonra), `leaveFamily` (elle ayrılma). Hesap silme de bunları kullanır (Plus durumundan bağımsız). Aile listesi açılınca eski kayıtlarda sahibi üye olmayan aile kendiliğinden onarılır.

**Aile kaydı (meta) atomik:** `updateMeta` = Grup 1'in karşılaştır-ve-yaz motoru (`mutateBucket`). Eskiden düz `SET` idi: hesap silmedeki sahiplik devri `deleting` işaretini ezebiliyordu. Silmede `family:<id>:meta:version|backups|daily-backups` da siliniyor.

**Davet kodu (`_lib/inviteCodes.js`):** 10 karakter, 32 harfli alfabe, `crypto.randomInt` (≈1,1·10^15; eski: 6 karakter, `Math.random`). SÜRESİZ: hiçbir TTL yok, yalnızca sahip yenileyince geçersizleşir. Gösterim `ABCDE-FGHJK`; giriş tire/boşluk/küçük harf yok sayar. `SET NX` ile ayrılır. Katılma kodun meta'daki GÜNCEL kodla eşleşmesini ister; katılmanın son kontrolü kod değiştiyse yalnızca kendi eklediğini geri alır → çıkarılan üye eski kodla yarışarak geri giremez. Eski 6 karakterli kodlar sahip yenileyene kadar çalışır; sahipte "yenilemeni öneririz" notu.

**Deneme sınırı (yalnızca katılma):** UID başına saatte 30 istek; yanlış kod UID başına 15 dk'da 5 / günde 20, IP başına saatte 30, sistem geneli saatte 500. Sınırda kod hiç sorgulanmaz (429 `invite_rate_limited`, `Retry-After`). Doğru kodla katılan hata sayacına girmez.

**Gizlilik:** üye satırı yalnızca `{uid, name, isOwner, isAnonymous, joinedAt}`; e-posta hiçbir yanıtta yok, saklanmıyor, eski kayıtlardaki `email` alanları aile listesi açılınca silinir. Ad ve aile adı temizlenir, 40 karakterle sınırlı.

**"Aile reisi":** etiket sunucunun `isOwner` alanından (meta'daki GÜNCEL `ownerUid`) gelir; devirde yeni sahibe geçer, kurucuya sabit değildir. Görünüm: `Emre (aile reisi)`, kendi satırında ek olarak `· sen`. İlk turdaki kart başlığındaki "Sahip" rozeti ve satırdaki taç kaldırıldı (tekrar olmasın). EN: "(head of family)".

**Arayüz (`FamilyCard`):** davet kodu (kopyala / sahipte "Yenile"), üye listesi (sahipte her üyede "⋯" → "Sahip yap" / "Çıkar"), altta "Aileden Ayrıl" ve sahipte "Aileyi Sil". Riskli her işlem satır içi onay ister. Hata kodları `src/apiErrors.js` ile TR/EN.

## Salt okunur denetim
`app/scripts/audit-group3-readonly.mjs` ek sayımlar: `orphanOwner`, `noMembers`, `legacyInviteCodes`, `storedMemberEmails` (yalnızca sayı / aile kimliği).

## Test
`test/group4Family.test.mjs` (36). Kilit: üyelik/sahiplik/kod/içerik Plus kapat-aç boyunca korunur; kilitliyken üç kova da okuma/yazma 403 ve hiçbir şey yazılmaz; özet yalnızca kart alanları, üye olmayan ve çıkarılan alamaz; kilitli sahip çıkar/devret/kod/sil yapamaz, Plus açılınca yapar; kilitli üye ayrılır, sahipse devir çalışır, tek üye 409; yarım silmeyi tamamlama; bildirim gönderemez/almaz; paylaşım paneli job'u, çeviri, eski veri aktarımı, katılma kapalı; Plus kapatma ile ayrılma / devir yarışları; kilitli sahibin hesabı silinince devir; "aile reisi" devirde yeni sahibe geçer; istemci deposu `dropScope`. Ayrıca ilk turun testleri (kod, sınır, gizlilik, çıkarma, devir, ayrılma, hesap silme, denetim).
Koruma kaldırma denemesi: erişim kontrolündeki Plus, yönetimdeki Plus, silmedeki Plus, bildirim alıcı filtresi, özet alan kısıtı, kilitliyken kod gizleme — her biri kaldırılınca en az bir test düşüyor (ilk turun denemeleri de geçerli).
Eski kararı kodlayan iki Grup 3 testi yeni karara göre güncellendi: `group3Legacy` Legacy 8 (Plus'sız üye artık aile verisini okuyamaz) ve `group3Family` Aile 11 (Plus kapanınca üyelik korunur; yarışın amacı aynı).
`npm test` 310/310 (iki koşu), `vite build` temiz.

## Bilinen sınırlar / açık
- Plus'ı kapalı, ailede TEK üye olan sahip ne ayrılabilir ne silebilir (Plus'ı açınca ikisi de olur). Kural "Plus'sız yalnızca ayrılma" olduğu için böyle bırakıldı; aile ikinci aile hakkından yer kaplar ama Free kullanıcı zaten aile kuramaz/katılamaz.
- Kilitli üye, ad senkronu ile aile üye kaydındaki KENDİ görünen adını güncelleyebilir (ortak içerik değil).
- Kilitli aile tariflerinin başlıkları çevrilmez (çeviri ucu kilitli aileyi okumaz); asıl dilde görünür.
- Sahip ile son diğer üye TAM aynı anda ayrılırsa aile üyesiz kalabilir (veri durur, geçerli kodla ilk katılan sahip olur). Denetim `noMembers` ile görür.
- Davet kodunu Plus'lı tüm üyeler görüyor ve paylaşabiliyor (eskisi gibi).
- `aiHardening` "maliyet sayacı" testleri dakika sınırına denk gelince ara sıra düşüyor (saat sabitlenmemiş; Grup 3 tabanında da görüldü; Grup 5 işi).
- Gerçek cihazda / Preview'da denenmedi. Arayüz yalnızca yerel tarayıcıda, taklit API ile 360 px'te görüldü (Aileler kartı ve kenar çubuğundaki kilitli kart). Native değişiklik yok → yeni APK gerekmez.
