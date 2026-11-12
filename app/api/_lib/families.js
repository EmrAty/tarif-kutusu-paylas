import { redisGetJSON } from "./redis.js";
import { getProfile } from "./profile.js";
import { mutateBucket, bucketAuxKeys } from "./versionedBucket.js";

export function membersKey(id) {
  return `family:${id}:members`;
}

export function familyRecipesKey(id) {
  return `family:${id}:recipes`;
}

// Üye listesi silinirken birlikte silinmesi gereken anahtarlar (sürüm + yedek).
export function membersKeysWithAux(id) {
  return [membersKey(id), ...bucketAuxKeys(membersKey(id))];
}

const FAMILY_ID_RE = /^[\w-]{1,64}$/;

function corruptMembers() {
  const err = new Error("Aile üye listesi okunamadı.");
  err.status = 502;
  err.code = "members_unreadable";
  return err;
}

export function parseMembers(raw) {
  if (raw == null) return {};
  let value;
  try {
    value = JSON.parse(raw);
  } catch (e) {
    throw corruptMembers();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw corruptMembers();
  return value;
}

// Üye listesi değişiklikleri atomik karşılaştır-ve-yaz ile (Grup 1 motoru).
// Eskiden "oku → değiştir → geri yaz" idi: bir üye katılırken başka bir üyenin
// görünen ad güncellemesi katılanı listeden düşürebiliyordu (Grup 3 denetimi).
// mutate(members) yeni nesneyi ya da değişiklik yoksa undefined döndürür.
export async function updateMembers(familyId, mutate) {
  return mutateBucket(membersKey(familyId), { parse: parseMembers, mutate });
}

export async function removeMemberFromFamily(uid, familyId) {
  return updateMembers(familyId, (members) => {
    if (!members[uid]) return undefined;
    const next = { ...members };
    delete next[uid];
    return next;
  });
}

function accessError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Aile verisine (okuma/yazma, çeviri, bildirim) erişim için ortak kontrol.
// Kimlik doğrulaması tek başına yetmez; üç kayıt birlikte doğrulanır:
// kullanıcının profilinde aile var, aile kaydı (meta) var VE ailenin üye
// listesinde kullanıcı var. Biri eksikse erişim yok (fail-closed). Plus
// şartı burada YOK: Plus'ı kapanan üye ailesinin verisini görmeye devam eder
// (eski davranış); yalnızca share-panel job'u Plus ister (assertFamilyMember).
// profile verilirse yeniden okunmaz.
export async function assertFamilyAccess(uid, familyId, profile) {
  if (typeof familyId !== "string" || !FAMILY_ID_RE.test(familyId)) {
    throw accessError(400, "Geçersiz aile.");
  }
  const p = profile || (await getProfile(uid));
  if (!Array.isArray(p.families) || !p.families.includes(familyId)) {
    throw accessError(403, "Bu ailenin üyesi değilsin.");
  }
  const [meta, members] = await Promise.all([
    redisGetJSON(`family:${familyId}:meta`, null),
    redisGetJSON(membersKey(familyId), {}),
  ]);
  if (!meta) throw accessError(404, "Aile bulunamadı.");
  if (!members || typeof members !== "object" || !members[uid]) {
    throw accessError(403, "Bu ailenin üyesi değilsin.");
  }
  return { profile: p, meta, members };
}

// Kullanıcının erişimi gerçekten doğrulanan aileleri (profil + meta + üyelik).
// Doğrulanamayan aile sessizce dışarıda kalır; Redis hatası yukarı fırlar.
export async function verifiedFamilyIds(uid, profile) {
  const p = profile || (await getProfile(uid));
  const ids = Array.isArray(p.families) ? p.families : [];
  const checks = await Promise.all(
    ids.map((id) =>
      assertFamilyAccess(uid, id, p).then(
        () => id,
        (e) => {
          if (e && (e.status === 400 || e.status === 403 || e.status === 404)) return null;
          throw e;
        }
      )
    )
  );
  return checks.filter(Boolean);
}

// Bir aileye tarif yazmadan önce sunucu tarafı kontrol: kullanıcı Plus mı,
// aile gerçekten var mı, kullanıcı hem kendi profilinde hem ailenin üye
// listesinde o ailenin üyesi mi. Başarısızsa status'lu hata fırlatır — çağıran
// taraf bunu ASLA kişisel kayda düşürmemeli. Profil ve aile kaydı
// api/families.js'in yazdığı aynı anahtarlardan okunuyor.
export async function assertFamilyMember(uid, familyId) {
  if (typeof familyId !== "string" || !FAMILY_ID_RE.test(familyId)) {
    throw accessError(400, "Geçersiz aile.");
  }
  const profile = await getProfile(uid);
  if (!profile.isPlus) throw accessError(403, "Aile özelliği Plus üyelere özeldir.");
  if (!Array.isArray(profile.families) || !profile.families.includes(familyId)) {
    throw accessError(403, "Bu ailenin üyesi değilsin.");
  }
  const [meta, members] = await Promise.all([
    redisGetJSON(`family:${familyId}:meta`, null),
    redisGetJSON(membersKey(familyId), {}),
  ]);
  if (!meta) throw accessError(404, "Aile bulunamadı.");
  if (!members || !members[uid]) throw accessError(403, "Bu ailenin üyesi değilsin.");
  return { profile, meta };
}
