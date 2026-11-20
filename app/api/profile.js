import { requireUser } from "./_lib/auth.js";
import { getProfile, updateProfile } from "./_lib/profile.js";
import { cleanCategoryName, categoryKey, normalizeCustomCategories, validateNewCategory } from "../shared/categories.js";

// isPlus şu an gerçek bir ödeme sistemine bağlı değil — kullanıcının kendisi
// açıp kapatabildiği bir test bayrağı. Ödeme entegrasyonu eklendiğinde bu
// endpoint'in POST kısmı ödeme sağlayıcısının webhook'una taşınmalı.
export default async function handler(req, res) {
  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    res.status(e.status || 401).json({ error: e.message });
    return;
  }

  if (req.method === "GET") {
    // Grup 5 (B5): bozuk profil (getProfile 502 profile_unreadable fırlatır) ya
    // da Redis hatası yakalanmamış istisna olarak sızmasın; 502 + kod döner.
    try {
      res.status(200).json(publicProfile(await getProfile(user.uid)));
    } catch (e) {
      res.status(e.status || 502).json({ error: e.status ? e.message : "Profil okunamadı.", ...(e.code ? { code: e.code } : {}) });
    }
    return;
  }

  if (req.method === "POST") {
    const { isPlus, action } = req.body || {};
    // Özel kategoriler: kullanıcının kendi listesi (bkz. shared/categories.js).
    if (action === "addCategory" || action === "removeCategory") {
      try {
        res.status(200).json(await changeCategories(user.uid, action, (req.body || {}).name));
      } catch (e) {
        res.status(e.status || 502).json({ error: e.message || "Profil güncellenemedi.", ...(e.code ? { code: e.code } : {}) });
      }
      return;
    }
    if (typeof isPlus !== "boolean") {
      res.status(400).json({ error: "Geçersiz istek." });
      return;
    }
    try {
      res.status(200).json(await setPlus(user.uid, isPlus));
    } catch (e) {
      res.status(e.status || 502).json({ error: e.message || "Profil güncellenemedi.", ...(e.code ? { code: e.code } : {}) });
    }
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
}

async function setPlus(uid, isPlus) {
  // Grup 4 ürün kararı: Plus kapanınca kullanıcı ailelerinden ÇIKARILMAZ ve
  // sahipliği devredilmez; aileleri kilitlenir (içerik ve aile işlemleri
  // sunucuda kapalı, yalnızca üyeliğini görür ve ayrılabilir). Plus yeniden
  // açılınca aynı üyelik ve içerik olduğu gibi erişilebilir. Yalnızca bayrak
  // değişir (atomik); aile kayıtlarına dokunulmaz.
  const updated = await updateProfile(uid, (p) => (p.isPlus === isPlus ? undefined : { ...p, isPlus }));
  return updated.value;
}

const CATEGORY_ERRORS = {
  category_empty: "Kategori adı boş olamaz.",
  category_too_long: "Kategori adı çok uzun.",
  category_reserved: "Bu ad hazır kategorilerden biriyle aynı.",
  category_exists: "Bu adla bir kategorin zaten var.",
  category_limit: "Daha fazla kategori eklenemiyor.",
};

// Ekleme/kaldırma atomik (profil CAS): iki cihazdan aynı anda yapılan değişiklikler
// birbirini ezmez. Aynı ad zaten varsa ekleme, yoksa kaldırma değişiklik yapmaz
// (tekrar gönderilen istek hata vermez). Kaldırma yalnızca listeden çıkarır;
// tariflerin kategorisine dokunmaz (istemci yalnızca boş kategoride önerir).
export async function changeCategories(uid, action, rawName) {
  const name = cleanCategoryName(rawName);
  if (!name) throw Object.assign(new Error(CATEGORY_ERRORS.category_empty), { status: 400, code: "category_empty" });
  const key = categoryKey(name);
  let rejected = null;
  const updated = await updateProfile(uid, (p) => {
    rejected = null;
    const current = normalizeCustomCategories(p.categories);
    if (action === "removeCategory") {
      const next = current.filter((c) => categoryKey(c) !== key);
      return next.length === current.length ? undefined : { ...p, categories: next };
    }
    if (current.some((c) => categoryKey(c) === key)) return undefined;
    const code = validateNewCategory(name, current);
    if (code) {
      rejected = code;
      return undefined;
    }
    return { ...p, categories: [...current, name] };
  });
  if (rejected) throw Object.assign(new Error(CATEGORY_ERRORS[rejected]), { status: 400, code: rejected });
  return publicProfile(updated.value);
}

export function publicProfile(profile) {
  return { ...profile, categories: normalizeCustomCategories(profile && profile.categories) };
}
