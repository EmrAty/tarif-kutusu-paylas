// Kod ayrıştırıcısını gold etiketlere karşı ölçer. Ağ yok, AI yok.
import fs from "node:fs";
import { parseCaption, gate } from "./codeParser.mjs";
const TEST = process.argv.includes("--test");
const { GOLD } = await import(TEST ? "./gold-test.mjs" : "./gold.mjs");

const corpus = JSON.parse(fs.readFileSync(new URL(TEST ? "./corpus-test.json" : "./corpus.json", import.meta.url), "utf8"));
const lower = (s) => String(s || "").toLocaleLowerCase("tr");
const normAmt = (s) =>
  lower(s)
    .replace(/\([^)]*\)/g, " ")
    .replace(/½/g, "1/2").replace(/¼/g, "1/4").replace(/¾/g, "3/4")
    .replace(/(?<![\p{L}])yarım(?![\p{L}])/gu, "1/2").replace(/(?<![\p{L}])bir(?![\p{L}])/gu, "1")
    .replace(/^(yaklaşık|about|approx\.?|around|en az|~)\s*/u, "")
    .replace(/,/g, ".").replace(/\s+/g, " ").trim();

export function score(parsed, g) {
  const used = new Set();
  const misses = [];
  for (const [ga, gk] of g.ing) {
    const idx = parsed.ingredients.findIndex((p, i) => {
      if (used.has(i)) return false;
      const nameOk = lower(`${p.name} ${p.amount}`).includes(gk);
      const amountOk = ga === "" ? true : normAmt(p.amount).startsWith(normAmt(ga)) || normAmt(`${p.amount} ${p.name}`).startsWith(normAmt(ga));
      return nameOk && amountOk;
    });
    if (idx === -1) misses.push(`${ga} ${gk}`.trim());
    else used.add(idx);
  }
  const spurious = parsed.ingredients.filter((_, i) => !used.has(i)).map((p) => `${p.amount}|${p.name}`);
  const instr = lower(parsed.instructions.join(" "));
  let stepsOk;
  let stepsNote = "";
  if (g.steps === null) {
    stepsOk = parsed.instructions.length === 0;
    if (!stepsOk) stepsNote = "kaynakta yapılış yokken yapılış üretildi";
  } else {
    const missing = g.steps.filter((s) => !instr.includes(s));
    const leaked = (g.tips || []).filter((s) => instr.includes(s));
    stepsOk = missing.length === 0 && leaked.length === 0;
    if (missing.length) stepsNote += `eksik adım: ${missing.join("; ")} `;
    if (leaked.length) stepsNote += `yapılışa karışan: ${leaked.join("; ")}`;
  }
  const extrasMissing = (g.extra || []).filter((e) => !parsed.ingredients.some((p) => lower(p.name).includes(e)));
  return {
    recall: g.ing.length ? (g.ing.length - misses.length) / g.ing.length : 1,
    misses, spurious, stepsOk, stepsNote, extrasMissing,
    correct: misses.length === 0 && spurious.length === 0 && stepsOk,
  };
}

const MAIN = (process.argv[1] || "").endsWith("evalCode.mjs");
const rows = [];
if (MAIN) {
for (const c of corpus) {
  const g = GOLD[c.id];
  const t0 = process.hrtime.bigint();
  const parsed = parseCaption(c.caption || "");
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const strictSame = gate(parsed, { appLang: g.lang, mode: "strict" });
  const lenientSame = gate(parsed, { appLang: g.lang, mode: "lenient" });
  const strictTr = gate(parsed, { appLang: "tr", mode: "strict" });
  const s = g.kind === "list" ? score(parsed, g) : null;
  rows.push({ id: c.id, kind: g.kind, lang: g.lang, ms, parsed, s, strictSame, lenientSame, strictTr });
}

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(0)}%` : "-");
function summarize(label, pick) {
  const acc = rows.filter((r) => pick(r).accept);
  const good = acc.filter((r) => r.s?.correct);
  const bad = acc.filter((r) => !r.s?.correct);
  const lists = rows.filter((r) => r.kind === "list");
  const extrasLost = good.filter((r) => r.s.extrasMissing.length);
  console.log(
    `${label}: kabul ${acc.length}/${rows.length} (${pct(acc.length, rows.length)}); liste tariflerinin ${pct(acc.filter((r) => r.kind === "list").length, lists.length)}'i | ` +
      `kabul edilip DOĞRU ${good.length}, kabul edilip YANLIŞ ${bad.length} [${bad.map((r) => r.id).join(",")}]` +
      (extrasLost.length ? ` | doğru ama yapılıştaki ek malzeme yok: ${extrasLost.map((r) => r.id).join(",")}` : "")
  );
  return { acc, good, bad };
}

const allLists = rows.filter((r) => r.kind === "list");
console.log(`Derlem: ${rows.length} açıklama (${allLists.length} liste, ${rows.filter((r) => r.kind === "prose").length} düzyazı, ${rows.filter((r) => r.kind === "insufficient").length} tarifsiz)`);
console.log(`Kapıdan bağımsız ayrıştırma doğruluğu (yalnız liste tarifleri): tam doğru ${allLists.filter((r) => r.s.correct).length}/${allLists.length}, ortalama malzeme recall ${(allLists.reduce((a, r) => a + r.s.recall, 0) / allLists.length).toFixed(2)}`);
console.log(`Ayrıştırma süresi: ort ${(rows.reduce((a, r) => a + r.ms, 0) / rows.length).toFixed(2)} ms, en çok ${Math.max(...rows.map((r) => r.ms)).toFixed(2)} ms`);
summarize("Katı kapı, uygulama dili = açıklama dili", (r) => r.strictSame);
summarize("Gevşek kapı, uygulama dili = açıklama dili", (r) => r.lenientSame);
summarize("Katı kapı, uygulama TR (EN açıklama → model)", (r) => r.strictTr);

if (process.argv.includes("--detail")) {
  for (const r of rows) {
    console.log(`\n--- ${r.id} [${r.kind}/${r.lang}] strict=${r.strictSame.accept} lenient=${r.lenientSame.accept} ${r.s ? `correct=${r.s.correct} recall=${r.s.recall.toFixed(2)}` : ""}`);
    if (!r.strictSame.accept) console.log("  red:", r.strictSame.reasons.slice(0, 4).join(" | "));
    if (r.s && !r.s.correct) console.log("  eksik:", r.s.misses.join(" / "), "| fazla:", r.s.spurious.join(" / "), "|", r.s.stepsNote);
  }
}
fs.writeFileSync(new URL(TEST ? "./results-code-test.json" : "./results-code.json", import.meta.url), JSON.stringify(rows.map(({ parsed, ...r }) => ({ ...r, title: parsed.title, ingredients: parsed.ingredients.map((i) => [i.amount, i.name, i.section]), instructions: parsed.instructions })), null, 1));
}
