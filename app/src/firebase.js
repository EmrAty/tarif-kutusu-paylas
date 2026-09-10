import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getMessaging, isSupported, getToken } from "firebase/messaging";

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

// VAPID anahtarı ("Web Push sertifikaları"), apiKey gibi tarayıcıya gömülmesi
// normal olan public bir değer — Firebase Console > Project Settings > Cloud
// Messaging > Web Push certificates'ten üretilip buraya yapıştırılmalı.
// Boş bırakılırsa bildirim özelliği sessizce devre dışı kalır (çökmez).
const VAPID_KEY = "BP10K8TFmNgb6T7g2s20h-7J8zinVRIH0PHXWzgK76TMRapq-OtBLR2tthQxXITIRybf22Swz76qpeCVLf_Id9M";

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();

// Bildirim izni isteyip bir FCM (Firebase Cloud Messaging) cihaz token'ı alır.
// Tarayıcı push bildirimlerini desteklemiyorsa (ör. iOS Safari'de ana ekrana
// eklenmemiş sekme), VAPID anahtarı henüz girilmemişse ya da kullanıcı izni
// reddederse null döner — çağıran taraf bunu sessizce yok sayabilir.
export async function requestFcmToken() {
  try {
    if (!VAPID_KEY) return null;
    if (!(await isSupported())) return null;
    if (typeof Notification === "undefined") return null;
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return null;
    const registration = await navigator.serviceWorker.register("/firebase-messaging-sw.js");
    const messaging = getMessaging(app);
    return await getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: registration });
  } catch (e) {
    return null;
  }
}
