import { redisGetJSON } from "./redis.js";
import { mutateBucket } from "./versionedBucket.js";
import { FREE_RECIPE_LIMIT, FREE_LIMIT_ERROR_CODE } from "../../shared/limits.js";

const MAX_FAMILIES = 2;

export function profileKey(uid) {
  return `user:${uid}:profile`;
}

export async function getProfile(uid) {
  return redisGetJSON(profileKey(uid), { isPlus: false, families: [] });
}

function corruptProfile() {
  const err = new Error("Profil okunamadı.");
  err.status = 502;
  err.code = "profile_unreadable";
  return err;
}

// Kayıt yoksa varsayılan profil; bozuk kayıt hata (varsayılanla EZİLMEZ —
// aile üyelikleri kaybolurdu).
export function parseProfile(raw) {
  if (raw == null) return { isPlus: false, families: [] };
  let value;
  try {
    value = JSON.parse(raw);
  } catch (e) {
    throw corruptProfile();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw corruptProfile();
  const families = value.families == null ? [] : value.families;
  if (!Array.isArray(families) || !families.every((f) => typeof f === "string")) throw corruptProfile();
  return { ...value, isPlus: !!value.isPlus, families: [...families] };
}

// Profil değişiklikleri atomik karşılaştır-ve-yaz ile (Grup 1 motoru, sürüm +
// yedek): aynı anda katılma / ayrılma / Plus değişikliği birbirini ezemez.
// mutate(profile) yeni profili döndürür ya da değişiklik yoksa undefined.
export async function updateProfile(uid, mutate) {
  return mutateBucket(profileKey(uid), { parse: parseProfile, mutate });
}

export { MAX_FAMILIES, FREE_RECIPE_LIMIT, FREE_LIMIT_ERROR_CODE };

// Sunucu tarafı mesaj (bildirim gövdesi ve kodu tanımayan istemciler için).
export const FREE_LIMIT_MESSAGE = `Free hesaplarda en fazla ${FREE_RECIPE_LIMIT} tarif kaydedebilirsin. Daha fazla tarif kaydetmek için Plus'a geç.`;
