import { requireUser } from "./_lib/auth.js";
import { assertFamilyAccess } from "./_lib/families.js";
import { getProfile } from "./_lib/profile.js";
import { collectPushTargets, sendToTargets } from "./_lib/fcm.js";
import { craveNotificationBody } from "./_lib/turkish.js";
import { redisGetJSON } from "./_lib/redis.js";
import { assertNotifyAllowed, notificationTitle, notificationName } from "./_lib/notifyGuard.js";

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

  // Grup 5: istemciden yalnızca aile ve tarif kimliği kullanılır. Gönderen adı
  // sunucudaki üye kaydından, tarif başlığı ailenin kayıtlı listesinden gelir;
  // istemcinin gönderdiği recipeTitle / senderName (eski paketler hâlâ gönderiyor)
  // YOK SAYILIR — başka biri adına ya da serbest metinle bildirim atılamaz.
  const { familyId, recipeId } = req.body || {};
  if (typeof familyId !== "string" || !familyId || (typeof recipeId !== "string" && typeof recipeId !== "number") || recipeId === "") {
    res.status(400).json({ error: "Eksik bilgi." });
    return;
  }

  // Profil + aile kaydı + üye listesi + Plus birlikte doğrulanır (Plus'sız
  // üyenin ailesi kilitli: bildirim gönderemez).
  let members;
  let title;
  try {
    ({ members } = await assertFamilyAccess(user.uid, familyId));
    const list = await redisGetJSON(`family:${familyId}:recipes`, []);
    const recipe = Array.isArray(list) ? list.find((r) => r && r.id === recipeId) : null;
    title = recipe ? notificationTitle(recipe.title) : "";
    if (!title) {
      res.status(404).json({ error: "Tarif bu ailede bulunamadı.", code: "recipe_not_found" });
      return;
    }
    await assertNotifyAllowed({ uid: user.uid, familyId, recipeId: String(recipeId) });
  } catch (e) {
    if (e.retryAfter) res.setHeader("Retry-After", String(e.retryAfter));
    res.status(e.status || 502).json({ error: e.message, ...(e.code ? { code: e.code } : {}) });
    return;
  }
  const name = notificationName(members[user.uid]?.name) || "Biri";
  const body = craveNotificationBody(name, title);
  // Plus'ı kapalı üyenin ailesi kilitli: tarifi açamayacağı bildirimi almaz
  // (profil okunamazsa da gönderilmez — fail-closed).
  const others = Object.keys(members).filter((uid) => uid !== user.uid);
  const plusFlags = await Promise.all(others.map((uid) => getProfile(uid).then((p) => !!p.isPlus, () => false)));
  const recipientUids = others.filter((_, i) => plusFlags[i]);

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
        data: { recipeId: String(recipeId) },
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
