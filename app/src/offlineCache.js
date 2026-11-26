// Çevrimdışı görüntüleme için cihazdaki tarif kopyası (saf modül; testte Map,
// uygulamada IndexedDB). Ayrıntı ve politika: docs/qr-ve-cevrimdisi.md.
//
// Kurallar:
//  - Yalnızca SUNUCUNUN ONAYLADIĞI veri yazılır (src/syncedBuckets.js onAccept:
//    başarılı okuma ya da kabul edilen yazım). Bekleyen/başarısız değişiklik,
//    boş "yüklenemedi" durumu ya da önbelleğin kendisi asla buraya yazılmaz.
//  - Önbellek yalnızca GÖSTERİM içindir: bucket deposuna (dataStore) hiç girmez,
//    bu yüzden üzerine yazım yapılamaz; sunucudaki tarifler onunla ezilemez.
//  - Hesap bazında ayrı anahtarlar (`u:<uid>:…`). Oturum değişince, çıkışta ve
//    hesap silinince başka hesabın kayıtları silinir (purgeExcept).
//  - Aile listeleri: yalnızca sunucunun son doğruladığı (üye + Plus) ailelerin
//    kopyası tutulur; aile listesi her başarılı yenilemede budanır (retainFamilies).
//  - Sürümü daha eski bir okuma, daha yeni kaydı ezmez.

export const OFFLINE_CACHE_VERSION = 1;
const PREFIX = "u:";
const metaKey = (uid) => `${PREFIX}${uid}:meta`;
const bucketKey = (uid, scope) => `${PREFIX}${uid}:recipes:${scope}`;
const uidOfKey = (key) => (key.startsWith(PREFIX) ? key.slice(PREFIX.length).split(":")[0] : null);

const isUid = (uid) => typeof uid === "string" && uid.length > 0 && uid.length <= 128 && !uid.includes(":");

// storage: { get(key), set(key, value), delete(key), keys() } — hepsi Promise.
export function createOfflineCache({ storage, now = () => Date.now() }) {
  // Aynı anahtara yazımlar sırayla (eski sürüm yeni kaydın üstüne binmesin).
  const chains = new Map();
  const serial = (key, fn) => {
    const prev = chains.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    const settled = next.catch(() => {});
    chains.set(key, settled);
    settled.then(() => {
      if (chains.get(key) === settled) chains.delete(key);
    });
    return next;
  };
  // Önbellek kolaylıktır: depolama hatası uygulamayı asla durdurmaz.
  const safe = (p, fallback) => Promise.resolve(p).catch(() => fallback);

  async function saveBucket(uid, scope, version, data) {
    if (!isUid(uid) || typeof scope !== "string" || !scope || !Array.isArray(data) || !Number.isSafeInteger(version)) return false;
    const key = bucketKey(uid, scope);
    return safe(
      serial(key, async () => {
        const current = await storage.get(key);
        if (current && Number.isSafeInteger(current.version) && current.version > version) return false;
        await storage.set(key, { v: OFFLINE_CACHE_VERSION, uid, scope, version, savedAt: now(), data });
        return true;
      }),
      false
    );
  }

  async function saveMeta(uid, patch) {
    if (!isUid(uid)) return false;
    const key = metaKey(uid);
    return safe(
      serial(key, async () => {
        const current = (await storage.get(key)) || {};
        const next = { ...current, ...patch, v: OFFLINE_CACHE_VERSION, uid, updatedAt: now() };
        if (Array.isArray(next.families)) {
          next.families = next.families
            .filter((f) => f && typeof f.id === "string")
            .map((f) => ({ id: f.id, name: typeof f.name === "string" ? f.name : "" }));
        }
        await storage.set(key, next);
        return true;
      }),
      false
    );
  }

  // { meta, buckets: { [scope]: { version, savedAt, data } } } | null
  async function read(uid) {
    if (!isUid(uid)) return null;
    const keys = await safe(storage.keys(), []);
    const own = keys.filter((k) => uidOfKey(k) === uid);
    if (!own.length) return null;
    const meta = (await safe(storage.get(metaKey(uid)), null)) || null;
    const buckets = {};
    for (const key of own) {
      if (key === metaKey(uid)) continue;
      const entry = await safe(storage.get(key), null);
      if (!entry || entry.uid !== uid || !Array.isArray(entry.data) || entry.v !== OFFLINE_CACHE_VERSION) continue;
      buckets[entry.scope] = { version: entry.version, savedAt: entry.savedAt, data: entry.data };
    }
    // Aile kopyası yalnızca son bilinen doğrulanmış aileler için gösterilir.
    const allowed = new Set(["personal", ...((meta && meta.families) || []).map((f) => f.id)]);
    for (const scope of Object.keys(buckets)) if (!allowed.has(scope)) delete buckets[scope];
    if (!Object.keys(buckets).length && !meta) return null;
    return { meta, buckets };
  }

  // Sunucunun doğruladığı aile listesi geldi: listede olmayan ailelerin kopyası silinir.
  async function retainFamilies(uid, families, extra = {}) {
    if (!isUid(uid) || !Array.isArray(families)) return;
    const ids = new Set(families.map((f) => f && f.id).filter(Boolean));
    await saveMeta(uid, { families, ...extra });
    const keys = await safe(storage.keys(), []);
    for (const key of keys) {
      if (uidOfKey(key) !== uid || key === metaKey(uid)) continue;
      const scope = key.slice(`${PREFIX}${uid}:recipes:`.length);
      if (scope && scope !== "personal" && !ids.has(scope)) await serial(key, () => safe(storage.delete(key)));
    }
  }

  // uid dışındaki herkesin kopyasını siler (uid null → hepsi).
  async function purgeExcept(uid) {
    const keys = await safe(storage.keys(), []);
    let removed = 0;
    for (const key of keys) {
      if (uid && uidOfKey(key) === uid) continue;
      await serial(key, () => safe(storage.delete(key)));
      removed++;
    }
    return removed;
  }

  async function purge(uid) {
    const keys = await safe(storage.keys(), []);
    for (const key of keys) if (uidOfKey(key) === uid) await serial(key, () => safe(storage.delete(key)));
  }

  return { saveBucket, saveMeta, read, retainFamilies, purgeExcept, purge };
}

export function createMemoryStorage(map = new Map()) {
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  return {
    map,
    async get(key) {
      return clone(map.get(key));
    },
    async set(key, value) {
      map.set(key, clone(value));
    },
    async delete(key) {
      map.delete(key);
    },
    async keys() {
      return [...map.keys()];
    },
  };
}

// Tarayıcı: IndexedDB (localStorage'ın ~5 MB sınırı tarif listesine yetmeyebilir).
// IndexedDB yoksa/açılamazsa her işlem sessizce başarısız olur (önbellek yok sayılır).
export function createIdbStorage({ name = "tarif-kutusu-offline", store = "kv", indexedDB = globalThis.indexedDB } = {}) {
  let dbPromise = null;
  const open = () => {
    if (!indexedDB) return Promise.reject(new Error("indexeddb_unavailable"));
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(name, 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(store)) req.result.createObjectStore(store);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error("indexeddb_blocked"));
      }).catch((e) => {
        dbPromise = null;
        throw e;
      });
    }
    return dbPromise;
  };
  const run = (mode, fn) =>
    open().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(store, mode);
          const req = fn(tx.objectStore(store));
          tx.oncomplete = () => resolve(req ? req.result : undefined);
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        })
    );
  return {
    get: (key) => run("readonly", (s) => s.get(key)),
    set: (key, value) => run("readwrite", (s) => s.put(value, key)),
    delete: (key) => run("readwrite", (s) => s.delete(key)),
    keys: () => run("readonly", (s) => s.getAllKeys()).then((k) => (k || []).map(String)),
  };
}

// Ağ/sunucu kaynaklı okuma hatası mı (önbellek gösterilebilir) yoksa yetki/
// hesap hatası mı (gösterilmez)? 4xx (401 silinmiş hesap, 403, 426) çevrimdışı sayılmaz.
export function isOfflineError(err) {
  if (!err) return false;
  if (err.code === "network_error" || err.code === "auth/network-request-failed") return true;
  if (Number.isInteger(err.status)) return err.status >= 500;
  return false;
}
