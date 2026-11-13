import crypto from "node:crypto";
import { redisPipeline, redisCommand } from "./redis.js";
import {
  RATE_LIMITS,
  ANON_IP_LIMITS,
  ANON_IP_CAPTION_LIMITS,
  DATA_WRITE_LIMITS,
  ANON_IP_DATA_WRITE_LIMITS,
  CONCURRENCY,
  ACTION_POOL,
  GLOBAL_ACTIONS,
  globalLimits,
  userAiLimits,
  killSwitchOn,
} from "./abusePolicy.js";

// AI uçlarının ortak koruması: hız sınırı (UID + misafirde IP), eşzamanlılık
// kirası ve global güvenlik tavanı. Sınırlar abusePolicy.js'te.
//
// Redis'e erişilemezse istek GEÇİRİLİR (fail-open): koruma katmanının bir
// arızası gerçek kullanıcıların tarif çıkarmasını durdurmamalı. Acil kapatma
// anahtarı (AI_KILL_SWITCH) Redis'ten bağımsız çalışır.

export const GUARD_CODES = {
  rateLimited: "rate_limited",
  tooManyInFlight: "too_many_in_flight",
  capacity: "ai_capacity",
};

export class GuardError extends Error {
  constructor(status, code, message, retryAfter) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

const MESSAGES = {
  rate_limited: "Kısa sürede çok fazla istek geldi. Biraz bekleyip tekrar dene.",
  too_many_in_flight: "Şu anda hazırlanan tariflerin var. Bitmelerini bekleyip tekrar dene.",
  ai_capacity: "Tarif servisi şu anda çok yoğun. Lütfen biraz sonra tekrar dene.",
};

let clock = () => Date.now();
// Testler pencere sınırlarına denk gelip dalgalanmasın diye saati sabitleyebilir.
export function __setClockForTests(fn) {
  clock = fn || (() => Date.now());
}

let warnedUnavailable = false;
function warnUnavailable(e) {
  if (warnedUnavailable) return;
  warnedUnavailable = true;
  console.warn(JSON.stringify({ tag: "ai-guard", warning: "redis unavailable, failing open", error: e?.message }));
}

// Vercel x-real-ip / x-forwarded-for başlıklarını kendisi yazar (istemcinin
// gönderdiği değerin üzerine), bu yüzden burada güvenilir.
export function clientIp(req) {
  const h = req?.headers || {};
  const pick = (v) => (Array.isArray(v) ? v[0] : v);
  const raw = pick(h["x-real-ip"]) || pick(h["x-vercel-forwarded-for"]) || pick(h["x-forwarded-for"]) || "";
  return String(raw).split(",")[0].trim().slice(0, 64);
}

const hashId = (value) => crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 24);

// Sabit pencereli sayaçlar: her pencere için INCR + EXPIRE tek pipeline'da.
// Aşılan ilk pencere için kalan süre (sn) döner; aşılmadıysa null.
async function hitWindows(prefix, windows, now) {
  const commands = [];
  const keys = windows.map((w) => {
    const bucket = Math.floor(now / 1000 / w.seconds);
    const key = `${prefix}:${w.seconds}:${bucket}`;
    commands.push(["INCR", key], ["EXPIRE", key, String(w.seconds + 5)]);
    return { key, bucket, ...w };
  });
  const results = await redisPipeline(commands);
  for (let i = 0; i < keys.length; i++) {
    const count = results[i * 2];
    if (count instanceof Error) throw count;
    if (Number(count) > keys[i].limit) {
      const windowEnd = (keys[i].bucket + 1) * keys[i].seconds;
      return Math.max(1, Math.ceil(windowEnd - now / 1000));
    }
  }
  return null;
}

export async function checkRateLimit({ action, uid, isAnonymous, ip }, { now = clock() } = {}) {
  const windows = RATE_LIMITS[action];
  if (!windows) throw new Error(`Bilinmeyen AI eylemi: ${action}`);
  try {
    const userWindows = windows.map((w) => ({ seconds: w.seconds, limit: isAnonymous ? w.anon : w.user }));
    let retryAfter = await hitWindows(`rl:${action}:u:${uid}`, userWindows, now);
    if (retryAfter == null && isAnonymous && ip) {
      const ipWindows = action === "caption" ? ANON_IP_CAPTION_LIMITS : ANON_IP_LIMITS;
      const ipScope = action === "caption" ? "caption" : "ai";
      retryAfter = await hitWindows(`rl:${ipScope}:ip:${hashId(ip)}`, ipWindows, now);
    }
    if (retryAfter != null) {
      throw new GuardError(429, GUARD_CODES.rateLimited, MESSAGES.rate_limited, retryAfter);
    }
  } catch (e) {
    if (e instanceof GuardError) throw e;
    warnUnavailable(e);
  }
}

// Veri yazımı hız sınırı (Grup 5 B3): aynı pencere altyapısı, ayrı anahtarlar.
// Redis'e ulaşılamazsa GEÇİRİLİR (fail-open): yazımın kendisi zaten Redis'e
// gidecek ve orada 502 alacak; koruma katmanı ayrıca bir arıza kaynağı olmasın.
export async function checkDataWriteLimit({ uid, isAnonymous, ip }, { now = clock() } = {}) {
  try {
    const windows = DATA_WRITE_LIMITS.map((w) => ({ seconds: w.seconds, limit: isAnonymous ? w.anon : w.user }));
    let retryAfter = await hitWindows(`rl:data-write:u:${uid}`, windows, now);
    if (retryAfter == null && isAnonymous && ip) retryAfter = await hitWindows(`rl:data-write:ip:${hashId(ip)}`, ANON_IP_DATA_WRITE_LIMITS, now);
    if (retryAfter != null) throw new GuardError(429, GUARD_CODES.rateLimited, MESSAGES.rate_limited, retryAfter);
  } catch (e) {
    if (e instanceof GuardError) throw e;
    warnUnavailable(e);
  }
}

export function assertKillSwitchOff() {
  if (killSwitchOn()) throw new GuardError(503, GUARD_CODES.capacity, MESSAGES.ai_capacity, 300);
}

// Sağlayıcı maliyet sayaçları: UID başına toplam AI tavanı + tüm sistemin global
// tavanı. Uç bazlı hız sayaçlarından (checkRateLimit) AYRI bir kavram: onlar
// denemeleri sayar (saldırı denemesi de sayılsın diye), bunlar yalnızca gerçekten
// sağlayıcıya (Anthropic/OpenAI) gitmek üzere kabul edilen işleri sayar.
// Bu yüzden her AI ucunda EN SON, sağlayıcı çağrısından hemen önce çağrılır:
// doğrulama, hız sınırı, eşzamanlılık ve girdi boyutu reddi bu sayaçlara hiç
// dokunmaz. Dört sayaç tek pipeline'da artırılır; herhangi biri aşılırsa dördü de
// geri alınır (DECR), yani reddedilen istek de sayaçta kalmaz. Yarışta bir istek
// fazladan reddedilebilir, fazladan kabul edilmez.
//
// Aşım: UID tavanı → 429 rate_limited (kullanıcı "biraz bekle" görür, kota değil),
// global tavan → 503 ai_capacity.
export async function reserveAiBudget({ uid, isAnonymous }, { now = clock() } = {}) {
  assertKillSwitchOff();
  const global = globalLimits();
  const user = userAiLimits(!!isAnonymous);
  const windows = [
    { scope: "user", prefix: `rl:user-ai:${uid}`, seconds: 3600, limit: user.hourly },
    { scope: "user", prefix: `rl:user-ai:${uid}`, seconds: 86400, limit: user.daily },
    { scope: "global", prefix: "rl:global:ai", seconds: 3600, limit: global.hourly },
    { scope: "global", prefix: "rl:global:ai", seconds: 86400, limit: global.daily },
  ].map((w) => {
    const bucket = Math.floor(now / 1000 / w.seconds);
    return { ...w, bucket, key: `${w.prefix}:${w.seconds}:${bucket}` };
  });
  let exceeded = null;
  try {
    const results = await redisPipeline(windows.flatMap((w) => [["INCR", w.key], ["EXPIRE", w.key, String(w.seconds + 5)]]));
    windows.forEach((w, i) => {
      const count = results[i * 2];
      if (count instanceof Error) throw count;
      if (Number(count) > w.limit && (!exceeded || (exceeded.scope === "user" && w.scope === "global"))) exceeded = w;
    });
    if (exceeded) await redisPipeline(windows.map((w) => ["DECR", w.key])).catch(() => {});
  } catch (e) {
    warnUnavailable(e);
    return;
  }
  if (!exceeded) return;
  const retryAfter = Math.max(1, Math.ceil((exceeded.bucket + 1) * exceeded.seconds - now / 1000));
  if (exceeded.scope === "global") {
    console.warn(JSON.stringify({ tag: "ai-guard", alert: "global AI ceiling reached", hourly: global.hourly, daily: global.daily }));
    throw new GuardError(503, GUARD_CODES.capacity, MESSAGES.ai_capacity, retryAfter);
  }
  console.warn(JSON.stringify({ tag: "ai-guard", alert: "per-user AI ceiling reached", uid: hashId(uid), window: exceeded.seconds }));
  throw new GuardError(429, GUARD_CODES.rateLimited, MESSAGES.rate_limited, retryAfter);
}

// Eşzamanlılık kirası: ZSET üyesi = kira kimliği, skor = bitiş zamanı (ms).
// Önce süresi geçen kiralar silinir, sonra eklenip sayılır; sınır aşıldıysa
// eklenen kira geri alınır. Dönen release() kirayı bırakır (iki kez çağrılabilir).
export async function acquireSlot({ pool, uid, isAnonymous }, { now = clock() } = {}) {
  const config = CONCURRENCY[pool];
  if (!config) throw new Error(`Bilinmeyen eşzamanlılık havuzu: ${pool}`);
  const limit = isAnonymous ? config.anon : config.user;
  const key = `ai:inflight:${pool}:${uid}`;
  const leaseId = `${now}-${crypto.randomBytes(6).toString("hex")}`;
  const expiresAt = now + config.ttlSeconds * 1000;
  let acquired = false;
  try {
    const results = await redisPipeline([
      ["ZREMRANGEBYSCORE", key, "-inf", String(now)],
      ["ZADD", key, String(expiresAt), leaseId],
      ["ZCARD", key],
      ["EXPIRE", key, String(config.ttlSeconds + 30)],
    ]);
    const count = results[2];
    if (count instanceof Error) throw count;
    if (Number(count) > limit) {
      await redisCommand(["ZREM", key, leaseId]).catch(() => {});
      throw new GuardError(429, GUARD_CODES.tooManyInFlight, MESSAGES.too_many_in_flight, 15);
    }
    acquired = true;
  } catch (e) {
    if (e instanceof GuardError) throw e;
    warnUnavailable(e);
  }
  let released = false;
  return async function release() {
    if (released || !acquired) return;
    released = true;
    await redisCommand(["ZREM", key, leaseId]).catch(() => {});
  };
}

// Bir AI isteğinin tamamı: acil kapatma → uç hız sınırı → eşzamanlılık kirası →
// maliyet sayaçları (UID toplamı + global). Maliyet sayacı reddederse alınan kira
// hemen bırakılır. Dönen release() iş bittiğinde (başarı ya da hata) çağrılmalı.
//
// reserveBudget: false → maliyet sayacını çağıran kendisi, sağlayıcıya gideceği
// kesinleşince reserveAiBudget ile ayırır (ör. recipe-jobs, aynı videonun tekrar
// paylaşımı yeni iş açmıyorsa sayılmasın diye).
export async function guardAiRequest({ action, user, req, reserveBudget = true }) {
  assertKillSwitchOff();
  const ctx = { action, uid: user.uid, isAnonymous: !!user.isAnonymous, ip: clientIp(req) };
  await checkRateLimit(ctx);
  const pool = ACTION_POOL[action];
  const release = pool ? await acquireSlot({ pool, uid: ctx.uid, isAnonymous: ctx.isAnonymous }) : async () => {};
  if (reserveBudget && GLOBAL_ACTIONS.has(action)) {
    try {
      await reserveAiBudget(ctx);
    } catch (e) {
      await release();
      throw e;
    }
  }
  return release;
}

// Vercel'de yanıt gönderildikten sonra çalışan kod (waitUntil dışında) garanti
// değil: fonksiyon donabilir. Gerçek Preview'da /api/extract'ın `finally`'deki
// release()'i yanıttan sonra çalışmadı ve kira TTL dolana kadar (330 sn) kaldı.
// Bu yüzden kira YANITTAN ÖNCE bırakılmalı: deferResponse yanıtı bellekte tutar,
// çağıran kirayı bıraktıktan sonra flush() ile gönderir.
export function deferResponse(res) {
  let status = 200;
  let body;
  let written = false;
  const headers = [];
  const proxy = {
    status(code) {
      status = code;
      return proxy;
    },
    json(payload) {
      body = payload;
      written = true;
      return proxy;
    },
    setHeader(name, value) {
      headers.push([name, value]);
    },
  };
  return {
    res: proxy,
    flush() {
      if (!written) return;
      written = false;
      if (typeof res.setHeader === "function") headers.forEach(([n, v]) => res.setHeader(n, v));
      res.status(status).json(body);
    },
  };
}

// GuardError'ı istemcinin anlayacağı biçimde yazar; değilse false döner.
export function sendGuardError(res, e) {
  if (!(e instanceof GuardError)) return false;
  if (e.retryAfter && typeof res.setHeader === "function") res.setHeader("Retry-After", String(e.retryAfter));
  res.status(e.status).json({ error: e.message, code: e.code, retryAfter: e.retryAfter || undefined });
  return true;
}
