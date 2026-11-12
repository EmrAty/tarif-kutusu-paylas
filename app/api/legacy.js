import { requireUser } from "./_lib/auth.js";
import { redisGet } from "./_lib/redis.js";

// Aile hesapları/Plus eklenmeden önce tüm uygulama tek bir paylaşımlı listeydi
// ("recipes" / "shopping-list" / "pantry-items" — UID içermeyen global
// anahtarlar). Bu anahtarlarda sahiplik bilgisi YOK; içerik, uygulamanın ilk
// (aile içi) kullanıcılarının ortak verisi.
//
// GÜVENLİK (Grup 3): Eskiden giriş yapmış HERKES (Play'den kurulan bir
// uygulamadaki anonim misafir dahil) bu veriyi okuyup kendi listesine
// aktarabiliyordu — kimlik doğrulaması sahiplik kanıtı değildir. Artık:
//   * Varsayılan: kimseye açık değil (fail-closed).
//   * Yalnızca LEGACY_DATA_OWNER_UIDS ortam değişkeninde (virgülle ayrılmış)
//     açıkça listelenen, anonim OLMAYAN hesaplar okuyabilir. Sahipliği
//     insan (proje sahibi) kanıtlar; kod tahmin etmez.
//   * Global anahtarlar ASLA silinmez/taşınmaz; bu uç yalnızca okur. Aktarım
//     istemcide, hedef kova boşken sürümlü yazım (baseVersion 0) ile yapılır;
//     dolu kova üzerine yazılmaz (bkz. App.jsx importLegacyInto).
//   * Bozuk/yanlış biçimli eski veri reddedilir (null), kısmen aktarılmaz.
export const LEGACY_NOT_ELIGIBLE_CODE = "legacy_not_eligible";

export function legacyOwnerUids() {
  return new Set(
    String(process.env.LEGACY_DATA_OWNER_UIDS || "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^[A-Za-z0-9_-]{6,128}$/.test(s))
  );
}

export function isLegacyOwner(user) {
  if (!user || user.isAnonymous) return false;
  return legacyOwnerUids().has(user.uid);
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// data.js'teki yazım kurallarıyla aynı biçim: tarif listesi = nesne dizisi
// (her birinin id'si olmalı), kiler = dizi, alışveriş listesi = nesne.
// Kurala uymayan değer bütünüyle reddedilir (null) — kısmi/bozuk aktarım yok.
export function sanitizeLegacyValue(bucket, raw) {
  if (raw == null || raw === "") return null;
  let parsed;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (e) {
    return null;
  }
  if (bucket === "shopping-list") return isPlainObject(parsed) && Object.keys(parsed).length ? JSON.stringify(parsed) : null;
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  if (bucket === "recipes" && !parsed.every((r) => isPlainObject(r) && typeof r.id === "string" && r.id)) return null;
  return JSON.stringify(parsed);
}

export default async function handler(req, res) {
  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    res.status(e.status || 401).json({ error: e.message });
    return;
  }
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  if (!isLegacyOwner(user)) {
    res.status(403).json({ error: "Bu hesapta aktarılacak eski veri yok.", code: LEGACY_NOT_ELIGIBLE_CODE });
    return;
  }
  try {
    const [recipes, shoppingList, pantryItems] = await Promise.all([
      redisGet("recipes"),
      redisGet("shopping-list"),
      redisGet("pantry-items"),
    ]);
    res.status(200).json({
      recipes: sanitizeLegacyValue("recipes", recipes),
      shoppingList: sanitizeLegacyValue("shopping-list", shoppingList),
      pantryItems: sanitizeLegacyValue("pantry-items", pantryItems),
    });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
}
