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
  assert.deepEqual(g.body.families, [{ id: fam.id, name: "Ev", membership: "unverified" }]);
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
