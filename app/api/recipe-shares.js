// QR ile tarif paylaşımı. Kurallar: api/_lib/recipeShares.js, docs/qr-ve-cevrimdisi.md.
//
//   GET  /api/recipe-shares?token=…                      → alıcı: paylaşılan tarifi okur (AI yok)
//   GET  /api/recipe-shares?status=1&scope=…&recipeId=…  → sahip: bu tarifin açık paylaşımı
//   POST /api/recipe-shares { action: "create", scope, familyId?, recipeId } → sahip: QR bağlantısı
//   POST /api/recipe-shares { action: "revoke", scope, familyId?, recipeId } → sahip: paylaşımı durdur
//
// Kayıt bu uçta YAPILMAZ: alıcı tarifi kendi listesine normal kayıt yoluyla
// (/api/data, sürümlü yazım) ekler. Böylece Free sınırı, aile üyeliği ve Plus
// kilidi tek yerde (api/data.js) uygulanır ve paylaşım bunları aşamaz.
import { requireUser } from "./_lib/auth.js";
import { redisPipeline } from "./_lib/redis.js";
import { checkDataWriteLimit, clientIp, sendGuardError } from "./_lib/aiGuard.js";
import { createShare, revokeShare, resolveShare, shareStatus } from "./_lib/recipeShares.js";

// Okuma hız sınırı (token tahminini ve kazımayı anlamsız kılmak için; token
// zaten 144 bit). Redis'e ulaşılamazsa geçirilir: okumanın kendisi orada düşer.
const RESOLVE_LIMITS = [
  { seconds: 60, user: 30, anon: 15 },
  { seconds: 3600, user: 200, anon: 80 },
];

async function checkResolveLimit(user, now = Date.now()) {
  try {
    const commands = [];
    const keys = RESOLVE_LIMITS.map((w) => {
      const bucket = Math.floor(now / 1000 / w.seconds);
      const key = `rl:recipe-share-read:u:${user.uid}:${w.seconds}:${bucket}`;
      commands.push(["INCR", key], ["EXPIRE", key, String(w.seconds + 5)]);
      return { limit: user.isAnonymous ? w.anon : w.user, end: (bucket + 1) * w.seconds };
    });
    const results = await redisPipeline(commands);
    for (let i = 0; i < keys.length; i++) {
      if (Number(results[i * 2]) > keys[i].limit) return Math.max(1, Math.ceil(keys[i].end - now / 1000));
    }
  } catch {
    // fail-open (bkz. yukarı)
  }
  return null;
}

function sendError(res, e) {
  if (sendGuardError(res, e)) return;
  const status = e && Number.isInteger(e.status) && e.status >= 400 && e.status < 600 ? e.status : 500;
  if (status >= 500) console.error("[recipe-shares]", e && e.message);
  res.status(status).json({ error: status >= 500 ? "Paylaşım şu an açılamadı. Biraz sonra tekrar dene." : e.message, ...(e && e.code ? { code: e.code } : {}) });
}

export default async function handler(req, res) {
  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    res.status(e.status || 401).json({ error: e.message });
    return;
  }

  try {
    if (req.method === "GET") {
      const q = req.query || {};
      if (q.status === "1") {
        const out = await shareStatus(user.uid, { scope: q.scope, familyId: q.familyId, recipeId: q.recipeId });
        res.status(200).json(out);
        return;
      }
      const retryAfter = await checkResolveLimit(user);
      if (retryAfter != null) {
        res.setHeader("Retry-After", String(retryAfter));
        res.status(429).json({ error: "Çok fazla deneme. Biraz bekleyip tekrar dene.", code: "rate_limited", retryAfter });
        return;
      }
      const out = await resolveShare(user.uid, typeof q.token === "string" ? q.token : "");
      res.status(200).json(out);
      return;
    }

    if (req.method === "POST") {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      await checkDataWriteLimit({ uid: user.uid, isAnonymous: user.isAnonymous, ip: clientIp(req) });
      const source = { scope: body.scope, familyId: body.familyId, recipeId: body.recipeId };
      if (body.action === "create") {
        const out = await createShare(user.uid, source);
        res.status(200).json(out);
        return;
      }
      if (body.action === "revoke") {
        const out = await revokeShare(user.uid, source);
        res.status(200).json(out);
        return;
      }
      res.status(400).json({ error: "Geçersiz istek.", code: "invalid_request" });
      return;
    }

    res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    sendError(res, e);
  }
}
