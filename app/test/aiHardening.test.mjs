// Grup 2 sertleştirme (Fable denetimi, 11 Kasım 2026): çeviri girdi bütçesi,
// sağlayıcı maliyet sayacının yalnızca sağlayıcıya giden işleri sayması, UID başına
// toplam AI tavanı, recipe-jobs kira sızıntısı ve IPv6 kanonik ayrıştırma.
// Anthropic hep taklit; gerçek çağrı/para yok.
import test from "node:test";
import assert from "node:assert/strict";
import { setRoutes, calls, invoke, resetDb, json, db, setRedisFault, zsetSize } from "./helpers/fakeServices.mjs";

process.env.RECIPE_JOB_NOTIFY_MIN_DELAY_MS = "0";

const { default: extract } = await import("../api/extract.js");
const { default: recipeJobs } = await import("../api/recipe-jobs.js");
const { default: suggest } = await import("../api/suggest-recipes.js");
const { default: translate, TRANSLATE_INPUT_LIMITS, TITLE_MAX_CHARS } = await import("../api/translate-recipe.js");
const { acquireSlot, reserveAiBudget, GuardError, __setClockForTests } = await import("../api/_lib/aiGuard.js");
const { userAiLimits, globalLimits, RATE_LIMITS, USER_SHARE_OF_GLOBAL } = await import("../api/_lib/abusePolicy.js");
const { checkInputBudget, textChars } = await import("../api/_lib/aiInputBudget.js");
const { translationPayload } = await import("../shared/recipeLocales.js");
const { isPrivateAddress, parseIPv6 } = await import("../api/_lib/socialUrl.js");

const FIXED_NOW = Date.UTC(2026, 10, 11, 9, 30, 20);
let now = FIXED_NOW;
__setClockForTests(() => now);

const ANTHROPIC = "https://api.anthropic.com/v1/messages";
const RECIPE = {
  title: "Mercimek Çorbası",
  servings: 4,
  servings_unit: "porsiyon",
  prep_time_minutes: 30,
  difficulty: "Kolay",
  ingredients: [{ name: "kırmızı mercimek", amount: "1 su bardağı" }],
  instructions: ["Haşla."],
  nutrition: { calories: 800, protein_g: 40, carbs_g: 120, fat_g: 10 },
  assumptions: "",
  portion: { dish_type: "corba", cooking_method: "haslama_sulu", items: [] },
};
const okClaude = () => json(200, { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(RECIPE) }], usage: { output_tokens: 10 } });

// Tek sahte Anthropic: çeviri isteğine kimlik çevirisi, öneriye boş liste, tarif çıkarmaya RECIPE.
function anthropic(url, init) {
  const body = JSON.parse(init.body);
  const system = typeof body.system === "string" ? body.system : "";
  if (system.startsWith("You translate recipe text")) {
    const text = body.messages[0].content[0].text.replace(/^<recipe>\n/, "").replace(/\n<\/recipe>$/, "");
    const data = JSON.parse(text);
    const out = data.titles ? { titles: data.titles.map((t) => `EN ${t}`) } : data;
    return json(200, { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(out) }], usage: { output_tokens: 5 } });
  }
  if (system.startsWith("Sen bir yemek önerisi")) return json(200, { content: [{ type: "text", text: '{"suggestions":[]}' }] });
  return okClaude();
}
const anthropicCalls = () => calls.filter((c) => c.url === ANTHROPIC);

function reset(route = anthropic) {
  resetDb();
  setRoutes([[ANTHROPIC, route]]);
  now = FIXED_NOW;
}

// Sayaç toplamı (ör. "rl:global:ai:3600:" ile başlayan anahtarlar).
function counter(prefix) {
  let total = 0;
  for (const [key, value] of db) if (key.startsWith(prefix) && typeof value === "string") total += Number(value);
  return total;
}
const globalHour = () => counter("rl:global:ai:3600:");
const anyCostCounter = () => [...db.keys()].some((k) => k.startsWith("rl:global:") || k.startsWith("rl:user-ai:"));
const inflight = (uid) => zsetSize(`ai:inflight:heavy:${uid}`);
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

const normalBody = { link: "https://www.tiktok.com/@sef/video/1", caption: "1 su bardağı mercimek, 1 soğan", notes: "", language: "tr" };

function storeRecipes(uid, recipes) {
  db.set(`user:${uid}:recipes`, JSON.stringify(recipes));
}
const trRecipe = (id, extra = {}) => ({
  id,
  title: `Tarif ${id}`,
  ingredients: [{ name: "un", amount: "2 su bardağı" }],
  instructions: ["Karıştır.", "180 derecede 30 dakika pişir."],
  assumptions: "",
  ...extra,
});
const translateOne = (uid, recipeId) => invoke(translate, { uid, body: { recipeId, scope: "personal", target: "en" } });

// ============ 1. Çeviri girdi bütçesi ============

test("çeviri: normal tarif çevrilir (Claude'a bir kez gidilir, sayaçlar bir artar)", async () => {
  reset();
  storeRecipes("TR1", [trRecipe("r1")]);
  const r = await translateOne("TR1", "r1");
  assert.equal(r.status, 200);
  assert.equal(r.body.cached, false);
  assert.equal(r.body.translation.title, "Tarif r1");
  assert.equal(anthropicCalls().length, 1);
  assert.equal(globalHour(), 1);
  // Aynı içerik ikinci kez önbellekten: hiçbir sayaç artmaz.
  assert.equal((await translateOne("TR1", "r1")).body.cached, true);
  assert.equal(anthropicCalls().length, 1);
  assert.equal(globalHour(), 1);
});

test("çeviri: aşırı büyük tarif Claude'dan, hız ve maliyet sayaçlarından ÖNCE 413 input_too_large", async () => {
  reset();
  const huge = trRecipe("big", { instructions: Array.from({ length: 20 }, () => "a".repeat(2_000)) });
  storeRecipes("ATK", [huge]);
  const r = await translateOne("ATK", "big");
  assert.equal(r.status, 413);
  assert.equal(r.body.code, "input_too_large");
  assert.equal(anthropicCalls().length, 0, "sağlayıcı taklidine hiç ulaşılmamalı");
  assert.equal(anyCostCounter(), false, "maliyet sayaçları tüketilmemeli");
  assert.equal(counter("rl:translate:"), 0, "uç hız sayacı da tüketilmemeli");
});

test("çeviri: tek alan ve dizi sınırları (başlık, adım sayısı) da Claude'dan önce uygulanır", async () => {
  reset();
  storeRecipes("ATK2", [
    trRecipe("longTitle", { title: "B".repeat(TITLE_MAX_CHARS + 1) }),
    trRecipe("manySteps", { instructions: Array.from({ length: TRANSLATE_INPUT_LIMITS.arrays.instructions + 1 }, (_, i) => `Adım ${i}`) }),
  ]);
  for (const id of ["longTitle", "manySteps"]) {
    const r = await translateOne("ATK2", id);
    assert.equal(r.status, 413, id);
    assert.equal(r.body.code, "input_too_large", id);
  }
  assert.equal(anthropicCalls().length, 0);
  assert.equal(anyCostCounter(), false);
});

test("çeviri: tam sınırda geçer, bir karakter fazlası reddedilir", async () => {
  const atLimit = (extraChar) => {
    const base = trRecipe("edge", { title: "T".repeat(TITLE_MAX_CHARS), instructions: [] });
    const used = textChars(translationPayload(base, "en"));
    return { ...base, instructions: ["x".repeat(TRANSLATE_INPUT_LIMITS.maxTotalChars - used + extraChar)] };
  };
  reset();
  const ok = atLimit(0);
  assert.equal(textChars(translationPayload(ok, "en")), TRANSLATE_INPUT_LIMITS.maxTotalChars);
  storeRecipes("EDGE", [ok]);
  assert.equal((await translateOne("EDGE", "edge")).status, 200);

  reset();
  storeRecipes("EDGE", [atLimit(1)]);
  const over = await translateOne("EDGE", "edge");
  assert.equal(over.status, 413);
  assert.equal(anthropicCalls().length, 0);
});

test("çeviri (başlık listesi): aşırı uzun başlık Claude'a hiç gönderilmez, normal başlıklar çevrilir", async () => {
  reset();
  const giant = "Ç".repeat(5_000);
  storeRecipes("TTL", [trRecipe("a", { title: giant }), trRecipe("b", { title: "Menemen" })]);
  const r = await invoke(translate, { uid: "TTL", body: { mode: "titles", target: "en" } });
  assert.equal(r.status, 200);
  assert.equal(r.body.titles.Menemen, "EN Menemen");
  assert.equal(r.body.titles[giant], undefined);
  assert.equal(r.body.skipped, 1);
  const sent = JSON.parse(anthropicCalls()[0].init.body).messages[0].content[0].text;
  assert.ok(!sent.includes(giant.slice(0, 400)), "dev başlık isteğe girmemeli");

  // Yalnızca dev başlık varsa Claude'a hiç gidilmez, sayaç tüketilmez.
  reset();
  storeRecipes("TTL2", [trRecipe("a", { title: giant })]);
  const only = await invoke(translate, { uid: "TTL2", body: { mode: "titles", target: "en" } });
  assert.equal(only.status, 200);
  assert.equal(anthropicCalls().length, 0);
  assert.equal(anyCostCounter(), false);
});

test("checkInputBudget: genel yardımcı alan/dizi/toplam sınırlarını ayrı raporlar", () => {
  const limits = { maxTotalChars: 10, fields: { title: 4 }, arrays: { items: 2 } };
  assert.equal(checkInputBudget({ title: "abcd", items: ["a", "b"] }, limits), null);
  assert.equal(checkInputBudget({ title: "abcde" }, limits).reason, "field");
  assert.equal(checkInputBudget({ items: ["a", "b", "c"] }, limits).reason, "items");
  assert.equal(checkInputBudget({ title: "ab", items: ["abcd", "abcde"] }, limits).reason, "total");
  assert.equal(textChars({ a: ["xy", { b: "z" }], n: 12345 }), 3);
});

// ============ 2. Maliyet sayacı yalnızca sağlayıcıya giden işleri sayar ============

test("maliyet sayacı: eşzamanlılık reddi global sayacı artırmaz", async () => {
  const pending = [];
  reset(() => new Promise((resolve) => pending.push(() => resolve(okClaude()))));
  const running = [];
  for (let i = 0; i < 5; i++) running.push(invoke(extract, { uid: "PAR", body: normalBody }));
  await settle(50);
  assert.equal(globalHour(), 5);
  const sixth = await invoke(extract, { uid: "PAR", body: normalBody });
  assert.equal(sixth.body.code, "too_many_in_flight");
  assert.equal(globalHour(), 5, "AI'a gitmeyen istek sayılmamalı");
  assert.equal(counter("rl:user-ai:PAR:3600:"), 5);
  pending.splice(0).forEach((done) => done());
  await Promise.all(running);
});

test("maliyet sayacı: doğrulama, eski istemci, giriş ve hız sınırı redleri sayılmaz", async () => {
  reset();
  await invoke(extract, { body: { link: "x" } }); // missing_input
  await invoke(extract, { body: { system: "x", messages: [] } }); // client_update_required
  await invoke(extract, { body: { ...normalBody, images: [{ mediaType: "image/png", data: "<script>" }] } }); // image_invalid
  await invoke(extract, { token: null, body: normalBody }); // 401
  await invoke(suggest, { body: { items: [] } }); // 400
  assert.equal(anyCostCounter(), false);

  for (let i = 0; i < 20; i++) await invoke(extract, { uid: "BURST", body: normalBody });
  assert.equal(globalHour(), RATE_LIMITS.extract[0].user, "yalnızca Claude'a giden istekler sayılmalı");
  assert.equal(anthropicCalls().length, RATE_LIMITS.extract[0].user);
});

test("maliyet sayacı: gerçek sağlayıcı isteği sayılır; aynı videonun tekrar paylaşımı sayılmaz", async () => {
  reset();
  assert.equal((await invoke(extract, { uid: "ONE", body: normalBody })).status, 200);
  assert.equal(globalHour(), 1);

  db.set("profile:SHARE", JSON.stringify({ isPlus: true, families: [] }));
  const body = (requestId) => ({
    requestId,
    sourceUrl: "https://www.instagram.com/p/SAME/",
    caption: "1 kg tavuk, 2 yemek kaşığı salça, 1 su bardağı su ile fırında pişirilir.",
    category: "Kahvaltı",
  });
  const first = await invoke(recipeJobs, { uid: "SHARE", body: body("req-first-1") });
  assert.equal(first.body.duplicate, false);
  const again = await invoke(recipeJobs, { uid: "SHARE", body: body("req-second-2") });
  assert.equal(again.body.duplicate, true);
  assert.equal(globalHour(), 2, "tekrar paylaşım yeni iş açmadığı için sayılmamalı");
  await settle();
});

test("maliyet sayacı: global tavan reddi de sayaçta kalmaz (geri alınır)", async () => {
  reset();
  process.env.AI_GLOBAL_HOURLY_LIMIT = "3";
  try {
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await invoke(extract, { uid: `G${i}`, body: normalBody })).status);
    assert.deepEqual(statuses, [200, 200, 200, 503, 503, 503]);
    assert.equal(globalHour(), 3);
    assert.equal(anthropicCalls().length, 3);
  } finally {
    delete process.env.AI_GLOBAL_HOURLY_LIMIT;
  }
});

// ============ 3. UID başına toplam AI tavanı ============

// Bir saat boyunca her 20 saniyede bir AI çağrısı, uçlar sırayla (extract → suggest → translate).
// Uç bazlı dakika/saat sınırlarının hiçbirine takılmaz; yalnızca toplam tavan devreye girebilir.
async function mixedUsage(uid, count) {
  storeRecipes(uid, Array.from({ length: count }, (_, i) => trRecipe(`m${i}`)));
  const hourStart = Date.UTC(2026, 10, 11, 14, 0, 0);
  const statuses = [];
  for (let i = 0; i < count; i++) {
    now = hourStart + i * 20_000;
    const kind = i % 3;
    const r =
      kind === 0
        ? await invoke(extract, { uid, body: normalBody })
        : kind === 1
          ? await invoke(suggest, { uid, body: { items: ["yumurta", `domates ${i}`] } })
          : await translateOne(uid, `m${i}`);
    statuses.push(r.status === 200 ? 200 : r.body.code);
  }
  return statuses;
}

test("UID toplam tavanı: değerler global tavanın küçük bir kısmı; uç sınırlarının toplamından düşük", () => {
  const user = userAiLimits(false);
  const anon = userAiLimits(true);
  const global = globalLimits();
  assert.ok(user.hourly <= global.hourly * USER_SHARE_OF_GLOBAL, "tek hesap global saatlik tavanın en çok %20'si");
  assert.ok(user.daily <= global.daily * USER_SHARE_OF_GLOBAL);
  assert.ok(anon.hourly < user.hourly && anon.daily < user.daily);
  const endpointHourlySum = ["extract", "recipeJob", "suggest", "translate"].reduce((n, a) => n + RATE_LIMITS[a][1].user, 0);
  assert.ok(endpointHourlySum > user.hourly, "toplam tavan uç sınırlarının toplamını gerçekten daraltmalı");
});

test("UID toplam tavanı: normal yoğun kullanım (saatte 90 karışık AI çağrısı) hiç engellenmez", async () => {
  reset();
  const statuses = await mixedUsage("POWER", 90);
  assert.ok(statuses.every((s) => s === 200), JSON.stringify(statuses.filter((s) => s !== 200)));
});

test("UID toplam tavanı: farklı uçlardan yüksek kullanım tek hesapta tavana takılır; yeni UID etkilenmez", async () => {
  reset();
  const limit = userAiLimits(false).hourly;
  const statuses = await mixedUsage("HOG", limit + 15);
  assert.equal(statuses.filter((s) => s === 200).length, limit);
  assert.ok(statuses.slice(limit).every((s) => s === "rate_limited"), "tavan sonrası anlaşılır 429");
  assert.equal(globalHour(), limit, "reddedilenler global sayaçta kalmamalı");
  assert.ok(globalHour() <= globalLimits().hourly * USER_SHARE_OF_GLOBAL, "tek hesap global kapasitenin çoğunu tüketemez");
  // Başka bir hesap aynı saatte normal çalışır.
  assert.equal((await invoke(extract, { uid: "FRESH", body: normalBody })).status, 200);
});

test("UID toplam tavanı: env ile ayarlanabilir; global tavan düşürülürse kullanıcı tavanı da düşer", async () => {
  process.env.AI_USER_HOURLY_LIMIT = "2";
  try {
    reset();
    await reserveAiBudget({ uid: "ENV", isAnonymous: false });
    await reserveAiBudget({ uid: "ENV", isAnonymous: false });
    await assert.rejects(reserveAiBudget({ uid: "ENV", isAnonymous: false }), (e) => e instanceof GuardError && e.code === "rate_limited");
  } finally {
    delete process.env.AI_USER_HOURLY_LIMIT;
  }
  process.env.AI_GLOBAL_HOURLY_LIMIT = "50";
  try {
    assert.equal(userAiLimits(false).hourly, 10);
  } finally {
    delete process.env.AI_GLOBAL_HOURLY_LIMIT;
  }
});

// ============ 4. recipe-jobs eşzamanlılık kirası ============

const jobBody = (i) => ({
  requestId: `lease-${i}-abcdef`,
  sourceUrl: `https://www.instagram.com/p/LEASE${i}/`,
  caption: "1 kg tavuk, 2 yemek kaşığı salça, 1 su bardağı su ile fırında pişirilir.",
  category: "Kahvaltı",
});

test("kira: kira alındıktan sonra Redis hatası (URL kilidi) → kira bırakılır", async () => {
  reset();
  db.set("profile:LK", JSON.stringify({ isPlus: true, families: [] }));
  setRedisFault((c) => c[0] === "SET" && c.includes("NX"));
  const r = await invoke(recipeJobs, { uid: "LK", body: jobBody(1) });
  assert.equal(r.status, 502);
  setRedisFault(null);
  assert.equal(inflight("LK"), 0);
  assert.equal(anthropicCalls().length, 0);
});

test("kira: job kaydı yazılırken Redis hatası → kira bırakılır", async () => {
  reset();
  db.set("profile:LK2", JSON.stringify({ isPlus: true, families: [] }));
  setRedisFault((c) => c[0] === "SET" && String(c[1]).startsWith("job:"));
  const r = await invoke(recipeJobs, { uid: "LK2", body: jobBody(2) });
  assert.ok(r.status >= 500);
  setRedisFault(null);
  assert.equal(inflight("LK2"), 0);
});

test("kira: sağlayıcı hatası → job failed, kira bırakılır", async () => {
  reset(() => json(500, { error: { message: "boom" } }));
  db.set("profile:LK3", JSON.stringify({ isPlus: true, families: [] }));
  const r = await invoke(recipeJobs, { uid: "LK3", body: jobBody(3) });
  assert.equal(r.status, 200);
  await settle();
  assert.equal(JSON.parse(db.get(`job:LK3:${r.body.jobId}`)).status, "failed");
  assert.equal(inflight("LK3"), 0);
});

test("kira: başarılı job → kira bırakılır", async () => {
  reset();
  db.set("profile:LK4", JSON.stringify({ isPlus: true, families: [] }));
  const r = await invoke(recipeJobs, { uid: "LK4", body: jobBody(4) });
  await settle();
  assert.equal(JSON.parse(db.get(`job:LK4:${r.body.jobId}`)).status, "completed");
  assert.equal(inflight("LK4"), 0);
});

test("kira: alınamayan kira başka kiraları bırakmaz; iki kez release güvenli", async () => {
  reset();
  const releases = [];
  for (let i = 0; i < 5; i++) releases.push(await acquireSlot({ pool: "heavy", uid: "LK5", isAnonymous: false }));
  await assert.rejects(acquireSlot({ pool: "heavy", uid: "LK5", isAnonymous: false }), (e) => e.code === "too_many_in_flight");
  assert.equal(inflight("LK5"), 5, "reddedilen istek mevcut kiraları silmemeli");
  await releases[0]();
  await releases[0]();
  assert.equal(inflight("LK5"), 4, "çift release yalnızca kendi kirasını bir kez bırakır");

  // recipe-jobs yolunda da: 6. job reddedilir, çalışan 5 kira yerinde kalır.
  const pending = [];
  reset(() => new Promise((resolve) => pending.push(() => resolve(okClaude()))));
  db.set("profile:LK6", JSON.stringify({ isPlus: true, families: [] }));
  for (let i = 0; i < 5; i++) assert.equal((await invoke(recipeJobs, { uid: "LK6", body: jobBody(10 + i) })).status, 200);
  await settle(50);
  const sixth = await invoke(recipeJobs, { uid: "LK6", body: jobBody(20) });
  assert.equal(sixth.body.code, "too_many_in_flight");
  assert.equal(inflight("LK6"), 5);
  pending.splice(0).forEach((done) => done());
  await settle();
  assert.equal(inflight("LK6"), 0);
});

// ============ 5. IPv6 kanonik ayrıştırma ============

test("IPv6: loopback her yazımda özel (kanonik, açık yazım, sıfır dolgulu)", () => {
  for (const ip of ["::1", "0:0:0:0:0:0:0:1", "0000:0000:0000:0000:0000:0000:0000:0001", "::0:1"]) assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ["::", "0:0:0:0:0:0:0:0"]) assert.equal(isPrivateAddress(ip), true, ip);
  assert.deepEqual(parseIPv6("0:0:0:0:0:0:0:1"), parseIPv6("::1"));
});

test("IPv6: IPv4-mapped/compatible/6to4 içindeki özel IPv4 yakalanır, genel IPv4 geçer", () => {
  for (const ip of ["::ffff:7f00:1", "::ffff:127.0.0.1", "::ffff:a00:5", "::ffff:10.0.0.5", "::ffff:c0a8:101", "::ffff:169.254.169.254", "::127.0.0.1", "2002:7f00:1::1", "0:0:0:0:0:ffff:7f00:1"]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ["::ffff:8.8.8.8", "::ffff:808:808", "2002:808:808::1"]) assert.equal(isPrivateAddress(ip), false, ip);
});

test("IPv6: ULA, link-local, multicast ve bölge kimlikli adresler özel", () => {
  for (const ip of ["fc00::1", "fd12:3456::1", "FD00::ABCD", "fe80::1", "fe80::1%eth0", "febf::1", "fec0::1", "ff02::1", "2001:db8::1", "64:ff9b::a00:1"]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
});

test("IPv6: gerçek genel adresler yanlışlıkla özel sayılmaz", () => {
  for (const ip of ["2a03:2880:f12f:83:face:b00c:0:25de", "2606:4700:4700::1111", "2001:4860:4860::8888", "2620:0:2d0:200::7", "fe7f::1", "fbff::1"]) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test("IPv6: geçersiz biçimler ayrıştırılmaz (güvenli tarafta kalır)", () => {
  for (const ip of ["1::2::3", "::1:2:3:4:5:6:7:8", "12345::1", "::ffff:999.0.0.1"]) assert.equal(parseIPv6(ip), null, ip);
});
