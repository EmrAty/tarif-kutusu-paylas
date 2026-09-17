import React from "react";
import ReactDOM from "react-dom/client";
import TarifKutusu from "./App.jsx";
import SharePanel from "./SharePanel.jsx";
import "./index.css";

// Android paylaşım paneli (native ShareActivity) sayfayı "?sharePanel=1" ile ve
// kendi JS köprüsüyle açıyor. İkisi birden yoksa normal uygulama çalışıyor —
// tarayıcıdaki ve ana ikondan açılan uygulamada hiçbir şey değişmiyor.
const isSharePanel =
  new URLSearchParams(window.location.search).get("sharePanel") === "1" &&
  typeof window.TarifKutusuShare !== "undefined";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>{isSharePanel ? <SharePanel /> : <TarifKutusu />}</React.StrictMode>
);
