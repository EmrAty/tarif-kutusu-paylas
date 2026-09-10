import { redisGetJSON, redisSetJSON } from "./redis.js";

export function membersKey(id) {
  return `family:${id}:members`;
}

export async function removeMemberFromFamily(uid, familyId) {
  const members = await redisGetJSON(membersKey(familyId), {});
  if (members[uid]) {
    delete members[uid];
    await redisSetJSON(membersKey(familyId), members);
  }
}
