import { registerPlugin } from "@capacitor/core";

// Android tarafındaki NativeSplashPlugin ile eşleşen JS köprüsü: MainActivity'nin
// tam ekran açılış görselini uygulama hazır olunca kaldırır (web'de kullanılmıyor).
const NativeSplash = registerPlugin("NativeSplash");

export default NativeSplash;
