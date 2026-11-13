// "Canım çekti" aile bildirimi için kötüye kullanım koruması (Grup 5).
//
// Normal kullanım: bir kişi günde birkaç kez, farklı tarifler için bildirim atar.
// Sınırlar bunu hiç etkilemeyecek kadar geniş, art arda bildirim selini ise keser:
//  - aynı gönderen + aynı aile + aynı tarif: 10 dakika bekleme (çift dokunma, tekrar tekrar dürtme)
//  - gönderen başına (tüm aileler): saatte 10, günde 30
//  - aile başına (tüm üyeler): saatte 40
// Sayaçlar sabit pencereli (INCR + EXPIRE), aynı-tarif beklemesi SET NX EX; tek pipeline. Redis'e ulaşılamazsa
// bildirim GÖNDERİLMEZ (fail-closed): bu yol zaten aile üyeliğini Redis'ten
// doğruluyor, yani Redis yokken bildirim de yok.
import crypto from "node:crypto";
import { redisPipeline } from "./redis.js";

export const NOTIFY_LIMITS = {
  sameRecipeSeconds: 10 * 60,
  senderHourly: 10,
  senderDaily: 30,
  familyHourly: 40,
};

export const NOTIFY_RATE_LIMITED_CODE = "notify_rate_limited";

let clock = () => Date.now();
export function __setNotifyClockForTests(fn) {
  clock = fn || (() => Date.now());
}

const hash = (v) => crypto.createHash("sha256").update(String(v)).digest("hex").slice(0, 24);

function rateLimited(retryAfter) {
  return Object.assign(new Error("Çok sık bildirim gönderdin. Biraz sonra tekrar dene."), {
    status: 429,
    code: NOTIFY_RATE_LIMITED_CODE,
    retryAfter,
  });
}

// Sınır aşılırsa 429 fırlatır. Aşılan istek de sayılır (dürtme seli uzamasın diye
// pencere sonuna kadar kapalı kalır).
export async function assertNotifyAllowed({ uid, familyId, recipeId }, now = clock()) {
  const sec = Math.floor(now / 1000);
  // Aynı tarif için kesin 10 dakikalık bekleme (SET NX EX); diğerleri sabit pencere.
  const sameKey = `rl:notify:same:${hash(`${uid}|${familyId}|${recipeId}`)}`;
  const windows = [
    { key: `rl:notify:u:${uid}`, seconds: 3600, limit: NOTIFY_LIMITS.senderHourly },
    { key: `rl:notify:u:${uid}`, seconds: 86400, limit: NOTIFY_LIMITS.senderDaily },
    { key: `rl:notify:f:${familyId}`, seconds: 3600, limit: NOTIFY_LIMITS.familyHourly },
  ].map((w) => {
    const bucket = Math.floor(sec / w.seconds);
    return { ...w, bucket, full: `${w.key}:${w.seconds}:${bucket}` };
  });
  let results;
  try {
    results = await redisPipeline([
      ["SET", sameKey, String(sec), "NX", "EX", String(NOTIFY_LIMITS.sameRecipeSeconds)],
      ...windows.flatMap((w) => [["INCR", w.full], ["EXPIRE", w.full, String(w.seconds + 5)]]),
    ]);
  } catch (e) {
    throw Object.assign(new Error("Bildirim şu an gönderilemiyor. Biraz sonra tekrar dene."), { status: 503 });
  }
  if (results.some((r) => r instanceof Error)) throw Object.assign(new Error("Bildirim şu an gönderilemiyor."), { status: 503 });
  if (results[0] == null) throw rateLimited(NOTIFY_LIMITS.sameRecipeSeconds);
  for (let i = 0; i < windows.length; i++) {
    if (Number(results[1 + i * 2]) > windows[i].limit) {
      // Bu tarif aslında gönderilmedi: 10 dakikalık beklemesini bırak (sayaç
      // penceresi açılınca hemen gönderilebilsin).
      await redisPipeline([["DEL", sameKey]]).catch(() => {});
      throw rateLimited(Math.max(1, (windows[i].bucket + 1) * windows[i].seconds - sec));
    }
  }
}

// Bildirim metnine giren serbest metin: kontrol karakterleri/satır sonları tek
// boşluk, en çok `max` karakter (fazlası "…").
export function cleanNotificationText(raw, max) {
  const text = String(raw ?? "")
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join("").trimEnd()}…` : text;
}

export const NOTIFY_TITLE_MAX = 80;
export const NOTIFY_NAME_MAX = 40;
export const notificationTitle = (raw) => cleanNotificationText(raw, NOTIFY_TITLE_MAX);
export const notificationName = (raw) => cleanNotificationText(raw, NOTIFY_NAME_MAX);
