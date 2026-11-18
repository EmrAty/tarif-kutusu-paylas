# Kayıt hedefleri: ad değiştirme, çoklu hedef, aileye taşı/kopyala (18 Kasım 2026)

Dal: `feature/rename-multi-target-move` (temel: production `9d97c8f`). Main'e alınmadı, yayınlanmadı.

## Model (bağımsız kopyalar)
Her listedeki kayıt **ayrı** bir tariftir. Kişisel kayıt asıl kimliği (`id`) taşır; her aile kopyası asıl kimlikten türetilen kendi kimliğini alır: `<id>-fam-<aileId>` (`shared/recipeIds.js`, istemci ve sunucu ortak). Sonuç:
- Ailede düzenleme/silme kişisel tarifi etkilemez, kişiseldeki işlemler aile kopyasını etkilemez; kart listesinde her kopya ayrı kart olarak görünür.
- Kimlik türetildiği (rastgele olmadığı) için "Tekrar dene" ve ikinci kopyalama aynı kimliği üretir → hedefte zaten varsa liste değişmez (kopya çoğalmaz). AI'a yeniden gidilmez.
- "Kopyala" = içerik aile kopyası kimliğiyle aileye eklenir. "Taşı" = önce aileye yaz, seçilen **her** aileye yazıldıysa kişisel kaydı kaldır.
- Kayıttan sonra açılan / bildirimdeki tarif: kişisele yazıldıysa kişisel kayıt, değilse ilk aile kopyası.
- Eski kayıtlar: bu daldan önce (Grup 5 çoklu hedef) aynı kimlikle birden çok listeye yazılmış tarifler bağlı kalır (tek kart, düzenleme her kopyaya). Bunlar taşınmadı/ayrıştırılmadı.

## Akışlar
| Yer | Ad değiştirme | Çoklu hedef | Kısmi hata |
|---|---|---|---|
| Yeni Tarif Çıkar (`/api/extract`) | AI sonrası "Tarif hazır" adımı (`ExtractReview`); ad bütün hedeflere yazılır | Mevcut `SaveTargetPicker` (inceleme adımında da) | `SaveResultBanner`: kaydedilen/kaydedilemeyen yerler + "Tekrar dene" (AI yok) |
| Elle oluştur (`RecipeEditor`) | Zaten ad alanı var | Mevcut seçici | Aynı bant |
| Android paylaşım paneli (`/api/recipe-jobs`) | İsteğe bağlı "Tarif adı" alanı (boşsa AI'ın başlığı) | Onay kutuları (kişisel + aileler, en az biri) | Job hedef hedef sonuç yazar; eksik varsa tarif job kaydında saklanır, uygulama açılınca bant + "Tekrar dene" (`action: "retry"`, AI yok) |
| Tarif detayı | — | — | "Aileye taşı veya kopyala" paneli; kısmi hatada kişisel tarif korunur |

Not: "Elimde Bunlar Var" önerisini kaydetme yalnızca kişisel listeye (değişmedi).

## Sunucu (`api/recipe-jobs.js`)
- `targets: [{scope:"personal"} | {scope:"family", familyId}]` (en çok 3; yoksa eski `target`/`familyId`). Kabulde her aile `assertFamilyMember`, kişisel seçiliyse Free sınırı (AI'dan önce). Yazımdan hemen önce her hedef yeniden denetlenir; başarısız aile kişisele düşmez.
- `title` (isteğe bağlı, ≤120, kontrol karakterleri temizlenir) AI başlığının yerine geçer.
- Job kaydı: `targets[].status` (`saved`/`failed`, `error`, `code`). Eksik hedef varsa `recipe` saklanır ve `user:<uid>:job-attention` (hash, 7 gün) listesine girer. Hiçbir yere yazılamazsa job `failed`, `errorCode` (ör. `free_recipe_limit`), bildirim "hazırlandı ama kaydedilemedi" ve **linksiz** (dokununca Yeni Tarif Çıkar açılıp ikinci AI çağrısı yapılmasın).
- `GET ?attention=1` liste; `POST {action:"retry", jobId}` yalnızca başarısız hedeflere yazar (aynı denetimler + veri yazım hız sınırı); `POST {action:"dismiss", jobId}` listeden çıkarır, saklanan tarifi atar.
- Bildirim: kısmi kayıtta gövdeye "Bazı yerlere kaydedilemedi…" eklenir; `familyIds` (virgüllü) çoklu aile tazelemesi için.

## Testler
`test/multiTargetJobs.test.mjs` (10), `test/recipeTransferServer.test.mjs` (5, gerçek `/api/data`), `src/recipeTransfer.test.mjs` (7). `npm run check` yeşil.

## Telefonda denenecekler (Preview)
1. Yeni Tarif Çıkar → "Tarif hazır" → adı değiştir, Kişisel + aile seç → Kaydet → iki ayrı kart (Kişisel ve Ev), ikisinde de yeni ad; birini düzenle/sil → diğeri değişmez.
2. Aynı adımda "Geri dön" → Tarifi Çıkar'a tekrar bas → AI beklemesi olmadan inceleme ekranı gelmeli.
3. TikTok → Paylaş → panelde ad yaz + iki yer seç → bildirimdeki ad ve iki listedeki ad aynı.
4. Kısmi hata: ikinci telefonda aileden çıkar/Plus kapat, sonra ilk telefonda o aileye + kişisele paylaş → bildirim "Bazı yerlere kaydedilemedi", uygulamada bant ("Kaydedildi: Kişisel / Kaydedilemedi: Ev") → erişimi geri ver → "Tekrar dene" → ailede tek kopya.
5. Tarif detayı → "Aileye taşı veya kopyala" → Kopyala → ailede ayrı kart; aile kopyasında adı değiştir → kişisel aynı kalır; tekrar Kopyala seçeneği o aile için görünmez; başka tarifte Taşı → kişisel listeden kalkar, ailede kalır; porsiyon, "≈" tahmini miktarlar, bölümler aynı.
6. Free hesap (Plus kapalı): taşı düğmesi görünmez; panelde aile seçeneği yok.
