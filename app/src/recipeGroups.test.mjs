// Kişisel + aile kopyaları tek kartta; ilişki türetilmiş kimlikten, ad asla.
import test from "node:test";
import assert from "node:assert/strict";
import { groupCopies, copiesOf, groupIdOf } from "./recipeGroups.js";

const P = (id, extra = {}) => ({ id, title: "Menemen", _scopes: ["personal"], ...extra });
const F = (id, fam, extra = {}) => ({ id, title: "Menemen", _scopes: [fam], ...extra });

test("kişisel + iki aile kopyası tek grup; kart kişisel kopyayı açar", () => {
  const list = [F("r1-fam-F1", "F1"), P("r1"), F("r1-fam-F2", "F2"), P("r2")];
  const groups = groupCopies(list);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].primary.id, "r1");
  assert.deepEqual(groups[0].members.map((m) => m.id), ["r1-fam-F1", "r1", "r1-fam-F2"]);
  assert.deepEqual(copiesOf(list[2], list).map((m) => m.id), ["r1", "r1-fam-F1", "r1-fam-F2"]);
});

test("aynı adlı ama farklı kimlikli tarifler gruplanmaz", () => {
  const groups = groupCopies([P("r1"), P("r9"), F("r9x-fam-F1", "F1")]);
  assert.equal(groups.length, 3);
});

test("kopyalar farklı bölümdeyse (extraKey) ayrı kart; kilitli aile özeti gruplanmaz", () => {
  const list = [P("r1", { category: "Kahvaltı" }), F("r1-fam-F1", "F1", { category: "Tatlılar" }), F("r1-fam-F2", "F2", { _lockedFamily: true })];
  const groups = groupCopies(list, { extraKey: (r) => r.category || "" });
  assert.equal(groups.length, 3);
});

test("yalnızca ailede olan kopya kendi başına; eski aynı kimlikli bağlı kayıt tek kayıt", () => {
  assert.equal(groupIdOf(F("r5-fam-F1", "F1")), "r5");
  assert.equal(groupIdOf({ id: "r6", _scopes: ["personal", "F1"] }), "r6");
  assert.equal(groupIdOf(F("x-fam-F1", "F2")), "x-fam-F1", "başka ailenin son eki atılmaz");
});
