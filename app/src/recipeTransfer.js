// Kişisel listedeki bir tarifi aileye/ailelere taşıma ya da kopyalama.
// Saf modül (React/Firebase yok) — node --test ile sınanır.
//
// Aile kopyası BAĞIMSIZ bir kayıttır: asıl kimlikten türetilmiş kendi kimliği
// vardır (bkz. shared/recipeIds.js), ailede düzenleme/silme kişisel tarifi
// etkilemez, tersi de. Kurallar:
//  - Kopyala: ailede bu tarifin kopyası yoksa eklenir; varsa DOKUNULMAZ (çoğalmaz,
//    sonradan düzenlenmiş aile kopyasının üzerine yazılmaz) ve "zaten vardı" döner.
//  - Taşı: önce aynı kopyalama; sonra her seçilen ailede kopyanın GERÇEKTEN var ve
//    erişilebilir olduğu sunucudan taze okunarak doğrulanır (verify). Ancak hepsi
//    doğrulanırsa kişisel kayıt kaldırılır. Bu, daha önce kopyalanmış bir tarifte
//    "taşımayı tamamla" (yalnızca kişiseli kaldır) anlamına da gelir; mevcut aile
//    kopyası korunur.
//  - Aileye yazım ya da doğrulama başarısızsa kişisel tarif asla kaybolmaz.
// Malzemeler, bölümler, püf noktaları, kategori ve porsiyon alanları olduğu gibi
// taşınır (nesne kopyalanır, alan seçilmez). Aile yetkisi ve Plus kilidi sunucuda
// (/api/data) uygulanır; reddedilen yazım burada "failed" olarak döner.
import { recipeForFamily } from "../shared/recipeIds.js";

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
// verify(familyId, copyId) → Promise<boolean>: sunucudan taze okuma; yalnızca taşımada.
// Dönen: { saved: [familyId], existing: [familyId], failed: [{ scopeKey, error }],
//          verifyFailed: [familyId], removedFromPersonal, removeError }
// beforeRemove(): kişisel kayıt kaldırılmadan hemen önce (ör. ekranı aile kopyasına geçirmek için).
export async function transferRecipe({ recipe, familyIds, mode, mutate, verify, personalKey, beforeRemove }) {
  const clean = storableRecipe(recipe);
  const targets = [...new Set(familyIds)].filter((k) => k && k !== personalKey);
  const saved = [];
  const existing = [];
  const failed = [];
  await Promise.all(
    targets.map(async (familyId) => {
      const copy = recipeForFamily(clean, familyId);
      let had = false;
      try {
        await mutate(familyId, (list) => {
          had = list.some((r) => r && r.id === copy.id);
          return had ? list : [copy, ...list];
        });
        saved.push(familyId);
        if (had) existing.push(familyId);
      } catch (error) {
        failed.push({ scopeKey: familyId, error });
      }
    })
  );
  const order = (k) => targets.indexOf(k);
  saved.sort((a, b) => order(a) - order(b));
  existing.sort((a, b) => order(a) - order(b));
  failed.sort((a, b) => order(a.scopeKey) - order(b.scopeKey));

  let removedFromPersonal = false;
  let removeError = null;
  const verifyFailed = [];
  if (mode === "move" && targets.length > 0 && failed.length === 0) {
    for (const familyId of targets) {
      let ok = false;
      try {
        ok = !!verify && (await verify(familyId, recipeForFamily(clean, familyId).id));
      } catch {
        ok = false;
      }
      if (!ok) verifyFailed.push(familyId);
    }
    if (verifyFailed.length === 0) {
      try {
        if (beforeRemove) beforeRemove(targets[0]);
        await mutate(personalKey, removeRecipeById(clean.id));
        removedFromPersonal = true;
      } catch (error) {
        removeError = error;
      }
    }
  }
  return { saved, existing, failed, verifyFailed, removedFromPersonal, removeError };
}
