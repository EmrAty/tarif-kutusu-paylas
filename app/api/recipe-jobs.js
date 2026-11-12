import crypto from "node:crypto";
import { waitUntil, getDeadline } from "@vercel/functions";
import { requireUser } from "./_lib/auth.js";
import { redisDel, redisGet, redisGetJSON, redisSet, redisSetJSON, redisSetNX } from "./_lib/redis.js";
import { getProfile, FREE_RECIPE_LIMIT, FREE_LIMIT_ERROR_CODE, FREE_LIMIT_MESSAGE } from "./_lib/profile.js";
import { extractRecipeFromCaption } from "./_lib/extractRecipe.js";
import { collectPushTargets, notifyUserDevices } from "./_lib/fcm.js";
import { mutateBucket, parseListOrThrow, bucketAuxKeys } from "./_lib/versionedBucket.js";
import { assertFamilyMember, familyRecipesKey } from "./_lib/families.js";
import { isAccountDeleted, accountDeletedError } from "./_lib/accountDeletion.js";
import { isTikTokLink, tiktokTranscript } from "./_lib/tiktok.js";
import { parseSocialUrl, SUPPORTED_LINK_MESSAGE } from "./_lib/socialUrl.js";
import { guardAiRequest, reserveAiBudget, sendGuardError, deferResponse } from "./_lib/aiGuard.js";
import { CATEGORIES } from "../shared/recipeExtraction.js";
import { DEFAULT_CONTENT_LANG, isContentLanguage } from "../shared/recipeLocales.js";

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
const MIN_CLAUDE_MS = 60_000;
const MIN_FALLBACK_MS = 20_000;
const MAX_CAPTION_CHARS = 20000;
const MAX_TRANSCRIPT_CHARS = 12000;
// Android, uygulama ön plandayken gelen FCM "notification" mesajını sistem
// çubuğunda GÖSTERMİYOR (onMessageReceived'e veriyor; Capacitor'da
// presentationOptions tanımlı değil). Paylaşım paneli (ShareActivity) job kabul
// edildikten sonra ~1,4 sn + kapanma animasyonu boyunca açık kaldığı için o
// arada gönderilen bildirim kayboluyordu: ör. 401 ile ~0,1 sn'de düşen job'ın
// "Tarif oluşturulamadı" bildirimi hiç görünmüyordu. Bildirim, job başladıktan
// en az bu kadar sonra gönderiliyor. (Testler ortam değişkeniyle kısaltıyor.)
const NOTIFY_MIN_DELAY_MS = 5000;
const LIMIT_MESSAGE = FREE_LIMIT_MESSAGE;
const INSUFFICIENT_MESSAGE = "Bu videodan yeterli tarif bilgisi çıkaramadık.";

// Caption'ın tek başına tarif için yeterli olup olmadığı: hashtag/mention/link
// atıldıktan sonraki uzunluk ve ölçü birimi sayısı. Yanlışlıkla "yeterli" demek
// Claude'un malzemeleri uydurmasına yol açacağı için eşikler muhafazakâr; yanlış
// "yetersiz" demenin bedeli ise sadece gereksiz bir altyazı denemesi.
// Türkçe birimler ASCII olmayan harflerle bittiği için \b yerine harf-değil
// ileri bakışı kullanılıyor (\b JavaScript'te ASCII tabanlı).
const MEASURE_RE =
  /\d+[.,]?\d*\s*(?:gram|gr|g|kilo|kg|litre|lt|ml|cl|adet|tane|paket|diş|dilim|demet|tutam|su bardağı|çay bardağı|bardak|yemek kaşığı|çorba kaşığı|tatlı kaşığı|çay kaşığı|kaşık|fincan|porsiyon)(?![\p{L}])/giu;
const RICH_CAPTION_CHARS = 400;
const MEASURED_CAPTION_CHARS = 120;
const MEASURE_HITS = 3;

function captionLooksSufficient(caption) {
  const cleaned = caption
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[#@][\p{L}\p{N}_]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length >= RICH_CAPTION_CHARS) return true;
  const hits = cleaned.match(MEASURE_RE)?.length ?? 0;
  return hits >= MEASURE_HITS && cleaned.length >= MEASURED_CAPTION_CHARS;
}

function insufficientSourceError() {
  const err = new Error(INSUFFICIENT_MESSAGE);
  err.notifyBody = INSUFFICIENT_MESSAGE;
  return err;
}

const recipesKey = (uid) => `user:${uid}:recipes`;
const jobKey = (uid, jobId) => `job:${uid}:${jobId}`;
const requestKey = (uid, requestId) => `job-req:${uid}:${requestId}`;
// Kişisel hedefte anahtar eskisiyle birebir aynı; aynı videonun bir aileye
// gönderilmesi ayrı bir iş sayılıyor.
const urlLockKey = (uid, url, target) => {
  const lockSource = target.scope === "family" ? `${url}|family:${target.familyId}` : url;
  return `job-url:${uid}:${crypto.createHash("sha1").update(lockSource).digest("hex")}`;
};

// Panelden gelen kayıt hedefi. Alan yoksa (eski panel) kişisel. Aile hedefi
// burada yalnızca biçim olarak okunuyor; üyelik assertFamilyMember ile hem job
// kabulünde hem kayıttan hemen önce doğrulanıyor.
function parseTarget(body) {
  const { target, familyId } = body || {};
  if (target === undefined || target === null || target === "personal") return { scope: "personal" };
  if (target === "family" && typeof familyId === "string" && familyId) return { scope: "family", familyId };
  return null;
}

function genId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function logStep(jobId, step, ms, extra) {
  console.log(JSON.stringify({ tag: "recipe-job", jobId, step, ms, ...extra }));
}

function notifyMinDelayMs() {
  const override = process.env.RECIPE_JOB_NOTIFY_MIN_DELAY_MS;
  const value = override === undefined || override === "" ? NaN : Number(override);
  return Number.isFinite(value) && value >= 0 ? value : NOTIFY_MIN_DELAY_MS;
}

async function waitForSharePanelToClose(startedAt) {
  const wait = startedAt + notifyMinDelayMs() - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
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

// Tarifi listeye ekler: güncel liste okunur, tarif başına eklenir ve
// karşılaştır-ve-yaz ile yazılır (bkz. _lib/versionedBucket.js). Arada bir
// istemci ya da başka bir job yazdıysa güncel listeye yeniden uygulanır —
// kimsenin değişikliği ezilmez. Liste bozuksa ([] varsayılmaz) hata verir;
// aksi hâlde tek bir ayrıştırma hatası kullanıcının tüm tariflerinin üzerine
// yazardı. `check(list)` yazımdan hemen önce (ör. Free limiti) hata atabilir.
async function addRecipeToList(key, recipe, check) {
  await mutateBucket(key, {
    parse: (raw) => {
      try {
        return parseListOrThrow(raw);
      } catch (e) {
        throw new Error("Tarif listesi okunamadı.");
      }
    },
    mutate: (list) => {
      if (list.some((r) => r && r.id === recipe.id)) return undefined;
      if (check) check(list);
      return [recipe, ...list];
    },
  });
}

async function discardJobOfDeletedAccount(uid, jobId, lockKey) {
  logStep(jobId, "account-deleted", 0);
  await redisDel(jobKey(uid, jobId)).catch(() => {});
  await redisDel(lockKey).catch(() => {});
}

// Kişisel tarif: silinen hesabın anahtarları tamamen kaldırılıyor. Aile tarifi:
// aile başka üyelerle sürüyorsa tarif ailenin ortak listesinde kalıyor (aileye
// ait); aile silme sırasında kaldırıldıysa yeniden oluşan anahtarlar siliniyor.
async function removeRecipeOfDeletedAccount(uid, recipeId, target) {
  if (target.scope === "family") {
    if ((await redisGet(`family:${target.familyId}:meta`)) == null) {
      for (const key of [familyRecipesKey(target.familyId), ...bucketAuxKeys(familyRecipesKey(target.familyId))]) {
        await redisDel(key);
      }
    }
    return;
  }
  for (const key of [recipesKey(uid), ...bucketAuxKeys(recipesKey(uid))]) {
    await redisDel(key);
  }
}

// release: eşzamanlılık kirası (aiGuard). Job hangi yoldan biterse bitsin bırakılıyor.
async function processRecipeJob({ release, ...job }) {
  try {
    await runRecipeJob(job);
  } finally {
    await release().catch(() => {});
  }
}

async function runRecipeJob({ uid, jobId, sourceUrl, caption, category, addedBy, language, lockKey, target }) {
  const startedAt = Date.now();
  const timings = {};
  let recipe = null;
  let transcriptMeta = null;

  try {
    const deadline = getDeadline();
    const budgetMs = deadline ? deadline.getTime() - Date.now() : null;
    const remainingMs = () => (deadline ? deadline.getTime() - Date.now() : MAX_CLAUDE_MS + RESERVE_MS);
    await patchJob(uid, jobId, { status: "processing", startedAt, budgetMs });

    // Caption tarif için yeterliyse akış hiç değişmiyor (eski hızlı yol).
    // Panel açıklamayı boş gönderdiyse TikTok sayfasında yeniden aranıyor.
    // Yeterli açıklama yoksa önce altyazı, sonra konuşma metni deneniyor.
    let recipeText = caption;
    if (isTikTokLink(sourceUrl) && !captionLooksSufficient(caption)) {
      const fallbackBudget = remainingMs() - RESERVE_MS - MIN_CLAUDE_MS;
      const fallback =
        fallbackBudget >= MIN_FALLBACK_MS
          ? await tiktokTranscript(sourceUrl, {
              budgetMs: fallbackBudget,
              captionIsSufficient: caption ? undefined : captionLooksSufficient,
              log: (step, ms, extra) => logStep(jobId, step, ms, extra),
            })
          : { transcript: "", method: "none", timings: {}, meta: { skipped: "süre kalmadı" } };
      Object.assign(timings, fallback.timings);
      transcriptMeta = { method: fallback.method, ...fallback.meta };
      if (fallback.caption) {
        recipeText = fallback.caption.slice(0, MAX_CAPTION_CHARS);
      } else {
        if (!fallback.transcript) throw insufficientSourceError();
        recipeText = `${caption}\n\n--- Videonun konuşma metni (otomatik çıkarıldı) ---\n${fallback.transcript.slice(
          0,
          MAX_TRANSCRIPT_CHARS
        )}`;
      }
    }

    const claudeTimeout = Math.max(15_000, Math.min(MAX_CLAUDE_MS, remainingMs() - RESERVE_MS));

    let t = Date.now();
    const { recipe: parsed, usage, stopReason } = await extractRecipeFromCaption({
      link: sourceUrl,
      caption: recipeText,
      language,
      timeoutMs: claudeTimeout,
    });
    timings.claude = Date.now() - t;
    logStep(jobId, "claude", timings.claude, { outputTokens: usage?.output_tokens, stopReason });

    // Job sürerken hesap silinmiş olabilir: silinen hesaba tarif yazılmıyor.
    if (await isAccountDeleted(uid)) throw accountDeletedError();

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
    if (target.scope === "family") {
      // Job kuyruktayken Plus kapanmış ya da aileden çıkılmış olabilir: tekrar
      // doğrulanıyor. Başarısızsa job başarısız olur, kişisel listeye yazılmaz.
      await assertFamilyMember(uid, target.familyId);
      await addRecipeToList(familyRecipesKey(target.familyId), recipe);
    } else {
      const profile = await getProfile(uid);
      await addRecipeToList(recipesKey(uid), recipe, (list) => {
        if (!profile.isPlus && list.length >= FREE_RECIPE_LIMIT) throw new Error(LIMIT_MESSAGE);
      });
    }
    timings.save = Date.now() - t;
    logStep(jobId, "save", timings.save);
  } catch (e) {
    if (e.accountDeleted || (await isAccountDeleted(uid).catch(() => false))) {
      await discardJobOfDeletedAccount(uid, jobId, lockKey);
      return;
    }
    timings.total = Date.now() - startedAt;
    logStep(jobId, "failed", timings.total, { error: e.message, transcriptMeta });
    await patchJob(uid, jobId, {
      status: "failed",
      error: e.message || "Bilinmeyen hata",
      timings,
      transcriptMeta,
    }).catch(() => {});
    await redisDel(lockKey).catch(() => {});
    await waitForSharePanelToClose(startedAt);
    const t = Date.now();
    const notify = await notifyUserDevices(uid, {
      title: "Tarif oluşturulamadı",
      body: e.notifyBody || "Paylaştığın videodan tarif çıkarılamadı. Dokun, uygulamada tekrar deneyelim.",
      data: { type: "recipe_failed", link: sourceUrl },
    }, { dedupeKey: `${jobId}:failed` }).catch((err) => ({ sent: 0, attempted: 0, error: err.message }));
    // Başarısız job'da da bildirim sonucu kayda yazılıyor (önceden yalnızca
    // başarılı yolda vardı; "bildirim geldi mi" sorusu yanıtsız kalıyordu).
    logStep(jobId, "fcm", Date.now() - t, { sent: notify.sent, attempted: notify.attempted, kind: "failed" });
    await patchJob(uid, jobId, { notify }).catch(() => {});
    return;
  }

  // Kontrol ile kayıt arasında hesap silindiyse az önce yazılan tarif geri
  // alınıyor (silme bu anahtarları çoktan temizlemiş olabilir).
  if (await isAccountDeleted(uid).catch(() => false)) {
    await removeRecipeOfDeletedAccount(uid, recipe.id, target).catch(() => {});
    await discardJobOfDeletedAccount(uid, jobId, lockKey);
    return;
  }

  // Tarif kaydedildi: buradan sonrası başarısız olsa bile job "failed" olmamalı.
  await patchJob(uid, jobId, {
    status: "completed",
    recipeId: recipe.id,
    recipeTitle: recipe.title,
    completedAt: Date.now(),
    timings,
    transcriptMeta,
  }).catch(() => {});

  await waitForSharePanelToClose(startedAt);
  const t = Date.now();
  const notify = await notifyUserDevices(uid, {
    title: "Tarifin hazır 🍝",
    body: recipe.title ? `${recipe.title} tarifin hazır.` : "Tarifin hazır.",
    // Aile tarifinde uygulama doğru listeyi tazeleyebilsin diye kapsam da
    // gidiyor; kişisel bildirimin payload'ı eskisiyle aynı.
    data:
      target.scope === "family"
        ? { type: "recipe_ready", recipeId: recipe.id, scope: "family", familyId: target.familyId }
        : { type: "recipe_ready", recipeId: recipe.id },
  }, { dedupeKey: `${jobId}:ready` }).catch((e) => ({ sent: 0, attempted: 0, error: e.message }));
  timings.fcm = Date.now() - t;
  timings.total = Date.now() - startedAt;
  logStep(jobId, "fcm", timings.fcm, { sent: notify.sent, attempted: notify.attempted });
  logStep(jobId, "done", timings.total);
  await patchJob(uid, jobId, { timings, notify }).catch(() => {});
}

async function countDevices(uid) {
  try {
    // Tarif bildiriminin gideceği (native) cihaz sayısı; yalnızca okur.
    return (await collectPushTargets(uid, { cleanup: false })).length;
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

async function handlePost(req, res, user) {
  const uid = user.uid;
  const { requestId, sourceUrl, caption, category, addedBy, language } = req.body || {};
  const target = parseTarget(req.body);
  if (!target) {
    res.status(400).json({ error: "Geçersiz kayıt hedefi." });
    return;
  }

  // Gerçek URL ayrıştırması: "evil.com/?tiktok.com", "tiktok.com.evil.com",
  // "instagram.com@evil.com" ya da IP adresi kabul edilmiyor (bkz. socialUrl.js).
  const parsedUrl = parseSocialUrl(sourceUrl);
  if (!parsedUrl) {
    res.status(400).json({ error: SUPPORTED_LINK_MESSAGE });
    return;
  }
  const url = parsedUrl.url;
  const captionText = typeof caption === "string" ? caption.trim() : "";
  // TikTok'ta açıklama boş olabilir: processRecipeJob yetersiz açıklamada zaten
  // altyazı/konuşma metnine düşüyor, ikisi de yoksa job "failed" oluyor (tarif
  // uydurulmuyor). Instagram/YouTube'da böyle bir yol olmadığı için açıklama şart.
  if (!captionText && !isTikTokLink(url)) {
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

  if (target.scope === "family") {
    // Yetkisiz/yanlış aile: job hiç açılmıyor, hata dönüyor. Kişisel listeye
    // sessizce düşürülmüyor.
    try {
      await assertFamilyMember(uid, target.familyId);
    } catch (e) {
      res.status(e.status || 403).json({ error: e.message });
      return;
    }
  }

  const profile = await getProfile(uid);
  if (target.scope === "personal" && !profile.isPlus) {
    const list = await redisGetJSON(recipesKey(uid), []);
    if (Array.isArray(list) && list.length >= FREE_RECIPE_LIMIT) {
      res.status(403).json({ error: LIMIT_MESSAGE, code: FREE_LIMIT_ERROR_CODE });
      return;
    }
  }

  // Kötüye kullanım koruması (hız + eşzamanlı job). Normal kullanımda hiç devreye
  // girmez; tekrar gönderimler (yukarıdaki requestId dalı) buraya gelmeden
  // döndüğü için sayılmaz. Maliyet sayacı (UID toplamı + global) burada DEĞİL,
  // aşağıda yeni bir job açılacağı kesinleşince ayrılıyor.
  let release;
  try {
    release = await guardAiRequest({ action: "recipeJob", user, req, reserveBudget: false });
  } catch (e) {
    if (sendGuardError(res, e)) return;
    throw e;
  }

  // Kira sahipliği: kira ya arka plan job'una devredilir (o, bittiğinde bırakır)
  // ya da bu fonksiyon hangi yoldan çıkarsa çıksın (erken dönüş, Redis hatası,
  // throw) finally'de bırakılır. release() iki kez çağrılsa da güvenli.
  // Yanıt, kira bırakıldıktan (ya da job'a devredildikten) sonra gönderilir:
  // Vercel'de yanıttan sonraki kod garanti değil (bkz. deferResponse).
  const deferred = deferResponse(res);
  const out = deferred.res;
  let handedOff = false;
  try {
    const jobId = genId();
    const lockKey = urlLockKey(uid, url, target);
    // Aynı video iki kez paylaşılırsa (ör. share intent iki kez tetiklenirse)
    // ikinci bir tarif oluşmasın.
    if (!(await redisSetNX(lockKey, jobId, URL_LOCK_TTL))) {
      const lockedJobId = await redisGet(lockKey);
      const job = lockedJobId ? effectiveJob(await redisGetJSON(jobKey(uid, lockedJobId), null)) : null;
      if (blocksNewJob(job)) {
        await redisSet(reqKey, job.id, REQUEST_TTL);
        await respondWithJob(out, uid, job, true);
        return;
      }
      await redisSet(lockKey, jobId, URL_LOCK_TTL);
    }

    // Yeni bir job açılacak ve sağlayıcıya gidilecek: maliyet sayacı şimdi.
    try {
      await reserveAiBudget({ uid, isAnonymous: !!user.isAnonymous });
    } catch (e) {
      await redisDel(lockKey).catch(() => {});
      if (sendGuardError(out, e)) return;
      throw e;
    }

    const now = Date.now();
    const job = {
      id: jobId,
      status: "queued",
      sourceUrl: url,
      category,
      scope: target.scope,
      familyId: target.scope === "family" ? target.familyId : null,
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
        // Yalnızca çıktı dili; bilinmeyen değer varsayılan dile (tr) düşer.
        language: isContentLanguage(language) ? language : DEFAULT_CONTENT_LANG,
        lockKey,
        target,
        release,
      })
    );
    handedOff = true;

    await respondWithJob(out, uid, job, false);
  } finally {
    if (!handedOff) await release().catch(() => {});
    deferred.flush();
  }
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
      await handlePost(req, res, user);
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
