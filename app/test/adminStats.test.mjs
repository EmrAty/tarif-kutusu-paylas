// GET /api/profile?admin=stats: yönetim paneli için toplu sayılar. Bellek içi Redis
// (fakeServices), dışarıya istek gitmez. Uç yalnızca ADMIN_STATS_KEY ile açılır
// ve yanıtta hiçbir kişisel tanımlayıcı (uid, aile id'si, tarif adı) bulunmaz.
import test from "node:test";
import assert from "node:assert/strict";
import { db, resetDb, invoke } from "./helpers/fakeServices.mjs";

const KEY = "test-admin-key-0123456789abcdef";
const { localDay, statsDayKey } = await import("../api/_lib/adminStats.js");
const { default: handler } = await import("../api/profile.js");

const NOW = Date.now();
const DAY = 86_400_000;
const today = localDay(NOW);

function seed() {
  resetDb();
  db.set("user:U1:profile", JSON.stringify({ isPlus: true, families: ["F1"] }));
  db.set("user:U2:profile", JSON.stringify({ isPlus: false, families: [] }));
  db.set("user:U1:recipes", JSON.stringify([
    { id: "r1", title: "Gizli Tarif Adı", createdAt: NOW - 1000 },
    { id: "r2", title: "x", createdAt: NOW - 3 * DAY },
    { id: "r3", title: "y", createdAt: NOW - 40 * DAY },
  ]));
  db.set("user:U1:recipes:version", "4");
  db.set("user:U2:recipes", JSON.stringify([{ id: "r4", title: "z", createdAt: NOW - 2000 }]));
  // Başka hesaba taşınmış (donmuş) misafir sayılmaz.
  db.set("user:G1:profile", JSON.stringify({ isPlus: false }));
  db.set("user:G1:recipes", JSON.stringify([{ id: "g1", createdAt: NOW }]));
  db.set("user:G1:mergedInto", "U2");
  db.set("family:F1:meta", JSON.stringify({ name: "Aile Adı Gizli", ownerUid: "U1" }));
  db.set("family:F1:recipes", JSON.stringify([{ id: "f1", createdAt: NOW - 500 }]));
  db.set("job:U1:j1", JSON.stringify({ id: "j1", status: "completed", createdAt: NOW - 5000, timings: { total: 14000, claude: 11000 }, transcriptMeta: null }));
  db.set("job:U1:j2", JSON.stringify({ id: "j2", status: "completed", createdAt: NOW - 4000, timings: { total: 22000, claude: 19000 }, transcriptMeta: { method: "subtitle" } }));
  db.set("job:U2:j3", JSON.stringify({ id: "j3", status: "failed", errorCode: "ai_unavailable", createdAt: NOW - 3000, timings: {}, transcriptMeta: { method: "audio" } }));
  db.set("job-req:U1:abc", "j1"); // job:* kalıbına girmemeli
  db.set(`rl:global:ai:86400:${Math.floor(NOW / DAY)}`, "9");
}

const auth = (k = KEY) => ({ method: "GET", authorization: `Bearer ${k}`, query: { admin: "stats" } });

test("anahtar tanımlı değilse 401 ve Redis'e gidilmez", async () => {
  seed();
  delete process.env.ADMIN_STATS_KEY;
  const out = await invoke(handler, auth());
  assert.equal(out.status, 401);
});

test("yanlış ya da eksik anahtar 401", async () => {
  seed();
  process.env.ADMIN_STATS_KEY = KEY;
  assert.equal((await invoke(handler, auth("yanlis-anahtar-0123456789abcd"))).status, 401);
  assert.equal((await invoke(handler, { method: "GET", authorization: "", query: { admin: "stats" } })).status, 401);
  // Firebase kullanıcı token'ı bu uca giremez.
  assert.equal((await invoke(handler, { method: "GET", uid: "U1", query: { admin: "stats" } })).status, 401);
});

test("admin parametresi olmayan istek normal profil ucudur", async () => {
  seed();
  process.env.ADMIN_STATS_KEY = KEY;
  const out = await invoke(handler, { method: "GET", uid: "U1" });
  assert.equal(out.status, 200);
  assert.equal(out.body.isPlus, true);
});

test("yalnızca GET", async () => {
  process.env.ADMIN_STATS_KEY = KEY;
  assert.equal((await invoke(handler, { ...auth(), method: "POST" })).status, 405);
});

test("toplamlar doğru ve yanıtta kişisel tanımlayıcı yok", async () => {
  seed();
  process.env.ADMIN_STATS_KEY = KEY;
  const out = await invoke(handler, auth());
  assert.equal(out.status, 200);
  const s = out.body;
  assert.equal(s.usage.users, 2);
  assert.equal(s.usage.plusUsers, 1);
  assert.equal(s.usage.families, 1);
  assert.equal(s.usage.personalRecipes, 4);
  assert.equal(s.usage.familyRecipes, 1);
  assert.equal(s.usage.recipes7d, 4); // r1, r2, r4, f1
  assert.equal(s.usage.activeUsers7d, 2);
  assert.equal(s.usage.aiCallsToday, 9);
  assert.equal(s.jobs7d.jobs, 3);
  assert.equal(s.jobs7d.ok, 2);
  assert.equal(s.jobs7d.failed, 1);
  assert.equal(s.jobs7d.aiUnavailable, 1);
  assert.equal(s.jobs7d.viaCaption, 1);
  assert.equal(s.jobs7d.viaSubtitle, 1);
  assert.equal(s.jobs7d.viaAudio, 1);
  assert.equal(s.jobs7d.successRate, 66.7);
  assert.equal(s.jobs7d.medianSeconds, 18);
  assert.equal(s.daily.length, 60);
  const last = s.daily.at(-1);
  assert.equal(last.date, today);
  assert.equal(last.activeUsers, 2);
  assert.equal(last.jobs, 3);
  assert.deepEqual([last.viaCaption, last.viaSubtitle, last.viaAudio], [1, 1, 1]);
  const text = JSON.stringify(s);
  for (const secret of ["U1", "U2", "G1", "F1", "Gizli", "j1", "abc"]) {
    assert.ok(!text.includes(secret), `yanıtta "${secret}" geçmemeli`);
  }
});

test("günlük özet kalıcı yazılır; job kaydı silinse de geçmiş kalır", async () => {
  seed();
  process.env.ADMIN_STATS_KEY = KEY;
  await invoke(handler, auth());
  const stored = JSON.parse(db.get(statsDayKey(today)));
  assert.equal(stored.jobs.jobs, 3);
  assert.equal(stored.aiCalls, 9);
  // Job kayıtları 7 günde siliniyor; son 6 gün dışındaki özet ezilmemeli.
  const old = localDay(NOW - 10 * DAY);
  db.set(statsDayKey(old), JSON.stringify({ jobs: { jobs: 5, ok: 5, failed: 0 }, aiCalls: 40, newRecipes: 2 }));
  for (const k of [...db.keys()]) if (k.startsWith("job:")) db.delete(k);
  const out = await invoke(handler, auth());
  const oldRow = out.body.daily.find((d) => d.date === old);
  assert.equal(oldRow.jobs, 5);
  assert.equal(oldRow.aiCalls, 40);
  // AI sayısı küçülmez (sayaç gün içinde sıfırlanmaz ama yarışa karşı max alınır).
  db.set(`rl:global:ai:86400:${Math.floor(NOW / DAY)}`, "3");
  const again = await invoke(handler, auth());
  assert.equal(again.body.daily.at(-1).aiCalls, 9);
});

test("Redis hatası 502 ve ayrıntı sızdırmaz", async () => {
  seed();
  process.env.ADMIN_STATS_KEY = KEY;
  const { setRedisDown } = await import("./helpers/fakeServices.mjs");
  setRedisDown(true);
  const out = await invoke(handler, auth());
  setRedisDown(false);
  assert.equal(out.status, 502);
  assert.deepEqual(Object.keys(out.body), ["error"]);
});
