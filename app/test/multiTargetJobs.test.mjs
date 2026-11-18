// Paylaşım paneli: aynı anda kişisel + aile(ler)e kayıt, kaydetmeden önce ad
// değiştirme ve kısmi kayıtta AI'sız "Tekrar dene".
// Bellek içi Redis + sahte Google JWKS/OAuth/FCM + sahte Anthropic; dış ağ yok.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { setRoutes, invoke, resetDb, json, db, calls, waitFor, drainBackground } from "./helpers/fakeServices.mjs";

process.env.RECIPE_JOB_NOTIFY_MIN_DELAY_MS = "0";
{
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.FIREBASE_SERVICE_ACCOUNT_KEY = JSON.stringify({
    client_email: "test@tarif-kutusu.test",
    project_id: "tarif-kutusu",
    private_key: privateKey.export({ format: "pem", type: "pkcs8" }),
  });
}

const { default: recipeJobs, parseTitleOverride } = await import("../api/recipe-jobs.js");
const { FREE_RECIPE_LIMIT } = await import("../shared/limits.js");

const ANTHROPIC = "https://api.anthropic.com/v1/messages";
const FCM_SEND = "https://fcm.googleapis.com/v1/projects/tarif-kutusu/messages:send";
const RECIPE = {
  title: "Fırın Tavuk",
  servings: 4,
  ingredients: [{ name: "tavuk", amount: "1 kg" }],
  instructions: ["Pişir."],
};

let pushes = [];
function routes() {
  setRoutes([
    [ANTHROPIC, () => json(200, { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(RECIPE) }], usage: { output_tokens: 10 } })],
    ["https://oauth2.googleapis.com/token", () => json(200, { access_token: "fcm-access", expires_in: 3600 })],
    [
      FCM_SEND,
      (url, init) => {
        pushes.push(JSON.parse(init.body).message);
        return json(200, { name: "projects/x/messages/1" });
      },
    ],
  ]);
}
const aiCalls = () => calls.filter((c) => c.url === ANTHROPIC).length;

const read = (key) => (db.has(key) ? JSON.parse(db.get(key)) : undefined);

function family(id, members) {
  db.set(`family:${id}:meta`, JSON.stringify({ name: `Aile ${id}`, ownerUid: members[0], inviteCode: `CODE${id}` }));
  db.set(`family:${id}:members`, JSON.stringify(Object.fromEntries(members.map((uid, i) => [uid, { joinedAt: i + 1 }]))));
  db.set(`family:${id}:recipes`, JSON.stringify([]));
}

function reset({ isPlus = true, families = ["F1", "F2"] } = {}) {
  resetDb();
  pushes = [];
  routes();
  db.set("user:A:profile", JSON.stringify({ isPlus, families }));
  db.set("user:A:recipes", JSON.stringify([]));
  db.set("user:A:pushTargets", { type: "hash", map: new Map([["device-1", JSON.stringify({ platform: "android", installationId: "i-1", updatedAt: 1 })]]) });
  family("F1", ["A"]);
  family("F2", ["A"]);
}

let n = 0;
const body = (extra) => ({
  requestId: `mt-${++n}-abcdef`,
  sourceUrl: `https://www.instagram.com/p/MT${n}/`,
  caption: "1 kg tavuk, 2 yemek kaşığı salça, 1 su bardağı su ile fırında pişirilir.",
  category: "Kahvaltı",
  language: "tr",
  ...extra,
});

async function runJob(extra) {
  const r = await invoke(recipeJobs, { uid: "A", body: body(extra) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await drainBackground();
  const job = await waitFor(() => {
    const j = read(`job:A:${r.body.jobId}`);
    return (j?.status === "completed" || j?.status === "failed") && j.notify && j;
  }, { message: "job bitmeli" });
  return job;
}

const ALL = [{ scope: "personal" }, { scope: "family", familyId: "F1" }, { scope: "family", familyId: "F2" }];

const withoutId = ({ id, ...rest }) => rest;

test("Çoklu hedef: tek AI çağrısı, kişisel + iki aileye BAĞIMSIZ kopyalar (ayrı kimlik, aynı içerik)", async () => {
  reset();
  const job = await runJob({ targets: ALL });
  assert.equal(job.status, "completed");
  assert.equal(aiCalls(), 1);
  const personal = read("user:A:recipes");
  const f1 = read("family:F1:recipes");
  const f2 = read("family:F2:recipes");
  assert.equal(personal.length, 1);
  assert.equal(f1.length, 1);
  assert.equal(f2.length, 1);
  assert.equal(f1[0].id, `${personal[0].id}-fam-F1`);
  assert.equal(f2[0].id, `${personal[0].id}-fam-F2`);
  assert.deepEqual(withoutId(f1[0]), withoutId(personal[0]));
  assert.deepEqual(withoutId(f2[0]), withoutId(personal[0]));
  assert.equal(job.recipeId, personal[0].id);
  assert.equal(pushes[0].data.recipeId, personal[0].id);
  assert.equal(personal[0].servings, 4);
  assert.deepEqual(job.targets.map((t) => t.status), ["saved", "saved", "saved"]);
  assert.equal(job.recipe, undefined, "her yere yazıldıysa tarif job kaydında saklanmaz");
  assert.equal(db.has("user:A:job-attention"), false);
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].data.familyIds, "F1,F2");
  assert.equal(pushes[0].data.scope, undefined, "kişisel kayıt varsa bildirim kişisel tarifi açar");
});

test("Ad değiştirme: kullanıcının verdiği ad bütün hedeflere yazılır, AI'a ikinci kez gidilmez", async () => {
  reset();
  const job = await runJob({ targets: ALL, title: "  Annemin   tavuğu " });
  assert.equal(aiCalls(), 1);
  for (const key of ["user:A:recipes", "family:F1:recipes", "family:F2:recipes"]) assert.equal(read(key)[0].title, "Annemin tavuğu");
  assert.equal(job.recipeTitle, "Annemin tavuğu");
  assert.match(pushes[0].notification.body, /Annemin tavuğu/);
});

test("Ad doğrulama: boş → AI başlığı; uzun kırpılır; metin olmayan 400", async () => {
  assert.equal(parseTitleOverride(undefined), "");
  assert.equal(parseTitleOverride("   "), "");
  assert.equal(parseTitleOverride("a\nb\tc"), "a b c");
  assert.equal(parseTitleOverride("x".repeat(300)).length, 120);
  assert.equal(parseTitleOverride(42), null);
  reset();
  const r = await invoke(recipeJobs, { uid: "A", body: body({ title: { x: 1 } }) });
  assert.equal(r.status, 400);
  const job = await runJob({ title: "" });
  assert.equal(read("user:A:recipes")[0].title, "Fırın Tavuk");
  assert.equal(job.status, "completed");
});

test("Tek hedef seçilebilir: yalnızca aile (kişisel listeye hiçbir şey yazılmaz)", async () => {
  reset();
  const job = await runJob({ targets: [{ scope: "family", familyId: "F2" }] });
  assert.equal(job.status, "completed");
  assert.deepEqual(read("user:A:recipes"), []);
  assert.equal(read("family:F2:recipes").length, 1);
  assert.equal(job.recipeId, read("family:F2:recipes")[0].id, "job kaydı aile kopyasını gösterir");
  assert.match(job.recipeId, /-fam-F2$/);
  assert.deepEqual(pushes[0].data, { type: "recipe_ready", recipeId: job.recipeId, scope: "family", familyId: "F2" });
});

test("Eski panel biçimi (target/familyId) aynen çalışır", async () => {
  reset();
  const job = await runJob({ target: "family", familyId: "F1" });
  assert.equal(job.status, "completed");
  assert.equal(job.scope, "family");
  assert.equal(job.familyId, "F1");
  assert.equal(read("family:F1:recipes").length, 1);
});

test("Geçersiz hedef listeleri 400; üyesi olunmayan aile 403 ve AI'a gidilmez", async () => {
  reset();
  for (const targets of [[], [{ scope: "x" }], [null], [{ scope: "family" }], "personal", new Array(4).fill({ scope: "personal" }).map((t, i) => ({ ...t, i }))]) {
    const r = await invoke(recipeJobs, { uid: "A", body: body({ targets }) });
    assert.equal(r.status, 400, JSON.stringify(targets));
  }
  family("F9", ["B"]);
  const r = await invoke(recipeJobs, { uid: "A", body: body({ targets: [{ scope: "personal" }, { scope: "family", familyId: "F9" }] }) });
  assert.equal(r.status, 403);
  assert.equal(r.body.familyId, "F9");
  assert.equal(aiCalls(), 0);
  assert.deepEqual(read("user:A:recipes"), []);
});

test("Free sınırı kişisel hedef seçiliyken job kabulünde uygulanır (AI'dan önce)", async () => {
  reset({ isPlus: false, families: [] });
  db.set("user:A:recipes", JSON.stringify(Array.from({ length: FREE_RECIPE_LIMIT }, (_, i) => ({ id: `r${i}`, title: `T${i}` }))));
  const r = await invoke(recipeJobs, { uid: "A", body: body({ targets: [{ scope: "personal" }] }) });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "free_recipe_limit");
  assert.equal(aiCalls(), 0);
});

test("Kısmi kayıt: aile erişimi job sürerken kalkarsa kişisel kayıt durur, aile başarısız görünür; Tekrar dene AI'sız ve kopyasız", async () => {
  reset();
  // AI çalışırken F2 üyeliği düşsün (Plus/üyelik yazımdan hemen önce yeniden denetlenir).
  setRoutes([
    [
      ANTHROPIC,
      () => {
        db.set("family:F2:members", JSON.stringify({ B: { joinedAt: 1 } }));
        return json(200, { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(RECIPE) }], usage: { output_tokens: 10 } });
      },
    ],
    ["https://oauth2.googleapis.com/token", () => json(200, { access_token: "fcm-access", expires_in: 3600 })],
    [FCM_SEND, (url, init) => (pushes.push(JSON.parse(init.body).message), json(200, { name: "m" }))],
  ]);
  const job = await runJob({ targets: ALL, title: "Benim Tavuğum" });
  assert.equal(job.status, "completed");
  assert.deepEqual(job.targets.map((t) => [t.scope, t.familyId, t.status]), [
    ["personal", undefined, "saved"],
    ["family", "F1", "saved"],
    ["family", "F2", "failed"],
  ]);
  assert.deepEqual(read("family:F2:recipes"), [], "başarısız aile hedefi kişisel listeye düşmez, aileye de yazılmaz");
  assert.equal(job.recipe.title, "Benim Tavuğum");
  assert.match(pushes[0].notification.body, /Bazı yerlere kaydedilemedi/);

  const list = await invoke(recipeJobs, { method: "GET", uid: "A", query: { attention: "1" } });
  assert.equal(list.status, 200);
  assert.equal(list.body.jobs.length, 1);
  assert.equal(list.body.jobs[0].recipeTitle, "Benim Tavuğum");
  assert.deepEqual(list.body.jobs[0].targets.map((t) => t.status), ["saved", "saved", "failed"]);

  // Hâlâ üye değilken tekrar: yine başarısız, hiçbir yerde kopya yok.
  let retry = await invoke(recipeJobs, { uid: "A", body: { action: "retry", jobId: job.id } });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.job.targets[2].status, "failed");
  assert.equal(read("user:A:recipes").length, 1);

  // Üyelik geri gelince: yalnızca F2'ye yazılır; aynı id, aynı ad, ikinci AI çağrısı yok.
  family("F2", ["A"]);
  retry = await invoke(recipeJobs, { uid: "A", body: { action: "retry", jobId: job.id } });
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.body.job.targets.map((t) => t.status), ["saved", "saved", "saved"]);
  assert.equal(aiCalls(), 1);
  assert.equal(read("user:A:recipes").length, 1);
  assert.equal(read("family:F1:recipes").length, 1);
  assert.equal(read("family:F2:recipes")[0].id, `${read("user:A:recipes")[0].id}-fam-F2`);
  assert.deepEqual(withoutId(read("family:F2:recipes")[0]), withoutId(read("user:A:recipes")[0]));
  assert.equal(read("family:F2:recipes")[0].title, "Benim Tavuğum");
  assert.equal(read(`job:A:${job.id}`).recipe, null, "her şey yazılınca saklanan kopya atılır");
  assert.deepEqual((await invoke(recipeJobs, { method: "GET", uid: "A", query: { attention: "1" } })).body.jobs, []);

  // Bir kez daha tekrar: hiçbir şey değişmez.
  retry = await invoke(recipeJobs, { uid: "A", body: { action: "retry", jobId: job.id } });
  assert.equal(retry.status, 200);
  assert.equal(read("family:F2:recipes").length, 1);
});

test("Hiçbir hedefe yazılamazsa: job failed, tarif saklanır, bildirim linksiz; Tekrar dene AI'sız kaydeder", async () => {
  reset({ isPlus: false, families: [] });
  // Kabulde sınırın altında; AI sürerken başka cihazdan liste doldu.
  setRoutes([
    [
      ANTHROPIC,
      () => {
        db.set("user:A:recipes", JSON.stringify(Array.from({ length: FREE_RECIPE_LIMIT }, (_, i) => ({ id: `r${i}`, title: `T${i}` }))));
        return json(200, { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(RECIPE) }], usage: { output_tokens: 10 } });
      },
    ],
    ["https://oauth2.googleapis.com/token", () => json(200, { access_token: "fcm-access", expires_in: 3600 })],
    [FCM_SEND, (url, init) => (pushes.push(JSON.parse(init.body).message), json(200, { name: "m" }))],
  ]);
  const job = await runJob({ targets: [{ scope: "personal" }] });
  assert.equal(job.status, "failed");
  assert.equal(job.errorCode, "free_recipe_limit");
  assert.equal(job.recipeId, null);
  assert.ok(job.recipe);
  assert.deepEqual(pushes[0].data, { type: "recipe_failed", saveFailed: "1" });
  assert.match(pushes[0].notification.body, /hazırlandı ama kaydedilemedi/);

  // Sınır hâlâ dolu: tekrar dene yine Free sınırıyla düşer (sunucu uygular).
  let retry = await invoke(recipeJobs, { uid: "A", body: { action: "retry", jobId: job.id } });
  assert.equal(retry.body.job.targets[0].code, "free_recipe_limit");
  assert.equal(read("user:A:recipes").length, FREE_RECIPE_LIMIT);

  // Bir tarif silinince kaydedilir; AI'a yeniden gidilmez.
  db.set("user:A:recipes", JSON.stringify(read("user:A:recipes").slice(1)));
  retry = await invoke(recipeJobs, { uid: "A", body: { action: "retry", jobId: job.id } });
  assert.equal(retry.body.job.status, "completed");
  assert.equal(read("user:A:recipes")[0].id, job.recipe.id);
  assert.equal(aiCalls(), 1);
});

test("Kapat (dismiss): uyarı listeden kalkar, saklanan tarif atılır; başka kullanıcı job'a erişemez", async () => {
  reset();
  db.set("family:F2:members", JSON.stringify({ B: { joinedAt: 1 } }));
  // Kabul anında F2 üyeliği yoksa job hiç açılmaz; bu yüzden kısmi durumu doğrudan kuruyoruz.
  db.set("job:A:job-x-123", JSON.stringify({ id: "job-x-123", status: "completed", recipe: { id: "rx", title: "X" }, targets: [{ scope: "personal", status: "saved" }, { scope: "family", familyId: "F2", status: "failed", error: "Bu ailenin üyesi değilsin." }] }));
  db.set("user:A:job-attention", { type: "hash", map: new Map([["job-x-123", "1"]]) });
  assert.equal((await invoke(recipeJobs, { method: "GET", uid: "A", query: { attention: "1" } })).body.jobs.length, 1);
  assert.equal((await invoke(recipeJobs, { uid: "B", body: { action: "retry", jobId: "job-x-123" } })).status, 404);
  assert.equal((await invoke(recipeJobs, { uid: "A", body: { action: "nope", jobId: "job-x-123" } })).status, 400);
  const d = await invoke(recipeJobs, { uid: "A", body: { action: "dismiss", jobId: "job-x-123" } });
  assert.equal(d.status, 200);
  assert.equal(read("job:A:job-x-123").recipe, null);
  assert.deepEqual((await invoke(recipeJobs, { method: "GET", uid: "A", query: { attention: "1" } })).body.jobs, []);
});
