import { requireUser } from "./_lib/auth.js";
import { redisGet, redisSet, redisGetJSON } from "./_lib/redis.js";
import { getProfile, FREE_RECIPE_LIMIT } from "./_lib/profile.js";

const ALLOWED_BUCKETS = new Set(["recipes", "shopping-list", "pantry-items"]);

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

  if (req.method === "GET") {
    try {
      const value = await redisGet(key);
      res.status(200).json({ value: value ?? null });
    } catch (e) {
      res.status(e.status || 502).json({ error: e.message });
    }
    return;
  }

  if (req.method === "POST") {
    const { value } = req.body || {};
    if (typeof value !== "string") {
      res.status(400).json({ error: "Geçersiz istek." });
      return;
    }

    if (bucket === "recipes" && scope === "personal") {
      const profile = await getProfile(user.uid);
      if (!profile.isPlus) {
        try {
          const previous = (await redisGetJSON(key, [])) || [];
          const next = JSON.parse(value);
          if (Array.isArray(next) && next.length > FREE_RECIPE_LIMIT && next.length > previous.length) {
            res.status(403).json({
              error: `Ücretsiz hesaplar en fazla ${FREE_RECIPE_LIMIT} kişisel tarif ekleyebilir. Sınırsız eklemek için Plus'a geç.`,
            });
            return;
          }
        } catch (e) {
          // ayrıştırma başarısızsa limit kontrolü atlanır, normal yazım denemesi devam eder
        }
      }
    }

    try {
      await redisSet(key, value);
      res.status(200).json({ ok: true });
    } catch (e) {
      res.status(e.status || 502).json({ error: e.message });
    }
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
}
