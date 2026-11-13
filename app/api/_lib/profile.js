import { redisGet } from "./redis.js";
import { mutateBucket } from "./versionedBucket.js";
import { FREE_RECIPE_LIMIT, FREE_LIMIT_ERROR_CODE } from "../../shared/limits.js";

const MAX_FAMILIES = 2;

export function profileKey(uid) {
  return `user:${uid}:profile`;
}

// Okuma için profil: her zaman { isPlus: boolean, families: string[] } biçiminde
// döner (Grup 5). Eskiden kayıt neyse o dönüyordu: `families` alanı eksik bir
// kayıt `profile.families.includes` çağrılarında 500'e, "null" kaydı TypeError'a
// yol açıyordu. Kayıt yoksa varsayılan; alan eksik/yanlış türdeyse güvenli
// varsayılana tamamlanır (metin olmayan aile kimlikleri yok sayılır). JSON hiç
// çözülemiyorsa varsayılan DÖNMEZ, 502 fırlatılır (Free sanılıp aileleri
// kaybolmasın; yazma yolu parseProfile ile zaten aynı kuralı izliyor).
export async function getProfile(uid) {
  return normalizeProfile(await redisGet(profileKey(uid)));
}

export function normalizeProfile(raw) {
  if (raw == null) return { isPlus: false, families: [] };
  let value;
  try {
    value = JSON.parse(raw);
  } catch (e) {
    throw corruptProfile();
  }
  if (value == null) return { isPlus: false, families: [] };
  if (typeof value !== "object" || Array.isArray(value)) throw corruptProfile();
  const families = Array.isArray(value.families) ? value.families.filter((f) => typeof f === "string" && f) : [];
  return { ...value, isPlus: value.isPlus === true, families };
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
  return { ...value, isPlus: value.isPlus === true, families: [...families] };
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
