// Grup 3 — FCM token yaşam döngüsü ve tarif bildirimi hedeflemesi.
// Production'da görülen hata: tek tarif → Android 1 + Chrome 2 = 3 bildirim.
// Bellek içi Redis + sahte Google OAuth/FCM + sahte Anthropic; dış ağ yok.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { setRoutes, invoke, resetDb, json, db, setRedisFault } from "./helpers/fakeServices.mjs";

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

let sentTo = []; // FCM'in kabul ettiği her mesajın token'ı + data'sı
let fcmBehaviour = () => null; // token -> null (başarılı) | Response

function reset() {
  resetDb();
  sentTo = [];
  fcmBehaviour = () => null;
  setRoutes([
    [ANTHROPIC, () => json(200, { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(RECIPE) }], usage: { output_tokens: 10 } })],
    ["https://oauth2.googleapis.com/token", () => json(200, { access_token: "fcm-access", expires_in: 3600 })],
    [
      FCM_SEND,
      (url, init) => {
        const message = JSON.parse(init.body).message;
        const custom = fcmBehaviour(message.token);
        if (custom) return custom;
        sentTo.push({ token: message.token, data: message.data || {} });
        return json(200, { name: "projects/x/messages/1" });
      },
    ],
  ]);
}

const ANDROID_1 = "android-token-device-one-aaaaaaaaaaaa";
const ANDROID_2 = "android-token-device-two-bbbbbbbbbbbb";
const WEB_1 = "web-chrome-token-desktop-cccccccccccc";
const WEB_2 = "web-chrome-token-phone-dddddddddddddd";
const INSTALL_A = "install-android-A1";
const INSTALL_B = "install-android-B2";

const register = (uid, token, platform, installationId, opts = {}) =>
  invoke(fcmToken, { uid, body: { token, ...(platform ? { platform } : {}), ...(installationId ? { installationId } : {}) }, ...opts });
const unregister = (uid, body) => invoke(fcmToken, { method: "DELETE", uid, body });
const recipeReady = (uid, dedupeKey) =>
  notifyUserDevices(uid, { title: "Tarifin hazır", body: "x", data: { type: "recipe_ready", recipeId: "r1" } }, { nativeOnly: true, dedupeKey });
const hashFields = (uid) => {
  const v = db.get(pushTargetsKey(uid));
  return v && v.type === "hash" ? [...v.map.keys()].sort() : [];
};
const tokensSent = () => sentTo.map((s) => s.token).sort();

async function waitForJob(uid, jobId) {
  for (let i = 0; i < 300; i++) {
    const job = JSON.parse(db.get(`job:${uid}:${jobId}`) || "null");
    if (job && (job.status === "completed" || job.status === "failed") && job.notify) return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("job bitmedi");
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

// ---------------------------------------------------------------------------

test("FCM 1: tek Android token → tarif bildirimi tam 1 push", async () => {
  reset();
  assert.equal((await register("A", ANDROID_1, "android", INSTALL_A)).status, 200);
  const { job } = await runJob("A");
  assert.equal(job.status, "completed");
  assert.deepEqual(tokensSent(), [ANDROID_1]);
  assert.equal(sentTo[0].data.type, "recipe_ready");
  assert.deepEqual(job.notify, { sent: 1, attempted: 1, error: null });
});

test("FCM 2: aynı token iki kez kaydedilirse tek kayıt ve tek push", async () => {
  reset();
  await register("A", ANDROID_1, "android", INSTALL_A);
  await register("A", ANDROID_1, "android", INSTALL_A);
  // Eski şemada da aynı token yinelenmiş olsa bile tek hedef.
  db.set(fcmTokensKey("A"), JSON.stringify([ANDROID_1, ANDROID_1]));
  assert.deepEqual(hashFields("A"), [ANDROID_1]);
  const result = await recipeReady("A");
  assert.deepEqual(tokensSent(), [ANDROID_1]);
  assert.equal(result.attempted, 1);
});

test("FCM 3: 1 Android + 2 web (Chrome) token → tarif bildirimi yalnızca Android'e (production hatası)", async () => {
  reset();
  await register("A", ANDROID_1, "android", INSTALL_A);
  await register("A", WEB_1, "web", "install-web-desktop");
  await register("A", WEB_2, "web", "install-web-phone");
  const { job, response } = await runJob("A");
  assert.deepEqual(tokensSent(), [ANDROID_1], "Chrome'a tarif bildirimi gitmemeli");
  assert.equal(job.notify.sent, 1);
  assert.equal(response.notifyDevices, 1, "panelin gösterdiği cihaz sayısı da yalnızca native");
});

test("FCM 4: çıkış (DELETE) → eski hesap artık push alamaz", async () => {
  reset();
  await register("A", ANDROID_1, "android", INSTALL_A);
  const r = await unregister("A", { token: ANDROID_1, installationId: INSTALL_A });
  assert.equal(r.status, 200);
  assert.deepEqual(hashFields("A"), []);
  assert.equal(db.has(pushOwnerKey(ANDROID_1)), false);
  const result = await recipeReady("A");
  assert.equal(result.attempted, 0);
  assert.deepEqual(sentTo, []);
});

test("FCM 5: A'dan çıkış yapılmadan B'ye girilse bile cihaz yalnızca B'ye bağlı (eski şemadaki kayıt dahil)", async () => {
  reset();
  await register("A", ANDROID_1, "android", INSTALL_A);
  // A'nın eski listesinde de aynı token var (Grup 3 öncesi kayıt).
  db.set(fcmTokensKey("A"), JSON.stringify([ANDROID_1]));
  await register("B", ANDROID_1, "android", INSTALL_A);
  assert.deepEqual(hashFields("A"), []);
  assert.deepEqual(JSON.parse(db.get(fcmTokensKey("A"))), []);
  assert.deepEqual(hashFields("B"), [ANDROID_1]);
  assert.equal(db.get(pushOwnerKey(ANDROID_1)), "B");
  assert.equal((await recipeReady("A")).attempted, 0, "A bu cihaza bildirim gönderemez");
  await recipeReady("B");
  assert.deepEqual(tokensSent(), [ANDROID_1]);
});

test("FCM 5b: temizlik yarıda kalsa (eski hesabın kaydı silinemese) bile A hedeflemez — sahiplik okumada doğrulanır", async () => {
  reset();
  await register("A", ANDROID_1, "android", INSTALL_A);
  setRedisFault((c) => c[0] === "HDEL" && c[1] === pushTargetsKey("A"));
  await register("B", ANDROID_1, "android", INSTALL_A);
  setRedisFault(null);
  assert.deepEqual(hashFields("A"), [ANDROID_1], "kayıt A'da kaldı (temizlik başarısız)");
  assert.equal((await recipeReady("A")).attempted, 0, "ama A'ya gönderilmez");
  assert.deepEqual(hashFields("A"), [], "ve okuma sırasında tembel olarak temizlenir");
});

test("FCM 6: token yenilenince (aynı kurulum) eski token hedeflenmez", async () => {
  reset();
  await register("A", ANDROID_1, "android", INSTALL_A);
  const refreshed = "android-token-device-one-REFRESHED-zz";
  await register("A", refreshed, "android", INSTALL_A);
  assert.deepEqual(hashFields("A"), [refreshed]);
  assert.equal(db.has(pushOwnerKey(ANDROID_1)), false);
  await recipeReady("A");
  assert.deepEqual(tokensSent(), [refreshed]);
});

test("FCM 7: UNREGISTERED/geçersiz token depodan temizlenir; yük hatası (INVALID_ARGUMENT) token'ı silmez", async () => {
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

  // Yük hatası: token geçerli kalmalı.
  fcmBehaviour = () => json(400, { error: { status: "INVALID_ARGUMENT", message: "Invalid JSON payload received." } });
  await recipeReady("A");
  assert.deepEqual(hashFields("A"), [ANDROID_2]);

  assert.equal(isPermanentTokenError(400, { error: { status: "INVALID_ARGUMENT", message: "The registration token is not a valid FCM registration token" } }), true);
  assert.equal(isPermanentTokenError(403, { error: { status: "PERMISSION_DENIED", details: [{ errorCode: "SENDER_ID_MISMATCH" }] } }), true);
  assert.equal(isPermanentTokenError(500, { error: { status: "INTERNAL" } }), false);
  assert.equal(isPermanentTokenError(429, { error: { status: "RESOURCE_EXHAUSTED", details: [{ errorCode: "QUOTA_EXCEEDED" }] } }), false);
});

test("FCM 7b: geçersiz token temizliğinde Redis hatası gönderim sonucunu değiştirmez", async () => {
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

test("FCM 8: anonim → gerçek hesaba bağlama (aynı uid) ve bağlanamayınca mevcut hesaba geçiş", async () => {
  reset();
  // linkWithCredential: uid değişmez, anonim token sonradan e-posta token'ıyla yeniden kaydedilir.
  await register("ANON1", ANDROID_1, "android", INSTALL_A, { anonymous: true });
  await register("ANON1", ANDROID_1, "android", INSTALL_A);
  assert.deepEqual(hashFields("ANON1"), [ANDROID_1]);
  await recipeReady("ANON1");
  assert.deepEqual(tokensSent(), [ANDROID_1]);

  // credential-already-in-use: oturum başka (mevcut) hesaba geçer → cihaz o hesaba taşınır.
  sentTo = [];
  await register("REAL", ANDROID_1, "android", INSTALL_A);
  assert.equal((await recipeReady("ANON1")).attempted, 0);
  await recipeReady("REAL");
  assert.deepEqual(tokensSent(), [ANDROID_1]);
});

test("FCM 9: aynı hesaba bağlı iki Android cihaz → her biri tam 1 bildirim", async () => {
  reset();
  await register("A", ANDROID_1, "android", INSTALL_A);
  await register("A", ANDROID_2, "android", INSTALL_B);
  await register("A", WEB_1, "web", "install-web-desktop");
  const { job } = await runJob("A");
  assert.deepEqual(tokensSent(), [ANDROID_1, ANDROID_2].sort());
  assert.equal(job.notify.sent, 2);
});

test("FCM 10: eski şema güvenli geçiş — platform bilinmeyen kayıt yalnızca geçiş için, web etiketlenince çıkar, veri silinmez", async () => {
  reset();
  db.set(fcmTokensKey("A"), JSON.stringify([ANDROID_1, WEB_1, WEB_2]));
  // Henüz kimse platformla kaydolmadı: eski davranış korunur (bildirim kaybolmasın).
  await recipeReady("A", "job-1");
  assert.deepEqual(tokensSent(), [ANDROID_1, WEB_1, WEB_2].sort());

  // Android uygulaması yeni sürümle açıldı → artık yalnızca Android.
  sentTo = [];
  await register("A", ANDROID_1, "android", INSTALL_A);
  assert.deepEqual(JSON.parse(db.get(fcmTokensKey("A"))), [WEB_1, WEB_2], "Android eski listeden taşındı, web'ler silinmedi");
  await recipeReady("A", "job-2");
  assert.deepEqual(tokensSent(), [ANDROID_1]);

  // Chrome açıldı → web etiketlenir, eski listeden çıkar ama yine hedeflenmez.
  sentTo = [];
  await register("A", WEB_1, "web", "install-web-desktop");
  assert.deepEqual(JSON.parse(db.get(fcmTokensKey("A"))), [WEB_2]);
  await recipeReady("A", "job-3");
  assert.deepEqual(tokensSent(), [ANDROID_1]);

  // Aile bildirimi (platformdan bağımsız) eski + yeni hedefleri yinelenmesiz kullanır.
  const all = (await collectPushTargets("A")).map((t) => t.token).sort();
  assert.deepEqual(all, [ANDROID_1, WEB_1, WEB_2].sort());
});

test("FCM 10b: başka hesaba geçmiş eski şema token'ı geçiş fallback'inde bile gönderilmez", async () => {
  reset();
  db.set(fcmTokensKey("A"), JSON.stringify([ANDROID_1]));
  await register("B", ANDROID_1, "android", INSTALL_A); // cihaz artık B'nin
  assert.equal((await recipeReady("A")).attempted, 0);
  assert.deepEqual(sentTo, []);
});

test("FCM 10c: platform göndermeyen eski istemci paketi eski şemaya yazar (geriye uyumlu)", async () => {
  reset();
  assert.equal((await register("A", ANDROID_1)).status, 200);
  assert.deepEqual(JSON.parse(db.get(fcmTokensKey("A"))), [ANDROID_1]);
  assert.equal(db.get(pushOwnerKey(ANDROID_1)), "A");
  await recipeReady("A");
  assert.deepEqual(tokensSent(), [ANDROID_1]);
  assert.equal((await register("A", ANDROID_1, "desktop")).status, 400, "bilinmeyen platform reddedilir");
  assert.equal((await register("A", ANDROID_1, "android", "x")).status, 400, "geçersiz kurulum kimliği reddedilir");
});

test("FCM 11: aynı job için ikinci bildirim denemesi gönderilmez (dedupe)", async () => {
  reset();
  await register("A", ANDROID_1, "android", INSTALL_A);
  await recipeReady("A", "A:job-77:ready");
  const second = await recipeReady("A", "A:job-77:ready");
  assert.equal(second.duplicate, true);
  assert.deepEqual(tokensSent(), [ANDROID_1]);
  // Farklı job → yeni bildirim.
  await recipeReady("A", "A:job-78:ready");
  assert.equal(sentTo.length, 2);
});

test("FCM 12: web push kaydı olsa bile tarif HATA bildirimi de native dışına gitmez; aile bildirimi web'e gider", async () => {
  reset();
  await register("A", ANDROID_1, "android", INSTALL_A);
  await register("A", WEB_1, "web", "install-web-desktop");
  setRoutes([
    [ANTHROPIC, () => json(401, { error: { message: "invalid x-api-key" } })],
    ["https://oauth2.googleapis.com/token", () => json(200, { access_token: "fcm-access", expires_in: 3600 })],
    [FCM_SEND, (url, init) => (sentTo.push({ token: JSON.parse(init.body).message.token, data: JSON.parse(init.body).message.data }), json(200, {}))],
  ]);
  const { job } = await runJob("A");
  assert.equal(job.status, "failed");
  assert.deepEqual(tokensSent(), [ANDROID_1]);
  assert.equal(sentTo[0].data.type, "recipe_failed");

  // "Canı çekti" aile bildirimi platformdan bağımsız: B'nin Android'i + web'i.
  sentTo = [];
  db.set("user:S:profile", JSON.stringify({ isPlus: true, families: ["F1"] }));
  db.set("family:F1:meta", JSON.stringify({ name: "Ev", ownerUid: "S", inviteCode: "ABCDEF" }));
  db.set("family:F1:members", JSON.stringify({ S: { joinedAt: 1 }, A: { joinedAt: 2 } }));
  const r = await invoke(notify, { uid: "S", body: { familyId: "F1", recipeId: "r1", recipeTitle: "Menemen" } });
  assert.equal(r.status, 200);
  assert.deepEqual(tokensSent(), [ANDROID_1, WEB_1].sort());
  assert.equal(r.body.sent, 2);
});

test("FCM 13: hesap silinince push kayıtları ve sahiplik işaretleri temizlenir; başka hesabın sahipliğine dokunulmaz", async () => {
  reset();
  setRoutes([["https://", () => json(200, {})]]);
  await register("DEL1", ANDROID_1, "android", INSTALL_A);
  await register("DEL1", ANDROID_2, "android", INSTALL_B);
  await register("OTHER", ANDROID_2, "android", INSTALL_B); // ANDROID_2 artık OTHER'ın
  db.set("user:DEL1:profile", JSON.stringify({ isPlus: false, families: [] }));
  await deleteAccount("DEL1");
  assert.equal(db.has(pushTargetsKey("DEL1")), false);
  assert.equal(db.has(pushOwnerKey(ANDROID_1)), false);
  assert.equal(db.get(pushOwnerKey(ANDROID_2)), "OTHER");
  assert.deepEqual(hashFields("OTHER"), [ANDROID_2]);
});
