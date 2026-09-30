import { redisGetJSON, redisSetJSON } from "./redis.js";
import { FREE_RECIPE_LIMIT, FREE_LIMIT_ERROR_CODE } from "../../shared/limits.js";

const MAX_FAMILIES = 2;

export function profileKey(uid) {
  return `user:${uid}:profile`;
}

export async function getProfile(uid) {
  return redisGetJSON(profileKey(uid), { isPlus: false, families: [] });
}

export async function setProfile(uid, profile) {
  await redisSetJSON(profileKey(uid), profile);
}

export { MAX_FAMILIES, FREE_RECIPE_LIMIT, FREE_LIMIT_ERROR_CODE };

// Sunucu tarafı mesaj (bildirim gövdesi ve kodu tanımayan istemciler için).
export const FREE_LIMIT_MESSAGE = `Free hesaplarda en fazla ${FREE_RECIPE_LIMIT} tarif kaydedebilirsin. Daha fazla tarif kaydetmek için Plus'a geç.`;
