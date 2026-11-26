// QR ile tarif paylaşımı (sunucu). Ayrıntı ve varsayılanlar: docs/qr-ve-cevrimdisi.md.
//
// Paylaşım kaydı tarifin KOPYASI değil, ona işaret eden kısa ömürlü bir anahtardır:
//   recipe-share:<token> → { v, shareId, ownerUid, scope, familyId, recipeId, createdAt, expiresAt }  (EX = süre)
//   user:<uid>:recipe-shares → { "<scopeKey>|<recipeId>": { token, shareId, expiresAt } }  (sahibin dizini)
// Token rastgele 144 bit (base64url, 24 karakter); QR'da yalnızca bu ve sitenin
// adresi bulunur. Oturum token'ı ya da gizli anahtar QR'a hiç girmez.
//
// Her okumada kaynak yeniden doğrulanır (fail-closed):
//  - kayıt var ve süresi dolmamış (TTL + expiresAt),
//  - sahibin hesabı silinmemiş,
//  - kişisel tarifte: tarif sahibinin listesinde duruyor ve Free sınırı yüzünden
//    KİLİTLİ değil (kilitli tarif paylaşımla açılamaz),
//  - aile tarifinde: sahibi hâlâ o ailenin üyesi ve Plus (assertFamilyAccess),
//    tarif aile listesinde duruyor.
// Biri tutmazsa yanıt her durumda aynıdır (404 share_unavailable): süresi dolmuş,
// durdurulmuş, silinmiş ya da hiç olmamış paylaşım birbirinden ayırt edilmez.
import crypto from "node:crypto";
import { redisCommand, redisDel, redisGetJSON } from "./redis.js";
import { getProfile, FREE_RECIPE_LIMIT } from "./profile.js";
import { readBucket } from "./versionedBucket.js";
import { assertFamilyAccess } from "./families.js";
import { isAccountDeleted } from "./accountDeletion.js";
import { lockedRecipeIds } from "../../src/recipeLocks.js";
import { sanitizeSharedRecipe, SHARE_TOKEN_RE, SHARE_TTL_SECONDS } from "../../shared/recipeShare.js";
import { shareKey, shareIndexKey } from "./recipeShareKeys.js";

export { shareKey, shareIndexKey, deleteSharesOf } from "./recipeShareKeys.js";

export const SHARE_UNAVAILABLE = "share_unavailable";
export const RECIPE_LOCKED = "recipe_locked";
// Sahibin dizininde tutulan en fazla paylaşım; aşılırsa en eskisi durdurulur.
export const MAX_SHARES_PER_USER = 200;

const FAMILY_ID_RE = /^[\w-]{1,64}$/;
const RECIPE_ID_MAX = 100;

function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}
const unavailable = () => httpError(404, SHARE_UNAVAILABLE, "Bu paylaşım artık geçerli değil.");

const newToken = () => crypto.randomBytes(18).toString("base64url");
const newShareId = () => crypto.randomBytes(12).toString("base64url");

export function validRecipeId(id) {
  return (typeof id === "string" && id.length > 0 && id.length <= RECIPE_ID_MAX) || (typeof id === "number" && Number.isFinite(id));
}

// İstek gövdesindeki hedef: { scope: "personal" } | { scope: "family", familyId }.
export function parseSource({ scope, familyId, recipeId }) {
  if (!validRecipeId(recipeId)) throw httpError(400, "invalid_request", "Geçersiz tarif.");
  if (scope === "personal") return { scope, familyId: null, recipeId };
  if (scope === "family" && typeof familyId === "string" && FAMILY_ID_RE.test(familyId)) return { scope, familyId, recipeId };
  throw httpError(400, "invalid_request", "Geçersiz kapsam.");
}
const sourceKey = ({ scope, familyId, recipeId }) => `${scope === "family" ? `family:${familyId}` : "personal"}|${recipeId}`;

function parseList(raw) {
  if (raw == null) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// Kaynak tarifi sahibinin gözünden okur; erişim/kilit kuralları burada.
// lockedError: kişisel tarif kilitliyse fırlatılacak hata (oluştururken 403,
// okurken "geçersiz paylaşım").
async function readSourceRecipe(ownerUid, source, { lockedError }) {
  const profile = await getProfile(ownerUid);
  let key;
  if (source.scope === "family") {
    await assertFamilyAccess(ownerUid, source.familyId, profile);
    key = `family:${source.familyId}:recipes`;
  } else {
    key = `user:${ownerUid}:recipes`;
  }
  const list = parseList((await readBucket(key)).raw);
  const recipe = list.find((r) => r && typeof r === "object" && r.id === source.recipeId);
  if (!recipe) return null;
  if (source.scope === "personal" && lockedRecipeIds(list, { isPlus: !!profile.isPlus, limit: FREE_RECIPE_LIMIT }).has(recipe.id)) {
    throw lockedError();
  }
  return recipe;
}

async function readIndex(uid) {
  const value = await redisGetJSON(shareIndexKey(uid), {});
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

async function writeIndex(uid, index) {
  await redisCommand(["SET", shareIndexKey(uid), JSON.stringify(index)]);
}

// Paylaşım oluşturur ya da aynı tarifin hâlâ geçerli paylaşımını döndürür
// (aynı QR: ekranda tekrar açınca kod değişmez, basılı/ekran görüntüsü kodlar
// süre dolana ya da durdurulana kadar çalışır).
export async function createShare(ownerUid, sourceInput, { now = Date.now() } = {}) {
  const source = parseSource(sourceInput);
  let recipe;
  try {
    recipe = await readSourceRecipe(ownerUid, source, {
      lockedError: () => httpError(403, RECIPE_LOCKED, "Kilitli tarif paylaşılamaz. Plus'a geçince ya da başka tarif silince açılır."),
    });
  } catch (e) {
    if (e.status === 400 || e.status === 403 || e.status === 404) {
      if (e.code === RECIPE_LOCKED || e.code === "family_locked") throw e;
      throw httpError(e.status === 400 ? 400 : 403, e.code || "forbidden", e.message);
    }
    throw e;
  }
  if (!recipe) throw httpError(404, "recipe_not_found", "Tarif bulunamadı.");

  const index = await readIndex(ownerUid);
  const sk = sourceKey(source);
  const existing = index[sk];
  if (existing && typeof existing.token === "string" && Number(existing.expiresAt) > now + 60_000) {
    const record = await redisGetJSON(shareKey(existing.token), null);
    if (record && record.ownerUid === ownerUid && Number(record.expiresAt) > now) {
      return { token: existing.token, shareId: record.shareId, expiresAt: record.expiresAt, reused: true };
    }
  }

  const token = newToken();
  const shareId = newShareId();
  const expiresAt = now + SHARE_TTL_SECONDS * 1000;
  const record = {
    v: 1,
    shareId,
    ownerUid,
    scope: source.scope,
    familyId: source.familyId,
    recipeId: source.recipeId,
    createdAt: now,
    expiresAt,
  };
  await redisCommand(["SET", shareKey(token), JSON.stringify(record), "EX", String(SHARE_TTL_SECONDS)]);

  // Dizin: süresi geçenler atılır; tavan aşılırsa en eski paylaşım durdurulur.
  const next = {};
  for (const [k, v] of Object.entries(index)) {
    if (k !== sk && v && Number(v.expiresAt) > now) next[k] = v;
  }
  next[sk] = { token, shareId, expiresAt };
  const entries = Object.entries(next).sort((a, b) => Number(a[1].expiresAt) - Number(b[1].expiresAt));
  const overflow = entries.slice(0, Math.max(0, entries.length - MAX_SHARES_PER_USER));
  for (const [k, v] of overflow) {
    delete next[k];
    await redisDel(shareKey(v.token)).catch(() => {});
  }
  if (existing && existing.token && existing.token !== token) await redisDel(shareKey(existing.token)).catch(() => {});
  await writeIndex(ownerUid, next);
  return { token, shareId, expiresAt, reused: false };
}

// Bir tarifin paylaşımını durdurur (QR hemen geçersiz olur). Paylaşım yoksa da başarılı.
export async function revokeShare(ownerUid, sourceInput) {
  const source = parseSource(sourceInput);
  const index = await readIndex(ownerUid);
  const sk = sourceKey(source);
  const entry = index[sk];
  if (!entry) return { revoked: false };
  if (typeof entry.token === "string") await redisDel(shareKey(entry.token));
  delete index[sk];
  await writeIndex(ownerUid, index);
  return { revoked: true };
}

// Sahibin bir tarif için hâlâ geçerli paylaşımı (ekranda "paylaşım açık" göstermek için).
export async function shareStatus(ownerUid, sourceInput, { now = Date.now() } = {}) {
  const source = parseSource(sourceInput);
  const index = await readIndex(ownerUid);
  const entry = index[sourceKey(source)];
  if (!entry || !(Number(entry.expiresAt) > now)) return { active: false };
  const record = await redisGetJSON(shareKey(entry.token), null);
  if (!record || record.ownerUid !== ownerUid) return { active: false };
  return { active: true, token: entry.token, shareId: record.shareId, expiresAt: record.expiresAt };
}

// Alıcı için paylaşımı açar: güncel, temizlenmiş tarif içeriği (kopya değil, o anki hâli).
export async function resolveShare(viewerUid, token, { now = Date.now() } = {}) {
  if (typeof token !== "string" || !SHARE_TOKEN_RE.test(token)) throw unavailable();
  const record = await redisGetJSON(shareKey(token), null);
  if (!record || typeof record !== "object" || !(Number(record.expiresAt) > now) || typeof record.ownerUid !== "string") {
    throw unavailable();
  }
  if (await isAccountDeleted(record.ownerUid)) throw unavailable();
  let source;
  try {
    source = parseSource(record);
  } catch {
    throw unavailable();
  }
  let recipe;
  try {
    recipe = await readSourceRecipe(record.ownerUid, source, { lockedError: unavailable });
  } catch (e) {
    // Sahip aileden çıktı, Plus'ı kapandı, aile silindi, tarif kilitlendi: geçersiz.
    if (e.status === 400 || e.status === 403 || e.status === 404) throw unavailable();
    throw e;
  }
  if (!recipe) throw unavailable();
  const clean = sanitizeSharedRecipe(recipe);
  if (!clean) throw unavailable();
  return { shareId: record.shareId, expiresAt: record.expiresAt, own: viewerUid === record.ownerUid, recipe: clean };
}
