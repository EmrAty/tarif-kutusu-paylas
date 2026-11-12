import { requireUser } from "./_lib/auth.js";
import { redisGetJSON, redisDel, redisCommand } from "./_lib/redis.js";
import { getProfile, updateProfile, MAX_FAMILIES } from "./_lib/profile.js";
import {
  familyMetaKey,
  inviteKey,
  membersKey,
  membersKeysWithAux,
  metaAuxKeys,
  updateMembers,
  updateMeta,
  removeMemberFromFamily,
  dropFamilyFromProfile,
  isFamilyDeleting,
  deleteFamilyCompletely,
  undoJoinIfFamilyGone,
  pruneDeletedFamilies,
  readFamilyState,
  ensureOwner,
  oldestMember,
  leaveFamily,
  cleanName,
  MEMBER_NAME_MAX,
  FAMILY_NAME_MAX,
} from "./_lib/families.js";
import { generateInviteCode, normalizeInviteCode, assertJoinAllowed, recordJoinFailure } from "./_lib/inviteCodes.js";
import { clientIp } from "./_lib/aiGuard.js";

// Aile uç noktası.
//   GET                         aile özetleri (+ görünen ad senkronu)
//   POST action=create          Plus
//   POST action=join            Plus; deneme sınırlı (bkz. _lib/inviteCodes.js)
//   POST action=leave           herkes; sahip ayrılırken sahiplik devredilir
//   POST action=delete          yalnızca sahip
//   POST action=remove          yalnızca sahip — üyeyi çıkarır, kodu yeniler (Grup 4)
//   POST action=transfer        yalnızca sahip — sahipliği devreder (Grup 4)
//   POST action=rotateCode      yalnızca sahip — yeni davet kodu (Grup 4)
// Yalnızca yeni aileye girmek (create/join) Plus ister; mevcut ailedeki
// yönetim işlemleri (ayrılma, silme, çıkarma, devir, kod yenileme) istemez —
// Plus'ı kapanan sahip de ailesini düzenleyebilsin, sahipsiz aile kalmasın.

function familyId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function httpError(status, message, code) {
  return Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
}

// Yeni davet kodunu bu aileye ayırır (SET NX: başka ailenin koduyla çakışmaz).
async function claimInviteCode(id) {
  for (let i = 0; i < 5; i++) {
    const code = generateInviteCode();
    const ok = await redisCommand(["SET", inviteKey(code), JSON.stringify(id), "NX"]);
    if (ok === "OK") return code;
  }
  throw httpError(502, "Davet kodu oluşturulamadı.");
}

// Kod yenileme: yeni kod ayrılır → meta atomik güncellenir (yalnızca sahip,
// silinmiyorsa) → eski kodun anahtarı silinir. Katılma ayrıca meta'daki kodla
// karşılaştırdığı için eski anahtar silinemese bile eski kod çalışmaz.
async function rotateInviteCode(id, uid) {
  const code = await claimInviteCode(id);
  let previous = null;
  try {
    await updateMeta(id, (m) => {
      if (!m || isFamilyDeleting(m)) throw httpError(404, "Aile bulunamadı.");
      if (m.ownerUid !== uid) throw httpError(403, "Bu işlemi yalnızca aile sahibi yapabilir.", "not_owner");
      previous = m.inviteCode || null;
      return { ...m, inviteCode: code, inviteRotatedAt: Date.now() };
    });
  } catch (e) {
    await redisDel(inviteKey(code)).catch(() => {});
    throw e;
  }
  if (previous && previous !== code) await redisDel(inviteKey(previous)).catch(() => {});
  return code;
}

// Sahip işlemleri için ortak kontrol: profil + meta + üye listesi + sahiplik.
async function requireOwner(uid, id, profile) {
  if (typeof id !== "string" || !profile.families.includes(id)) throw httpError(403, "Bu ailenin üyesi değilsin.");
  const { meta, members } = await readFamilyState(id);
  if (!meta || isFamilyDeleting(meta)) throw httpError(404, "Aile bulunamadı.");
  if (!members[uid]) throw httpError(403, "Bu ailenin üyesi değilsin.");
  if (meta.ownerUid !== uid) throw httpError(403, "Bu işlemi yalnızca aile sahibi yapabilir.", "not_owner");
  return { meta, members };
}

function targetMember(body, uid, members) {
  const target = body?.memberUid;
  if (typeof target !== "string" || !UID_RE.test(target)) throw httpError(400, "Geçersiz üye.");
  if (target === uid) throw httpError(400, "Bu işlem kendi hesabın için yapılamaz.");
  if (!members[target]) throw httpError(404, "Bu kişi ailede değil.", "member_not_found");
  return target;
}

// Erişimi olmayan aile özetleri yalnızca kimlik + ad + durum taşır; davet kodu,
// sahip ve üye listesi gösterilmez (aksi hâlde "profilde yazıyor" tek başına
// üyelik vermiş olurdu). `members: []`, `inviteCode: null`, `ownerUid: null`
// alanları eski web paketi uyumluluğu içindir: production'daki paket her
// aile için `f.members.map(...)` çağırıyor; alan yoksa Aileler ekranı çöker.
//   membership "verified"   — tam özet
//   membership "unverified" — profilde var, üye listesinde yok (yeniden katıl / ayrıl)
//   membership "deleting"   — silme sürüyor ya da yarıda kaldı (sahip
//                             tamamlar, diğerleri ayrılır); sahip kimliği yalnızca
//                             doğrulanmış üyeye gösterilir.
//
// Grup 4 — gizlilik: üye satırı yalnızca {uid, name, isOwner, isAnonymous,
// joinedAt} taşır. E-posta diğer üyelere hiç gönderilmez (eskiden her üyenin
// e-postası tüm aileye dönüyordu); adı olmayan üye istemcide "İsimsiz üye"
// olarak görünür. uid, sahip işlemlerinin (çıkar / devret) hedefi için gerekli.
async function loadFamilySummary(id, uid, { repairOwner = true } = {}) {
  let [meta, members] = await Promise.all([redisGetJSON(familyMetaKey(id), null), redisGetJSON(membersKey(id), {})]);
  if (!meta) return null;
  const isMember = !!(members && typeof members === "object" && members[uid]);
  const restricted = (membership, extra = {}) => ({ id, name: meta.name, membership, inviteCode: null, ownerUid: null, members: [], ...extra });
  if (isFamilyDeleting(meta)) return restricted("deleting", isMember || meta.ownerUid === uid ? { ownerUid: meta.ownerUid } : {});
  if (!isMember) return restricted("unverified");
  // Eski kayıt / yarıda kalmış işlem: sahip artık üye değilse en eski üyeye
  // devredilir (aile sahipsiz görünmesin).
  if (repairOwner && !members[meta.ownerUid]) {
    const owner = await ensureOwner(id).catch(() => null);
    if (owner) meta = { ...meta, ownerUid: owner };
  }
  const list = Object.entries(members)
    .map(([memberUid, info]) => ({
      uid: memberUid,
      name: cleanName(info?.name, MEMBER_NAME_MAX) || null,
      isOwner: memberUid === meta.ownerUid,
      isAnonymous: !!info?.isAnonymous,
      joinedAt: Number.isFinite(info?.joinedAt) ? info.joinedAt : null,
    }))
    .sort((a, b) => (a.joinedAt ?? Infinity) - (b.joinedAt ?? Infinity) || a.uid.localeCompare(b.uid));
  return {
    id,
    name: meta.name,
    inviteCode: meta.inviteCode,
    ownerUid: meta.ownerUid,
    isOwner: meta.ownerUid === uid,
    membership: "verified",
    members: list,
  };
}

// Kullanıcı görünen ismini (Ayarlar'da girdiği, cihazda saklanan isim) sonradan
// değiştirebiliyor — her aile listesi çekilişinde kendi üyelik kaydındaki ismi
// güncel tutuyor ki aile üyeleri gerçek ismini görsün.
// Atomik güncelleme: aynı anda katılan üyeyi listeden düşüremez. Yalnızca
// zaten üye olan kaydı günceller (asla üye eklemez). Kozmetik olduğu için
// hatası listeyi bozmaz.
// Grup 4: aynı yazımda eski kayıtlarda saklanan e-posta alanları da silinir
// (artık hiçbir yerde kullanılmıyor; veri azaltma). Değişiklik yoksa yazılmaz.
async function syncDisplayName(uid, familyIds, name) {
  await Promise.all(
    familyIds.map((id) =>
      updateMembers(id, (members) => {
        if (!members[uid]) return undefined;
        const wantName = name && members[uid].name !== name;
        const hasEmail = Object.values(members).some((m) => m && typeof m === "object" && "email" in m);
        if (!wantName && !hasEmail) return undefined;
        const next = {};
        for (const [memberUid, info] of Object.entries(members)) {
          const { email, ...rest } = info && typeof info === "object" ? info : {};
          next[memberUid] = memberUid === uid && name ? { ...rest, name } : rest;
        }
        return next;
      }).catch(() => {})
    )
  );
}

function sendError(res, e) {
  if (e.retryAfter) res.setHeader?.("Retry-After", String(e.retryAfter));
  res.status(e.status || 502).json({
    error: e.message || "İşlem tamamlanamadı.",
    ...(e.code ? { code: e.code } : {}),
    ...(e.retryAfter ? { retryAfter: e.retryAfter } : {}),
  });
}

export default async function handler(req, res) {
  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    res.status(e.status || 401).json({ error: e.message });
    return;
  }

  try {
    await handle(req, res, user);
  } catch (e) {
    sendError(res, e);
  }
}

async function handle(req, res, user) {
  if (req.method === "GET") {
    const profile = await getProfile(user.uid);
    // Silinmiş ailenin (aile kaydı gerçekten yok) profilde kalan kimliği temizlenir.
    const familyIds = await pruneDeletedFamilies(user.uid, profile.families);
    const name = cleanName(req.query.name, MEMBER_NAME_MAX);
    await syncDisplayName(user.uid, familyIds, name);
    const families = (await Promise.all(familyIds.map((id) => loadFamilySummary(id, user.uid)))).filter(Boolean);
    res.status(200).json({ isPlus: profile.isPlus, families });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const body = req.body || {};
  const { action } = body;
  const profile = await getProfile(user.uid);
  // Hayalet aile 2'lik sınırdan yer yemesin (yalnızca kesin silinmişler).
  if (action === "create" || action === "join") profile.families = await pruneDeletedFamilies(user.uid, profile.families);

  // Yalnızca yeni bir aile kurmak/katılmak Plus gerektiriyor. Ayrılmak ve
  // kendi ailesini yönetmek serbest: aksi halde Plus'ı kapatan biri ailede
  // takılı kalır ya da aile sahipsiz/yönetilemez olurdu.
  if (!profile.isPlus && (action === "create" || action === "join")) {
    res.status(403).json({ error: "Aile özelliği Plus üyelere özeldir." });
    return;
  }

  const memberRecord = () => ({
    name: cleanName(body.memberName, MEMBER_NAME_MAX) || null,
    isAnonymous: user.isAnonymous,
    joinedAt: Date.now(),
  });

  // Profile aile ekler (atomik). Plus ve sınır, güncel profil üzerinde
  // yeniden kontrol edilir (arada başka bir katılma olmuş olabilir).
  const addFamilyToProfile = (id) =>
    updateProfile(user.uid, (p) => {
      if (p.families.includes(id)) return undefined;
      if (!p.isPlus) throw httpError(403, "Aile özelliği Plus üyelere özeldir.");
      if (p.families.length >= MAX_FAMILIES) throw httpError(403, `En fazla ${MAX_FAMILIES} aileye üye olabilirsin.`);
      return { ...p, families: [...p.families, id] };
    });

  if (action === "create") {
    const name = cleanName(body.name, FAMILY_NAME_MAX);
    if (!name) {
      res.status(400).json({ error: "Aileye bir isim vermen lazım." });
      return;
    }
    if (profile.families.length >= MAX_FAMILIES) {
      res.status(403).json({ error: `En fazla ${MAX_FAMILIES} aileye üye olabilirsin.` });
      return;
    }
    const id = familyId();
    // Kod önce ayrılır; aile kaydı (meta) yazılmadan ve kodla eşleşmeden
    // kimse katılamaz.
    const code = await claimInviteCode(id);
    try {
      await updateMeta(id, (m) => {
        if (m) throw httpError(409, "Aile oluşturulamadı, tekrar dene.");
        return { name, ownerUid: user.uid, createdAt: Date.now(), inviteCode: code };
      });
      await updateMembers(id, () => ({ [user.uid]: memberRecord() }));
      await addFamilyToProfile(id);
    } catch (e) {
      // Profile eklenemediyse yarım aile bırakılmaz.
      await redisCommand(["DEL", inviteKey(code), ...membersKeysWithAux(id), ...metaAuxKeys(id), familyMetaKey(id)]).catch(() => {});
      throw e;
    }
    res.status(200).json(await loadFamilySummary(id, user.uid));
    return;
  }

  if (action === "join") {
    if (typeof body.code !== "string" || !body.code.trim()) {
      res.status(400).json({ error: "Davet kodunu gir." });
      return;
    }
    const ip = clientIp(req);
    await assertJoinAllowed({ uid: user.uid, ip });
    const code = normalizeInviteCode(body.code);
    const invalid = async (count = true) => {
      if (count) await recordJoinFailure({ uid: user.uid, ip });
      res.status(404).json({ error: "Bu davet kodu geçersiz.", code: "invite_invalid" });
    };
    // Biçimi bile tutmayan giriş sorgulanmaz (yazım hatası, sayaç artmaz).
    if (!code) return invalid(false);
    const id = await redisGetJSON(inviteKey(code), null);
    const meta = typeof id === "string" ? await redisGetJSON(familyMetaKey(id), null) : null;
    // Kod meta'daki güncel kodla da eşleşmeli: yenilenmiş (eski) kodun
    // silinememiş anahtarı tek başına katılma sağlamaz.
    if (!meta || isFamilyDeleting(meta) || meta.inviteCode !== code) return invalid();
    const members = await redisGetJSON(membersKey(id), {});
    const inProfile = profile.families.includes(id);
    const inMembers = !!(members && members[user.uid]);
    if (inProfile && inMembers) {
      res.status(400).json({ error: "Bu ailenin zaten üyesisin." });
      return;
    }
    if (!inProfile && profile.families.length >= MAX_FAMILIES) {
      res.status(403).json({ error: `En fazla ${MAX_FAMILIES} aileye üye olabilirsin.` });
      return;
    }
    // Önce üye listesi, sonra profil. Geçerli davet kodu üyeliğin kanıtıdır;
    // kaydın bir yarısı eksikse (eski yarış ya da yarıda kalmış işlem) aynı
    // kodla yeniden katılmak onu onarır. Var olan katılma tarihi korunur.
    const added = await updateMembers(id, (m) => (m[user.uid] ? undefined : { ...m, [user.uid]: memberRecord() }));
    let profileAdded;
    try {
      profileAdded = await addFamilyToProfile(id);
    } catch (e) {
      if (added.changed) await removeMemberFromFamily(user.uid, id).catch(() => {});
      throw e;
    }
    // Son kontrol: bu arada aile silindiyse, silinmeye başladıysa ya da kod
    // yenilendiyse (üye çıkarma) katılma geri alınır.
    if (await undoJoinIfFamilyGone(user.uid, id, { code, added: { member: added.changed, profile: profileAdded.changed } })) {
      res.status(404).json({ error: "Bu davet kodu geçersiz.", code: "invite_invalid" });
      return;
    }
    const summary = await loadFamilySummary(id, user.uid);
    res.status(200).json({ ...summary, repaired: inProfile || inMembers });
    return;
  }

  if (action === "leave") {
    const id = body.familyId;
    if (!id || !profile.families.includes(id)) {
      res.status(400).json({ error: "Bu ailenin üyesi değilsin." });
      return;
    }
    const { meta, members } = await readFamilyState(id);
    const activeOwner = meta && !isFamilyDeleting(meta) && meta.ownerUid === user.uid && members[user.uid];
    if (activeOwner && !oldestMember(members, user.uid)) {
      // Tek üye sahipse ayrılmak aileyi sahipsiz ve erişilemez bırakırdı.
      throw httpError(409, "Ailede senden başka üye yok. Aileyi bırakmak istiyorsan silebilirsin.", "sole_member");
    }
    let preferred = null;
    if (activeOwner && body.newOwnerUid != null) preferred = targetMember({ memberUid: body.newOwnerUid }, user.uid, members);
    // Sahiplik devri → üye listesi → profil → sahip kontrolü. Profil yazımı
    // yarıda kalırsa kullanıcı aileyi "doğrulanamadı" olarak görür ve
    // ayrılmayı tekrar deneyebilir; erişimi zaten kalkmıştır.
    await leaveFamily(user.uid, id, { preferredOwner: preferred });
    const updated = await getProfile(user.uid);
    res.status(200).json({ ok: true, families: updated.families });
    return;
  }

  if (action === "delete") {
    const id = body.familyId;
    if (!id || !profile.families.includes(id)) {
      res.status(400).json({ error: "Bu ailenin üyesi değilsin." });
      return;
    }
    const meta = await redisGetJSON(familyMetaKey(id), null);
    if (!meta) {
      // Zaten silinmiş: profilde kalan kimlik temizlenir.
      await pruneDeletedFamilies(user.uid, [id]);
      res.status(200).json({ ok: true, alreadyDeleted: true });
      return;
    }
    if (meta.ownerUid !== user.uid) {
      res.status(403).json({ error: "Sadece aile sahibi silebilir.", code: "not_owner" });
      return;
    }
    // Sahip doğrulanmış üye olmalı; yarıda kalmış silmede (işaretli) üye
    // listesi zaten silinmiş olabileceğinden sahip tamamlayabilir.
    const members = await redisGetJSON(membersKey(id), {});
    if (!isFamilyDeleting(meta) && !(members && members[user.uid])) {
      res.status(403).json({ error: "Bu ailenin üyesi değilsin." });
      return;
    }
    await deleteFamilyCompletely(id, { lastUid: user.uid });
    res.status(200).json({ ok: true });
    return;
  }

  if (action === "remove") {
    const id = body.familyId;
    const { members } = await requireOwner(user.uid, id, profile);
    const target = targetMember(body, user.uid, members);
    // 1) Kod yenilenir: çıkarılan kişi bildiği kodla geri dönemez (eski kodla
    //    yarışan katılma da son kontrolde geri alınır).
    await rotateInviteCode(id, user.uid);
    // 2) Üye listesinden (erişim burada kalkar), 3) onun profilinden.
    await removeMemberFromFamily(target, id);
    // Profil yazılamazsa çıkarılan kişi aileyi "doğrulanamadı" olarak görür
    // ve ayrılabilir; erişimi yoktur.
    await dropFamilyFromProfile(target, id).catch(() => {});
    await ensureOwner(id);
    res.status(200).json(await loadFamilySummary(id, user.uid));
    return;
  }

  if (action === "transfer") {
    const id = body.familyId;
    const { members } = await requireOwner(user.uid, id, profile);
    const target = targetMember(body, user.uid, members);
    await updateMeta(id, (m) => {
      if (!m || isFamilyDeleting(m)) throw httpError(404, "Aile bulunamadı.");
      if (m.ownerUid !== user.uid) throw httpError(403, "Bu işlemi yalnızca aile sahibi yapabilir.", "not_owner");
      return { ...m, ownerUid: target };
    });
    // Hedef tam bu sırada ayrıldıysa sahiplik en eski üyeye geçer.
    await ensureOwner(id);
    res.status(200).json(await loadFamilySummary(id, user.uid));
    return;
  }

  if (action === "rotateCode") {
    const id = body.familyId;
    await requireOwner(user.uid, id, profile);
    await rotateInviteCode(id, user.uid);
    res.status(200).json(await loadFamilySummary(id, user.uid));
    return;
  }

  res.status(400).json({ error: "Geçersiz işlem." });
}
