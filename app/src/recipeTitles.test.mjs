// Ortak tarif adı: bütün yazılabilir kopyalar, kilitli olanlar raporlanır, kısmi hatada güvenli tekrar.
import test from "node:test";
import assert from "node:assert/strict";
import { titleTargets, writeTitle, setTitleIfPresent } from "./recipeTitles.js";

const P = { id: "r1", title: "Pilav", ingredients: [{ name: "Pirinç", amount: "1" }], _scopes: ["personal"] };
const F1 = { id: "r1-fam-F1", title: "Pilav", ingredients: [{ name: "Pirinç", amount: "2" }], _scopes: ["F1"] };
const F2 = { id: "r1-fam-F2", title: "Pilav", _scopes: ["F2"], _lockedFamily: true };
const OTHER = { id: "r9", title: "Pilav", _scopes: ["personal"] }; // aynı ad, ilgisiz tarif

function store(initial, fail = new Set()) {
  const lists = new Map(Object.entries(initial));
  const mutate = async (scopeKey, updater) => {
    if (fail.has(scopeKey)) throw Object.assign(new Error("403"), { status: 403 });
    lists.set(scopeKey, updater(lists.get(scopeKey) || []));
  };
  return { lists, mutate };
}

test("titleTargets: kişisel + aile kopyaları (kimlikle, adla değil); kilitli aile ve Free kilitli kopya yazılmaz", () => {
  const out = titleTargets(F1, [P, F1, F2, OTHER], { personalKey: "personal" });
  assert.deepEqual(out.targets, [
    { id: "r1", scopeKey: "personal" },
    { id: "r1-fam-F1", scopeKey: "F1" },
  ]);
  assert.deepEqual(out.locked, ["F2"]);
  const locked = titleTargets(P, [P, F1], { personalKey: "personal", isLocked: (r) => r.id === "r1" });
  assert.deepEqual(locked.targets, [{ id: "r1-fam-F1", scopeKey: "F1" }]);
  assert.deepEqual(locked.locked, ["personal"]);
});

test("writeTitle: yalnız ad değişir, içerik kopyaya özel kalır; kısmi hata yalnız başarısız kopyada tekrar edilir", async () => {
  const fail = new Set(["F1"]);
  const s = store({ personal: [{ ...P, _scopes: undefined }], F1: [{ ...F1, _scopes: undefined }] }, fail);
  const targets = titleTargets(P, [P, F1], { personalKey: "personal" }).targets;
  const first = await writeTitle(targets, "Tereyağlı Pilav", s.mutate);
  assert.deepEqual(first.saved, [{ id: "r1", scopeKey: "personal" }]);
  assert.deepEqual(first.failed.map((f) => f.scopeKey), ["F1"]);
  assert.equal(s.lists.get("personal")[0].title, "Tereyağlı Pilav");
  assert.equal(s.lists.get("F1")[0].title, "Pilav", "erişilemeyen kopya değişmedi");
  fail.clear();
  const retry = await writeTitle(first.failed, "Tereyağlı Pilav", s.mutate);
  assert.deepEqual(retry.failed, []);
  assert.equal(s.lists.get("F1")[0].title, "Tereyağlı Pilav");
  assert.equal(s.lists.get("F1")[0].ingredients[0].amount, "2", "aile kopyasının içeriği korunur");
  assert.equal(s.lists.get("personal")[0].ingredients[0].amount, "1");
});

test("setTitleIfPresent: silinmiş kopyayı yeniden oluşturmaz; aynı ad listeyi değiştirmez", () => {
  const list = [{ id: "a", title: "X" }];
  assert.equal(setTitleIfPresent("b", "Y")(list), list);
  assert.equal(setTitleIfPresent("a", "X")(list), list);
  assert.deepEqual(setTitleIfPresent("a", "Y")(list), [{ id: "a", title: "Y" }]);
});
