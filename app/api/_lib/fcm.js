import crypto from "node:crypto";

// FCM'e (Firebase Cloud Messaging) sunucudan push göndermek normalde
// firebase-admin paketini gerektirir, ama o da bir servis hesabı JWT'sini
// Google'ın OAuth2 endpoint'ine karşı değiş tokuş etmekten ibaret — burada
// aynı işi node:crypto ile elle imzalayıp yapıyoruz, auth.js'teki "jose yeter,
// firebase-admin gerekmez" tercihiyle tutarlı olsun diye.
function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

let cachedToken = null; // { accessToken, projectId, expiresAt }

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken;
  }

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (!raw) {
    const err = new Error("Sunucu yapılandırması eksik: bildirim gönderme anahtarı tanımlı değil.");
    err.status = 500;
    throw err;
  }
  const serviceAccount = JSON.parse(raw);

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), serviceAccount.private_key);
  const jwt = `${unsigned}.${base64url(signature)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error("Google'dan bildirim gönderme yetkisi alınamadı.");
    err.status = 502;
    throw err;
  }

  cachedToken = {
    accessToken: data.access_token,
    projectId: serviceAccount.project_id,
    expiresAt: now * 1000 + data.expires_in * 1000,
  };
  return cachedToken;
}

export function fcmTokensKey(uid) {
  return `user:${uid}:fcmTokens`;
}

// Tek bir cihaz token'ına push gönderiyor. Token artık geçersizse (uygulama
// kaldırılmış, izin geri alınmış vb.) invalidToken:true fırlatıyor ki çağıran
// taraf o token'ı kalıcı listeden temizleyebilsin.
export async function sendFcmMessage(token, { title, body }) {
  const { accessToken, projectId } = await getAccessToken();
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        token,
        notification: { title, body },
        webpush: { fcm_options: { link: "/" } },
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
