import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";

// Bu değerler Firebase konsolundaki proje ayarlarından ("Web app" config) geliyor.
// Gizli değildir — Firebase web config'i tarayıcıda görünmesi normal olan public bir
// tanımlayıcı kümesidir, güvenlik gerçek erişim kurallarıyla (Firebase Console'da
// Authentication > Settings) sağlanır. Kendi proje değerlerinle değiştir.
const firebaseConfig = {
  apiKey: "AIzaSyB9EptcLQLySYfZ87Ed59XFPYlK7ZpfqR0",
  authDomain: "tarif-kutusu.firebaseapp.com",
  projectId: "tarif-kutusu",
  storageBucket: "tarif-kutusu.firebasestorage.app",
  messagingSenderId: "821289337714",
  appId: "1:821289337714:web:f124f1e033a7126c6753eb",
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();

// ÜRÜN KARARI: web (Chrome) push bildirimleri kapalı; bildirimler yalnızca
// Android uygulamasına gider (bkz. api/_lib/fcm.js). Web istemcisi artık
// bildirim izni istemez ve token kaydetmez.
//
// Eskiden kurulmuş web push'u bu tarayıcıda söker: YALNIZCA
// /firebase-messaging-sw.js kaydının push aboneliğini iptal eder ve o kaydı
// kaldırır. Başka service worker'lara dokunmaz. Bildirim izni sayfadan geri
// alınamaz (tarayıcı ayarı); abonelik olmadığı için bir anlamı kalmaz.
// Hiçbir zaman hata fırlatmaz; bir kayıt söküldüyse true döner.
export async function retireWebPush() {
  try {
    if (typeof navigator === "undefined" || !navigator.serviceWorker?.getRegistrations) return false;
    const registrations = await navigator.serviceWorker.getRegistrations();
    let retired = false;
    for (const registration of registrations) {
      const worker = registration.active || registration.waiting || registration.installing;
      const script = String(worker?.scriptURL || "").split(/[?#]/)[0];
      if (!script.endsWith("/firebase-messaging-sw.js")) continue;
      try {
        const subscription = await registration.pushManager?.getSubscription();
        if (subscription) await subscription.unsubscribe();
      } catch (e) {
        // abonelik okunamadı/iptal edilemedi: kayıt yine de kaldırılır
      }
      if (await registration.unregister().catch(() => false)) retired = true;
    }
    return retired;
  } catch (e) {
    return false;
  }
}
