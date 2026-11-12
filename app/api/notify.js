import { requireUser } from "./_lib/auth.js";
import { assertFamilyAccess } from "./_lib/families.js";
import { collectPushTargets, sendToTargets } from "./_lib/fcm.js";
import { craveNotificationBody } from "./_lib/turkish.js";

export default async function handler(req, res) {
  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    res.status(e.status || 401).json({ error: e.message });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { familyId, recipeId, recipeTitle, senderName } = req.body || {};
  if (!familyId || !recipeTitle) {
    res.status(400).json({ error: "Eksik bilgi." });
    return;
  }

  // Profil + aile kaydı + üye listesi birlikte doğrulanır.
  let members;
  try {
    ({ members } = await assertFamilyAccess(user.uid, familyId));
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
    return;
  }
  const name = (senderName || "").trim() || members[user.uid]?.name || "Biri";
  const body = craveNotificationBody(name, recipeTitle);
  const recipientUids = Object.keys(members).filter((uid) => uid !== user.uid);

  // sent/attempted, gönderenin "gönderildi" görmesine rağmen kimsenin bildirim
  // almadığı durumları (kayıtlı token yok / FCM gönderimi hata verdi) istemcide
  // ayırt edebilmek için dönülüyor — daha önce bu bilgi hiç görünmüyordu ve
  // token hiç kaydolmasa bile istemci her zaman "gönderildi" gösteriyordu.
  let sent = 0;
  let attempted = 0;
  let lastError = null;
  // "Canı çekti" bildirimi de YALNIZCA alıcının Android kayıtlarına gider (web
  // push kapalı, web'e geri dönüş yok); her Android cihaza bir bildirim,
  // başka hesaba geçmiş token'a hiç.
  await Promise.all(
    recipientUids.map(async (uid) => {
      let targets;
      try {
        targets = await collectPushTargets(uid);
      } catch (e) {
        lastError = e.message;
        return;
      }
      if (!targets.length) return;
      // Bildirime tıklanınca doğrudan bu tarifin açılması için (bkz.
      // App.jsx'teki pushNotificationActionPerformed dinleyicisi).
      const result = await sendToTargets(uid, targets, {
        title: "Tarif Kutusu",
        body,
        data: recipeId ? { recipeId } : undefined,
      });
      attempted += result.attempted;
      sent += result.sent;
      if (result.error) lastError = result.error;
    })
  );

  res.status(200).json({
    ok: true,
    sent,
    attempted,
    recipientCount: recipientUids.length,
    error: sent === 0 ? lastError : null,
  });
}
