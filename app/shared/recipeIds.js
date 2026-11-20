// Aile kopyalarının kimliği (istemci + sunucu ortak).
//
// Aynı anda kişisel + aileye kaydedilen ya da kişisel listeden aileye
// kopyalanan tarif her listede BAĞIMSIZ bir kayıttır: ailede düzenleme/silme
// kişisel tarifi etkilemez, tersi de. Bunun için her aile kopyası kendi
// kimliğini alır. Kimlik rastgele değil, asıl kimlikten türetilir:
// `<asılId>-fam-<aileId>`. Böylece "Tekrar dene" ya da ikinci kopyalama aynı
// kimliği üretir ve hedef listede zaten varsa hiçbir şey eklenmez (kopya
// çoğalmaz, AI'a yeniden gidilmez).
// Kişisel kopya asıl kimliği korur.

const SEP = "-fam-";

export function familyCopyId(baseId, familyId) {
  const base = String(baseId);
  if (!familyId) return baseId;
  const suffix = `${SEP}${familyId}`;
  return base.endsWith(suffix) ? base : `${base}${suffix}`;
}

// familyId boşsa (kişisel) tarif olduğu gibi döner.
export function recipeForFamily(recipe, familyId) {
  if (!familyId) return recipe;
  return { ...recipe, id: familyCopyId(recipe.id, familyId) };
}

// Aile kopyasının asıl kimliği (kişisel kopyanın kimliği). İlişki yalnızca
// türetilmiş kimlikten kurulur, tarif adından asla. scopeKey kişiselse kimlik aynen döner.
export function baseRecipeId(id, scopeKey) {
  const s = String(id);
  if (!scopeKey) return s;
  const suffix = `${SEP}${scopeKey}`;
  return s.endsWith(suffix) && s.length > suffix.length ? s.slice(0, -suffix.length) : s;
}
