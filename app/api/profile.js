import { requireUser } from "./_lib/auth.js";
import { getProfile, setProfile } from "./_lib/profile.js";
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
    const profile = await getProfile(user.uid);
    const wasPlus = profile.isPlus;
    profile.isPlus = isPlus;
    // Plus kapatılınca üyesi olunan tüm ailelerden de otomatik çıkılıyor —
    // Plus'ın aile özelliği bir kez açılıp kapansa bile kalıcı kalmasın diye.
    if (wasPlus && !isPlus && profile.families.length > 0) {
      await Promise.all(profile.families.map((familyId) => removeMemberFromFamily(user.uid, familyId)));
      profile.families = [];
    }
    await setProfile(user.uid, profile);
    res.status(200).json(profile);
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
}
