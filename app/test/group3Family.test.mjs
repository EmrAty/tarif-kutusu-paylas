// Grup 3 — aile üyelik kaydının yarışları ve tutarsız kayıtların ele alınması.
// Fable D1: katılma sırasında başka üyenin görünen ad güncellemesi üye listesini
// "oku → değiştir → geri yaz" ile ezdiğinde katılan üye listeden düşüyor, profilde
// aile kalıyor; sıkı üyelik kontrolüyle 403 alıp yeniden de katılamıyordu.
// Bellek içi Redis (gerçek Lua ile EVAL); dış ağ yok.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { setRoutes, invoke, resetDb, json, db, setRedisHook, setRedisFault } from "./helpers/fakeServices.mjs";

{
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.FIREBASE_SERVICE_ACCOUNT_KEY = JSON.stringify({
    client_email: "test@tarif-kutusu.test",
    project_id: "tarif-kutusu",
    private_key: privateKey.export({ format: "pem", type: "pkcs8" }),
  });
}

const { default: families } = await import("../api/families.js");
const { default: dataHandler } = await import("../api/data.js");
const { default: profileHandler } = await import("../api/profile.js");
const { deleteAccount } = await import("../api/_lib/accountDeletion.js");
const { listBackups } = await import("../api/_lib/versionedBucket.js");

function reset() {
  resetDb();
  setRoutes([
    ["https://oauth2.googleapis.com/token", () => json(200, { access_token: "x", expires_in: 3600 })],
    ["https://", () => json(200, {})],
  ]);
}

const plus = (uid, fams = []) => db.set(`user:${uid}:profile`, JSON.stringify({ isPlus: true, families: fams }));
const members = (id) => Object.keys(JSON.parse(db.get(`family:${id}:members`) || "{}")).sort();
const profileFamilies = (uid) => JSON.parse(db.get(`user:${uid}:profile`)).families;
const readFamily = (uid, id) => invoke(dataHandler, { method: "GET", uid, query: { bucket: "recipes", scope: "family", familyId: id } });
const join = (uid, code, memberName) => invoke(families, { uid, body: { action: "join", code, ...(memberName ? { memberName } : {}) } });
const isMembersWrite = (id) => (cmd) => (cmd[0] === "EVAL" && cmd[3] === `family:${id}:members`) || (cmd[0] === "SET" && cmd[1] === `family:${id}:members`);

async function createFamily(owner = "OWNER") {
  plus(owner);
  const r = await invoke(families, { uid: owner, body: { action: "create", name: "Ev", memberName: "Kurucu" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

// Bir yazımın tam öncesinde başka bir işlemi araya sokar (bir kez).
function interleaveOnce(predicate, action) {
  let fired = false;
  setRedisHook(async (cmd) => {
    if (fired || !predicate(cmd)) return;
    fired = true;
    setRedisHook(null);
    await action();
  });
  return () => fired;
}

test("Aile 1 (D1): katılma, başka üyenin görünen ad güncellemesiyle yarışınca katılan üye listeden düşmez", async () => {
  reset();
  const fam = await createFamily();
  plus("JOINER");
  let joinStatus;
  const fired = interleaveOnce(isMembersWrite(fam.id), async () => {
    joinStatus = (await join("JOINER", fam.inviteCode, "Yeni")).status;
  });
  await invoke(families, { method: "GET", uid: "OWNER", query: { name: "Yeni İsim" } });
  setRedisHook(null);
  assert.ok(fired(), "yarış gerçekten oluştu");
  assert.equal(joinStatus, 200);
  assert.deepEqual(members(fam.id), ["JOINER", "OWNER"]);
  const list = JSON.parse(db.get(`family:${fam.id}:members`));
  assert.equal(list.OWNER.name, "Yeni İsim", "ad güncellemesi de kaybolmadı");
  assert.equal((await readFamily("JOINER", fam.id)).status, 200);
});

test("Aile 2: iki kişi aynı anda katılınca ikisi de üye listesinde kalır", async () => {
  reset();
  const fam = await createFamily();
  plus("J1");
  plus("J2");
  interleaveOnce(isMembersWrite(fam.id), async () => {
    assert.equal((await join("J2", fam.inviteCode)).status, 200);
  });
  assert.equal((await join("J1", fam.inviteCode)).status, 200);
  setRedisHook(null);
  assert.deepEqual(members(fam.id), ["J1", "J2", "OWNER"]);
  assert.equal((await readFamily("J1", fam.id)).status, 200);
  assert.equal((await readFamily("J2", fam.id)).status, 200);
});

test("Aile 3: bir üye ayrılırken başka biri katılırsa ikisi de doğru sonuçlanır", async () => {
  reset();
  const fam = await createFamily();
  plus("LEAVER");
  plus("NEWBIE");
  await join("LEAVER", fam.inviteCode);
  interleaveOnce(isMembersWrite(fam.id), async () => {
    assert.equal((await join("NEWBIE", fam.inviteCode)).status, 200);
  });
  assert.equal((await invoke(families, { uid: "LEAVER", body: { action: "leave", familyId: fam.id } })).status, 200);
  setRedisHook(null);
  assert.deepEqual(members(fam.id), ["NEWBIE", "OWNER"]);
  assert.deepEqual(profileFamilies("LEAVER"), []);
  assert.equal((await readFamily("LEAVER", fam.id)).status, 403);
});

test("Aile 4: profil yarışı — aynı anda iki aileye katılma ve Plus değişikliği birbirini ezmez", async () => {
  reset();
  const f1 = await createFamily("O1");
  const f2 = await createFamily("O2");
  plus("U");
  interleaveOnce((cmd) => cmd[0] === "EVAL" && cmd[3] === "user:U:profile", async () => {
    assert.equal((await join("U", f2.inviteCode)).status, 200);
  });
  assert.equal((await join("U", f1.inviteCode)).status, 200);
  setRedisHook(null);
  assert.deepEqual(profileFamilies("U").sort(), [f1.id, f2.id].sort());
  assert.equal((await readFamily("U", f1.id)).status, 200);
  assert.equal((await readFamily("U", f2.id)).status, 200);
});

test("Aile 5: mevcut tutarsız kayıt (profilde var, üye listesinde yok) → erişim yok, otomatik üyelik yok, davet kodu sızmaz", async () => {
  reset();
  const fam = await createFamily();
  plus("GHOST", [fam.id]); // eski yarıştan kalmış kayıt
  assert.equal((await readFamily("GHOST", fam.id)).status, 403);
  // Aile listesi: yalnızca ad + durum; davet kodu ve üyeler yok.
  const g = await invoke(families, { method: "GET", uid: "GHOST", query: { name: "Hayalet" } });
  assert.equal(g.status, 200);
  // Eski web paketi uyumluluğu: members/inviteCode/ownerUid alanları var ama boş.
  assert.deepEqual(g.body.families, [{ id: fam.id, name: "Ev", membership: "unverified", inviteCode: null, ownerUid: null, members: [] }]);
  // Ad senkronizasyonu üye EKLEMEZ.
  assert.deepEqual(members(fam.id), ["OWNER"]);
  assert.equal((await readFamily("GHOST", fam.id)).status, 403);
});

test("Aile 6: tutarsız kayıt geçerli davet koduyla onarılır; yanlış kodla onarılamaz", async () => {
  reset();
  const fam = await createFamily();
  plus("GHOST", [fam.id]);
  assert.equal((await join("GHOST", "ZZZZZZ")).status, 404);
  assert.deepEqual(members(fam.id), ["OWNER"]);
  const r = await join("GHOST", fam.inviteCode, "Geri Döndüm");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.repaired, true);
  assert.equal(r.body.membership, "verified");
  assert.deepEqual(members(fam.id), ["GHOST", "OWNER"]);
  assert.deepEqual(profileFamilies("GHOST"), [fam.id], "aile profilde tekrarlanmadı");
  assert.equal((await readFamily("GHOST", fam.id)).status, 200);
  // Tam üye için yeniden katılma hâlâ "zaten üyesin".
  assert.equal((await join("GHOST", fam.inviteCode)).status, 400);
});

test("Aile 7: ters tutarsızlık (üye listesinde var, profilde yok) → erişim yok; aynı kodla katılma onarır, katılma tarihi korunur", async () => {
  reset();
  const fam = await createFamily();
  plus("HALF");
  const list = JSON.parse(db.get(`family:${fam.id}:members`));
  list.HALF = { name: "Yarım", joinedAt: 42 };
  db.set(`family:${fam.id}:members`, JSON.stringify(list));
  assert.equal((await readFamily("HALF", fam.id)).status, 403);
  const r = await join("HALF", fam.inviteCode);
  assert.equal(r.status, 200);
  assert.equal(r.body.repaired, true);
  assert.equal(JSON.parse(db.get(`family:${fam.id}:members`)).HALF.joinedAt, 42);
  assert.equal((await readFamily("HALF", fam.id)).status, 200);
});

test("Aile 8: tutarsız kayıtla aileden ayrılmak mümkün ve temiz", async () => {
  reset();
  const fam = await createFamily();
  plus("GHOST", [fam.id]);
  const r = await invoke(families, { uid: "GHOST", body: { action: "leave", familyId: fam.id } });
  assert.equal(r.status, 200);
  assert.deepEqual(profileFamilies("GHOST"), []);
  assert.deepEqual(members(fam.id), ["OWNER"]);
});

test("Aile 9: profil yazılamazsa katılma geri alınır (yarım kayıt kalmaz) ve tekrar denenebilir", async () => {
  reset();
  const fam = await createFamily();
  plus("J");
  setRedisFault((cmd) => cmd[0] === "EVAL" && cmd[3] === "user:J:profile");
  const r = await join("J", fam.inviteCode);
  setRedisFault(null);
  assert.equal(r.status >= 500, true);
  assert.deepEqual(members(fam.id), ["OWNER"], "üye listesine eklenen geri alındı");
  assert.equal((await join("J", fam.inviteCode)).status, 200);
  assert.equal((await readFamily("J", fam.id)).status, 200);
});

test("Aile 10: bozuk profil kaydı varsayılanla ezilmez", async () => {
  reset();
  const fam = await createFamily();
  db.set("user:BAD:profile", "{bozuk");
  const r = await join("BAD", fam.inviteCode);
  assert.notEqual(r.status, 200);
  assert.equal(db.get("user:BAD:profile"), "{bozuk");
  const p = await invoke(profileHandler, { uid: "BAD", body: { isPlus: true } });
  assert.notEqual(p.status, 200);
  assert.equal(db.get("user:BAD:profile"), "{bozuk");
});

test("Aile 11: Plus kapatılırken aynı anda katılınan aile profilden silinmez ama kapatılan ailelerden çıkılır", async () => {
  reset();
  const f1 = await createFamily("O1");
  const f2 = await createFamily("O2");
  plus("U");
  await join("U", f1.inviteCode);
  interleaveOnce((cmd) => cmd[0] === "EVAL" && cmd[3] === "user:U:profile", async () => {
    await join("U", f2.inviteCode);
  });
  const r = await invoke(profileHandler, { uid: "U", body: { isPlus: false } });
  setRedisHook(null);
  assert.equal(r.status, 200);
  const p = JSON.parse(db.get("user:U:profile"));
  assert.equal(p.isPlus, false);
  assert.equal(p.families.includes(f1.id), false);
  assert.deepEqual(members(f1.id), ["O1"]);
  // f2 katılımı ezilmedi: profil ve üye listesi tutarlı kaldı.
  assert.equal(p.families.includes(f2.id), members(f2.id).includes("U"));
});

test("Aile 12: aile silme — üyelerin profilleri ve üye listesinin sürüm/yedek anahtarları da silinir", async () => {
  reset();
  const fam = await createFamily();
  plus("M");
  await join("M", fam.inviteCode);
  await invoke(families, { method: "GET", uid: "M", query: { name: "Yeni" } });
  assert.ok(db.has(`family:${fam.id}:members:version`));
  const r = await invoke(families, { uid: "OWNER", body: { action: "delete", familyId: fam.id } });
  assert.equal(r.status, 200);
  for (const key of [...db.keys()]) assert.equal(key.startsWith(`family:${fam.id}`), false, key);
  assert.equal(db.has(`invite:${fam.inviteCode}:family`), false);
  assert.deepEqual(profileFamilies("M"), []);
  assert.deepEqual(profileFamilies("OWNER"), []);
});

test("Aile 13: üye listesi değişiklikleri Grup 1 sürüm/yedek motoruyla yazılır (önceki hâl yedekte)", async () => {
  reset();
  const fam = await createFamily();
  plus("M");
  await join("M", fam.inviteCode);
  const { recent } = await listBackups(`family:${fam.id}:members`);
  assert.ok(recent.some((b) => Object.keys(JSON.parse(b.raw)).join() === "OWNER"), JSON.stringify(recent));
});

test("Aile 14: hesap silme — son üye değilse atomik çıkar, aynı anda katılan üye kaybolmaz", async () => {
  reset();
  const fam = await createFamily();
  plus("DEL", []);
  await join("DEL", fam.inviteCode);
  plus("LATE");
  interleaveOnce(isMembersWrite(fam.id), async () => {
    await join("LATE", fam.inviteCode);
  });
  await deleteAccount("DEL");
  setRedisHook(null);
  assert.deepEqual(members(fam.id), ["LATE", "OWNER"]);
});

test("Aile 15: salt okunur production denetim betiği tutarsız kayıtları bulur ve hiçbir şey yazmaz", async () => {
  reset();
  const fam = await createFamily();
  plus("GHOST", [fam.id]);
  plus("LOST", ["deleted-family-1"]);
  const list = JSON.parse(db.get(`family:${fam.id}:members`));
  list.HALF = { joinedAt: 3 };
  db.set(`family:${fam.id}:members`, JSON.stringify(list));
  db.set("recipes", JSON.stringify([{ id: 1 }]));
  db.set("user:A:fcmTokens", JSON.stringify(["t1", "t2"]));
  const { auditGroup3, makeReadOnlyClient } = await import("../scripts/audit-group3-readonly.mjs");
  const { runRedis } = await import("./helpers/fakeServices.mjs");
  const before = JSON.stringify([...db.entries()].map(([k, v]) => [k, typeof v === "string" ? v : "x"]));
  const run = makeReadOnlyClient(async (cmd) => runRedis(cmd));
  const report = await auditGroup3(run);
  assert.deepEqual(report.families.profileOnly, [{ familyId: fam.id, uid: "GHOST" }]);
  assert.deepEqual(report.families.membersOnly, [{ familyId: fam.id, uid: "HALF" }]);
  assert.deepEqual(report.families.missingFamily, [{ familyId: "deleted-family-1", uids: ["LOST"] }]);
  assert.equal(report.legacy.recipes.state, "invalid");
  assert.equal(report.legacy["shopping-list"].state, "missing");
  assert.equal(report.push.legacyTokens, 2);
  assert.equal(JSON.stringify([...db.entries()].map(([k, v]) => [k, typeof v === "string" ? v : "x"])), before, "hiçbir şey yazılmadı");
  await assert.rejects(run(["SET", "x", "1"]), /izin verilmeyen/);
  await assert.rejects(run(["DEL", "x"]), /izin verilmeyen/);
});

// ------------------------- silme ↔ katılma yarışı -------------------------

const familyKeysLeft = (id) => [...db.keys()].filter((k) => k.startsWith(`family:${id}:`));
const deleteFam = (owner, id) => invoke(families, { uid: owner, body: { action: "delete", familyId: id } });

// Silmenin her adımının tam öncesinde katılmayı araya sokar.
const DELETE_STEPS = [
  // Grup 4: işaret artık atomik karşılaştır-ve-yaz (EVAL) ile yazılıyor.
  ["silme işareti (meta yazımı)", (id) => (c) => (c[0] === "SET" && c[1] === `family:${id}:meta`) || (c[0] === "EVAL" && c[3] === `family:${id}:meta`)],
  ["davet kodu silme", () => (c) => c[0] === "DEL" && String(c[1]).startsWith("invite:")],
  ["üye profillerinin güncellenmesi", () => (c) => c[0] === "EVAL" && c[3] === "user:OWNER:profile"],
  ["veri/üye anahtarlarının silinmesi", (id) => (c) => c[0] === "DEL" && c.slice(1).includes(`family:${id}:members`)],
  ["meta silme", (id) => (c) => c[0] === "DEL" && c[1] === `family:${id}:meta` && c.length === 2],
];

for (const [label, predicateFor] of DELETE_STEPS) {
  test(`Aile 16: kurucu silerken katılma (${label} öncesi) → hayalet kayıt ve sahipsiz anahtar kalmaz`, async () => {
    reset();
    const fam = await createFamily();
    plus("JOINER");
    let joinStatus = null;
    const fired = interleaveOnce(predicateFor(fam.id), async () => {
      joinStatus = (await join("JOINER", fam.inviteCode)).status;
    });
    assert.equal((await deleteFam("OWNER", fam.id)).status, 200);
    setRedisHook(null);
    assert.ok(fired(), "yarış gerçekten oluştu");
    assert.ok(joinStatus === 200 || joinStatus === 404, String(joinStatus));
    assert.deepEqual(profileFamilies("JOINER"), [], "katılanın profilinde silinmiş aile kalmadı");
    assert.deepEqual(profileFamilies("OWNER"), []);
    assert.deepEqual(familyKeysLeft(fam.id), []);
  });
}

// Katılmanın her adımının tam öncesinde silmenin TAMAMINI araya sokar.
const JOIN_STEPS = [
  ["üye listesi yazımı", (id) => (c) => c[0] === "EVAL" && c[3] === `family:${id}:members`],
  ["profil yazımı", () => (c) => c[0] === "EVAL" && c[3] === "user:JOINER:profile"],
];
for (const [label, predicateFor] of JOIN_STEPS) {
  test(`Aile 17: katılma sürerken (${label} öncesi) aile tamamen silinirse katılma 404 ve geri alınır (Fable senaryosu)`, async () => {
    reset();
    const fam = await createFamily();
    plus("JOINER");
    const fired = interleaveOnce(predicateFor(fam.id), async () => {
      assert.equal((await deleteFam("OWNER", fam.id)).status, 200);
    });
    const r = await join("JOINER", fam.inviteCode);
    setRedisHook(null);
    assert.ok(fired());
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.deepEqual(profileFamilies("JOINER"), []);
    assert.deepEqual(familyKeysLeft(fam.id), [], "yeniden yaratılmış boş üye listesi de temizlendi");
    // Kota boş: iki yeni aileye katılabilir.
    const a = await createFamily("O2");
    const b = await createFamily("O3");
    assert.equal((await join("JOINER", a.inviteCode)).status, 200);
    assert.equal((await join("JOINER", b.inviteCode)).status, 200);
  });
}

test("Aile 18: mevcut hayalet kayıt — aile listesi açılınca profilden temizlenir, kota açılır", async () => {
  reset();
  const a = await createFamily("O2");
  plus("U", ["gone-family-1", "gone-family-2"]); // eski yarıştan kalmış, aile kaydı yok
  assert.equal((await join("U", a.inviteCode)).status, 200, "katılma da önce hayaletleri temizler");
  assert.deepEqual(profileFamilies("U"), [a.id]);
  plus("V", ["gone-family-3"]);
  const g = await invoke(families, { method: "GET", uid: "V" });
  assert.equal(g.status, 200);
  assert.deepEqual(g.body.families, []);
  assert.deepEqual(profileFamilies("V"), []);
});

test("Aile 19: geçici okuma hatası 'aile silinmiş' sayılmaz — meşru üyelik silinmez", async () => {
  reset();
  const fam = await createFamily();
  plus("M");
  await join("M", fam.inviteCode);
  setRedisFault((c) => c[0] === "MGET" && String(c[1]).endsWith(":meta"));
  const g = await invoke(families, { method: "GET", uid: "M" });
  const j = await join("M", "ZZZZZZ");
  setRedisFault(null);
  assert.ok(g.status >= 500, String(g.status));
  assert.ok(j.status >= 500, String(j.status));
  assert.deepEqual(profileFamilies("M"), [fam.id]);
  assert.deepEqual(members(fam.id), ["M", "OWNER"]);
  assert.equal((await readFamily("M", fam.id)).status, 200);
});

test("Aile 20: yarıda kalmış silme — erişim yok, durum görünür, kurucu tamamlar, üye ayrılabilir", async () => {
  reset();
  const fam = await createFamily();
  plus("M");
  await join("M", fam.inviteCode);
  // Silme işaretten hemen sonra çöktü.
  setRedisFault((c) => c[0] === "DEL" && String(c[1]).startsWith("invite:"));
  const crashed = await deleteFam("OWNER", fam.id);
  setRedisFault(null);
  assert.ok(crashed.status >= 500);
  assert.equal(JSON.parse(db.get(`family:${fam.id}:meta`)).deleting, true);
  assert.equal((await readFamily("M", fam.id)).status, 404, "silinmekte olan aileye erişim yok");
  plus("X");
  assert.equal((await join("X", fam.inviteCode)).status, 404, "silinmekte olan aileye katılma yok");

  const gm = await invoke(families, { method: "GET", uid: "M" });
  assert.deepEqual(gm.body.families, [{ id: fam.id, name: "Ev", membership: "deleting", inviteCode: null, ownerUid: "OWNER", members: [] }]);
  const go = await invoke(families, { method: "GET", uid: "OWNER" });
  assert.equal(go.body.families[0].membership, "deleting");

  assert.equal((await invoke(families, { uid: "M", body: { action: "leave", familyId: fam.id } })).status, 200);
  assert.deepEqual(profileFamilies("M"), []);
  assert.equal((await deleteFam("OWNER", fam.id)).status, 200, "kurucu silmeyi tamamlar");
  assert.deepEqual(familyKeysLeft(fam.id), []);
  assert.deepEqual(profileFamilies("OWNER"), []);
  assert.equal(db.has(`invite:${fam.inviteCode}:family`), false);
});

test("Aile 21: üye olmayan kişi, kurucu uid'sini bilse de silinmekte olan aileyi silemez; kurucu kimliği yalnız üyeye görünür", async () => {
  reset();
  const fam = await createFamily();
  plus("GHOST", [fam.id]);
  const meta = JSON.parse(db.get(`family:${fam.id}:meta`));
  db.set(`family:${fam.id}:meta`, JSON.stringify({ ...meta, deleting: true }));
  const g = await invoke(families, { method: "GET", uid: "GHOST" });
  assert.equal(g.body.families[0].ownerUid, null);
  assert.equal((await deleteFam("GHOST", fam.id)).status, 403);
  assert.ok(db.has(`family:${fam.id}:meta`));
});

test("Aile 22: hesabı silinen son üye — aynı anda katılan kişi hayalet kayıtla kalmaz", async () => {
  reset();
  const fam = await createFamily("SOLO");
  plus("JOINER");
  interleaveOnce((c) => c[0] === "SET" && c[1] === `family:${fam.id}:meta`, async () => {
    await join("JOINER", fam.inviteCode);
  });
  await deleteAccount("SOLO");
  setRedisHook(null);
  assert.deepEqual(profileFamilies("JOINER"), []);
  assert.deepEqual(familyKeysLeft(fam.id), []);
});

test("Aile 23: eski web paketi uyumluluğu — erişilemeyen her özette members dizisi var, bilgi sızmaz", async () => {
  reset();
  const fam = await createFamily();
  plus("GHOST", [fam.id]);
  const g = await invoke(families, { method: "GET", uid: "GHOST" });
  for (const f of g.body.families) {
    assert.ok(Array.isArray(f.members), "production paketi f.members.map(...) çağırıyor");
    assert.equal(f.members.length, 0);
    assert.equal(f.inviteCode, null);
  }
  // Production paketinin aynı ifadesi çökmeden çalışır.
  const t = (k) => k;
  const label = g.body.families[0].members.map((m) => m.name || m.email || (m.isAnonymous ? t("guest") : t("user"))).join(", ");
  assert.equal(label, "");
});
