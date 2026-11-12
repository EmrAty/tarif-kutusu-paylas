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
//   * Biçimi tanınmayan eski veri aktarılmaz (kısmen de değil) ve "yok"tan
//     ayrı raporlanır (status.<alan>.state = "invalid").
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

// Desteklenen biçim = repo geçmişinde legacy döneminde (3 Eylül 2026 →
// 42a31ed) gerçekten yazılan biçim; bugünkü kovalarla birebir aynı, dönüşüm
// gerekmez:
//   recipes        [{ id: "<Date.now()>-xxxxxx", ... }]  (id her zaman metin)
//   shopping-list  { selected: [<tarif id>], checked: { ... } }
//   pantry-items   ["malzeme", ...]
// Bunun dışındaki her şey (sayısal id, id'siz tarif, dizi biçiminde alışveriş
// listesi…) "tanınmayan biçim" olarak raporlanır: hiçbir şey dönüştürülmez,
// kısmen aktarılmaz, veri yerinde kalır. Sonuç türleri:
//   missing  anahtar yok
//   empty    anahtar var, aktarılacak öğe yok
//   ok       aktarılabilir (count öğe)
//   invalid  tanınmayan biçim (reason + count)
function invalid(reason, count) {
  return { state: "invalid", reason, ...(count != null ? { count } : {}) };
}

export function classifyLegacyValue(bucket, raw) {
  if (raw == null || raw === "") return { state: "missing" };
  let parsed;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (e) {
    return invalid("not_json");
  }
  if (bucket === "shopping-list") {
    if (!isPlainObject(parsed)) return invalid(Array.isArray(parsed) ? "array_instead_of_object" : "not_object");
    const { selected, checked } = parsed;
    if (selected !== undefined && !(Array.isArray(selected) && selected.every((x) => typeof x === "string"))) return invalid("selected_not_id_list");
    if (checked !== undefined && !isPlainObject(checked)) return invalid("checked_not_object");
    const count = (selected || []).length + Object.keys(checked || {}).length;
    return count ? { state: "ok", count, value: JSON.stringify(parsed) } : { state: "empty" };
  }
  if (!Array.isArray(parsed)) return invalid("not_array");
  if (parsed.length === 0) return { state: "empty" };
  if (bucket === "pantry-items") {
    if (!parsed.every((x) => typeof x === "string")) return invalid("item_not_text", parsed.length);
    return { state: "ok", count: parsed.length, value: JSON.stringify(parsed) };
  }
  // recipes
  if (!parsed.every(isPlainObject)) return invalid("item_not_object", parsed.length);
  if (!parsed.every((r) => r.id !== undefined && r.id !== null && r.id !== "")) return invalid("id_missing", parsed.length);
  if (!parsed.every((r) => typeof r.id === "string")) return invalid("id_not_text", parsed.length);
  if (new Set(parsed.map((r) => r.id)).size !== parsed.length) return invalid("duplicate_id", parsed.length);
  return { state: "ok", count: parsed.length, value: JSON.stringify(parsed) };
}

// Geriye dönük: yalnızca aktarılabilir değeri (ya da null) verir.
export function sanitizeLegacyValue(bucket, raw) {
  const result = classifyLegacyValue(bucket, raw);
  return result.state === "ok" ? result.value : null;
}

const BUCKETS = [
  ["recipes", "recipes"],
  ["shoppingList", "shopping-list"],
  ["pantryItems", "pantry-items"],
];

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
    const raws = await Promise.all(BUCKETS.map(([, bucket]) => redisGet(bucket)));
    const body = { status: {} };
    BUCKETS.forEach(([field, bucket], i) => {
      const { value, ...status } = classifyLegacyValue(bucket, raws[i]);
      body[field] = value || null;
      body.status[field] = status;
    });
    res.status(200).json(body);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
}
