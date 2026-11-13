// Veri kovası boyut ve biçim sınırları (Grup 5 denetimi B3).
//
// Sorun: /api/data her biçimde ve boyutta değeri 200 ile yazıyordu (misafir
// hesap 3 MB alışveriş listesi, 3 MB tek kiler öğesi, 2000 tariflik liste yazdı);
// her yazım önceki hâli yedeklediği için (versionedBucket.js) depolama katlanıyordu.
//
// Kural: sınırlar yalnızca BÜYÜTEN yazımı reddeder. Sınırın zaten üstündeki eski
// bir kova küçülten (ya da aynı boyutta kalan) yazımı her zaman yapabilir — kullanıcı
// kendi listesinde kilitli kalmaz. Biçim denetimi yalnızca yeni/değişen parçalara
// uygulanır; eski kayıtlardaki tuhaflık (ör. eski alışveriş listesi alanı) listenin
// başka yerindeki değişikliği engellemez.
//
// Gerçek biçimler (koddan): tarifler = nesne dizisi (recipeInput.js ayrıca denetler);
// kiler = metin dizisi (App.jsx PantryFinder, legacy.js); alışveriş listesi =
// { selected: [tarif id], checked: { <malzeme anahtarı>: bool }, servings: { <tarif id>: sayı } }.
// Sunucu tarafı yazıcılar (recipe-jobs, misafir taşıma) aynı sınırları kullanır.

export const BUCKET_LIMITS = {
  // Gerçekçi büyük tarif ~6–7 KB → 2 MB ≈ 300 büyük tarif; tipik tarif ~2 KB → ~1000.
  recipes: { maxBytes: 2_000_000, maxItems: 2000 },
  "shopping-list": { maxBytes: 200_000, maxEntries: 2000, maxKeyChars: 300, maxServings: 1000 },
  "pantry-items": { maxBytes: 100_000, maxItems: 500, maxItemChars: 200 },
};

export const BUCKET_TOO_LARGE_CODE = "bucket_too_large";
export const INVALID_BUCKET_VALUE_CODE = "invalid_bucket_value";

function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

export const tooLarge = () =>
  httpError(413, BUCKET_TOO_LARGE_CODE, "Bu liste çok büyüdü; daha fazla eklenemiyor. Yer açmak için bir şeyler silmen gerekiyor.");
const invalid = () => httpError(400, INVALID_BUCKET_VALUE_CODE, "Geçersiz veri.");

export const byteSize = (raw) => (raw == null ? 0 : Buffer.byteLength(raw, "utf8"));

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const sameJSON = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const validId = (id) => (typeof id === "string" && id.length > 0 && id.length <= 100) || (typeof id === "number" && Number.isFinite(id));

// Boyut/sayı: yalnızca büyüten yazım sınırı aşamaz.
export function checkBucketSize(bucket, nextRaw, previousRaw, nextCount = null, previousCount = null) {
  const limits = BUCKET_LIMITS[bucket];
  if (!limits) return;
  const nextBytes = byteSize(nextRaw);
  if (nextBytes > limits.maxBytes && nextBytes > byteSize(previousRaw)) throw tooLarge();
  if (limits.maxItems && nextCount != null && nextCount > limits.maxItems && nextCount > (previousCount ?? 0)) throw tooLarge();
}

function checkPantry(next, previous) {
  const limits = BUCKET_LIMITS["pantry-items"];
  const before = new Set((Array.isArray(previous) ? previous : []).map((x) => JSON.stringify(x)));
  for (const item of next) {
    if (before.has(JSON.stringify(item))) continue; // dokunulmamış eski öğe
    if (typeof item !== "string" || !item.trim() || [...item].length > limits.maxItemChars) throw invalid();
  }
}

function checkShoppingField(key, value) {
  const limits = BUCKET_LIMITS["shopping-list"];
  if (key === "selected") {
    if (!Array.isArray(value) || value.length > limits.maxEntries || !value.every(validId)) throw invalid();
    return;
  }
  if (key === "checked" || key === "servings") {
    if (!isPlainObject(value)) throw invalid();
    const entries = Object.entries(value);
    if (entries.length > limits.maxEntries) throw invalid();
    for (const [k, v] of entries) {
      if (!k || k.length > limits.maxKeyChars) throw invalid();
      if (key === "checked" && typeof v !== "boolean") throw invalid();
      if (key === "servings" && !(typeof v === "number" && Number.isFinite(v) && v > 0 && v <= limits.maxServings)) throw invalid();
    }
    return;
  }
  throw invalid(); // bilinmeyen alan
}

function checkShopping(next, previous) {
  const before = isPlainObject(previous) ? previous : {};
  for (const [key, value] of Object.entries(next)) {
    if (key in before && sameJSON(before[key], value)) continue; // değişmemiş (eski biçim dahil)
    checkShoppingField(key, value);
  }
}

// Biçim denetimi (tarifler hariç; onlar recipeInput.checkRecipeList ile).
// next: ayrıştırılmış yeni değer, previous: aynı anın kayıtlı değeri (ayrıştırılmış ya da null).
export function checkBucketShape(bucket, next, previous) {
  if (bucket === "pantry-items") checkPantry(next, previous);
  else if (bucket === "shopping-list") checkShopping(next, previous);
}

export function parseStored(raw) {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
