// Türkçe iyelik eki ("Ahmet'in", "Ayşe'nin", "Mustafa'nın" gibi) — büyük ünlü
// uyumuna göre doğru ünlüyü (ı/i/u/ü) seçip, isim ünlüyle bitiyorsa araya
// kaynaştırma "n"si ekliyor. Özel isimlerde ünsüz yumuşaması (Mehmet->Mehmed)
// yazıya yansıtılmadığı için burada da uygulanmıyor.
const VOWEL_HARMONY = {
  a: "ı", ı: "ı", o: "u", u: "u",
  e: "i", i: "i", ö: "ü", ü: "ü",
};
const VOWELS = new Set(Object.keys(VOWEL_HARMONY));

function trLower(str) {
  return str.replace(/İ/g, "i").replace(/I/g, "ı").toLowerCase();
}

export function turkishPossessive(rawName) {
  const name = (rawName || "").trim();
  if (!name) return "Birinin";
  const lower = trLower(name);
  let harmonizedVowel = "i";
  for (let i = lower.length - 1; i >= 0; i--) {
    if (VOWELS.has(lower[i])) {
      harmonizedVowel = VOWEL_HARMONY[lower[i]];
      break;
    }
  }
  const endsInVowel = VOWELS.has(lower[lower.length - 1]);
  const suffix = (endsInVowel ? "n" : "") + harmonizedVowel + "n";
  return `${name}'${suffix}`;
}

export function craveNotificationBody(senderName, recipeTitle) {
  return `${turkishPossessive(senderName)} canı ${recipeTitle} yemek istiyor.`;
}
