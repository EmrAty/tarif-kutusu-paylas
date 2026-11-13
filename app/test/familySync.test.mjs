// Grup 4 — aile durumunun canlı yenilenmesi (src/familySync.js).
// Saf JS; ağ yok. Sahte istek ve sahte zamanlayıcı ile.
import test from "node:test";
import assert from "node:assert/strict";
import { createFamilySync, splitFamilies, sameData, FAMILY_POLL_MS, FAMILY_POLL_OPEN_MS } from "../src/familySync.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeTimers() {
  let next = 1;
  const active = new Map();
  return {
    setInterval(fn, ms) {
      const id = next++;
      active.set(id, { fn, ms });
      return id;
    },
    clearInterval(id) {
      active.delete(id);
    },
    tick() {
      for (const { fn } of [...active.values()]) fn();
    },
    get count() {
      return active.size;
    },
    get intervals() {
      return [...active.values()].map((t) => t.ms);
    },
  };
}

// Her request çağrısı için ayrı bir deferred; testler sırayla çözer.
function harness({ visible = true } = {}) {
  const calls = [];
  const applied = [];
  const timers = fakeTimers();
  const state = { visible };
  const sync = createFamilySync({
    request: (name) => {
      const d = deferred();
      calls.push({ name, ...d });
      return d.promise;
    },
    apply: (split) => applied.push(split),
    isVisible: () => state.visible,
    timers,
  });
  return { sync, calls, applied, timers, state };
}

const fam = (id, extra = {}) => ({ id, name: id, membership: "verified", ownerUid: "a", inviteCode: "C1", members: [{ uid: "a", isOwner: true }], ...extra });
const flush = () => new Promise((r) => setImmediate(r));

test("aralıklar makul: ekran açıkken daha sık", () => {
  assert.ok(FAMILY_POLL_OPEN_MS < FAMILY_POLL_MS);
  assert.ok(FAMILY_POLL_OPEN_MS >= 5000 && FAMILY_POLL_MS <= 60000);
});

test("splitFamilies: tam / kilitli / doğrulanamayan ayrımı; eski sunucu yanıtı tam sayılır", () => {
  const s = splitFamilies({
    isPlus: true,
    families: [fam("v"), { id: "old", name: "old", members: [] }, fam("l", { membership: "locked" }), fam("u", { membership: "unverified" }), fam("d", { membership: "deleting" }), null, { name: "kimliksiz" }],
  });
  assert.equal(s.isPlus, true);
  assert.deepEqual(s.families.map((f) => f.id), ["v", "old"]);
  assert.deepEqual(s.locked.map((f) => f.id), ["l"]);
  assert.deepEqual(s.unverified.map((f) => f.id), ["u", "d"]);
});

test("sameData içerik karşılaştırır", () => {
  assert.equal(sameData([fam("a")], [fam("a")]), true);
  assert.equal(sameData([fam("a")], [fam("a", { ownerUid: "b" })]), false);
});

test("hesap yokken istek atılmaz", async () => {
  const h = harness();
  const r = await h.sync.load();
  assert.equal(r.status, "skipped");
  assert.equal(h.calls.length, 0);
});

test("başarılı yanıt uygulanır (üyelik, aile reisi, kod, Plus birlikte)", async () => {
  const h = harness();
  h.sync.setAccount("u1");
  const p = h.sync.load();
  h.calls[0].resolve({ isPlus: true, families: [fam("f1", { ownerUid: "b", inviteCode: "NEW" })] });
  assert.equal((await p).status, "applied");
  assert.equal(h.applied.length, 1);
  assert.equal(h.applied[0].families[0].ownerUid, "b");
  assert.equal(h.applied[0].families[0].inviteCode, "NEW");
  assert.equal(h.applied[0].isPlus, true);
});

test("geç gelen ESKİ yanıt yeni durumu geri almaz", async () => {
  const h = harness();
  h.sync.setAccount("u1");
  const older = h.sync.load();
  const newer = h.sync.load();
  // yeni yanıt önce gelir: üye çıkarılmış
  h.calls[1].resolve({ isPlus: true, families: [] });
  assert.equal((await newer).status, "applied");
  // eski yanıt sonra gelir: hâlâ üye görünüyor
  h.calls[0].resolve({ isPlus: true, families: [fam("f1")] });
  assert.equal((await older).status, "stale");
  assert.equal(h.applied.length, 1);
  assert.deepEqual(h.applied[0].families, []);
});

test("bağlantı hatası ve bozuk yanıt hiçbir şeyi değiştirmez (boş liste sayılmaz)", async () => {
  const h = harness();
  h.sync.setAccount("u1");
  const a = h.sync.load();
  h.calls[0].reject(new Error("network"));
  assert.equal((await a).status, "error");
  for (const bad of [null, "x", {}, { isPlus: true }, { families: "yok" }]) {
    const p = h.sync.load();
    h.calls.at(-1).resolve(bad);
    assert.equal((await p).status, "invalid");
  }
  assert.equal(h.applied.length, 0);
});

test("arka plan: görünmezken istek yok; aynı anda tek arka plan isteği", async () => {
  const h = harness({ visible: false });
  h.sync.setAccount("u1");
  assert.equal((await h.sync.load({ background: true })).reason, "hidden");
  assert.equal(h.calls.length, 0);
  h.state.visible = true;
  const p1 = h.sync.load({ background: true });
  const p2 = h.sync.load({ background: true });
  assert.equal(h.calls.length, 1);
  assert.equal(p1, p2);
  h.calls[0].resolve({ isPlus: false, families: [] });
  await p1;
  h.sync.load({ background: true });
  assert.equal(h.calls.length, 2);
});

test("kendi işlem sürerken arka plan yenilemesi yok; yoldaki eski yanıt işlemin sonucunu ezmez", async () => {
  const h = harness();
  h.sync.setAccount("u1");
  const bg = h.sync.load({ background: true }); // işlemden önce başladı
  const end = h.sync.beginChange();
  assert.equal((await h.sync.load({ background: true })).reason, "change_in_progress");
  end();
  const after = h.sync.load(); // işlem sonrası açık yenileme
  h.calls[1].resolve({ isPlus: true, families: [fam("f1", { ownerUid: "b" })] });
  assert.equal((await after).status, "applied");
  h.calls[0].resolve({ isPlus: true, families: [fam("f1", { ownerUid: "a" })] });
  assert.equal((await bg).status, "stale");
  assert.equal(h.applied.length, 1);
  assert.equal(h.applied[0].families[0].ownerUid, "b");
  end(); // ikinci çağrı sayaçları bozmaz
  h.sync.load({ background: true });
  assert.equal(h.calls.length, 3);
});

test("görünen ad yalnızca değiştiğinde ve ilk başarılı yüklemeye kadar gönderilir", async () => {
  const h = harness();
  h.sync.setAccount("u1");
  let p = h.sync.load({ name: "Emre" });
  assert.equal(h.calls[0].name, "Emre");
  h.calls[0].reject(new Error("x")); // senkron başarısız: tekrar gönderilmeli
  await p;
  p = h.sync.load({ name: "Emre" });
  assert.equal(h.calls[1].name, "Emre");
  h.calls[1].resolve({ isPlus: true, families: [] });
  await p;
  p = h.sync.load({ name: "Emre" });
  assert.equal(h.calls[2].name, "");
  h.calls[2].resolve({ isPlus: true, families: [] });
  await p;
  h.sync.load({ background: true });
  assert.equal(h.calls[3].name, "");
  h.calls[3].resolve({ isPlus: true, families: [] });
  await flush();
  h.sync.load({ name: "Emre A." });
  assert.equal(h.calls[4].name, "Emre A.");
});

test("hesap değişince: zamanlayıcı durur, önceki hesabın yanıtı uygulanmaz, ad yeniden gönderilir", async () => {
  const h = harness();
  h.sync.setAccount("u1");
  h.sync.setPolling(FAMILY_POLL_MS);
  assert.equal(h.timers.count, 1);
  const p = h.sync.load({ name: "Emre" });
  h.sync.setAccount("u2");
  assert.equal(h.timers.count, 0);
  h.calls[0].resolve({ isPlus: true, families: [fam("f1")] });
  assert.equal((await p).status, "stale");
  assert.equal(h.applied.length, 0);
  h.sync.load({ name: "Emre" });
  assert.equal(h.calls[1].name, "Emre");
  h.sync.setAccount(null);
  assert.equal((await h.sync.load()).status, "skipped");
  h.sync.setPolling(FAMILY_POLL_MS);
  assert.equal(h.timers.count, 0, "hesapsız zamanlayıcı kurulmaz");
});

test("zamanlayıcı: aralık değişince yeniden kurulur, aynı aralıkta sıfırlanmaz, 0 durdurur; tik arka plan yüklemesidir", async () => {
  const h = harness();
  h.sync.setAccount("u1");
  h.sync.setPolling(FAMILY_POLL_MS);
  h.sync.setPolling(FAMILY_POLL_MS);
  assert.deepEqual(h.timers.intervals, [FAMILY_POLL_MS]);
  h.sync.setPolling(FAMILY_POLL_OPEN_MS);
  assert.deepEqual(h.timers.intervals, [FAMILY_POLL_OPEN_MS]);
  h.timers.tick();
  h.timers.tick(); // ilk istek yoldayken ikinci tik yeni istek açmaz
  assert.equal(h.calls.length, 1);
  h.calls[0].resolve({ isPlus: true, families: [] });
  await flush();
  h.state.visible = false;
  h.timers.tick();
  assert.equal(h.calls.length, 1, "arka plandayken istek yok");
  h.sync.setPolling(0);
  assert.equal(h.timers.count, 0);
  h.sync.setPolling(FAMILY_POLL_MS);
  h.sync.stopPolling();
  assert.equal(h.timers.count, 0);
});

test("Plus kapanması / açılması: aile kilitli listeye geçer, Plus açılınca geri döner", async () => {
  const h = harness();
  h.sync.setAccount("u1");
  let p = h.sync.load();
  h.calls[0].resolve({ isPlus: false, families: [fam("f1", { membership: "locked", locked: true, inviteCode: null })] });
  await p;
  assert.equal(h.applied[0].isPlus, false);
  assert.deepEqual(h.applied[0].families, []);
  assert.deepEqual(h.applied[0].locked.map((f) => f.id), ["f1"]);
  p = h.sync.load();
  h.calls[1].resolve({ isPlus: true, families: [fam("f1")] });
  await p;
  assert.equal(h.applied[1].isPlus, true);
  assert.deepEqual(h.applied[1].families.map((f) => f.id), ["f1"]);
  assert.deepEqual(h.applied[1].locked, []);
});
