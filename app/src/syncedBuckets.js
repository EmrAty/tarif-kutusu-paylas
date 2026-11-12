// Sunucudaki sürümlü veri kovalarının (tarifler, alışveriş listesi, kiler;
// kişisel ya da aile) istemci tarafı. React'ten bağımsız saf JS: testler bunu
// gerçek api/data.js'e bağlayarak çalıştırıyor.
//
// Kurallar:
// 1. "Yüklenemedi" ile "boş" asla aynı şey değil. Her kova için durum:
//      idle -> loading -> ready | error
//    Okuma hatası (ağ, 5xx, oturum, bozuk JSON) hiçbir zaman boş liste olarak
//    yazılmaz. Daha önce yüklenmiş kovanın yenilemesi başarısız olursa son
//    bilinen doğru veri korunur, yalnızca `stale` işaretlenir.
// 2. Değişiklikler bütün liste olarak değil, NİYET olarak (updater fonksiyonu)
//    verilir. Updater sunucunun son bilinen hâline uygulanır ve okunan sürümle
//    birlikte gönderilir (karşılaştır-ve-yaz). Sunucu "çakışma" derse (başka
//    cihaz/aile üyesi/arka plan job'u önce yazmış) dönen güncel veriye aynı
//    niyet yeniden uygulanıp tekrar denenir — en fazla `maxAttempts` kez.
// 3. Hiç yüklenememiş kovada değişiklik yapılmaz: önce yükleme denenir, o da
//    başarısızsa işlem `not_loaded` hatasıyla reddedilir.
// 4. Aynı kovadaki değişiklikler sırayla gönderilir (kendi isteklerimiz
//    birbirleriyle çakışmasın). Ekranda gösterilen veri = sunucudan onaylı
//    veri + henüz bekleyen niyetler; başarısız olan niyet listeden çıkınca
//    görünüm kendiliğinden geri döner (yalnızca o değişiklik).

import { CLIENT_OUTDATED, clientOutdatedError, createUpdateGate, isClientOutdatedResponse } from "./updateRequired.js";

export const BUCKET_STATUS = { IDLE: "idle", LOADING: "loading", READY: "ready", ERROR: "error" };
export const VERSION_CONFLICT = "version_conflict";
export const NOT_LOADED = "not_loaded";
export const CONFLICT_EXHAUSTED = "conflict_exhausted";

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function storeError(code, message, cause) {
  const err = new Error(message);
  err.code = code;
  if (cause) err.cause = cause;
  return err;
}

function unreadable(bucket) {
  return storeError("bucket_unreadable", `${bucket} verisi okunamadı.`);
}

// Kova türüne göre varsayılan (kayıt yoksa) değer ve biçim kontrolü.
export function parseBucketValue(bucket, raw) {
  const isObjectBucket = bucket === "shopping-list";
  if (raw == null) return isObjectBucket ? {} : [];
  let value;
  try {
    value = JSON.parse(raw);
  } catch (e) {
    throw unreadable(bucket);
  }
  if (isObjectBucket ? !isPlainObject(value) : !Array.isArray(value)) throw unreadable(bucket);
  return value;
}

// Tarif listesinde yalnızca istemcinin eklediği gösterim alanları (_scope,
// _scopes) sunucuya gitmez.
export function serializeBucketValue(bucket, value) {
  if (bucket === "recipes" && Array.isArray(value)) {
    return JSON.stringify(value.map(({ _scope, _scopes, ...rest }) => rest));
  }
  return JSON.stringify(value);
}

/**
 * transport:
 *   get(bucket, scope)  -> { value: string|null, version: number }   (hata: throw)
 *   set(bucket, scope, value, baseVersion) -> { version: number }
 *       çakışmada err.code === "version_conflict" ve mümkünse
 *       err.current = { value, version } fırlatır.
 * normalize(bucket, data) -> data : okunan veriye uygulanan (ör. eski kategori
 *   adlarını çevirme) saf dönüşüm; bir sonraki yazımda sunucuya da gider.
 * updateGate: bkz. src/updateRequired.js. Sunucu istemciyi eski bulursa (426)
 *   kapı kapanır; o andan sonra hiçbir değişiklik sunucuya gönderilmez.
 */
export function createBucketStore({ transport, maxAttempts = 4, normalize, updateGate = createUpdateGate() } = {}) {
  let entries = new Map();
  let generation = 0;
  let state = {};
  const listeners = new Set();

  const keyOf = (bucket, scope) => `${bucket}|${scope}`;
  const prepare = (bucket, raw) => {
    const data = parseBucketValue(bucket, raw);
    return normalize ? normalize(bucket, data) : data;
  };

  function entryOf(bucket, scope) {
    const key = keyOf(bucket, scope);
    let entry = entries.get(key);
    if (!entry) {
      entry = {
        bucket,
        scope,
        status: BUCKET_STATUS.IDLE,
        stale: false,
        error: null,
        confirmed: null,
        version: null,
        pending: [],
        loadPromise: null,
        queue: Promise.resolve(),
      };
      entries.set(key, entry);
    }
    return entry;
  }

  function displayOf(entry) {
    if (entry.status !== BUCKET_STATUS.READY) return null;
    return entry.pending.reduce((acc, p) => {
      try {
        const next = p.updater(acc);
        return next === undefined ? acc : next;
      } catch (e) {
        return acc;
      }
    }, entry.confirmed);
  }

  function emit() {
    const next = {};
    for (const [key, e] of entries) {
      next[key] = {
        bucket: e.bucket,
        scope: e.scope,
        status: e.status,
        stale: e.stale,
        error: e.error,
        version: e.version,
        saving: e.pending.length > 0,
        data: displayOf(e),
      };
    }
    state = next;
    listeners.forEach((fn) => fn());
  }

  function accept(entry, data, version) {
    entry.confirmed = data;
    entry.version = version;
    entry.status = BUCKET_STATUS.READY;
    entry.stale = false;
    entry.error = null;
  }

  // force: hazır kovayı da sunucudan tazeler (yenileme). Hata fırlatmaz;
  // sonucu kovanın durumundan okunur.
  function load(bucket, scope, { force = false } = {}) {
    const entry = entryOf(bucket, scope);
    if (entry.loadPromise) return entry.loadPromise;
    if (!force && entry.status === BUCKET_STATUS.READY) return Promise.resolve(entry);
    const gen = generation;
    const hadData = entry.status === BUCKET_STATUS.READY;
    if (!hadData) {
      entry.status = BUCKET_STATUS.LOADING;
      entry.error = null;
      emit();
    }
    entry.loadPromise = (async () => {
      try {
        const res = await transport.get(bucket, scope);
        if (gen !== generation) return entry;
        if (!res || !Number.isSafeInteger(res.version) || res.version < 0) throw unreadable(bucket);
        const data = prepare(bucket, res.value);
        // Yanıt, bu arada kendi yazımımızla onaylanmış daha yeni bir sürümden
        // eskiyse yok sayılır (sürümler kova başına hep artar).
        if (!(hadData && entry.version != null && res.version < entry.version)) accept(entry, data, res.version);
      } catch (err) {
        if (err?.code === CLIENT_OUTDATED) updateGate.markRequired();
        if (gen !== generation) return entry;
        if (entry.status === BUCKET_STATUS.READY) {
          entry.stale = true; // son bilinen doğru veri korunur
          entry.error = err;
        } else {
          entry.status = BUCKET_STATUS.ERROR;
          entry.error = err;
          entry.confirmed = null;
          entry.version = null;
        }
      } finally {
        entry.loadPromise = null;
        if (gen === generation) emit();
      }
      return entry;
    })();
    return entry.loadPromise;
  }

  const ensureLoaded = (bucket, scope) => load(bucket, scope);
  const refresh = (bucket, scope) => load(bucket, scope, { force: true });

  // updater(current) -> yeni değer; undefined ya da aynı referans = değişiklik yok.
  // Updater saf olmalı: hem görünüm için hem her denemede yeniden çağrılır.
  function mutate(bucket, scope, updater) {
    // Güncelleme gerekiyorsa değişiklik hiç denenmez, görünümde de belirmez.
    if (updateGate.isRequired()) return Promise.reject(clientOutdatedError());
    const entry = entryOf(bucket, scope);
    const gen = generation;
    const item = { updater };
    entry.pending.push(item);
    emit();

    const run = async () => {
      if (gen !== generation) throw storeError("session_changed", "Oturum değişti.");
      if (entry.status !== BUCKET_STATUS.READY) {
        await load(bucket, scope);
        if (entry.status !== BUCKET_STATUS.READY) {
          throw storeError(NOT_LOADED, "Veriler yüklenemediği için değişiklik yapılamadı.", entry.error);
        }
      }
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (gen !== generation) throw storeError("session_changed", "Oturum değişti.");
        const base = entry.confirmed;
        const next = updater(base);
        if (next === undefined || next === base) return base;
        if (updateGate.isRequired()) throw clientOutdatedError();
        try {
          const res = await transport.set(bucket, scope, serializeBucketValue(bucket, next), entry.version);
          if (gen !== generation) throw storeError("session_changed", "Oturum değişti.");
          accept(entry, next, res.version);
          return next;
        } catch (err) {
          if (err?.code !== VERSION_CONFLICT) throw err;
          // Başkası önce yazdı: güncel veriyi al, niyeti ona yeniden uygula.
          let fresh = err.current;
          if (!fresh || !Number.isSafeInteger(fresh.version)) fresh = await transport.get(bucket, scope);
          if (gen !== generation) throw storeError("session_changed", "Oturum değişti.");
          accept(entry, prepare(bucket, fresh.value), fresh.version);
          emit();
        }
      }
      throw storeError(
        CONFLICT_EXHAUSTED,
        "Veriler aynı anda başka bir yerde değiştiği için kaydedilemedi. Lütfen tekrar dene."
      );
    };

    const result = entry.queue.then(run, run).catch((err) => {
      // Sunucu bu istemciyi eski buldu: uygulama genelinde güncelleme gerekli.
      if (err?.code === CLIENT_OUTDATED) updateGate.markRequired();
      // Yazım çakışma dışı bir nedenle başarısız olduysa (ör. yanıt yolda
      // kaybolduysa yazım sunucuda gerçekleşmiş olabilir) görünüm arka planda
      // sunucuyla yeniden eşitlenir. Hata yine çağırana iletilir.
      if (gen === generation && entry.status === BUCKET_STATUS.READY && err?.code !== "session_changed") {
        load(bucket, scope, { force: true });
      }
      throw err;
    });
    entry.queue = result.catch(() => {});
    return result.finally(() => {
      const i = entry.pending.indexOf(item);
      if (i >= 0) entry.pending.splice(i, 1);
      if (gen === generation) emit();
    });
  }

  function reset() {
    generation++;
    entries = new Map();
    emit();
  }

  // Bir kapsamın (ör. kilitlenen ailenin) tüm kovalarını bellekten atar.
  // Yoldaki yüklemeler kopmuş kayda yazar, görünüme dönmez.
  function dropScope(scope) {
    let changed = false;
    for (const [key, e] of entries) {
      if (e.scope === scope) {
        entries.delete(key);
        changed = true;
      }
    }
    if (changed) emit();
  }

  return {
    getState: () => state,
    get: (bucket, scope) => state[keyOf(bucket, scope)] || null,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    load,
    ensureLoaded,
    refresh,
    mutate,
    reset,
    dropScope,
  };
}

// /api/data istemcisi. request(method, { query, body }) -> { status, body }
// (uygulamada fetch + kimlik token'ı, testlerde doğrudan api/data.js).
// Her 2xx dışı yanıt hata olarak fırlatılır: okuma hatası boş veri değildir.
export function createDataTransport(request) {
  const scopeParams = (scope) => (scope === "personal" ? { scope: "personal" } : { scope: "family", familyId: scope });
  const httpError = (status, body) => {
    const err = new Error((body && body.error) || `İstek başarısız (${status}).`);
    err.status = status;
    if (body && body.code) err.code = body.code;
    if (isClientOutdatedResponse(status, body)) err.code = CLIENT_OUTDATED;
    return err;
  };
  return {
    async get(bucket, scope) {
      const { status, body } = await request("GET", { query: { bucket, ...scopeParams(scope) } });
      if (status !== 200 || !body || !Number.isSafeInteger(body.version)) throw httpError(status, body);
      return { value: body.value ?? null, version: body.version };
    },
    async set(bucket, scope, value, baseVersion) {
      const { status, body } = await request("POST", { body: { bucket, ...scopeParams(scope), value, baseVersion } });
      if (status === 409 && body && body.code === VERSION_CONFLICT) {
        const err = httpError(status, body);
        if (Number.isSafeInteger(body.version)) err.current = { value: body.value ?? null, version: body.version };
        throw err;
      }
      if (status !== 200 || !body || !Number.isSafeInteger(body.version)) throw httpError(status, body);
      return { version: body.version };
    },
  };
}
