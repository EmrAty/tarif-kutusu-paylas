// Aynı tarifin kişisel ve aile kopyalarını genel listede TEK kartta göstermek.
// Saf modül (React yok) — node --test ile sınanır.
//
// Kopyalar bağımsız kayıtlardır (bkz. shared/recipeIds.js): aile kopyasının kimliği
// `<asılId>-fam-<aileId>`. Gruplama yalnızca bu türetilmiş kimliğe bakar (ad asla).
// Kart yalnızca görünümdür: düzenleme/silme/favori her zaman TEK bir kayda (kartın
// açtığı, ya da detayda seçilen kopyaya) uygulanır.
import { baseRecipeId } from "../shared/recipeIds.js";

const PERSONAL_DEFAULT = "personal";

// Kaydın asıl kimliği: hangi listedeyse o listenin son ekini atar.
export function groupIdOf(recipe, personalKey = PERSONAL_DEFAULT) {
  const scopes = recipe._scopes || [recipe._scope];
  for (const s of scopes) {
    if (s && s !== personalKey) {
      const base = baseRecipeId(recipe.id, s);
      if (base !== String(recipe.id)) return base;
    }
  }
  return String(recipe.id);
}

// recipes: kayıt listesi (her biri _scopes taşır). extraKey: aynı gruba girmek için
// ayrıca eşit olması gereken anahtar (ör. liste bölümü: kategorileri farklıysa kopyalar
// ayrı bölümlerde ayrı kart olur). Kilitli aile özetleri gruplanmaz.
// Dönen: [{ key, primary, members }] — primary: kişisel kopya varsa o, yoksa ilk kopya.
export function groupCopies(recipes, { personalKey = PERSONAL_DEFAULT, extraKey = () => "" } = {}) {
  const groups = new Map();
  const out = [];
  for (const r of recipes || []) {
    if (!r) continue;
    const key = r._lockedFamily ? `locked|${r.id}` : `${groupIdOf(r, personalKey)}|${extraKey(r)}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, primary: r, members: [] };
      groups.set(key, g);
      out.push(g);
    }
    g.members.push(r);
    const isPersonal = (r._scopes || [r._scope]).includes(personalKey);
    const primaryPersonal = (g.primary._scopes || [g.primary._scope]).includes(personalKey);
    if (isPersonal && !primaryPersonal) g.primary = r;
  }
  return out;
}

// Bir kaydın bütün kopyaları (kendisi dahil), kişisel önce.
export function copiesOf(recipe, recipes, personalKey = PERSONAL_DEFAULT) {
  if (!recipe || recipe._lockedFamily) return recipe ? [recipe] : [];
  const id = groupIdOf(recipe, personalKey);
  const list = (recipes || []).filter((r) => r && !r._lockedFamily && groupIdOf(r, personalKey) === id);
  const isPersonal = (r) => (r._scopes || [r._scope]).includes(personalKey);
  return [...list.filter(isPersonal), ...list.filter((r) => !isPersonal(r))];
}
