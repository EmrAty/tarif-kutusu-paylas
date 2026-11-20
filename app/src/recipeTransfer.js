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
import { familyCopyId } from "../shared/recipeIds.js";
import { groupIdOf } from "./recipeGroups.js";

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
// baseId: tarifin asıl kimliği (kişisel kopyanın kimliği). Kaynak bir aile kopyası
// olabilir (yalnızca kopyalama): yeni aile kopyası yine asıl kimlikten türetilir ki
// bütün kopyalar tek grupta kalsın. Taşıma yalnızca kişisel kaynaktan yapılır.
export async function transferRecipe({ recipe, baseId, familyIds, mode, mutate, verify, personalKey, beforeRemove }) {
  const clean = storableRecipe(recipe);
  const base = baseId != null ? String(baseId) : String(clean.id);
  if (mode === "move" && base !== String(clean.id)) throw new Error("move_requires_personal_source");
  const copyFor = (familyId) => ({ ...clean, id: familyCopyId(base, familyId) });
  const targets = [...new Set(familyIds)].filter((k) => k && k !== personalKey);
  const saved = [];
  const existing = [];
  const failed = [];
  await Promise.all(
    targets.map(async (familyId) => {
      const copy = copyFor(familyId);
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
        ok = !!verify && (await verify(familyId, copyFor(familyId).id));
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

// Bir tarif kartı/ekranı için yapılabilecek taşıma/kopyalama işlemleri. Seçili kopya
// hangisi olursa olsun (kişisel ya da aile kopyası) aynı gruptan hesaplanır; böylece
// kopyalamadan sonra aile kopyasına geçince ya da "taşımayı tamamla" için düğme kaybolmaz.
//  - Kaynak: grubun kilitsiz kişisel kopyası; yoksa (taşınmış tarif) seçili aile kopyası.
//  - Taşı / Taşımayı tamamla: yalnızca kişisel kaynakta. Kopyası olan aile de listelenir
//    ("kopyası var"; kopyalama ona yazmaz).
//  - Yalnızca aile kopyası varsa: kopyası olmayan diğer erişilebilir ailelere Kopyala.
// copies: grubun erişilebilir kopyaları (copiesOf); families: [{ id, name }] (Plus ile
// erişilen aileler); familyHasCopy(familyId, copyId) → boolean; isLocked(recipe) → boolean.
// Yapılacak bir işlem yoksa null.
export function transferOptions({ record, copies, families, personalKey, familyHasCopy, isLocked = () => false }) {
  if (!record || record._lockedFamily || !families || !families.length) return null;
  const scopesOf = (r) => r._scopes || [r._scope];
  const list = (copies && copies.length ? copies : [record]).filter((r) => r && !r._lockedFamily);
  const personal = list.find((r) => scopesOf(r).includes(personalKey) && !isLocked(r));
  if (!personal && list.some((r) => scopesOf(r).includes(personalKey))) return null; // kişisel kopya kilitli
  const source = personal || (isLocked(record) ? null : record);
  if (!source) return null;
  const baseId = personal ? String(personal.id) : groupIdOf(source, personalKey);
  // Grubun herhangi bir kopyasının bulunduğu aileler (eski, aynı kimlikli kayıtlar dahil).
  const covered = new Set(list.flatMap(scopesOf));
  const options = families
    .filter((f) => f && f.id && !scopesOf(source).includes(f.id))
    .map((f) => ({ id: f.id, name: f.name, hasCopy: covered.has(f.id) || !!(familyHasCopy && familyHasCopy(f.id, familyCopyId(baseId, f.id))) }));
  const canMove = !!personal;
  const shown = canMove ? options : options.filter((o) => !o.hasCopy);
  if (!shown.length) return null;
  return { sourceId: source.id, sourceScope: canMove ? personalKey : scopesOf(source)[0], baseId, canMove, families: shown };
}
