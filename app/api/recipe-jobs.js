import crypto from "node:crypto";
import { waitUntil, getDeadline } from "@vercel/functions";
import { requireUser } from "./_lib/auth.js";
import { redisCommand, redisDel, redisGet, redisGetJSON, redisSet, redisSetJSON, redisSetNX } from "./_lib/redis.js";
import { getProfile, FREE_RECIPE_LIMIT, FREE_LIMIT_ERROR_CODE, FREE_LIMIT_MESSAGE } from "./_lib/profile.js";
import { extractRecipeFromCaption, isServiceSideError } from "./_lib/extractRecipe.js";
import { collectPushTargets, notifyUserDevices } from "./_lib/fcm.js";
import { mutateBucket, parseListOrThrow, bucketAuxKeys } from "./_lib/versionedBucket.js";
import { checkBucketSize } from "./_lib/bucketLimits.js";
import { assertFamilyMember, familyRecipesKey } from "./_lib/families.js";
import { isAccountDeleted, accountDeletedError } from "./_lib/accountDeletion.js";
import { mergeRedirectTarget, isGuestBound } from "./_lib/guestMerge.js";
import { isTikTokLink, tiktokTranscript } from "./_lib/tiktok.js";
import { notifyText, failedBody } from "./_lib/jobNotifyText.js";
import { parseSocialUrl, SUPPORTED_LINK_MESSAGE } from "./_lib/socialUrl.js";
import { guardAiRequest, reserveAiBudget, sendGuardError, deferResponse, checkDataWriteLimit, clientIp } from "./_lib/aiGuard.js";
import { isAcceptableRecipeCategory } from "../shared/categories.js";
import { recipeForFamily, familyCopyId } from "../shared/recipeIds.js";
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
// Claude hesabı/kapasitesi kaynaklı hata: video ya da açıklamayla ilgisi yok.
const SERVICE_UNAVAILABLE_MESSAGE = "Tarif servisi şu anda çalışmıyor; sorun videoda değil. Biraz sonra tekrar dene.";

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
  err.notifyKind = "insufficient";
  return err;
}

const recipesKey = (uid) => `user:${uid}:recipes`;
const jobKey = (uid, jobId) => `job:${uid}:${jobId}`;
const requestKey = (uid, requestId) => `job-req:${uid}:${requestId}`;
// Kişisel hedefte anahtar eskisiyle birebir aynı; aynı videonun bir aileye
// gönderilmesi ayrı bir iş sayılıyor.
// Birden fazla hedefte (kişisel + aileler) kilit kaynağı hedef kümesini içerir.
const urlLockKey = (uid, url, targets) => {
  const lockSource =
    targets.length === 1
      ? targets[0].scope === "family"
        ? `${url}|family:${targets[0].familyId}`
        : url
      : `${url}|${targets.map(targetKey).sort().join("|")}`;
  return `job-url:${uid}:${crypto.createHash("sha1").update(lockSource).digest("hex")}`;
};
// Kısmi kaydedilen (bazı hedeflere yazılamayan) job'ların listesi: uygulama
// açılınca "şuraya kaydedilemedi — Tekrar dene" bandı buradan gelir.
const attentionKey = (uid) => `user:${uid}:job-attention`;
const MAX_ATTENTION = 10;
const MAX_TITLE_CHARS = 120;
// Kişisel 1 + Plus'ta en fazla 2 aile.
const MAX_TARGETS = 3;

const targetKey = (t) => (t.scope === "family" ? `family:${t.familyId}` : "personal");

// Panelden gelen kayıt hedefi. Alan yoksa (eski panel) kişisel. Aile hedefi
// burada yalnızca biçim olarak okunuyor; üyelik assertFamilyMember ile hem job
// kabulünde hem kayıttan hemen önce doğrulanıyor.
function parseTarget(body) {
  const { target, familyId } = body || {};
  if (target === undefined || target === null || target === "personal") return { scope: "personal" };
  if (target === "family" && typeof familyId === "string" && familyId) return { scope: "family", familyId };
  return null;
}

// Yeni panel: `targets: [{scope:"personal"} | {scope:"family", familyId}]`
// (aynı anda kişisel + aileler). Yoksa eski tek hedef alanları okunur.
// Kişisel hedef her zaman önce (Free sınırı hatası belirgin olsun).
function parseTargets(body) {
  const list = body?.targets;
  if (list === undefined || list === null) {
    const one = parseTarget(body);
    return one ? [one] : null;
  }
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_TARGETS) return null;
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (!raw || typeof raw !== "object" || typeof raw.scope !== "string") return null;
    const t = parseTarget({ target: raw.scope, familyId: raw.familyId });
    if (!t) return null;
    if (seen.has(targetKey(t))) continue;
    seen.add(targetKey(t));
    out.push(t);
  }
  return [...out.filter((t) => t.scope === "personal"), ...out.filter((t) => t.scope !== "personal")];
}

// Kullanıcının panelde verdiği ad (isteğe bağlı). Boşsa AI'ın başlığı kalır.
// undefined → "" ; geçersiz tür → null (400).
export function parseTitleOverride(value) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return null;
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TITLE_CHARS);
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
      const next = [recipe, ...list];
      // Grup 5 (B3): /api/data ile aynı kova tavanı (büyüten yazım aşamaz).
      checkBucketSize("recipes", JSON.stringify(next), JSON.stringify(list), next.length, list.length);
      return next;
    },
  });
}

function freeLimitError() {
  const err = new Error(LIMIT_MESSAGE);
  err.code = FREE_LIMIT_ERROR_CODE;
  return err;
}

// Tek bir hedefe yazım. Aile kopyası bağımsızdır: asıl kimlikten türetilmiş
// kendi kimliğiyle yazılır (shared/recipeIds.js); tekrar yazımda aynı kimlik
// üretildiği için hiçbir şey değişmez (kopya çoğalmaz).
// Aile: Plus + gerçek üyelik her yazımdan hemen önce yeniden doğrulanır;
// başarısızsa kişisel listeye ASLA düşülmez. Kişisel: Free sınırı (taşınan
// misafirin tarifinde taşımadaki gibi uygulanmaz).
async function saveRecipeToTarget({ uid, ownerUid, recipe, target }) {
  if (target.scope === "family") {
    await assertFamilyMember(ownerUid, target.familyId);
    await addRecipeToList(familyRecipesKey(target.familyId), recipeForFamily(recipe, target.familyId));
    return;
  }
  if (ownerUid !== uid) {
    await addRecipeToList(recipesKey(ownerUid), recipe);
    return;
  }
  const profile = await getProfile(uid);
  await addRecipeToList(recipesKey(uid), recipe, (list) => {
    if (!profile.isPlus && list.length >= FREE_RECIPE_LIMIT) throw freeLimitError();
  });
}

// Her hedef ayrı denenir; sonuç hedef hedef döner (kişisel önce, aileler sırayla).
// Hiçbir hata dışarı fırlatılmaz.
async function saveRecipeToTargets({ uid, ownerUid, recipe, targets }) {
  const results = [];
  for (const target of targets) {
    try {
      await saveRecipeToTarget({ uid, ownerUid, recipe, target });
      results.push({ ...target, status: "saved" });
    } catch (e) {
      results.push({ ...target, status: "failed", error: e.message || "Kaydedilemedi.", ...(e.code ? { code: e.code } : {}) });
    }
  }
  return results;
}

const failedTargetsOf = (results) => (results || []).filter((r) => r.status !== "saved");
const plainTarget = (r) => (r.scope === "family" ? { scope: "family", familyId: r.familyId } : { scope: "personal" });
// Bildirimin/job kaydının gösterdiği kopya: kişisele yazıldıysa o, değilse ilk aile kopyası.
function primaryRecipeId(baseId, results) {
  const saved = (results || []).filter((r) => r.status === "saved");
  if (!saved.length || saved.some((r) => r.scope === "personal")) return baseId;
  return familyCopyId(baseId, saved[0].familyId);
}

async function markAttention(uid, jobId) {
  await redisCommand(["HSET", attentionKey(uid), jobId, String(Date.now())]);
  await redisCommand(["EXPIRE", attentionKey(uid), String(JOB_TTL)]).catch(() => {});
}

async function clearAttention(uid, jobId) {
  await redisCommand(["HDEL", attentionKey(uid), jobId]).catch(() => {});
}

function hashEntries(raw) {
  if (Array.isArray(raw)) {
    const out = [];
    for (let i = 0; i + 1 < raw.length; i += 2) out.push([String(raw[i]), Number(raw[i + 1]) || 0]);
    return out;
  }
  if (raw && typeof raw === "object") return Object.entries(raw).map(([k, v]) => [k, Number(v) || 0]);
  return [];
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

// Tarifin yazılacağı hesap. Hesap silindiyse tarif yazılmaz (accountDeletedError).
// Grup 5: misafir hesabı mevcut bir hesaba taşınırken dondurulur (aynı "silindi"
// işareti); misafirken başlatılmış job'un tarifi o zaman atılmaz, verinin
// taşındığı hesaba yazılır (guest-merge:moved:<misafir>).
async function redirectTargetOf(uid) {
  const moved = await mergeRedirectTarget(uid).catch(() => null);
  if (!moved || (await isAccountDeleted(moved).catch(() => true))) return null;
  return moved;
}

async function recipeOwnerFor(uid) {
  if (!(await isAccountDeleted(uid))) return uid;
  const moved = await redirectTargetOf(uid);
  if (moved) return moved;
  throw accountDeletedError();
}

// release: eşzamanlılık kirası (aiGuard). Job hangi yoldan biterse bitsin bırakılıyor.
async function processRecipeJob({ release, ...job }) {
  try {
    await runRecipeJob(job);
  } finally {
    await release().catch(() => {});
  }
}

async function runRecipeJob({ uid, jobId, sourceUrl, caption, category, addedBy, language, lockKey, targets, title }) {
  const startedAt = Date.now();
  const timings = {};
  let recipe = null;
  let saveResults = null;
  let transcriptMeta = null;
  let ownerUid = uid;

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
    const { recipe: parsed, usage, stopReason, model: extractModel } = await extractRecipeFromCaption({
      link: sourceUrl,
      caption: recipeText,
      language,
      timeoutMs: claudeTimeout,
    });
    timings.claude = Date.now() - t;
    logStep(jobId, "claude", timings.claude, { model: extractModel, inputTokens: usage?.input_tokens, outputTokens: usage?.output_tokens, stopReason });
    timings.extractModel = extractModel;

    // Job sürerken hesap silinmiş olabilir: silinen hesaba tarif yazılmıyor.
    // Misafir başka bir hesaba taşındıysa tarif o hesaba yazılıyor.
    ownerUid = await recipeOwnerFor(uid);

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
    // Kullanıcının panelde verdiği ad AI'ın başlığının yerine geçer (yeni AI çağrısı yok).
    if (title) recipe.title = title;
    // Job kuyruktayken Plus kapanmış ya da aileden çıkılmış olabilir: her hedef
    // yazımdan önce yeniden doğrulanıyor. Başarısız aile hedefi kişisel listeye
    // düşmez; diğer hedefler yine de yazılır.
    saveResults = await saveRecipeToTargets({ uid, ownerUid, recipe, targets });
    timings.save = Date.now() - t;
    logStep(jobId, "save", timings.save, { targets: saveResults.map((r) => `${targetKey(r)}:${r.status}`) });
    if (!saveResults.some((r) => r.status === "saved")) {
      const first = saveResults[0];
      const err = new Error(first.error);
      if (first.code) err.code = first.code;
      throw err;
    }
  } catch (e) {
    timings.total = Date.now() - startedAt;
    const serviceSide = isServiceSideError(e);
    if (serviceSide) {
      e.notifyBody = SERVICE_UNAVAILABLE_MESSAGE;
      e.notifyKind = "service";
    }
    // Tarif çıkarıldı ama hiçbir hedefe yazılamadı (Free sınırı, aile erişimi,
    // Redis): bildirim "videodan çıkarılamadı" demez ve linki taşımaz — dokununca
    // uygulama "Yeni Tarif Çıkar"ı açıp ikinci bir AI çağrısına yönlendirmesin;
    // uygulamadaki "Tekrar dene" bandı saklanan tarifi yazar.
    const saveFailedOnly = !!(recipe && saveResults);
    if (saveFailedOnly && !serviceSide) e.notifyKind = "save";
    const failedNotification = {
      title: notifyText(language).failedTitle,
      body: failedBody(language, e.notifyKind),
      data: saveFailedOnly ? { type: "recipe_failed", saveFailed: "1" } : { type: "recipe_failed", link: sourceUrl },
    };
    if (e.accountDeleted || (await isAccountDeleted(uid).catch(() => false))) {
      // e.accountDeleted: recipeOwnerFor hesabı silinmiş ve hedefsiz buldu (gerçek silme).
      // Aksi hâlde misafir bir hesaba taşınmış olabilir: başarılı yoldaki gibi misafirin
      // job kaydı atılır, ama kullanıcı gelmeyecek tarifi beklemesin diye başarısızlık
      // bildirimi hedefe gider. Hedef yoksa / silinmişse / okunamazsa (null) bugünkü gibi
      // sessizce atılır.
      const moved = e.accountDeleted ? null : await redirectTargetOf(uid);
      if (!moved) {
        await discardJobOfDeletedAccount(uid, jobId, lockKey);
        return;
      }
      logStep(jobId, "failed-redirected", timings.total, { error: e.message, kind: e.kind, transcriptMeta });
      await redisDel(jobKey(uid, jobId)).catch(() => {});
      await redisDel(lockKey).catch(() => {});
      await waitForSharePanelToClose(startedAt);
      const t = Date.now();
      const notify = await notifyUserDevices(moved, failedNotification, { dedupeKey: `${jobId}:failed` }).catch((err) => ({
        sent: 0,
        attempted: 0,
        error: err.message,
      }));
      logStep(jobId, "fcm", Date.now() - t, { sent: notify.sent, attempted: notify.attempted, kind: "failed-redirected" });
      return;
    }
    logStep(jobId, "failed", timings.total, { error: e.message, kind: e.kind, transcriptMeta });
    // Tarif çıkarıldı ama hiçbir hedefe yazılamadı: tarif job kaydında saklanır,
    // uygulamadaki "Tekrar dene" AI'a yeniden gitmeden aynı tarifi (aynı id) yazar.
    const keepRecipe = saveFailedOnly;
    await patchJob(uid, jobId, {
      status: "failed",
      error: e.message || "Bilinmeyen hata",
      // Makine-okunur neden: "ai_unavailable" = servis tarafı (kredi/anahtar/yoğunluk), içerikle ilgisiz.
      ...(serviceSide ? { errorCode: "ai_unavailable" } : e.code ? { errorCode: e.code } : {}),
      // recipeId yalnızca KAYDEDİLMİŞ tarifi gösterir; burada null kalır.
      ...(keepRecipe ? { recipe, recipeTitle: recipe.title, targets: saveResults } : {}),
      timings,
      transcriptMeta,
    }).catch(() => {});
    if (keepRecipe) await markAttention(uid, jobId).catch(() => {});
    await redisDel(lockKey).catch(() => {});
    await waitForSharePanelToClose(startedAt);
    const t = Date.now();
    const notify = await notifyUserDevices(uid, failedNotification, { dedupeKey: `${jobId}:failed` }).catch((err) => ({ sent: 0, attempted: 0, error: err.message }));
    // Başarısız job'da da bildirim sonucu kayda yazılıyor (önceden yalnızca
    // başarılı yolda vardı; "bildirim geldi mi" sorusu yanıtsız kalıyordu).
    logStep(jobId, "fcm", Date.now() - t, { sent: notify.sent, attempted: notify.attempted, kind: "failed" });
    await patchJob(uid, jobId, { notify }).catch(() => {});
    return;
  }

  // Kontrol ile kayıt arasında hesap silindiyse az önce yazılan tarif geri
  // alınıyor (silme bu anahtarları çoktan temizlemiş olabilir).
  const savedTargets = saveResults.filter((r) => r.status === "saved").map(plainTarget);
  const failedTargets = failedTargetsOf(saveResults);
  if (ownerUid === uid && (await isAccountDeleted(uid).catch(() => false))) {
    const moved = await redirectTargetOf(uid);
    if (moved) {
      // Misafir tam bu arada taşımaya bağlandı: taşımanın tarif adımı bu tarifi
      // görmemiş olabilir. Kişisel tarif hedefe de yazılır (id ile tekil; aynı
      // içerik iki kez eklenmez). Aile tarifi ailenin listesinde kalır (aile devredilir).
      try {
        if (savedTargets.some((t) => t.scope === "personal")) await addRecipeToList(recipesKey(moved), recipe);
        ownerUid = moved;
        // Taşıma çoktan bittiyse misafir anahtarına az önce yazılan kopya kalmasın.
        if (!(await isGuestBound(uid).catch(() => true))) {
          for (const t of savedTargets) await removeRecipeOfDeletedAccount(uid, recipe.id, t).catch(() => {});
        }
      } catch (e) {
        logStep(jobId, "redirect-failed", 0, { error: e.message });
      }
    }
    if (ownerUid === uid) {
      for (const t of savedTargets) await removeRecipeOfDeletedAccount(uid, recipe.id, t).catch(() => {});
      await discardJobOfDeletedAccount(uid, jobId, lockKey);
      return;
    }
  }

  const redirected = ownerUid !== uid;
  if (redirected) {
    // Misafirin job kaydı taşıma temizliğiyle siliniyor; yeniden oluşturulmaz.
    logStep(jobId, "redirected-to-merge-target", 0);
    await redisDel(jobKey(uid, jobId)).catch(() => {});
    await redisDel(lockKey).catch(() => {});
  } else {
    // Tarif kaydedildi: buradan sonrası başarısız olsa bile job "failed" olmamalı.
    // Bazı hedeflere yazılamadıysa tarif job kaydında kalır ("Tekrar dene" AI'sız
    // aynı tarifi yazar) ve job uygulamadaki uyarı listesine girer.
    await patchJob(uid, jobId, {
      status: "completed",
      recipeId: primaryRecipeId(recipe.id, saveResults),
      recipeTitle: recipe.title,
      targets: saveResults,
      ...(failedTargets.length ? { recipe } : {}),
      completedAt: Date.now(),
      timings,
      transcriptMeta,
    }).catch(() => {});
    if (failedTargets.length) await markAttention(uid, jobId).catch(() => {});
  }

  await waitForSharePanelToClose(startedAt);
  const t = Date.now();
  const personalSaved = savedTargets.some((s) => s.scope === "personal");
  const savedFamilyIds = savedTargets.filter((s) => s.scope === "family").map((s) => s.familyId);
  const text = notifyText(language);
  const notify = await notifyUserDevices(ownerUid, {
    title: text.readyTitle,
    body: failedTargets.length ? `${text.readyBody(recipe.title)} ${text.partialSuffix}` : text.readyBody(recipe.title),
    // Aile tarifinde uygulama doğru listeyi tazeleyebilsin diye kapsam da
    // gidiyor; kişisel bildirimin payload'ı eskisiyle aynı. Birden fazla aileye
    // yazıldıysa familyIds hepsini taşır (FCM data değerleri metin).
    data: {
      type: "recipe_ready",
      recipeId: primaryRecipeId(recipe.id, saveResults),
      ...(!personalSaved && savedFamilyIds.length ? { scope: "family", familyId: savedFamilyIds[0] } : {}),
      ...(savedFamilyIds.length && (personalSaved || savedFamilyIds.length > 1) ? { familyIds: savedFamilyIds.join(",") } : {}),
    },
  }, { dedupeKey: `${jobId}:ready` }).catch((e) => ({ sent: 0, attempted: 0, error: e.message }));
  timings.fcm = Date.now() - t;
  timings.total = Date.now() - startedAt;
  logStep(jobId, "fcm", timings.fcm, { sent: notify.sent, attempted: notify.attempted });
  logStep(jobId, "done", timings.total);
  if (!redirected) await patchJob(uid, jobId, { timings, notify }).catch(() => {});
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
  const targets = parseTargets(req.body);
  if (!targets) {
    res.status(400).json({ error: "Geçersiz kayıt hedefi." });
    return;
  }
  const title = parseTitleOverride(req.body?.title);
  if (title === null) {
    res.status(400).json({ error: "Geçersiz tarif adı." });
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
  // Sabit kategori ya da kullanıcının özel kategorisi (temiz ad; bkz. shared/categories.js).
  if (!isAcceptableRecipeCategory(category)) {
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

  // Yetkisiz/yanlış aile: job hiç açılmıyor, hata dönüyor (AI'a gidilmez).
  // Kişisel listeye sessizce düşürülmüyor.
  for (const target of targets) {
    if (target.scope !== "family") continue;
    try {
      await assertFamilyMember(uid, target.familyId);
    } catch (e) {
      res.status(e.status || 403).json({ error: e.message, familyId: target.familyId });
      return;
    }
  }

  const profile = await getProfile(uid);
  if (targets.some((t) => t.scope === "personal") && !profile.isPlus) {
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
    const lockKey = urlLockKey(uid, url, targets);
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
      // scope/familyId: eski tek hedef alanları (ilk hedef); tam liste `targets`.
      scope: targets[0].scope,
      familyId: targets[0].scope === "family" ? targets[0].familyId : null,
      targets: targets.map((t) => ({ ...t, status: "pending" })),
      ...(title ? { titleOverride: title } : {}),
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
        targets,
        title,
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

// ---------------------------------------------------------------------------
// Kısmi kayıt: "Tekrar dene" / "Kapat" (uygulama içi bant)
//
// Job bazı hedeflere yazamadıysa tarif job kaydında saklı. Tekrar deneme AI'a
// gitmez; aynı tarif nesnesini (aynı id) yalnızca başarısız hedeflere yazar.
// Zaten yazılmış hedefe tekrar yazım hiçbir şey değiştirmez (kopya oluşmaz).
// Aile üyeliği, Plus ve Free sınırı ilk yazımdaki gibi yeniden denetlenir.

const JOB_ID_RE = /^[\w-]{6,64}$/;

function attentionSummary(job) {
  return {
    id: job.id,
    recipeId: job.recipeId || null,
    recipeTitle: job.recipeTitle || job.recipe?.title || "",
    status: job.status,
    createdAt: job.createdAt || 0,
    targets: (job.targets || []).map((t) => ({
      scope: t.scope,
      familyId: t.scope === "family" ? t.familyId : null,
      status: t.status,
      ...(t.error ? { error: t.error } : {}),
      ...(t.code ? { code: t.code } : {}),
    })),
  };
}

const needsAttention = (job) => !!(job && job.recipe && failedTargetsOf(job.targets).length);

async function listAttention(uid) {
  const entries = hashEntries(await redisCommand(["HGETALL", attentionKey(uid)]))
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_ATTENTION);
  const out = [];
  for (const [jobId] of entries) {
    const job = await redisGetJSON(jobKey(uid, jobId), null);
    if (needsAttention(job)) out.push(attentionSummary(job));
    else await clearAttention(uid, jobId);
  }
  return out;
}

async function readJobForAction(req, res, uid) {
  const jobId = req.body?.jobId;
  if (typeof jobId !== "string" || !JOB_ID_RE.test(jobId)) {
    res.status(400).json({ error: "Geçersiz istek." });
    return null;
  }
  const job = await redisGetJSON(jobKey(uid, jobId), null);
  if (!job) {
    await clearAttention(uid, jobId);
    res.status(404).json({ error: "Böyle bir iş bulunamadı." });
    return null;
  }
  return job;
}

async function handleRetry(req, res, user) {
  const uid = user.uid;
  const job = await readJobForAction(req, res, uid);
  if (!job) return;
  if (!needsAttention(job)) {
    await clearAttention(uid, job.id);
    res.status(200).json({ job: attentionSummary(job) });
    return;
  }
  try {
    await checkDataWriteLimit({ uid, isAnonymous: !!user.isAnonymous, ip: clientIp(req) });
  } catch (e) {
    if (sendGuardError(res, e)) return;
    throw e;
  }
  const failed = failedTargetsOf(job.targets).map(plainTarget);
  const retried = await saveRecipeToTargets({ uid, ownerUid: uid, recipe: job.recipe, targets: failed });
  const byKey = new Map(retried.map((r) => [targetKey(r), r]));
  const targets = job.targets.map((t) => byKey.get(targetKey(t)) || t);
  const anySaved = targets.some((t) => t.status === "saved");
  const stillFailed = failedTargetsOf(targets).length > 0;
  const next = await patchJob(uid, job.id, {
    targets,
    ...(anySaved ? { status: "completed", recipeId: primaryRecipeId(job.recipe.id, targets), error: null, errorCode: null, completedAt: job.completedAt || Date.now() } : {}),
    // Her şey yazıldıysa saklanan tarif kopyasına gerek kalmadı.
    ...(stillFailed ? {} : { recipe: null }),
  });
  if (!stillFailed) await clearAttention(uid, job.id);
  logStep(job.id, "retry", 0, { targets: targets.map((t) => `${targetKey(t)}:${t.status}`) });
  res.status(200).json({ job: attentionSummary(next) });
}

async function handleDismiss(req, res, user) {
  const uid = user.uid;
  const job = await readJobForAction(req, res, uid);
  if (!job) return;
  await clearAttention(uid, job.id);
  if (job.recipe) await patchJob(uid, job.id, { recipe: null });
  res.status(200).json({ ok: true });
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
      const action = req.body?.action;
      if (action === "retry") {
        await handleRetry(req, res, user);
        return;
      }
      if (action === "dismiss") {
        await handleDismiss(req, res, user);
        return;
      }
      if (action !== undefined) {
        res.status(400).json({ error: "Geçersiz istek." });
        return;
      }
      await handlePost(req, res, user);
      return;
    }
    if (req.method === "GET") {
      if (req.query.attention) {
        res.status(200).json({ jobs: await listAttention(user.uid) });
        return;
      }
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
    res.status(e.status || 502).json({ error: e.message || "İstek tamamlanamadı.", ...(e.code ? { code: e.code } : {}) });
  }
}
