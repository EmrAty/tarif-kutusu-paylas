import { requireUser } from "./_lib/auth.js";
import { redisGetJSON, redisSetJSON } from "./_lib/redis.js";
import { getProfile } from "./_lib/profile.js";
import { membersKey } from "./_lib/families.js";
import { fcmTokensKey, sendFcmMessage } from "./_lib/fcm.js";
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

  const { familyId, recipeTitle, senderName } = req.body || {};
  if (!familyId || !recipeTitle) {
    res.status(400).json({ error: "Eksik bilgi." });
    return;
  }

  const profile = await getProfile(user.uid);
  if (!profile.families.includes(familyId)) {
    res.status(403).json({ error: "Bu ailenin üyesi değilsin." });
    return;
  }

  const members = await redisGetJSON(membersKey(familyId), {});
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
  await Promise.all(
    recipientUids.map(async (uid) => {
      const tokens = await redisGetJSON(fcmTokensKey(uid), []);
      if (!tokens.length) return;
      attempted += tokens.length;
      const stillValid = [];
      for (const token of tokens) {
        try {
          await sendFcmMessage(token, { title: "Tarif Kutusu", body });
          sent++;
          stillValid.push(token);
        } catch (e) {
          // invalidToken değilse geçici bir hata olabilir (ör. ağ) — token'ı
          // silmeden bırakıyoruz, sadece kalıcı olarak geçersizse temizliyoruz.
          if (!e.invalidToken) stillValid.push(token);
          lastError = e.message;
        }
      }
      if (stillValid.length !== tokens.length) {
        await redisSetJSON(fcmTokensKey(uid), stillValid);
      }
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
