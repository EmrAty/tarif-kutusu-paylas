// Grup 3 — FCM token yaşam döngüsü ve tarif bildirimi hedeflemesi.
// Production'da görülen hata: tek tarif → Android 1 + Chrome 2 = 3 bildirim.
// Fable denetiminin D2 (token devralma), D3 (çıkış sonrası Chrome'a geri dönüş)
// ve D4 (deploy sonrası ilk paylaşımda eski davranış) senaryoları da burada.
// Ürün kararı: web (Chrome) push tamamen kapalı — tarif VE aile bildirimleri
// yalnızca Android'e, Android kaydı yoksa web'e/eski listeye geri dönüş yok.
// Bellek içi Redis + sahte Google OAuth/FCM + sahte Anthropic; dış ağ yok.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { setRoutes, invoke, resetDb, json, db, setRedisFault, waitFor } from "./helpers/fakeServices.mjs";

process.env.RECIPE_JOB_NOTIFY_MIN_DELAY_MS = "0";
{
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.FIREBASE_SERVICE_ACCOUNT_KEY = JSON.stringify({
    client_email: "test@tarif-kutusu.test",
    project_id: "tarif-kutusu",
    private_key: privateKey.export({ format: "pem", type: "pkcs8" }),
  });
}

const { default: fcmToken } = await import("../api/fcm-token.js");
const { default: recipeJobs } = await import("../api/recipe-jobs.js");
const { default: notify } = await import("../api/notify.js");
const { notifyUserDevices, collectPushTargets, pushTargetsKey, pushOwnerKey, fcmTokensKey, isPermanentTokenError } = await import(
  "../api/_lib/fcm.js"
);
const { deleteAccount } = await import("../api/_lib/accountDeletion.js");

const ANTHROPIC = "https://api.anthropic.com/v1/messages";
const FCM_SEND = "https://fcm.googleapis.com/v1/projects/tarif-kutusu/messages:send";
const RECIPE = { title: "Fırın Tavuk", ingredients: [{ name: "tavuk", amount: "1 kg" }], instructions: ["Pişir."] };

let sentTo = []; // FCM'in kabul ettiği her mesaj: token + data + görünür mü
let fcmBehaviour = () => null; // token -> null (başarılı) | Response

function routes(anthropic = () => json(200, { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(RECIPE) }], usage: { output_tokens: 10 } })) {
  setRoutes([
    [ANTHROPIC, anthropic],
    ["https://oauth2.googleapis.com/token", () => json(200, { access_token: "fcm-access", expires_in: 3600 })],
    [
      FCM_SEND,
      (url, init) => {
        const message = JSON.parse(init.body).message;
        const custom = fcmBehaviour(message.token);
        if (custom) return custom;
        sentTo.push({ token: message.token, data: message.data || {}, visible: !!message.notification, message });
        return json(200, { name: "projects/x/messages/1" });
      },
    ],
  ]);
}

function reset() {
  resetDb();
  sentTo = [];
  fcmBehaviour = () => null;
  routes();
}

const ANDROID_1 = "android-token-device-one-aaaaaaaaaaaa";
const ANDROID_2 = "android-token-device-two-bbbbbbbbbbbb";
const WEB_1 = "web-chrome-token-desktop-cccccccccccc";
const WEB_2 = "web-chrome-token-phone-dddddddddddddd";
const INSTALL_A = "install-android-A1";
const INSTALL_B = "install-android-B2";

const register = (uid, token, platform, installationId, opts = {}) =>
  invoke(fcmToken, { uid, body: { token, ...(platform ? { platform } : {}), ...(installationId ? { installationId } : {}) }, ...opts });
const unregister = (uid, body) => invoke(fcmToken, { uid, body: { action: "unregister", ...body } });
const verify = (uid, token, nonce) => invoke(fcmToken, { uid, body: { action: "verify", token, nonce } });
const recipeReady = (uid, dedupeKey) =>
  notifyUserDevices(uid, { title: "Tarifin hazır", body: "x", data: { type: "recipe_ready", recipeId: "r1" } }, { dedupeKey });
const hashFields = (uid) => {
  const v = db.get(pushTargetsKey(uid));
  return v && v.type === "hash" ? [...v.map.keys()].sort() : [];
};
const visibleTokens = () => sentTo.filter((s) => s.visible).map((s) => s.token).sort();
const verifyMessages = () => sentTo.filter((s) => s.data.type === "push_verify");

// Cihaz (gerçek sahip) doğrulama mesajını alır ve istemcinin yaptığı gibi
// kodu bu oturumla geri yollar.
async function deviceEchoes(uid, token) {
  const msg = verifyMessages().filter((m) => m.token === token).pop();
  assert.ok(msg, "doğrulama mesajı cihaza gitmeli");
  return verify(uid, token, msg.data.nonce);
}

async function waitForJob(uid, jobId) {
  return waitFor(() => {
    const job = JSON.parse(db.get(`job:${uid}:${jobId}`) || "null");
    return job && (job.status === "completed" || job.status === "failed") && job.notify && job;
  }, { message: `job bitmeli: ${jobId}` });
}

async function runJob(uid, i = 1) {
  db.set(`user:${uid}:profile`, JSON.stringify({ isPlus: true, families: [] }));
  const r = await invoke(recipeJobs, {
    uid,
    body: {
      requestId: `g3-${uid}-${i}-abcdef`,
      sourceUrl: `https://www.instagram.com/p/G3${uid}${i}/`,
      caption: "1 kg tavuk, 2 yemek kaşığı salça, 1 su bardağı su ile fırında pişirilir.",
      category: "Kahvaltı",
    },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { response: r.body, job: await waitForJob(uid, r.body.jobId) };
}

// ------------------------------- teslimat ---------------------------------

test("FCM 1: tek Android token → tarif bildirimi tam 1 push (webpush yükü yok)", async () => {
  reset();
  assert.equal((await register("A", ANDROID_1, "android", INSTALL_A)).status, 200);
  const { job } = await runJob("A");
  assert.equal(job.status, "completed");
  assert.deepEqual(visibleTokens(), [ANDROID_1]);
  assert.equal(sentTo[0].data.type, "recipe_ready");
  assert.deepEqual(job.notify, { sent: 1, attempted: 1, error: null });
  assert.equal(sentTo[0].message.webpush, undefined, "web push kapalı: webpush yükü gönderilmez");
  assert.equal(sentTo[0].message.android.priority, "high");
});

test("FCM 2: aynı token iki kez kaydedilirse tek kayıt ve tek push", async () => {
  reset();
  await register("A", ANDROID_1, "android", INSTALL_A);
  await register("A", ANDROID_1, "android", INSTALL_A);
  assert.deepEqual(hashFields("A"), [ANDROID_1]);
  const result = await recipeReady("A");
  assert.deepEqual(visibleTokens(), [ANDROID_1]);
  assert.equal(result.attempted, 1);
});

test("FCM 3: 1 Android + 2 web (Chrome) token → tarif bildirimi yalnızca Android'e (production hatası)", async () => {
  reset();
  await register("A", ANDROID_1, "android", INSTALL_A);
  await register("A", WEB_1, "web", "install-web-desktop");
  await register("A", WEB_2, "web", "install-web-phone");
  const { job, response } = await runJob("A");
  assert.deepEqual(visibleTokens(), [ANDROID_1], "Chrome'a tarif bildirimi gitmemeli");
  assert.equal(job.notify.sent, 1);
  assert.equal(response.notifyDevices, 1, "panelin gösterdiği cihaz sayısı da yalnızca native");
});

test("FCM 4 (D4): deploy sonrası, ana uygulama yeni paketle açılmadan — eski listedeki hiçbir token'a tarif bildirimi gitmez", async () => {
  reset();
  db.set(fcmTokensKey("A"), JSON.stringify(["android-old-token-xxxx", "chrome-old-1-xxxxxxxx", "chrome-old-2-xxxxxxxx"]));
  const { job, response } = await runJob("A");
  assert.equal(job.status, "completed", "tarif yine kaydedilir");
  assert.deepEqual(sentTo, [], "Chrome'a tarif bildirimi gitmez (platform bilinmiyor)");
  assert.equal(response.notifyDevices, 0, "panel 'kayıtlı cihaz yok' durumunu doğru gösterir");
  assert.deepEqual(JSON.parse(db.get(fcmTokensKey("A"))).length, 3, "eski liste silinmez");
});

test("FCM 5 (D3): Android'den çıkış → tarif bildirimi etiketsiz Chrome token'ına GERİ DÖNMEZ", async () => {
  reset();
  const CHROME = "chrome-legacy-token-bbbbbbbbbbbb";
  db.set(fcmTokensKey("A"), JSON.stringify([ANDROID_1, CHROME]));
  await register("A", ANDROID_1, "android", INSTALL_A);
  await recipeReady("A");
  assert.deepEqual(visibleTokens(), [ANDROID_1]);
  sentTo = [];
  assert.equal((await unregister("A", { token: ANDROID_1, installationId: INSTALL_A })).status, 200);
  const after = await recipeReady("A");
  assert.equal(after.attempted, 0);
  assert.deepEqual(sentTo, []);
});

test("FCM 6: çıkış (POST unregister ve eski DELETE) → eski hesap artık push alamaz", async () => {
  reset();
  await register("A", ANDROID_1, "android", INSTALL_A);
  assert.equal((await unregister("A", { installationId: INSTALL_A })).status, 200, "yalnızca kurulum kimliğiyle de olur");
  assert.deepEqual(hashFields("A"), []);
  assert.equal(db.has(pushOwnerKey(ANDROID_1)), false);
  await register("A", ANDROID_2, "android", INSTALL_B);
  const del = await invoke(fcmToken, { method: "DELETE", uid: "A", body: { token: ANDROID_2 } });
  assert.equal(del.status, 200);
  assert.equal((await recipeReady("A")).attempted, 0);
});

test("FCM 7: normal hesap değişimi — A'dan çıkıp B'ye girmek doğrulama gerektirmez", async () => {
  reset();
  await register("A", ANDROID_1, "android", INSTALL_A);
  await unregister("A", { token: ANDROID_1, installationId: INSTALL_A });
  const r = await register("B", ANDROID_1, "android", INSTALL_A);
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "registered");
  assert.equal(verifyMessages().length, 0);
  assert.equal(db.get(pushOwnerKey(ANDROID_1)), "B");
});

test("FCM 8: çıkış kaydı silinemeden B'ye geçilirse cihaz sahiplik kanıtıyla B'ye geçer; A artık hedeflemez", async () => {
  reset();
  await register("A", ANDROID_1, "android", INSTALL_A);
  db.set(fcmTokensKey("A"), JSON.stringify([ANDROID_1])); // Grup 3 öncesi kayıt da var
  const r = await register("B", ANDROID_1, "android", INSTALL_A);
  assert.equal(r.status, 202);
  assert.equal(r.body.status, "verification_required");
  assert.deepEqual(hashFields("A"), [ANDROID_1], "kanıt gelene kadar hiçbir şey değişmez");
  const msg = verifyMessages()[0];
  assert.equal(msg.visible, false, "doğrulama mesajı sessiz (data-only)");
  assert.equal(msg.message.notification, undefined);

  const v = await deviceEchoes("B", ANDROID_1);
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.deepEqual(hashFields("A"), []);
  assert.deepEqual(JSON.parse(db.get(fcmTokensKey("A"))), []);
  assert.deepEqual(hashFields("B"), [ANDROID_1]);
  assert.equal((await recipeReady("A")).attempted, 0);
  sentTo = [];
  await recipeReady("B");
  assert.deepEqual(visibleTokens(), [ANDROID_1]);
});

test("FCM 9 (D2): başkasının token'ını bilmek yetmez — kurbanın kaydı korunur, saldırganın bildirimi kurbana gitmez", async () => {
  reset();
  await register("VICTIM", ANDROID_1, "android", "install-victim-1");
  const r = await register("ATTACKER", ANDROID_1, "android", "install-attacker", { anonymous: true });
  assert.equal(r.body.status, "verification_required");
  // Saldırgan kodu bilmiyor: tahmin/boş/yanlış kod reddedilir.
  for (const nonce of ["0".repeat(32), "", "x"]) {
    const v = await verify("ATTACKER", ANDROID_1, nonce);
    assert.equal(v.status, 409);
  }
  // Kurbanın cihazı (VICTIM oturumunda) kodu alsa bile saldırganın adına
  // kullanamaz: kod isteyen hesaba bağlı.
  const leaked = verifyMessages()[0].data.nonce;
  assert.equal((await verify("VICTIM", ANDROID_1, leaked)).status, 409);

  assert.deepEqual(hashFields("VICTIM"), [ANDROID_1]);
  assert.equal(db.get(pushOwnerKey(ANDROID_1)), "VICTIM");
  sentTo = [];
  assert.equal((await recipeReady("VICTIM")).sent, 1);
  assert.equal((await recipeReady("ATTACKER")).attempted, 0, "saldırganın bildirimi kurbanın cihazına gitmez");
});

test("FCM 9b: doğrulama kodu tek kullanımlık, süreli ve doğrulama push'u sınırlı", async () => {
  reset();
  await register("A", ANDROID_1, "android", INSTALL_A);
  await register("B", ANDROID_1, "android", INSTALL_A);
  await register("B", ANDROID_1, "android", INSTALL_A); // 30 sn içinde tekrar: yeni push yok
  assert.equal(verifyMessages().length, 1);
  const nonce = verifyMessages()[0].data.nonce;
  assert.equal((await verify("B", ANDROID_1, nonce)).status, 200);
  assert.equal((await verify("B", ANDROID_1, nonce)).status, 409, "ikinci kullanım reddedilir");
});

test("FCM 9c: eski sahip token'ı artık tutmuyorsa (bayat sahiplik) kanıt istenmez", async () => {
  reset();
  await register("A", ANDROID_1, "android", INSTALL_A);
  // A'nın kaydı silinmiş ama sahiplik işareti kalmış (yarıda kalmış temizlik).
  db.get(pushTargetsKey("A")).map.delete(ANDROID_1);
  const r = await register("B", ANDROID_1, "android", INSTALL_A);
  assert.equal(r.body.status, "registered");
  assert.equal(db.get(pushOwnerKey(ANDROID_1)), "B");
});

test("FCM 9d: platform göndermeyen eski istemci başka hesabın token'ını alamaz", async () => {
  reset();
  await register("A", ANDROID_1, "android", INSTALL_A);
  const r = await register("B", ANDROID_1);
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "ignored");
  assert.equal(db.get(pushOwnerKey(ANDROID_1)), "A");
  assert.equal(db.has(fcmTokensKey("B")), false);
});

test("FCM 10: token yenilenince (aynı kurulum) eski token hedeflenmez", async () => {
  reset();
  await register("A", ANDROID_1, "android", INSTALL_A);
  const refreshed = "android-token-device-one-REFRESHED-zz";
  await register("A", refreshed, "android", INSTALL_A);
  assert.deepEqual(hashFields("A"), [refreshed]);
  assert.equal(db.has(pushOwnerKey(ANDROID_1)), false);
  await recipeReady("A");
  assert.deepEqual(visibleTokens(), [refreshed]);
});

test("FCM 11: UNREGISTERED/geçersiz token depodan temizlenir; yük hatası (INVALID_ARGUMENT) token'ı silmez", async () => {
  reset();
  await register("A", ANDROID_1, "android", INSTALL_A);
  await register("A", ANDROID_2, "android", INSTALL_B);
  fcmBehaviour = (token) =>
    token === ANDROID_1
      ? json(404, { error: { status: "NOT_FOUND", message: "Requested entity was not found.", details: [{ errorCode: "UNREGISTERED" }] } })
      : null;
  const r1 = await recipeReady("A");
  assert.equal(r1.sent, 1);
  assert.deepEqual(hashFields("A"), [ANDROID_2]);
  assert.equal(db.has(pushOwnerKey(ANDROID_1)), false);

  fcmBehaviour = () => json(400, { error: { status: "INVALID_ARGUMENT", message: "Invalid JSON payload received." } });
  await recipeReady("A");
  assert.deepEqual(hashFields("A"), [ANDROID_2]);

  assert.equal(isPermanentTokenError(400, { error: { status: "INVALID_ARGUMENT", message: "The registration token is not a valid FCM registration token" } }), true);
  assert.equal(isPermanentTokenError(403, { error: { status: "PERMISSION_DENIED", details: [{ errorCode: "SENDER_ID_MISMATCH" }] } }), true);
  assert.equal(isPermanentTokenError(500, { error: { status: "INTERNAL" } }), false);
  assert.equal(isPermanentTokenError(429, { error: { status: "RESOURCE_EXHAUSTED", details: [{ errorCode: "QUOTA_EXCEEDED" }] } }), false);
});

test("FCM 11b: geçersiz token temizliğinde Redis hatası gönderim sonucunu değiştirmez", async () => {
  reset();
  await register("A", ANDROID_1, "android", INSTALL_A);
  await register("A", ANDROID_2, "android", INSTALL_B);
  fcmBehaviour = (token) => (token === ANDROID_1 ? json(404, { error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } }) : null);
  setRedisFault((c) => c[0] === "HDEL");
  const r = await recipeReady("A");
  setRedisFault(null);
  assert.equal(r.sent, 1);
  assert.equal(r.attempted, 2);
});

test("FCM 12: anonim → gerçek hesaba bağlama (aynı uid) doğrulama gerektirmez", async () => {
  reset();
  await register("ANON1", ANDROID_1, "android", INSTALL_A, { anonymous: true });
  const r = await register("ANON1", ANDROID_1, "android", INSTALL_A);
  assert.equal(r.body.status, "registered");
  assert.deepEqual(hashFields("ANON1"), [ANDROID_1]);
  await recipeReady("ANON1");
  assert.deepEqual(visibleTokens(), [ANDROID_1]);
});

test("FCM 13: aynı hesaba bağlı iki Android cihaz → her biri tam 1 bildirim", async () => {
  reset();
  await register("A", ANDROID_1, "android", INSTALL_A);
  await register("A", ANDROID_2, "android", INSTALL_B);
  await register("A", WEB_1, "web", "install-web-desktop");
  const { job } = await runJob("A");
  assert.deepEqual(visibleTokens(), [ANDROID_1, ANDROID_2].sort());
  assert.equal(job.notify.sent, 2);
});

test("FCM 14: eski şema — Android yeni paketle kaydolunca eski listeden taşınır; eski liste ve web hiçbir bildirimin hedefi değil", async () => {
  reset();
  db.set(fcmTokensKey("A"), JSON.stringify([ANDROID_1, WEB_1, WEB_2]));
  await register("A", ANDROID_1, "android", INSTALL_A);
  assert.deepEqual(JSON.parse(db.get(fcmTokensKey("A"))), [WEB_1, WEB_2]);
  await recipeReady("A", "job-2:ready");
  assert.deepEqual(visibleTokens(), [ANDROID_1]);

  sentTo = [];
  // Eski paketin web kaydı: kabul edilmez, eski listedeki aynı token da silinir.
  const r = await register("A", WEB_1, "web", "install-web-desktop");
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "ignored");
  assert.deepEqual(JSON.parse(db.get(fcmTokensKey("A"))), [WEB_2]);
  assert.deepEqual(hashFields("A"), [ANDROID_1]);
  await recipeReady("A", "job-3:ready");
  assert.deepEqual(visibleTokens(), [ANDROID_1]);

  // Aile bildirimi de aynı hedefleri kullanır: yalnızca Android.
  const all = (await collectPushTargets("A")).map((t) => t.token).sort();
  assert.deepEqual(all, [ANDROID_1]);
});

test("FCM 14b: başka hesaba geçmiş eski şema token'ı aile bildiriminde de kullanılmaz", async () => {
  reset();
  db.set(fcmTokensKey("A"), JSON.stringify([ANDROID_1]));
  await register("B", ANDROID_1, "android", INSTALL_A); // sahipsizdi → doğrudan B
  assert.deepEqual(await collectPushTargets("A"), []);
});

test("FCM 14c: platform göndermeyen eski istemci paketi yok sayılır (hiçbir şey yazılmaz); hatalı girdi reddedilir", async () => {
  reset();
  const legacy = await register("A", ANDROID_1);
  assert.equal(legacy.status, 200);
  assert.equal(legacy.body.status, "ignored");
  assert.equal(db.has(fcmTokensKey("A")), false);
  assert.equal(db.has(pushOwnerKey(ANDROID_1)), false);
  assert.deepEqual(hashFields("A"), []);
  assert.equal((await register("A", ANDROID_1, "desktop")).status, 400, "bilinmeyen platform");
  assert.equal((await register("A", ANDROID_1, "android", "x")).status, 400, "geçersiz kurulum kimliği");
  assert.equal((await invoke(fcmToken, { uid: "A", body: { action: "nope", token: ANDROID_1 } })).status, 400);
});

test("FCM 15: aynı job için ikinci bildirim denemesi gönderilmez; Redis hatasında bildirim yine gider", async () => {
  reset();
  await register("A", ANDROID_1, "android", INSTALL_A);
  await recipeReady("A", "job-77:ready");
  const second = await recipeReady("A", "job-77:ready");
  assert.equal(second.duplicate, true);
  assert.equal(sentTo.length, 1);
  assert.ok(db.has("push-sent:A:job-77:ready"));
  await recipeReady("A", "job-78:ready");
  assert.equal(sentTo.length, 2);

  // İşaret yazılamazsa (Redis hatası): kayıp yerine gönderim.
  setRedisFault((c) => c[0] === "SET" && String(c[1]).startsWith("push-sent:"));
  const r = await recipeReady("A", "job-79:ready");
  setRedisFault(null);
  assert.equal(r.sent, 1);
});

const familyOf = (members) => {
  for (const uid of members) db.set(`user:${uid}:profile`, JSON.stringify({ isPlus: true, families: ["F1"] }));
  db.set("family:F1:meta", JSON.stringify({ name: "Ev", ownerUid: members[0], inviteCode: "ABCDEF" }));
  db.set("family:F1:members", JSON.stringify(Object.fromEntries(members.map((uid, i) => [uid, { joinedAt: i + 1 }]))));
};
const crave = (uid) => invoke(notify, { uid, body: { familyId: "F1", recipeId: "r1", recipeTitle: "Menemen" } });
const webTarget = (installationId) => JSON.stringify({ platform: "web", installationId, updatedAt: 1 });
const seedHash = (uid, entries) => db.set(pushTargetsKey(uid), { type: "hash", map: new Map(entries) });

test("FCM 16: tarif HATA bildirimi ve aile 'canı çekti' bildirimi yalnızca Android'e (web push kapalı)", async () => {
  reset();
  await register("A", ANDROID_1, "android", INSTALL_A);
  await register("A", WEB_1, "web", "install-web-desktop");
  routes(() => json(401, { error: { message: "invalid x-api-key" } }));
  const { job } = await runJob("A");
  assert.equal(job.status, "failed");
  assert.deepEqual(visibleTokens(), [ANDROID_1]);
  assert.equal(sentTo[0].data.type, "recipe_failed");

  sentTo = [];
  familyOf(["S", "A"]);
  const r = await crave("S");
  assert.equal(r.status, 200);
  assert.deepEqual(visibleTokens(), [ANDROID_1]);
  assert.equal(r.body.sent, 1);
  assert.equal(r.body.attempted, 1);
  assert.equal(sentTo[0].message.webpush, undefined);
});

test("FCM 16b: aile bildirimi — Android kaydı olmayan üyeye web'e ya da eski listeye geri dönüş yok", async () => {
  reset();
  // B: yalnızca eski (platformsuz) liste + eskiden yazılmış bir web kaydı.
  db.set(fcmTokensKey("B"), JSON.stringify([WEB_2]));
  seedHash("B", [[WEB_1, webTarget("install-web-desktop")]]);
  db.set(pushOwnerKey(WEB_1), "B");
  familyOf(["S", "B"]);
  const r = await crave("S");
  assert.equal(r.status, 200);
  assert.deepEqual(sentTo, [], "hiçbir FCM çağrısı yapılmaz");
  assert.equal(r.body.sent, 0);
  assert.equal(r.body.attempted, 0);
  assert.equal(r.body.recipientCount, 1);
  // Eski web kaydı gönderim sırasında temizlenir, sahipliği bırakılır; eski liste yerinde.
  assert.deepEqual(hashFields("B"), []);
  assert.equal(db.has(pushOwnerKey(WEB_1)), false);
  assert.deepEqual(JSON.parse(db.get(fcmTokensKey("B"))), [WEB_2]);
});

test("FCM 16c: aile bildirimi — iki Android cihazı olan üyeye her cihaz için tam 1 bildirim", async () => {
  reset();
  await register("B", ANDROID_1, "android", INSTALL_A);
  await register("B", ANDROID_2, "android", INSTALL_B);
  await register("B", WEB_1, "web", "install-web-desktop");
  familyOf(["S", "B"]);
  const r = await crave("S");
  assert.deepEqual(visibleTokens(), [ANDROID_1, ANDROID_2].sort());
  assert.equal(r.body.sent, 2);
  assert.equal(sentTo.length, 2);
});

test("FCM 16d: web kaydı sahiplik almaz, başkasının Android kaydına dokunmaz; aynı kurulumun eski web kaydını siler", async () => {
  reset();
  await register("A", ANDROID_1, "android", INSTALL_A);
  // Eski paket / saldırgan A'nın Android token'ını "web" diye kendi hesabına yazmaya çalışır.
  const r = await register("B", ANDROID_1, "web", "install-web-phone");
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "ignored");
  assert.equal(db.get(pushOwnerKey(ANDROID_1)), "A");
  assert.deepEqual(hashFields("A"), [ANDROID_1]);
  assert.deepEqual(verifyMessages(), [], "web kaydı doğrulama push'u da tetiklemez");

  // Eskiden yazılmış web kaydı: aynı kurulumdan gelen web kaydı onu siler, Android'e dokunmaz.
  seedHash("C", [
    [WEB_1, webTarget("install-web-desktop")],
    [ANDROID_2, JSON.stringify({ platform: "android", installationId: INSTALL_B, updatedAt: 1 })],
  ]);
  db.set(pushOwnerKey(WEB_1), "C");
  await register("C", WEB_2, "web", "install-web-desktop");
  assert.deepEqual(hashFields("C"), [ANDROID_2]);
  assert.equal(db.has(pushOwnerKey(WEB_1)), false);
  assert.equal(db.has(pushOwnerKey(WEB_2)), false);

  // İstemcinin girişteki temizliği: kurulum kimliğiyle unregister.
  seedHash("D", [[WEB_1, webTarget("install-web-desktop")]]);
  assert.equal((await unregister("D", { installationId: "install-web-desktop" })).status, 200);
  assert.deepEqual(hashFields("D"), []);
});

test("FCM 16e: sessiz sahiplik doğrulaması yalnızca Android yüküyle gider (webpush yok)", async () => {
  reset();
  await register("A", ANDROID_1, "android", INSTALL_A);
  const r = await register("B", ANDROID_1, "android", INSTALL_B);
  assert.equal(r.body.status, "verification_required");
  const [msg] = verifyMessages();
  assert.ok(msg);
  assert.equal(msg.visible, false);
  assert.equal(msg.message.webpush, undefined);
  assert.equal((await deviceEchoes("B", ANDROID_1)).status, 200);
  assert.equal(db.get(pushOwnerKey(ANDROID_1)), "B");
});

test("FCM 17: hesap silinince push kayıtları, sahiplik ve job bildirim işaretleri temizlenir; başka hesabınkine dokunulmaz", async () => {
  reset();
  setRoutes([["https://", () => json(200, {})]]);
  await register("DEL1", ANDROID_1, "android", INSTALL_A);
  await register("DEL1", ANDROID_2, "android", INSTALL_B);
  await unregister("DEL1", { token: ANDROID_2 });
  await register("OTHER", ANDROID_2, "android", INSTALL_B);
  db.set("push-sent:DEL1:job-1:ready", "1");
  db.set("push-sent:OTHER:job-1:ready", "1");
  db.set("user:DEL1:profile", JSON.stringify({ isPlus: false, families: [] }));
  await deleteAccount("DEL1");
  assert.equal(db.has(pushTargetsKey("DEL1")), false);
  assert.equal(db.has(pushOwnerKey(ANDROID_1)), false);
  assert.equal(db.has("push-sent:DEL1:job-1:ready"), false);
  assert.equal(db.has("push-sent:OTHER:job-1:ready"), true);
  assert.equal(db.get(pushOwnerKey(ANDROID_2)), "OTHER");
  assert.deepEqual(hashFields("OTHER"), [ANDROID_2]);
});

test("FCM 18: HGETALL nesne biçiminde dönse de hedefler okunur (Upstash biçim toleransı)", async () => {
  reset();
  await register("A", ANDROID_1, "android", INSTALL_A);
  // Upstash REST düz dizi döndürür; nesne biçimi de desteklenir.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    if (String(input) === "https://kv.test" && init.body && JSON.parse(init.body)[0] === "HGETALL") {
      const flat = (await (await realFetch(input, init)).json()).result;
      const obj = {};
      for (let i = 0; i + 1 < flat.length; i += 2) obj[flat[i]] = flat[i + 1];
      return json(200, { result: obj });
    }
    return realFetch(input, init);
  };
  try {
    const targets = await collectPushTargets("A");
    assert.deepEqual(targets.map((t) => t.token), [ANDROID_1]);
  } finally {
    globalThis.fetch = realFetch;
  }
});
