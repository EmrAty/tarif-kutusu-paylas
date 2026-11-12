import crypto from "node:crypto";
import { redisPipeline } from "./redis.js";

// Aile davet kodları (Grup 4).
//
// Biçim: 10 karakter, 32 harfli alfabe (karışan 0/O, 1/I yok) → 32^10 ≈ 1,1·10^15
// olasılık, `crypto.randomInt` ile (eski kod 6 karakter ve Math.random idi:
// ≈ 10^9). Kullanıcıya "ABCDE-FGHJK" diye gösterilir; girişte boşluk, tire ve
// küçük harf yok sayılır. Eski 6 karakterli kodlar, aile sahibi yenileyene
// kadar geçerli kalır (paylaşılmış davetler bozulmasın diye).

export const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const INVITE_CODE_LENGTH = 10;
export const LEGACY_INVITE_CODE_LENGTH = 6;

export function generateInviteCode() {
  let code = "";
  for (let i = 0; i < INVITE_CODE_LENGTH; i++) code += INVITE_ALPHABET[crypto.randomInt(INVITE_ALPHABET.length)];
  return code;
}

// Girişi saklanan biçime çevirir; geçersiz biçimde null (sunucuya sorgu atılmaz).
export function normalizeInviteCode(input) {
  if (typeof input !== "string") return null;
  const code = input.toUpperCase().replace(/[\s-]/g, "");
  if (code.length !== INVITE_CODE_LENGTH && code.length !== LEGACY_INVITE_CODE_LENGTH) return null;
  for (const ch of code) if (!INVITE_ALPHABET.includes(ch)) return null;
  return code;
}

export function isLegacyInviteCode(code) {
  return typeof code === "string" && code.length === LEGACY_INVITE_CODE_LENGTH;
}

// ---------------------------------------------------------------------------
// Katılma denemesi sınırları (kod tahminine karşı)
//
// Sabit pencereli sayaçlar. "attempt" her katılma isteğini, "fail" yalnızca
// geçersiz kodu sayar; doğru kodla katılan normal kullanıcı fail sayacına hiç
// girmez. Misafir (anonim) hesap saniyeler içinde yeniden açılabildiği için IP
// ve sistem geneli tavanı da var. Redis'e ulaşılamazsa katılma zaten
// yapılamaz; bu yüzden burada hata fırlatılır (fail-closed).
//
// Global tavan bilinçli bir takas: saldırı sürerken (saatte 500'den fazla
// yanlış kod) herkesin katılması o saatin sonuna kadar durur; buna karşılık
// eski 6 karakterli kodlar bile pratikte tahmin edilemez kalır.
// ---------------------------------------------------------------------------

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86400;

export const JOIN_LIMITS = {
  uidAttempts: [{ seconds: HOUR, limit: 30 }],
  uidFailures: [
    { seconds: 15 * MINUTE, limit: 5 },
    { seconds: DAY, limit: 20 },
  ],
  ipFailures: [{ seconds: HOUR, limit: 30 }],
  globalFailures: [{ seconds: HOUR, limit: 500 }],
};

const hash = (value) => crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 24);

let clock = () => Date.now();
export function __setInviteClockForTests(fn) {
  clock = fn || (() => Date.now());
}

function windowKeys(prefix, windows, now) {
  return windows.map((w) => {
    const bucket = Math.floor(now / 1000 / w.seconds);
    return { key: `${prefix}:${w.seconds}:${bucket}`, retryAfter: Math.max(1, Math.ceil((bucket + 1) * w.seconds - now / 1000)), ...w };
  });
}

function scopes(uid, ip, now) {
  return {
    uidAttempts: windowKeys(`rl:join:attempt:u:${uid}`, JOIN_LIMITS.uidAttempts, now),
    failures: [
      ...windowKeys(`rl:join:fail:u:${uid}`, JOIN_LIMITS.uidFailures, now),
      ...(ip ? windowKeys(`rl:join:fail:ip:${hash(ip)}`, JOIN_LIMITS.ipFailures, now) : []),
      ...windowKeys("rl:join:fail:all", JOIN_LIMITS.globalFailures, now),
    ],
  };
}

export function joinRateLimitedError(retryAfter) {
  const err = new Error("Çok fazla deneme yapıldı. Biraz bekleyip tekrar dene.");
  err.status = 429;
  err.code = "invite_rate_limited";
  err.retryAfter = retryAfter;
  return err;
}

function unwrap(value) {
  if (value instanceof Error) throw Object.assign(new Error("Veritabanına erişilemedi."), { status: 502 });
  return Number(value || 0);
}

// Her katılma isteğinden ÖNCE: deneme sayacını artırır, hata sayaçlarını okur.
// Sınır aşıldıysa 429 fırlatır (kod hiç sorgulanmaz → tahmin için bilgi yok).
export async function assertJoinAllowed({ uid, ip }, now = clock()) {
  const s = scopes(uid, ip, now);
  const commands = [];
  for (const w of s.uidAttempts) commands.push(["INCR", w.key], ["EXPIRE", w.key, String(w.seconds + 5)]);
  for (const w of s.failures) commands.push(["GET", w.key]);
  const results = await redisPipeline(commands);
  let i = 0;
  for (const w of s.uidAttempts) {
    const count = unwrap(results[i]);
    i += 2;
    if (count > w.limit) throw joinRateLimitedError(w.retryAfter);
  }
  for (const w of s.failures) {
    const count = unwrap(results[i++]);
    if (count >= w.limit) throw joinRateLimitedError(w.retryAfter);
  }
}

// Geçersiz koddan sonra çağrılır.
export async function recordJoinFailure({ uid, ip }, now = clock()) {
  const s = scopes(uid, ip, now);
  const commands = [];
  for (const w of s.failures) commands.push(["INCR", w.key], ["EXPIRE", w.key, String(w.seconds + 5)]);
  await redisPipeline(commands);
}
