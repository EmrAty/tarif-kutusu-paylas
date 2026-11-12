// Sunucu hata yanıtlarının istemcideki ortak sınıflandırması. App.jsx'teki
// authedFetch ve doğrudan fetch kullanan extractRecipe aynı kuralı izler:
//   1. "istemci eski" (426 / client_outdated / client_update_required) →
//      merkezi güncelleme kapısı tetiklenir (Yenile penceresi, yazımlar durur);
//   2. diğer her kod (input_too_large, rate_limited, free_recipe_limit,
//      version_conflict…) olduğu gibi err.code olarak korunur ve kapıya
//      DOKUNMAZ.
// Saf modül (i18n/Firebase yok) — node --test ile doğrudan sınanabilir.
import { appUpdateGate, isClientOutdatedResponse } from "./updateRequired.js";

// Sunucunun makine-okunur hata kodları → i18n anahtarı (bkz. api/_lib/aiGuard.js,
// api/extract.js, api/translate-recipe.js).
export const SERVER_ERROR_KEYS = {
  rate_limited: "errors.rateLimited",
  too_many_in_flight: "errors.tooManyInFlight",
  ai_capacity: "errors.aiCapacity",
  client_update_required: "errors.clientUpdateRequired",
  extract_failed: "errors.extractFailed",
  input_too_long: "errors.inputTooLong",
  input_too_large: "errors.inputTooLong",
  missing_input: "errors.needDescriptionOrImage",
  too_many_images: "errors.tooManyImages",
  image_too_large: "errors.imageTooLarge",
  images_total_too_large: "errors.imagesTotalTooLarge",
  image_unsupported: "errors.imageUnsupported",
  image_invalid: "errors.imageProcessFailed",
  // Aile (api/families.js, Grup 4)
  invite_invalid: "families.errorInviteInvalid",
  invite_rate_limited: "families.errorInviteRateLimited",
  sole_member: "families.errorSoleMember",
  not_owner: "families.errorNotOwner",
  member_not_found: "families.errorMemberNotFound",
  family_locked: "families.errorLocked",
};

export function serverErrorKey(code) {
  return (code && SERVER_ERROR_KEYS[code]) || null;
}

// Başarısız bir yanıtın gövdesini güvenle okur (JSON değilse {}).
export async function readErrorBody(response) {
  try {
    const data = await response.json();
    return data && typeof data === "object" ? data : {};
  } catch (e) {
    return {};
  }
}

// { outdated, code }: outdated ise kapı tetiklenmiştir.
export function classifyErrorResponse(status, body, { gate = appUpdateGate } = {}) {
  const code = body && typeof body.code === "string" ? body.code : null;
  if (isClientOutdatedResponse(status, body)) {
    gate.markRequired();
    return { outdated: true, code };
  }
  return { outdated: false, code };
}
