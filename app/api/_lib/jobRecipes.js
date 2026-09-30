import { redisDel, redisGetJSON, redisSetJSON } from "./redis.js";

// Arka plan job'unun bir tarif listesine (kişisel ya da aile) eklediği ama
// istemcinin henüz hiç okumadığı tariflerin id'leri. İstemci listeyi bellekteki
// kopyadan bütün hâlinde geri yazdığı için, bu tarifler o yazımda kaybolmasın
// diye api/data.js bunları listeye geri ekliyor; liste okununca siliniyor.
//
// owner, listenin sahibinin anahtar öneki: kişisel için userOwner(uid)
// ("user:<uid>"), aile için familyOwner(id) ("family:<id>") — tarif listesi
// anahtarlarıyla (`${owner}:recipes`) aynı düzen.
const TTL_SECONDS = 7 * 24 * 3600;
const MAX_ENTRIES = 20;

export const userOwner = (uid) => `user:${uid}`;
export const familyOwner = (familyId) => `family:${familyId}`;

export function pendingKey(owner) {
  return `${owner}:pendingJobRecipes`;
}

export async function getPendingJobRecipes(owner) {
  const list = await redisGetJSON(pendingKey(owner), []);
  return Array.isArray(list) ? list : [];
}

export async function setPendingJobRecipes(owner, ids) {
  if (!ids.length) {
    await redisDel(pendingKey(owner));
    return;
  }
  await redisSetJSON(pendingKey(owner), ids.slice(-MAX_ENTRIES), TTL_SECONDS);
}

export async function addPendingJobRecipe(owner, id) {
  const current = await getPendingJobRecipes(owner);
  await setPendingJobRecipes(owner, [...current, id]);
}

// GET /api/data'dan dönen listede artık bulunan id'leri bekleyenlerden çıkarır.
export async function acknowledgePendingJobRecipes(owner, rawList) {
  const pending = await getPendingJobRecipes(owner);
  if (!pending.length) return;
  let seen;
  try {
    const list = JSON.parse(rawList);
    if (!Array.isArray(list)) return;
    seen = new Set(list.map((r) => r && r.id));
  } catch (e) {
    return;
  }
  const remaining = pending.filter((id) => !seen.has(id));
  if (remaining.length !== pending.length) await setPendingJobRecipes(owner, remaining);
}

// POST /api/data: gelen listede olmayan ama sunucu listesinde duran bekleyen
// tarifleri (istemcinin hiç görmediği) gelen listenin başına ekler.
export async function mergePendingJobRecipes(owner, loadPreviousList, incomingList) {
  const pending = await getPendingJobRecipes(owner);
  if (!pending.length || !Array.isArray(incomingList)) return { list: incomingList, merged: [] };
  const previousList = await loadPreviousList();
  if (!Array.isArray(previousList)) return { list: incomingList, merged: [] };
  const incomingIds = new Set(incomingList.map((r) => r && r.id));
  const missing = previousList.filter((r) => r && pending.includes(r.id) && !incomingIds.has(r.id));
  if (!missing.length) return { list: incomingList, merged: [] };
  return { list: [...missing, ...incomingList], merged: missing.map((r) => r.id) };
}
