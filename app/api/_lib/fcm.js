import { redisGetJSON, redisSetJSON } from "./redis.js";
import { getServiceAccountToken } from "./googleAuth.js";

// FCM'e (Firebase Cloud Messaging) sunucudan push göndermek için servis hesabı
// erişim token'ı ortak yardımcıdan (googleAuth.js) alınıyor.
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

async function getAccessToken() {
  try {
    return await getServiceAccountToken(FCM_SCOPE, "Sunucu yapılandırması eksik: bildirim gönderme anahtarı tanımlı değil.");
  } catch (e) {
    if (e.status === 502) e.message = "Google'dan bildirim gönderme yetkisi alınamadı.";
    throw e;
  }
}

export function fcmTokensKey(uid) {
  return `user:${uid}:fcmTokens`;
}

// Tek bir cihaz token'ına push gönderiyor. Token artık geçersizse (uygulama
// kaldırılmış, izin geri alınmış vb.) invalidToken:true fırlatıyor ki çağıran
// taraf o token'ı kalıcı listeden temizleyebilsin.
export async function sendFcmMessage(token, { title, body, data }) {
  const { accessToken, projectId } = await getAccessToken();
  const recipeId = data?.recipeId;
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        token,
        notification: { title, body },
        // data, bildirime tıklanınca doğru tarifin açılabilmesi için (bkz.
        // App.jsx / firebase-messaging-sw.js) - FCM data payload'ı sadece
        // string değer kabul ediyor.
        ...(data ? { data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])) } : {}),
        // Varsayılan ("normal") öncelik, cihaz Doze/pil optimizasyonu
        // modundayken bildirimi dakikalarca geciktirebiliyordu ("geç geliyor"
        // diye bildirildi, 10 Eylül 2026) - "high" cihazı hemen uyandırıyor.
        android: { priority: "high" },
        webpush: { fcm_options: { link: recipeId ? `/?openRecipe=${encodeURIComponent(recipeId)}` : "/" } },
      },
    }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const status = data?.error?.status;
    const err = new Error(data?.error?.message || "Bildirim gönderilemedi.");
    err.invalidToken = status === "NOT_FOUND" || status === "INVALID_ARGUMENT";
    throw err;
  }
}

// Tek kullanıcının kayıtlı tüm cihazlarına gönderir; notify.js'teki aile
// döngüsüyle aynı "kalıcı geçersiz token'ı temizle" kuralı.
export async function notifyUserDevices(uid, { title, body, data }) {
  const tokens = (await redisGetJSON(fcmTokensKey(uid), [])) || [];
  let sent = 0;
  let lastError = null;
  const stillValid = [];
  for (const token of tokens) {
    try {
      await sendFcmMessage(token, { title, body, data });
      sent++;
      stillValid.push(token);
    } catch (e) {
      if (!e.invalidToken) stillValid.push(token);
      lastError = e.message;
    }
  }
  if (stillValid.length !== tokens.length) {
    await redisSetJSON(fcmTokensKey(uid), stillValid);
  }
  return { sent, attempted: tokens.length, error: sent === 0 ? lastError : null };
}
