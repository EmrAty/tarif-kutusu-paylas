import test from "node:test";
import assert from "node:assert/strict";
import { fetchAllTitles } from "./titleTranslation.js";

const mkWanted = (n) => Array.from({ length: n }, (_, i) => `Başlık ${i}`);

// Sahte sunucu: önbellekte olanları da döndürür, her turda en çok `per` yeni başlık çevirir.
function fakeServer(wanted, per = 60) {
  const done = {};
  let calls = 0;
  return {
    get calls() { return calls; },
    request: async () => {
      calls++;
      const todo = wanted.filter((t) => !(t in done)).slice(0, per);
      todo.forEach((t) => (done[t] = `T:${t}`));
      return { titles: { ...done }, translated: todo.length, skipped: 0 };
    },
  };
}

test("150 başlık: 3 istekle hepsi çevrilir", async () => {
  const wanted = mkWanted(150);
  const s = fakeServer(wanted);
  const r = await fetchAllTitles({ wanted, request: s.request });
  assert.equal(s.calls, 3);
  assert.equal(r.complete, true);
  assert.equal(Object.keys(r.titles).length, 150);
});

test("60 ve altı: tek istek", async () => {
  const wanted = mkWanted(60);
  const s = fakeServer(wanted);
  const r = await fetchAllTitles({ wanted, request: s.request });
  assert.equal(s.calls, 1);
  assert.equal(r.complete, true);
});

test("ilerleme yoksa tek istekte durur", async () => {
  let calls = 0;
  const r = await fetchAllTitles({ wanted: mkWanted(10), request: async () => (calls++, { titles: {}, translated: 0, skipped: 0 }) });
  assert.equal(calls, 1);
  assert.equal(r.complete, false);
});

test("sunucu 'translated' dese de yeni başlık gelmezse durur", async () => {
  let calls = 0;
  const r = await fetchAllTitles({ wanted: mkWanted(100), request: async () => (calls++, { titles: { "Başlık 0": "A" }, translated: 60 }) });
  assert.equal(calls, 2);
  assert.equal(Object.keys(r.titles).length, 1);
});

test("hata: durur, eldeki kısmi sonuç korunur", async () => {
  const wanted = mkWanted(150);
  const s = fakeServer(wanted);
  let n = 0;
  const r = await fetchAllTitles({
    wanted,
    request: () => (++n === 2 ? Promise.reject(new Error("429")) : s.request()),
  });
  assert.equal(n, 2);
  assert.equal(r.complete, false);
  assert.equal(Object.keys(r.titles).length, 60);
  assert.equal(r.error.message, "429");
});

test("tur üst sınırı aşılmaz", async () => {
  const wanted = mkWanted(1000);
  const s = fakeServer(wanted, 1);
  const r = await fetchAllTitles({ wanted, request: s.request, maxRounds: 4 });
  assert.equal(s.calls, 4);
  assert.equal(r.rounds, 4);
  const d = await fetchAllTitles({ wanted, request: fakeServer(wanted, 1).request });
  assert.equal(d.rounds, 10);
});

test("aynı başlık tekrarı tek sayılır", async () => {
  const s = fakeServer(["A"]);
  const r = await fetchAllTitles({ wanted: ["A", "A", "A"], request: s.request });
  assert.equal(s.calls, 1);
  assert.equal(r.complete, true);
});
