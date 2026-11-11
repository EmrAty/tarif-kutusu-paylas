// Grup 1 (sürümlü veri, karşılaştır-ve-yaz, güncelleme kapısı) + Grup 2 (AI
// koruması, kira, maliyet sayacı, girdi bütçesi) BİRLİKTE. Her iki taraf da aynı
// bellek içi Redis'te (gerçek Lua ile EVAL, MGET, /pipeline, sıralı küme) çalışır.
// Anthropic hep taklit; gerçek ağ/para yok.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setRoutes, calls, invoke, resetDb, json, db, setRedisFault, setRedisHook, zsetSize } from "./helpers/fakeServices.mjs";

process.env.RECIPE_JOB_NOTIFY_MIN_DELAY_MS = "0";

const { default: recipeJobs } = await import("../api/recipe-jobs.js");
const { default: dataHandler } = await import("../api/data.js");
const { default: extract } = await import("../api/extract.js");
const { default: suggest } = await import("../api/suggest-recipes.js");
const { default: translate, TRANSLATE_INPUT_LIMITS } = await import("../api/translate-recipe.js");
const { reserveAiBudget, acquireSlot, __setClockForTests } = await import("../api/_lib/aiGuard.js");
const { readBucket, compareAndSet, versionKey, listBackups } = await import("../api/_lib/versionedBucket.js");
const { redisCommand, redisPipeline, redisGet } = await import("../api/_lib/redis.js");
const { createBucketStore, createDataTransport } = await import("../src/syncedBuckets.js");
const { createUpdateGate, isClientOutdatedResponse, CLIENT_OUTDATED } = await import("../src/updateRequired.js");
const { classifyErrorResponse, serverErrorKey, readErrorBody } = await import("../src/apiErrors.js");

const FIXED_NOW = Date.UTC(2026, 10, 11, 9, 30, 20);
__setClockForTests(() => FIXED_NOW);

const ANTHROPIC = "https://api.anthropic.com/v1/messages";
const RECIPE = { title: "Fırın Tavuk", ingredients: [{ name: "tavuk", amount: "1 kg" }], instructions: ["Pişir."] };
const okClaude = () => json(200, { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(RECIPE) }], usage: { output_tokens: 10 } });
const anthropicCalls = () => calls.filter((c) => c.url === ANTHROPIC);

function reset(route = () => okClaude()) {
  resetDb();
  setRoutes([[ANTHROPIC, route]]);
}

const recipesOf = (n, prefix = "r") => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i + 1}`, title: `Tarif ${i + 1}`, isFavorite: false }));
const readList = (key) => JSON.parse(db.get(key));
const inflight = (uid) => zsetSize(`ai:inflight:heavy:${uid}`);
const counter = (prefix) => [...db].reduce((n, [k, v]) => (k.startsWith(prefix) && typeof v === "string" ? n + Number(v) : n), 0);
const isEvalOn = (key) => (c) => c[0] === "EVAL" && c[3] === key;

const jobBody = (i, extra = {}) => ({
  requestId: `int-${i}-abcdef`,
  sourceUrl: `https://www.instagram.com/p/INT${i}/`,
  caption: "1 kg tavuk, 2 yemek kaşığı salça, 1 su bardağı su ile fırında pişirilir.",
  category: "Kahvaltı",
  ...extra,
});

async function waitForJob(uid, jobId) {
  for (let i = 0; i < 200; i++) {
    const job = JSON.parse(db.get(`job:${uid}:${jobId}`) || "null");
    if (job && (job.status === "completed" || job.status === "failed")) {
      // processRecipeJob kirayı finally'de, job kaydından sonra bırakıyor.
      await new Promise((r) => setTimeout(r, 20));
      return job;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`job bitmedi: ${db.get(`job:${uid}:${jobId}`)}`);
}

// Uygulamanın gerçek istemci deposu (Grup 1), doğrudan api/data.js'e bağlı.
function clientStore(uid, gate = createUpdateGate()) {
  const transport = createDataTransport(async (method, { query, body }) => {
    const r = await invoke(dataHandler, { method, uid, query: query || {}, body });
    return { status: r.status, body: r.body };
  });
  return createBucketStore({ transport, updateGate: gate });
}
const setFavorite = (id) => (list) => list.map((r) => (r.id === id ? { ...r, isFavorite: true } : r));
const addRecipe = (recipe) => (list) => [recipe, ...list];

// ============ Test 1 — AI job + sürümlü yazım + eşzamanlı istemci ============

test("entegrasyon 1: job tarifi sürümlü yazımla kaydedilir; aynı anda istemcinin yaptığı değişiklik de korunur; kira temizlenir", async () => {
  reset();
  const uid = "I1";
  const key = `user:${uid}:recipes`;
  db.set(`user:${uid}:profile`, JSON.stringify({ isPlus: true, families: [] }));
  db.set(key, JSON.stringify(recipesOf(5)));
  const store = clientStore(uid);
  await store.load("recipes", "personal");

  // Job'un karşılaştır-ve-yaz'ından hemen önce istemci iki değişiklik yazıyor.
  let raced = false;
  setRedisHook(async (command) => {
    if (raced || !isEvalOn(key)(command)) return;
    raced = true;
    await store.mutate("recipes", "personal", addRecipe({ id: "manual", title: "Elle" }));
    await store.mutate("recipes", "personal", setFavorite("r3"));
  });

  const r = await invoke(recipeJobs, { uid, body: jobBody(1) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const job = await waitForJob(uid, r.body.jobId);
  assert.equal(job.status, "completed", job.error);
  assert.ok(raced, "yarış gerçekten oluştu");

  const list = readList(key);
  assert.equal(list.length, 7);
  assert.ok(list.some((x) => x.id === job.recipeId), "job tarifi korundu");
  assert.ok(list.some((x) => x.id === "manual"), "istemcinin tarifi korundu");
  assert.equal(list.find((x) => x.id === "r3").isFavorite, true, "istemcinin favorisi korundu");
  assert.equal(Number(db.get(versionKey(key))), 4, "istemci 2 + job 1 yazım (sürüm 1'den)");
  assert.equal(inflight(uid), 0, "kira bırakıldı");
  assert.equal(counter("rl:global:ai:3600:"), 1, "tek sağlayıcı işi = tek maliyet sayımı");

  // İstemci bayat görünümünden bir değişiklik daha yapsa da job tarifi silinmez.
  await store.mutate("recipes", "personal", setFavorite("r1"));
  assert.ok(readList(key).some((x) => x.id === job.recipeId));
});

// ============ Test 2 — Çakışma sırasında kira ============

test("entegrasyon 2: yazım iki kez sürüm çakışmasına uğrar, yeniden deneme başarılı; veri kaybı yok, kira temizlenir", async () => {
  reset();
  const uid = "I2";
  const key = `user:${uid}:recipes`;
  db.set(`user:${uid}:profile`, JSON.stringify({ isPlus: true, families: [] }));
  db.set(key, JSON.stringify(recipesOf(3)));
  let bumps = 0;
  setRedisHook(async (command) => {
    if (!isEvalOn(key)(command) || bumps >= 2) return;
    bumps++;
    // Başka bir yazan araya giriyor (sürüm artıyor, tarif ekleniyor).
    const current = await readBucket(key);
    const list = JSON.parse(current.raw);
    db.set(key, JSON.stringify([{ id: `other${bumps}` }, ...list]));
    db.set(versionKey(key), String(current.version + 1));
  });

  const r = await invoke(recipeJobs, { uid, body: jobBody(2) });
  const job = await waitForJob(uid, r.body.jobId);
  assert.equal(job.status, "completed", job.error);
  assert.equal(bumps, 2);
  const ids = readList(key).map((x) => x.id);
  for (const id of ["r1", "r2", "r3", "other1", "other2", job.recipeId]) assert.ok(ids.includes(id), id);
  assert.equal(ids.length, 6);
  assert.equal(inflight(uid), 0);
});

// ============ Test 3 — Sağlayıcı hatası ============

test("entegrasyon 3: sağlayıcı hatası → kova (değer + sürüm + yedek) değişmez, job failed, kira temizlenir", async () => {
  reset(() => json(500, { error: { message: "boom" } }));
  const uid = "I3";
  const key = `user:${uid}:recipes`;
  db.set(`user:${uid}:profile`, JSON.stringify({ isPlus: true, families: [] }));
  db.set(key, JSON.stringify(recipesOf(4)));
  db.set(versionKey(key), "9");
  const before = db.get(key);

  const r = await invoke(recipeJobs, { uid, body: jobBody(3) });
  const job = await waitForJob(uid, r.body.jobId);
  assert.equal(job.status, "failed");
  assert.equal(db.get(key), before);
  assert.equal(db.get(versionKey(key)), "9");
  assert.equal((await listBackups(key)).recent.length, 0, "yazım olmadığı için yedek de yok");
  assert.equal(inflight(uid), 0);
});

test("entegrasyon 3b: yazım sırasında Redis hatası (EVAL 500) → veri değişmez, job failed, kira temizlenir", async () => {
  reset();
  const uid = "I3B";
  const key = `user:${uid}:recipes`;
  db.set(`user:${uid}:profile`, JSON.stringify({ isPlus: true, families: [] }));
  db.set(key, JSON.stringify(recipesOf(2)));
  const before = db.get(key);
  setRedisFault(isEvalOn(key));
  const r = await invoke(recipeJobs, { uid, body: jobBody(31) });
  const job = await waitForJob(uid, r.body.jobId);
  setRedisFault(null);
  assert.equal(job.status, "failed");
  assert.equal(db.get(key), before);
  assert.equal(inflight(uid), 0);
});

test("entegrasyon 3c: Free limit — kabulde dolu kova 403 (kira/sayaç yok); iş sürerken dolarsa job failed, istemcinin tarifi korunur, kira temizlenir", async () => {
  reset();
  const uid = "I3C";
  const key = `user:${uid}:recipes`;
  db.set(`user:${uid}:profile`, JSON.stringify({ isPlus: false, families: [] }));

  db.set(key, JSON.stringify(recipesOf(15)));
  const full = await invoke(recipeJobs, { uid, body: jobBody(40) });
  assert.equal(full.status, 403);
  assert.equal(full.body.code, "free_recipe_limit");
  assert.equal(inflight(uid), 0);
  assert.equal(counter("rl:global:ai:"), 0);
  assert.equal(anthropicCalls().length, 0);

  // 14 tarifle kabul edilir; Claude dönerken istemci 15. tarifi ekler.
  db.set(key, JSON.stringify(recipesOf(14)));
  db.delete(versionKey(key));
  const store = clientStore(uid);
  await store.load("recipes", "personal");
  let raced = false;
  setRedisHook(async (command) => {
    if (raced || !isEvalOn(key)(command)) return;
    raced = true;
    await store.mutate("recipes", "personal", addRecipe({ id: "manual15" }));
  });
  const r = await invoke(recipeJobs, { uid, body: jobBody(41) });
  assert.equal(r.status, 200);
  const job = await waitForJob(uid, r.body.jobId);
  assert.equal(job.status, "failed");
  const list = readList(key);
  assert.equal(list.length, 15);
  assert.ok(list.some((x) => x.id === "manual15"));
  assert.equal(inflight(uid), 0);
});

test("entegrasyon 3d: doğrulama/aynı video çıkışları kira bırakır; ikinci paylaşım maliyet sayılmaz", async () => {
  reset();
  const uid = "I3D";
  db.set(`user:${uid}:profile`, JSON.stringify({ isPlus: true, families: [] }));
  const bad = await invoke(recipeJobs, { uid, body: jobBody(50, { category: "Yok" }) });
  assert.equal(bad.status, 400);
  assert.equal(inflight(uid), 0);

  const first = await invoke(recipeJobs, { uid, body: jobBody(51) });
  await waitForJob(uid, first.body.jobId);
  const dup = await invoke(recipeJobs, { uid, body: jobBody(51, { requestId: "int-51-other1" }) });
  assert.equal(dup.body.duplicate, true);
  assert.equal(inflight(uid), 0);
  assert.equal(counter("rl:global:ai:3600:"), 1);
  assert.equal(anthropicCalls().length, 1);
});

// ============ Test 4 — client_update_required ============

test("entegrasyon 4: /api/extract eski istemciyi client_update_required ile reddeder → merkezi kapı tetiklenir, sonraki değişiklik bloklanır", async () => {
  reset();
  const uid = "I4";
  const r = await invoke(extract, { uid, body: { system: "x", model: "claude-opus", max_tokens: 99999, messages: [] } });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "client_update_required");
  assert.equal(anthropicCalls().length, 0);
  assert.equal(counter("rl:global:ai:"), 0, "eski istemci reddi maliyet sayılmaz");

  const gate = createUpdateGate();
  const verdict = classifyErrorResponse(r.status, r.body, { gate });
  assert.equal(verdict.outdated, true);
  assert.equal(verdict.code, "client_update_required");
  assert.equal(gate.isRequired(), true);

  // Grup 1: kapı kapandıktan sonra hiçbir değişiklik sunucuya gitmez.
  db.set(`user:${uid}:recipes`, JSON.stringify(recipesOf(2)));
  const store = clientStore(uid, gate);
  await store.load("recipes", "personal");
  const before = db.get(`user:${uid}:recipes`);
  await assert.rejects(store.mutate("recipes", "personal", addRecipe({ id: "x" })), (e) => e.code === CLIENT_OUTDATED);
  assert.equal(db.get(`user:${uid}:recipes`), before);

  // syncedBuckets'ın kendi transport'u da aynı kodu tanır.
  assert.equal(isClientOutdatedResponse(400, { code: "client_update_required" }), true);
});

test("entegrasyon 4b: 426 ve client_outdated kapıyı tetikler (Grup 1 davranışı aynen)", async () => {
  reset();
  for (const [status, body] of [[426, {}], [400, { code: "client_outdated" }], [426, { code: "client_outdated" }]]) {
    const gate = createUpdateGate();
    assert.equal(classifyErrorResponse(status, body, { gate }).outdated, true, `${status} ${JSON.stringify(body)}`);
    assert.equal(gate.isRequired(), true);
  }
  // Sunucu: sürüm göndermeyen yazım gerçekten 426 client_outdated döner.
  const r = await invoke(dataHandler, { uid: "I4B", body: { bucket: "recipes", scope: "personal", value: "[]" } });
  assert.equal(r.status, 426);
  assert.equal(r.body.code, "client_outdated");
});

// ============ Test 5 — input_too_large ============

test("entegrasyon 5: input_too_large kodu korunur, kapıyı tetiklemez, doğru mesaja eşlenir; diğer kodlar da kapıya dokunmaz", async () => {
  reset();
  const uid = "I5";
  const huge = { id: "big", title: "Dev", ingredients: [], instructions: Array.from({ length: 20 }, () => "x".repeat(2000)) };
  db.set(`user:${uid}:recipes`, JSON.stringify([huge]));
  const r = await invoke(translate, { uid, body: { recipeId: "big", scope: "personal", target: "en" } });
  assert.equal(r.status, 413);
  assert.equal(r.body.code, "input_too_large");
  assert.equal(anthropicCalls().length, 0);
  assert.equal(counter("rl:"), 0, "hiçbir sayaç artmadı");
  assert.ok(TRANSLATE_INPUT_LIMITS.maxTotalChars === 16000);

  const gate = createUpdateGate();
  const verdict = classifyErrorResponse(r.status, r.body, { gate });
  assert.deepEqual(verdict, { outdated: false, code: "input_too_large" });
  assert.equal(gate.isRequired(), false);
  assert.equal(serverErrorKey("input_too_large"), "errors.inputTooLong");

  for (const [status, code] of [[429, "rate_limited"], [409, "version_conflict"], [403, "free_recipe_limit"], [503, "ai_capacity"], [429, "too_many_in_flight"]]) {
    const g = createUpdateGate();
    assert.deepEqual(classifyErrorResponse(status, { code }, { gate: g }), { outdated: false, code });
    assert.equal(g.isRequired(), false, code);
  }
  assert.equal(serverErrorKey("rate_limited"), "errors.rateLimited");

  // Eşlenen anahtarlar iki dilde de var (i18n.jsx JSX olduğu için metin olarak okunur).
  const i18n = fs.readFileSync(new URL("../src/i18n.jsx", import.meta.url), "utf8");
  for (const k of ["errors.inputTooLong", "errors.rateLimited", "errors.clientUpdateRequired", "errors.clientOutdated", "translation.tooLarge"]) {
    assert.equal(i18n.split(`"${k}":`).length - 1, 2, `${k} tr+en`);
  }

  // JSON olmayan hata gövdesi güvenle okunur.
  assert.deepEqual(await readErrorBody(new Response("<html>502</html>", { status: 502 })), {});
});

// ============ Test 6 — Redis yardımcıları birlikte ============

test("entegrasyon 6: AI koruması (/pipeline), sürümlü kova (MGET/EVAL) ve sıkı hata işleme aynı ortamda çalışır", async () => {
  reset();
  // AI pipeline: sayaç + kira.
  await reserveAiBudget({ uid: "I6", isAnonymous: false });
  assert.equal(counter("rl:user-ai:I6:3600:"), 1);
  assert.equal(counter("rl:global:ai:3600:"), 1);
  const release = await acquireSlot({ pool: "heavy", uid: "I6", isAnonymous: false });
  assert.equal(inflight("I6"), 1);
  await release();
  assert.equal(inflight("I6"), 0);

  // Sürümlü kova: tembel geçiş + karşılaştır-ve-yaz + yedek.
  const key = "user:I6:recipes";
  db.set(key, JSON.stringify(recipesOf(1)));
  const current = await readBucket(key);
  assert.equal(current.version, 1);
  assert.deepEqual(await compareAndSet(key, 1, JSON.stringify(recipesOf(2))), { ok: true, version: 2 });
  assert.equal((await compareAndSet(key, 1, "[]")).ok, false, "bayat sürüm yazamaz");
  assert.equal(readList(key).length, 2);
  assert.equal((await listBackups(key)).recent.length, 1);

  // Grup 1 sıkı hata işleme: komut hatası "kayıt yok" sayılmaz.
  db.set("wrongtype", "x");
  await assert.rejects(redisCommand(["ZCARD", "wrongtype"]), (e) => e.status === 502);
  await assert.rejects(redisCommand(["LPUSH", "wrongtype", "a"]), (e) => e.status === 502);

  // Pipeline: komut hatası yalnızca o elemanda Error; HTTP hatası tümden throw.
  const results = await redisPipeline([["INCR", "p:ok"], ["INCR", "wrongtype"], ["GET", "p:ok"]]);
  assert.equal(results[0], 1);
  assert.ok(results[1] instanceof Error);
  assert.equal(results[2], "1");
  setRedisFault(() => true);
  await assert.rejects(redisPipeline([["INCR", "p:ok"]]), (e) => e.status === 502);
  // AI koruması bu durumda fail-open (bilerek), sürümlü okuma ise HATA verir (boş liste değil).
  await reserveAiBudget({ uid: "I6", isAnonymous: false });
  await assert.rejects(readBucket(key));
  const read = await invoke(dataHandler, { method: "GET", uid: "I6", query: { bucket: "recipes", scope: "personal" } });
  assert.ok(read.status >= 500, "okuma hatası boş liste olarak dönmez");
  setRedisFault(null);
  assert.equal(readList(key).length, 2);
});

// ============ Ek deney — karışık uçlarla UID tavanı (recipe-jobs dahil) ============

test("entegrasyon 7: tek UID extract + recipe-jobs karıştırarak saatlik toplam tavanı aşamaz; başka UID etkilenmez", async () => {
  reset();
  const uid = "I7";
  db.set(`user:${uid}:profile`, JSON.stringify({ isPlus: true, families: [] }));
  // Kalıcı hesap tavanı 120/saat: önceden 118 sağlayıcı işi sayılmış olsun.
  const bucket = Math.floor(FIXED_NOW / 1000 / 3600);
  db.set(`rl:user-ai:${uid}:3600:${bucket}`, "118");
  db.set(`rl:global:ai:3600:${bucket}`, "118");

  const body = { link: "https://www.tiktok.com/@sef/video/1", caption: "1 su bardağı mercimek, 1 soğan", notes: "", language: "tr" };
  assert.equal((await invoke(extract, { uid, body })).status, 200);
  const job = await invoke(recipeJobs, { uid, body: jobBody(70) });
  assert.equal(job.status, 200);
  await waitForJob(uid, job.body.jobId);

  const over = await invoke(recipeJobs, { uid, body: jobBody(71) });
  assert.equal(over.status, 429);
  assert.equal(over.body.code, "rate_limited");
  assert.equal(inflight(uid), 0, "tavan reddi kirayı bırakır");
  assert.equal(db.get(`rl:user-ai:${uid}:3600:${bucket}`), "120", "reddedilen istek sayaçta kalmaz");
  assert.equal(db.get(`rl:global:ai:3600:${bucket}`), "120");
  assert.equal(await redisGet(`job-url:${uid}:x`), null);

  const other = await invoke(extract, { uid: "I7-OTHER", body });
  assert.equal(other.status, 200);
  assert.equal(anthropicCalls().length, 3);
});

// ============ Preview bulgusu — kira yanıttan ÖNCE bırakılmalı ============
// Gerçek Preview'da (Vercel) /api/extract'ın yanıttan sonra çalışan release()'i
// çalışmadı; kira 330 sn TTL ile kaldı. Burada yanıtın yazıldığı anda kiranın
// sıfır olduğu doğrulanıyor.

test("entegrasyon 8: extract/suggest/recipe-jobs yanıtı yazıldığı anda kira zaten bırakılmış (başarı ve hata yolları)", async () => {
  const leaseAtResponse = async (handler, opts, pool = "heavy") => {
    let atResponse = null;
    const r = await invoke(handler, { ...opts, onRespond: () => (atResponse = zsetSize(`ai:inflight:${pool}:${opts.uid}`)) });
    return { r, atResponse };
  };
  const body = { link: "https://www.tiktok.com/@sef/video/1", caption: "1 su bardağı mercimek, 1 soğan", notes: "", language: "tr" };

  reset();
  let x = await leaseAtResponse(extract, { uid: "I8A", body });
  assert.equal(x.r.status, 200);
  assert.equal(x.atResponse, 0, "extract başarı: yanıt anında kira bırakılmış");

  reset(() => json(500, { error: { message: "boom" } }));
  x = await leaseAtResponse(extract, { uid: "I8B", body });
  assert.equal(x.r.status, 502);
  assert.equal(x.atResponse, 0, "extract sağlayıcı hatası: yanıt anında kira bırakılmış");

  reset(() => json(200, { content: [{ type: "text", text: '{"suggestions":[]}' }] }));
  x = await leaseAtResponse(suggest, { uid: "I8C", body: { items: ["yumurta", "domates"] } }, "suggest");
  assert.equal(x.r.status, 200, JSON.stringify(x.r.body));
  assert.equal(x.atResponse, 0, "suggest: yanıt anında kira bırakılmış");

  // recipe-jobs devretmeyen yol: aynı videonun ikinci paylaşımı.
  reset();
  db.set("user:I8D:profile", JSON.stringify({ isPlus: true, families: [] }));
  const first = await invoke(recipeJobs, { uid: "I8D", body: jobBody(80) });
  await waitForJob("I8D", first.body.jobId);
  x = await leaseAtResponse(recipeJobs, { uid: "I8D", body: jobBody(80, { requestId: "int-80-second" }) });
  assert.equal(x.r.body.duplicate, true);
  assert.equal(x.atResponse, 0, "recipe-jobs tekrar paylaşım: yanıt anında kira bırakılmış");

  // Guard reddi de (too_many_in_flight) yanıt anında yalnızca mevcut 5 kirayı gösterir.
  reset();
  for (let i = 0; i < 5; i++) await acquireSlot({ pool: "heavy", uid: "I8E", isAnonymous: false });
  x = await leaseAtResponse(extract, { uid: "I8E", body });
  assert.equal(x.r.body.code, "too_many_in_flight");
  assert.equal(x.atResponse, 5);
});
