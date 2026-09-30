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
