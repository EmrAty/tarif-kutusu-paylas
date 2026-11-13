// Misafir (anonim) hesabın verisini, kullanıcının geçtiği mevcut hesaba taşır.
//
// Grup 5 ilk sürümü misafir ID token'ını yalnızca istemci state'inde tutuyordu:
// hesaba geçtikten sonra taşıma isteği başarısız olur ve uygulama kapanırsa ya da
// 1 saatlik token dolarsa misafirin verisi erişilemez anonim uid altında kalıyordu.
// Şimdi (denetim B1/B2) taşıma DAYANIKLI ve sunucu tarafında kayıtlı:
//
//  1. Bilet (misafir oturumuyla, hesaba geçmeden ÖNCE): POST /api/account
//     {action:"createGuestMergeTicket"} rastgele bir gizli değer döndürür. Sunucuda
//     yalnızca SHA-256 özeti durur (guest-merge:ticket:<özet>). Taşıma bitene kadar
//     TTL YOK — süre dolumu veriyi asla erişilemez bırakmaz. Misafir başına tek
//     geçerli bilet (yenisi eskisinin kaydını siler); kullanılmayan bilet zararsız.
//  2. Talep (hedef hesapla, ilk kez): {action:"claimGuestMergeTicket", ticket}.
//     Önce hedefin dizinine (user:<hedef>:guestMerges) "bekliyor" kaydı yazılır,
//     sonra misafirin durum kaydı (guest-merge:state:<misafir>) atomik olarak bu
//     hedefe bağlanır. Bir bilet/misafir yalnızca TEK hedefe bağlanabilir. Bağlanınca
//     misafir hesabı dondurulur (deleted-account işareti, TTL'siz): misafirin başka
//     cihazda açık oturumu artık yazamaz, taşınan veri sonradan değişmez.
//  3. Devam: bundan sonra cihazdaki bilete gerek yoktur. Hedef hesap HERHANGİ bir
//     cihazda açılınca {action:"resumeGuestMerges"} dizindeki yarım taşımaları bitirir.
//  4. Adımlar (her biri tekrar çalıştırılabilir; durum kaydında işaretli):
//     tarifler → kiler → alışveriş listesi → aile üyelikleri → temizlik. Süreç
//     herhangi bir yerde ölürse sonraki çağrı kaldığı yerden devam eder, kopya
//     üretmez (tarif id'ye göre, kiler metne göre tekilleştirilir).
//  5. Temizlik (son adım): misafirin Redis verisi ve anonim Firebase kullanıcısı
//     silinir (hesap silme yolu). Bilet kaydı 30 gün "tamamlandı" olarak kalır
//     (aynı hedefin tekrar talebi sonucu görür), dizin kaydı "done" olur.
//
// Eski yol ({action:"mergeGuest", guestToken}) geriye uyum için aynı motoru
// kullanır (bilet olmadan bağlar).
//
// Kurallar:
//  - tarifler: hedefte olmayan id'ler eklenir (link/boyut denetimiyle; geçersiz
//    kayıt atlanır ve sayılır). Aynı id farklı içerikle varsa misafirinki yeni bir
//    id ile eklenir (hiçbiri kaybolmaz). Free sınırı UYGULANMAZ (ürün kararı:
//    sınırın üstü kilitli görünür).
//  - kiler: hedefte olmayan öğeler eklenir; alışveriş listesi: hedefte boşsa
//    kopyalanır, doluysa dokunulmaz (iki listeyi birleştirmek öğeleri bozabilir).
//  - kova tavanları (bucketLimits.js): taşıma, kullanıcının kendi verisi olduğu için
//    tavanın 2 katına kadar büyütebilir; bunu da aşarsa taşıma "blocked" olur ve
//    misafir verisi SİLİNMEZ (yer açılınca devam eder).
//  - aile: misafirin üyeliği ve sahipliği hedefe devredilir (bkz. transferFamily).
//  - kötüye kullanım: hedef hesap başına 30 günde en çok GUEST_MERGE_LIMIT taşıma
//    bağlanır (ürün kararı bekliyor). Sınırda yeni bilet bağlanmaz; misafir verisi
//    silinmez, bilet geçerli kalır, 429 guest_merge_limit döner.
import crypto from "node:crypto";
import { redisGet, redisSet, redisSetNX, redisDel, redisCommand } from "./redis.js";
import { mutateBucket, readBucket, parseListOrThrow, bucketAuxKeys } from "./versionedBucket.js";
import { checkRecipeList } from "./recipeInput.js";
import { BUCKET_LIMITS, byteSize } from "./bucketLimits.js";
import { getProfile, updateProfile, MAX_FAMILIES } from "./profile.js";
import {
  readFamilyState,
  isFamilyDeleting,
  updateMembers,
  updateMeta,
  removeMemberFromFamily,
  dropFamilyFromProfile,
  ensureOwner,
  leaveFamily,
  leaveAsLastMember,
  undoJoinIfFamilyGone,
} from "./families.js";
import { deleteAccount, isAccountDeleted, accountDeletedError, deletedMarkerKey } from "./accountDeletion.js";

export const GUEST_MERGE_LIMIT = 3;
// Sınırdayken bağlanıp sıraya alınan (ertelenmiş) taşımaların hedef başına üst sınırı.
export const GUEST_MERGE_DEFERRED_MAX = 10;
export const GUEST_MERGE_WINDOW_MS = 30 * 24 * 3600 * 1000;
const DONE_TICKET_TTL = 30 * 24 * 3600;
const HISTORY_KEEP_MS = 90 * 24 * 3600 * 1000;
const LOCK_TTL = 120;
// Taşıma, tavanın en çok bu katına kadar büyütebilir (kullanıcının kendi verisi).
export const MERGE_HEADROOM = 2;

export const ticketKey = (hash) => `guest-merge:ticket:${hash}`;
export const stateKey = (guestUid) => `guest-merge:state:${guestUid}`;
export const indexKey = (targetUid) => `user:${targetUid}:guestMerges`;
const lockKey = (guestUid) => `guest-merge:lock:${guestUid}`;
// Grup 5 ilk sürümünün işareti; geri dönüş (rollback) uyumu için yazılmaya devam eder.
const legacyMergedKey = (guestUid) => `user:${guestUid}:mergedInto`;

const TICKET_RE = /^[A-Za-z0-9_-]{43}$/;
export const hashTicket = (ticket) => crypto.createHash("sha256").update(ticket).digest("hex");

let clock = () => Date.now();
export function __setGuestMergeClockForTests(fn) {
  clock = fn || (() => Date.now());
}

function httpError(status, code, message, extra = {}) {
  return Object.assign(new Error(message), { status, code, ...extra });
}

function parseObject(raw, what) {
  if (raw == null) return null;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw httpError(502, "guest_merge_unreadable", `${what} okunamadı.`);
  }
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw httpError(502, "guest_merge_unreadable", `${what} okunamadı.`);
  return value;
}
const parseState = (raw) => parseObject(raw, "Taşıma kaydı");
const parseIndex = (raw) => parseObject(raw, "Taşıma listesi") || {};
const parseShopping = (raw) => {
  try {
    return parseObject(raw, "Alışveriş listesi");
  } catch {
    throw httpError(502, "bucket_unreadable", "Alışveriş listesi okunamadı.");
  }
};

const updateState = (guestUid, mutate) => mutateBucket(stateKey(guestUid), { parse: parseState, mutate });
const updateIndex = (targetUid, mutate) => mutateBucket(indexKey(targetUid), { parse: parseIndex, mutate });

async function readState(guestUid) {
  return parseState(await redisGet(stateKey(guestUid)));
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isEmptyShoppingList = (v) =>
  !v || (isPlainObject(v) && Object.values(v).every((x) => x == null || (Array.isArray(x) ? x.length === 0 : isPlainObject(x) ? Object.keys(x).length === 0 : false)));

function emptyReport() {
  return { recipes: 0, skippedRecipes: 0, pantry: 0, shoppingList: "none", families: {} };
}

// ---------------------------------------------------------------------------
// 1. Bilet
// ---------------------------------------------------------------------------

export async function createTicket(guest) {
  if (!guest.isAnonymous) throw httpError(400, "not_guest", "Yalnızca misafir hesabın verisi taşınabilir.");
  const current = await readState(guest.uid);
  if (current && current.targetUid) throw httpError(409, "guest_already_merged", "Bu misafir verisi başka bir hesaba taşınıyor.");
  const ticket = crypto.randomBytes(32).toString("base64url");
  const hash = hashTicket(ticket);
  // Önce bilet kaydı (durum kaydı hiçbir zaman olmayan bir bileti göstermesin).
  await redisSet(ticketKey(hash), JSON.stringify({ guestUid: guest.uid, createdAt: clock() }));
  let previousHash = null;
  try {
    await updateState(guest.uid, (state) => {
      if (state && state.targetUid) throw httpError(409, "guest_already_merged", "Bu misafir verisi başka bir hesaba taşınıyor.");
      previousHash = state?.ticketHash || null;
      return { ...(state || {}), guestUid: guest.uid, ticketHash: hash, status: "open", createdAt: clock() };
    });
  } catch (e) {
    await redisDel(ticketKey(hash)).catch(() => {});
    throw e;
  }
  if (previousHash && previousHash !== hash) await redisDel(ticketKey(previousHash)).catch(() => {});
  return { ticket };
}

// ---------------------------------------------------------------------------
// 2. Bağlama
// ---------------------------------------------------------------------------

// Dizin kaydı durumları: "pending" (başlatıldı; pencereye sayılır), "done"
// (tamamlandı; pencereye sayılır), "deferred" (denetim K1: hedef sınırdayken
// bağlandı, adımlar çalışmadı; pencereye SAYILMAZ, pencere açılınca sırayla
// başlatılır). Pencereye sayılan an: startedAt (eski kayıtlarda boundAt).
const startedAtOf = (e) => Number(e?.startedAt ?? e?.boundAt) || 0;
const countsTowardWindow = (e, now) => !!e && (e.status === "pending" || e.status === "done") && startedAtOf(e) > now - GUEST_MERGE_WINDOW_MS;

function limitError() {
  return httpError(429, "guest_merge_limit", "Bu hesaba bekleyen çok fazla misafir taşıması var. Misafir verilerin silinmedi; daha sonra tekrar dene.");
}

// Hedefin dizinine kayıt ekler (sınır kontrolü burada, atomik). Pencere doluysa
// kayıt "deferred" olur; ertelenmiş kayıt sayısı da doluysa bağlanmaz (429).
async function reserveIndexEntry(targetUid, guestUid, ticketHash) {
  const now = clock();
  await updateIndex(targetUid, (index) => {
    const existing = index[guestUid];
    if (existing) return existing.ticketHash || !ticketHash ? undefined : { ...index, [guestUid]: { ...existing, ticketHash } };
    const pruned = Object.fromEntries(Object.entries(index).filter(([, e]) => !(e && e.status === "done" && Number(e.completedAt) < now - HISTORY_KEEP_MS)));
    const started = Object.values(pruned).filter((e) => countsTowardWindow(e, now)).length;
    const deferredCount = Object.values(pruned).filter((e) => e && e.status === "deferred").length;
    const hasQueue = deferredCount > 0; // sıra korunur: önce bekleyenler
    let entry;
    if (started < GUEST_MERGE_LIMIT && !hasQueue) entry = { boundAt: now, startedAt: now, status: "pending" };
    else if (deferredCount < GUEST_MERGE_DEFERRED_MAX) entry = { boundAt: now, status: "deferred" };
    else throw limitError();
    return { ...pruned, [guestUid]: { ...entry, ...(ticketHash ? { ticketHash } : {}) } };
  });
}

// Ertelenmiş kaydı, pencere izin veriyorsa ve sırası geldiyse başlatır.
// Dönüş: güncel dizin kaydı.
async function promoteIfAllowed(targetUid, guestUid) {
  const now = clock();
  const { value } = await updateIndex(targetUid, (index) => {
    const entry = index[guestUid];
    if (!entry || entry.status !== "deferred") return undefined;
    const started = Object.values(index).filter((e) => countsTowardWindow(e, now)).length;
    if (started >= GUEST_MERGE_LIMIT) return undefined;
    // Sıra: daha önce ertelenen başka bir kayıt varsa önce o başlar.
    const earlier = Object.entries(index).some(([g, e]) => g !== guestUid && e && e.status === "deferred" && (Number(e.boundAt) < Number(entry.boundAt) || (Number(e.boundAt) === Number(entry.boundAt) && g < guestUid)));
    if (earlier) return undefined;
    return { ...index, [guestUid]: { ...entry, status: "pending", startedAt: now } };
  });
  return { entry: value[guestUid] || null, index: value };
}

// Ertelenmiş kaydın sıradaki yerine göre tahmini başlama zamanı.
function deferredStartAfter(index, guestUid, now) {
  const queue = Object.entries(index)
    .filter(([, e]) => e && e.status === "deferred")
    .sort(([ga, a], [gb, b]) => Number(a.boundAt) - Number(b.boundAt) || (ga < gb ? -1 : 1))
    .map(([g]) => g);
  const position = Math.max(0, queue.indexOf(guestUid));
  const started = Object.values(index)
    .filter((e) => countsTowardWindow(e, now))
    .map(startedAtOf)
    .sort((a, b) => a - b);
  // Her pencere açıldığında bir sıradaki başlar: position. sıradaki, (position+1). boşluğu bekler.
  const freeNow = Math.max(0, GUEST_MERGE_LIMIT - started.length);
  if (position < freeNow) return now;
  const k = started.length - GUEST_MERGE_LIMIT + (position - freeNow);
  // Sıranın gerisindekiler için bilinen en erken an (önlerindekiler de pencereyi dolduracak).
  if (k < started.length) return started[k] + GUEST_MERGE_WINDOW_MS;
  return started.length ? started[started.length - 1] + GUEST_MERGE_WINDOW_MS : now;
}

async function dropIndexEntry(targetUid, guestUid) {
  await updateIndex(targetUid, (index) => {
    if (!index[guestUid] || index[guestUid].status === "done") return undefined;
    const next = { ...index };
    delete next[guestUid];
    return next;
  }).catch(() => {});
}

async function bindGuest({ guestUid, targetUid, ticketHash, fromIndex = false }) {
  if (guestUid === targetUid) throw httpError(400, "same_account", "Aynı hesap.");
  const existing = await readState(guestUid);
  if (existing && existing.targetUid && existing.targetUid !== targetUid) {
    throw httpError(409, "guest_already_merged", "Bu misafir verisi başka bir hesaba taşındı.");
  }
  const legacyOwner = await redisGet(legacyMergedKey(guestUid));
  if (legacyOwner && legacyOwner !== targetUid) throw httpError(409, "guest_already_merged", "Bu misafir verisi başka bir hesaba taşındı.");

  // Önce hedefin dizini: buradan sonra süreç ölse bile hedef hesap herhangi bir
  // cihazdan devam edebilir (dizin kaydı ancak bilet/token doğrulandıktan sonra yazılır).
  if (!fromIndex) await reserveIndexEntry(targetUid, guestUid, ticketHash);

  let lost = false;
  await updateState(guestUid, (state) => {
    if (state && state.targetUid) {
      if (state.targetUid !== targetUid) lost = true;
      return undefined;
    }
    return {
      ...(state || {}),
      guestUid,
      ticketHash: state?.ticketHash || ticketHash || null,
      targetUid,
      boundAt: clock(),
      status: "bound",
      steps: {},
      report: emptyReport(),
    };
  });
  if (lost) {
    await dropIndexEntry(targetUid, guestUid);
    throw httpError(409, "guest_already_merged", "Bu misafir verisi başka bir hesaba taşındı.");
  }
  await ensureFrozen(guestUid, targetUid);
}

// Misafiri dondur (TTL'siz): artık misafir oturumu yazamaz. Temizlikteki hesap
// silme bu işareti 24 saatlik olağan işaretle değiştirir. Denetim K3: bağlamadaki
// yazım düşse bile her başlatma/sürdürmede (adımlardan ÖNCE) yeniden garanti edilir.
async function ensureFrozen(guestUid, targetUid) {
  await redisSet(deletedMarkerKey(guestUid), String(clock()));
  await redisSet(legacyMergedKey(guestUid), targetUid);
}

// ---------------------------------------------------------------------------
// 3. Adımlar
// ---------------------------------------------------------------------------

function capacityError() {
  return httpError(
    413,
    "guest_merge_capacity",
    "Misafir verilerin bu hesaba sığmadı (liste çok büyük). Verilerin silinmedi; yer açınca taşıma kendiliğinden devam eder."
  );
}

function assertMergeCapacity(bucket, nextRaw, previousRaw, nextCount, previousCount) {
  const limits = BUCKET_LIMITS[bucket];
  const nextBytes = byteSize(nextRaw);
  if (nextBytes > limits.maxBytes * MERGE_HEADROOM && nextBytes > byteSize(previousRaw)) throw capacityError();
  if (limits.maxItems && nextCount != null && nextCount > limits.maxItems * MERGE_HEADROOM && nextCount > previousCount) throw capacityError();
}

const recipeFingerprint = (r) => crypto.createHash("sha256").update(JSON.stringify(r)).digest("hex").slice(0, 8);

// Geçerli tarifleri hedef kişisel listeye ekler. { added, skipped }.
async function mergeRecipesInto(targetUid, incoming) {
  const accepted = [];
  let skipped = 0;
  for (const r of incoming) {
    if (!isPlainObject(r)) {
      skipped++;
      continue;
    }
    try {
      accepted.push(checkRecipeList([r], []).list[0]);
    } catch {
      skipped++;
    }
  }
  let added = 0;
  if (accepted.length) {
    const key = `user:${targetUid}:recipes`;
    await mutateBucket(key, {
      parse: parseListOrThrow,
      mutate: (list) => {
        const byId = new Map(list.filter(isPlainObject).map((r) => [r.id, JSON.stringify(r)]));
        const add = [];
        for (const r of accepted) {
          const have = byId.get(r.id);
          if (have === undefined) {
            add.push(r);
            byId.set(r.id, JSON.stringify(r));
          } else if (have !== JSON.stringify(r)) {
            // Aynı id, farklı içerik: deterministik yeni id (tekrar çalıştırmada aynı).
            const copy = { ...r, id: `${String(r.id).slice(0, 80)}-m${recipeFingerprint(r)}` };
            if (!byId.has(copy.id)) {
              add.push(copy);
              byId.set(copy.id, JSON.stringify(copy));
            }
          }
        }
        added = add.length;
        if (!add.length) return undefined;
        const next = [...list, ...add];
        assertMergeCapacity("recipes", JSON.stringify(next), JSON.stringify(list), next.length, list.length);
        return next;
      },
    });
  }
  return { added, skipped };
}

const pantryNorm = (x) => (typeof x === "string" ? x.trim().toLocaleLowerCase("tr") : JSON.stringify(x));

async function mergePantryInto(targetUid, incoming) {
  let added = 0;
  if (!incoming.length) return added;
  await mutateBucket(`user:${targetUid}:pantry-items`, {
    parse: parseListOrThrow,
    mutate: (list) => {
      const have = new Set(list.map(pantryNorm));
      const add = [];
      for (const x of incoming) {
        const k = pantryNorm(x);
        if (have.has(k)) continue;
        have.add(k);
        add.push(x);
      }
      added = add.length;
      if (!add.length) return undefined;
      const next = [...list, ...add];
      assertMergeCapacity("pantry-items", JSON.stringify(next), JSON.stringify(list), next.length, list.length);
      return next;
    },
  });
  return added;
}

// Alışveriş listesi birleştirme (denetim K2). selected = birleşim (önce hedefinkiler,
// sonra yeni kimlikler); checked/servings: hedefin değerleri korunur, yalnızca
// misafirde olan anahtarlar eklenir; bilinmeyen eski alanlarda çakışmada hedefinki
// korunur, yalnızca misafirde olan alan eklenir. Saf ve idempotent.
export function mergeShoppingLists(target, incoming) {
  if (isEmptyShoppingList(incoming)) return target;
  if (isEmptyShoppingList(target)) return incoming;
  const out = { ...incoming, ...target };
  const tSel = Array.isArray(target.selected) ? target.selected : [];
  const iSel = Array.isArray(incoming.selected) ? incoming.selected : [];
  if (Array.isArray(target.selected) || Array.isArray(incoming.selected)) {
    const seen = new Set(tSel.map((x) => JSON.stringify(x)));
    out.selected = [...tSel, ...iSel.filter((x) => !seen.has(JSON.stringify(x)) && seen.add(JSON.stringify(x)))];
  }
  for (const key of ["checked", "servings"]) {
    const t = isPlainObject(target[key]) ? target[key] : null;
    const i = isPlainObject(incoming[key]) ? incoming[key] : null;
    if (t && i) out[key] = { ...i, ...t };
  }
  return out;
}

// "copied" | "merged" | "none"
async function mergeShoppingInto(targetUid, incoming) {
  const key = `user:${targetUid}:shopping-list`;
  if (isEmptyShoppingList(incoming)) return "none";
  let result = "merged";
  await mutateBucket(key, {
    parse: parseShopping,
    mutate: (current) => {
      result = isEmptyShoppingList(current) ? "copied" : "merged";
      const next = mergeShoppingLists(current, incoming);
      if (JSON.stringify(next) === JSON.stringify(current)) return undefined;
      assertMergeCapacity("shopping-list", JSON.stringify(next), current == null ? null : JSON.stringify(current), null, null);
      return next;
    },
  });
  return result;
}

async function readList(key) {
  const { raw } = await readBucket(key);
  return parseListOrThrow(raw);
}

// Misafirin bir ailedeki üyeliğini hedefe devreder. Sonuç (rapor için):
//  "transferred"            hedef üye oldu (sahiplik dahil), misafir çıkarıldı
//  "already_member"         hedef zaten üyeydi; misafir çıkarıldı, sahiplik hedefe geçti
//  "left_handed_off"        hedef 2 aile sınırında; sahiplik diğer üyeye, misafir ayrıldı
//  "dissolved_into_personal" hedef sınırda ve misafir tek üye: ailenin tarifleri/kileri
//                           hedefin kişisel listesine kopyalandı, sonra aile silindi
//  "gone"                   aile artık yok / misafir üye değil
async function transferFamily(guestUid, targetUid, id) {
  const { meta, members } = await readFamilyState(id);
  if (!meta || isFamilyDeleting(meta)) {
    await dropFamilyFromProfile(guestUid, id);
    return { result: "gone" };
  }
  if (!members[guestUid]) {
    // Önceki bir çalıştırma devri bitirmiş olabilir.
    await dropFamilyFromProfile(guestUid, id);
    return { result: members[targetUid] ? "transferred" : "gone" };
  }
  const targetProfile = await getProfile(targetUid);
  const alreadyMember = !!members[targetUid];
  const hasRoom = targetProfile.families.includes(id) || targetProfile.families.length < MAX_FAMILIES;

  if (alreadyMember || hasRoom) {
    const guestEntry = members[guestUid] || {};
    let addedMember = false;
    await updateMembers(id, (m) => {
      if (m[targetUid] || !m[guestUid]) return undefined;
      addedMember = true;
      return { ...m, [targetUid]: { ...guestEntry, joinedAt: guestEntry.joinedAt ?? clock() } };
    });
    let addedProfile = false;
    let full = false;
    await updateProfile(targetUid, (p) => {
      if (p.families.includes(id)) return undefined;
      if (p.families.length >= MAX_FAMILIES) {
        full = true;
        return undefined;
      }
      addedProfile = true;
      return { ...p, families: [...p.families, id] };
    });
    if (full) {
      // Bu arada hedef başka bir aileye katıldı: eklediğimiz üye kaydını geri al,
      // "sınırda" yoluna geç.
      if (addedMember) await removeMemberFromFamily(targetUid, id);
      return transferFamilyTargetFull(guestUid, targetUid, id);
    }
    if (await undoJoinIfFamilyGone(targetUid, id, { added: { member: addedMember, profile: addedProfile } })) {
      await dropFamilyFromProfile(guestUid, id);
      return { result: "gone" };
    }
    // Sahiplik: hedef artık üye olduğundan aile hiçbir an sahipsiz kalmaz.
    await updateMeta(id, (m) => (m && !m.deleting && m.ownerUid === guestUid ? { ...m, ownerUid: targetUid } : undefined));
    await removeMemberFromFamily(guestUid, id);
    await dropFamilyFromProfile(guestUid, id);
    await ensureOwner(id);
    return { result: alreadyMember ? "already_member" : "transferred" };
  }
  return transferFamilyTargetFull(guestUid, targetUid, id);
}

async function transferFamilyTargetFull(guestUid, targetUid, id) {
  const { members } = await readFamilyState(id);
  const others = Object.keys(members).filter((u) => u !== guestUid);
  if (others.length) {
    // Sahiplik (varsa) en eski üyeye devredilir, misafir ayrılır; aile ve içeriği kalır.
    await leaveFamily(guestUid, id);
    return { result: "left_handed_off" };
  }
  // Misafir tek üye: içerik hedefin kişisel listesine, sonra aile silinir.
  // İçerik kopyalanmadan aile silinmez; kapasite yetmezse taşıma durur.
  const recipes = await readList(`family:${id}:recipes`);
  const pantry = await readList(`family:${id}:pantry-items`);
  const shopping = parseShopping((await readBucket(`family:${id}:shopping-list`)).raw);
  const r = await mergeRecipesInto(targetUid, recipes);
  const pantryAdded = await mergePantryInto(targetUid, pantry);
  const shoppingResult = await mergeShoppingInto(targetUid, shopping);
  // Bu arada biri katıldıysa aile silinmez (leaveAsLastMember yalnızca ayrılır).
  const outcome = await leaveAsLastMember(guestUid, id);
  return {
    result: outcome === "deleted" ? "dissolved_into_personal" : "left_handed_off",
    recipes: r.added,
    skippedRecipes: r.skipped,
    pantry: pantryAdded,
    shoppingList: shoppingResult,
  };
}

async function markStep(guestUid, step, patchReport) {
  await updateState(guestUid, (s) => {
    if (!s) return undefined;
    return {
      ...s,
      steps: { ...(s.steps || {}), [step]: true },
      report: patchReport ? patchReport({ ...emptyReport(), ...(s.report || {}) }) : s.report,
    };
  });
}

async function assertTargetAlive(targetUid) {
  if (await isAccountDeleted(targetUid)) throw accountDeletedError();
}

const publicReport = (report) => ({ ...emptyReport(), ...(report || {}) });

async function runSteps(guestUid, targetUid) {
  let state = await readState(guestUid);
  if (!state || state.targetUid !== targetUid) throw httpError(409, "guest_already_merged", "Bu misafir verisi başka bir hesaba taşındı.");
  const steps = () => state.steps || {};
  const refresh = async () => {
    state = await readState(guestUid);
  };

  if (!steps().recipes) {
    await assertTargetAlive(targetUid);
    const r = await mergeRecipesInto(targetUid, await readList(`user:${guestUid}:recipes`));
    await markStep(guestUid, "recipes", (rep) => ({ ...rep, recipes: r.added, skippedRecipes: r.skipped }));
    await refresh();
  }
  if (!steps().pantry) {
    await assertTargetAlive(targetUid);
    const added = await mergePantryInto(targetUid, await readList(`user:${guestUid}:pantry-items`));
    await markStep(guestUid, "pantry", (rep) => ({ ...rep, pantry: added }));
    await refresh();
  }
  if (!steps().shopping) {
    await assertTargetAlive(targetUid);
    const result = await mergeShoppingInto(targetUid, parseShopping((await readBucket(`user:${guestUid}:shopping-list`)).raw));
    await markStep(guestUid, "shopping", (rep) => ({ ...rep, shoppingList: result }));
    await refresh();
  }
  if (!steps().families) {
    // Profil okunamıyorsa aile üyelikleri bilinemez: adım tamamlanmaz, temizlik
    // (misafiri silme) yapılmaz — misafir hiçbir ailede öksüz kalmasın.
    const guestProfile = await getProfile(guestUid).catch((e) => {
      if (e.code === "profile_unreadable") {
        throw httpError(502, "guest_profile_unreadable", "Misafir hesabın aile bilgisi okunamadı; taşıma tamamlanmadı. Verilerin silinmedi.");
      }
      throw e;
    });
    for (const id of guestProfile.families) {
      await assertTargetAlive(targetUid);
      const outcome = await transferFamily(guestUid, targetUid, id);
      await markStep(guestUid, `family:${id}`, (rep) => ({ ...rep, families: { ...(rep.families || {}), [id]: outcome } }));
    }
    await markStep(guestUid, "families");
    await refresh();
  }
  return state;
}

// Temizlik: misafir verisi + anonim Firebase kullanıcısı silinir; bilet "tamamlandı"
// (30 gün), dizin kaydı "done". Her parça tekrar çalıştırılabilir.
async function cleanup(state) {
  const { guestUid, targetUid, ticketHash } = state;
  const report = publicReport(state.report);
  await deleteAccount(guestUid, { keepGuestMergeState: true });
  if (ticketHash) {
    await redisSet(ticketKey(ticketHash), JSON.stringify({ guestUid, targetUid, status: "done", report, completedAt: clock() }), DONE_TICKET_TTL);
  }
  await updateIndex(targetUid, (index) => {
    const entry = index[guestUid] || { boundAt: state.boundAt };
    if (entry.status === "done") return undefined;
    return { ...index, [guestUid]: { ...entry, status: "done", completedAt: clock(), report, ...(ticketHash ? { ticketHash } : {}) } };
  });
  await redisCommand(["DEL", stateKey(guestUid), ...bucketAuxKeys(stateKey(guestUid))]);
}

// Bağlı bir taşımayı kaldığı yerden bitirir.
// { status: "done" | "in_progress" | "blocked", report, cleanupPending?, code? }
async function runMerge(guestUid, targetUid) {
  const locked = await redisSetNX(lockKey(guestUid), String(clock()), LOCK_TTL);
  if (!locked) {
    const state = await readState(guestUid).catch(() => null);
    return { status: "in_progress", report: publicReport(state?.report) };
  }
  try {
    let state;
    try {
      const current = await readState(guestUid);
      if (current && current.targetUid === targetUid && !(current.steps && current.steps.families)) {
        await ensureFrozen(guestUid, targetUid);
      }
      state = await runSteps(guestUid, targetUid);
    } catch (e) {
      if (e.code === "guest_merge_capacity" || e.code === "guest_profile_unreadable") {
        const s = await readState(guestUid).catch(() => null);
        return { status: "blocked", code: e.code, error: e.message, report: publicReport(s?.report) };
      }
      throw e;
    }
    try {
      await cleanup(state);
    } catch (e) {
      // Veri taşındı; yalnızca misafir kopyasının silinmesi yarım kaldı. Sonraki
      // açılışta (resumeGuestMerges) tekrar denenir; hedef hesap silinirse de temizlenir.
      console.warn(JSON.stringify({ tag: "guest-merge", warning: "cleanup pending", error: e.message }));
      return { status: "done", cleanupPending: true, report: publicReport(state.report) };
    }
    return { status: "done", report: publicReport(state.report) };
  } finally {
    await redisDel(lockKey(guestUid)).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Uç noktaların kullandığı işlemler
// ---------------------------------------------------------------------------

// Bağlı taşımayı dizin durumuna göre başlatır ya da "deferred" döndürür.
async function startOrDefer(guestUid, targetUid) {
  let { entry, index } = await promoteIfAllowed(targetUid, guestUid);
  if (!entry) {
    index = parseIndex(await redisGet(indexKey(targetUid)));
    entry = index[guestUid] || null;
  }
  if (entry && entry.status === "deferred") {
    // Ertelenmişken de misafir donuk kalır (K3).
    const state = await readState(guestUid);
    if (state && state.targetUid === targetUid) await ensureFrozen(guestUid, targetUid);
    return { status: "deferred", startAfter: deferredStartAfter(index, guestUid, clock()), report: publicReport(null) };
  }
  if (entry && entry.status === "done") return { status: "done", report: publicReport(entry.report) };
  return runMerge(guestUid, targetUid);
}

function assertTarget(target) {
  if (target.isAnonymous) throw httpError(400, "target_is_guest", "Misafir verisi yalnızca kayıtlı bir hesaba taşınabilir.");
}

export async function claimTicket({ ticket, target }) {
  assertTarget(target);
  if (typeof ticket !== "string" || !TICKET_RE.test(ticket)) throw httpError(400, "ticket_invalid", "Geçersiz taşıma bileti.");
  const hash = hashTicket(ticket);
  const record = parseObject(await redisGet(ticketKey(hash)), "Taşıma bileti");
  if (!record || typeof record.guestUid !== "string") throw httpError(404, "ticket_not_found", "Taşıma bileti bulunamadı.");
  if (record.status === "done") {
    if (record.targetUid !== target.uid) throw httpError(409, "guest_already_merged", "Bu misafir verisi başka bir hesaba taşındı.");
    return { status: "done", report: publicReport(record.report) };
  }
  await bindGuest({ guestUid: record.guestUid, targetUid: target.uid, ticketHash: hash });
  return startOrDefer(record.guestUid, target.uid);
}

// Eski yol: misafir ID token'ı ile (bilet yok).
export async function mergeGuestInto({ guest, targetUid, targetIsAnonymous = false }) {
  if (!guest.isAnonymous) throw httpError(400, "not_guest", "Yalnızca misafir hesabın verisi taşınabilir.");
  if (guest.uid === targetUid) throw httpError(400, "same_account", "Aynı hesap.");
  assertTarget({ isAnonymous: targetIsAnonymous });
  const state = await readState(guest.uid);
  if (!(state && state.targetUid === targetUid)) {
    // Taşıması tamamlanıp silinmiş misafir (token'ı hâlâ geçerli olabilir).
    const index = parseIndex(await redisGet(indexKey(targetUid)));
    if (index[guest.uid]?.status === "done") return { status: "done", report: publicReport(index[guest.uid].report) };
    if (!state && (await isAccountDeleted(guest.uid))) throw httpError(409, "guest_already_merged", "Bu misafir verisi zaten taşındı.");
  }
  await bindGuest({ guestUid: guest.uid, targetUid, ticketHash: null });
  return startOrDefer(guest.uid, targetUid);
}

// Hedef hesabın yarım kalan taşımalarını bitirir (her açılışta, her cihazda).
export async function resumeMerges(target) {
  if (target.isAnonymous) return [];
  const index = parseIndex(await redisGet(indexKey(target.uid)));
  // Temizliğin son parçası (durum kaydını silmek) yarıda kaldıysa: tamamlanmış
  // taşımanın kalan durum kaydı süpürülür.
  for (const [guestUid, entry] of Object.entries(index)) {
    if (!entry || entry.status !== "done" || !entry.completedAt || entry.completedAt < clock() - GUEST_MERGE_WINDOW_MS) continue;
    const state = await readState(guestUid).catch(() => null);
    if (state && state.targetUid === target.uid) {
      await redisCommand(["DEL", stateKey(guestUid), ...bucketAuxKeys(stateKey(guestUid))]).catch(() => {});
    }
  }
  const rank = (e) => (e.status === "deferred" ? 1 : 0);
  const pending = Object.entries(index)
    .filter(([, e]) => e && e.status !== "done")
    .sort(([ga, a], [gb, b]) => rank(a) - rank(b) || Number(a.boundAt) - Number(b.boundAt) || (ga < gb ? -1 : 1));
  const results = [];
  for (const [guestUid, entry] of pending) {
    try {
      const state = await readState(guestUid);
      if (!state || !state.targetUid) {
        // Dizin yazıldı ama bağlama yarıda kaldı: aynı hedefe yeniden bağla.
        await bindGuest({ guestUid, targetUid: target.uid, ticketHash: entry.ticketHash || null, fromIndex: true });
      } else if (state.targetUid !== target.uid) {
        // Yarışı başka hedef kazanmış: bu dizin kaydı geçersiz.
        await dropIndexEntry(target.uid, guestUid);
        continue;
      }
      results.push(await startOrDefer(guestUid, target.uid));
    } catch (e) {
      if (e.code === "guest_already_merged") {
        await dropIndexEntry(target.uid, guestUid);
        continue;
      }
      results.push({ status: "failed", code: e.code || null, error: e.status ? e.message : "Veriler taşınamadı." });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Hesap silme ile ilişki (accountDeletion.js çağırır)
// ---------------------------------------------------------------------------

// Hedef hesap silinirken: bağlı (bekleyen ya da tamamlanmış) misafirlerin kalıntıları
// ve taşıma kayıtları da silinir (Play hesap silme taahhüdü).
export async function deleteMergedGuestsOf(targetUid) {
  let index = {};
  try {
    index = parseIndex(await redisGet(indexKey(targetUid)));
  } catch (e) {
    console.warn(JSON.stringify({ tag: "account-delete", warning: "guest merge index unreadable" }));
  }
  const guests = [];
  for (const [guestUid, entry] of Object.entries(index)) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(guestUid)) continue;
    const state = await readState(guestUid).catch(() => null);
    // Yalnızca gerçekten bu hedefe bağlı (ya da bağlanması yarıda kalmış) misafir silinir.
    if (state && state.targetUid && state.targetUid !== targetUid) continue;
    await deleteAccount(guestUid, { keepGuestMergeState: true });
    const hashes = [entry?.ticketHash, state?.ticketHash].filter(Boolean);
    await redisCommand(["DEL", stateKey(guestUid), ...bucketAuxKeys(stateKey(guestUid)), lockKey(guestUid), ...hashes.map(ticketKey)]);
    guests.push(guestUid);
  }
  return guests;
}

// Misafirin kendi hesabı silinirken (taşımadan bağımsız): açık bilet ve durum kaydı.
export async function deleteOwnMergeState(guestUid) {
  const state = await readState(guestUid).catch(() => null);
  const keys = [stateKey(guestUid), ...bucketAuxKeys(stateKey(guestUid)), lockKey(guestUid)];
  if (state?.ticketHash && !state.targetUid) keys.push(ticketKey(state.ticketHash));
  await redisCommand(["DEL", ...keys]);
}
