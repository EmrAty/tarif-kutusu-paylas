import { requireUser } from "./_lib/auth.js";
import { getProfile, updateProfile } from "./_lib/profile.js";
import crypto from "node:crypto";
import { redisGetJSON } from "./_lib/redis.js";
import { verifiedFamilyIds } from "./_lib/families.js";
import { isContentLanguage } from "../shared/recipeLocales.js";
import {
  cleanCategoryName,
  categoryKey,
  normalizeCustomCategories,
  validateNewCategory,
  cleanCategoryRef,
  legacyCategoryRef,
  isAcceptableRecipeCategory,
} from "../shared/categories.js";

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
      const profile = await getProfile(user.uid);
      const out = publicProfile(profile);
      if (req.query && req.query.familyCategories === "1") out.familyCategories = await familyCategories(user.uid, profile);
      res.status(200).json(out);
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
        res.status(200).json(await changeCategories(user.uid, action, req.body || {}));
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
// birbirini ezmez. Aynı ad zaten varsa ekleme değişiklik yapmaz (o kategori döner);
// kaldırma kimlikle yapılır, yoksa değişiklik yok (tekrar gönderilen istek hata
// vermez). Kaldırma yalnızca listeden çıkarır; tariflerin kategorisine dokunmaz
// (istemci yalnızca boş kategoride önerir). Kimlik sunucuda üretilir.
export async function changeCategories(uid, action, body = {}) {
  let rejected = null;
  let created = null;
  if (action === "removeCategory") {
    const id = typeof body.id === "string" ? body.id : "";
    const updated = await updateProfile(uid, (p) => {
      const current = normalizeCustomCategories(p.categories);
      const next = current.filter((c) => c.id !== id);
      return next.length === current.length ? undefined : { ...p, categories: next };
    });
    return publicProfile(updated.value);
  }
  const name = cleanCategoryName(body.name);
  if (!name) throw Object.assign(new Error(CATEGORY_ERRORS.category_empty), { status: 400, code: "category_empty" });
  const key = categoryKey(name);
  const lang = isContentLanguage(body.lang) ? body.lang : "tr";
  const updated = await updateProfile(uid, (p) => {
    rejected = null;
    const current = normalizeCustomCategories(p.categories);
    const existing = current.find((c) => categoryKey(c.name) === key);
    if (existing) {
      created = existing;
      return undefined;
    }
    const code = validateNewCategory(name, current);
    if (code) {
      rejected = code;
      return undefined;
    }
    created = { id: newCategoryId(), name, lang };
    return { ...p, categories: [...current, created] };
  });
  if (rejected) throw Object.assign(new Error(CATEGORY_ERRORS[rejected]), { status: 400, code: rejected });
  return { ...publicProfile(updated.value), created };
}

function newCategoryId() {
  return `c${crypto.randomBytes(8).toString("hex")}`;
}

export function publicProfile(profile) {
  return { ...profile, categories: normalizeCustomCategories(profile && profile.categories) };
}

// Paylaşım paneli için: üyesi olduğun (Plus ile erişilebilen) ailelerin tariflerinde
// BAŞKA üyelerin kullandığı özel kategoriler. Yalnızca aile tariflerinde zaten
// görünen bilgi döner (ad, kimlik, sahibin uid'i/adı, dil); tarif içeriği dönmez.
export async function familyCategories(uid, profile) {
  const ids = await verifiedFamilyIds(uid, profile);
  const out = [];
  await Promise.all(
    ids.map(async (familyId) => {
      const [rawList, rawMembers] = await Promise.all([
        redisGetJSON(`family:${familyId}:recipes`, []),
        redisGetJSON(`family:${familyId}:members`, {}),
      ]);
      const list = Array.isArray(rawList) ? rawList : [];
      // Bağsız (eski) tariflerde sahip, ekleyenin adının üye listesindeki tek eşleşmesi
      // (istemcideki categoryOf ile aynı kural; bkz. shared/categories.js legacyCategoryRef).
      const members =
        rawMembers && typeof rawMembers === "object" && !Array.isArray(rawMembers)
          ? Object.entries(rawMembers).map(([memberUid, m]) => ({ uid: memberUid, name: m && m.name }))
          : [];
      const siblings = list.filter((r) => r && r.categoryRef);
      const seen = new Set();
      for (const r of list) {
        const ref = cleanCategoryRef(r && r.categoryRef) || legacyCategoryRef(r, members, siblings);
        if (!ref || ref.uid === uid || !isAcceptableRecipeCategory(r.category)) continue;
        const k = `${ref.uid}:${ref.id}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ familyId, name: r.category, ref });
      }
    })
  );
  return out;
}
