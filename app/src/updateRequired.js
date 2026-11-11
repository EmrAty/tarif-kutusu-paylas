// "Uygulama güncellenmeli" durumu (istemci sunucuyla uyumsuz).
//
// Sunucu bir yazımı 426 / code "client_outdated" ile reddederse (ör. sürüm
// bilgisi göndermeyen eski istemci), bu istemci artık güvenle veri yazamaz:
//   - o değişiklik başarısız sayılır (görünüm geri alınır, liste tazelenir),
//   - uygulama genelinde `required` olur ve sonraki tüm değişiklikler sunucuya
//     gitmeden reddedilir,
//   - kullanıcıya kapatılamayan "Yenile" penceresi gösterilir.
// Yenileme yalnızca kullanıcı dokununca yapılır (otomatik yenileme döngüsü yok).
// Mevcut "güncelleme var" bandı da aynı yenileme fonksiyonunu kullanır.

export const CLIENT_OUTDATED = "client_outdated";

export function isClientOutdatedResponse(status, body) {
  return status === 426 || (!!body && body.code === CLIENT_OUTDATED);
}

export function clientOutdatedError(message = "Uygulamanın yeni bir sürümü var. Lütfen uygulamayı yenile.") {
  const err = new Error(message);
  err.status = 426;
  err.code = CLIENT_OUTDATED;
  return err;
}

export function createUpdateGate() {
  let required = false;
  const listeners = new Set();
  return {
    isRequired: () => required,
    markRequired() {
      if (required) return;
      required = true;
      listeners.forEach((fn) => fn());
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

// Uygulama genelindeki tek kapı.
export const appUpdateGate = createUpdateGate();

const RELOAD_MARK_KEY = "tarif-kutusu:update-reload-from";

function defaultStorage() {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch (e) {
    return null;
  }
}

// Kullanıcının "Yenile"/"Güncelle" dokunuşu. Hangi paketten yenilendiği
// oturum deposuna yazılır; yenilemeden sonra aynı paket yine reddedilirse
// (önbellekten eski paket geldiyse) pencere bunu söyler ama KENDİLİĞİNDEN
// tekrar yenilemez. Web'de ve Capacitor WebView'ında (server.url canlı siteyi
// yüklüyor) aynı şekilde çalışır.
export function reloadForUpdate({ version, location = typeof window !== "undefined" ? window.location : null, storage = defaultStorage() } = {}) {
  try {
    if (storage && version) storage.setItem(RELOAD_MARK_KEY, String(version));
  } catch (e) {
    // depolama yoksa yalnızca "yenileme işe yaramadı" uyarısı çıkmaz
  }
  if (location) location.reload();
}

export function reloadDidNotHelp({ version, storage = defaultStorage() } = {}) {
  try {
    return !!storage && !!version && storage.getItem(RELOAD_MARK_KEY) === String(version);
  } catch (e) {
    return false;
  }
}
