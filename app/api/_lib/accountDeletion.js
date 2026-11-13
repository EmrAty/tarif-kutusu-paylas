import { redisGet, redisSet, redisDel, redisGetJSON, redisCommand } from "./redis.js";
import { getProfile, profileKey } from "./profile.js";
import { removeMemberFromFamily, deleteFamilyCompletely, isFamilyDeleting, handOffOwnership, ensureOwner } from "./families.js";
import { fcmTokensKey, pushTargetsKey, releasePushOwnership } from "./fcm.js";
import { bucketAuxKeys } from "./versionedBucket.js";
import { getServiceAccountToken } from "./googleAuth.js";
import { deleteMergedGuestsOf, deleteOwnMergeState } from "./guestMerge.js";

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

export const deletedMarkerKey = (uid) => `deleted-account:${uid}`;

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
    pushTargetsKey(uid),
    `user:${uid}:pendingJobRecipes`,
    `user:${uid}:recentlyRemovedRecipes`,
    `user:${uid}:recentlyRemovedRecipes:v2`,
  ];
}

// Paylaşım paneli job kayıtları (TTL'li ama kaynak linki içeriyor).
function jobKeyPatterns(uid) {
  // push-sent: job başına bildirim tekrar işareti (içerik yok, 7 gün TTL) —
  // yine de hesapla birlikte silinir.
  return [`job:${uid}:*`, `job-req:${uid}:*`, `job-url:${uid}:*`, `push-sent:${uid}:*`, `user:${uid}:*`];
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

// Kullanıcıyı ailesinden çıkarır. Başka üye kalmadıysa aile tamamen silinir;
// kaldıysa aile ve ortak listeler dokunulmadan kalır, sahiplik devredilir.
async function leaveFamilyForDeletion(uid, id) {
  const meta = await redisGetJSON(familyMetaKey(id), null);
  if (!meta) return { id, result: "missing" };
  // Sahiplik ÖNCE devredilir (en eski katılan; Grup 4: meta artık atomik
  // yazılıyor, eskiden düz SET silme işaretini ezebiliyordu).
  const handedTo = await handOffOwnership(uid, id);
  // Atomik: aynı anda katılan başka bir üye listeden düşmez.
  const { value: members } = await removeMemberFromFamily(uid, id);
  if (Object.keys(members).length === 0 || isFamilyDeleting(meta)) {
    // Ortak silme (işaret → üyeleri işaretten sonra oku → profiller → veri →
    // meta): aynı anda katılan biri hayalet kayıtla kalmaz.
    await deleteFamilyCompletely(id, { skipUid: uid });
    return { id, result: "deleted" };
  }
  // Devirden sonra yeni sahip tam bu sırada ayrıldıysa en eski üyeye geçer.
  await ensureOwner(id);
  if (handedTo || meta.ownerUid === uid) return { id, result: "ownership_transferred" };
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

// keepGuestMergeState: yalnızca misafir taşımasının temizlik adımı kullanır (taşıma
// kaydı, dizine "tamamlandı" yazılana kadar dursun).
export async function deleteAccount(uid, { keepGuestMergeState = false } = {}) {
  if (typeof uid !== "string" || !UID_RE.test(uid)) throw new Error("Geçersiz kullanıcı kimliği.");

  await redisSet(deletedMarkerKey(uid), String(Date.now()), DELETED_MARKER_TTL);

  // Grup 5 (B2): bu hesaba taşınan (ya da taşınması süren) misafir hesapların
  // kalıntıları ve taşıma kayıtları da silinir; misafirin kendi açık bileti de.
  const mergedGuests = await deleteMergedGuestsOf(uid);
  if (!keepGuestMergeState) await deleteOwnMergeState(uid);

  // Bozuk profil (Grup 5'te getProfile artık 502 fırlatıyor) hesap silmeyi
  // engellemez: aile üyelikleri profilden okunamaz, kalan kişisel veri yine silinir.
  const profile = await getProfile(uid).catch((e) => {
    if (e.code !== "profile_unreadable") throw e;
    console.warn(JSON.stringify({ tag: "account-delete", warning: "profile unreadable; family memberships skipped" }));
    return { families: [] };
  });
  const familyIds = Array.isArray(profile.families) ? profile.families : [];
  const families = [];
  for (const id of familyIds) {
    families.push(await leaveFamilyForDeletion(uid, id));
  }

  // Cihaz token'larının sahiplik işaretleri (push-owner:*) yalnızca hâlâ bu
  // hesaba aitse kaldırılır. Hata silmeyi durdurmaz: kalan işaret silinmiş
  // uid'yi gösterir ve hiçbir hesaba bildirim götürmez.
  await releasePushOwnership(uid).catch(() => {});
  await deleteKeys(personalKeys(uid));
  const scanned = [];
  for (const pattern of jobKeyPatterns(uid)) {
    scanned.push(...(await scanKeys(pattern)));
  }
  await deleteKeys(scanned.filter((key) => key !== profileKey(uid)));
  await redisDel(profileKey(uid));

  const firebase = await deleteFirebaseUser(uid);
  return { families, firebase: firebase.result, ...(mergedGuests.length ? { mergedGuests: mergedGuests.length } : {}) };
}
