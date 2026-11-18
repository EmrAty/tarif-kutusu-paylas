// Paylaşım job'unun push bildirimi metinleri (yalnızca title/body). Job kaydındaki
// error/errorCode ve HTTP yanıtları dilden bağımsız kalır. Free sınırı hatasında gövde
// (eskisi gibi) varsayılan başarısızlık metnidir. Bilinmeyen dil -> Türkçe.
import { DEFAULT_CONTENT_LANG } from "../../shared/recipeLocales.js";

export const NOTIFY_TEXT = {
  tr: {
    readyTitle: "Tarifin hazır 🍝",
    readyBody: (title) => (title ? `${title} tarifin hazır.` : "Tarifin hazır."),
    partialSuffix: "Bazı yerlere kaydedilemedi; uygulamada tekrar deneyebilirsin.",
    saveFailed: "Tarif hazırlandı ama kaydedilemedi. Uygulamada tekrar deneyebilirsin.",
    failedTitle: "Tarif oluşturulamadı",
    failedDefault: "Paylaştığın videodan tarif çıkarılamadı. Dokun, uygulamada tekrar deneyelim.",
    insufficient: "Bu videodan yeterli tarif bilgisi çıkaramadık.",
    serviceUnavailable: "Tarif servisi şu anda çalışmıyor; sorun videoda değil. Biraz sonra tekrar dene.",
  },
  en: {
    readyTitle: "Your recipe is ready 🍝",
    readyBody: (title) => (title ? `${title} is ready.` : "Your recipe is ready."),
    partialSuffix: "It couldn't be saved everywhere; you can retry in the app.",
    saveFailed: "The recipe was prepared but couldn't be saved. You can retry in the app.",
    failedTitle: "Couldn't create the recipe",
    failedDefault: "We couldn't extract a recipe from the video you shared. Tap to try again in the app.",
    insufficient: "We couldn't get enough recipe details from this video.",
    serviceUnavailable: "The recipe service isn't working right now; it's not the video. Please try again in a bit.",
  },
};

export function notifyText(language) {
  return NOTIFY_TEXT[language] || NOTIFY_TEXT[DEFAULT_CONTENT_LANG];
}

// Hata türüne göre başarısızlık bildirim gövdesi. kind: "insufficient" | "service" | undefined.
export function failedBody(language, kind) {
  const t = notifyText(language);
  if (kind === "insufficient") return t.insufficient;
  if (kind === "service") return t.serviceUnavailable;
  if (kind === "save") return t.saveFailed;
  return t.failedDefault;
}
