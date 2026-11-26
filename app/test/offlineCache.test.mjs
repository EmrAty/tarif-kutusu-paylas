// Çevrimdışı tarif kopyası: gerçek istemci depo (src/syncedBuckets.js) gerçek
// /api/data'ya bağlı; onAccept yalnızca sunucunun onayladığı veriyi önbelleğe yazar.
import test from "node:test";
import assert from "node:assert/strict";
import { invoke, resetDb, db } from "./helpers/fakeServices.mjs";

const { default: dataHandler } = await import("../api/data.js");
const { createBucketStore, createDataTransport, BUCKET_STATUS } = await import("../src/syncedBuckets.js");
const { createOfflineCache, createMemoryStorage, isOfflineError } = await import("../src/offlineCache.js");

function setup(uid = "A") {
  const storage = createMemoryStorage();
  const cache = createOfflineCache({ storage });
  let online = true;
  const request = async (method, { query, body }) => {
    if (!online) throw Object.assign(new TypeError("Failed to fetch"), { code: "network_error" });
    return invoke(dataHandler, { method, uid, query: query || {}, body });
  };
  const writes = [];
  const store = createBucketStore({
    transport: createDataTransport(request),
    onAccept: (bucket, scope, data, version) => {
      if (bucket === "recipes") writes.push(cache.saveBucket(uid, scope, version, data));
    },
  });
  return { storage, cache, store, setOnline: (v) => (online = v), flush: () => Promise.all(writes) };
}

const R1 = { id: "1700000000000-aaa111", title: "Menemen", ingredients: [{ name: "yumurta", amount: "3" }], instructions: ["Pişir."] };

test("yalnızca sunucunun onayladığı veri önbelleğe girer; bekleyen/başarısız değişiklik girmez", async () => {
  resetDb();
  db.set("user:A:profile", JSON.stringify({ isPlus: false, families: [] }));
  db.set("user:A:recipes", JSON.stringify([R1]));
  const { cache, store, setOnline, flush } = setup();
  await store.load("recipes", "personal");
  await flush();
  let snap = await cache.read("A");
  assert.deepEqual(snap.buckets.personal.data.map((r) => r.id), [R1.id]);
  const v1 = snap.buckets.personal.version;

  // Kabul edilen yazım → önbellek güncellenir.
  await store.mutate("recipes", "personal", (list) => [{ id: "1700000000001-bbb222", title: "Çorba" }, ...list]);
  await flush();
  snap = await cache.read("A");
  assert.equal(snap.buckets.personal.data.length, 2);
  assert.ok(snap.buckets.personal.version > v1);

  // Çevrimdışı yazım denemesi: başarısız, önbellek değişmez.
  setOnline(false);
  await assert.rejects(store.mutate("recipes", "personal", () => []));
  await flush();
  assert.equal((await cache.read("A")).buckets.personal.data.length, 2);
});

test("çevrimdışı açılış: depo 'error' kalır (boş liste değil), önbellek okunabilir, sunucu verisi ezilmez", async () => {
  resetDb();
  db.set("user:A:profile", JSON.stringify({ isPlus: false, families: [] }));
  db.set("user:A:recipes", JSON.stringify([R1]));
  const first = setup();
  await first.store.load("recipes", "personal");
  await first.flush();

  // "Uygulama yeniden başladı" (yeni depo, aynı cihaz depolaması), internet yok.
  const cache = createOfflineCache({ storage: first.storage });
  const offlineStore = createBucketStore({
    transport: createDataTransport(async () => {
      throw Object.assign(new TypeError("Failed to fetch"), { code: "network_error" });
    }),
  });
  await offlineStore.load("recipes", "personal");
  const st = offlineStore.get("recipes", "personal");
  assert.equal(st.status, BUCKET_STATUS.ERROR);
  assert.equal(st.data, null, "yüklenemeyen kova boş liste sayılmaz");
  assert.ok(isOfflineError(st.error));
  const snap = await cache.read("A");
  assert.equal(snap.buckets.personal.data[0].title, "Menemen");
  // Önbellek depoya girmediği için değişiklik yazılamaz; sunucudaki liste aynı kalır.
  await assert.rejects(offlineStore.mutate("recipes", "personal", () => []), (e) => e.code === "not_loaded");
  assert.equal(JSON.parse(db.get("user:A:recipes")).length, 1);
});

test("eski sürüm daha yeni kaydı ezmez", async () => {
  const cache = createOfflineCache({ storage: createMemoryStorage() });
  await cache.saveBucket("A", "personal", 5, [{ id: "x" }]);
  assert.equal(await cache.saveBucket("A", "personal", 4, []), false);
  assert.equal((await cache.read("A")).buckets.personal.data.length, 1);
});

test("hesaplar ayrı: başka hesabın kopyası görünmez; çıkış/hesap değişimi temizler", async () => {
  const storage = createMemoryStorage();
  const cache = createOfflineCache({ storage });
  await cache.saveBucket("A", "personal", 1, [{ id: "a" }]);
  await cache.saveBucket("B", "personal", 1, [{ id: "b" }]);
  assert.deepEqual((await cache.read("B")).buckets.personal.data, [{ id: "b" }]);
  assert.equal(await cache.read("C"), null);
  await cache.purgeExcept("B");
  assert.equal(await cache.read("A"), null);
  assert.ok(await cache.read("B"));
  await cache.purgeExcept(null);
  assert.equal(storage.map.size, 0);
  assert.equal(await cache.read("A:x"), null, "geçersiz uid");
});

test("aile kopyaları yalnızca son doğrulanan aileler için; üyelik bitince silinir", async () => {
  const storage = createMemoryStorage();
  const cache = createOfflineCache({ storage });
  await cache.retainFamilies("A", [{ id: "F1", name: "Ev" }, { id: "F2", name: "İş" }], { isPlus: true });
  await cache.saveBucket("A", "personal", 1, []);
  await cache.saveBucket("A", "F1", 1, [{ id: "f1" }]);
  await cache.saveBucket("A", "F2", 1, [{ id: "f2" }]);
  let snap = await cache.read("A");
  assert.deepEqual(Object.keys(snap.buckets).sort(), ["F1", "F2", "personal"]);
  assert.equal(snap.meta.isPlus, true);
  // Sunucu: F2'den çıkarıldı (ya da Plus kapandı → kilitli aile listede yok).
  await cache.retainFamilies("A", [{ id: "F1", name: "Ev" }], { isPlus: true });
  snap = await cache.read("A");
  assert.deepEqual(Object.keys(snap.buckets).sort(), ["F1", "personal"]);
  assert.ok(![...storage.map.keys()].some((k) => k.endsWith(":F2")));
  // Meta'da olmayan aile kovası (ör. yarışta yazılmış) gösterilmez.
  await cache.saveBucket("A", "F9", 1, [{ id: "f9" }]);
  assert.equal((await cache.read("A")).buckets.F9, undefined);
});

test("depolama hatası uygulamayı durdurmaz", async () => {
  const broken = { get: async () => { throw new Error("x"); }, set: async () => { throw new Error("x"); }, delete: async () => { throw new Error("x"); }, keys: async () => { throw new Error("x"); } };
  const cache = createOfflineCache({ storage: broken });
  assert.equal(await cache.saveBucket("A", "personal", 1, []), false);
  assert.equal(await cache.read("A"), null);
  await cache.purgeExcept(null);
});

test("çevrimdışı hata sınıflandırması: ağ ve 5xx evet, 401/403/426 hayır", () => {
  assert.ok(isOfflineError({ code: "network_error" }));
  assert.ok(isOfflineError({ code: "auth/network-request-failed" }));
  assert.ok(isOfflineError({ status: 503 }));
  assert.ok(!isOfflineError({ status: 401 }));
  assert.ok(!isOfflineError({ status: 403 }));
  assert.ok(!isOfflineError({ status: 426, code: "client_outdated" }));
  assert.ok(!isOfflineError(null));
});
