// /api/data ile yazılan tarif listelerinin sunucu tarafı denetimi (Grup 5).
//
// İstemci tüm listeyi yazar; bu yüzden denetim yalnızca YENİ ya da DEĞİŞMİŞ
// tariflere uygulanır. Eski kayıtlar (ör. sınırdan önce yazılmış büyük bir tarif)
// listenin başka bir yerindeki değişikliği engellemez; dokunulduklarında denetlenir.
//  - link: yalnızca güvenli http(s) (bkz. shared/safeLink.js). Güvensiz link
//    reddedilmez, SİLİNİR: liste yazımı (ör. eski bir aile kaydı yüzünden) kilitlenmesin.
//    Eski kayıtlardaki güvensiz link istemcide de hiçbir zaman href olmaz.
//  - id: boş olmayan metin (≤ 100) ya da sayı; yoksa 400.
//  - boyut: tek tarifin JSON'u en çok MAX_RECIPE_CHARS; aşarsa 413.
import { safeRecipeLink } from "../../shared/safeLink.js";

// Claude'un çıkardığı gerçekçi büyük bir tarif ~6–7 bin karakter (bkz.
// translate-recipe.js). 64 bin bunun ~10 katı; görsel/base64 gibi şeylerin
// listeye gömülmesini ve tek tarifle Redis değerinin şişirilmesini engeller.
export const MAX_RECIPE_CHARS = 64_000;
const MAX_ID_CHARS = 100;

const validId = (id) =>
  (typeof id === "string" && id.length > 0 && id.length <= MAX_ID_CHARS) || (typeof id === "number" && Number.isFinite(id));

function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

// next: istemcinin gönderdiği liste (her eleman düz nesne, parseIncoming denetledi)
// previous: aynı anın kayıtlı listesi. Dönen { list, sanitized } yazılacak listedir.
export function checkRecipeList(next, previous) {
  const before = new Map();
  for (const r of Array.isArray(previous) ? previous : []) {
    if (r && typeof r === "object" && r.id != null) before.set(r.id, JSON.stringify(r));
  }
  let sanitized = 0;
  const list = next.map((recipe) => {
    const serialized = JSON.stringify(recipe);
    if (recipe.id != null && before.get(recipe.id) === serialized) return recipe; // değişmemiş eski kayıt
    if (!validId(recipe.id)) throw httpError(400, "invalid_recipe", "Tarif kaydı geçersiz.");
    if (serialized.length > MAX_RECIPE_CHARS) throw httpError(413, "recipe_too_large", "Tarif çok büyük; kaydedilemedi.");
    if (recipe.link !== undefined && recipe.link !== null && recipe.link !== "") {
      const safe = safeRecipeLink(recipe.link);
      if (!safe) {
        sanitized++;
        const { link, ...rest } = recipe;
        return rest;
      }
    }
    return recipe;
  });
  return { list, sanitized };
}
