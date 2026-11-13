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

// Sınır aşılırsa 429 fırlatır. Sıra (Grup 5 denetimi B4):
//  1) aynı-tarif beklemesi (SET NX EX) — reddedilirse HİÇBİR sayaç artmaz;
//  2) gönderenin kendi saatlik/günlük sayaçları — aşan istek de sayılır (dürtme
//     seli pencere sonuna kadar kapalı kalır), ama aile sayacına hiç dokunmaz;
//  3) aile saatlik sayacı — yalnızca 1 ve 2'yi geçen, gerçekten gönderilecek
//     istekte artar; aşılırsa geri alınır (DECR).
// Böylece tek bir üye reddedilen isteklerle ailenin diğer üyelerini kilitleyemez.
// 2 ya da 3'te reddedilen tarifin 10 dakikalık beklemesi bırakılır (gönderilmedi).
const pipelineOrUnavailable = async (commands) => {
  let results;
  try {
    results = await redisPipeline(commands);
  } catch (e) {
    throw Object.assign(new Error("Bildirim şu an gönderilemiyor. Biraz sonra tekrar dene."), { status: 503 });
  }
  if (results.some((r) => r instanceof Error)) throw Object.assign(new Error("Bildirim şu an gönderilemiyor."), { status: 503 });
  return results;
};

export async function assertNotifyAllowed({ uid, familyId, recipeId }, now = clock()) {
  const sec = Math.floor(now / 1000);
  const sameKey = `rl:notify:same:${hash(`${uid}|${familyId}|${recipeId}`)}`;
  const win = (key, seconds, limit) => {
    const bucket = Math.floor(sec / seconds);
    return { seconds, limit, bucket, full: `${key}:${seconds}:${bucket}` };
  };
  const senderWindows = [win(`rl:notify:u:${uid}`, 3600, NOTIFY_LIMITS.senderHourly), win(`rl:notify:u:${uid}`, 86400, NOTIFY_LIMITS.senderDaily)];
  const familyWindow = win(`rl:notify:f:${familyId}`, 3600, NOTIFY_LIMITS.familyHourly);
  const retryOf = (w) => Math.max(1, (w.bucket + 1) * w.seconds - sec);
  const releaseSame = () => redisPipeline([["DEL", sameKey]]).catch(() => {});

  const [same] = await pipelineOrUnavailable([["SET", sameKey, String(sec), "NX", "EX", String(NOTIFY_LIMITS.sameRecipeSeconds)]]);
  if (same == null) throw rateLimited(NOTIFY_LIMITS.sameRecipeSeconds);

  let senderResults;
  try {
    senderResults = await pipelineOrUnavailable(senderWindows.flatMap((w) => [["INCR", w.full], ["EXPIRE", w.full, String(w.seconds + 5)]]));
  } catch (e) {
    await releaseSame();
    throw e;
  }
  for (let i = 0; i < senderWindows.length; i++) {
    if (Number(senderResults[i * 2]) > senderWindows[i].limit) {
      await releaseSame();
      throw rateLimited(retryOf(senderWindows[i]));
    }
  }

  let familyResults;
  try {
    familyResults = await pipelineOrUnavailable([["INCR", familyWindow.full], ["EXPIRE", familyWindow.full, String(familyWindow.seconds + 5)]]);
  } catch (e) {
    await releaseSame();
    throw e;
  }
  if (Number(familyResults[0]) > familyWindow.limit) {
    await redisPipeline([["DECR", familyWindow.full], ["DEL", sameKey]]).catch(() => {});
    throw rateLimited(retryOf(familyWindow));
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
