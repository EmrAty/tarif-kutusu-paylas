import { requireUser } from "./_lib/auth.js";
import {
  registerPushTarget,
  unregisterPushTarget,
  isValidPushToken,
  isValidInstallationId,
  PUSH_PLATFORMS,
} from "./_lib/fcm.js";

// Cihaz push token'ı kaydı (bkz. _lib/fcm.js "Push hedefleri").
// POST   {token, platform?, installationId?} — kaydet / bu hesaba bağla.
//        platform: "android" | "ios" | "web". Platform göndermeyen eski
//        istemci paketi eski şemaya yazar (geriye uyumlu).
// DELETE {token?, installationId?} — çıkışta bu cihazı bu hesaptan ayır.
export default async function handler(req, res) {
  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    res.status(e.status || 401).json({ error: e.message });
    return;
  }

  if (req.method !== "POST" && req.method !== "DELETE") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { token, platform, installationId } = req.body || {};
  if (installationId != null && !isValidInstallationId(installationId)) {
    res.status(400).json({ error: "Geçersiz kurulum kimliği." });
    return;
  }

  try {
    if (req.method === "DELETE") {
      if (token != null && !isValidPushToken(token)) {
        res.status(400).json({ error: "Geçersiz token." });
        return;
      }
      if (!token && !installationId) {
        res.status(400).json({ error: "Token eksik." });
        return;
      }
      const result = await unregisterPushTarget(user.uid, { token, installationId });
      res.status(200).json({ ok: true, ...result });
      return;
    }

    if (!token) {
      res.status(400).json({ error: "Token eksik." });
      return;
    }
    if (!isValidPushToken(token)) {
      res.status(400).json({ error: "Geçersiz token." });
      return;
    }
    if (platform != null && !PUSH_PLATFORMS.has(platform)) {
      res.status(400).json({ error: "Geçersiz platform." });
      return;
    }
    const result = await registerPushTarget(user.uid, { token, platform: platform || null, installationId: installationId || null });
    res.status(200).json({ ok: true, ...result });
  } catch (e) {
    res.status(e.status || 502).json({ error: "Bildirim kaydı yapılamadı." });
  }
}
