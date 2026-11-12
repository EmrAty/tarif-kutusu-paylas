import { redisGet, redisGetJSON, redisDel, redisCommand } from "./redis.js";
import { getProfile, updateProfile } from "./profile.js";
import { mutateBucket, bucketAuxKeys } from "./versionedBucket.js";

export function familyMetaKey(id) {
  return `family:${id}:meta`;
}
export function inviteKey(code) {
  return `invite:${code}:family`;
}
const FAMILY_BUCKETS = ["recipes", "shopping-list", "pantry-items"];

// Silme sürüyor (ya da yarıda kalmış): erişim, katılma ve yeni veri yok.
export function isFamilyDeleting(meta) {
  return !!(meta && meta.deleting);
}

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

// Aile kaydının (meta) yalnızca sürüm/yedek anahtarları; meta'nın kendisi
// silmede EN SON silinir.
export function metaAuxKeys(id) {
  return bucketAuxKeys(familyMetaKey(id));
}

function corruptMeta() {
  const err = new Error("Aile kaydı okunamadı.");
  err.status = 502;
  err.code = "family_unreadable";
  return err;
}

// Kayıt yoksa null; bozuk kayıt hata (asla "yok" sayılmaz).
export function parseMeta(raw) {
  if (raw == null) return null;
  let value;
  try {
    value = JSON.parse(raw);
  } catch (e) {
    throw corruptMeta();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw corruptMeta();
  return value;
}

// Aile kaydı (meta: ad, sahip, davet kodu, silme işareti) değişiklikleri
// Grup 4'ten itibaren atomik karşılaştır-ve-yaz ile. Eskiden düz SET idi:
// sahiplik devri / kod yenileme ile silme işareti aynı anda yazılırsa biri
// diğerini ezebiliyordu (ör. `deleting` işareti kaybolup silinmekte olan
// aileye yeniden katılım açılabilirdi). mutate(meta|null) yeni kaydı ya da
// değişiklik yoksa undefined döndürür.
export async function updateMeta(id, mutate) {
  return mutateBucket(familyMetaKey(id), { parse: parseMeta, mutate });
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

// Görünen ad / aile adı: kontrol ve yön karakterleri atılır, boşluklar
// sadeleşir, uzunluk sınırlanır (eskiden sınırsızdı).
export const MEMBER_NAME_MAX = 40;
export const FAMILY_NAME_MAX = 40;
export function cleanName(value, max) {
  if (typeof value !== "string") return "";
  const plain = value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, "").replace(/\s+/g, " ").trim();
  return [...plain].slice(0, max).join("").trim();
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

// Plus kapalı üyenin ailesi KİLİTLİ (Grup 4 ürün kararı): üyelik ve sahiplik
// korunur, ama aile içeriğine erişim ve aile işlemleri kapalı. Plus yeniden
// açılınca hiçbir taşıma/davet gerekmeden her şey erişilebilir olur.
export const FAMILY_LOCKED_CODE = "family_locked";
export function familyLockedError(message = "Aile içeriği Plus üyelere açık. Plus'ı açınca ailen kaldığı yerden devam eder.") {
  const err = new Error(message);
  err.status = 403;
  err.code = FAMILY_LOCKED_CODE;
  return err;
}

// Aile verisine (okuma/yazma, çeviri, bildirim) erişim için ortak kontrol.
// Kimlik doğrulaması tek başına yetmez; üç kayıt birlikte doğrulanır:
// kullanıcının profilinde aile var, aile kaydı (meta) var VE ailenin üye
// listesinde kullanıcı var. Biri eksikse erişim yok (fail-closed).
// Grup 4: üyelik doğrulandıktan sonra Plus da istenir (403 family_locked).
// requirePlus: false yalnızca kilitli kart özeti için (api/data.js summary).
// profile verilirse yeniden okunmaz.
export async function assertFamilyAccess(uid, familyId, profile, { requirePlus = true } = {}) {
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
  if (!meta || isFamilyDeleting(meta)) throw accessError(404, "Aile bulunamadı.");
  if (!members || typeof members !== "object" || !members[uid]) {
    throw accessError(403, "Bu ailenin üyesi değilsin.");
  }
  if (requirePlus && !p.isPlus) throw familyLockedError();
  return { profile: p, meta, members };
}

// Kullanıcının erişimi gerçekten doğrulanan aileleri (profil + meta + üyelik
// + Plus; kilitli aileler dışarıda kalır).
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
  if (!meta || isFamilyDeleting(meta)) throw accessError(404, "Aile bulunamadı.");
  if (!members || !members[uid]) throw accessError(403, "Bu ailenin üyesi değilsin.");
  return { profile, meta };
}

// ---------------------------------------------------------------------------
// Aile silme ve hayalet kayıtlar (Grup 3)
//
// Yarış: kurucu silerken başka biri katılırsa, eski kodda katılma 200 dönüp
// aile silinebiliyor, katılanın profilinde silinmiş aile kalıyordu ("hayalet":
// arayüzde görünmüyor ama 2'lik aile sınırından yer yiyor).
//
// Kural (iki taraflı kontrol):
//   silme : 1) meta'ya `deleting` işareti  2) davet kodu silinir
//           3) üye listesi İŞARETTEN SONRA okunur, her üyenin profilinden aile
//              çıkarılır  4) veri + üye listesi silinir  5) meta en son
//   katılma: üye listesi + profil yazıldıktan SONRA meta yeniden okunur; yoksa
//           ya da `deleting` ise katılma kendini geri alır (404).
// Katılmanın üye yazımı ya silmenin 3. adımından önce olur (silme onu görür
// ve profilini temizler) ya da sonra olur (o zaman katılmanın son kontrolü
// işareti görür). İkisi birden kaçıramaz. Yarıda kalan silme işaretli kalır;
// kurucu tekrar deneyebilir, üyeler ayrılabilir.
// ---------------------------------------------------------------------------

export function familyDataKeys(id) {
  return [
    ...FAMILY_BUCKETS.flatMap((b) => {
      const key = `family:${id}:${b}`;
      return [key, ...bucketAuxKeys(key)];
    }),
    `family:${id}:pendingJobRecipes`, // eski sürümden kalmış olabilecek işaretçi
    ...membersKeysWithAux(id),
  ];
}

export const dropFamilyFromProfile = (uid, id) =>
  updateProfile(uid, (p) => (p.families.includes(id) ? { ...p, families: p.families.filter((f) => f !== id) } : undefined));

// lastUid: profili EN SON güncellenecek üye (kurucu — yarıda kalırsa tekrar
// deneyebilsin). skipUid: profiline hiç dokunulmayacak üye (hesabı silinen).
export async function deleteFamilyCompletely(id, { lastUid = null, skipUid = null } = {}) {
  // İşaret atomik (Grup 4): aynı anda yapılan kod yenileme / sahiplik devri
  // onu ezemez; işaretten sonra kod yenilenemez (yenileme işareti görüp
  // vazgeçer ve yazdığı yeni davet anahtarını siler).
  const { value: meta } = await updateMeta(id, (m) => (m && !m.deleting ? { ...m, deleting: true, deletingAt: Date.now() } : undefined));
  if (!meta) return { result: "missing" };
  if (meta.inviteCode) await redisDel(inviteKey(meta.inviteCode));
  // İşaretten SONRA okunur (bozuksa silme durur; tekrar denenebilir).
  const members = parseMembers(await redisGet(membersKey(id)));
  const uids = Object.keys(members).filter((u) => u !== skipUid && u !== lastUid);
  await Promise.all(uids.map((u) => dropFamilyFromProfile(u, id)));
  if (lastUid && lastUid !== skipUid) await dropFamilyFromProfile(lastUid, id);
  const keys = [...familyDataKeys(id), ...metaAuxKeys(id)];
  for (let i = 0; i < keys.length; i += 50) await redisCommand(["DEL", ...keys.slice(i, i + 50)]);
  // meta en son: yarıda kalırsa aile işaretli hâlde bulunup tekrar silinebilir.
  await redisDel(familyMetaKey(id));
  return { result: "deleted" };
}

// Katılmanın son kontrolü (bkz. yukarıdaki kural). Aile yoksa ya da
// siliniyorsa bu kullanıcının az önce yazdığı üyelik ve profil kaydı geri
// alınır; true döner. Okuma hatası fırlar (üyelik silinmez).
//
// Grup 4: katılmada kullanılan kod bu arada yenilendiyse de (`code` verilirse)
// katılma geri alınır. Üye çıkarma önce kodu yeniler, sonra üyeyi siler; eski
// kodla yarışan bir yeniden katılma böylece çıkarılan üyeyi geri sokamaz. Bu
// durumda YALNIZCA bu katılmanın eklediği kayıtlar geri alınır (`added`),
// önceden var olan üyelik (onarım) silinmez.
export async function undoJoinIfFamilyGone(uid, id, { code = null, added = null } = {}) {
  const meta = await redisGetJSON(familyMetaKey(id), null);
  if (meta && !isFamilyDeleting(meta)) {
    if (!code || meta.inviteCode === code) return false;
    if (added?.member) await removeMemberFromFamily(uid, id).catch(() => {});
    if (added?.profile) await dropFamilyFromProfile(uid, id).catch(() => {});
    return true;
  }
  await removeMemberFromFamily(uid, id).catch(() => {});
  await dropFamilyFromProfile(uid, id).catch(() => {});
  if (!meta) {
    // Silme üye listesini çoktan sildiyse katılma onu boş olarak yeniden
    // yaratmış olabilir: sahipsiz boş liste kalmasın.
    const rest = await redisGetJSON(membersKey(id), null).catch(() => null);
    if (rest && typeof rest === "object" && Object.keys(rest).length === 0) {
      for (const key of membersKeysWithAux(id)) await redisDel(key).catch(() => {});
    }
  }
  return true;
}

// Hayalet temizliği: profildeki aile kimliklerinden, aile kaydı (meta) BAŞARILI
// bir okumada gerçekten bulunmayanları kullanıcının KENDİ profilinden çıkarır.
// Okuma hatası fırlar — "okunamadı" asla "silinmiş" sayılmaz. Yalnızca erişim
// azaltır, hiçbir üyelik vermez. Kalan aile kimliklerini döndürür.
export async function pruneDeletedFamilies(uid, familyIds) {
  if (!familyIds.length) return familyIds;
  const metas = await redisCommand(["MGET", ...familyIds.map(familyMetaKey)]);
  if (!Array.isArray(metas) || metas.length !== familyIds.length) {
    throw Object.assign(new Error("Aile bilgisi okunamadı."), { status: 502 });
  }
  const gone = familyIds.filter((id, i) => metas[i] === null);
  if (!gone.length) return familyIds;
  const updated = await updateProfile(uid, (p) => {
    const next = p.families.filter((f) => !gone.includes(f));
    return next.length === p.families.length ? undefined : { ...p, families: next };
  });
  return updated.value.families;
}

// ---------------------------------------------------------------------------
// Sahiplik (Grup 4)
//
// Kural: ailede en az bir üye varken sahip daima o üyelerden biridir.
//   - Sahip ayrılırken (elle, Plus kapanınca, hesap silinince) sahiplik ÖNCE
//     devredilir: seçtiği üyeye, seçmediyse en eski katılana (joinedAt,
//     eşitlikte uid).
//   - Üye listesini küçülten her işlemden sonra `ensureOwner` çalışır: sahip
//     artık üye değilse (eşzamanlı ayrılma, eski kayıt) sahiplik en eski üyeye
//     geçer. "Devret ↔ hedef ayrılıyor" yarışında iki taraf da işlemden sonra
//     kontrol ettiği için biri mutlaka görür.
//   - Hiç üye kalmamış aile için sahip seçilemez; böyle bir aileye geçerli
//     kodla ilk katılan, ilk aile listesi açılışında sahip olur.
// ---------------------------------------------------------------------------

export function oldestMember(members, excludeUid = null) {
  const entries = Object.entries(members).filter(([uid]) => uid !== excludeUid);
  if (!entries.length) return null;
  entries.sort(([uidA, a], [uidB, b]) => (a?.joinedAt ?? Infinity) - (b?.joinedAt ?? Infinity) || uidA.localeCompare(uidB));
  return entries[0][0];
}

// Meta + üye listesi tek MGET ile (aynı anın görüntüsü). Bozuk kayıt hata.
export async function readFamilyState(id) {
  const result = await redisCommand(["MGET", familyMetaKey(id), membersKey(id)]);
  if (!Array.isArray(result) || result.length !== 2) throw corruptMeta();
  return { meta: parseMeta(result[0] ?? null), members: parseMembers(result[1] ?? null) };
}

// Sahip üye listesinde değilse en eski üyeye devreder. Güncel sahibi (ya da
// sahip seçilemiyorsa null) döndürür.
export async function ensureOwner(id) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { meta, members } = await readFamilyState(id);
    if (!meta || isFamilyDeleting(meta)) return null;
    if (members[meta.ownerUid]) return meta.ownerUid;
    const next = oldestMember(members);
    if (!next) return null;
    const result = await updateMeta(id, (m) => (m && !m.deleting && m.ownerUid === meta.ownerUid ? { ...m, ownerUid: next } : undefined));
    if (result.changed) return next;
    // Sahip bu arada başka bir işlemle değişti: yeniden bak.
  }
  return null;
}

// `uid` sahipse ve ailede başka üye varsa sahipliği devreder (tercih edilen
// üye geçerliyse ona, değilse en eski katılana). Devredilen uid ya da null.
export async function handOffOwnership(uid, id, preferredUid = null) {
  const { meta, members } = await readFamilyState(id);
  if (!meta || isFamilyDeleting(meta) || meta.ownerUid !== uid) return null;
  const next = preferredUid && preferredUid !== uid && members[preferredUid] ? preferredUid : oldestMember(members, uid);
  if (!next) return null;
  await updateMeta(id, (m) => (m && !m.deleting && m.ownerUid === uid ? { ...m, ownerUid: next } : undefined));
  return next;
}

// Kullanıcıyı aileden çıkarır (elle ayrılma): sahiplik devri → üye listesi →
// profil → sahip kontrolü. Plus kapanması artık kimseyi aileden çıkarmaz
// (aile kilitlenir, bkz. assertFamilyAccess).
export async function leaveFamily(uid, id, { preferredOwner = null } = {}) {
  await handOffOwnership(uid, id, preferredOwner);
  await removeMemberFromFamily(uid, id);
  await dropFamilyFromProfile(uid, id);
  await ensureOwner(id);
}
