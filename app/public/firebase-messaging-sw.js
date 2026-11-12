// Web (Chrome) push bildirimleri KAPALI (ürün kararı; bildirimler yalnızca
// Android uygulamasına gider). Bu dosya yalnızca eskiden kurulmuş web push
// kayıtlarını sökmek için duruyor: eski bir sekme bu adresi yeniden kaydederse
// ya da tarayıcı mevcut kaydı güncellerse, bu sürüm push aboneliğini iptal
// edip kendini kaldırır. Firebase SDK'sı yüklenmez, bildirim gösterilmez.
// Uygulamanın başka bir service worker'ı yok; çevrimdışı önbellek / güncelleme
// (/version.json bandı) bu dosyadan bağımsızdır.

async function retire() {
  try {
    const subscription = await self.registration.pushManager.getSubscription();
    if (subscription) await subscription.unsubscribe();
  } catch (e) {
    // yok say
  }
  try {
    await self.registration.unregister();
  } catch (e) {
    // yok say
  }
}

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(retire());
});

// Sunucu artık web'e push göndermiyor; yine de bir mesaj gelirse (eski
// abonelik) bildirim gösterilmez, abonelik sökülür.
self.addEventListener("push", (event) => {
  event.waitUntil(retire());
});

// Eskiden gösterilmiş bir bildirime tıklanırsa uygulama (varsa tarifiyle) açılır.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const recipeId = data.recipeId || (data.FCM_MSG && data.FCM_MSG.data && data.FCM_MSG.data.recipeId);
  const url = recipeId ? `/?openRecipe=${encodeURIComponent(recipeId)}` : "/";
  event.waitUntil(clients.openWindow(url));
});
