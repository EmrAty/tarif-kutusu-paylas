import { requireUser } from "./_lib/auth.js";
import { redisGet, redisSet, redisGetJSON, redisSetJSON } from "./_lib/redis.js";
import { getProfile, FREE_RECIPE_LIMIT, FREE_LIMIT_ERROR_CODE, FREE_LIMIT_MESSAGE } from "./_lib/profile.js";
import { acknowledgePendingJobRecipes, mergePendingJobRecipes, userOwner, familyOwner } from "./_lib/jobRecipes.js";

const ALLOWED_BUCKETS = new Set(["recipes", "shopping-list", "pantry-items"]);

// Kişisel listeden az önce çıkarılan tarif id'leri: "Geri al" (App.jsx,
// 6 sn) silinen tarifi listeye geri yazıyor. Sınırın üstündeki Free
// kullanıcıda bu yazım yeni tarif sayılıp reddedilirse silinen tarif kaybolurdu.
const RECENTLY_REMOVED_TTL = 120;
const MAX_RECENTLY_REMOVED = 30;
const recentlyRemovedKey = (uid) => `user:${uid}:recentlyRemovedRecipes`;

const idsOf = (list) => new Set((Array.isArray(list) ? list : []).map((r) => r && r.id).filter(Boolean));

function bucketKey(scope, uid, familyId, bucket) {
  return scope === "family" ? `family:${familyId}:${bucket}` : `user:${uid}:${bucket}`;
}

export default async function handler(req, res) {
  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    res.status(e.status || 401).json({ error: e.message });
    return;
  }

  const bucket = req.method === "GET" ? req.query.bucket : (req.body || {}).bucket;
  const scope = req.method === "GET" ? req.query.scope : (req.body || {}).scope;
  const familyId = req.method === "GET" ? req.query.familyId : (req.body || {}).familyId;

  if (!ALLOWED_BUCKETS.has(bucket)) {
    res.status(400).json({ error: "Geçersiz veri türü." });
    return;
  }
  if (scope !== "personal" && scope !== "family") {
    res.status(400).json({ error: "Geçersiz kapsam." });
    return;
  }
  if (scope === "family") {
    if (!familyId) {
      res.status(400).json({ error: "Aile kimliği gerekli." });
      return;
    }
    const profile = await getProfile(user.uid);
    if (!profile.families.includes(familyId)) {
      res.status(403).json({ error: "Bu ailenin üyesi değilsin." });
      return;
    }
  }

  const key = bucketKey(scope, user.uid, familyId, bucket);
  const isPersonalRecipes = bucket === "recipes" && scope === "personal";
  // Paylaşım paneli job'u hem kişisel hem aile tarif listesine yazabiliyor
  // (bkz. recipe-jobs.js); henüz okunmamış job tarifleri ikisinde de korunuyor.
  const isRecipes = bucket === "recipes";
  const pendingOwner = scope === "family" ? familyOwner(familyId) : userOwner(user.uid);

  if (req.method === "GET") {
    try {
      const value = await redisGet(key);
      if (isRecipes && value) {
        await acknowledgePendingJobRecipes(pendingOwner, value).catch(() => {});
      }
      res.status(200).json({ value: value ?? null });
    } catch (e) {
      res.status(e.status || 502).json({ error: e.message });
    }
    return;
  }

  if (req.method === "POST") {
    let { value } = req.body || {};
    if (typeof value !== "string") {
      res.status(400).json({ error: "Geçersiz istek." });
      return;
    }

    let merged = [];
    let previous = null;
    const loadPrevious = async () => {
      if (previous === null) previous = (await redisGetJSON(key, [])) || [];
      return previous;
    };
    if (isRecipes) {
      try {
        const result = await mergePendingJobRecipes(pendingOwner, loadPrevious, JSON.parse(value));
        if (result.merged.length) {
          value = JSON.stringify(result.list);
          merged = result.merged;
        }
      } catch (e) {
        // ayrıştırılamazsa gelen değer olduğu gibi yazılır (önceki davranış)
      }
    }

    if (isPersonalRecipes) {
      const profile = await getProfile(user.uid);
      if (!profile.isPlus) {
        try {
          const previous = await loadPrevious();
          const next = JSON.parse(value);
          if (Array.isArray(next) && next.length > FREE_RECIPE_LIMIT && next.length > previous.length) {
            // Yalnızca gerçekten yeni tarif engelleniyor; az önce silinip geri
            // alınan tarif yeni sayılmıyor. Düzenleme/silme uzunluğu artırmıyor.
            const previousIds = idsOf(previous);
            const recentlyRemoved = new Set(await redisGetJSON(recentlyRemovedKey(user.uid), []));
            const hasNew = next.some((r) => r && !previousIds.has(r.id) && !recentlyRemoved.has(r.id));
            if (hasNew) {
              res.status(403).json({ error: FREE_LIMIT_MESSAGE, code: FREE_LIMIT_ERROR_CODE });
              return;
            }
          }
        } catch (e) {
          // ayrıştırma başarısızsa limit kontrolü atlanır, normal yazım denemesi devam eder
        }
      }

      try {
        const previous = await loadPrevious();
        const nextIds = idsOf(JSON.parse(value));
        const removed = [...idsOf(previous)].filter((id) => !nextIds.has(id));
        if (removed.length) {
          const current = await redisGetJSON(recentlyRemovedKey(user.uid), []);
          const merged = [...(Array.isArray(current) ? current : []), ...removed].slice(-MAX_RECENTLY_REMOVED);
          await redisSetJSON(recentlyRemovedKey(user.uid), merged, RECENTLY_REMOVED_TTL);
        }
      } catch (e) {
        // kayıt tutulamazsa yalnızca geri alma istisnası çalışmaz
      }
    }

    try {
      await redisSet(key, value);
      res.status(200).json(merged.length ? { ok: true, merged } : { ok: true });
    } catch (e) {
      res.status(e.status || 502).json({ error: e.message });
    }
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
}
