import { jwtVerify, createRemoteJWKSet } from "jose";

// Firebase ID token'ları standart bir JWT — Google'ın herkese açık anahtarlarıyla
// (servis hesabı/gizli bilgi gerekmeden) doğrulanabiliyor. Bu yüzden firebase-admin
// gibi ağır bir bağımlılık ve yeni bir gizli env değişkeni eklemeye gerek kalmadı.
const PROJECT_ID = "tarif-kutusu";
const ISSUER = `https://securetoken.google.com/${PROJECT_ID}`;
const JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

const JWKS = createRemoteJWKSet(new URL(JWKS_URL));

// req.body üzerinden değil, Authorization header'ından okunuyor — bu yüzden bu
// fonksiyon hem GET hem POST endpoint'lerinde aynı şekilde çalışabiliyor.
export async function requireUser(req) {
  const header = req.headers.authorization || req.headers.Authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) {
    const err = new Error("Giriş yapmanız gerekiyor.");
    err.status = 401;
    throw err;
  }

  try {
    const { payload } = await jwtVerify(token, JWKS, { issuer: ISSUER, audience: PROJECT_ID });
    if (!payload.sub) throw new Error("Token içinde kullanıcı kimliği yok.");
    return {
      uid: payload.sub,
      email: payload.email || null,
      isAnonymous: payload.firebase?.sign_in_provider === "anonymous",
    };
  } catch (e) {
    const err = new Error("Oturum doğrulanamadı, lütfen tekrar giriş yap.");
    err.status = 401;
    throw err;
  }
}
