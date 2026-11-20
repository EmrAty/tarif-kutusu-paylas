// Tarif kategorileri (istemci + sunucu ortak).
//
// Beş sabit kategori her zaman var (shared/recipeExtraction.js CATEGORIES; depoda
// Türkçe değerle durur, yalnızca etiketi çevrilir). Kullanıcı kendi kategorilerini
// ekleyebilir:
//  - Kullanıcının listesi profilinde: `user:<uid>:profile` → categories:
//    [{ id, name, lang }]. Kimlik (id) kalıcıdır; ad yazıldığı gibi saklanır,
//    lang = oluşturulduğu sıradaki uygulama dili (çeviri buna göre yapılır).
//  - Tarif kategorisini ad olarak taşır (`category`, eski istemciler/yayın için),
//    özel kategoride yanında `categoryRef: { id, uid, by, lang }` (kimlik, sahibin
//    uid'i, sahibin o anki adı, ad dili). Kategoriyi ad değil, (uid, id) belirler:
//    aynı adlı iki kişinin kategorisi ayrı kalır; dil değişince hiçbir şey yazılmaz.
//  - Aile: ayrı bir aile kategori listesi yok. Bir üyenin aile tariflerinde
//    kullandığı kategori, o tariflerin categoryRef'inden türetilir ve o aileye
//    kaydederken diğer üyelere de seçenek olur ("Çorbalar (Emre)"). Üyenin aileye
//    hiç kaydetmediği kategorileri yalnız kendi profilinde durur, başka hesaba
//    açılmaz. Sahip aileden ayrılsa da aile tariflerindeki kategori (ve seçeneği)
//    kalır; adı ailede yoksa kayıttaki `by` gösterilir.
// d2254df (yalnız Preview) sürümünde profil kategorileri düz metindi, tariflerde
// categoryRef yoktu: metin girdiler addan türetilen sabit kimlik alır ve
// categoryRef'siz tarif, kullanıcının aynı adlı kategorisine bağlanır.
import { CATEGORIES } from "./recipeExtraction.js";

export { CATEGORIES };

export const CATEGORY_NAME_MAX = 40;
export const MAX_CUSTOM_CATEGORIES = 30;
const CATEGORY_LANGS = ["tr", "en"];
const ID_RE = /^[a-z0-9]{4,24}$/;

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
const INVISIBLE_RE = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069\\ufeff]", "g");

// Kullanıcının yazdığı adı saklanacak biçime getirir (kontrol karakterleri atılır,
// boşluklar sadeleşir). Harfler/büyük-küçük harf korunur.
export function cleanCategoryName(name) {
  if (typeof name !== "string") return "";
  return name.normalize("NFC").replace(INVISIBLE_RE, " ").replace(/\s+/g, " ").trim();
}

export const isFixedCategory = (name) => CATEGORIES.includes(name);
const cleanLang = (lang) => (CATEGORY_LANGS.includes(lang) ? lang : "tr");

// Eski (metin) kategoriler için addan türeyen sabit kimlik.
export function legacyCategoryId(name) {
  let h = 2166136261;
  const s = categoryKey(name);
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return `l${(h >>> 0).toString(36).padStart(7, "0")}`;
}

// Profildeki listeyi okurken: yalnızca geçerli, tekrarsız kategoriler (sıra korunur).
export function normalizeCustomCategories(list) {
  const out = [];
  const seenKeys = new Set();
  const seenIds = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const obj = typeof raw === "string" ? { name: raw } : raw && typeof raw === "object" ? raw : null;
    if (!obj) continue;
    const name = cleanCategoryName(obj.name);
    const key = categoryKey(name);
    if (!name || name.length > CATEGORY_NAME_MAX || RESERVED_KEYS.has(key) || seenKeys.has(key)) continue;
    const id = typeof obj.id === "string" && ID_RE.test(obj.id) ? obj.id : legacyCategoryId(name);
    if (seenIds.has(id)) continue;
    seenKeys.add(key);
    seenIds.add(id);
    out.push({ id, name, lang: cleanLang(obj.lang) });
    if (out.length >= MAX_CUSTOM_CATEGORIES) break;
  }
  return out;
}

const namesOf = (existing) => (existing || []).map((c) => (typeof c === "string" ? c : c && c.name));

// Yeni özel kategori adı için hata kodu; geçerliyse null.
export function validateNewCategory(name, existing = []) {
  const clean = cleanCategoryName(name);
  if (!clean) return "category_empty";
  if (clean.length > CATEGORY_NAME_MAX) return "category_too_long";
  const key = categoryKey(clean);
  if (RESERVED_KEYS.has(key)) return "category_reserved";
  if (namesOf(existing).some((c) => categoryKey(c) === key)) return "category_exists";
  if ((existing || []).length >= MAX_CUSTOM_CATEGORIES) return "category_limit";
  return null;
}

// Bir tarife yazılabilecek kategori adı: sabitlerden biri ya da temiz bir özel ad.
export function isAcceptableRecipeCategory(name) {
  if (isFixedCategory(name)) return true;
  if (typeof name !== "string") return false;
  const clean = cleanCategoryName(name);
  return !!clean && clean === name && clean.length <= CATEGORY_NAME_MAX && !RESERVED_KEYS.has(categoryKey(clean));
}

// Tarifteki categoryRef'in güvenli hâli (biçimsizse null). Sunucu ve istemci aynı kuralı kullanır.
export function cleanCategoryRef(ref) {
  if (!ref || typeof ref !== "object") return null;
  const id = typeof ref.id === "string" && ID_RE.test(ref.id) ? ref.id : null;
  const uid = typeof ref.uid === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(ref.uid) ? ref.uid : null;
  if (!id || !uid) return null;
  return { id, uid, by: cleanCategoryName(typeof ref.by === "string" ? ref.by : "").slice(0, 40), lang: cleanLang(ref.lang) };
}

// --- Tanımlayıcılar ------------------------------------------------------------------
// Bir kategori, listelerde ve seçicilerde şu biçimde dolaşır:
//   { key, name, fixed, ref, lang, mine }
// key: sabit "f:<ad>", özel "u:<uid>:<id>", kimliksiz eski ad "n:<anahtar>".

const fixedDesc = (name) => ({ key: `f:${name}`, name, fixed: true, ref: null, lang: "tr", mine: false });

function mineDesc(cat, me) {
  return {
    key: `u:${me.uid}:${cat.id}`,
    name: cat.name,
    fixed: false,
    ref: { id: cat.id, uid: me.uid, by: cleanCategoryName(me.name || "").slice(0, 40), lang: cat.lang },
    lang: cat.lang,
    mine: true,
  };
}

// ctx: { me: { uid, name }, mine: normalizeCustomCategories(...) }
export function categoryOf(recipe, ctx) {
  const name = recipe && typeof recipe.category === "string" ? recipe.category : "";
  if (!name) return null;
  if (isFixedCategory(name)) return fixedDesc(name);
  const mine = (ctx && ctx.mine) || [];
  const me = (ctx && ctx.me) || {};
  const ref = cleanCategoryRef(recipe.categoryRef);
  if (ref) {
    if (ref.uid === me.uid) {
      const own = mine.find((c) => c.id === ref.id);
      if (own) return mineDesc(own, me);
    }
    return { key: `u:${ref.uid}:${ref.id}`, name, fixed: false, ref, lang: ref.lang, mine: ref.uid === me.uid };
  }
  const own = mine.find((c) => categoryKey(c.name) === categoryKey(name));
  if (own && me.uid) return mineDesc(own, me);
  return { key: `n:${categoryKey(name)}`, name, fixed: false, ref: null, lang: "tr", mine: false };
}

// Liste bölümleri ya da seçici seçenekleri: sabitler, kendi kategorilerim (oluşturma
// sırasıyla, boş olsa da), sonra verilen tariflerde geçen diğer kategoriler (ada göre).
// Seçici için `recipes` yalnızca kaydedilecek yerlerin (kişisel/aile) tarifleridir:
// bir ailenin üyelerinin kategorileri yalnızca o aileye kaydederken seçenek olur.
export function categoryOptions(ctx, recipes = []) {
  const out = CATEGORIES.map(fixedDesc);
  const keys = new Set(out.map((d) => d.key));
  for (const cat of (ctx && ctx.mine) || []) {
    if (!ctx.me || !ctx.me.uid) break;
    const d = mineDesc(cat, ctx.me);
    if (!keys.has(d.key)) {
      keys.add(d.key);
      out.push(d);
    }
  }
  const extra = [];
  for (const r of Array.isArray(recipes) ? recipes : []) {
    const d = categoryOf(r, ctx);
    if (d && !keys.has(d.key)) {
      keys.add(d.key);
      extra.push(d);
    }
  }
  extra.sort((a, b) => a.name.localeCompare(b.name, "tr") || a.key.localeCompare(b.key));
  return [...out, ...extra];
}

// Tarife yazılacak alanlar (categoryRef yalnızca özel kategoride).
export function categoryFields(desc) {
  if (!desc) return { category: "", categoryRef: undefined };
  return { category: desc.name, categoryRef: desc.ref ? { ...desc.ref } : undefined };
}
