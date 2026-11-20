// Tarif adı kopyalar arasında ORTAKTIR (20 Kasım kararı): kişisel ve aile kopyalarından
// birinin adı değişince, kullanıcının yazabildiği bütün kopyalarda değişir. İçerik
// düzenleme, favori ve silme yalnızca seçili kopyaya uygulanmaya devam eder.
// Saf modül (React/Firebase yok) — node --test ile sınanır.
//
// Yetki aşılmaz: kilitli kopyalar (Plus'ı kapalı aile özeti, Free sınırı üstündeki kişisel
// tarif) hiç yazılmaz, "kilitli" diye raporlanır. Aile yazımları sunucuda yine
// üyelik + Plus denetiminden geçer; reddedilen yazım "failed" döner ve yalnızca o
// kopyalar yeniden denenir. Yazım yalnızca kayıt hâlâ varsa adı değiştirir (silinmiş
// kopya yeniden oluşmaz); aynı ad zaten yazılıysa liste değişmez (tekrar deneme güvenli).
import { groupIdOf } from "./recipeGroups.js";

// record: ekranda açık kopya; recipes: birleşik liste (_scopes, _lockedFamily taşır).
// Dönen: { targets: [{ id, scopeKey }], locked: [scopeKey] }
export function titleTargets(record, recipes, { personalKey, isLocked = () => false } = {}) {
  if (!record) return { targets: [], locked: [] };
  const gid = groupIdOf(record, personalKey);
  const targets = [];
  const locked = [];
  const seen = new Set();
  for (const r of recipes || []) {
    if (!r || groupIdOf(r, personalKey) !== gid) continue;
    for (const scopeKey of r._scopes || [r._scope]) {
      const k = `${scopeKey}|${r.id}`;
      if (!scopeKey || seen.has(k)) continue;
      seen.add(k);
      if (r._lockedFamily || isLocked(r)) locked.push(scopeKey);
      else targets.push({ id: r.id, scopeKey });
    }
  }
  if (!targets.length && !locked.length) targets.push(...(record._scopes || [record._scope]).map((scopeKey) => ({ id: record.id, scopeKey })));
  return { targets, locked: [...new Set(locked)] };
}

export const setTitleIfPresent = (id, title) => (list) => {
  const i = list.findIndex((r) => r && r.id === id);
  if (i < 0 || list[i].title === title) return list;
  const next = list.slice();
  next[i] = { ...list[i], title };
  return next;
};

// mutate(scopeKey, updater) → Promise. Hiçbir hata dışarı fırlatılmaz.
// Dönen: { saved: [{ id, scopeKey }], failed: [{ id, scopeKey, error }] }
export async function writeTitle(targets, title, mutate) {
  const saved = [];
  const failed = [];
  await Promise.all(
    (targets || []).map(async (t) => {
      try {
        await mutate(t.scopeKey, setTitleIfPresent(t.id, title));
        saved.push({ id: t.id, scopeKey: t.scopeKey });
      } catch (error) {
        failed.push({ id: t.id, scopeKey: t.scopeKey, error });
      }
    })
  );
  const order = (t) => (targets || []).findIndex((x) => x.scopeKey === t.scopeKey && x.id === t.id);
  saved.sort((a, b) => order(a) - order(b));
  failed.sort((a, b) => order(a) - order(b));
  return { saved, failed };
}
