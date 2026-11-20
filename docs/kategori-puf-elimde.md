# Menü sırası, özel kategoriler, püf noktaları, "Elimde Bunlar Var" (20 Kasım 2026)

Dal: `feature/categories-tips-pantry` (temel: `feature/rename-multi-target-move` `e74ea4c`; ad değiştirme, çoklu kayıt ve aileye taşı/kopyala bu dalda aynen duruyor). Main'e alınmadı, yayınlanmadı, Preview bağlantısı değiştirilmedi (`preview.tarifkutusu.app` hâlâ `feature/rename-multi-target-move`).

Yalnızca web/JS + API değişikliği → **yeni APK gerekmez** (native dosyaya dokunulmadı).

## Menü
"Tarifi Kendin Oluştur" en üstte, sarı (ana düğme); "Yeni Tarif Çıkar" onun eski yerinde, beyaz. Altında Alışveriş Listesi, Elimde Bunlar Var, **Yeni Kategori Oluştur** (aynı düğme dili, kesikli çerçeve).

## Özel kategoriler (`shared/categories.js`)
- 5 sabit kategori aynen kalır (depoda Türkçe değer, yalnızca etiket çevrilir).
- Kullanıcının kendi listesi **profilinde**: `user:<uid>:profile` → `categories` (en çok 30, ad ≤ 40 karakter). `POST /api/profile {action:"addCategory"|"removeCategory", name}`; profil CAS'ıyla atomik, tekrar istek değişiklik yapmaz. Başka hesaba hiç gösterilmez; hesap silmede profil zaten silinir; misafir→hesap taşımada misafirin kategorileri hedefin listesine eklenir (birleşim, aile adımında).
- Ad yazıldığı gibi saklanır, TR/EN arayüzde aynen gösterilir. Reddedilenler: sabitler (TR ve EN etiketleriyle), "Diğer/Other", "Favoriler/Favorites", eski adlar (`Öğle Yemeği`, `Akşam Yemeği`, `Atıştırmalık & Soslar` — okunurken başka kategoriye çevrildikleri için), büyük/küçük harf farkıyla aynı ad.
- Tarif kategorisini **ad olarak** taşır (`recipe.category`). Seçim yerleri (Yeni Tarif Çıkar, elle oluştur, düzenle, kategorisiz tarif uyarısı, AI önerisini kaydet, Android paylaşım paneli) = sabitler + benim kategorilerim + kişisel tariflerimde geçen adlar. Çiplerin sonunda "+ Yeni" aynı pencereyi açar ve oluşturulanı seçer (paylaşım panelinde oluşturma yok, sade kalsın).
- **Aile ilişkisi:** aile listesinin ayrı kategori listesi yok. Aileye kaydedilen/kopyalanan/taşınan tarif kategorisini yanında götürür; diğer üyeler o tarifi o başlık altında görür, ama ad onların seçim listesine eklenmez. Bölüm sırası: sabitler → benim kategorilerim → tariflerde geçen diğer adlar (alfabetik).
- Kaldırma yalnızca **boş** kategoride (pencerede çöp kutusu). Tarifler hiçbir zaman kategorisiz kalmaz.
- Paylaşım job'u artık sabit ya da temiz özel adı kabul eder (`isAcceptableRecipeCategory`).

## Püf noktaları (`recipe.tips`, `shared/recipeTips.js`)
- Mevcut tek çıkarma çağrısının JSON şemasına `tips: string[]` eklendi (ek AI çağrısı yok). Prompt: yalnızca kaynakta açıkça geçen ipuçları; kendi önerisi yok, modelin notları `assumptions`'ta kalır (ayrı bej not). Temizlik: kırp, boşları/tekrarları at, ≤12 öğe, ≤400 karakter; boşsa alan kayda yazılmaz.
- Tarif detayında Yapılış'ın altında "Püf Noktaları" bölümü (açık gelir); içerik yoksa görünmez. Elle oluşturma ve düzenlemede ayrı kart (ekle/sil).
- Taşı/kopyala tarif nesnesinin tamamını kopyalar (alan korunur; `test/recipeTransferServer.test.mjs` fixture'ında var). Paylaşım job'u `...parsed` ile yazar.
- Çeviri: püf noktası olan tarifte `tips` çeviri isteğine ve şemaya eklenir (aynı sayı/sıra, rakam değişen öğe asıl metinle kalır). Püf noktası olmayan tarifin çeviri isteği, önbellek anahtarı ve içerik parmak izi **değişmez**. Eski tarifler doldurulmaz.

## "Elimde Bunlar Var" (`src/pantryMatch.js`)
- Malzeme girişi aynı. Sonuç sırası: **Kayıtlı Tariflerinden** (cihazda eşleşme, AI yok) → altında mevcut AI önerileri kartı.
- Erişilebilen bütün tarifler aranır (kişisel + Plus ile açık aileler; aile tarifi kartında aile adı). Kilitli tarifler (Free sınırı, kilitli aile özeti) ve artık erişilemeyen ailelerin tarifleri hiç aranmaz: adı ya da eksik malzemesi gösterilmez.
- Eşleşme: Türkçe harf sadeleştirme (ğ/ı/ş…), çoğul/iyelik ekleri ("soğanlar", "tereyağ"), bitişik/ayrı yazım ("zeytin yağı"), hazırlık sözcükleri ("ince doğranmış"), alternatifler ("ya da", "/"). Başka ürün sayılmaz: "domates" ≠ "domates salçası", "biber" ≠ "biberiye", "su" ≠ "sucuk". Gösterim çevirisi varsa İngilizce adla da eşleşir.
- Eksikler her kartta "Eksik: …" olarak listelenir; "Hepsi elinde" yalnızca hiç eksik yoksa. Tek varsayım: musluk suyu ("su", "ılık su") sayıma girmez.
- Uygun tarif yoksa kısa mesaj; AI kartı yine görünür.

## Testler
`shared/categories.test.mjs` (5), `src/pantryMatch.test.mjs` (6), `test/categoriesTips.test.mjs` (8). `test/integration.test.mjs` 3d: geçersiz kategori örneği "Yok" → "Breakfast" (artık "Yok" geçerli bir özel ad). `npm run check` yeşil (555 test).
Mobil görünüm 390 px'te yerel sahte veriyle (Firebase/API taklidi, gerçek servise gidilmeden) kontrol edildi: menü, kategori penceresi (hata ve ekleme), bölümler, Elimde Bunlar Var sonuçları, detay ve düzenleyicide püf noktaları.

## Telefonda denenecekler (Preview bu dala bağlandıktan sonra)
1. Menü: "Tarifi Kendin Oluştur" en üstte sarı, "Yeni Tarif Çıkar" altında beyaz; ikisi de doğru ekranı açıyor.
2. "Yeni Kategori Oluştur" → "Kahvaltı" ya da "Breakfast" reddedilir; "Çorbalar" eklenir, listede boş bölüm olarak görünür; boşken silinebilir.
3. Elle oluştur / Yeni Tarif Çıkar / paylaşım panelinde "Çorbalar" seçilebilir; çipteki "+ Yeni" ile oluşturulan kategori seçili gelir. Uygulamayı kapat-aç → kategori duruyor (ikinci cihazda da).
4. Özel kategorili tarifi aileye kopyala → ikinci telefonda (aile üyesi) tarif "Çorbalar" başlığı altında; o üyenin kendi seçim listesinde "Çorbalar" yok.
5. Kaynakta ipucu geçen bir video paylaş/çıkar → detayda "Püf Noktaları" (yalnızca kaynaktakiler); ipucu olmayan videoda bölüm yok. Düzenle'de ekle/sil, kaydet.
6. Püf noktalı tarifi aileye kopyala/taşı → ailede de var; dili İngilizce yap → püf noktaları çevrilmiş (kayıt Türkçe kalır).
7. Elimde Bunlar Var: "yumurta, domates, tereyağ" → önce kayıtlı tarifler (eksikler yazılı), altında "Fikir İste". Eşleşme yoksa kısa mesaj + AI kartı. Free hesapta kilitli tarifler listede yok.

Önceki dalın telefon testleri (`docs/kayit-hedefleri.md`, 6 senaryo) hâlâ bekliyor; bu dal onları da içerir.
