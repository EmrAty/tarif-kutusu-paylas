import crypto from "node:crypto";

// FIREBASE_SERVICE_ACCOUNT_KEY'deki servis hesabıyla Google OAuth2 erişim
// token'ı alıyor. firebase-admin'in yaptığı da bundan ibaret: servis hesabı
// JWT'sini node:crypto ile imzalayıp Google'ın token endpoint'inde değiş
// tokuş etmek (auth.js'teki "jose yeter, firebase-admin gerekmez" tercihi).
// FCM (fcm.js) ve hesap silme (firebaseUsers.js) farklı scope'larla kullanıyor.
function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const cachedTokens = new Map(); // scope -> { accessToken, projectId, expiresAt }

export async function getServiceAccountToken(scope, missingKeyMessage) {
  const cached = cachedTokens.get(scope);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached;
  }

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (!raw) {
    const err = new Error(missingKeyMessage || "Sunucu yapılandırması eksik: servis hesabı anahtarı tanımlı değil.");
    err.status = 500;
    throw err;
  }
  const serviceAccount = JSON.parse(raw);

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: serviceAccount.client_email,
    scope,
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
    const err = new Error("Google'dan yetki alınamadı.");
    err.status = 502;
    throw err;
  }

  const token = {
    accessToken: data.access_token,
    projectId: serviceAccount.project_id,
    expiresAt: now * 1000 + data.expires_in * 1000,
  };
  cachedTokens.set(scope, token);
  return token;
}
