// Aile durumunun (üyelik, aile reisi, yönetim yetkisi, davet kodu, Plus /
// kilit) canlı yenilenmesi. React'ten bağımsız saf JS: testler doğrudan
// çalıştırıyor (test/familySync.test.mjs).
//
// Neden: aile bilgisi eskiden yalnızca girişte ve kullanıcının KENDİ
// işleminden sonra çekiliyordu. Başka bir cihazdaki değişiklik (üye çıkarma,
// sahiplik devri, kod yenileme, Plus kapatma) uygulama kapatılıp açılana kadar
// görünmüyordu.
//
// Kurallar:
// 1. Sıra: her istek bir sıra numarası alır; yalnızca EN SON başlatılan
//    isteğin yanıtı uygulanır. Geç gelen eski yanıt yeni durumu geri almaz.
// 2. Kullanıcının kendi değişikliği (beginChange) yoldaki bütün istekleri
//    geçersiz kılar ve bitene kadar arka plan yenilemesi yapılmaz: işlemden
//    önceki hâli taşıyan bir yanıt, işlemin sonucunu bir an bile ezmez.
// 3. Hata ya da beklenmeyen yanıt hiçbir şeyi değiştirmez (boş liste sayılmaz);
//    son bilinen durum ekranda kalır, bir sonraki yenilemede tekrar denenir.
// 4. Arka plan yenilemesi: uygulama görünür değilken hiç istek atılmaz; aynı
//    anda tek arka plan isteği olur (üst üste binmez).
// 5. Hesap değişince (setAccount) zamanlayıcı durur, yoldaki yanıtlar atılır,
//    ad senkronu sıfırlanır.

// Aile ekranı açıkken daha sık, diğer ekranlarda daha seyrek. Yalnızca
// en az bir ailesi olan kullanıcıda (ya da Aileler ekranı açıkken) çalışır.
export const FAMILY_POLL_MS = 20_000;
export const FAMILY_POLL_OPEN_MS = 10_000;

// Sunucu yanıtını ekranın kullandığı üç listeye ayırır.
//   families   — tam erişim (membership yok ya da "verified"; eski sunucu uyumu)
//   locked     — Plus kapalı (Grup 4): yalnızca kart özeti
//   unverified — profilde var, üyelik doğrulanamadı / silme sürüyor
export function splitFamilies(data) {
  const all = Array.isArray(data?.families) ? data.families.filter((f) => f && typeof f.id === "string") : [];
  const usable = (f) => !f.membership || f.membership === "verified";
  const locked = (f) => f.membership === "locked";
  return {
    isPlus: !!data?.isPlus,
    families: all.filter(usable),
    locked: all.filter(locked),
    unverified: all.filter((f) => !usable(f) && !locked(f)),
  };
}

// İçerik aynıysa önceki referansı korumak için (gereksiz yeniden çizim ve
// kilitli kart özeti isteği olmasın).
export function sameData(a, b) {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch (e) {
    return false;
  }
}

/**
 * request(name) -> sunucu yanıtı ({ isPlus, families }); hata: throw.
 *   name boş değilse sunucu kullanıcının aile üye kaydındaki görünen adı
 *   günceller (yazım içerir) — bu yüzden yalnızca ad değişmişse gönderilir.
 * apply(split) -> splitFamilies sonucunu ekrana uygular.
 * isVisible() -> uygulama ön planda mı.
 * timers: { setInterval, clearInterval } (testlerde sahte).
 */
export function createFamilySync({ request, apply, isVisible = () => true, timers = globalThis } = {}) {
  let account = null;
  let seq = 0;
  let changes = 0;
  let backgroundInFlight = null;
  let syncedName = null;
  let timer = null;
  let timerMs = 0;

  function stopPolling() {
    if (timer != null) timers.clearInterval(timer);
    timer = null;
    timerMs = 0;
  }

  function setAccount(uid) {
    const next = uid || null;
    if (next === account) return;
    account = next;
    seq++;
    changes = 0;
    backgroundInFlight = null;
    syncedName = null;
    stopPolling();
  }

  function load({ background = false, name = "" } = {}) {
    if (!account) return Promise.resolve({ status: "skipped", reason: "no_account" });
    if (background) {
      if (changes > 0) return Promise.resolve({ status: "skipped", reason: "change_in_progress" });
      if (!isVisible()) return Promise.resolve({ status: "skipped", reason: "hidden" });
      if (backgroundInFlight) return backgroundInFlight;
    }
    const mySeq = ++seq;
    const myAccount = account;
    const sendName = typeof name === "string" && name && name !== syncedName ? name : "";
    const current = () => mySeq === seq && myAccount === account;
    const promise = (async () => {
      let data;
      try {
        data = await request(sendName);
      } catch (error) {
        return { status: current() ? "error" : "stale", error };
      }
      if (!current()) return { status: "stale" };
      if (!data || typeof data !== "object" || !Array.isArray(data.families)) return { status: "invalid" };
      if (sendName) syncedName = sendName;
      apply(splitFamilies(data));
      return { status: "applied" };
    })();
    if (background) {
      backgroundInFlight = promise;
      promise.finally(() => {
        if (backgroundInFlight === promise) backgroundInFlight = null;
      });
    }
    return promise;
  }

  // Kullanıcının kendi aile/Plus işlemi başlıyor. Dönen fonksiyon işlem
  // bitince (başarılı ya da hatalı) çağrılır; ardından açık bir load yapılır.
  function beginChange() {
    changes++;
    seq++;
    backgroundInFlight = null;
    const myAccount = account;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      if (myAccount === account && changes > 0) changes--;
    };
  }

  // intervalMs <= 0 ya da hesap yoksa yenileme durur. Aynı aralıkla tekrar
  // çağrılırsa zamanlayıcı sıfırlanmaz.
  function setPolling(intervalMs) {
    if (!account || !(intervalMs > 0)) {
      stopPolling();
      return;
    }
    if (timer != null && timerMs === intervalMs) return;
    stopPolling();
    timerMs = intervalMs;
    timer = timers.setInterval(() => {
      load({ background: true });
    }, intervalMs);
  }

  return {
    setAccount,
    load,
    beginChange,
    setPolling,
    stopPolling,
    get pollingMs() {
      return timerMs;
    },
  };
}
