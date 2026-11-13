import test from "node:test";
import assert from "node:assert/strict";
import { saveTicket, loadTicket, clearTicket, syncGuestMerge, summarize, TICKET_STORAGE_KEY } from "./guestMergeClient.js";

function memoryStorage({ broken = false } = {}) {
  const map = new Map();
  return {
    map,
    getItem: (k) => (broken ? null : map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      if (broken === "throw") throw new Error("quota");
      map.set(k, String(v));
    },
    removeItem: (k) => map.delete(k),
  };
}
const err = (code, message = code) => Object.assign(new Error(message), { code });

test("bilet yazımı geri okunarak doğrulanır; depo yazmıyorsa fırlatır (hesaba geçilmez)", () => {
  const s = memoryStorage();
  saveTicket(s, { ticket: "t", guestUid: "G" });
  assert.equal(loadTicket(s).ticket, "t");
  assert.throws(() => saveTicket(memoryStorage({ broken: true }), { ticket: "t", guestUid: "G" }));
  assert.throws(() => saveTicket(memoryStorage({ broken: "throw" }), { ticket: "t", guestUid: "G" }));
  clearTicket(s);
  assert.equal(loadTicket(s), null);
  s.map.set(TICKET_STORAGE_KEY, "{bozuk");
  assert.equal(loadTicket(s), null);
});

test("misafir oturumunda (ya da bilet aynı misafire aitse) hiçbir istek atılmaz / bilet talep edilmez", async () => {
  const s = memoryStorage();
  saveTicket(s, { ticket: "t", guestUid: "G" });
  const calls = [];
  assert.equal(await syncGuestMerge({ user: { uid: "G", isAnonymous: true }, storage: s, call: async (b) => calls.push(b) }), null);
  assert.equal(calls.length, 0);
  await syncGuestMerge({ user: { uid: "G", isAnonymous: false }, storage: s, call: async (b) => (calls.push(b), { merges: [] }) });
  assert.deepEqual(calls.map((c) => c.action), ["resumeGuestMerges"]);
  assert.equal(loadTicket(s), null, "aynı uid ile bağlanan misafirin bileti silinir");
});

test("talep başarılı: bilet silinir, sonuç özetlenir; geçici hata: bilet kalır, sonraki açılışta yeniden denenir", async () => {
  const s = memoryStorage();
  saveTicket(s, { ticket: "t", guestUid: "G" });
  let fail = true;
  const call = async (b) => {
    if (b.action === "claimGuestMergeTicket") {
      if (fail) throw err(undefined, "ağ hatası");
      return { status: "done", recipes: 3, pantry: 1, families: { F1: { result: "transferred" } } };
    }
    return { merges: [] };
  };
  const first = await syncGuestMerge({ user: { uid: "R" }, storage: s, call });
  assert.equal(first.status, "failed");
  assert.ok(loadTicket(s), "geçici hatada bilet kalır");
  fail = false;
  const second = await syncGuestMerge({ user: { uid: "R" }, storage: s, call });
  assert.deepEqual({ status: second.status, recipes: second.recipes, families: second.families }, { status: "done", recipes: 3, families: 1 });
  assert.equal(loadTicket(s), null);
});

test("kalıcı hata kodları bileti siler; sınır (429) bileti tutar", async () => {
  for (const [code, keep] of [["ticket_not_found", false], ["guest_already_merged", false], ["guest_merge_limit", true]]) {
    const s = memoryStorage();
    saveTicket(s, { ticket: "t", guestUid: "G" });
    const out = await syncGuestMerge({
      user: { uid: "R" },
      storage: s,
      call: async (b) => {
        if (b.action === "claimGuestMergeTicket") throw err(code);
        return { merges: [] };
      },
    });
    assert.equal(!!loadTicket(s), keep, code);
    if (code === "guest_merge_limit") assert.equal(out.status, "limit");
    if (code === "ticket_not_found") assert.equal(out, null, "bulunamayan bilet sessizce atılır");
  }
});

test("bilet yokken de (başka cihaz) sunucudaki yarım taşıma sürdürülür ve görünür olur", async () => {
  const out = await syncGuestMerge({
    user: { uid: "R" },
    storage: memoryStorage(),
    call: async () => ({ merges: [{ status: "in_progress", recipes: 0 }] }),
  });
  assert.equal(out.status, "merging");
  assert.equal(summarize([{ status: "blocked", code: "guest_merge_capacity", error: "sığmadı" }]).status, "blocked");
  assert.equal(summarize([]), null);
});

test("K1: bağlanmamış bilet dururken yeni geçiş onu ezmez; sync ikisini de sırayla talep eder, bağlananları siler", async () => {
  const { loadTickets } = await import("./guestMergeClient.js");
  const s = memoryStorage();
  saveTicket(s, { ticket: "t1", guestUid: "G1" });
  saveTicket(s, { ticket: "t2", guestUid: "G2" });
  saveTicket(s, { ticket: "t2b", guestUid: "G2" }); // aynı misafirin yeni bileti eskisinin yerine
  assert.deepEqual(loadTickets(s).map((t) => t.ticket), ["t1", "t2b"]);
  const claimed = [];
  const out = await syncGuestMerge({
    user: { uid: "R" },
    storage: s,
    call: async (b) => {
      if (b.action === "claimGuestMergeTicket") {
        claimed.push(b.ticket);
        if (b.ticket === "t1") return { status: "deferred", startAfter: 2000 };
        throw err(undefined, "ağ");
      }
      return { merges: [{ status: "deferred", startAfter: 1000 }] };
    },
  });
  assert.deepEqual(claimed, ["t1", "t2b"]);
  assert.deepEqual(loadTickets(s).map((t) => t.ticket), ["t2b"], "ertelenmiş ama bağlanmış bilet silinir; geçici hatalı kalır");
  assert.equal(out.status, "failed");
  // Eski tek-nesne biçimi de okunur.
  const old = memoryStorage();
  old.map.set(TICKET_STORAGE_KEY, JSON.stringify({ ticket: "x", guestUid: "G" }));
  assert.equal(loadTicket(old).ticket, "x");
});

test("K1/K2: özet ertelenmiş taşımanın en erken tarihini ve birleştirilen alışveriş listesini taşır", () => {
  const d = summarize([{ status: "deferred", startAfter: 5000 }, { status: "deferred", startAfter: 3000 }]);
  assert.deepEqual({ status: d.status, startAfter: d.startAfter }, { status: "deferred", startAfter: 3000 });
  assert.equal(summarize([{ status: "done", shoppingList: "merged" }]).shoppingMerged, true);
  assert.equal(summarize([{ status: "done", families: { F: { result: "dissolved_into_personal", shoppingList: "merged" } } }]).shoppingMerged, true);
});
