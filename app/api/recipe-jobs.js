import crypto from "node:crypto";
import { waitUntil, getDeadline } from "@vercel/functions";
import { requireUser } from "./_lib/auth.js";
import { redisDel, redisGet, redisGetJSON, redisSet, redisSetJSON, redisSetNX } from "./_lib/redis.js";
import { getProfile, FREE_RECIPE_LIMIT } from "./_lib/profile.js";
import { extractRecipeFromCaption } from "./_lib/extractRecipe.js";
import { fcmTokensKey, notifyUserDevices } from "./_lib/fcm.js";
import { addPendingJobRecipe } from "./_lib/jobRecipes.js";
import { CATEGORIES } from "../shared/recipeExtraction.js";

// Android paylaşım paneli (ShareActivity) buraya POST atıyor: link, kullanıcının
// gördüğü video açıklaması ve seçtiği kategori. Job kabul edilir edilmez {jobId}
// dönüyor, panel kapanıyor; asıl iş (Claude -> kaydet -> bildirim) waitUntil ile
// yanıt gönderildikten sonra da sürüyor. Normal "Yeni Tarif Çıkar" akışı ve
// /api/extract bundan tamamen bağımsız, dokunulmadı.
//
// Süre: Fluid Compute açık (Hobby'de varsayılan) olduğu için üst sınır 300 sn.
// Fonksiyon bu sınırı aşarsa Vercel onu öldürür ve waitUntil promise'i iptal
// edilir - yani catch bloğu çalışmaz, job "processing"te takılı kalırdı. Bu
// yüzden Claude çağrısı her zaman kalan süreden RESERVE_MS kadar önce kesiliyor.
export const config = { maxDuration: 300 };

const JOB_TTL = 7 * 24 * 3600;
const REQUEST_TTL = 24 * 3600;
const URL_LOCK_TTL = 330;
const STALE_MS = 6 * 60 * 1000;
const RESERVE_MS = 20_000;
const MAX_CLAUDE_MS = 240_000;
const MAX_CAPTION_CHARS = 20000;
const SUPPORTED_LINK = /tiktok\.com|youtu\.be|youtube\.com|instagram\.com/i;
const LIMIT_MESSAGE = `Ücretsiz hesaplar en fazla ${FREE_RECIPE_LIMIT} kişisel tarif ekleyebilir. Sınırsız eklemek için Plus'a geç.`;

const recipesKey = (uid) => `user:${uid}:recipes`;
const jobKey = (uid, jobId) => `job:${uid}:${jobId}`;
const requestKey = (uid, requestId) => `job-req:${uid}:${requestId}`;
const urlLockKey = (uid, url) => `job-url:${uid}:${crypto.createHash("sha1").update(url).digest("hex")}`;

function genId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function logStep(jobId, step, ms, extra) {
  console.log(JSON.stringify({ tag: "recipe-job", jobId, step, ms, ...extra }));
}

// Fonksiyon öldürüldüyse job sonsuza kadar "processing" görünmesin: yeterince
// eskiyen bir job başarısız sayılır (ve yeni bir job açılmasını engellemez).
function effectiveJob(job) {
  if (!job) return null;
  const active = job.status === "queued" || job.status === "processing";
  if (active && Date.now() - (job.updatedAt || job.createdAt || 0) > STALE_MS) {
    return { ...job, status: "failed", error: job.error || "İşlem yarıda kaldı." };
  }
  return job;
}

function blocksNewJob(job) {
  return !!job && (job.status === "queued" || job.status === "processing" || job.status === "completed");
}

async function patchJob(uid, jobId, patch) {
  const key = jobKey(uid, jobId);
  const current = (await redisGetJSON(key, null)) || {};
  const next = { ...current, ...patch, updatedAt: Date.now() };
  await redisSetJSON(key, next, JOB_TTL);
  return next;
}

// Liste bozuksa ([] fallback'i yerine) hata veriyoruz - aksi hâlde tek bir
// ayrıştırma hatası kullanıcının tüm tariflerinin üzerine yazardı.
async function readRecipeList(uid) {
  const raw = await redisGet(recipesKey(uid));
  if (raw == null) return [];
  let list;
  try {
    list = JSON.parse(raw);
  } catch (e) {
    throw new Error("Tarif listesi okunamadı.");
  }
  if (!Array.isArray(list)) throw new Error("Tarif listesi okunamadı.");
  return list;
}

async function processRecipeJob({ uid, jobId, sourceUrl, caption, category, addedBy, lockKey }) {
  const startedAt = Date.now();
  const timings = {};
  let recipe = null;

  try {
    const deadline = getDeadline();
    const budgetMs = deadline ? deadline.getTime() - Date.now() : null;
    await patchJob(uid, jobId, { status: "processing", startedAt, budgetMs });

    const claudeTimeout = Math.max(
      15_000,
      Math.min(MAX_CLAUDE_MS, (budgetMs == null ? MAX_CLAUDE_MS + RESERVE_MS : budgetMs) - RESERVE_MS)
    );

    let t = Date.now();
    const { recipe: parsed, usage, stopReason } = await extractRecipeFromCaption({
      link: sourceUrl,
      caption,
      timeoutMs: claudeTimeout,
    });
    timings.claude = Date.now() - t;
    logStep(jobId, "claude", timings.claude, { outputTokens: usage?.output_tokens, stopReason });

    t = Date.now();
    const recipeId = genId();
    recipe = {
      ...parsed,
      id: recipeId,
      createdAt: Date.now(),
      link: sourceUrl,
      category,
      isFavorite: false,
      addedBy: addedBy || "",
      source: "share",
    };
    const profile = await getProfile(uid);
    const list = await readRecipeList(uid);
    if (!profile.isPlus && list.length >= FREE_RECIPE_LIMIT) throw new Error(LIMIT_MESSAGE);
    // İşaretçi kayıttan ÖNCE yazılıyor: istemci bu tarifi görmeden listeyi geri
    // yazarsa api/data.js onu koruyabilsin (bkz. _lib/jobRecipes.js).
    await addPendingJobRecipe(uid, recipeId);
    await redisSet(recipesKey(uid), JSON.stringify([recipe, ...list]));
    timings.save = Date.now() - t;
    logStep(jobId, "save", timings.save);
  } catch (e) {
    timings.total = Date.now() - startedAt;
    logStep(jobId, "failed", timings.total, { error: e.message });
    await patchJob(uid, jobId, { status: "failed", error: e.message || "Bilinmeyen hata", timings }).catch(() => {});
    await redisDel(lockKey).catch(() => {});
    await notifyUserDevices(uid, {
      title: "Tarif oluşturulamadı",
      body: "Paylaştığın videodan tarif çıkarılamadı. Dokun, uygulamada tekrar deneyelim.",
      data: { type: "recipe_failed", link: sourceUrl },
    }).catch(() => {});
    return;
  }

  // Tarif kaydedildi: buradan sonrası başarısız olsa bile job "failed" olmamalı.
  await patchJob(uid, jobId, {
    status: "completed",
    recipeId: recipe.id,
    recipeTitle: recipe.title,
    completedAt: Date.now(),
    timings,
  }).catch(() => {});

  const t = Date.now();
  const notify = await notifyUserDevices(uid, {
    title: "Tarifin hazır 🍝",
    body: recipe.title ? `${recipe.title} tarifin hazır.` : "Tarifin hazır.",
    data: { type: "recipe_ready", recipeId: recipe.id },
  }).catch((e) => ({ sent: 0, attempted: 0, error: e.message }));
  timings.fcm = Date.now() - t;
  timings.total = Date.now() - startedAt;
  logStep(jobId, "fcm", timings.fcm, { sent: notify.sent, attempted: notify.attempted });
  logStep(jobId, "done", timings.total);
  await patchJob(uid, jobId, { timings, notify }).catch(() => {});
}

async function countDevices(uid) {
  try {
    const tokens = await redisGetJSON(fcmTokensKey(uid), []);
    return Array.isArray(tokens) ? tokens.length : 0;
  } catch (e) {
    return 0;
  }
}

async function respondWithJob(res, uid, job, duplicate) {
  res.status(200).json({
    jobId: job.id,
    status: job.status,
    duplicate,
    notifyDevices: await countDevices(uid),
  });
}

async function handlePost(req, res, uid) {
  const { requestId, sourceUrl, caption, category, addedBy } = req.body || {};

  const url = typeof sourceUrl === "string" ? sourceUrl.trim() : "";
  if (!/^https?:\/\//i.test(url) || !SUPPORTED_LINK.test(url) || url.length > 2000) {
    res.status(400).json({ error: "Desteklenmeyen link. Sadece TikTok, YouTube ve Instagram linkleri destekleniyor." });
    return;
  }
  const captionText = typeof caption === "string" ? caption.trim() : "";
  if (!captionText) {
    res.status(400).json({ error: "Açıklama boş olamaz." });
    return;
  }
  if (captionText.length > MAX_CAPTION_CHARS) {
    res.status(400).json({ error: "Açıklama çok uzun." });
    return;
  }
  if (!CATEGORIES.includes(category)) {
    res.status(400).json({ error: "Yemeğin hangi kategoriye ait olduğunu seçmen lazım." });
    return;
  }
  if (typeof requestId !== "string" || !/^[\w-]{6,64}$/.test(requestId)) {
    res.status(400).json({ error: "Geçersiz istek." });
    return;
  }

  // Aynı panelden gelen tekrar (çift dokunuş ya da ağ hatasından sonra yeniden
  // deneme) yeni job açmıyor. Job başarısızsa yeniden denemeye izin veriliyor.
  const reqKey = requestKey(uid, requestId);
  const previousJobId = await redisGet(reqKey);
  if (previousJobId) {
    const job = effectiveJob(await redisGetJSON(jobKey(uid, previousJobId), null));
    if (blocksNewJob(job)) {
      await respondWithJob(res, uid, job, true);
      return;
    }
  }

  const profile = await getProfile(uid);
  if (!profile.isPlus) {
    const list = await redisGetJSON(recipesKey(uid), []);
    if (Array.isArray(list) && list.length >= FREE_RECIPE_LIMIT) {
      res.status(403).json({ error: LIMIT_MESSAGE });
      return;
    }
  }

  const jobId = genId();
  const lockKey = urlLockKey(uid, url);
  // Aynı video iki kez paylaşılırsa (ör. share intent iki kez tetiklenirse)
  // ikinci bir tarif oluşmasın.
  if (!(await redisSetNX(lockKey, jobId, URL_LOCK_TTL))) {
    const lockedJobId = await redisGet(lockKey);
    const job = lockedJobId ? effectiveJob(await redisGetJSON(jobKey(uid, lockedJobId), null)) : null;
    if (blocksNewJob(job)) {
      await redisSet(reqKey, job.id, REQUEST_TTL);
      await respondWithJob(res, uid, job, true);
      return;
    }
    await redisSet(lockKey, jobId, URL_LOCK_TTL);
  }

  const now = Date.now();
  const job = {
    id: jobId,
    status: "queued",
    sourceUrl: url,
    category,
    createdAt: now,
    updatedAt: now,
    recipeId: null,
    error: null,
  };
  await redisSetJSON(jobKey(uid, jobId), job, JOB_TTL);
  await redisSet(reqKey, jobId, REQUEST_TTL);

  waitUntil(
    processRecipeJob({
      uid,
      jobId,
      sourceUrl: url,
      caption: captionText,
      category,
      addedBy: typeof addedBy === "string" ? addedBy.slice(0, 60) : "",
      lockKey,
    })
  );

  await respondWithJob(res, uid, job, false);
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
    if (req.method === "POST") {
      await handlePost(req, res, user.uid);
      return;
    }
    if (req.method === "GET") {
      const jobId = req.query.id;
      if (!jobId || typeof jobId !== "string") {
        res.status(400).json({ error: "Geçersiz istek." });
        return;
      }
      const job = effectiveJob(await redisGetJSON(jobKey(user.uid, jobId), null));
      if (!job) {
        res.status(404).json({ error: "Böyle bir iş bulunamadı." });
        return;
      }
      res.status(200).json(job);
      return;
    }
    res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message || "İstek tamamlanamadı." });
  }
}
