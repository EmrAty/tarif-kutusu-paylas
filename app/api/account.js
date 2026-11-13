import { requireUser, verifyIdToken } from "./_lib/auth.js";
import { deleteAccount } from "./_lib/accountDeletion.js";
import { mergeGuestInto } from "./_lib/guestMerge.js";

// DELETE /api/account — giriş yapmış kullanıcının KENDİ hesabını siler. uid
// yalnızca doğrulanmış ID token'dan geliyor; istemciden hiçbir kimlik
// alınmıyor. Ayrıntılar ve silme sırası: _lib/accountDeletion.js.
//
// POST /api/account { action: "mergeGuest", guestToken } (Grup 5) — misafir
// hesabın kişisel verisini bu hesaba taşır (bkz. _lib/guestMerge.js). Ayrı bir
// fonksiyon dosyası yerine burada: Vercel Hobby planı 12 fonksiyonla sınırlı.
export default async function handler(req, res) {
  if (req.method !== "DELETE" && req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  let user;
  try {
    // Silme yarıda kaldıysa aynı hesap tekrar deneyebilsin diye "silindi"
    // işareti silme isteğini engellemiyor (taşımayı engelliyor).
    user = await requireUser(req, { allowDeleted: req.method === "DELETE" });
  } catch (e) {
    res.status(e.status || 401).json({ error: e.message });
    return;
  }

  if (req.method === "POST") {
    const { action, guestToken } = req.body || {};
    if (action !== "mergeGuest" || typeof guestToken !== "string" || !guestToken) {
      res.status(400).json({ error: "Geçersiz istek." });
      return;
    }
    try {
      const guest = await verifyIdToken(guestToken).catch(() => {
        throw Object.assign(new Error("Misafir oturumu doğrulanamadı."), { status: 400, code: "guest_token_invalid" });
      });
      const report = await mergeGuestInto({ guest, targetUid: user.uid });
      console.log(JSON.stringify({ tag: "guest-merge", ...report }));
      res.status(200).json({ ok: true, ...report });
    } catch (e) {
      res.status(e.status || 502).json({ error: e.status ? e.message : "Veriler taşınamadı.", ...(e.code ? { code: e.code } : {}) });
    }
    return;
  }

  try {
    const result = await deleteAccount(user.uid);
    console.log("[account-delete]", JSON.stringify({ uid: user.uid, ...result }));
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error("[account-delete] failed", user.uid, e && e.message);
    res.status(500).json({
      error: "Hesap silinemedi. Lütfen tekrar dene.",
      code: "account_delete_failed",
    });
  }
}
