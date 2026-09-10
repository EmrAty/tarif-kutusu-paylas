import { requireUser } from "./_lib/auth.js";
import { redisGetJSON, redisSetJSON } from "./_lib/redis.js";
import { getProfile, setProfile, MAX_FAMILIES } from "./_lib/profile.js";
import { membersKey, removeMemberFromFamily } from "./_lib/families.js";

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

async function loadFamilySummary(id) {
  const [meta, members] = await Promise.all([
    redisGetJSON(metaKey(id), null),
    redisGetJSON(membersKey(id), {}),
  ]);
  if (!meta) return null;
  return {
    id,
    name: meta.name,
    inviteCode: meta.inviteCode,
    ownerUid: meta.ownerUid,
    members: Object.entries(members).map(([uid, info]) => ({
      uid,
      name: info.name || null,
      email: info.email || null,
      isAnonymous: !!info.isAnonymous,
    })),
  };
}

// Kullanıcı görünen ismini (Ayarlar'da girdiği, cihazda saklanan isim) sonradan
// değiştirebiliyor — her aile listesi çekilişinde kendi üyelik kaydındaki ismi
// güncel tutuyor ki aile üyeleri e-posta yerine gerçek ismini görsün.
async function syncDisplayName(uid, familyIds, name) {
  if (!name) return;
  await Promise.all(
    familyIds.map(async (id) => {
      const members = await redisGetJSON(membersKey(id), {});
      if (members[uid] && members[uid].name !== name) {
        members[uid] = { ...members[uid], name };
        await redisSetJSON(membersKey(id), members);
      }
    })
  );
}

export default async function handler(req, res) {
  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    res.status(e.status || 401).json({ error: e.message });
    return;
  }

  if (req.method === "GET") {
    const profile = await getProfile(user.uid);
    const name = (req.query.name || "").trim();
    if (name) await syncDisplayName(user.uid, profile.families, name);
    const families = (await Promise.all(profile.families.map(loadFamilySummary))).filter(Boolean);
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
    const memberName = (req.body?.memberName || "").trim() || null;
    await Promise.all([
      redisSetJSON(metaKey(id), { name, ownerUid: user.uid, createdAt: Date.now(), inviteCode: code }),
      redisSetJSON(membersKey(id), {
        [user.uid]: { name: memberName, email: user.email, isAnonymous: user.isAnonymous, joinedAt: Date.now() },
      }),
      redisSetJSON(inviteKey(code), id),
    ]);
    profile.families = [...profile.families, id];
    await setProfile(user.uid, profile);
    res.status(200).json(await loadFamilySummary(id));
    return;
  }

  if (action === "join") {
    const code = (req.body?.code || "").trim().toUpperCase();
    if (!code) {
      res.status(400).json({ error: "Davet kodunu gir." });
      return;
    }
    if (profile.families.length >= MAX_FAMILIES) {
      res.status(403).json({ error: `En fazla ${MAX_FAMILIES} aileye üye olabilirsin.` });
      return;
    }
    const id = await redisGetJSON(inviteKey(code), null);
    if (!id) {
      res.status(404).json({ error: "Bu davet kodu geçersiz." });
      return;
    }
    if (profile.families.includes(id)) {
      res.status(400).json({ error: "Bu ailenin zaten üyesisin." });
      return;
    }
    const memberName = (req.body?.memberName || "").trim() || null;
    const members = await redisGetJSON(membersKey(id), {});
    members[user.uid] = { name: memberName, email: user.email, isAnonymous: user.isAnonymous, joinedAt: Date.now() };
    await redisSetJSON(membersKey(id), members);
    profile.families = [...profile.families, id];
    await setProfile(user.uid, profile);
    res.status(200).json(await loadFamilySummary(id));
    return;
  }

  if (action === "leave") {
    const id = req.body?.familyId;
    if (!id || !profile.families.includes(id)) {
      res.status(400).json({ error: "Bu ailenin üyesi değilsin." });
      return;
    }
    await removeMemberFromFamily(user.uid, id);
    profile.families = profile.families.filter((f) => f !== id);
    await setProfile(user.uid, profile);
    res.status(200).json({ ok: true });
    return;
  }

  res.status(400).json({ error: "Geçersiz işlem." });
}
