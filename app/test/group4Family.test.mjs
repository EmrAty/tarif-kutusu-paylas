// Grup 4 — aile yönetimi: üye çıkarma, sahiplik devri, davet kodu yenileme,
// deneme sınırı, e-posta gizliliği, sahipsiz aile kalmaması.
// Bellek içi Redis (gerçek Lua ile EVAL); dış ağ yok.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { setRoutes, invoke, resetDb, json, db, setRedisHook } from "./helpers/fakeServices.mjs";

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
const { normalizeInviteCode, generateInviteCode, INVITE_ALPHABET, JOIN_LIMITS, __setInviteClockForTests } = await import("../api/_lib/inviteCodes.js");

function reset() {
  resetDb();
  __setInviteClockForTests(() => 1_800_000_000_000);
  setRoutes([
    ["https://oauth2.googleapis.com/token", () => json(200, { access_token: "x", expires_in: 3600 })],
    ["https://", () => json(200, {})],
  ]);
}

const plus = (uid, fams = []) => db.set(`user:${uid}:profile`, JSON.stringify({ isPlus: true, families: fams }));
const memberUids = (id) => Object.keys(JSON.parse(db.get(`family:${id}:members`) || "{}")).sort();
const meta = (id) => JSON.parse(db.get(`family:${id}:meta`));
const profileFamilies = (uid) => JSON.parse(db.get(`user:${uid}:profile`) || '{"families":[]}').families;
const readFamily = (uid, id) => invoke(dataHandler, { method: "GET", uid, query: { bucket: "recipes", scope: "family", familyId: id } });
const post = (uid, body, opts = {}) => invoke(families, { uid, body, ...opts });
const join = (uid, code, opts = {}) => post(uid, { action: "join", code, memberName: opts.name || uid }, opts);
const list = (uid, name) => invoke(families, { method: "GET", uid, query: name ? { name } : {} });

let clockMs = 1_000;
async function createFamily(owner = "OWNER", name = "Ev") {
  plus(owner);
  const r = await post(owner, { action: "create", name, memberName: "Sahip" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
// Katılma tarihleri belirgin sıralı olsun (en eski = ilk katılan).
async function joinAll(fam, uids) {
  for (const uid of uids) {
    plus(uid);
    const r = await join(uid, fam.inviteCode);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const m = JSON.parse(db.get(`family:${fam.id}:members`));
    m[uid].joinedAt = (clockMs += 1000);
    db.set(`family:${fam.id}:members`, JSON.stringify(m));
  }
}

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
const isMetaWrite = (id) => (c) => c[0] === "EVAL" && c[3] === `family:${id}:meta`;

// ------------------------------- davet kodu -------------------------------

test("Kod 1: yeni kod 10 karakter, güvenli alfabe; giriş tire/boşluk/küçük harf kabul eder", async () => {
  reset();
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const c = generateInviteCode();
    assert.equal(c.length, 10);
    for (const ch of c) assert.ok(INVITE_ALPHABET.includes(ch));
    seen.add(c);
  }
  assert.equal(seen.size, 200);
  assert.equal(normalizeInviteCode("abcde-fghjk"), "ABCDEFGHJK");
  assert.equal(normalizeInviteCode(" ABC DEF "), "ABCDEF"); // eski 6 karakter
  assert.equal(normalizeInviteCode("ABCDE-FGHJ0"), null); // 0 alfabede yok
  assert.equal(normalizeInviteCode("ABC"), null);

  const fam = await createFamily();
  assert.equal(fam.inviteCode.length, 10);
  plus("U");
  const pretty = `${fam.inviteCode.slice(0, 5).toLowerCase()}-${fam.inviteCode.slice(5)}`;
  assert.equal((await join("U", pretty)).status, 200);
});

test("Kod 2: eski 6 karakterli kod sahip yenileyene kadar çalışır, yenileyince çalışmaz", async () => {
  reset();
  const fam = await createFamily();
  const m = meta(fam.id);
  db.delete(`invite:${m.inviteCode}:family`);
  db.set(`family:${fam.id}:meta`, JSON.stringify({ ...m, inviteCode: "ABC234" }));
  db.set("invite:ABC234:family", JSON.stringify(fam.id));
  plus("OLD1");
  assert.equal((await join("OLD1", "abc234")).status, 200);

  const r = await post("OWNER", { action: "rotateCode", familyId: fam.id });
  assert.equal(r.status, 200);
  assert.equal(r.body.inviteCode.length, 10);
  assert.equal(db.has("invite:ABC234:family"), false);
  plus("OLD2");
  assert.equal((await join("OLD2", "ABC234")).status, 404);
  assert.equal((await join("OLD2", r.body.inviteCode)).status, 200);
});

test("Kod 3: yenilemeyi yalnızca sahip yapabilir; eski kodun silinemeyen anahtarı tek başına katılma sağlamaz", async () => {
  reset();
  const fam = await createFamily();
  await joinAll(fam, ["M1"]);
  const r = await post("M1", { action: "rotateCode", familyId: fam.id });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "not_owner");
  assert.equal(meta(fam.id).inviteCode, fam.inviteCode);

  const rot = await post("OWNER", { action: "rotateCode", familyId: fam.id });
  // Eski anahtar bir hata yüzünden kalmış olsun:
  db.set(`invite:${fam.inviteCode}:family`, JSON.stringify(fam.id));
  plus("X");
  const versionBefore = db.get(`family:${fam.id}:members:version`);
  assert.equal((await join("X", fam.inviteCode)).status, 404);
  assert.equal(db.get(`family:${fam.id}:members:version`), versionBefore, "eski kod üye listesine hiç dokunmadı");
  assert.equal((await join("X", rot.body.inviteCode)).status, 200);
});

test("Kod 4: yenileme ile silme yarışı — silme işareti ezilmez, yeni kod artık anahtar bırakmaz", async () => {
  reset();
  const fam = await createFamily();
  // Yenilemenin meta yazımından hemen önce silme TAMAMEN çalışsın.
  const fired = interleaveOnce(isMetaWrite(fam.id), async () => {
    assert.equal((await post("OWNER", { action: "delete", familyId: fam.id })).status, 200);
  });
  const r = await post("OWNER", { action: "rotateCode", familyId: fam.id });
  setRedisHook(null);
  assert.ok(fired(), "yarış gerçekten oluştu");
  assert.ok([403, 404].includes(r.status), String(r.status));
  assert.deepEqual([...db.keys()].filter((k) => k.startsWith("invite:") || k.startsWith(`family:${fam.id}`)), []);
});

test("Kod 5: silme işareti yenileme sırasında yazılırsa (eski düz SET'te kaybolurdu) işaret korunur", async () => {
  reset();
  const fam = await createFamily();
  // Silmenin işaret yazımından hemen önce yenileme araya girsin.
  let rotated;
  const fired = interleaveOnce(isMetaWrite(fam.id), async () => {
    rotated = await post("OWNER", { action: "rotateCode", familyId: fam.id });
  });
  assert.equal((await post("OWNER", { action: "delete", familyId: fam.id })).status, 200);
  setRedisHook(null);
  assert.ok(fired(), "yarış gerçekten oluştu");
  assert.equal(rotated.status, 200);
  // Silme, yenilemenin yazdığı kodu da gördü ve sildi; aile tamamen gitti.
  assert.deepEqual([...db.keys()].filter((k) => k.startsWith("invite:") || k.startsWith(`family:${fam.id}`)), []);
  plus("Z");
  assert.equal((await join("Z", rotated.body.inviteCode)).status, 404);
});

// ---------------------------- deneme sınırı -----------------------------

test("Sınır 1: yanlış kodla 5 deneme sonra 429; doğru kod da artık sorgulanmaz; doğru kodlar sayaca girmez", async () => {
  reset();
  const fam = await createFamily();
  plus("GUESS");
  for (let i = 0; i < JOIN_LIMITS.uidFailures[0].limit; i++) {
    const r = await join("GUESS", "ZZZZZ-ZZZZZ");
    assert.equal(r.status, 404);
  }
  const blocked = await join("GUESS", fam.inviteCode);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.code, "invite_rate_limited");
  assert.ok(blocked.body.retryAfter > 0);
  assert.deepEqual(memberUids(fam.id), ["OWNER"]);
  // 15 dk sonra açılır.
  __setInviteClockForTests(() => 1_800_000_000_000 + 16 * 60 * 1000);
  assert.equal((await join("GUESS", fam.inviteCode)).status, 200);

  // Doğru kodla katılan / biçimsiz giriş yapan, hata sayacına girmez.
  plus("OK");
  for (let i = 0; i < 8; i++) await join("OK", "x");
  assert.equal((await join("OK", fam.inviteCode)).status, 200);
});

test("Sınır 2: yeni misafir hesap açmak IP sınırını aşmaz", async () => {
  reset();
  const fam = await createFamily();
  let blockedAt = null;
  for (let i = 0; i < 40 && blockedAt == null; i++) {
    const uid = `ANON${i}`;
    plus(uid);
    for (let k = 0; k < 2; k++) {
      const r = await post(uid, { action: "join", code: "QQQQQQ" }, { anonymous: true, ip: "198.51.100.9" });
      if (r.status === 429) {
        blockedAt = i * 2 + k;
        break;
      }
    }
  }
  assert.equal(blockedAt, JOIN_LIMITS.ipFailures[0].limit);
  // Başka IP'deki gerçek kullanıcı etkilenmez.
  plus("REAL");
  assert.equal((await post("REAL", { action: "join", code: fam.inviteCode }, { ip: "203.0.113.50" })).status, 200);
});

test("Sınır 3: istek seli — UID başına saatlik deneme tavanı (doğru/yanlış fark etmez)", async () => {
  reset();
  plus("FLOOD");
  let last;
  for (let i = 0; i < JOIN_LIMITS.uidAttempts[0].limit + 1; i++) last = await join("FLOOD", "x");
  assert.equal(last.status, 429);
});

// ---------------------------- gizlilik ----------------------------------

test("Gizlilik 1: yanıtlarda e-posta yok; ad yoksa null; eski kayıtlardaki e-posta temizlenir", async () => {
  reset();
  const fam = await createFamily();
  await joinAll(fam, ["M1"]);
  // Eski sürümün yazdığı kayıt biçimi (e-postalı, adsız üye).
  const m = JSON.parse(db.get(`family:${fam.id}:members`));
  m.M1 = { ...m.M1, name: null, email: "m1@ornek.test" };
  m.OWNER.email = "sahip@ornek.test";
  db.set(`family:${fam.id}:members`, JSON.stringify(m));

  const r = await list("OWNER");
  const text = JSON.stringify(r.body);
  assert.ok(!text.includes("@ornek.test"), text);
  const f = r.body.families[0];
  assert.deepEqual(Object.keys(f.members[0]).sort(), ["isAnonymous", "isOwner", "joinedAt", "name", "uid"]);
  assert.equal(f.members.find((x) => x.uid === "M1").name, null);
  assert.ok(!db.get(`family:${fam.id}:members`).includes("@"), "depolanan e-postalar silindi");
  // Katılma / oluşturma yanıtları da e-posta taşımaz.
  plus("M2");
  const j = await join("M2", fam.inviteCode);
  assert.ok(!JSON.stringify(j.body).includes("@"));
});

test("Gizlilik 2: ad temizlenir ve 40 karakterle sınırlanır; aile adı da", async () => {
  reset();
  plus("O");
  const r = await post("O", { action: "create", name: "  Çok\u0000 uzun ".repeat(10), memberName: "A‮li  " + "x".repeat(80) });
  assert.equal(r.status, 200);
  assert.ok(r.body.name.length <= 40);
  assert.ok(!r.body.name.includes("\u0000"));
  const me = r.body.members[0];
  assert.ok(me.name.length <= 40 && !me.name.includes("‮") && me.name.startsWith("Ali x"));
});

// ---------------------------- üye çıkarma -------------------------------

test("Çıkar 1: sahip üyeyi çıkarır → erişim biter, kod yenilenir, eski kodla dönemez, yeni kodla dönebilir", async () => {
  reset();
  const fam = await createFamily();
  await joinAll(fam, ["M1", "M2"]);
  const r = await post("OWNER", { action: "remove", familyId: fam.id, memberUid: "M1" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(memberUids(fam.id), ["M2", "OWNER"]);
  assert.deepEqual(profileFamilies("M1"), []);
  assert.equal((await readFamily("M1", fam.id)).status, 403);
  assert.notEqual(r.body.inviteCode, fam.inviteCode);
  assert.equal((await join("M1", fam.inviteCode)).status, 404);
  assert.equal((await readFamily("M2", fam.id)).status, 200, "diğer üye etkilenmez");
  assert.equal((await join("M1", r.body.inviteCode)).status, 200);
});

test("Çıkar 2: yetki — üye başkasını çıkaramaz, sahip kendini çıkaramaz, olmayan üye 404", async () => {
  reset();
  const fam = await createFamily();
  await joinAll(fam, ["M1", "M2"]);
  const byMember = await post("M1", { action: "remove", familyId: fam.id, memberUid: "M2" });
  assert.equal(byMember.status, 403);
  assert.equal(byMember.body.code, "not_owner");
  assert.equal((await post("OWNER", { action: "remove", familyId: fam.id, memberUid: "OWNER" })).status, 400);
  assert.equal((await post("OWNER", { action: "remove", familyId: fam.id, memberUid: "NOPE" })).status, 404);
  // Başka ailenin sahibi bu aileye dokunamaz.
  const other = await createFamily("O2", "Başka");
  assert.equal((await post("O2", { action: "remove", familyId: fam.id, memberUid: "M1" })).status, 403);
  assert.equal(other.isOwner, true);
  assert.deepEqual(memberUids(fam.id), ["M1", "M2", "OWNER"]);
  assert.equal(meta(fam.id).inviteCode, fam.inviteCode, "başarısız denemeler kodu değiştirmez");
});

test("Çıkar 3: çıkarılan üye eski kodla aynı anda yeniden katılırsa geri giremez (yarış)", async () => {
  reset();
  const fam = await createFamily();
  await joinAll(fam, ["M1"]);
  // Önce M1 kendisi ayrılıp eski kodla tekrar katılmaya başlasın; katılmanın
  // üye yazımından hemen önce sahip onu "çıkarsın" (kod yenilenir).
  await post("M1", { action: "leave", familyId: fam.id });
  let removeStatus;
  // M1 artık üye değil → çıkarma 404 olur; asıl yarış: katılma eski kodu
  // okuduktan sonra kod yenilenir.
  const fired = interleaveOnce((c) => c[0] === "EVAL" && c[3] === `family:${fam.id}:members`, async () => {
    removeStatus = (await post("OWNER", { action: "rotateCode", familyId: fam.id })).status;
  });
  const j = await join("M1", fam.inviteCode);
  setRedisHook(null);
  assert.ok(fired(), "yarış gerçekten oluştu");
  assert.equal(removeStatus, 200);
  assert.equal(j.status, 404);
  assert.deepEqual(memberUids(fam.id), ["OWNER"]);
  assert.deepEqual(profileFamilies("M1"), []);
});

test("Çıkar 4: çıkarma sırasında hedefin yeniden katılması (üye listesi yazımı öncesi) onu içeri bırakmaz", async () => {
  reset();
  const fam = await createFamily();
  await joinAll(fam, ["M1"]);
  // Hedefin profil kaydı eski bir yarışla kaybolmuş olsun: eski kodla
  // "onarım" katılması, çıkarmanın kod yenilemesiyle üye silmesi arasına girer.
  db.set("user:M1:profile", JSON.stringify({ isPlus: true, families: [] }));
  let j;
  const fired = interleaveOnce((c) => c[0] === "EVAL" && c[3] === `family:${fam.id}:members`, async () => {
    j = await join("M1", fam.inviteCode);
  });
  const r = await post("OWNER", { action: "remove", familyId: fam.id, memberUid: "M1" });
  setRedisHook(null);
  assert.ok(fired(), "yarış gerçekten oluştu");
  assert.equal(r.status, 200);
  assert.equal(j.status, 404);
  assert.deepEqual(memberUids(fam.id), ["OWNER"]);
  assert.equal((await readFamily("M1", fam.id)).status, 403);
});

test("Çıkar 5: aile Plus'sız sahibin de yönetilebilir (yalnızca create/join Plus ister)", async () => {
  reset();
  const fam = await createFamily();
  await joinAll(fam, ["M1"]);
  db.set("user:OWNER:profile", JSON.stringify({ isPlus: false, families: [fam.id] }));
  assert.equal((await post("OWNER", { action: "remove", familyId: fam.id, memberUid: "M1" })).status, 200);
  assert.equal((await post("OWNER", { action: "rotateCode", familyId: fam.id })).status, 200);
  assert.equal((await post("OWNER", { action: "create", name: "Yeni" })).status, 403);
});

// --------------------------- sahiplik devri -----------------------------

test("Devir 1: sahip devreder → yeni sahip yönetir, eski sahip yönetemez ama üye kalır", async () => {
  reset();
  const fam = await createFamily();
  await joinAll(fam, ["M1", "M2"]);
  const r = await post("OWNER", { action: "transfer", familyId: fam.id, memberUid: "M2" });
  assert.equal(r.status, 200);
  assert.equal(meta(fam.id).ownerUid, "M2");
  assert.equal(r.body.isOwner, false);
  assert.equal(r.body.members.find((m) => m.uid === "M2").isOwner, true);
  assert.equal((await post("OWNER", { action: "remove", familyId: fam.id, memberUid: "M1" })).status, 403);
  assert.equal((await post("OWNER", { action: "delete", familyId: fam.id })).status, 403);
  assert.equal((await readFamily("OWNER", fam.id)).status, 200);
  assert.equal((await post("M2", { action: "remove", familyId: fam.id, memberUid: "OWNER" })).status, 200);
});

test("Devir 2: yalnızca sahip, yalnızca üyeye; üye olmayana / kendine devir yok", async () => {
  reset();
  const fam = await createFamily();
  await joinAll(fam, ["M1"]);
  assert.equal((await post("M1", { action: "transfer", familyId: fam.id, memberUid: "M1" })).status, 403);
  assert.equal((await post("OWNER", { action: "transfer", familyId: fam.id, memberUid: "STRANGER" })).status, 404);
  assert.equal((await post("OWNER", { action: "transfer", familyId: fam.id, memberUid: "OWNER" })).status, 400);
  assert.equal((await post("OWNER", { action: "transfer", familyId: fam.id, memberUid: "../x" })).status, 400);
  assert.equal(meta(fam.id).ownerUid, "OWNER");
});

test("Devir 3: devir ↔ hedef aynı anda ayrılıyor → aile sahipsiz kalmaz", async () => {
  for (const order of ["leave-first", "transfer-first"]) {
    reset();
    const fam = await createFamily();
    await joinAll(fam, ["M1", "M2"]);
    let fired;
    if (order === "leave-first") {
      // Devrin meta yazımından hemen önce hedef ayrılsın.
      fired = interleaveOnce(isMetaWrite(fam.id), async () => {
        assert.equal((await post("M1", { action: "leave", familyId: fam.id })).status, 200);
      });
      await post("OWNER", { action: "transfer", familyId: fam.id, memberUid: "M1" });
    } else {
      // Hedefin ayrılırken üye listesi yazımından hemen önce devir tamamlansın.
      fired = interleaveOnce((c) => c[0] === "EVAL" && c[3] === `family:${fam.id}:members`, async () => {
        assert.equal((await post("OWNER", { action: "transfer", familyId: fam.id, memberUid: "M1" })).status, 200);
      });
      assert.equal((await post("M1", { action: "leave", familyId: fam.id })).status, 200);
    }
    setRedisHook(null);
    assert.ok(fired(), "yarış gerçekten oluştu");
    const owner = meta(fam.id).ownerUid;
    assert.ok(memberUids(fam.id).includes(owner), `${order}: sahip (${owner}) üye`);
    assert.ok(!memberUids(fam.id).includes("M1"));
  }
});

// ---------------------------- sahip ayrılıyor ---------------------------

test("Ayrıl 1: sahip ayrılınca seçtiği üye, seçmezse en eski katılan sahip olur", async () => {
  reset();
  let fam = await createFamily();
  await joinAll(fam, ["M1", "M2"]);
  assert.equal((await post("OWNER", { action: "leave", familyId: fam.id, newOwnerUid: "M2" })).status, 200);
  assert.equal(meta(fam.id).ownerUid, "M2");
  assert.deepEqual(memberUids(fam.id), ["M1", "M2"]);
  assert.deepEqual(profileFamilies("OWNER"), []);

  reset();
  fam = await createFamily();
  await joinAll(fam, ["M1", "M2"]);
  assert.equal((await post("OWNER", { action: "leave", familyId: fam.id })).status, 200);
  assert.equal(meta(fam.id).ownerUid, "M1");
  // Geçersiz seçim reddedilir (sessizce başkasına geçmez).
  assert.equal((await post("M1", { action: "leave", familyId: fam.id, newOwnerUid: "OWNER" })).status, 404);
  assert.equal(meta(fam.id).ownerUid, "M1");
});

test("Ayrıl 2: tek üye sahip ayrılamaz (409 sole_member); silebilir", async () => {
  reset();
  const fam = await createFamily();
  const r = await post("OWNER", { action: "leave", familyId: fam.id });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "sole_member");
  assert.deepEqual(profileFamilies("OWNER"), [fam.id]);
  assert.equal((await post("OWNER", { action: "delete", familyId: fam.id })).status, 200);
});

test("Ayrıl 3: eski kayıt — sahip üye listesinde yoksa aile listesi açılınca en eski üye sahip olur", async () => {
  reset();
  const fam = await createFamily();
  await joinAll(fam, ["M1", "M2"]);
  // Eski kodla sahip ayrılmış, meta'da hâlâ onun uid'si kalmış olsun.
  const m = JSON.parse(db.get(`family:${fam.id}:members`));
  delete m.OWNER;
  db.set(`family:${fam.id}:members`, JSON.stringify(m));
  db.set("user:OWNER:profile", JSON.stringify({ isPlus: true, families: [] }));
  const r = await list("M2");
  assert.equal(meta(fam.id).ownerUid, "M1");
  assert.equal(r.body.families[0].ownerUid, "M1");
  assert.equal(r.body.families[0].members.find((x) => x.uid === "M1").isOwner, true);
});

// ------------------------------ Plus kapanınca ---------------------------

test("Plus 1: sahip Plus'ı kapatınca aileden çıkar, sahiplik en eski üyeye geçer", async () => {
  reset();
  const fam = await createFamily();
  await joinAll(fam, ["M1", "M2"]);
  const r = await invoke(profileHandler, { uid: "OWNER", body: { isPlus: false } });
  assert.equal(r.status, 200);
  assert.equal(r.body.isPlus, false);
  assert.deepEqual(r.body.families, []);
  assert.deepEqual(r.body.keptFamilies, []);
  assert.equal(meta(fam.id).ownerUid, "M1");
  assert.deepEqual(memberUids(fam.id), ["M1", "M2"]);
});

test("Plus 2: tek üye sahip Plus'ı kapatınca üyelik korunur (sahipsiz/erişilemez aile oluşmaz)", async () => {
  reset();
  const fam = await createFamily();
  const r = await invoke(profileHandler, { uid: "OWNER", body: { isPlus: false } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.keptFamilies, [fam.id]);
  assert.deepEqual(r.body.families, [fam.id]);
  assert.equal((await readFamily("OWNER", fam.id)).status, 200);
  const g = await list("OWNER");
  assert.equal(g.body.isPlus, false);
  assert.equal(g.body.families[0].isOwner, true);
  // Yeni aile yok ama kendi ailesini silebilir.
  assert.equal((await post("OWNER", { action: "join", code: fam.inviteCode })).status, 403);
  assert.equal((await post("OWNER", { action: "delete", familyId: fam.id })).status, 200);
});

test("Plus 3: Plus kapatma ile aynı anda katılma — yeni aileye girilemez (önce isPlus yazılır)", async () => {
  reset();
  const fam = await createFamily("O2");
  plus("U");
  let joinStatus;
  const fired = interleaveOnce((c) => c[0] === "EVAL" && c[3] === "user:U:profile", async () => {
    joinStatus = (await join("U", fam.inviteCode)).status;
  });
  assert.equal((await invoke(profileHandler, { uid: "U", body: { isPlus: false } })).status, 200);
  setRedisHook(null);
  assert.ok(fired(), "yarış gerçekten oluştu");
  // Katılma ya profilde Plus'ı kapalı görüp reddedildi ya da önce tamamlandı;
  // her iki durumda kayıt tutarlı.
  const inMembers = memberUids(fam.id).includes("U");
  assert.equal(inMembers, profileFamilies("U").includes(fam.id), `join=${joinStatus}`);
});

// ------------------------------ hesap silme ------------------------------

test("Hesap 1: sahibin hesabı silinince sahiplik en eski üyeye geçer (atomik meta)", async () => {
  reset();
  const fam = await createFamily();
  await joinAll(fam, ["M1", "M2"]);
  const out = await deleteAccount("OWNER");
  assert.equal(out.families[0].result, "ownership_transferred");
  assert.equal(meta(fam.id).ownerUid, "M1");
  assert.deepEqual(memberUids(fam.id), ["M1", "M2"]);
});

test("Hesap 2: devredilen üye tam o sırada ayrılırsa sahiplik bir sonrakine geçer", async () => {
  reset();
  const fam = await createFamily();
  await joinAll(fam, ["M1", "M2"]);
  const fired = interleaveOnce(isMetaWrite(fam.id), async () => {
    assert.equal((await post("M1", { action: "leave", familyId: fam.id })).status, 200);
  });
  await deleteAccount("OWNER");
  setRedisHook(null);
  assert.ok(fired(), "yarış gerçekten oluştu");
  assert.deepEqual(memberUids(fam.id), ["M2"]);
  assert.equal(meta(fam.id).ownerUid, "M2");
});

test("Silme: meta'nın sürüm/yedek anahtarları da silinir", async () => {
  reset();
  const fam = await createFamily();
  await joinAll(fam, ["M1"]);
  await post("OWNER", { action: "rotateCode", familyId: fam.id });
  assert.ok(db.has(`family:${fam.id}:meta:version`));
  assert.equal((await post("OWNER", { action: "delete", familyId: fam.id })).status, 200);
  assert.deepEqual([...db.keys()].filter((k) => k.startsWith(`family:${fam.id}`) || k.startsWith("invite:")), []);
});

test("Denetim: salt okunur betik sahipsiz aileyi, üyesiz aileyi, eski kodu ve saklı e-postayı sayar; hiçbir şey yazmaz", async () => {
  reset();
  const { auditGroup3, makeReadOnlyClient } = await import("../scripts/audit-group3-readonly.mjs");
  const { runRedis } = await import("./helpers/fakeServices.mjs");
  const a = await createFamily("OA", "A");
  await joinAll(a, ["MA"]);
  const b = await createFamily("OB", "B");
  // a: sahip üye listesinden düşmüş + e-postalı eski kayıt; b: hiç üye yok + eski kod.
  const ma = JSON.parse(db.get(`family:${a.id}:members`));
  delete ma.OA;
  ma.MA.email = "x@ornek.test";
  db.set(`family:${a.id}:members`, JSON.stringify(ma));
  db.set(`family:${b.id}:members`, "{}");
  db.set(`family:${b.id}:meta`, JSON.stringify({ ...meta(b.id), inviteCode: "ABC234" }));
  const before = JSON.stringify([...db.entries()].map(([k, v]) => [k, typeof v === "string" ? v : "x"]));
  const report = await auditGroup3(makeReadOnlyClient(async (cmd) => runRedis(cmd)));
  assert.deepEqual(report.families.orphanOwner, [{ familyId: a.id }]);
  assert.deepEqual(report.families.noMembers, [{ familyId: b.id }]);
  assert.equal(report.families.legacyInviteCodes, 1);
  assert.equal(report.families.storedMemberEmails, 1);
  assert.ok(!JSON.stringify(report).includes("@ornek.test"), "e-posta raporda yok");
  assert.equal(JSON.stringify([...db.entries()].map(([k, v]) => [k, typeof v === "string" ? v : "x"])), before);
});
