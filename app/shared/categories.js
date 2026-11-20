// Tarif kategorileri (istemci + sunucu ortak).
//
// Beş sabit kategori her zaman var (shared/recipeExtraction.js CATEGORIES; depoda
// Türkçe değerle durur, yalnızca etiketi çevrilir). Kullanıcı bunlara kendi
// kategorilerini ekleyebilir:
//  - Kullanıcının kendi listesi profilinde (`user:<uid>:profile` → `categories`)
//    durur; başka hesaba hiç gösterilmez.
//  - Tarif kategorisini her zaman ad olarak taşır (`recipe.category`). Bu yüzden
//    aileye kaydedilen/kopyalanan tarif kategorisini yanında götürür; diğer
//    üyeler o tarifi o başlık altında görür ama ad onların listesine eklenmez.
//  - Ad, kullanıcının yazdığı gibi saklanır ve her dilde aynen gösterilir
//    (çevrilmez). Sabit kategorilerle (her iki dildeki etiketleriyle), "Diğer"
//    bölümüyle ve eski kategori adlarıyla çakışan adlar kabul edilmez.
import { CATEGORIES } from "./recipeExtraction.js";

export { CATEGORIES };

export const CATEGORY_NAME_MAX = 40;
export const MAX_CUSTOM_CATEGORIES = 30;

// Sabit kategorilerin İngilizce etiketleri (src/i18n.jsx CATEGORY_LABELS ile aynı)
// ve eski adlar (App.jsx LEGACY_CATEGORY_MAP okunurken yenisine çevirir — bu adlarla
// özel kategori açılsaydı kayıtları okunurken başka kategoriye taşınırdı).
const RESERVED = [
  ...CATEGORIES,
  "Breakfast",
  "Lunch & Dinner",
  "Sauces",
  "Snacks",
  "Desserts",
  "Öğle Yemeği",
  "Akşam Yemeği",
  "Atıştırmalık & Soslar",
  "Diğer",
  "Other",
  "Favoriler",
  "Favorites",
];

// Karşılaştırma anahtarı: büyük/küçük harf ve fazladan boşluk farkı aynı ad sayılır.
export function categoryKey(name) {
  return String(name || "")
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("tr");
}

const RESERVED_KEYS = new Set(RESERVED.map(categoryKey));

// Kontrol ve görünmez yön/biçim karakterleri (ad aynı görünüp farklı olmasın).
const INVISIBLE_RE = new RegExp("[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]", "g");

// Kullanıcının yazdığı adı saklanacak biçime getirir (kontrol karakterleri atılır,
// boşluklar sadeleşir). Harfler/büyük-küçük harf korunur.
export function cleanCategoryName(name) {
  if (typeof name !== "string") return "";
  return name
    .normalize("NFC")
    .replace(INVISIBLE_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const isFixedCategory = (name) => CATEGORIES.includes(name);

// Yeni özel kategori adı için hata kodu; geçerliyse null.
// existing: kullanıcının mevcut özel kategorileri.
export function validateNewCategory(name, existing = []) {
  const clean = cleanCategoryName(name);
  if (!clean) return "category_empty";
  if (clean.length > CATEGORY_NAME_MAX) return "category_too_long";
  const key = categoryKey(clean);
  if (RESERVED_KEYS.has(key)) return "category_reserved";
  if ((existing || []).some((c) => categoryKey(c) === key)) return "category_exists";
  if ((existing || []).length >= MAX_CUSTOM_CATEGORIES) return "category_limit";
  return null;
}

// Profildeki listeyi okurken: yalnızca geçerli, tekrarsız adlar (sıra korunur).
export function normalizeCustomCategories(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const clean = cleanCategoryName(raw);
    const key = categoryKey(clean);
    if (!clean || clean.length > CATEGORY_NAME_MAX || RESERVED_KEYS.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= MAX_CUSTOM_CATEGORIES) break;
  }
  return out;
}

// Bir tarife yazılabilecek kategori: sabitlerden biri ya da temiz bir özel ad.
// (Sunucu, paylaşım job'unda kategorinin kullanıcının listesinde olup olmadığına
// bakmaz: kategori yalnızca kullanıcının kendi tarifindeki bir etikettir.)
export function isAcceptableRecipeCategory(name) {
  if (isFixedCategory(name)) return true;
  if (typeof name !== "string") return false;
  const clean = cleanCategoryName(name);
  return !!clean && clean === name && clean.length <= CATEGORY_NAME_MAX && !RESERVED_KEYS.has(categoryKey(clean));
}

// Tarif listelerinde görünen bölüm sırası: sabitler, kullanıcının kendi
// kategorileri (oluşturma sırasıyla), sonra tariflerde geçen diğer adlar
// (ör. aile üyesinin kategorisi, misafirken açılmış kategori) alfabetik.
export function categorySections(customCategories, recipes) {
  const out = [...CATEGORIES];
  const keys = new Set(out.map(categoryKey));
  const push = (name) => {
    const key = categoryKey(name);
    if (!name || keys.has(key)) return;
    keys.add(key);
    out.push(name);
  };
  normalizeCustomCategories(customCategories).forEach(push);
  const extra = [];
  for (const r of Array.isArray(recipes) ? recipes : []) {
    const c = r && typeof r.category === "string" ? r.category : "";
    if (c && !keys.has(categoryKey(c)) && !extra.some((e) => categoryKey(e) === categoryKey(c))) extra.push(c);
  }
  extra.sort((a, b) => a.localeCompare(b, "tr"));
  extra.forEach(push);
  return out;
}

// Bir tarifin hangi bölümde göründüğü: aynı ad farklı büyük/küçük harfle yazılmışsa
// tek bölümde toplanır. Kategorisi olmayan tarif null (→ "Diğer").
export function sectionOf(recipe, sections) {
  const c = recipe && typeof recipe.category === "string" ? recipe.category : "";
  if (!c) return null;
  const key = categoryKey(c);
  return sections.find((s) => categoryKey(s) === key) || null;
}
