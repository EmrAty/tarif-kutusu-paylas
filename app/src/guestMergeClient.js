// Misafir → mevcut hesap taşımasının istemci tarafı (Grup 5 denetimi B1).
// Saf modül (React/Firebase yok) — node --test ile doğrudan sınanır.
//
// Akış (sunucu: api/_lib/guestMerge.js):
//  1. Misafirken, hesaba geçmeden ÖNCE: sunucudan bilet alınır ve hesaptan bağımsız
//     kalıcı depoya (localStorage) yazılır; yazım doğrulanamazsa hesaba GEÇİLMEZ.
//  2. Hesaba geçilir. Giriş başarısız olur ya da kullanıcı vazgeçerse misafir
//     olarak kalınır; kullanılmayan bilet zararsızdır.
//  3. Uygulama her açılışta ve her oturum değişiminde syncGuestMerge çalıştırır:
//     cihazda bilet varsa talep edilir (başarıyla bağlanınca/bitince silinir; geçici
//     hatada kalır, sonraki açılışta yeniden denenir), sonra sunucudaki yarım
//     taşımalar sürdürülür (başka cihazda başlamış olsa bile).
export const TICKET_STORAGE_KEY = "tarif-kutusu:guest-merge-ticket";

// Bileti siler/değiştirir: kalıcı hata kodları (bilet artık işe yaramaz).
const TICKET_DEAD_CODES = new Set(["ticket_not_found", "ticket_invalid", "guest_already_merged", "same_account"]);

export function loadTicket(storage) {
  try {
    const raw = storage.getItem(TICKET_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw);
    return value && typeof value.ticket === "string" && typeof value.guestUid === "string" ? value : null;
  } catch {
    return null;
  }
}

// Yazar ve geri okuyarak doğrular. Başarısızsa fırlatır: çağıran hesaba GEÇMEMELİ.
export function saveTicket(storage, { ticket, guestUid }, now = Date.now()) {
  const value = JSON.stringify({ ticket, guestUid, savedAt: now });
  storage.setItem(TICKET_STORAGE_KEY, value);
  if (storage.getItem(TICKET_STORAGE_KEY) !== value) throw new Error("ticket_not_persisted");
}

export function clearTicket(storage) {
  try {
    storage.removeItem(TICKET_STORAGE_KEY);
  } catch {
    // depoya erişilemiyorsa bilet zaten okunamaz
  }
}

// Birden çok taşıma sonucunu tek bir arayüz durumuna indirger.
// status: "merging" | "done" | "blocked" | "limit" | "failed" | null (gösterilecek bir şey yok)
export function summarize(results) {
  const list = results.filter(Boolean);
  if (!list.length) return null;
  const sum = { recipes: 0, pantry: 0, families: 0, shoppingKept: false, skippedRecipes: 0 };
  for (const r of list) {
    sum.recipes += Number(r.recipes) || 0;
    sum.pantry += Number(r.pantry) || 0;
    sum.skippedRecipes += Number(r.skippedRecipes) || 0;
    if (r.shoppingList === "kept_existing") sum.shoppingKept = true;
    if (r.families && typeof r.families === "object") sum.families += Object.values(r.families).filter((f) => f && f.result && f.result !== "gone").length;
  }
  const order = ["failed", "limit", "blocked", "merging", "done"];
  const statusOf = (r) => (r.status === "in_progress" ? "merging" : r.code === "guest_merge_limit" ? "limit" : r.status);
  const status = order.find((s) => list.some((r) => statusOf(r) === s)) || "done";
  const withError = list.find((r) => r.error);
  return { status, ...sum, error: withError ? withError.error : null, code: withError ? withError.code || null : null };
}

// call(body) → yanıt gövdesi; hata: err.code / err.message (authedFetch gibi).
export async function syncGuestMerge({ user, storage, call }) {
  if (!user || user.isAnonymous) return null;
  const results = [];
  const stored = loadTicket(storage);
  if (stored && stored.guestUid !== user.uid) {
    try {
      const res = await call({ action: "claimGuestMergeTicket", ticket: stored.ticket });
      // Bağlandı (bitti, sürüyor ya da yer bekliyor): bundan sonra sunucu sürdürür.
      clearTicket(storage);
      results.push(res);
    } catch (e) {
      if (TICKET_DEAD_CODES.has(e.code)) {
        clearTicket(storage);
        if (e.code === "guest_already_merged") results.push({ status: "failed", code: e.code, error: e.message });
      } else {
        // Geçici hata ya da sınır: bilet kalır, sonraki açılışta yeniden denenir.
        results.push({ status: "failed", code: e.code || null, error: e.message });
      }
    }
  }
  try {
    const res = await call({ action: "resumeGuestMerges" });
    for (const m of res.merges || []) results.push(m);
  } catch (e) {
    if (!results.length) return null; // yalnızca sürdürme başarısız: sessiz, sonraki açılışta tekrar
  }
  // Talep bu çağrıda bitti; aynı taşıma resume'da tekrar görünmez.
  return summarize(results);
}
