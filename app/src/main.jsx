import React from "react";
import ReactDOM from "react-dom/client";
import TarifKutusu from "./App.jsx";
import SharePanel from "./SharePanel.jsx";
import { LanguageProvider } from "./i18n.jsx";
import "./index.css";

// Android paylaşım paneli (native ShareActivity) sayfayı "?sharePanel=1" ile ve
// kendi JS köprüsüyle açıyor. İkisi birden yoksa normal uygulama çalışıyor —
// tarayıcıdaki ve ana ikondan açılan uygulamada hiçbir şey değişmiyor.
const isSharePanel =
  new URLSearchParams(window.location.search).get("sharePanel") === "1" &&
  typeof window.TarifKutusuShare !== "undefined";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <LanguageProvider>{isSharePanel ? <SharePanel /> : <TarifKutusu />}</LanguageProvider>
  </React.StrictMode>
);

// Çevrimdışı açılış (bkz. src/sw/swLogic.js): yalnızca üretim derlemesinde ve
// ana uygulamada kaydedilir. Kayıt başarısızsa uygulama aynen çalışır (yalnızca
// internetsiz açılamaz). Paylaşım paneli kaydetmez; SW de panele karışmaz.
if (!isSharePanel && import.meta.env.PROD && typeof navigator !== "undefined" && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
  });
}
