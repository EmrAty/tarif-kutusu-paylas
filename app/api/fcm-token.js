import { requireUser } from "./_lib/auth.js";
import { redisGetJSON, redisSetJSON } from "./_lib/redis.js";
import { fcmTokensKey } from "./_lib/fcm.js";

// Tarayıcı/cihaz bir push-bildirim token'ı ürettiğinde buraya kaydediliyor.
// Bir kullanıcının birden fazla cihazı (telefon + bilgisayar) olabileceği
// için tek bir değer değil, bir liste tutuluyor.
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

  const { token } = req.body || {};
  if (!token) {
    res.status(400).json({ error: "Token eksik." });
    return;
  }

  const tokens = await redisGetJSON(fcmTokensKey(user.uid), []);
  if (!tokens.includes(token)) {
    tokens.push(token);
    await redisSetJSON(fcmTokensKey(user.uid), tokens);
  }
  res.status(200).json({ ok: true });
}
