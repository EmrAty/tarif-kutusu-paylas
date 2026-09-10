// Uygulama arka plandayken (sekme kapalı/başka sekmedeyken) gelen push
// bildirimlerini gösteren service worker. Vite bunu işlemiyor (public/
// klasöründeki dosyalar aynen kopyalanıyor) — bu yüzden import yerine
// klasik importScripts (compat) kullanılıyor, ekstra build adımı gerekmiyor.
importScripts("https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyB9EptcLQLySYfZ87Ed59XFPYlK7ZpfqR0",
  authDomain: "tarif-kutusu.firebaseapp.com",
  projectId: "tarif-kutusu",
  storageBucket: "tarif-kutusu.firebasestorage.app",
  messagingSenderId: "821289337714",
  appId: "1:821289337714:web:f124f1e033a7126c6753eb",
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const { title, body } = payload.notification || {};
  self.registration.showNotification(title || "Tarif Kutusu", {
    body: body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
  });
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow("/"));
});
