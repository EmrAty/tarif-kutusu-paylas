import { redisGetJSON, redisSetJSON } from "./redis.js";
import { getProfile } from "./profile.js";

export function membersKey(id) {
  return `family:${id}:members`;
}

export function familyRecipesKey(id) {
  return `family:${id}:recipes`;
}

const FAMILY_ID_RE = /^[\w-]{1,64}$/;

export async function removeMemberFromFamily(uid, familyId) {
  const members = await redisGetJSON(membersKey(familyId), {});
  if (members[uid]) {
    delete members[uid];
    await redisSetJSON(membersKey(familyId), members);
  }
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
