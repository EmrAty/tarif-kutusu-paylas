import { requireUser } from "./_lib/auth.js";
import { redisGetJSON, redisSetJSON, redisDel } from "./_lib/redis.js";
import { getProfile, updateProfile, MAX_FAMILIES } from "./_lib/profile.js";
import { membersKey, membersKeysWithAux, updateMembers, removeMemberFromFamily, assertFamilyAccess } from "./_lib/families.js";
import { bucketAuxKeys } from "./_lib/versionedBucket.js";

function familyId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function inviteCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // karışabilecek harfler (0/O, 1/I) çıkarıldı
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function metaKey(id) {
  return `family:${id}:meta`;
}
function inviteKey(code) {
  return `invite:${code}:family`;
}

function httpError(status, message, code) {
  return Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
}

// Üyelik doğrulanamayan (profilde var, üye listesinde yok) aile için yalnızca
// adı ve durum döner: davet kodu ve üye listesi gösterilmez — aksi hâlde
// "profilde yazıyor" tek başına üyelik vermiş olurdu. Kullanıcı aileden
// davet kodunu alıp yeniden katılarak (onarım) ya da ayrılarak çözer.
async function loadFamilySummary(id, uid) {
  const [meta, members] = await Promise.all([
    redisGetJSON(metaKey(id), null),
    redisGetJSON(membersKey(id), {}),
  ]);
  if (!meta) return null;
  if (!members || typeof members !== "object" || !members[uid]) {
    return { id, name: meta.name, membership: "unverified" };
  }
  return {
    id,
    name: meta.name,
    inviteCode: meta.inviteCode,
    ownerUid: meta.ownerUid,
    membership: "verified",
    members: Object.entries(members).map(([memberUid, info]) => ({
      uid: memberUid,
      name: info.name || null,
      email: info.email || null,
      isAnonymous: !!info.isAnonymous,
    })),
  };
}

// Kullanıcı görünen ismini (Ayarlar'da girdiği, cihazda saklanan isim) sonradan
// değiştirebiliyor — her aile listesi çekilişinde kendi üyelik kaydındaki ismi
// güncel tutuyor ki aile üyeleri e-posta yerine gerçek ismini görsün.
// Atomik güncelleme: aynı anda katılan üyeyi listeden düşüremez. Yalnızca
// zaten üye olan kaydı günceller (asla üye eklemez). Kozmetik olduğu için
// hatası listeyi bozmaz.
async function syncDisplayName(uid, familyIds, name) {
  if (!name) return;
  await Promise.all(
    familyIds.map((id) =>
      updateMembers(id, (members) => {
        if (!members[uid] || members[uid].name === name) return undefined;
        return { ...members, [uid]: { ...members[uid], name } };
      }).catch(() => {})
    )
  );
}

function sendError(res, e) {
  res.status(e.status || 502).json({ error: e.message || "İşlem tamamlanamadı.", ...(e.code ? { code: e.code } : {}) });
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
    const name = (req.query.name || "").trim();
    if (name) await syncDisplayName(user.uid, profile.families, name);
    const families = (await Promise.all(profile.families.map((id) => loadFamilySummary(id, user.uid)))).filter(Boolean);
    res.status(200).json({ isPlus: profile.isPlus, families });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { action } = req.body || {};
  const profile = await getProfile(user.uid);

  // Ayrılmak her zaman serbest — sadece yeni bir aile kurmak/katılmak Plus gerektiriyor.
  // Aksi halde Plus'ı kapatan biri, üyesi olduğu bir ailede sonsuza dek takılı kalırdı.
  if (!profile.isPlus && action !== "leave") {
    res.status(403).json({ error: "Aile özelliği Plus üyelere özeldir." });
    return;
  }

  const memberRecord = () => ({
    name: (req.body?.memberName || "").trim() || null,
    email: user.email,
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
    const name = (req.body?.name || "").trim();
    if (!name) {
      res.status(400).json({ error: "Aileye bir isim vermen lazım." });
      return;
    }
    if (profile.families.length >= MAX_FAMILIES) {
      res.status(403).json({ error: `En fazla ${MAX_FAMILIES} aileye üye olabilirsin.` });
      return;
    }
    const id = familyId();
    const code = inviteCode();
    await redisSetJSON(metaKey(id), { name, ownerUid: user.uid, createdAt: Date.now(), inviteCode: code });
    await updateMembers(id, () => ({ [user.uid]: memberRecord() }));
    try {
      await addFamilyToProfile(id);
    } catch (e) {
      // Profile eklenemediyse yarım aile bırakılmaz (henüz kimse katılamaz:
      // davet kodu henüz yazılmadı).
      await Promise.all([redisDel(metaKey(id)), ...membersKeysWithAux(id).map((k) => redisDel(k))]).catch(() => {});
      throw e;
    }
    await redisSetJSON(inviteKey(code), id);
    res.status(200).json(await loadFamilySummary(id, user.uid));
    return;
  }

  if (action === "join") {
    const code = (req.body?.code || "").trim().toUpperCase();
    if (!code) {
      res.status(400).json({ error: "Davet kodunu gir." });
      return;
    }
    const id = await redisGetJSON(inviteKey(code), null);
    const meta = id ? await redisGetJSON(metaKey(id), null) : null;
    if (!id || !meta) {
      res.status(404).json({ error: "Bu davet kodu geçersiz." });
      return;
    }
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
    try {
      await addFamilyToProfile(id);
    } catch (e) {
      if (added.changed) await removeMemberFromFamily(user.uid, id).catch(() => {});
      throw e;
    }
    const summary = await loadFamilySummary(id, user.uid);
    res.status(200).json({ ...summary, repaired: inProfile || inMembers });
    return;
  }

  if (action === "leave") {
    const id = req.body?.familyId;
    if (!id || !profile.families.includes(id)) {
      res.status(400).json({ error: "Bu ailenin üyesi değilsin." });
      return;
    }
    // Önce üye listesi: profil yazımı yarıda kalırsa kullanıcı aileyi hâlâ
    // görür ve ayrılmayı tekrar deneyebilir; erişimi zaten kalkmıştır.
    await removeMemberFromFamily(user.uid, id);
    const updated = await updateProfile(user.uid, (p) =>
      p.families.includes(id) ? { ...p, families: p.families.filter((f) => f !== id) } : undefined
    );
    res.status(200).json({ ok: true, families: updated.value.families });
    return;
  }

  if (action === "delete") {
    const id = req.body?.familyId;
    if (!id || !profile.families.includes(id)) {
      res.status(400).json({ error: "Bu ailenin üyesi değilsin." });
      return;
    }
    // Silme yetkisi: doğrulanmış üyelik + sahiplik.
    let access;
    try {
      access = await assertFamilyAccess(user.uid, id, profile);
    } catch (e) {
      res.status(e.status === 404 ? 404 : e.status || 403).json({ error: e.status === 404 ? "Aile bulunamadı." : e.message });
      return;
    }
    const { meta, members } = access;
    if (meta.ownerUid !== user.uid) {
      res.status(403).json({ error: "Sadece aileyi kuran kişi silebilir." });
      return;
    }
    // Davet kodu önce: silme sürerken yeni katılım olmasın.
    if (meta.inviteCode) await redisDel(inviteKey(meta.inviteCode));
    // Silinen ailenin tüm üyelerinin kendi profilinden de bu aile çıkarılıyor
    // (atomik; aynı anda yapılan katılma/Plus değişikliği ezilmez). Biri
    // başarısız olursa veri silinmez, işlem tekrar denenebilir.
    // Sahibin profili EN SON: yarıda kalırsa sahip silmeyi tekrar deneyebilir.
    const dropFamily = (uid) =>
      updateProfile(uid, (p) => (p.families.includes(id) ? { ...p, families: p.families.filter((f) => f !== id) } : undefined));
    await Promise.all(Object.keys(members).filter((uid) => uid !== user.uid).map(dropFamily));
    await dropFamily(user.uid);
    // Ortak listeler, sürüm sayaçları ve yedekleri birlikte siliniyor.
    // pendingJobRecipes: eski sürümden kalmış olabilecek işaretçi (artık yazılmıyor).
    const dataKeys = ["recipes", "shopping-list", "pantry-items"].flatMap((b) => {
      const key = `family:${id}:${b}`;
      return [key, ...bucketAuxKeys(key)];
    });
    await Promise.all([
      ...membersKeysWithAux(id).map((key) => redisDel(key)),
      ...dataKeys.map((key) => redisDel(key)),
      redisDel(`family:${id}:pendingJobRecipes`),
    ]);
    // meta en son: yarıda kalırsa aile hâlâ bulunup silme tekrar denenebilir.
    await redisDel(metaKey(id));
    res.status(200).json({ ok: true });
    return;
  }

  res.status(400).json({ error: "Geçersiz işlem." });
}
