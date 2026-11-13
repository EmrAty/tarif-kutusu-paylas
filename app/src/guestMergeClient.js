// Misafir → mevcut hesap taşımasının istemci tarafı (Grup 5 denetimi B1, K1).
// Saf modül (React/Firebase yok) — node --test ile doğrudan sınanır.
//
// Akış (sunucu: api/_lib/guestMerge.js):
//  1. Misafirken, hesaba geçmeden ÖNCE: sunucudan bilet alınır ve hesaptan bağımsız
//     kalıcı depoya (localStorage) EKLENİR; yazım doğrulanamazsa hesaba GEÇİLMEZ.
//     Depo bir LİSTE tutar (K1): bağlanmamış eski bir bilet dururken yapılan yeni
//     geçiş onu ezmez; her misafirin en güncel bileti saklanır.
//  2. Hesaba geçilir. Giriş başarısız olur ya da kullanıcı vazgeçerse misafir
//     olarak kalınır; kullanılmayan bilet zararsızdır.
//  3. Uygulama her açılışta ve her oturum değişiminde syncGuestMerge çalıştırır:
//     cihazdaki biletler sırayla talep edilir (sunucuda bağlanınca — bitmiş, sürüyor,
//     yer bekliyor ya da sıraya alınmış — silinir; geçici hatada kalır), sonra
//     sunucudaki yarım/sıradaki taşımalar sürdürülür (başka cihazda başlamış olsa bile).
export const TICKET_STORAGE_KEY = "tarif-kutusu:guest-merge-ticket";
const MAX_STORED_TICKETS = 20;

// Bileti siler: kalıcı hata kodları (bilet artık işe yaramaz).
const TICKET_DEAD_CODES = new Set(["ticket_not_found", "ticket_invalid", "guest_already_merged", "same_account"]);

const validEntry = (v) => v && typeof v.ticket === "string" && typeof v.guestUid === "string";

// Eski biçim (tek nesne) de okunur.
export function loadTickets(storage) {
  try {
    const raw = storage.getItem(TICKET_STORAGE_KEY);
    if (!raw) return [];
    const value = JSON.parse(raw);
    const list = Array.isArray(value) ? value : [value];
    return list.filter(validEntry);
  } catch {
    return [];
  }
}

export const loadTicket = (storage) => loadTickets(storage)[0] || null;

function writeTickets(storage, list) {
  if (!list.length) {
    storage.removeItem(TICKET_STORAGE_KEY);
    return null;
  }
  const value = JSON.stringify(list.slice(-MAX_STORED_TICKETS));
  storage.setItem(TICKET_STORAGE_KEY, value);
  return value;
}

// Ekler (aynı misafirin eski biletinin yerine) ve geri okuyarak doğrular.
// Başarısızsa fırlatır: çağıran hesaba GEÇMEMELİ.
export function saveTicket(storage, { ticket, guestUid }, now = Date.now()) {
  const list = loadTickets(storage).filter((t) => t.guestUid !== guestUid);
  const value = writeTickets(storage, [...list, { ticket, guestUid, savedAt: now }]);
  if (storage.getItem(TICKET_STORAGE_KEY) !== value) throw new Error("ticket_not_persisted");
}

// Tek bileti (verilmezse hepsini) siler.
export function clearTicket(storage, ticket) {
  try {
    if (ticket === undefined) storage.removeItem(TICKET_STORAGE_KEY);
    else writeTickets(storage, loadTickets(storage).filter((t) => t.ticket !== ticket));
  } catch {
    // depoya erişilemiyorsa bilet zaten okunamaz
  }
}

// Birden çok taşıma sonucunu tek bir arayüz durumuna indirger.
// status: "failed" | "limit" | "blocked" | "merging" | "deferred" | "done"; boşsa null.
export function summarize(results) {
  const list = results.filter(Boolean);
  if (!list.length) return null;
  const sum = { recipes: 0, pantry: 0, families: 0, shoppingMerged: false, skippedRecipes: 0, startAfter: null };
  for (const r of list) {
    sum.recipes += Number(r.recipes) || 0;
    sum.pantry += Number(r.pantry) || 0;
    sum.skippedRecipes += Number(r.skippedRecipes) || 0;
    if (r.shoppingList === "merged") sum.shoppingMerged = true;
    if (r.families && typeof r.families === "object") {
      const fams = Object.values(r.families).filter((f) => f && f.result && f.result !== "gone");
      sum.families += fams.length;
      if (fams.some((f) => f.shoppingList === "merged")) sum.shoppingMerged = true;
    }
    if (r.status === "deferred" && Number.isFinite(r.startAfter)) {
      sum.startAfter = sum.startAfter == null ? r.startAfter : Math.min(sum.startAfter, r.startAfter);
    }
  }
  const order = ["failed", "limit", "blocked", "merging", "deferred", "done"];
  const statusOf = (r) => (r.status === "in_progress" ? "merging" : r.code === "guest_merge_limit" ? "limit" : r.status);
  const status = order.find((s) => list.some((r) => statusOf(r) === s)) || "done";
  const withError = list.find((r) => r.error);
  return { status, ...sum, error: withError ? withError.error : null, code: withError ? withError.code || null : null };
}

// call(body) → yanıt gövdesi; hata: err.code / err.message (authedFetch gibi).
export async function syncGuestMerge({ user, storage, call }) {
  if (!user || user.isAnonymous) return null;
  const results = [];
  for (const stored of loadTickets(storage)) {
    if (stored.guestUid === user.uid) continue;
    try {
      const res = await call({ action: "claimGuestMergeTicket", ticket: stored.ticket });
      // Sunucuda bağlandı: bundan sonra sunucu sürdürür, bilete gerek yok.
      clearTicket(storage, stored.ticket);
      results.push(res);
    } catch (e) {
      if (TICKET_DEAD_CODES.has(e.code)) {
        clearTicket(storage, stored.ticket);
        if (e.code === "guest_already_merged") results.push({ status: "failed", code: e.code, error: e.message });
      } else {
        // Geçici hata ya da bekleyen sınırı dolu: bilet kalır, sonraki açılışta yeniden denenir.
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
  return summarize(results);
}
