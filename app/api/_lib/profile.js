import { redisGetJSON, redisSetJSON } from "./redis.js";

const MAX_FAMILIES = 2;
const FREE_RECIPE_LIMIT = 50;

export function profileKey(uid) {
  return `user:${uid}:profile`;
}

export async function getProfile(uid) {
  return redisGetJSON(profileKey(uid), { isPlus: false, families: [] });
}

export async function setProfile(uid, profile) {
  await redisSetJSON(profileKey(uid), profile);
}

export { MAX_FAMILIES, FREE_RECIPE_LIMIT };
