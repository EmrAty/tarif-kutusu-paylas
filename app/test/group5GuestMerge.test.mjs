// Grup 5 — denetim B1/B2: dayanıklı misafir → mevcut hesap taşıma.
// Bellek içi Redis (gerçek Lua) + sahte Firebase; gerçek ağ yok, sabit bekleme yok.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { setRoutes, invoke, resetDb, json, db, redisLog, setRedisFault, idToken } from "./helpers/fakeServices.mjs";

{
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.FIREBASE_SERVICE_ACCOUNT_KEY = JSON.stringify({
    client_email: "test@tarif-kutusu.test",
    project_id: "tarif-kutusu",
    private_key: privateKey.export({ format: "pem", type: "pkcs8" }),
  });
}

const { default: account } = await import("../api/account.js");
const { default: families } = await import("../api/families.js");
const { default: dataHandler } = await import("../api/data.js");
const { __setGuestMergeClockForTests, GUEST_MERGE_LIMIT, ticketKey, hashTicket } = await import("../api/_lib/guestMerge.js");

let firebaseDeleted = [];
function okRoutes() {
  setRoutes([
    ["https://oauth2.googleapis.com/token", () => json(200, { access_token: "x", expires_in: 3600 })],
    ["https://identitytoolkit.googleapis.com/v1/projects/tarif-kutusu/accounts:delete", (url, init) => {
      firebaseDeleted.push(JSON.parse(init.body).localId);
      return json(200, {});
    }],
  ]);
}
function reset() {
  resetDb();
  firebaseDeleted = [];
  __setGuestMergeClockForTests(null);
  okRoutes();
}

const recipe = (id, extra = {}) => ({ id, title: `Tarif ${id}`, ingredients: [], instructions: [], ...extra });
const stored = (key) => JSON.parse(db.get(key) || "null");
const createTicket = (guest) => invoke(account, { uid: guest, anonymous: true, body: { action: "createGuestMergeTicket" } });
const claim = (target, ticket, opts = {}) => invoke(account, { uid: target, ...opts, body: { action: "claimGuestMergeTicket", ticket } });
const resume = (target) => invoke(account, { uid: target, body: { action: "resumeGuestMerges" } });
const index = (target) => JSON.parse(db.get(`user:${target}:guestMerges`) || "{}");
const guestKeys = (g) =>
  [...db.keys()].filter((k) => k.startsWith(`user:${g}:`) || k.startsWith(`guest-merge:state:${g}`) || k === `guest-merge:lock:${g}`);
const ids = (key) => (stored(key) || []).map((r) => r.id).sort();

function seedGuest(g = "G", { familyOwner = false } = {}) {
  db.set(`user:${g}:recipes`, JSON.stringify([recipe("g1"), recipe("g2"), recipe("shared")]));
  db.set(`user:${g}:pantry-items`, JSON.stringify(["un", "şeker"]));
  db.set(`user:${g}:shopping-list`, JSON.stringify({ selected: ["g1"], checked: {} }));
  if (familyOwner) {
    db.set(`user:${g}:profile`, JSON.stringify({ isPlus: true, families: ["F1"] }));
    db.set("user:B:profile", JSON.stringify({ isPlus: true, families: ["F1"] }));
    db.set("family:F1:meta", JSON.stringify({ name: "Ev", ownerUid: g, inviteCode: "ABCDEFGHJK" }));
    db.set("family:F1:members", JSON.stringify({ [g]: { name: "Misafir", joinedAt: 1 }, B: { name: "B", joinedAt: 2 } }));
    db.set("invite:ABCDEFGHJK:family", "F1");
    db.set("family:F1:recipes", JSON.stringify([recipe("f1")]));
  }
}
function seedTarget(t = "REAL", { plus = true, families: fams = [] } = {}) {
  db.set(`user:${t}:profile`, JSON.stringify({ isPlus: plus, families: fams }));
  db.set(`user:${t}:recipes`, JSON.stringify([recipe("shared"), recipe("t1")]));
  db.set(`user:${t}:pantry-items`, JSON.stringify(["un"]));
}
function seedFullTarget(t = "REAL") {
  seedTarget(t, { families: ["X1", "X2"] });
  for (const id of ["X1", "X2"]) {
    db.set(`family:${id}:meta`, JSON.stringify({ name: id, ownerUid: t, inviteCode: `CODE${id}AAAA` }));
    db.set(`family:${id}:members`, JSON.stringify({ [t]: { name: "R", joinedAt: 1 } }));
  }
}

function assertMergedOutcome(target = "REAL", guest = "G", { family = false } = {}) {
  assert.deepEqual(ids(`user:${target}:recipes`), ["g1", "g2", "shared", "t1"]);
  assert.deepEqual(stored(`user:${target}:pantry-items`), ["un", "şeker"]);
  assert.deepEqual(stored(`user:${target}:shopping-list`), { selected: ["g1"], checked: {} });
  assert.deepEqual(guestKeys(guest), [], "misafir kalıntısı yok");
  assert.equal(index(target)[guest].status, "done");
  assert.ok(firebaseDeleted.includes(guest), "anonim Firebase kullanıcısı silindi");
  if (family) {
    assert.equal(stored("family:F1:meta").ownerUid, target);
    assert.deepEqual(Object.keys(stored("family:F1:members")).sort(), ["B", target].sort());
    assert.deepEqual(stored(`user:${target}:profile`).families, ["F1"]);
    assert.deepEqual(stored("user:B:profile").families, ["F1"]);
  }
}

test("B1: bilet → hesaba geç → talep: veri taşınır, misafir silinir; bilet düz metin/TTL'li saklanmaz; aynı hedefin tekrarı sonucu görür, başka hedef 409", async () => {
  reset();
  seedGuest();
  seedTarget();
  const t = await createTicket("G");
  assert.equal(t.status, 200);
  assert.match(t.body.ticket, /^[A-Za-z0-9_-]{43}$/);
  const ticketSet = redisLog.find((c) => c[0] === "SET" && String(c[1]).startsWith("guest-merge:ticket:"));
  assert.equal(ticketSet[1], ticketKey(hashTicket(t.body.ticket)));
  assert.ok(!ticketSet.map(String).includes("EX"), "açık bilet kaydında süre yok");
  assert.equal(JSON.stringify([...db.entries()]).includes(t.body.ticket), false, "gizli değer düz metin saklanmaz");
  const c = await claim("REAL", t.body.ticket);
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.status, "done");
  assert.equal(c.body.recipes, 2);
  assertMergedOutcome();
  const again = await claim("REAL", t.body.ticket);
  assert.equal(again.body.status, "done");
  assert.equal(again.body.recipes, 2);
  assert.equal(ids("user:REAL:recipes").length, 4, "tekrar kopya üretmez");
  assert.equal((await claim("OTHER", t.body.ticket)).status, 409);
});

test("B1: talep günler sonra da çalışır (misafir token'ı hiç kullanılmaz, süre dolumu kayıp yaratmaz)", async () => {
  reset();
  seedGuest();
  seedTarget();
  const { ticket } = (await createTicket("G")).body;
  __setGuestMergeClockForTests(() => Date.now() + 10 * 24 * 3600 * 1000);
  const c = await claim("REAL", ticket);
  assert.equal(c.body.status, "done", JSON.stringify(c.body));
  assertMergedOutcome();
});

test("B1: vazgeçme / başarısız giriş: misafir değişmeden kalır; yeni bilet eskisini geçersiz kılar", async () => {
  reset();
  seedGuest();
  const first = (await createTicket("G")).body.ticket;
  const second = (await createTicket("G")).body.ticket;
  const w = await invoke(dataHandler, {
    method: "POST",
    uid: "G",
    anonymous: true,
    body: { bucket: "pantry-items", scope: "personal", value: JSON.stringify(["un", "şeker", "tuz"]), baseVersion: 1 },
  });
  assert.equal(w.status, 200, "misafir dondurulmadı");
  assert.equal((await claim("REAL", first)).status, 404, "eski bilet geçersiz");
  assert.equal(stored("user:G:recipes").length, 3);
  assert.equal((await claim("REAL", second)).body.status, "done");
  assert.deepEqual(stored("user:REAL:pantry-items"), ["un", "şeker", "tuz"]);
});

test("B1: bağlanınca misafir dondurulur; temizlik yarım kalırsa (Firebase hatası) sonraki açılış bitirir", async () => {
  reset();
  seedGuest();
  seedTarget();
  const { ticket } = (await createTicket("G")).body;
  setRoutes([["https://oauth2.googleapis.com/token", () => json(500, {})]]);
  const c = await claim("REAL", ticket);
  assert.equal(c.body.status, "done");
  assert.equal(c.body.cleanupPending, true);
  const w = await invoke(dataHandler, { method: "POST", uid: "G", anonymous: true, body: { bucket: "pantry-items", scope: "personal", value: "[]", baseVersion: 0 } });
  assert.equal(w.status, 401, "misafir oturumu artık yazamaz");
  okRoutes();
  const r = await resume("REAL");
  assert.equal(r.body.merges[0].status, "done");
  assertMergedOutcome();
});

test("B1: HER yazım adımında kesinti + devam: sonuç aynı, kopya yok, aile sahipsiz kalmaz, veri kaybı yok", async () => {
  const WRITES = new Set(["SET", "DEL", "EVAL"]);
  let crashPoints = 0;
  for (let k = 1; k < 300; k++) {
    reset();
    seedGuest("G", { familyOwner: true });
    seedTarget("REAL");
    const { ticket } = (await createTicket("G")).body;
    let n = 0;
    let fired = false;
    setRedisFault((cmd) => {
      if (fired || !WRITES.has(String(cmd[0]).toUpperCase())) return false;
      if (++n === k) {
        fired = true;
        return true;
      }
      return false;
    });
    await claim("REAL", ticket);
    setRedisFault(null);
    if (!fired) break; // k, kesintisiz bir çalıştırmadaki yazım sayısını aştı
    crashPoints++;
    // Her an aile ya bir sahibe sahip ya da hiç değişmemiş olmalı.
    const meta = stored("family:F1:meta");
    assert.ok(meta && stored("family:F1:members")[meta.ownerUid], `k=${k}: aile sahipsiz kalmadı`);
    // İstemci: her açılışta önce yarım taşımaları sürdürür; bilet hâlâ cihazdaysa onu da ister.
    // Kilidin TTL'i dolmuş sayılır.
    for (let attempt = 0; attempt < 4; attempt++) {
      db.delete("guest-merge:lock:G");
      await resume("REAL"); // her açılışta en az bir kez
      if (index("REAL").G?.status === "done") break;
      db.delete("guest-merge:lock:G");
      await claim("REAL", ticket);
    }
    await resume("REAL");
    assertMergedOutcome("REAL", "G", { family: true });
    assert.deepEqual(stored("family:F1:recipes").map((r) => r.id), ["f1"], `k=${k}: aile içeriği korunur`);
  }
  assert.ok(crashPoints > 20, `yeterince kesinti noktası denendi (${crashPoints})`);
});

test("B1: bağlandıktan sonra kesinti — cihazdaki bilet olmadan (başka cihaz) resume ile tamamlanır", async () => {
  reset();
  seedGuest();
  seedTarget();
  const { ticket } = (await createTicket("G")).body;
  setRedisFault((cmd) => String(cmd[0]).toUpperCase() === "EVAL" && cmd.includes("user:REAL:recipes"));
  const c = await claim("REAL", ticket);
  assert.ok(c.status >= 500, JSON.stringify(c.body));
  setRedisFault(null);
  assert.equal(index("REAL").G.status, "pending");
  const r = await resume("REAL");
  assert.equal(r.status, 200);
  assert.equal(r.body.merges.length, 1);
  assert.equal(r.body.merges[0].status, "done");
  assertMergedOutcome();
  assert.deepEqual((await resume("REAL")).body.merges, [], "bitmiş taşıma yeniden çalışmaz");
});

test("B1: çift çağrı (aynı anda iki talep + devam) kopya üretmez", async () => {
  reset();
  seedGuest();
  seedTarget();
  const { ticket } = (await createTicket("G")).body;
  const results = await Promise.all([claim("REAL", ticket), claim("REAL", ticket), resume("REAL")]);
  for (const r of results) assert.equal(r.status, 200, JSON.stringify(r.body));
  for (let i = 0; i < 3 && index("REAL").G?.status !== "done"; i++) await resume("REAL");
  assertMergedOutcome();
});

test("B1: iki hedef aynı bileti ister: yalnızca biri bağlanır; diğerinde hiçbir şey yazılmaz", async () => {
  reset();
  seedGuest();
  seedTarget("R1");
  seedTarget("R2");
  const { ticket } = (await createTicket("G")).body;
  const [a, b] = await Promise.all([claim("R1", ticket), claim("R2", ticket)]);
  assert.equal([a, b].filter((r) => r.status === 200).length, 1, JSON.stringify([a.body, b.body]));
  const lost = [a, b].find((r) => r.status === 409);
  assert.ok(lost);
  assert.equal(lost.body.code, "guest_already_merged");
  const loser = a.status === 409 ? "R1" : "R2";
  assert.deepEqual(ids(`user:${loser}:recipes`), ["shared", "t1"]);
  assert.equal(index(loser).G, undefined, "kaybedenin dizininde kayıt kalmaz");
  assert.deepEqual((await resume(loser)).body.merges, []);
});

test("B2: hedef hesap taşıma sürerken silinirse misafir kalıntısı ve taşıma kayıtları da silinir", async () => {
  reset();
  seedGuest();
  seedTarget();
  const { ticket } = (await createTicket("G")).body;
  setRedisFault((cmd) => String(cmd[0]).toUpperCase() === "EVAL" && cmd.includes("user:REAL:pantry-items"));
  await claim("REAL", ticket);
  setRedisFault(null);
  assert.equal(index("REAL").G.status, "pending");
  assert.equal((await invoke(account, { method: "DELETE", uid: "REAL" })).status, 200);
  assert.deepEqual(guestKeys("G"), []);
  assert.deepEqual([...db.keys()].filter((k) => k.startsWith("user:REAL:") || k.startsWith("guest-merge:")), []);
  assert.ok(firebaseDeleted.includes("G") && firebaseDeleted.includes("REAL"));
  assert.equal((await claim("REAL2", ticket)).status, 404, "bilet de silindi");
});

test("B2: taşıma bittikten sonra hedef silinince misafirden hiçbir iz kalmaz (tamamlanmış bilet kaydı dahil)", async () => {
  reset();
  seedGuest();
  seedTarget();
  const { ticket } = (await createTicket("G")).body;
  assert.equal((await claim("REAL", ticket)).body.status, "done");
  assert.ok(db.has(ticketKey(hashTicket(ticket))), "tamamlanmış bilet kaydı (30 gün)");
  assert.equal((await invoke(account, { method: "DELETE", uid: "REAL" })).status, 200);
  const left = [...db.keys()].filter((k) => !k.startsWith("deleted-account:") && !k.startsWith("rl:"));
  assert.deepEqual(left, []);
});

test("B2: misafir kendi hesabını silerse açık bileti ve durum kaydı da silinir", async () => {
  reset();
  seedGuest();
  const { ticket } = (await createTicket("G")).body;
  assert.equal((await invoke(account, { method: "DELETE", uid: "G", anonymous: true })).status, 200);
  assert.deepEqual([...db.keys()].filter((k) => k.startsWith("guest-merge:") || k.startsWith("user:G:")), []);
  assert.equal((await claim("REAL", ticket)).status, 404);
});

test("B2: hedef başına 30 günde en çok N taşıma; sınırda bilet bağlanmaz, misafir silinmez/dondurulmaz, bilet geçerli kalır", async () => {
  reset();
  seedTarget("REAL");
  const tickets = [];
  for (let i = 0; i <= GUEST_MERGE_LIMIT; i++) {
    db.set(`user:G${i}:recipes`, JSON.stringify([recipe(`x${i}`)]));
    tickets.push((await createTicket(`G${i}`)).body.ticket);
  }
  for (let i = 0; i < GUEST_MERGE_LIMIT; i++) assert.equal((await claim("REAL", tickets[i])).body.status, "done");
  const over = await claim("REAL", tickets[GUEST_MERGE_LIMIT]);
  assert.equal(over.status, 429);
  assert.equal(over.body.code, "guest_merge_limit");
  assert.equal(stored(`user:G${GUEST_MERGE_LIMIT}:recipes`).length, 1, "misafir verisi duruyor");
  assert.equal(db.has(`deleted-account:G${GUEST_MERGE_LIMIT}`), false, "misafir dondurulmadı");
  __setGuestMergeClockForTests(() => Date.now() + 31 * 24 * 3600 * 1000);
  const later = await claim("REAL", tickets[GUEST_MERGE_LIMIT]);
  assert.equal(later.body.status, "done", JSON.stringify(later.body));
});

test("B1: misafir (anonim) hedefe taşıma yok; geçersiz/bilinmeyen bilet 400/404; kayıtlı hesap bilet üretemez", async () => {
  reset();
  seedGuest();
  const { ticket } = (await createTicket("G")).body;
  const anonTarget = await claim("ANON2", ticket, { anonymous: true });
  assert.equal(anonTarget.status, 400);
  assert.equal(anonTarget.body.code, "target_is_guest");
  assert.equal((await claim("REAL", "kısa")).status, 400);
  assert.equal((await claim("REAL", "A".repeat(43))).status, 404);
  assert.equal((await invoke(account, { uid: "REAL", body: { action: "createGuestMergeTicket" } })).body.code, "not_guest");
});

test("B1: kapasite: hedef liste tavanın 2 katını aşacaksa taşıma durur, misafir verisi kalır; yer açılınca devam eder", async () => {
  reset();
  seedGuest();
  db.set("user:REAL:profile", JSON.stringify({ isPlus: true, families: [] }));
  const big = Array.from({ length: 4000 }, (_, i) => recipe(`t${i}`));
  db.set("user:REAL:recipes", JSON.stringify(big));
  const { ticket } = (await createTicket("G")).body;
  const c = await claim("REAL", ticket);
  assert.equal(c.body.status, "blocked");
  assert.equal(c.body.code, "guest_merge_capacity");
  assert.equal(stored("user:G:recipes").length, 3);
  db.set("user:REAL:recipes", JSON.stringify(big.slice(0, 100)));
  db.delete("user:REAL:recipes:version");
  const r = await resume("REAL");
  assert.equal(r.body.merges[0].status, "done", JSON.stringify(r.body));
  assert.equal(stored("user:REAL:recipes").length, 103);
});

// ---- aile devri ----

test("B1 aile: misafir sahipse üyelik + sahiplik hedefe geçer (kıdem korunur); hedef kodu yenileyebilir", async () => {
  reset();
  seedGuest("G", { familyOwner: true });
  seedTarget("REAL");
  const c = await claim("REAL", (await createTicket("G")).body.ticket);
  assert.equal(c.body.status, "done");
  assert.equal(c.body.families.F1.result, "transferred");
  assertMergedOutcome("REAL", "G", { family: true });
  assert.equal(stored("family:F1:members").REAL.joinedAt, 1);
  const rot = await invoke(families, { uid: "REAL", body: { action: "rotateCode", familyId: "F1" } });
  assert.equal(rot.status, 200, JSON.stringify(rot.body));
});

test("B1 aile: Plus'sız hedef de üye olur (aile kilitli görünür); sahiplik yine hedefte", async () => {
  reset();
  seedGuest("G", { familyOwner: true });
  seedTarget("REAL", { plus: false });
  const c = await claim("REAL", (await createTicket("G")).body.ticket);
  assert.equal(c.body.families.F1.result, "transferred");
  assert.equal(stored("family:F1:meta").ownerUid, "REAL");
  assert.deepEqual(stored("user:REAL:profile").families, ["F1"]);
});

test("B1 aile: hedef zaten üyeyse yalnızca misafir çıkar, sahiplik hedefe geçer", async () => {
  reset();
  seedGuest("G", { familyOwner: true });
  seedTarget("REAL", { families: ["F1"] });
  db.set("family:F1:members", JSON.stringify({ ...stored("family:F1:members"), REAL: { name: "Gerçek", joinedAt: 3 } }));
  const c = await claim("REAL", (await createTicket("G")).body.ticket);
  assert.equal(c.body.families.F1.result, "already_member");
  assert.equal(stored("family:F1:meta").ownerUid, "REAL");
  assert.deepEqual(Object.keys(stored("family:F1:members")).sort(), ["B", "REAL"]);
  assert.equal(stored("family:F1:members").REAL.name, "Gerçek");
});

test("B1 aile: hedef 2 aile sınırında, başka üye varsa sahiplik o üyeye geçer, misafir ayrılır; aile ve içeriği kalır", async () => {
  reset();
  seedGuest("G", { familyOwner: true });
  seedFullTarget("REAL");
  const c = await claim("REAL", (await createTicket("G")).body.ticket);
  assert.equal(c.body.families.F1.result, "left_handed_off");
  assert.equal(stored("family:F1:meta").ownerUid, "B");
  assert.deepEqual(Object.keys(stored("family:F1:members")), ["B"]);
  assert.deepEqual(stored("family:F1:recipes").map((r) => r.id), ["f1"]);
  assert.deepEqual(stored("user:REAL:profile").families, ["X1", "X2"]);
});

test("B1 aile: hedef sınırda ve misafir tek üyeyse içerik hedefin kişisel listesine kopyalanır, sonra aile silinir; sayılır", async () => {
  reset();
  seedGuest();
  db.set("user:G:profile", JSON.stringify({ isPlus: true, families: ["F9"] }));
  db.set("family:F9:meta", JSON.stringify({ name: "Tek", ownerUid: "G", inviteCode: "ZZZZZZZZZZ" }));
  db.set("family:F9:members", JSON.stringify({ G: { name: "Misafir", joinedAt: 1 } }));
  db.set("invite:ZZZZZZZZZZ:family", "F9");
  db.set("family:F9:recipes", JSON.stringify([recipe("fam1"), recipe("t1", { title: "aynı id farklı içerik" })]));
  db.set("family:F9:pantry-items", JSON.stringify(["pirinç"]));
  db.set("family:F9:shopping-list", JSON.stringify({ selected: ["fam1"] }));
  seedFullTarget("REAL");
  const c = await claim("REAL", (await createTicket("G")).body.ticket);
  assert.equal(c.body.status, "done", JSON.stringify(c.body));
  const f = c.body.families.F9;
  assert.equal(f.result, "dissolved_into_personal");
  assert.equal(f.recipes, 2);
  assert.equal(f.pantry, 1);
  assert.equal(f.shoppingList, "not_copied_target_list_not_empty");
  const titles = stored("user:REAL:recipes").map((r) => r.title);
  for (const t of ["Tarif fam1", "aynı id farklı içerik", "Tarif t1"]) assert.ok(titles.includes(t), `${t} kaybolmaz`);
  assert.ok(stored("user:REAL:pantry-items").includes("pirinç"));
  assert.equal(db.has("family:F9:meta"), false);
  assert.equal(db.has("invite:ZZZZZZZZZZ:family"), false);
});

test("B1 eski yol: mergeGuest (guestToken) aynı dayanıklı motoru kullanır; tamamlanınca tekrar çağrı sonucu döndürür", async () => {
  reset();
  seedGuest();
  seedTarget();
  const tok = idToken("G", { anonymous: true });
  const r = await invoke(account, { uid: "REAL", body: { action: "mergeGuest", guestToken: tok } });
  assert.equal(r.body.status, "done");
  assert.equal(r.body.recipes, 2);
  assertMergedOutcome();
  const again = await invoke(account, { uid: "REAL", body: { action: "mergeGuest", guestToken: tok } });
  assert.equal(again.status, 200);
  assert.equal(again.body.status, "done");
  assert.equal((await invoke(account, { uid: "OTHER", body: { action: "mergeGuest", guestToken: tok } })).status, 409);
});
