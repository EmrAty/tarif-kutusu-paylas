import { requireUser } from "./_lib/auth.js";
import {
  registerPushTarget,
  verifyPushTarget,
  unregisterPushTarget,
  isValidPushToken,
  isValidInstallationId,
  PUSH_PLATFORMS,
} from "./_lib/fcm.js";

// Cihaz push token'ı kaydı (bkz. _lib/fcm.js "Push hedefleri").
// POST {token, platform?, installationId?}            — kaydet / bu hesaba bağla.
//      Token başka bir hesabın elindeyse {status: "verification_required"}
//      döner ve cihaza sessiz doğrulama mesajı gider.
// POST {action: "verify", token, nonce}               — sahiplik kanıtı.
// POST {action: "unregister", token?, installationId?} — çıkışta bu cihazı ayır.
// DELETE (gövdeli) eski yol olarak da kabul edilir; istemci POST kullanır
// (gövdeli DELETE'in her ara katmanda korunacağı garanti değil).
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

  const { action, token, platform, installationId, nonce } = req.body || {};
  const mode = req.method === "DELETE" ? "unregister" : action || "register";
  if (installationId != null && !isValidInstallationId(installationId)) {
    res.status(400).json({ error: "Geçersiz kurulum kimliği." });
    return;
  }
  if (token != null && !isValidPushToken(token)) {
    res.status(400).json({ error: "Geçersiz token." });
    return;
  }

  try {
    if (mode === "unregister") {
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

    if (mode === "verify") {
      const result = await verifyPushTarget(user.uid, { token, nonce });
      res.status(result.status === "registered" ? 200 : 409).json({ ok: result.status === "registered", ...result });
      return;
    }

    if (mode !== "register") {
      res.status(400).json({ error: "Geçersiz işlem." });
      return;
    }
    if (platform != null && !PUSH_PLATFORMS.has(platform)) {
      res.status(400).json({ error: "Geçersiz platform." });
      return;
    }
    const result = await registerPushTarget(user.uid, { token, platform: platform || null, installationId: installationId || null });
    res.status(result.status === "verification_required" ? 202 : 200).json({ ok: true, ...result });
  } catch (e) {
    res.status(e.status || 502).json({ error: "Bildirim kaydı yapılamadı." });
  }
}
