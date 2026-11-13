// Misafir (anonim) hesabın kişisel verisini, kullanıcının geçtiği mevcut hesaba
// taşır (Grup 5).
//
// Sorun: misafir, zaten kayıtlı bir Google/e-posta hesabını bağlamaya çalışınca
// Firebase bağlamayı reddediyor ve uygulama SESSİZCE o hesaba geçiyordu; misafirin
// tarifleri erişilemez bir anonim uid altında kalıyordu.
// Şimdi istemci önce kullanıcıya ne olacağını söyler, onay alırsa misafir ID
// token'ını saklayıp hesaba geçer ve bu taşımayı ister. İki hesabın da sahipliği
// kanıtlı: hedef = isteğin kendi oturumu, kaynak = gövdedeki geçerli misafir token'ı.
//
// Kurallar:
//  - kaynak gerçekten anonim olmalı ve hedeften farklı olmalı;
//  - bir misafir yalnızca TEK hesaba taşınabilir (işaret: user:<misafir>:mergedInto);
//    aynı hedefe tekrar çağrı güvenle tekrar eder (id ile tekilleştirme);
//  - tarifler: hedefte olmayan id'ler eklenir (link/boyut denetimiyle; geçersiz
//    kayıt atlanır ve sayılır). Free sınırı burada UYGULANMAZ: kullanıcının kendi
//    verisi silinmez; ürün kararı gereği sınırın üstündeki tarifler kilitli görünür;
//  - kiler: hedefte birebir aynısı olmayan öğeler eklenir;
//  - alışveriş listesi (tek nesne): hedefte boşsa kopyalanır, doluysa DOKUNULMAZ
//    (iki listeyi otomatik birleştirmek öğeleri bozabilir) ve bu yanıtla bildirilir;
//  - aile üyelikleri TAŞINMAZ (misafir aileden ayrılmaz; kullanıcı davet koduyla
//    yeni hesabıyla katılır). Misafirin verisi silinmez (anonim hesaba artık
//    erişilemediği için zararsız; ileride temizlik işi yapılabilir).
import { redisGet, redisSetNX } from "./redis.js";
import { mutateBucket, parseListOrThrow } from "./versionedBucket.js";
import { checkRecipeList } from "./recipeInput.js";

const MERGED_TTL = 30 * 24 * 3600;
const mergedKey = (guestUid) => `user:${guestUid}:mergedInto`;

function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function parseObjectOrNull(raw) {
  if (raw == null) return null;
  const value = JSON.parse(raw);
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

const isEmptyShoppingList = (v) =>
  !v || (typeof v === "object" && Object.values(v).every((x) => x == null || (Array.isArray(x) ? x.length === 0 : typeof x === "object" ? Object.keys(x).length === 0 : false)));

export async function mergeGuestInto({ guest, targetUid }) {
  if (!guest.isAnonymous) throw httpError(400, "not_guest", "Yalnızca misafir hesabın verisi taşınabilir.");
  if (guest.uid === targetUid) throw httpError(400, "same_account", "Aynı hesap.");

  // Tek hedef kuralı: ilk taşıma hedefi kilitler; aynı hedefe tekrar çağrı serbest.
  const claimed = await redisSetNX(mergedKey(guest.uid), targetUid, MERGED_TTL);
  if (!claimed) {
    const owner = await redisGet(mergedKey(guest.uid));
    if (owner !== targetUid) throw httpError(409, "guest_already_merged", "Bu misafir verisi başka bir hesaba taşındı.");
  }

  const report = { recipes: 0, skippedRecipes: 0, pantry: 0, shoppingList: "none" };

  // Tarifler
  const guestRecipes = parseListOrThrow(await redisGet(`user:${guest.uid}:recipes`));
  if (guestRecipes.length) {
    const accepted = [];
    for (const r of guestRecipes) {
      if (!r || typeof r !== "object" || Array.isArray(r)) {
        report.skippedRecipes++;
        continue;
      }
      try {
        accepted.push(checkRecipeList([r], []).list[0]);
      } catch {
        report.skippedRecipes++;
      }
    }
    await mutateBucket(`user:${targetUid}:recipes`, {
      parse: parseListOrThrow,
      mutate: (list) => {
        const have = new Set(list.map((r) => r && r.id));
        const add = accepted.filter((r) => !have.has(r.id));
        report.recipes = add.length;
        return add.length ? [...list, ...add] : undefined;
      },
    });
  }

  // Kiler
  const guestPantry = parseListOrThrow(await redisGet(`user:${guest.uid}:pantry-items`));
  if (guestPantry.length) {
    await mutateBucket(`user:${targetUid}:pantry-items`, {
      parse: parseListOrThrow,
      mutate: (list) => {
        const have = new Set(list.map((x) => JSON.stringify(x)));
        const add = guestPantry.filter((x) => !have.has(JSON.stringify(x)));
        report.pantry = add.length;
        return add.length ? [...list, ...add] : undefined;
      },
    });
  }

  // Alışveriş listesi
  const guestShopping = parseObjectOrNull(await redisGet(`user:${guest.uid}:shopping-list`));
  if (!isEmptyShoppingList(guestShopping)) {
    await mutateBucket(`user:${targetUid}:shopping-list`, {
      parse: parseObjectOrNull,
      mutate: (current) => {
        if (!isEmptyShoppingList(current)) {
          report.shoppingList = "kept_existing";
          return undefined;
        }
        report.shoppingList = "copied";
        return guestShopping;
      },
    });
  }

  return report;
}
