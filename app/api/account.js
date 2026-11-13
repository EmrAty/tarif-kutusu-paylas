import { requireUser, verifyIdToken } from "./_lib/auth.js";
import { deleteAccount } from "./_lib/accountDeletion.js";
import { createTicket, claimTicket, resumeMerges, mergeGuestInto } from "./_lib/guestMerge.js";

// DELETE /api/account — giriş yapmış kullanıcının KENDİ hesabını siler. uid
// yalnızca doğrulanmış ID token'dan geliyor; istemciden hiçbir kimlik
// alınmıyor. Ayrıntılar ve silme sırası: _lib/accountDeletion.js.
//
// POST /api/account — misafir verisini mevcut hesaba taşıma (Grup 5, ayrıntı:
// _lib/guestMerge.js). Ayrı bir fonksiyon dosyası yerine burada: Vercel Hobby
// planı 12 fonksiyonla sınırlı.
//   { action: "createGuestMergeTicket" }            misafir oturumuyla → { ticket }
//   { action: "claimGuestMergeTicket", ticket }      hedef hesapla → taşıma sonucu
//   { action: "resumeGuestMerges" }                  hedef hesapla → { merges: [...] }
//   { action: "mergeGuest", guestToken }             eski yol (geriye uyum)
// Taşıma sonucu: { ok, status: "done"|"in_progress"|"blocked", recipes,
//   skippedRecipes, pantry, shoppingList, families, cleanupPending?, code? }
function sendResult(res, result) {
  res.status(200).json({ ok: true, status: result.status, ...result.report, ...(result.cleanupPending ? { cleanupPending: true } : {}), ...(result.code ? { code: result.code, error: result.error } : {}) });
}

function sendFailure(res, e, fallback = "Veriler taşınamadı.") {
  res.status(e.status || 502).json({ error: e.status ? e.message : fallback, ...(e.code ? { code: e.code } : {}) });
}

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
    const { action, guestToken, ticket } = req.body || {};
    try {
      if (action === "createGuestMergeTicket") {
        res.status(200).json({ ok: true, ...(await createTicket(user)) });
        return;
      }
      if (action === "claimGuestMergeTicket") {
        const result = await claimTicket({ ticket, target: user });
        console.log(JSON.stringify({ tag: "guest-merge", via: "ticket", status: result.status, recipes: result.report?.recipes }));
        sendResult(res, result);
        return;
      }
      if (action === "resumeGuestMerges") {
        const merges = await resumeMerges(user);
        res.status(200).json({
          ok: true,
          merges: merges.map((m) => ({ status: m.status, ...(m.report || {}), ...(m.cleanupPending ? { cleanupPending: true } : {}), ...(m.code ? { code: m.code, error: m.error } : {}) })),
        });
        return;
      }
      if (action === "mergeGuest" && typeof guestToken === "string" && guestToken) {
        const guest = await verifyIdToken(guestToken).catch(() => {
          throw Object.assign(new Error("Misafir oturumu doğrulanamadı."), { status: 400, code: "guest_token_invalid" });
        });
        const result = await mergeGuestInto({ guest, targetUid: user.uid, targetIsAnonymous: !!user.isAnonymous });
        console.log(JSON.stringify({ tag: "guest-merge", via: "token", status: result.status, recipes: result.report?.recipes }));
        sendResult(res, result);
        return;
      }
    } catch (e) {
      sendFailure(res, e);
      return;
    }
    res.status(400).json({ error: "Geçersiz istek." });
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
