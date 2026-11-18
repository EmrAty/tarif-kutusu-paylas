// Kişisel listedeki bir tarifi aileye/ailelere taşıma ya da kopyalama.
// Saf modül (React/Firebase yok) — node --test ile sınanır.
//
// Uygulama bir tarifi birden fazla listede AYNI id ile tutar (kart tekilleşir,
// düzenleme her kopyaya yansır; bkz. App.jsx `recipes`). Kopyalama = tarif
// nesnesinin aynısını aile listesine eklemek; taşıma = önce aileye ekle, ancak
// seçilen HER aileye yazıldıysa kişisel kopyayı kaldır. Böylece:
//  - aileye yazım başarısızsa kişisel tarif asla kaybolmaz;
//  - tekrar deneme kopya üretmez (aynı id zaten varsa liste değişmez);
//  - malzemeler, bölümler, püf noktaları, tahmini miktar işaretleri ve porsiyon
//    alanları olduğu gibi taşınır (nesne kopyalanır, alan seçilmez).
// Aile yetkisi ve Plus kilidi sunucuda (/api/data) uygulanır; reddedilen yazım
// burada "failed" olarak döner.
import { saveRecipeToTargets } from "./saveTargets.js";

// Görünüm alanları (_scopes, _translation, _origTitle …) kayda girmez.
export function storableRecipe(recipe) {
  const out = {};
  for (const [key, value] of Object.entries(recipe || {})) {
    if (!key.startsWith("_")) out[key] = value;
  }
  return out;
}

export const removeRecipeById = (id) => (list) => (list.some((r) => r && r.id === id) ? list.filter((r) => !(r && r.id === id)) : list);

// mode: "move" | "copy". mutate(scopeKey, updater) → Promise.
// Dönüş: { saved: [familyId], failed: [{ scopeKey, error }], removedFromPersonal, removeError }
export async function transferRecipe({ recipe, familyIds, mode, mutate, personalKey }) {
  const clean = storableRecipe(recipe);
  const targets = [...new Set(familyIds)].filter((k) => k && k !== personalKey);
  const { saved, failed } = await saveRecipeToTargets(clean, targets, mutate, personalKey);
  let removedFromPersonal = false;
  let removeError = null;
  if (mode === "move" && targets.length > 0 && failed.length === 0) {
    try {
      await mutate(personalKey, removeRecipeById(clean.id));
      removedFromPersonal = true;
    } catch (error) {
      removeError = error;
    }
  }
  return { saved, failed, removedFromPersonal, removeError };
}
