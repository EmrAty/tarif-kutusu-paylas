// Grup 4 — aile yönetimi: üye çıkarma, sahiplik devri, davet kodu yenileme,
// deneme sınırı, e-posta gizliliği, sahipsiz aile kalmaması, Plus kapalıyken
// aile kilidi.
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

// ------------------------- Plus kapalı: aile kilitli -------------------------
// Ürün kararı (Grup 4): Plus kapanınca üyelik ve sahiplik KORUNUR, aile
// kilitlenir; Plus açılınca her şey olduğu gibi geri gelir.

const plusOff = (uid) => invoke(profileHandler, { uid, body: { isPlus: false } });
const plusOn = (uid) => invoke(profileHandler, { uid, body: { isPlus: true } });
const getBucket = (uid, id, bucket, extra = {}) => invoke(dataHandler, { method: "GET", uid, query: { bucket, scope: "family", familyId: id, ...extra } });
const putBucket = (uid, id, bucket, value, baseVersion) => invoke(dataHandler, { uid, body: { bucket, scope: "family", familyId: id, value: JSON.stringify(value), baseVersion } });
const FULL_RECIPE = {
  id: "r1",
  title: "Mercimek Çorbası",
  category: "Çorba",
  createdAt: 1700000000000,
  addedBy: "Ayşe",
  isFavorite: true,
  ingredients: [{ name: "kırmızı mercimek", amount: "1 su bardağı" }],
  instructions: ["GİZLİ ADIM"],
  link: "https://www.tiktok.com/@x/video/1",
  nutrition: { calories: 500 },
};

async function familyWithRecipe() {
  const fam = await createFamily();
  await joinAll(fam, ["M1", "M2"]);
  assert.equal((await putBucket("OWNER", fam.id, "recipes", [FULL_RECIPE], 0)).status, 200);
  assert.equal((await putBucket("OWNER", fam.id, "shopping-list", { selected: ["r1"], checked: {} }, 0)).status, 200);
  return fam;
}

test("Kilit 1: Plus kapanınca üyelik ve sahiplik korunur; Plus açılınca aynı aile, aynı kod, aynı içerik", async () => {
  reset();
  const fam = await familyWithRecipe();
  const off = await plusOff("OWNER");
  assert.equal(off.status, 200);
  assert.equal(off.body.isPlus, false);
  assert.deepEqual(off.body.families, [fam.id]);
  assert.equal(meta(fam.id).ownerUid, "OWNER", "sahiplik devredilmedi");
  assert.deepEqual(memberUids(fam.id), ["M1", "M2", "OWNER"]);

  const g = await list("OWNER");
  const f = g.body.families[0];
  assert.equal(f.membership, "locked");
  assert.equal(f.locked, true);
  assert.equal(f.inviteCode, null, "kilitliyken davet kodu gösterilmez");
  assert.equal(f.isOwner, true);
  assert.deepEqual(f.members.map((m) => m.uid).sort(), ["M1", "M2", "OWNER"]);

  const on = await plusOn("OWNER");
  assert.equal(on.status, 200);
  const g2 = await list("OWNER");
  assert.equal(g2.body.families[0].membership, "verified");
  assert.equal(g2.body.families[0].inviteCode, meta(fam.id).inviteCode);
  assert.equal(g2.body.families[0].inviteCode, fam.inviteCode, "kod aynı kaldı");
  const r = await getBucket("OWNER", fam.id, "recipes");
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body.value), [FULL_RECIPE]);
});

test("Kilit 2: kilitliyken aile verisi sunucuda kapalı (okuma ve yazma, tüm kovalar); kişisel veri etkilenmez", async () => {
  reset();
  const fam = await familyWithRecipe();
  await plusOff("M1");
  for (const bucket of ["recipes", "shopping-list", "pantry-items"]) {
    const r = await getBucket("M1", fam.id, bucket);
    assert.equal(r.status, 403, bucket);
    assert.equal(r.body.code, "family_locked");
    assert.ok(!JSON.stringify(r.body).includes("GİZLİ"));
  }
  const versionBefore = db.get(`family:${fam.id}:recipes:version`);
  const w = await putBucket("M1", fam.id, "recipes", [], Number(versionBefore));
  assert.equal(w.status, 403);
  assert.equal(db.get(`family:${fam.id}:recipes:version`), versionBefore, "hiçbir şey yazılmadı");
  const ws = await putBucket("M1", fam.id, "shopping-list", { selected: [], checked: {} }, 1);
  assert.equal(ws.status, 403);
  // Diğer üyeler etkilenmez; kişisel liste çalışır.
  assert.equal((await getBucket("M2", fam.id, "recipes")).status, 200);
  const personal = await invoke(dataHandler, { uid: "M1", body: { bucket: "recipes", scope: "personal", value: "[]", baseVersion: 0 } });
  assert.equal(personal.status, 200);
});

test("Kilit 3: kilitli kart özeti yalnızca kart alanlarını taşır (malzeme/yapılış/link yok); üye olmayan alamaz", async () => {
  reset();
  const fam = await familyWithRecipe();
  await plusOff("M1");
  const s = await getBucket("M1", fam.id, "recipes", { summary: "1" });
  assert.equal(s.status, 200);
  assert.deepEqual(s.body.summary, [{ id: "r1", title: "Mercimek Çorbası", category: "Çorba", createdAt: 1700000000000, addedBy: "Ayşe", isFavorite: true }]);
  assert.ok(!JSON.stringify(s.body).includes("GİZLİ") && !JSON.stringify(s.body).includes("tiktok"));
  // Özet yalnızca tarif listesi için; alışveriş listesi özeti yok.
  assert.equal((await getBucket("M1", fam.id, "shopping-list", { summary: "1" })).status, 400);
  plus("STRANGER");
  assert.equal((await getBucket("STRANGER", fam.id, "recipes", { summary: "1" })).status, 403);
  // Çıkarılan üye özeti de alamaz.
  await plusOn("M1");
  assert.equal((await post("OWNER", { action: "remove", familyId: fam.id, memberUid: "M1" })).status, 200);
  assert.equal((await getBucket("M1", fam.id, "recipes", { summary: "1" })).status, 403);
});

test("Kilit 4: Plus'ı kapalı sahip yönetemez (çıkar/devret/kod/sil); Plus açılınca yönetimi geri gelir", async () => {
  reset();
  const fam = await familyWithRecipe();
  await plusOff("OWNER");
  const code = meta(fam.id).inviteCode;
  for (const body of [
    { action: "remove", familyId: fam.id, memberUid: "M1" },
    { action: "transfer", familyId: fam.id, memberUid: "M1" },
    { action: "rotateCode", familyId: fam.id },
    { action: "delete", familyId: fam.id },
  ]) {
    const r = await post("OWNER", body);
    assert.equal(r.status, 403, body.action);
    assert.equal(r.body.code, "family_locked", body.action);
  }
  assert.deepEqual(memberUids(fam.id), ["M1", "M2", "OWNER"]);
  assert.equal(meta(fam.id).ownerUid, "OWNER");
  assert.equal(meta(fam.id).inviteCode, code);
  await plusOn("OWNER");
  assert.equal((await post("OWNER", { action: "remove", familyId: fam.id, memberUid: "M1" })).status, 200);
  assert.equal((await post("OWNER", { action: "transfer", familyId: fam.id, memberUid: "M2" })).status, 200);
  assert.equal(meta(fam.id).ownerUid, "M2");
});

test("Kilit 5: kilitli üye ayrılabilir; sahipse güvenli devir çalışır; tek üye sahip 409 (Plus mesajıyla)", async () => {
  reset();
  let fam = await familyWithRecipe();
  await plusOff("M2");
  assert.equal((await post("M2", { action: "leave", familyId: fam.id })).status, 200);
  assert.deepEqual(memberUids(fam.id), ["M1", "OWNER"]);
  await plusOff("OWNER");
  assert.equal((await post("OWNER", { action: "leave", familyId: fam.id })).status, 200);
  assert.equal(meta(fam.id).ownerUid, "M1", "devir en eski üyeye");
  assert.deepEqual(profileFamilies("OWNER"), []);

  reset();
  fam = await createFamily();
  await plusOff("OWNER");
  const r = await post("OWNER", { action: "leave", familyId: fam.id });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "sole_member");
  assert.match(r.body.error, /Plus/);
  assert.equal((await post("OWNER", { action: "delete", familyId: fam.id })).status, 403);
});

test("Kilit 6: kilitli sahip yarıda kalmış silmeyi tamamlayabilir (yalnızca temizlik)", async () => {
  reset();
  const fam = await createFamily();
  db.set(`family:${fam.id}:meta`, JSON.stringify({ ...meta(fam.id), deleting: true }));
  await plusOff("OWNER");
  assert.equal((await post("OWNER", { action: "delete", familyId: fam.id })).status, 200);
  assert.deepEqual([...db.keys()].filter((k) => k.startsWith(`family:${fam.id}`)), []);
});

test("Kilit 7: kilitliyken bildirim gönderemez; kilitli üye bildirim almaz (yalnız Android kuralı korunur)", async () => {
  reset();
  const fam = await familyWithRecipe();
  const { default: notify } = await import("../api/notify.js");
  await plusOff("M1");
  const s = await invoke(notify, { uid: "M1", body: { familyId: fam.id, recipeId: "r1", recipeTitle: "Çorba", senderName: "A" } });
  assert.equal(s.status, 403);
  assert.equal(s.body.code, "family_locked");
  // Sahip gönderir: alıcı yalnızca Plus'lı M2 (kilitli M1 sayılmaz).
  const ok = await invoke(notify, { uid: "OWNER", body: { familyId: fam.id, recipeId: "r1", recipeTitle: "Çorba", senderName: "Sahip" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.recipientCount, 1);
});

test("Kilit 8: diğer giriş yolları — paylaşım paneli job'u, çeviri ve eski veri aktarımı aileye gidemez", async () => {
  reset();
  const fam = await familyWithRecipe();
  await plusOff("M1");
  const { default: recipeJobs } = await import("../api/recipe-jobs.js");
  const job = await invoke(recipeJobs, {
    uid: "M1",
    body: { requestId: "req-lock-1", sourceUrl: "https://www.instagram.com/p/LOCK/", caption: "1 kg tavuk, 2 yemek kaşığı salça ile fırında.", category: "Kahvaltı", target: "family", familyId: fam.id },
  });
  assert.equal(job.status, 403);
  const { default: translate } = await import("../api/translate-recipe.js");
  const tr = await invoke(translate, { uid: "M1", body: { recipeId: "r1", scope: fam.id, target: "en" } });
  assert.equal(tr.status, 403);
  assert.ok(!JSON.stringify(tr.body).includes("GİZLİ"));
  // Eski veri aktarımı istemcide /api/data yazımıyla yapılır → aynı kilit.
  const imp = await putBucket("M1", fam.id, "pantry-items", ["un"], 0);
  assert.equal(imp.status, 403);
  // Kilitli üye yeni aileye katılamaz, aile kuramaz.
  const other = await createFamily("O2", "Başka");
  assert.equal((await join("M1", other.inviteCode)).status, 403);
});

test("Kilit 9: Plus kapatma ile aynı anda sahiplik devri ve ayrılma — üyelik/sahiplik tutarlı kalır", async () => {
  reset();
  const fam = await familyWithRecipe();
  // Sahip Plus'ı kapatırken (profil yazımından hemen önce) M1 ayrılsın.
  const fired = interleaveOnce((c) => c[0] === "EVAL" && c[3] === "user:OWNER:profile", async () => {
    assert.equal((await post("M1", { action: "leave", familyId: fam.id })).status, 200);
  });
  assert.equal((await plusOff("OWNER")).status, 200);
  setRedisHook(null);
  assert.ok(fired(), "yarış gerçekten oluştu");
  assert.equal(meta(fam.id).ownerUid, "OWNER");
  assert.deepEqual(memberUids(fam.id), ["M2", "OWNER"]);
  assert.deepEqual(profileFamilies("OWNER"), [fam.id]);
  // Devir sürerken hedef Plus'ı kapatırsa: devir yine geçerli (hedef üye),
  // yeni sahip kilitli olur ama aile sahipsiz kalmaz; Plus açınca yönetir.
  const fired2 = interleaveOnce(isMetaWrite(fam.id), async () => {
    assert.equal((await plusOff("M2")).status, 200);
  });
  await plusOn("OWNER");
  assert.equal((await post("OWNER", { action: "transfer", familyId: fam.id, memberUid: "M2" })).status, 200);
  setRedisHook(null);
  assert.ok(fired2(), "yarış gerçekten oluştu");
  assert.equal(meta(fam.id).ownerUid, "M2");
  assert.equal((await post("M2", { action: "rotateCode", familyId: fam.id })).status, 403);
  await plusOn("M2");
  assert.equal((await post("M2", { action: "rotateCode", familyId: fam.id })).status, 200);
});

test("Kilit 10: Plus'ı kapalı üyenin hesabı silinirse sahiplik yine güvenle devredilir", async () => {
  reset();
  const fam = await familyWithRecipe();
  await plusOff("OWNER");
  const out = await deleteAccount("OWNER");
  assert.equal(out.families[0].result, "ownership_transferred");
  assert.equal(meta(fam.id).ownerUid, "M1");
  assert.equal((await getBucket("M1", fam.id, "recipes")).status, 200, "ortak veri korunur");
});

// ------------------------------- aile reisi -------------------------------

test("Reis: sahip işareti mevcut sahipte; devirde yeni sahibe geçer, kurucuya sabit değil; kilitliyken de doğru", async () => {
  reset();
  const fam = await createFamily();
  await joinAll(fam, ["M1"]);
  const owners = async (uid) => (await list(uid)).body.families[0].members.filter((m) => m.isOwner).map((m) => m.uid);
  assert.deepEqual(await owners("M1"), ["OWNER"]);
  await post("OWNER", { action: "transfer", familyId: fam.id, memberUid: "M1" });
  assert.deepEqual(await owners("OWNER"), ["M1"]);
  assert.deepEqual(await owners("M1"), ["M1"]);
  assert.equal(meta(fam.id).ownerUid, "M1");
  await plusOff("OWNER");
  assert.deepEqual(await owners("OWNER"), ["M1"]);
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

test("İstemci deposu: kilitlenen ailenin kovaları bellekten atılır, diğer kapsamlar kalır", async () => {
  const { createBucketStore } = await import("../src/syncedBuckets.js");
  const data = { "recipes|personal": '[{"id":"p"}]', "recipes|F1": '[{"id":"f"}]', "shopping-list|F1": '{"selected":[],"checked":{}}' };
  const transport = {
    get: async (bucket, scope) => ({ value: data[`${bucket}|${scope}`] ?? null, version: 1 }),
    set: async () => ({ ok: true, version: 2 }),
  };
  const store = createBucketStore({ transport });
  await Promise.all([store.load("recipes", "personal"), store.load("recipes", "F1"), store.load("shopping-list", "F1")]);
  assert.ok(store.get("recipes", "F1")?.data);
  store.dropScope("F1");
  assert.equal(store.get("recipes", "F1"), null);
  assert.equal(store.get("shopping-list", "F1"), null);
  assert.deepEqual(store.get("recipes", "personal").data, [{ id: "p" }]);
});
