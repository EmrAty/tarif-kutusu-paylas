import { requireUser } from "./_lib/auth.js";
import { deleteAccount } from "./_lib/accountDeletion.js";

// DELETE /api/account — giriş yapmış kullanıcının KENDİ hesabını siler. uid
// yalnızca doğrulanmış ID token'dan geliyor; istemciden hiçbir kimlik
// alınmıyor. Ayrıntılar ve silme sırası: _lib/accountDeletion.js.
export default async function handler(req, res) {
  if (req.method !== "DELETE") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  let user;
  try {
    // Silme yarıda kaldıysa aynı hesap tekrar deneyebilsin diye "silindi"
    // işareti bu endpoint'i engellemiyor.
    user = await requireUser(req, { allowDeleted: true });
  } catch (e) {
    res.status(e.status || 401).json({ error: e.message });
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
