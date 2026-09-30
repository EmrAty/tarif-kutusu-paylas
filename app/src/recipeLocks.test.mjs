import { test } from "node:test";
import assert from "node:assert/strict";
import { recipeAddedAt, compareByAddedAt, lockedRecipeIds } from "./recipeLocks.js";

const LIMIT = 15;
// Liste sunucudaki gibi yeniden eskiye (yeni tarif başa ekleniyor).
const make = (n, start = 1_700_000_000_000) =>
  Array.from({ length: n }, (_, i) => ({ id: `${start + i * 1000}-abc${i}`, createdAt: start + i * 1000, title: `t${i}` })).reverse();
const oldestIds = (list, k) => [...list].sort(compareByAddedAt).slice(0, k).map((r) => r.id);

test("Free 14 ve 15 tarif: kilit yok", () => {
  assert.equal(lockedRecipeIds(make(14), { isPlus: false, limit: LIMIT }).size, 0);
  assert.equal(lockedRecipeIds(make(15), { isPlus: false, limit: LIMIT }).size, 0);
});

test("Free 16 / 20 / 80: en eski 15 açık, en yeniler kilitli", () => {
  for (const n of [16, 20, 80]) {
    const list = make(n);
    const locked = lockedRecipeIds(list, { isPlus: false, limit: LIMIT });
    assert.equal(locked.size, n - LIMIT, `n=${n}`);
    for (const id of oldestIds(list, LIMIT)) assert.ok(!locked.has(id), `en eski açık olmalı n=${n}`);
    const newest = [...list].sort(compareByAddedAt).slice(LIMIT).map((r) => r.id);
    for (const id of newest) assert.ok(locked.has(id));
  }
});

test("Plus: 20 ve 500 tarifte kilit yok", () => {
  assert.equal(lockedRecipeIds(make(20), { isPlus: true, limit: LIMIT }).size, 0);
  assert.equal(lockedRecipeIds(make(500), { isPlus: true, limit: LIMIT }).size, 0);
});

test("Açık bir tarif silinince kilitlilerin en eskisi açılır", () => {
  const list = make(20);
  const before = lockedRecipeIds(list, { isPlus: false, limit: LIMIT });
  const oldest = oldestIds(list, 1)[0];
  const firstLocked = [...list].sort(compareByAddedAt)[LIMIT].id;
  assert.ok(before.has(firstLocked));
  const after = lockedRecipeIds(list.filter((r) => r.id !== oldest), { isPlus: false, limit: LIMIT });
  assert.equal(after.size, 4);
  assert.ok(!after.has(firstLocked), "önce kilitli olan en eski tarif açılmalı");
});

test("Sonuç liste sırasından bağımsız (deterministik)", () => {
  const list = make(20);
  const shuffled = [...list].sort((a, b) => (a.title < b.title ? 1 : -1));
  assert.deepEqual([...lockedRecipeIds(list, { isPlus: false, limit: LIMIT })].sort(), [...lockedRecipeIds(shuffled, { isPlus: false, limit: LIMIT })].sort());
});

test("Aynı createdAt: id ikinci anahtar", () => {
  const same = Array.from({ length: 17 }, (_, i) => ({ id: `r-${String(i).padStart(2, "0")}`, createdAt: 5 }));
  const locked = lockedRecipeIds(same.reverse(), { isPlus: false, limit: LIMIT });
  assert.deepEqual([...locked].sort(), ["r-15", "r-16"]);
});

test("Tarih fallback: createdAt yoksa id'deki zaman, o da yoksa en eski (0)", () => {
  assert.equal(recipeAddedAt({ id: "1790000000000-ab12cd", createdAt: 1234 }), 1234);
  assert.equal(recipeAddedAt({ id: "1790000000000-ab12cd" }), 1790000000000);
  assert.equal(recipeAddedAt({ id: "1790000000000-ab12cd", createdAt: "bozuk" }), 1790000000000);
  assert.equal(recipeAddedAt({ id: "eski-tarif" }), 0);
  assert.equal(recipeAddedAt({}), 0);
  // Tarihsiz eski kayıtlar en eskiler arasında sayılır, yani açık kalır.
  const list = [...make(15), { id: "legacy-a" }, { id: "legacy-b" }];
  const locked = lockedRecipeIds(list, { isPlus: false, limit: LIMIT });
  assert.ok(!locked.has("legacy-a") && !locked.has("legacy-b"));
  assert.equal(locked.size, 2);
});
