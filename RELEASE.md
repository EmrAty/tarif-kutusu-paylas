# Yayın ve bakım düzeni (Grup 5)

Tek kişinin sürdürebileceği kadar sade. Komutlar `app/` klasöründe çalışır.

## Komutlar

| Komut | Ne yapar | Ağ / veri |
|---|---|---|
| `npm run check` | lint + tüm testler + build (CI'ın yerel karşılığı) | Ağsız, gizli anahtar gerekmez |
| `npm test` | Tüm `*.test.mjs` dosyaları (`test/`, `src/`, `shared/`) — yeni dosya otomatik dahil | Ağsız, sahte Redis/Firebase/AI |
| `npm run lint` | Çökme türü hatalar: hook sırası, tanımsız değişken vb. | — |
| `npm run verify:deploy -- --url <adres> [--commit <sha>] [--bypass-file <dosya>]` | Yayındaki sürümü salt okunur kontrol eder | Yalnızca kimliksiz GET/401 istekleri; veri yazmaz, AI çağırmaz |
| `npm run release:check -- <sha> --bypass-file <dosya>` | Production öncesi kapı: origin'de mi, main'e fast-forward mı, CI yeşil mi, Preview bu commit'i mi yayınlıyor | Salt okunur; push etmez |

Preview erişim anahtarı (`PREVIEW_BYPASS`) yalnızca git dışı `app/android/local.properties` dosyasında durur (test APK worktree'si: `C:\Users\emrea\tk-clone-group3-apk\app\android\local.properties`). Betikler onu dosyadan okur, hiçbir çıktıya yazmaz. Ortam değişkeni olarak da verilebilir: `VERCEL_PROTECTION_BYPASS`.

## Akış

```
dal → push ─┬─ GitHub Actions: CI / check (lint + test + build)      [otomatik]
            └─ Vercel: Preview derlemesi (her dal)                    [otomatik]
preview.tarifkutusu.app → bu dala bağla (Vercel → Domains)            [elle]
npm run verify:deploy -- --url https://preview.tarifkutusu.app --commit <sha> --bypass-file …
Tarif TEST APK ile telefon testi (aşağıdaki liste)                    [elle]
(Gerekiyorsa) bağımsız denetim                                        [elle]
npm run release:check -- <sha> --bypass-file …                        [otomatik kapı]
git push origin <sha>:refs/heads/main      ← yalnızca fast-forward     [elle]
Vercel production derlemesi (main)                                    [otomatik]
npm run verify:deploy -- --url https://tarifkutusu.app --commit <sha>  [elle başlatılır]
```

Kurallar:
- **Production'a çıkan, Preview'da test edilen commit'in kendisidir.** GitHub'da "Merge" düğmesi yeni bir merge commit'i üretir (test edilmemiş SHA) — kullanılmaz. Yayın `git push origin <sha>:refs/heads/main` ile yapılır; git, fast-forward olmayan push'u zaten reddeder. `--force` asla.
- main geride kalmışsa (başka bir şey yayınlandıysa): dalı main üzerine güncelle, yeniden push et, CI + Preview + telefon testini o yeni commit'te tekrarla.
- Acil düzeltme de aynı yoldan: önce dalda push (CI yeşil olsun), Preview kontrolü kısaltılabilir (`--skip-preview` betiği kırmızı bırakır; bunu bilerek kabul etmek gerekir).

## Hangi koruma zorunlu, hangisi elle?

| Koruma | Durum |
|---|---|
| Her push'ta lint + test + build (GitHub Actions) | **Otomatik** — iş akışı dosyası repoda (`.github/workflows/ci.yml`); main'de olduğu andan itibaren her dalda çalışır |
| Vercel Preview derlemesi | **Otomatik** (Vercel Git entegrasyonu) |
| Testler gizli anahtarsız, ağsız | **Zorunlu** — tanımsız dış istek testi düşürür; CI'da hiçbir anahtar yok |
| CI kırmızıyken main'e girememe | **Henüz elle** — GitHub'da main kuralı (aşağıda öneri) açılınca zorunlu olur |
| Fast-forward / test edilen SHA | Git fast-forward olmayan push'u reddeder; "Merge düğmesi kullanma" kuralı elle |
| `release:check` kapısı | Elle çalıştırılır; geçmeden push etmemek elle disiplindir (kural açılınca CI kısmı zorunlu olur) |
| Telefon testi, bağımsız denetim | **Elle** |
| Yayın sonrası kontrol (`verify:deploy`) | Elle başlatılır (production'a otomatik istek atan bir iş yok) |

### Önerilen GitHub ayarı (uygulanmadı — production'a çıkış davranışını değiştirir)

GitHub → repo → Settings → Rules → Rulesets → New branch ruleset:
- Hedef: `main` (Default branch); Enforcement: Active
- ✔ Restrict deletions, ✔ Block force pushes
- ✔ Require status checks to pass → `check` (GitHub Actions); "Require branches to be up to date" kapalı kalabilir (fast-forward zaten günceldir)
- Pull request zorunluluğu **eklenmez** (yayın fast-forward push ile yapılıyor)

Etkisi: CI'ı yeşil olmayan bir commit main'e push edilemez → Vercel production'a da çıkamaz. CI iş akışı main'de bulunmadan (Grup 3+4+5 main'e girmeden) açılırsa bekleyen kontrol hiç gelmez ve main'e push engellenir; bu yüzden **Grup 5 main'e alındıktan hemen sonra** açılmalı. Bypass listesine kendini eklersen acil durumda kural aşılabilir (önerilmez).

## Telefon testi (Tarif TEST APK, Preview)

TEST APK `preview.tarifkutusu.app`'i canlı yükler; web/sunucu değişikliği için yeni APK gerekmez (uygulamayı kapatıp aç). En az:
1. Giriş (Google) ve misafir girişi açılıyor
2. Tarif listesi yükleniyor; ekle / düzenle / favori / sil; iki cihazda aynı anda değişiklik kaybolmuyor
3. TikTok / Instagram paylaşımı → panel → "Tarife Ekle" → "Tarifin hazır" bildirimi → dokununca tarif açılıyor
4. Aile: liste, "Canım çekti" bildirimi diğer cihaza geliyor; Plus kapat/aç (test düğmesi) → aile kilitlenip açılıyor
5. Değişikliğin kendi özel senaryoları

## Geri dönüş (rollback)

1. **Önce raporla, kör geri dönme.** Sunucu kodu Redis veri biçimini değiştirdiyse (ör. Grup 1 sürümlü kovalar, Grup 3 push kayıtları, Grup 4 aile meta) eski kod yeni veriyi yanlış yorumlayabilir. Her grubun notunda (`GROUPn_NOTES.md`) geri dönüş uyumu yazılı olmalı.
2. Uyumluysa en hızlısı: Vercel → Deployments → önceki Production derlemesi → **Instant Rollback** (yeniden derleme yok, saniyeler; Hobby planda yalnızca bir önceki production derlemesine). Sonra `verify:deploy` ile eski commit'in yayında olduğunu doğrula.
3. Kalıcı düzeltme: dalda `git revert` (ya da düzeltme) → normal akış. Instant Rollback sonrası Vercel otomatik production atamasını durdurur; yeni main derlemesini Vercel'de "Promote" ile yeniden açmak gerekir.
4. Native (APK) değişikliği geri alınamaz: Play'de yeni sürüm gerekir. Native değişiklik içeren yayınlar web/sunucu ile geriye uyumlu olmalı.

## Testler hakkında

- `test/helpers/async.mjs`: `waitFor(koşul)` ve `drainBackground()` — sabit `setTimeout` beklemesi yerine duruma göre bekleme. Yeni testte "X ms bekle" yazma; Vercel `waitUntil` işleri `drainBackground()` ile izlenir.
- `test/helpers/fakeServices.mjs`: bellek içi Redis (gerçek Lua), sahte Firebase token (`idToken`, `signedToken`), rota tabanlı sahte fetch; tanımsız dış istek testi düşürür.
- `test/authContract.test.mjs`: yeni bir `api/*.js` eklenince yetki tablosuna yazılmazsa test düşer.
- Kararsızlık şüphesinde: `for i in $(seq 1 20); do npm test >/dev/null || echo FAIL; done` (paralel çalıştırmak yükü artırır, zamanlama hatalarını daha iyi gösterir).
