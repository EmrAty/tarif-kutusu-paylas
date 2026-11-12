import { requireUser } from "./_lib/auth.js";
import { getProfile, updateProfile } from "./_lib/profile.js";
import { leaveFamily } from "./_lib/families.js";

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
  // Plus kapatılınca üyesi olunan ailelerden otomatik çıkılıyor (ürün kararı,
  // 10 Eylül 2026: "Plus'ın tüm özellikleri iptal olsun"). Grup 4:
  //   - sahipse sahiplik önce en eski üyeye devredilir (eskiden aile sahipsiz
  //     kalıyordu: kimse silemiyor/yönetemiyordu);
  //   - ailede başka üye yoksa üyelik KORUNUR ("kept"): çıkılsaydı aile ve
  //     tarifleri kimsenin erişemediği sahipsiz kayıt olarak kalırdı. Kullanıcı
  //     Aileler ekranından aileyi silebilir ya da Plus'ı yeniden açabilir.
  // Sıra: önce isPlus=false yazılır (bu arada yeni katılma yapılamasın), sonra
  // aileler; profilden yalnızca gerçekten çıkılan aileler silinir.
  const updated = await updateProfile(uid, (p) => (p.isPlus === isPlus ? undefined : { ...p, isPlus }));
  if (before.isPlus && !isPlus && before.families.length > 0) {
    const kept = [];
    for (const familyId of before.families) {
      const result = await leaveFamily(uid, familyId, { keepIfAlone: true });
      if (result === "kept") kept.push(familyId);
    }
    const after = await getProfile(uid);
    return { ...after, keptFamilies: kept };
  }
  return updated.value;
}
