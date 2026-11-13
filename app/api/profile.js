import { requireUser } from "./_lib/auth.js";
import { getProfile, updateProfile } from "./_lib/profile.js";

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
    // Grup 5 (B5): bozuk profil (getProfile 502 profile_unreadable fırlatır) ya
    // da Redis hatası yakalanmamış istisna olarak sızmasın; 502 + kod döner.
    try {
      res.status(200).json(await getProfile(user.uid));
    } catch (e) {
      res.status(e.status || 502).json({ error: e.status ? e.message : "Profil okunamadı.", ...(e.code ? { code: e.code } : {}) });
    }
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
  // Grup 4 ürün kararı: Plus kapanınca kullanıcı ailelerinden ÇIKARILMAZ ve
  // sahipliği devredilmez; aileleri kilitlenir (içerik ve aile işlemleri
  // sunucuda kapalı, yalnızca üyeliğini görür ve ayrılabilir). Plus yeniden
  // açılınca aynı üyelik ve içerik olduğu gibi erişilebilir. Yalnızca bayrak
  // değişir (atomik); aile kayıtlarına dokunulmaz.
  const updated = await updateProfile(uid, (p) => (p.isPlus === isPlus ? undefined : { ...p, isPlus }));
  return updated.value;
}
