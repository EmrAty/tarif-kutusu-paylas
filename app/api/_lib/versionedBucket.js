import { redisCommand, redisEval } from "./redis.js";

// Sürümlü veri kovaları (tarifler, alışveriş listesi, kiler; kişisel ve aile).
//
// Veri eskisi gibi kendi anahtarında düz JSON metni olarak duruyor
// (ör. `user:<uid>:recipes`); yanında üç yardımcı anahtar var:
//   <key>:version        tamsayı sayaç. Tembel geçiş: sayaç yoksa, veri varsa
//                        sürüm 1, veri de yoksa 0 sayılır. Böylece sürümsüz eski
//                        kayıtlar hiçbir taşıma yazımı olmadan "sürüm 1" okunur;
//                        ilk başarılı yazım sayacı 2 yapar. baseVersion 0 yalnızca
//                        HİÇ verisi olmayan kovayı oluşturabilir, mevcut veriyi
//                        asla ezemez.
//   <key>:backups        yazımdan önceki son BACKUP_RING_SIZE hâl (liste)
//   <key>:daily-backups  her günün ilk yazımından önceki hâl, son DAILY_BACKUP_DAYS
//                        gün (hash, alan = YYYY-MM-DD)
// Yedek kaydı biçimi: "<sürüm>|<epoch ms>|<eski JSON metni>".
//
// Her yazım "karşılaştır ve yaz"dır: yazan, okuduğu sürümü gönderir; sunucudaki
// sürüm hâlâ aynıysa yazılır ve sürüm 1 artar, değilse hiçbir şey yazılmaz.
// Karşılaştırma, yedek ve yazım tek bir Lua betiğinde (Upstash'te atomik)
// yapılıyor — arada başka bir yazım giremez, yedek de yeni bir yarış açmaz.

export const BACKUP_RING_SIZE = 5;
export const DAILY_BACKUP_DAYS = 7;
export const BACKUP_TTL_SECONDS = 8 * 24 * 3600;
export const SERVER_MUTATION_ATTEMPTS = 6;

export const versionKey = (key) => `${key}:version`;
export const backupRingKey = (key) => `${key}:backups`;
export const dailyBackupKey = (key) => `${key}:daily-backups`;

// Kova anahtarı silinirken (aile/hesap silme) birlikte silinmesi gerekenler.
export function bucketAuxKeys(key) {
  return [versionKey(key), backupRingKey(key), dailyBackupKey(key)];
}

// KEYS: 1 veri, 2 sürüm, 3 yedek halkası, 4 günlük yedek
// ARGV: 1 beklenen sürüm, 2 yeni değer, 3 şimdi (ms), 4 gün (YYYY-MM-DD),
//       5 halka boyu, 6 yedek TTL (sn), 7 tutulacak gün sayısı
// Dönüş: {1, yeni sürüm} ya da {0, mevcut sürüm} (çakışma; hiçbir şey yazılmadı)
// Lua 5.1 (Redis) ve 5.3 (testlerdeki fengari) ile uyumlu tutuldu.
export const COMPARE_AND_SET_SCRIPT = `
local stored = redis.call('GET', KEYS[2])
local previous = redis.call('GET', KEYS[1])
local current
if stored then
  current = tonumber(stored)
  if current == nil then
    return redis.error_reply('invalid bucket version')
  end
elseif previous then
  current = 1
else
  current = 0
end
if current ~= tonumber(ARGV[1]) then
  return {0, current}
end
if previous then
  local snapshot = tostring(current) .. '|' .. ARGV[3] .. '|' .. previous
  redis.call('LPUSH', KEYS[3], snapshot)
  redis.call('LTRIM', KEYS[3], 0, tonumber(ARGV[5]) - 1)
  redis.call('EXPIRE', KEYS[3], ARGV[6])
  redis.call('HSETNX', KEYS[4], ARGV[4], snapshot)
  local days = redis.call('HKEYS', KEYS[4])
  local keep = tonumber(ARGV[7])
  if #days > keep then
    table.sort(days)
    for i = 1, #days - keep do
      redis.call('HDEL', KEYS[4], days[i])
    end
  end
  redis.call('EXPIRE', KEYS[4], ARGV[6])
end
local nextVersion = current + 1
redis.call('SET', KEYS[1], ARGV[2])
redis.call('SET', KEYS[2], tostring(nextVersion))
return {1, nextVersion}
`;

function corruptError(message) {
  const err = new Error(message);
  err.status = 502;
  err.code = "bucket_unreadable";
  return err;
}

// Lua betiğiyle aynı kural: sayaç yoksa veri varsa 1, yoksa 0.
function parseVersion(raw, hasData) {
  if (raw == null) return hasData ? 1 : 0;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) throw corruptError("Veri sürümü okunamadı.");
  return n;
}

export function isValidBaseVersion(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

// Değer ve sürüm tek komutla (MGET, atomik) okunur: ikisi her zaman aynı ana ait.
// Okuma hatası fırlatır; "kayıt yok" yalnızca { raw: null } demektir.
export async function readBucket(key) {
  const result = await redisCommand(["MGET", key, versionKey(key)]);
  if (!Array.isArray(result) || result.length !== 2) throw corruptError("Veri okunamadı.");
  const [raw, version] = result;
  return { raw: raw ?? null, version: parseVersion(version, raw != null) };
}

// { ok: true, version: yeni } ya da { ok: false, version: sunucudaki }.
export async function compareAndSet(key, expectedVersion, raw, now = Date.now()) {
  if (!isValidBaseVersion(expectedVersion)) throw new Error("Geçersiz sürüm.");
  if (typeof raw !== "string") throw new Error("Geçersiz değer.");
  const day = new Date(now).toISOString().slice(0, 10);
  const result = await redisEval(
    COMPARE_AND_SET_SCRIPT,
    [key, versionKey(key), backupRingKey(key), dailyBackupKey(key)],
    [expectedVersion, raw, now, day, BACKUP_RING_SIZE, BACKUP_TTL_SECONDS, DAILY_BACKUP_DAYS]
  );
  if (!Array.isArray(result) || result.length !== 2) throw corruptError("Veri yazılamadı.");
  return { ok: Number(result[0]) === 1, version: Number(result[1]) };
}

export function versionConflictError() {
  const err = new Error("Veri aynı anda başka bir yerde değişti; kaydedilemedi. Lütfen tekrar dene.");
  err.status = 409;
  err.code = "version_conflict_exhausted";
  return err;
}

// Sunucu tarafı yazıcılar (ör. paylaşım job'u) için: güncel değeri okur,
// `mutate(current)` ile yeni değeri hesaplar, karşılaştır-ve-yaz ile yazar;
// arada başka biri yazdıysa güncel değeri yeniden okuyup niyeti tekrar uygular.
// `parse(raw)` bozuk veride hata fırlatmalı (boş varsayılmamalı). `mutate`
// undefined dönerse yazım yapılmaz. Hata durumunda istisna fırlatır.
export async function mutateBucket(key, { parse, mutate, serialize = JSON.stringify, maxAttempts = SERVER_MUTATION_ATTEMPTS }) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { raw, version } = await readBucket(key);
    const current = parse(raw);
    const next = mutate(current);
    if (next === undefined) return { value: current, version, changed: false };
    const result = await compareAndSet(key, version, serialize(next));
    if (result.ok) return { value: next, version: result.version, changed: true };
  }
  throw versionConflictError();
}

// Tarif/kiler listesi: kayıt yoksa boş liste; bozuk ya da dizi değilse hata.
export function parseListOrThrow(raw) {
  if (raw == null) return [];
  let value;
  try {
    value = JSON.parse(raw);
  } catch (e) {
    throw corruptError("Liste okunamadı.");
  }
  if (!Array.isArray(value)) throw corruptError("Liste okunamadı.");
  return value;
}

// Kurtarma için (yönetici/testler): yedekleri en yeniden eskiye döndürür.
export function parseBackupEntry(entry) {
  const first = entry.indexOf("|");
  const second = entry.indexOf("|", first + 1);
  if (first < 0 || second < 0) return null;
  return {
    version: Number(entry.slice(0, first)),
    savedAt: Number(entry.slice(first + 1, second)),
    raw: entry.slice(second + 1),
  };
}

export async function listBackups(key) {
  const [ring, daily] = await Promise.all([
    redisCommand(["LRANGE", backupRingKey(key), "0", "-1"]),
    redisCommand(["HGETALL", dailyBackupKey(key)]),
  ]);
  const dailyEntries = [];
  const flat = Array.isArray(daily) ? daily : [];
  for (let i = 0; i + 1 < flat.length; i += 2) dailyEntries.push({ day: flat[i], ...parseBackupEntry(flat[i + 1]) });
  dailyEntries.sort((a, b) => (a.day < b.day ? 1 : -1));
  return {
    recent: (Array.isArray(ring) ? ring : []).map(parseBackupEntry).filter(Boolean),
    daily: dailyEntries,
  };
}
