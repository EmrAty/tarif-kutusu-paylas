import { requireUser } from "./_lib/auth.js";
import { getProfile, updateProfile } from "./_lib/profile.js";
import { removeMemberFromFamily } from "./_lib/families.js";

// isPlus şu an gerçek bir ödeme sistemine bağlı değil — kullanıcının kendisi
// açıp kapatabildiği bir test bayrağı. Ödeme entegrasyonu eklendiğinde bu
// endpoint'in POST kısmı ödeme sağlayıcısının webhook'una taşınmalı.
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
    res.status(200).json(profile);
    return;
  }

  if (req.method === "POST") {
    const { isPlus } = req.body || {};
    if (typeof isPlus !== "boolean") {
      res.status(400).json({ error: "Geçersiz istek." });
      return;
    }
    try {
      res.status(200).json(await setPlus(user.uid, isPlus));
    } catch (e) {
      res.status(e.status || 502).json({ error: e.message || "Profil güncellenemedi.", ...(e.code ? { code: e.code } : {}) });
    }
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
}

async function setPlus(uid, isPlus) {
  const before = await getProfile(uid);
  // Plus kapatılınca üyesi olunan tüm ailelerden de otomatik çıkılıyor —
  // Plus'ın aile özelliği bir kez açılıp kapansa bile kalıcı kalmasın diye.
  // Önce üye listelerinden (atomik), sonra profil (atomik): profilden
  // yalnızca gerçekten çıkılan aileler silinir, arada eklenen ezilmez.
  let left = [];
  if (before.isPlus && !isPlus && before.families.length > 0) {
    left = [...before.families];
    await Promise.all(left.map((familyId) => removeMemberFromFamily(uid, familyId)));
  }
  const updated = await updateProfile(uid, (p) => {
    const families = left.length ? p.families.filter((f) => !left.includes(f)) : p.families;
    if (p.isPlus === isPlus && families.length === p.families.length) return undefined;
    return { ...p, isPlus, families };
  });
  return updated.value;
}
