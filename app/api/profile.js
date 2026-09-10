import { requireUser } from "./_lib/auth.js";
import { getProfile, setProfile } from "./_lib/profile.js";

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
    profile.isPlus = isPlus;
    await setProfile(user.uid, profile);
    res.status(200).json(profile);
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
}
