import { redisGet, redisSet, redisDel, redisGetJSON, redisSetJSON, redisCommand } from "./redis.js";
import { getProfile, profileKey } from "./profile.js";
import { membersKey } from "./families.js";
import { fcmTokensKey } from "./fcm.js";
import { bucketAuxKeys } from "./versionedBucket.js";
import { getServiceAccountToken } from "./googleAuth.js";

// Hesap silme (DELETE /api/account). Sıra bilerek böyle:
//   1. "silindi" işareti  -> eski ID token'la gelen istekler ve yarıda kalmış
//      paylaşım job'u kullanıcının verisini yeniden oluşturamasın
//   2. aile üyelikleri    -> profil (aile listesi) hâlâ okunabilirken
//   3. kullanıcı verisi   -> profil en son
//   4. Firebase hesabı    -> en son; önceki adımlardan biri hata verirse
//      kullanıcı hâlâ giriş yapıp tekrar deneyebilir.
// Her adım tekrar çalıştırılabilir: aynı hesap için ikinci çağrı kalan işi
// bitirir, zaten silinmiş olanı atlar.

// Firebase ID token'ı en fazla 1 saat geçerli; işaret ondan uzun kalıyor.
const DELETED_MARKER_TTL = 24 * 3600;
const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;

const deletedMarkerKey = (uid) => `deleted-account:${uid}`;

export async function isAccountDeleted(uid) {
  return (await redisGet(deletedMarkerKey(uid))) != null;
}

// Silinmiş hesabın verisine yazmak üzere olan arka plan işleri bunu kullanıyor.
export function accountDeletedError() {
  const err = new Error("Hesap silindi.");
  err.status = 401;
  err.accountDeleted = true;
  return err;
}

const familyMetaKey = (id) => `family:${id}:meta`;
const inviteKey = (code) => `invite:${code}:family`;

// Sabit kişisel anahtarlar. Bunlara ek olarak user:<uid>:* altında kalan her
// şey de taranıp siliniyor (ileride eklenecek yeni bir kişisel anahtar
// unutulmasın diye).
// Veri kovaları ve sürüm/yedek anahtarları (bkz. versionedBucket.js).
const BUCKETS = ["recipes", "shopping-list", "pantry-items"];
const bucketKeysWithAux = (prefix) =>
  BUCKETS.flatMap((b) => {
    const key = `${prefix}:${b}`;
    return [key, ...bucketAuxKeys(key)];
  });

// pendingJobRecipes: eski sürümün job işaretçisi; artık yazılmıyor ama
// production'da 7 günlük TTL'i dolmamış kayıtlar kalmış olabilir.
function personalKeys(uid) {
  return [
    ...bucketKeysWithAux(`user:${uid}`),
    fcmTokensKey(uid),
    `user:${uid}:pendingJobRecipes`,
    `user:${uid}:recentlyRemovedRecipes`,
  ];
}

// Paylaşım paneli job kayıtları (TTL'li ama kaynak linki içeriyor).
function jobKeyPatterns(uid) {
  return [`job:${uid}:*`, `job-req:${uid}:*`, `job-url:${uid}:*`, `user:${uid}:*`];
}

async function scanKeys(pattern) {
  const keys = [];
  let cursor = "0";
  for (let i = 0; i < 1000; i++) {
    const result = await redisCommand(["SCAN", cursor, "MATCH", pattern, "COUNT", "1000"]);
    const [next, batch] = Array.isArray(result) ? result : ["0", []];
    keys.push(...(batch || []));
    cursor = String(next);
    if (cursor === "0") return keys;
  }
  throw new Error("Anahtar taraması bitmedi.");
}

async function deleteKeys(keys) {
  const unique = [...new Set(keys)];
  for (let i = 0; i < unique.length; i += 100) {
    await redisCommand(["DEL", ...unique.slice(i, i + 100)]);
  }
}

async function deleteWholeFamily(id, meta) {
  await deleteKeys([
    ...bucketKeysWithAux(`family:${id}`),
    `family:${id}:pendingJobRecipes`,
    ...(meta.inviteCode ? [inviteKey(meta.inviteCode)] : []),
  ]);
  await redisDel(membersKey(id));
  // meta en son: yarıda kalırsa tekrar çağrıda aile hâlâ bulunup temizleniyor.
  await redisDel(familyMetaKey(id));
}

// Sahiplik devri: kalan üyelerden en eski katılan (eşitlikte uid sırası).
function nextOwner(members) {
  return Object.entries(members)
    .sort(([uidA, a], [uidB, b]) => (a?.joinedAt ?? Infinity) - (b?.joinedAt ?? Infinity) || uidA.localeCompare(uidB))[0][0];
}

// Kullanıcıyı ailesinden çıkarır. Başka üye kalmadıysa aile tamamen silinir;
// kaldıysa aile ve ortak listeler dokunulmadan kalır, sahiplik devredilir.
async function leaveFamilyForDeletion(uid, id) {
  const meta = await redisGetJSON(familyMetaKey(id), null);
  if (!meta) return { id, result: "missing" };
  const members = await redisGetJSON(membersKey(id), {});
  if (members[uid]) {
    delete members[uid];
    if (Object.keys(members).length > 0) await redisSetJSON(membersKey(id), members);
  }
  if (Object.keys(members).length === 0) {
    await deleteWholeFamily(id, meta);
    return { id, result: "deleted" };
  }
  if (meta.ownerUid === uid) {
    meta.ownerUid = nextOwner(members);
    await redisSetJSON(familyMetaKey(id), meta);
    return { id, result: "ownership_transferred" };
  }
  return { id, result: "left" };
}

const IDENTITY_TOOLKIT_SCOPE = "https://www.googleapis.com/auth/identitytoolkit";

// Firebase Authentication kullanıcısını sunucudan siler (Identity Toolkit
// accounts:delete — firebase-admin'in auth().deleteUser() ile aynı çağrı).
// Kullanıcı zaten yoksa başarılı sayılır.
export async function deleteFirebaseUser(uid) {
  const { accessToken, projectId } = await getServiceAccountToken(IDENTITY_TOOLKIT_SCOPE);
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${projectId}/accounts:delete`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ localId: uid }),
  });
  if (res.ok) return { result: "deleted" };
  const data = await res.json().catch(() => ({}));
  const message = data?.error?.message || "";
  if (message.startsWith("USER_NOT_FOUND")) return { result: "already_deleted" };
  const err = new Error(`Firebase kullanıcısı silinemedi (${res.status} ${message})`);
  err.status = 502;
  throw err;
}

export async function deleteAccount(uid) {
  if (typeof uid !== "string" || !UID_RE.test(uid)) throw new Error("Geçersiz kullanıcı kimliği.");

  await redisSet(deletedMarkerKey(uid), String(Date.now()), DELETED_MARKER_TTL);

  const profile = await getProfile(uid);
  const familyIds = Array.isArray(profile.families) ? profile.families : [];
  const families = [];
  for (const id of familyIds) {
    families.push(await leaveFamilyForDeletion(uid, id));
  }

  await deleteKeys(personalKeys(uid));
  const scanned = [];
  for (const pattern of jobKeyPatterns(uid)) {
    scanned.push(...(await scanKeys(pattern)));
  }
  await deleteKeys(scanned.filter((key) => key !== profileKey(uid)));
  await redisDel(profileKey(uid));

  const firebase = await deleteFirebaseUser(uid);
  return { families, firebase: firebase.result };
}
