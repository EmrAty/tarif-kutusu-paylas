import crypto from "node:crypto";
import { redisCommand } from "./redis.js";

// GET /api/profile?admin=stats — yönetim paneli için toplu, kişisel veri içermeyen sayılar.
// Ayrı bir dosya/uç değil: Vercel Hobby planı en fazla 12 sunucu fonksiyonuna izin
// veriyor, bu yüzden profile.js bu isteği kullanıcı doğrulamasından önce buraya yönlendiriyor.
//
// Yalnızca ADMIN_STATS_KEY ortam değişkeni tanımlıysa çalışır; istek
// `Authorization: Bearer <ADMIN_STATS_KEY>` taşımalı. Anahtar tanımlı değilse ya
// da eşleşmezse 401 döner (Firebase kullanıcı token'ı bu uca hiçbir koşulda girmez). Yanıtta uid, e-posta, tarif adı ya da link yok —
// yalnızca sayılar ve günlük toplamlar.
//
// Tarif çıkarma akışlarına (extract, recipe-jobs) hiçbir şey eklenmedi; buradaki
// her sayı zaten Redis'te duran veriden okunuyor:
//   - kullanıcı/Plus: `user:<uid>:profile`, `user:<uid>:recipes`
//   - tarif: kova içindeki `createdAt` (Europe/Istanbul gününe göre)
//   - aile: `family:<id>:meta`, `family:<id>:recipes`
//   - paylaşım işleri: `job:<uid>:<jobId>` (7 gün TTL)
//   - AI çağrısı: aiGuard'ın global günlük sayacı `rl:global:ai:86400:<gün>`
// Job kayıtları 7 günde silindiği ve AI sayacı yalnızca bugünü tuttuğu için, her
// çağrıda günlük özet `stats:day:<YYYY-MM-DD>` anahtarına yazılır (400 gün TTL);
// geçmiş grafikler buradan okunur. Uç saatte bir çağrılınca hiçbir gün kaçmaz.

const DAY_MS = 86_400_000;
const TZ_OFFSET_MS = 3 * 3_600_000; // Europe/Istanbul, 2016'dan beri sabit UTC+3
const STATS_TTL = 400 * 86_400;
const HISTORY_DAYS = 60;
const RECIPE_SERIES_DAYS = 30;
const MAX_KEYS = 20_000;
const CHUNK = 50;

export const statsDayKey = (day) => `stats:day:${day}`;
export const localDay = (ms) => new Date(ms + TZ_OFFSET_MS).toISOString().slice(0, 10);
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

function authorized(req, secret) {
  const h = req.headers?.authorization || req.headers?.Authorization || "";
  const given = String(h).startsWith("Bearer ") ? String(h).slice(7) : "";
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(secret).digest();
  return given.length > 0 && crypto.timingSafeEqual(a, b);
}

async function scanAll(pattern) {
  const keys = [];
  let cursor = "0";
  let truncated = false;
  do {
    const result = await redisCommand(["SCAN", cursor, "MATCH", pattern, "COUNT", "1000"]);
    cursor = String(result?.[0] ?? "0");
    for (const k of result?.[1] || []) keys.push(String(k));
    if (keys.length >= MAX_KEYS) {
      truncated = true;
      break;
    }
  } while (cursor !== "0");
  return { keys: [...new Set(keys)], truncated };
}

async function mget(keys) {
  const out = [];
  for (let i = 0; i < keys.length; i += CHUNK) {
    const part = keys.slice(i, i + CHUNK);
    const values = part.length ? await redisCommand(["MGET", ...part]) : [];
    for (let j = 0; j < part.length; j++) out.push(values?.[j] ?? null);
  }
  return out;
}

function parseJSON(raw, fallback) {
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

const median = (arr) => {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

// Bir job kaydını günlük özete katar.
function addJob(agg, job) {
  agg.jobs += 1;
  if (job.status === "completed") agg.ok += 1;
  else if (job.status === "failed") {
    agg.failed += 1;
    if (job.errorCode === "ai_unavailable") agg.aiUnavailable += 1;
  } else agg.pending += 1;
  const method = job.transcriptMeta?.method;
  if (!job.transcriptMeta) agg.viaCaption += 1;
  else if (method === "subtitle") agg.viaSubtitle += 1;
  else if (method === "audio" || method === "transcribe") agg.viaAudio += 1;
  else agg.viaOther += 1;
  const total = Number(job.timings?.total);
  if (job.status === "completed" && Number.isFinite(total)) agg.durations.push(total);
  const claude = Number(job.timings?.claude);
  if (Number.isFinite(claude)) agg.claudeDurations.push(claude);
}

const emptyJobAgg = () => ({
  jobs: 0,
  ok: 0,
  failed: 0,
  aiUnavailable: 0,
  pending: 0,
  viaCaption: 0,
  viaSubtitle: 0,
  viaAudio: 0,
  viaOther: 0,
  durations: [],
  claudeDurations: [],
});

function summarizeJobs(agg) {
  const { durations, claudeDurations, ...rest } = agg;
  const finished = rest.ok + rest.failed;
  return {
    ...rest,
    successRate: finished ? Math.round((rest.ok / finished) * 1000) / 10 : null,
    medianSeconds: durations.length ? Math.round(median(durations) / 100) / 10 : null,
    medianClaudeSeconds: claudeDurations.length ? Math.round(median(claudeDurations) / 100) / 10 : null,
  };
}

export async function collectStats({ now = Date.now() } = {}) {
  const today = localDay(now);
  let truncated = false;

  // ---- kullanıcılar, Plus, kişisel tarifler ----
  const userScan = await scanAll("user:*");
  truncated ||= userScan.truncated;
  const users = new Map(); // uid -> { profile?, recipes?, merged? }
  for (const key of userScan.keys) {
    const m = /^user:([^:]+):(profile|recipes|mergedInto)$/.exec(key);
    if (!m) continue;
    const entry = users.get(m[1]) || {};
    entry[m[2]] = key;
    users.set(m[1], entry);
  }
  // Başka hesaba taşınmış (donmuş) misafirler sayılmaz.
  for (const [uid, e] of users) if (e.mergedInto) users.delete(uid);
  const uids = [...users.keys()].filter((uid) => users.get(uid).profile || users.get(uid).recipes);

  const profileKeys = uids.filter((u) => users.get(u).profile).map((u) => users.get(u).profile);
  const profiles = (await mget(profileKeys)).map((raw) => parseJSON(raw, null));
  const plusUsers = profiles.filter((p) => p && p.isPlus === true).length;

  const recipeOwners = uids.filter((u) => users.get(u).recipes);
  const recipeLists = (await mget(recipeOwners.map((u) => users.get(u).recipes))).map((raw) => parseJSON(raw, []));

  const seriesStart = now - (RECIPE_SERIES_DAYS - 1) * DAY_MS;
  const recipesByDay = new Map();
  const newByDay = new Map(); // tüm günler (kalıcı özete yazmak için)
  let personalRecipes = 0;
  let recipesToday = 0;
  let recipes7d = 0;
  const active7d = new Set();
  const activeByDay = new Map(); // gün -> o gün tarif ekleyen kişisel hesaplar
  const countRecipe = (r, owner) => {
    const created = Number(r?.createdAt);
    if (!Number.isFinite(created) || created <= 0) return;
    const day = localDay(created);
    newByDay.set(day, (newByDay.get(day) || 0) + 1);
    if (owner) {
      if (!activeByDay.has(day)) activeByDay.set(day, new Set());
      activeByDay.get(day).add(owner);
    }
    if (created >= seriesStart - DAY_MS) recipesByDay.set(day, (recipesByDay.get(day) || 0) + 1);
    if (day === today) recipesToday += 1;
    if (now - created < 7 * DAY_MS) {
      recipes7d += 1;
      if (owner) active7d.add(owner);
    }
  };
  recipeLists.forEach((list, i) => {
    if (!Array.isArray(list)) return;
    personalRecipes += list.length;
    for (const r of list) countRecipe(r, recipeOwners[i]);
  });

  // ---- aileler ----
  const familyScan = await scanAll("family:*:meta");
  truncated ||= familyScan.truncated;
  const familyIds = familyScan.keys.map((k) => /^family:([^:]+):meta$/.exec(k)?.[1]).filter(Boolean);
  const familyLists = (await mget(familyIds.map((id) => `family:${id}:recipes`))).map((raw) => parseJSON(raw, []));
  let familyRecipes = 0;
  for (const list of familyLists) {
    if (!Array.isArray(list)) continue;
    familyRecipes += list.length;
    for (const r of list) countRecipe(r, null);
  }

  // ---- paylaşım işleri (son 7 gün) ----
  const jobScan = await scanAll("job:*");
  truncated ||= jobScan.truncated;
  const jobs = (await mget(jobScan.keys)).map((raw) => parseJSON(raw, null)).filter((j) => j && j.createdAt);
  const jobsByDay = new Map();
  const jobs7d = emptyJobAgg();
  for (const job of jobs) {
    const day = localDay(Number(job.createdAt));
    if (!jobsByDay.has(day)) jobsByDay.set(day, emptyJobAgg());
    addJob(jobsByDay.get(day), job);
    if (now - Number(job.createdAt) < 7 * DAY_MS) addJob(jobs7d, job);
  }

  // ---- AI çağrıları (bugün, UTC günü) ----
  const aiBucket = Math.floor(now / DAY_MS);
  const aiToday = Number(await redisCommand(["GET", `rl:global:ai:86400:${aiBucket}`])) || 0;
  const aiDay = utcDay(aiBucket * DAY_MS);

  // ---- kalıcı günlük özet ----
  // Job'lar 7 gün tutulduğu için yalnızca son 6 günün job özeti tam; daha eski
  // günlerin kayıtlı özeti ezilmez. AI sayısı ve yeni tarif sayısı büyüyerek yazılır.
  const historyDays = [];
  for (let i = HISTORY_DAYS - 1; i >= 0; i--) historyDays.push(localDay(now - i * DAY_MS));
  const storedRaw = await mget(historyDays.map(statsDayKey));
  const stored = new Map(historyDays.map((d, i) => [d, parseJSON(storedRaw[i], null)]));
  const jobsCompleteFrom = localDay(now - 6 * DAY_MS);
  const writes = [];
  for (const day of historyDays) {
    const prev = stored.get(day) || {};
    const next = { ...prev };
    if (day >= jobsCompleteFrom) {
      const agg = jobsByDay.get(day);
      if (agg) next.jobs = summarizeJobs(agg);
      else if (!prev.jobs) next.jobs = summarizeJobs(emptyJobAgg());
    }
    if (day === aiDay) next.aiCalls = Math.max(Number(prev.aiCalls) || 0, aiToday);
    const created = newByDay.get(day) || 0;
    next.newRecipes = Math.max(Number(prev.newRecipes) || 0, created);
    if (JSON.stringify(next) !== JSON.stringify(prev) && (prev.jobs || next.jobs || next.aiCalls || next.newRecipes)) {
      stored.set(day, next);
      writes.push(redisCommand(["SET", statsDayKey(day), JSON.stringify(next), "EX", String(STATS_TTL)]));
    }
  }
  await Promise.all(writes);

  const daily = historyDays.map((day) => {
    const s = stored.get(day) || {};
    return {
      date: day,
      newRecipes: s.newRecipes ?? 0,
      // O gün tarif ekleyen hesap sayısı; silinen tarifler sayılmaz (yalnızca bugünkü veriden).
      activeUsers: activeByDay.get(day)?.size ?? 0,
      aiCalls: s.aiCalls ?? null,
      jobs: s.jobs?.jobs ?? null,
      jobsOk: s.jobs?.ok ?? null,
      jobsFailed: s.jobs?.failed ?? null,
      viaCaption: s.jobs?.viaCaption ?? null,
      viaSubtitle: s.jobs?.viaSubtitle ?? null,
      viaAudio: s.jobs?.viaAudio ?? null,
      medianSeconds: s.jobs?.medianSeconds ?? null,
    };
  });

  return {
    generatedAt: new Date(now).toISOString(),
    timezone: "Europe/Istanbul",
    truncated,
    usage: {
      users: uids.length,
      plusUsers,
      families: familyIds.length,
      personalRecipes,
      familyRecipes,
      recipesToday,
      recipes7d,
      activeUsers7d: active7d.size,
      aiCallsToday: aiToday,
    },
    jobs7d: summarizeJobs(jobs7d),
    daily,
  };
}

export async function adminStatsHandler(req, res) {
  const secret = process.env.ADMIN_STATS_KEY;
  if (!secret || secret.length < 24 || !authorized(req, secret)) {
    res.status(401).json({ error: "Yetkisiz." });
    return;
  }
  if (req.method !== "GET") {
    res.status(405).json({ error: "Yalnızca GET." });
    return;
  }
  try {
    res.status(200).json(await collectStats());
  } catch (e) {
    console.error(JSON.stringify({ tag: "admin-stats", error: e?.message, detail: e?.detail }));
    res.status(e.status || 502).json({ error: "İstatistikler okunamadı." });
  }
}
