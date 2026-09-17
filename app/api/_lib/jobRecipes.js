import { redisDel, redisGetJSON, redisSetJSON } from "./redis.js";

// Arka plan job'unun kişisel listeye eklediği ama istemcinin henüz hiç
// okumadığı tariflerin id'leri. İstemci listeyi bellekteki kopyadan bütün
// hâlinde geri yazdığı için, bu tarifler o yazımda kaybolmasın diye
// api/data.js bunları listeye geri ekliyor; istemci listeyi okuyunca siliniyor.
const TTL_SECONDS = 7 * 24 * 3600;
const MAX_ENTRIES = 20;

function pendingKey(uid) {
  return `user:${uid}:pendingJobRecipes`;
}

export async function getPendingJobRecipes(uid) {
  const list = await redisGetJSON(pendingKey(uid), []);
  return Array.isArray(list) ? list : [];
}

export async function setPendingJobRecipes(uid, ids) {
  if (!ids.length) {
    await redisDel(pendingKey(uid));
    return;
  }
  await redisSetJSON(pendingKey(uid), ids.slice(-MAX_ENTRIES), TTL_SECONDS);
}

export async function addPendingJobRecipe(uid, id) {
  const current = await getPendingJobRecipes(uid);
  await setPendingJobRecipes(uid, [...current, id]);
}

// GET /api/data'dan dönen listede artık bulunan id'leri bekleyenlerden çıkarır.
export async function acknowledgePendingJobRecipes(uid, rawList) {
  const pending = await getPendingJobRecipes(uid);
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
  if (remaining.length !== pending.length) await setPendingJobRecipes(uid, remaining);
}

// POST /api/data: gelen listede olmayan ama sunucu listesinde duran bekleyen
// tarifleri (istemcinin hiç görmediği) gelen listenin başına ekler.
export async function mergePendingJobRecipes(uid, loadPreviousList, incomingList) {
  const pending = await getPendingJobRecipes(uid);
  if (!pending.length || !Array.isArray(incomingList)) return { list: incomingList, merged: [] };
  const previousList = await loadPreviousList();
  if (!Array.isArray(previousList)) return { list: incomingList, merged: [] };
  const incomingIds = new Set(incomingList.map((r) => r && r.id));
  const missing = previousList.filter((r) => r && pending.includes(r.id) && !incomingIds.has(r.id));
  if (!missing.length) return { list: incomingList, merged: [] };
  return { list: [...missing, ...incomingList], merged: missing.map((r) => r.id) };
}
