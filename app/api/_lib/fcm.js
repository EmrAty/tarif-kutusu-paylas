import crypto from "node:crypto";
import { redisGetJSON, redisSetJSON, redisCommand, redisSet, redisSetNX } from "./redis.js";
import { getServiceAccountToken } from "./googleAuth.js";

// FCM'e (Firebase Cloud Messaging) sunucudan push göndermek için servis hesabı
// erişim token'ı ortak yardımcıdan (googleAuth.js) alınıyor.
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

async function getAccessToken() {
  try {
    return await getServiceAccountToken(FCM_SCOPE, "Sunucu yapılandırması eksik: bildirim gönderme anahtarı tanımlı değil.");
  } catch (e) {
    if (e.status === 502) e.message = "Google'dan bildirim gönderme yetkisi alınamadı.";
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Push hedefleri (Grup 3)
//
// ESKİ ŞEMA (hâlâ okunuyor, silinmiyor): `user:<uid>:fcmTokens` = JSON dizi.
//   Platform bilgisi yok; native Android FCM token'ı ile Chrome web-push FCM
//   token'ı aynı listede, ayırt edilemez. Token birden çok hesapta kalabilir.
//
// YENİ ŞEMA:
//   `user:<uid>:pushTargets` (HASH) alan = token,
//       değer = JSON {platform: "android"|"ios"|"web", installationId, updatedAt}
//   `push-owner:<sha256(token)>` = uid — token'ın şu anki TEK sahibi.
//
// Kurallar:
//   * Bir token aynı anda yalnızca bir hesaba aittir: yeni hesap kaydedince
//     eski hesabın kaydı silinir; okuma sırasında sahibi başka olan kayıt
//     hedeflenmez (ve tembel olarak temizlenir).
//   * Aynı kurulum (installationId) yeni token alırsa eski token kaldırılır.
//   * Tarif hazır/başarısız bildirimi yalnızca native Android'e gider. Kullanıcının
//     hiç "android" etiketli kaydı yoksa (uygulama yeni sürümle henüz açılmadı)
//     geçiş dönemi için yalnızca ESKİ listedeki, sahibi başka hesap olmayan,
//     platformu bilinmeyen token'lar kullanılır; "web" etiketli asla.
//   * Eski liste, token platformla yeniden kaydedildikçe tembel olarak boşalır.
// ---------------------------------------------------------------------------

export const PUSH_PLATFORMS = new Set(["android", "ios", "web"]);
export const NATIVE_RECIPE_PLATFORMS = new Set(["android"]);
const OWNER_TTL_SECONDS = 270 * 24 * 3600; // FCM pasif token ömrü
const MAX_TARGETS_PER_USER = 10;
const SENT_MARKER_TTL_SECONDS = 7 * 24 * 3600;

export function fcmTokensKey(uid) {
  return `user:${uid}:fcmTokens`;
}
export function pushTargetsKey(uid) {
  return `user:${uid}:pushTargets`;
}
export function pushOwnerKey(token) {
  return `push-owner:${crypto.createHash("sha256").update(String(token)).digest("hex")}`;
}

export function isValidPushToken(token) {
  return typeof token === "string" && token.length >= 1 && token.length <= 4096 && !/\s/.test(token);
}
export function isValidInstallationId(id) {
  return typeof id === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(id);
}

function parseTargets(flat) {
  const out = new Map();
  if (!Array.isArray(flat)) return out;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const token = flat[i];
    let meta = null;
    try {
      meta = JSON.parse(flat[i + 1]);
    } catch (e) {
      meta = null;
    }
    if (!isValidPushToken(token) || !meta || !PUSH_PLATFORMS.has(meta.platform)) continue;
    out.set(token, meta);
  }
  return out;
}

async function readLegacyTokens(uid) {
  const list = await redisGetJSON(fcmTokensKey(uid), []);
  return Array.isArray(list) ? [...new Set(list.filter(isValidPushToken))] : [];
}

async function removeFromLegacy(uid, tokens) {
  const drop = new Set(tokens);
  if (!drop.size) return;
  const list = await redisGetJSON(fcmTokensKey(uid), []);
  if (!Array.isArray(list)) return;
  const next = list.filter((t) => !drop.has(t));
  if (next.length !== list.length) await redisSetJSON(fcmTokensKey(uid), next);
}

async function readOwners(tokens) {
  if (!tokens.length) return [];
  const result = await redisCommand(["MGET", ...tokens.map(pushOwnerKey)]);
  return Array.isArray(result) ? result : tokens.map(() => null);
}

// Token'ı yalnızca hâlâ bu hesaba aitse serbest bırakır (başka hesabın yeni
// sahipliği silinmez).
async function releaseOwnerIfMine(uid, token) {
  const owner = await redisCommand(["GET", pushOwnerKey(token)]);
  if (owner === uid) await redisCommand(["DEL", pushOwnerKey(token)]);
}

// Bir token'ı bu hesabın bütün kayıtlarından kaldırır (yeni + eski şema).
export async function forgetToken(uid, token) {
  await redisCommand(["HDEL", pushTargetsKey(uid), token]);
  await removeFromLegacy(uid, [token]);
  await releaseOwnerIfMine(uid, token);
}

// Hesap silinirken: bu hesabın bütün token'larının sahipliğini bırakır.
export async function releasePushOwnership(uid) {
  const targets = parseTargets(await redisCommand(["HGETALL", pushTargetsKey(uid)]));
  const legacy = await readLegacyTokens(uid);
  for (const t of new Set([...targets.keys(), ...legacy])) await releaseOwnerIfMine(uid, t);
}

// Cihaz kaydı. platform yoksa (eski istemci paketi) token eski şemaya
// eklenir — davranış eskisiyle aynı, yalnızca sahiplik de işaretlenir.
export async function registerPushTarget(uid, { token, platform, installationId }) {
  const ownerKey = pushOwnerKey(token);
  const previousOwner = await redisCommand(["GET", ownerKey]);
  // Önce sahiplik: bundan sonra eski hesabın kaydı okumada hedeflenmez,
  // aşağıdaki temizlik yarıda kalsa bile.
  await redisSet(ownerKey, uid, OWNER_TTL_SECONDS);

  if (previousOwner && previousOwner !== uid) {
    // A'dan çıkıp B'ye giren cihaz: A artık bu cihaza push gönderemez.
    await redisCommand(["HDEL", pushTargetsKey(previousOwner), token]).catch(() => {});
    await removeFromLegacy(previousOwner, [token]).catch(() => {});
  }

  if (!platform) {
    const list = await redisGetJSON(fcmTokensKey(uid), []);
    const current = Array.isArray(list) ? list : [];
    const inNew = await redisCommand(["HMGET", pushTargetsKey(uid), token]);
    if (!current.includes(token) && !(Array.isArray(inNew) && inNew[0])) {
      await redisSetJSON(fcmTokensKey(uid), [...current, token]);
    }
    return { schema: "legacy" };
  }

  const now = Date.now();
  const existing = parseTargets(await redisCommand(["HGETALL", pushTargetsKey(uid)]));
  await redisCommand([
    "HSET",
    pushTargetsKey(uid),
    token,
    JSON.stringify({ platform, installationId: installationId || null, updatedAt: now }),
  ]);

  // Token yenilendi: aynı kurulumun eski token'ı artık hedeflenmez.
  const stale = [];
  if (installationId) {
    for (const [t, meta] of existing) {
      if (t !== token && meta.installationId === installationId) stale.push(t);
    }
  }
  // Sınır: en eski kayıtlar atılır (kurulumu bilinmeyen birikmeye karşı).
  const remaining = [...existing].filter(([t]) => t !== token && !stale.includes(t));
  if (remaining.length + 1 > MAX_TARGETS_PER_USER) {
    remaining.sort((a, b) => (a[1].updatedAt || 0) - (b[1].updatedAt || 0));
    stale.push(...remaining.slice(0, remaining.length + 1 - MAX_TARGETS_PER_USER).map(([t]) => t));
  }
  for (const t of stale) {
    await redisCommand(["HDEL", pushTargetsKey(uid), t]).catch(() => {});
    await releaseOwnerIfMine(uid, t).catch(() => {});
  }
  // Tembel geçiş: platformu artık bilinen token eski listeden çıkar.
  await removeFromLegacy(uid, [token, ...stale]).catch(() => {});
  return { schema: "v2", replaced: stale.length };
}

// Çıkış: bu kurulumun token'ı bu hesaptan ayrılır.
export async function unregisterPushTarget(uid, { token, installationId }) {
  const tokens = new Set();
  if (isValidPushToken(token)) tokens.add(token);
  if (installationId) {
    const existing = parseTargets(await redisCommand(["HGETALL", pushTargetsKey(uid)]));
    for (const [t, meta] of existing) if (meta.installationId === installationId) tokens.add(t);
  }
  for (const t of tokens) await forgetToken(uid, t);
  return { removed: tokens.size };
}

// Hedef listesi (yinelenmesiz). nativeOnly: tarif bildirimleri.
// cleanup=false: yalnızca okur (cihaz sayımı).
export async function collectPushTargets(uid, { nativeOnly = false, cleanup = true } = {}) {
  const [flat, legacy] = await Promise.all([
    redisCommand(["HGETALL", pushTargetsKey(uid)]),
    readLegacyTokens(uid),
  ]);
  const targets = parseTargets(flat);
  const all = [...new Set([...targets.keys(), ...legacy])];
  const owners = await readOwners(all);
  const ownerOf = new Map(all.map((t, i) => [t, owners[i]]));
  const ownedElsewhere = (t) => {
    const o = ownerOf.get(t);
    return o != null && o !== uid;
  };

  const staleNew = [];
  const v2 = [];
  for (const [token, meta] of targets) {
    if (ownedElsewhere(token)) staleNew.push(token);
    else v2.push({ token, platform: meta.platform, source: "v2" });
  }
  const staleLegacy = [];
  const legacyOnly = [];
  for (const token of legacy) {
    if (targets.has(token)) staleLegacy.push(token); // yeni şemada zaten var
    else if (ownedElsewhere(token)) staleLegacy.push(token); // başka hesaba geçmiş
    else legacyOnly.push({ token, platform: null, source: "legacy" });
  }

  if (cleanup && (staleNew.length || staleLegacy.length)) {
    // Temizlik bildirim akışını asla bozmaz.
    for (const t of staleNew) await redisCommand(["HDEL", pushTargetsKey(uid), t]).catch(() => {});
    await removeFromLegacy(uid, staleLegacy).catch(() => {});
  }

  if (!nativeOnly) return [...v2, ...legacyOnly];
  const native = v2.filter((t) => NATIVE_RECIPE_PLATFORMS.has(t.platform));
  if (native.length) return native;
  // Geçiş dönemi: native kaydı olmayan kullanıcıda yalnızca platformu
  // bilinmeyen eski token'lar (web etiketliler asla).
  return legacyOnly;
}

// FCM hata sınıflandırması: yalnızca token'ın KALICI olarak geçersiz olduğu
// durumlar temizlenir. INVALID_ARGUMENT yük hatası da olabilir; yalnızca
// mesaj token'ı işaret ediyorsa geçersiz sayılır.
export function isPermanentTokenError(status, body) {
  const err = body?.error || {};
  const codes = (Array.isArray(err.details) ? err.details : []).map((d) => d && d.errorCode).filter(Boolean);
  if (codes.includes("UNREGISTERED") || codes.includes("SENDER_ID_MISMATCH")) return true;
  if (err.status === "NOT_FOUND" || status === 404) return true;
  if (err.status === "INVALID_ARGUMENT" && /registration token/i.test(err.message || "")) return true;
  return false;
}

// Tek bir cihaz token'ına push gönderiyor. Token artık geçersizse (uygulama
// kaldırılmış, izin geri alınmış vb.) invalidToken:true fırlatıyor ki çağıran
// taraf o token'ı kalıcı listeden temizleyebilsin.
export async function sendFcmMessage(token, { title, body, data }) {
  const { accessToken, projectId } = await getAccessToken();
  const recipeId = data?.recipeId;
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        token,
        notification: { title, body },
        // data, bildirime tıklanınca doğru tarifin açılabilmesi için (bkz.
        // App.jsx / firebase-messaging-sw.js) - FCM data payload'ı sadece
        // string değer kabul ediyor.
        ...(data ? { data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])) } : {}),
        // Varsayılan ("normal") öncelik, cihaz Doze/pil optimizasyonu
        // modundayken bildirimi dakikalarca geciktirebiliyordu ("geç geliyor"
        // diye bildirildi, 10 Eylül 2026) - "high" cihazı hemen uyandırıyor.
        android: { priority: "high" },
        webpush: { fcm_options: { link: recipeId ? `/?openRecipe=${encodeURIComponent(recipeId)}` : "/" } },
      },
    }),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    const err = new Error(payload?.error?.message || "Bildirim gönderilemedi.");
    err.invalidToken = isPermanentTokenError(res.status, payload);
    throw err;
  }
}

// Hedeflere gönderir; kalıcı geçersiz token bu hesabın kayıtlarından silinir.
// Temizlikteki Redis hatası gönderim sonucunu değiştirmez.
export async function sendToTargets(uid, targets, message) {
  let sent = 0;
  let lastError = null;
  const seen = new Set();
  let attempted = 0;
  for (const { token } of targets) {
    if (seen.has(token)) continue;
    seen.add(token);
    attempted++;
    try {
      await sendFcmMessage(token, message);
      sent++;
    } catch (e) {
      lastError = e.message;
      if (e.invalidToken) await forgetToken(uid, token).catch(() => {});
    }
  }
  return { sent, attempted, error: sent === 0 ? lastError : null };
}

// Tek kullanıcının cihazlarına gönderir. dedupeKey verilirse aynı anahtarla
// ikinci gönderim yapılmaz (ör. aynı job için iki kez bildirim). İşaret
// yazılamazsa (Redis hatası) bildirim yine gönderilir: kullanıcıya bildirim
// ulaşmaması, nadir bir çift bildirimden daha kötü.
export async function notifyUserDevices(uid, { title, body, data }, { nativeOnly = false, dedupeKey = null } = {}) {
  if (dedupeKey) {
    let acquired = true;
    try {
      acquired = await redisSetNX(`push-sent:${dedupeKey}`, "1", SENT_MARKER_TTL_SECONDS);
    } catch (e) {
      acquired = true;
    }
    if (!acquired) return { sent: 0, attempted: 0, error: null, duplicate: true };
  }
  const targets = await collectPushTargets(uid, { nativeOnly });
  return sendToTargets(uid, targets, { title, body, data });
}
