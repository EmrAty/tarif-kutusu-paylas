import crypto from "node:crypto";
import { redisGetJSON, redisSetJSON, redisCommand, redisSet, redisSetNX, redisDel } from "./redis.js";
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
// ESKİ ŞEMA (okunur, silinmez): `user:<uid>:fcmTokens` = JSON dizi. Platform
//   bilgisi yok; native Android FCM token'ı ile Chrome web-push token'ı aynı
//   listede ve sunucu tarafında AYIRT EDİLEMEZ (ikisi de aynı FCM token biçimi).
//
// YENİ ŞEMA:
//   `user:<uid>:pushTargets` (HASH) alan = token,
//       değer = JSON {platform: "android"|"ios"|"web", installationId, updatedAt}
//   `push-owner:<sha256(token)>` = uid — token'ın şu anki TEK sahibi.
//
// Kurallar:
//   * Tarif hazır/başarısız bildirimi YALNIZCA "android" etiketli, bu hesaba ait
//     kayıtlara gider. Platformu bilinmeyen eski token'lara GİTMEZ (geri dönüş
//     yok): bunlar arasında Chrome token'ı olabilir ve sunucu ayırt edemez.
//     Bedeli: ana uygulama yeni web paketiyle bir kez açılana kadar o cihaza
//     tarif bildirimi gitmez (tarif yine kaydedilir; panel bunu gösterir).
//   * Aile "canı çekti" bildirimi platformdan bağımsızdır (ürün kararı bekliyor):
//     yeni + eski kayıtlar, yinelenmesiz ve başka hesaba geçmiş olanlar hariç.
//   * Bir token aynı anda tek hesaba aittir. Sahipsiz ya da sahibi artık
//     tutmayan token hemen alınır; BAŞKA bir hesabın elindeki token ancak
//     sahiplik kanıtıyla devralınır: sunucu o token'a sessiz (data-only)
//     doğrulama mesajı gönderir, mesajı yalnızca o cihazdaki uygulama alır ve
//     içindeki tek kullanımlık kodu geri yollar. Token'ı bilmek yetmez.
//   * Aynı kurulum (installationId) yeni token alırsa eskisi kaldırılır —
//     yalnızca kendi hesabının kayıtları arasında (başkasınınkine dokunmaz).
// ---------------------------------------------------------------------------

export const PUSH_PLATFORMS = new Set(["android", "ios", "web"]);
export const NATIVE_RECIPE_PLATFORMS = new Set(["android"]);
const OWNER_TTL_SECONDS = 270 * 24 * 3600; // FCM pasif token ömrü
const MAX_TARGETS_PER_USER = 10;
const SENT_MARKER_TTL_SECONDS = 7 * 24 * 3600;
const VERIFY_TTL_SECONDS = 300;
const VERIFY_RESEND_SECONDS = 30;
export const PUSH_VERIFY_TYPE = "push_verify";

const sha = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

export function fcmTokensKey(uid) {
  return `user:${uid}:fcmTokens`;
}
export function pushTargetsKey(uid) {
  return `user:${uid}:pushTargets`;
}
export function pushOwnerKey(token) {
  return `push-owner:${sha(token)}`;
}
export function pushVerifyKey(token, uid) {
  return `push-verify:${sha(token)}:${uid}`;
}
export function pushSentKey(uid, rest) {
  return `push-sent:${uid}:${rest}`;
}

export function isValidPushToken(token) {
  return typeof token === "string" && token.length >= 1 && token.length <= 4096 && !/\s/.test(token);
}
export function isValidInstallationId(id) {
  return typeof id === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(id);
}

// Upstash REST HGETALL düz dizi ([alan, değer, ...]) döndürür; nesne biçimi de
// kabul edilir (istemci/sürüm farkına karşı).
function hashEntries(result) {
  if (Array.isArray(result)) {
    const out = [];
    for (let i = 0; i + 1 < result.length; i += 2) out.push([result[i], result[i + 1]]);
    return out;
  }
  if (result && typeof result === "object") return Object.entries(result);
  return [];
}

function parseTargets(result) {
  const out = new Map();
  for (const [token, raw] of hashEntries(result)) {
    let meta = null;
    try {
      meta = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch (e) {
      meta = null;
    }
    if (!isValidPushToken(token) || !meta || !PUSH_PLATFORMS.has(meta.platform)) continue;
    out.set(token, meta);
  }
  return out;
}

async function readTargets(uid) {
  return parseTargets(await redisCommand(["HGETALL", pushTargetsKey(uid)]));
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
  return Array.isArray(result) && result.length === tokens.length ? result : tokens.map(() => null);
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
  const targets = await readTargets(uid);
  const legacy = await readLegacyTokens(uid);
  for (const t of new Set([...targets.keys(), ...legacy])) await releaseOwnerIfMine(uid, t);
}

// Kayıtlı sahip token'ı hâlâ tutuyor mu? Tutmuyorsa (çıkış/temizlik yarıda
// kalmış) sahiplik bayattır ve kanıt istenmez.
async function ownerStillHolds(owner, token) {
  const [inHash] = (await redisCommand(["HMGET", pushTargetsKey(owner), token])) || [];
  if (inHash) return true;
  return (await readLegacyTokens(owner)).includes(token);
}

// Token'ı bu hesaba bağlar (sahiplik kontrolü çağıranda yapılmış olmalı).
async function claimToken(uid, { token, platform, installationId }) {
  const ownerKey = pushOwnerKey(token);
  const previousOwner = await redisCommand(["GET", ownerKey]);
  // Önce sahiplik: bundan sonra eski hesabın kaydı okumada hedeflenmez,
  // aşağıdaki temizlik yarıda kalsa bile.
  await redisSet(ownerKey, uid, OWNER_TTL_SECONDS);
  if (previousOwner && previousOwner !== uid) {
    await redisCommand(["HDEL", pushTargetsKey(previousOwner), token]).catch(() => {});
    await removeFromLegacy(previousOwner, [token]).catch(() => {});
  }

  if (!platform) {
    // Platform göndermeyen eski istemci paketi: eski şemaya (davranış aynı).
    const list = await redisGetJSON(fcmTokensKey(uid), []);
    const current = Array.isArray(list) ? list : [];
    const [inNew] = (await redisCommand(["HMGET", pushTargetsKey(uid), token])) || [];
    if (!current.includes(token) && !inNew) await redisSetJSON(fcmTokensKey(uid), [...current, token]);
    return { status: "registered", schema: "legacy" };
  }

  const existing = await readTargets(uid);
  await redisCommand([
    "HSET",
    pushTargetsKey(uid),
    token,
    JSON.stringify({ platform, installationId: installationId || null, updatedAt: Date.now() }),
  ]);

  // Token yenilendi: aynı kurulumun eski token'ı artık hedeflenmez.
  const stale = [];
  if (installationId) {
    for (const [t, meta] of existing) if (t !== token && meta.installationId === installationId) stale.push(t);
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
  return { status: "registered", schema: "v2", replaced: stale.length };
}

// Cihaz kaydı. Dönüş: {status: "registered"} ya da
// {status: "verification_required"} (token başka hesabın; kanıt bekleniyor).
export async function registerPushTarget(uid, { token, platform, installationId }) {
  const owner = await redisCommand(["GET", pushOwnerKey(token)]);
  if (owner && owner !== uid && (await ownerStillHolds(owner, token))) {
    if (!platform) {
      // Eski istemci kanıt adımını bilmiyor: hiçbir şey değişmez.
      return { status: "ignored", reason: "owned_by_other_account" };
    }
    return startVerification(uid, { token, platform, installationId });
  }
  return claimToken(uid, { token, platform, installationId });
}

async function startVerification(uid, { token, platform, installationId }) {
  const nonce = crypto.randomBytes(16).toString("hex");
  const key = pushVerifyKey(token, uid);
  // Aynı token+hesap için en fazla VERIFY_RESEND_SECONDS'te bir push (spam'e karşı).
  const fresh = await redisSetNX(`${key}:sent`, "1", VERIFY_RESEND_SECONDS);
  if (!fresh) return { status: "verification_required", resent: false };
  await redisSet(key, JSON.stringify({ nonceHash: sha(nonce), platform, installationId: installationId || null }), VERIFY_TTL_SECONDS);
  try {
    await sendFcmMessage(token, { data: { type: PUSH_VERIFY_TYPE, nonce }, dataOnly: true });
  } catch (e) {
    if (e.invalidToken) {
      // Token artık geçersiz: kimseye ait değil, eski sahibin kaydı temizlenir.
      const owner = await redisCommand(["GET", pushOwnerKey(token)]).catch(() => null);
      if (owner) await forgetToken(owner, token).catch(() => {});
      await redisDel(key).catch(() => {});
      return { status: "invalid_token" };
    }
    return { status: "verification_required", sent: false };
  }
  return { status: "verification_required", sent: true };
}

// Sahiplik kanıtı: doğrulama mesajındaki kod yalnızca o token'ı alan cihaza
// ulaşır. Kod tek kullanımlıktır ve isteyen hesaba bağlıdır.
export async function verifyPushTarget(uid, { token, nonce }) {
  const key = pushVerifyKey(token, uid);
  const pending = await redisGetJSON(key, null);
  if (!pending || typeof nonce !== "string" || !/^[0-9a-f]{32}$/.test(nonce)) return { status: "verification_failed" };
  const a = Buffer.from(String(pending.nonceHash || ""), "hex");
  const b = Buffer.from(sha(nonce), "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { status: "verification_failed" };
  await redisDel(key);
  return claimToken(uid, { token, platform: pending.platform, installationId: pending.installationId });
}

// Çıkış: bu kurulumun token'ı bu hesaptan ayrılır (yalnızca kendi kayıtları).
export async function unregisterPushTarget(uid, { token, installationId }) {
  const tokens = new Set();
  if (isValidPushToken(token)) tokens.add(token);
  if (installationId) {
    for (const [t, meta] of await readTargets(uid)) if (meta.installationId === installationId) tokens.add(t);
  }
  for (const t of tokens) await forgetToken(uid, t);
  return { removed: tokens.size };
}

// Hedef listesi (yinelenmesiz). nativeOnly: tarif bildirimleri.
// cleanup=false: yalnızca okur (cihaz sayımı).
export async function collectPushTargets(uid, { nativeOnly = false, cleanup = true } = {}) {
  const [targets, legacy] = await Promise.all([readTargets(uid), nativeOnly ? Promise.resolve([]) : readLegacyTokens(uid)]);
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

  if (nativeOnly) return v2.filter((t) => NATIVE_RECIPE_PLATFORMS.has(t.platform));
  return [...v2, ...legacyOnly];
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
// dataOnly: görünür bildirim yok (Android'de sistem çubuğuna düşmez; uygulama
// ön plandaysa JS dinleyicisine gelir) — sahiplik doğrulaması için.
export async function sendFcmMessage(token, { title, body, data, dataOnly = false }) {
  const { accessToken, projectId } = await getAccessToken();
  const recipeId = data?.recipeId;
  const stringData = data ? Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])) : undefined;
  const message = dataOnly
    ? { token, data: stringData || {}, android: { priority: "high" }, webpush: { headers: { Urgency: "high" } } }
    : {
        token,
        notification: { title, body },
        // data, bildirime tıklanınca doğru tarifin açılabilmesi için (bkz.
        // App.jsx / firebase-messaging-sw.js) - FCM data payload'ı sadece
        // string değer kabul ediyor.
        ...(stringData ? { data: stringData } : {}),
        // Varsayılan ("normal") öncelik, cihaz Doze/pil optimizasyonu
        // modundayken bildirimi dakikalarca geciktirebiliyordu ("geç geliyor"
        // diye bildirildi, 10 Eylül 2026) - "high" cihazı hemen uyandırıyor.
        android: { priority: "high" },
        // Web'de bildirimi Firebase SDK'sı gösterir (firebase-messaging-sw.js);
        // ikon buradan gelir, tıklayınca link açılır.
        webpush: {
          notification: { icon: "/icon-192.png", badge: "/icon-192.png" },
          fcm_options: { link: recipeId ? `/?openRecipe=${encodeURIComponent(recipeId)}` : "/" },
        },
      };
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
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
// ikinci gönderim yapılmaz (ör. aynı job için iki kez bildirim).
// İşaret gönderimden ÖNCE yazılır. Bilinçli tercihler:
//   * İşaret yazılamazsa (Redis hatası) bildirim yine gönderilir: kayıp,
//     nadir bir çift bildirimden kötü. Çift ancak aynı job iki kez işlenir VE
//     iki seferde de Redis hata verirse oluşur.
//   * İşaret yazıldıktan sonra gönderim başarısız olursa yeniden deneme
//     yoktur (zaten hiçbir yol yeniden denemiyor) — işaret kayıp yaratmaz.
//   * İşaret yazıldıktan hemen sonra süreç ölürse o job'un bildirimi kaybolur.
export async function notifyUserDevices(uid, { title, body, data }, { nativeOnly = false, dedupeKey = null } = {}) {
  if (dedupeKey) {
    let acquired = true;
    try {
      acquired = await redisSetNX(pushSentKey(uid, dedupeKey), "1", SENT_MARKER_TTL_SECONDS);
    } catch (e) {
      acquired = true;
    }
    if (!acquired) return { sent: 0, attempted: 0, error: null, duplicate: true };
  }
  const targets = await collectPushTargets(uid, { nativeOnly });
  return sendToTargets(uid, targets, { title, body, data });
}
