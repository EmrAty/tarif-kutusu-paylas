// Doğrulayıcının MANTIK testi — model kalitesinin ölçümü DEĞİL.
// "Doğru çıktı" olarak, kod ayrıştırıcısının gold'a göre TAM DOĞRU çıktığı tarifler kullanılır
// (kaynaktan birebir kopya). Sonra bilinen hatalar yapay olarak eklenir ve doğrulayıcının
// bunları yakalayıp yakalamadığı sayılır. Gerçek model çıktısı (yeniden yazılmış adımlar, düzeltilmiş
// adlar) bu testte YOK; gerçek yanlış-alarm oranı ancak ücretli denemede ölçülebilir.
import fs from "node:fs";
import { parseCaption } from "./codeParser.mjs";
import { verify } from "./verifier.mjs";
import { score } from "./evalCode.mjs";

const sets = [
  ["corpus.json", (await import("./gold.mjs")).GOLD],
  ["corpus-test.json", (await import("./gold-test.mjs")).GOLD],
];
const cases = [];
for (const [file, GOLD] of sets) {
  for (const c of JSON.parse(fs.readFileSync(new URL(`./${file}`, import.meta.url), "utf8"))) {
    const g = GOLD[c.id];
    if (g.kind !== "list" || !c.caption) continue;
    const p = parseCaption(c.caption);
    if (!score(p, g).correct) continue;
    cases.push({ id: c.id, lang: g.lang, caption: c.caption, recipe: { ingredients: p.ingredients.map((i) => ({ name: i.name, amount: i.amount })), instructions: p.instructions, assumptions: "" } });
  }
}
const clone = (r) => JSON.parse(JSON.stringify(r));
const corruptions = {
  "uydurma malzeme (varsayım yok)": (r) => (r.ingredients.push({ name: "kaymak", amount: "200 gr" }), r),
  "miktar değişti (×3+1)": (r) => {
    const i = r.ingredients.find((x) => /\d/.test(x.amount));
    if (!i) return null;
    i.amount = i.amount.replace(/\d+(?:[.,]\d+)?/, (n) => String(Number(n.replace(",", ".")) * 3 + 1));
    return r;
  },
  "miktar değişti (+1)": (r) => {
    const i = r.ingredients.find((x) => /\d/.test(x.amount));
    if (!i) return null;
    i.amount = i.amount.replace(/\d+/, (n) => String(Number(n) + 1));
    return r;
  },
  "malzeme düştü": (r) => {
    const k = r.ingredients.findIndex((x) => /\d/.test(x.amount));
    if (k === -1) return null;
    r.ingredients.splice(k, 1);
    return r;
  },
  "miktar silindi": (r) => {
    const i = r.ingredients.find((x) => /\d/.test(x.amount));
    if (!i) return null;
    i.amount = "";
    return r;
  },
  "yapılış silindi": (r) => (r.instructions.length ? ((r.instructions = []), r) : null),
};

let falseFail = 0;
const appLangOf = (c) => c.lang;
const baseline = [];
for (const c of cases) {
  const v = verify(c.caption, c.recipe, { appLang: appLangOf(c) });
  if (!v.pass) {
    falseFail++;
    if (process.argv.includes("--why")) console.log("  gereksiz red", c.id, [...v.failures, ...v.complex].slice(0, 3).join(" | "));
  } else baseline.push(c);
}
console.log(`Doğru (kaynaktan birebir) çıktılar: ${cases.length}; doğrulayıcı gereksiz reddetti: ${falseFail}`);
for (const [name, fn] of Object.entries(corruptions)) {
  let n = 0;
  let caught = 0;
  const missed = [];
  for (const c of baseline) {
    const r = fn(clone(c.recipe));
    if (!r) continue;
    n++;
    if (!verify(c.caption, r, { appLang: appLangOf(c) }).pass) caught++;
    else missed.push(c.id);
  }
  console.log(`${name}: ${caught}/${n} yakalandı (yalnız doğru çıktıyı geçirdiği tarifler)${missed.length ? ` (kaçan: ${missed.join(",")})` : ""}`);
}
