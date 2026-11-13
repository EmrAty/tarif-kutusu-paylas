import crypto from "node:crypto";
import { requireUser } from "./_lib/auth.js";
import { redisGetJSON, redisSetJSON } from "./_lib/redis.js";
import { getProfile, FREE_RECIPE_LIMIT, FREE_LIMIT_ERROR_CODE, FREE_LIMIT_MESSAGE } from "./_lib/profile.js";
import { readBucket, compareAndSet, isValidBaseVersion } from "./_lib/versionedBucket.js";
import { assertFamilyAccess } from "./_lib/families.js";
import { checkRecipeList } from "./_lib/recipeInput.js";

const ALLOWED_BUCKETS = new Set(["recipes", "shopping-list", "pantry-items"]);

// Kişisel listeden az önce çıkarılan tarif id'leri: "Geri al" (App.jsx,
// 6 sn) silinen tarifi listeye geri yazıyor. Sınırın üstündeki Free
// kullanıcıda bu yazım yeni tarif sayılıp reddedilirse silinen tarif kaybolurdu.
const RECENTLY_REMOVED_TTL = 120;
const MAX_RECENTLY_REMOVED = 30;
// Grup 5: "geri al" istisnasının yeni biçimi. Eski anahtar (`…:recentlyRemovedRecipes`,
// yalnızca id dizisi) bilerek KULLANILMIYOR: eski sunucuya geri dönülürse eski kod
// yeni biçimi okuyup hata vermesin diye ayrı anahtar.
//   { ceiling: <silmeden önceki en yüksek tarif sayısı>, items: [{ id, h: <içerik özeti> }] }
const recentlyRemovedKey = (uid) => `user:${uid}:recentlyRemovedRecipes:v2`;
const recipeDigest = (r) => crypto.createHash("sha256").update(JSON.stringify(r)).digest("hex").slice(0, 32);
function readRecentlyRemoved(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ceiling: 0, items: [] };
  const items = Array.isArray(value.items) ? value.items.filter((x) => x && x.id != null && typeof x.h === "string") : [];
  return { ceiling: Number.isFinite(value.ceiling) ? value.ceiling : 0, items };
}

export const VERSION_CONFLICT_CODE = "version_conflict";
export const CLIENT_OUTDATED_CODE = "client_outdated";

const idsOf = (list) => new Set((Array.isArray(list) ? list : []).map((r) => r && r.id).filter(Boolean));

function bucketKey(scope, uid, familyId, bucket) {
  return scope === "family" ? `family:${familyId}:${bucket}` : `user:${uid}:${bucket}`;
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// Gelen değerin biçimi: tarif/kiler listesi dizi, alışveriş listesi nesne.
// Bozuk bir istemci yazımı hiçbir zaman kovanın yerine geçmesin.
function parseIncoming(bucket, value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (e) {
    return null;
  }
  if (bucket === "shopping-list") return isPlainObject(parsed) ? parsed : null;
  if (!Array.isArray(parsed)) return null;
  if (bucket === "recipes" && !parsed.every(isPlainObject)) return null;
  return parsed;
}

function parseStoredList(raw) {
  if (raw == null) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value : [];
  } catch (e) {
    return [];
  }
}

function conflict(res, current) {
  res.status(409).json({
    error: "Veri başka bir cihazda değişti.",
    code: VERSION_CONFLICT_CODE,
    value: current.raw,
    version: current.version,
  });
}

// Kilitli aile kartı özeti (Grup 4): Plus'ı kapalı üye aile tariflerini
// açamaz; listede yalnızca kilitli kart görünür. Kart için gerekenden fazlası
// (malzeme, yapılış, besin, link, görsel…) istemciye HİÇ gönderilmez.
const SUMMARY_TITLE_MAX = 200;
function lockedSummary(list) {
  return list
    .filter((r) => r && typeof r === "object" && (typeof r.id === "string" || typeof r.id === "number"))
    .map((r) => ({
      id: r.id,
      title: typeof r.title === "string" ? r.title.slice(0, SUMMARY_TITLE_MAX) : "",
      category: typeof r.category === "string" ? r.category.slice(0, 80) : "",
      createdAt: Number.isFinite(Number(r.createdAt)) ? Number(r.createdAt) : null,
      addedBy: typeof r.addedBy === "string" ? r.addedBy.slice(0, 40) : null,
      isFavorite: !!r.isFavorite,
    }));
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

  // summary=1: yalnızca aile tarif listesinin kilitli kart özeti (okuma).
  const summary = req.method === "GET" && req.query.summary === "1";
  if (summary && (scope !== "family" || bucket !== "recipes")) {
    res.status(400).json({ error: "Geçersiz istek." });
    return;
  }

  try {
    if (scope === "family") {
      if (!familyId) {
        res.status(400).json({ error: "Aile kimliği gerekli." });
        return;
      }
      // Profil + aile kaydı + üye listesi + Plus birlikte doğrulanır (bkz.
      // assertFamilyAccess). Plus'sız üye yalnızca özeti alabilir.
      try {
        await assertFamilyAccess(user.uid, familyId, undefined, { requirePlus: !summary });
      } catch (e) {
        if (e.status === 400 || e.status === 403 || e.status === 404) {
          res.status(e.status).json({ error: e.message, ...(e.code ? { code: e.code } : {}) });
          return;
        }
        throw e;
      }
    }

    const key = bucketKey(scope, user.uid, familyId, bucket);

    if (summary) {
      const current = await readBucket(key);
      res.status(200).json({ summary: lockedSummary(parseStoredList(current.raw)) });
      return;
    }

    // Okuma: değer + sürüm. "Kayıt yok" { value: null } demektir; her türlü
    // okuma hatası 5xx döner ve istemci bunu ASLA boş liste saymaz.
    if (req.method === "GET") {
      const current = await readBucket(key);
      res.status(200).json({ value: current.raw, version: current.version });
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const { value, baseVersion } = req.body || {};
    // Sürüm göndermeyen (eski) istemci kovanın tamamını körlemesine
    // ezebilirdi: yeni sunucu bu yazımı kabul etmez, istemci yenilenmeli.
    if (!isValidBaseVersion(baseVersion)) {
      res.status(426).json({
        error: "Uygulamanın yeni bir sürümü var. Değişikliklerin kaydedilebilmesi için lütfen uygulamayı yenile.",
        code: CLIENT_OUTDATED_CODE,
      });
      return;
    }
    if (typeof value !== "string") {
      res.status(400).json({ error: "Geçersiz istek." });
      return;
    }
    let next = parseIncoming(bucket, value);
    if (next === null) {
      res.status(400).json({ error: "Geçersiz veri." });
      return;
    }

    const current = await readBucket(key);
    if (current.version !== baseVersion) {
      conflict(res, current);
      return;
    }

    const isPersonalRecipes = bucket === "recipes" && scope === "personal";
    const previous = bucket === "recipes" ? parseStoredList(current.raw) : null;

    // Grup 5: yeni/değişen tariflerde link, kimlik ve boyut denetimi (kişisel ve aile).
    let raw = value;
    let sanitized = 0;
    if (bucket === "recipes") {
      let checked;
      try {
        checked = checkRecipeList(next, previous);
      } catch (e) {
        if (e.code) {
          res.status(e.status).json({ error: e.message, code: e.code });
          return;
        }
        throw e;
      }
      sanitized = checked.sanitized;
      if (sanitized) {
        next = checked.list;
        raw = JSON.stringify(next);
      }
    }

    if (isPersonalRecipes) {
      const profile = await getProfile(user.uid);
      if (!profile.isPlus && next.length > FREE_RECIPE_LIMIT && next.length > previous.length) {
        // Sınırın üstünde büyüme yalnızca GERÇEK bir "geri al" ise kabul edilir:
        //  - eklenen her tarif son 2 dakikada silinmiş olmalı ve içeriği silinen
        //    hâliyle birebir aynı olmalı (id'yi yeniden kullanıp yeni tarif eklenemez);
        //  - liste, silmeden önceki sayıyı (ceiling) aşamaz. Böylece "sil → yeni
        //    ekle → geri al" ile sınır aşılamaz; sınırın üstündeki eski hesaplar
        //    (fazla tarifler silinmez, kilitlenir) kendi tariflerini geri alabilir.
        // `previous`, karşılaştır-ve-yaz'ın beklediği sürümle aynı anın verisi:
        // kontrol ile yazım arasında liste değişirse yazım çakışmayla reddedilir.
        const previousIds = idsOf(previous);
        const recent = readRecentlyRemoved(await redisGetJSON(recentlyRemovedKey(user.uid), null));
        const restorable = new Map(recent.items.map((x) => [x.id, x.h]));
        const added = next.filter((r) => !previousIds.has(r.id));
        const genuineUndo = added.every((r) => restorable.get(r.id) === recipeDigest(r)) && next.length <= recent.ceiling;
        if (!genuineUndo) {
          res.status(403).json({ error: FREE_LIMIT_MESSAGE, code: FREE_LIMIT_ERROR_CODE });
          return;
        }
      }
    }

    const result = await compareAndSet(key, baseVersion, raw);
    if (!result.ok) {
      // Okuma ile yazım arasında başka biri yazdı: hiçbir şey yazılmadı.
      conflict(res, await readBucket(key));
      return;
    }

    if (isPersonalRecipes) {
      try {
        const nextIds = idsOf(next);
        const removed = previous.filter((r) => r && r.id != null && !nextIds.has(r.id));
        if (removed.length) {
          const recent = readRecentlyRemoved(await redisGetJSON(recentlyRemovedKey(user.uid), null));
          const items = [...recent.items, ...removed.map((r) => ({ id: r.id, h: recipeDigest(r) }))].slice(-MAX_RECENTLY_REMOVED);
          await redisSetJSON(
            recentlyRemovedKey(user.uid),
            { ceiling: Math.max(recent.ceiling, previous.length), items },
            RECENTLY_REMOVED_TTL
          );
        }
      } catch (e) {
        // kayıt tutulamazsa yalnızca geri alma istisnası çalışmaz
      }
    }

    res.status(200).json({ ok: true, version: result.version, ...(sanitized ? { sanitizedLinks: sanitized } : {}) });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.status ? e.message : "Veritabanına erişilemedi." });
  }
}
