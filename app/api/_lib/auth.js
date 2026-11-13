import { jwtVerify, createRemoteJWKSet } from "jose";
import { isAccountDeleted } from "./accountDeletion.js";

// Firebase ID token'ları standart bir JWT — Google'ın herkese açık anahtarlarıyla
// (servis hesabı/gizli bilgi gerekmeden) doğrulanabiliyor. Bu yüzden firebase-admin
// gibi ağır bir bağımlılık ve yeni bir gizli env değişkeni eklemeye gerek kalmadı.
const PROJECT_ID = "tarif-kutusu";
const ISSUER = `https://securetoken.google.com/${PROJECT_ID}`;
const JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

const JWKS = createRemoteJWKSet(new URL(JWKS_URL));

// req.body üzerinden değil, Authorization header'ından okunuyor — bu yüzden bu
// fonksiyon hem GET hem POST endpoint'lerinde aynı şekilde çalışabiliyor.
// Silinmiş hesabın hâlâ geçerli (en fazla 1 saatlik) ID token'ı reddediliyor,
// yoksa açık kalan bir cihaz silinen veriyi yeniden yazabilirdi.
// Firebase ID token'ını doğrular; { uid, email, isAnonymous } ya da 401 hatası.
// Grup 5: misafir verisi taşımada (POST /api/account) gövdedeki misafir token'ı
// da aynı kuralla doğrulanır.
export async function verifyIdToken(token) {
  try {
    if (typeof token !== "string" || !token) throw new Error("token yok");
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

export async function requireUser(req, { allowDeleted = false } = {}) {
  const header = req.headers.authorization || req.headers.Authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) {
    const err = new Error("Giriş yapmanız gerekiyor.");
    err.status = 401;
    throw err;
  }

  const user = await verifyIdToken(token);

  if (!allowDeleted) {
    let deleted = false;
    try {
      deleted = await isAccountDeleted(user.uid);
    } catch (e) {
      // Veritabanı o an cevap vermiyorsa istek kendi Redis çağrısında zaten
      // hata alacak; burada oturumu reddetmiyoruz.
    }
    if (deleted) {
      const err = new Error("Bu hesap silindi.");
      err.status = 401;
      throw err;
    }
  }
  return user;
}
