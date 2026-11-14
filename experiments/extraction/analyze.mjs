// results-models.json + ledger.json → kaynak-temelli kalite, maliyet, süre ve yönlendirici simülasyonu.
// Benzerlik ölçütü olarak Sonnet çıktısı KULLANILMAZ: her çıktı kaynak açıklamadan elle çıkarılan gold'a
// (malzeme+miktar+birim), alternatiflere, yapılıştaki süre/sıcaklık bilgilerine ve kaynağa göre kontrol edilir.
import fs from "node:fs";
import { GOLD as GOLD_DEV } from "./gold.mjs";
import { GOLD as GOLD_TEST } from "./gold-test.mjs";
import { ALTS } from "./gold-alts.mjs";
import { verify, numbersIn } from "./verifier.mjs";
import { parseCaption, gate } from "./codeParser.mjs";

const here = (f) => new URL(`./${f}`, import.meta.url);
const load = (f) => JSON.parse(fs.readFileSync(here(f), "utf8"));
const GOLD = { ...GOLD_DEV, ...GOLD_TEST };
const captions = Object.fromEntries([...load("corpus.json"), ...load("corpus-test.json")].map((c) => [c.id, c.caption]));
const results = load("results-models.json");
const ledger = load("ledger.json");
const lower = (s) => String(s ?? "").toLocaleLowerCase("tr");
const normAmt = (s) =>
  lower(s).replace(/\([^)]*\)/g, " ").replace(/½/g, "1/2").replace(/¼/g, "1/4").replace(/¾/g, "3/4")
    .replace(/(?<![\p{L}])yarım(?![\p{L}])/gu, "1/2").replace(/(?<![\p{L}])(bir|one)(?![\p{L}])/gu, "1").replace(/(?<![\p{L}])(iki|two)(?![\p{L}])/gu, "2")
    .replace(/^(yaklaşık|about)\s*/u, "").replace(/,/g, ".").replace(/\s+/g, " ").trim();
const TIME_TEMP = /(\d+(?:[.,]\d+)?(?:\s*[-–]\s*\d+)?)\s*(?:derece|°|dakika|dak\.?|dk|saat|minutes?|mins?|hours?|hr|f(?![\p{L}]))/giu;

export function judge(id, recipe) {
  const g = GOLD[id];
  const src = captions[id];
  const out = { kind: g.kind };
  const ings = recipe.ingredients || [];
  const steps = recipe.instructions || [];
  const allText = lower([...ings.map((i) => `${i.amount} ${i.name}`), ...steps, recipe.assumptions || ""].join(" | "));
  if (g.kind === "list") {
    const used = new Set();
    out.misses = [];
    for (const [ga, gk] of g.ing) {
      const idx = ings.findIndex((p, i) => !used.has(i) && lower(`${p.name} ${p.amount}`).includes(gk) && (ga === "" || normAmt(`${p.amount} ${p.name}`).includes(normAmt(ga))));
      if (idx === -1) {
        // ad var ama miktar/birim yanlış mı, yoksa malzeme hiç yok mu?
        const nameOnly = ings.some((p, i) => !used.has(i) && lower(p.name).includes(gk));
        out.misses.push({ want: `${ga} ${gk}`.trim(), type: nameOnly ? "miktar/birim" : "eksik malzeme" });
      } else used.add(idx);
    }
    out.extrasCaptured = (g.extra || []).filter((e) => ings.some((p) => lower(p.name).includes(e)));
    out.spurious = ings.filter((p, i) => !used.has(i) && !(g.extra || []).some((e) => lower(p.name).includes(e))).map((p) => `${p.amount} ${p.name}`.trim());
    out.recall = (g.ing.length - out.misses.length) / g.ing.length;
    out.stepsOk = g.steps === null ? steps.length === 0 : steps.length > 0;
  }
  // alternatifler
  out.alts = (ALTS[id] || []).map((grp) => ({ grp, ok: grp.every((t) => (/^\d/.test(t) ? numbersIn(allText).includes(t) : allText.includes(t))) }));
  // yapılıştaki süre/sıcaklık bilgileri korunmuş mu; kaynakta olmayan süre/sıcaklık uydurulmuş mu
  const srcFacts = [...new Set([...(src || "").matchAll(TIME_TEMP)].map((m) => numbersIn(m[1])[0]))].filter(Boolean);
  const outFactText = lower([...steps, recipe.assumptions || ""].join(" "));
  const outNums = new Set(numbersIn(outFactText));
  out.factsKept = srcFacts.filter((n) => outNums.has(n)).length;
  out.factsTotal = srcFacts.length;
  const srcNums = new Set(numbersIn(src));
  out.inventedTimeTemp = [...lower(steps.join(" ")).matchAll(TIME_TEMP)].map((m) => m[0]).filter((s) => numbersIn(s).some((n) => !srcNums.has(n)));
  // porsiyon: "kaynak" dediyse sayı kaynakta geçmeli
  out.servings = { value: recipe.servings ?? null, basis: recipe.servings_basis, unit: recipe.servings_unit || "porsiyon" };
  out.servingsFabricated = recipe.servings_basis === "kaynak" && !srcNums.has(String(recipe.servings));
  out.kcal = recipe.nutrition?.calories ?? null;
  out.title = recipe.title || "";
  out.assumptions = recipe.assumptions || "";
  out.verify = verify(src, recipe, { appLang: "tr" });
  out.autoCorrect = g.kind === "list" ? !out.misses.length && !out.spurious.length && out.stepsOk && out.alts.every((a) => a.ok) : null;
  return out;
}

const rows = Object.values(results);
const configs = [...new Set(rows.map((r) => r.config))];
const byId = {};
for (const r of rows) (byId[r.id] ||= {})[r.config] = r;
for (const r of rows) if (r.ok) r.j = judge(r.id, r.recipe);

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "-");
const q = (arr, p) => (arr.length ? arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))] : null);
const lines = [];
const log = (s = "") => lines.push(s);

const spent = ledger.calls.reduce((a, c) => a + (c.costUsd || 0), 0);
const possible = ledger.calls.reduce((a, c) => a + (c.possiblyBilledUsd || 0), 0);
log(`# Sonuçlar (otomatik; ${new Date().toISOString().slice(0, 16)})`);
log(`Ücretli çağrı: ${ledger.calls.length}, kesin harcama $${spent.toFixed(4)}${possible ? `, olası ek $${possible.toFixed(4)}` : ""}`);
log();
log("| Yapılandırma | Çağrı | Hata | Liste tariflerinde tam doğru | Malzeme recall | Eksik malzeme | Miktar/birim hatası | Fazla (kaynakta yok) | Alternatif korunan | Süre/sıcaklık korunan | Doğrulayıcı geçti | Ort. girdi/çıktı token | Ort. $/çağrı | p50 / p90 sn |");
log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
const summary = {};
for (const k of configs) {
  const rs = rows.filter((r) => r.config === k);
  const ok = rs.filter((r) => r.ok);
  const lists = ok.filter((r) => r.j.kind === "list");
  const misses = lists.flatMap((r) => r.j.misses);
  const alts = ok.flatMap((r) => r.j.alts);
  const facts = ok.reduce((a, r) => [a[0] + r.j.factsKept, a[1] + r.j.factsTotal], [0, 0]);
  const ms = rs.map((r) => r.ms);
  const s = {
    calls: rs.length, errors: rs.filter((r) => !r.ok).length,
    correct: lists.filter((r) => r.j.autoCorrect).length, lists: lists.length,
    recall: lists.reduce((a, r) => a + r.j.recall, 0) / Math.max(1, lists.length),
    missing: misses.filter((m) => m.type === "eksik malzeme").length, amountErr: misses.filter((m) => m.type === "miktar/birim").length,
    spurious: lists.reduce((a, r) => a + r.j.spurious.length, 0),
    alts: `${alts.filter((a) => a.ok).length}/${alts.length}`, facts: `${facts[0]}/${facts[1]}`,
    vpass: ok.filter((r) => r.j.verify.pass).length,
    inTok: ok.reduce((a, r) => a + r.usage.input_tokens, 0) / Math.max(1, ok.length),
    outTok: ok.reduce((a, r) => a + r.usage.output_tokens, 0) / Math.max(1, ok.length),
    usd: rs.reduce((a, r) => a + (r.costUsd || 0), 0) / Math.max(1, rs.length),
    p50: q(ms, 0.5) / 1000, p90: q(ms, 0.9) / 1000,
  };
  summary[k] = s;
  log(`| ${k} | ${s.calls} | ${s.errors} | ${s.correct}/${s.lists} | ${s.recall.toFixed(3)} | ${s.missing} | ${s.amountErr} | ${s.spurious} | ${s.alts} | ${s.facts} | ${s.vpass}/${ok.length} | ${Math.round(s.inTok)} / ${Math.round(s.outTok)} | ${s.usd.toFixed(4)} | ${s.p50?.toFixed(1)} / ${s.p90?.toFixed(1)} |`);
}

// Ortak örneklem: tüm yapılandırmaların başarıyla çalıştığı açıklamalar (adil karşılaştırma)
const common = Object.keys(byId).filter((id) => configs.every((k) => byId[id][k]?.ok));
log();
log(`Ortak örneklem (tüm yapılandırmalar başarılı): ${common.length} açıklama; ${common.filter((id) => GOLD[id].kind === "list").length} liste tarifi.`);
log("| Yapılandırma | Tam doğru (ortak) | Eksik malzeme | Miktar/birim | Fazla | Toplam $ |");
log("|---|---|---|---|---|---|");
for (const k of configs) {
  const rs = common.map((id) => byId[id][k]);
  const L = rs.filter((r) => r.j.kind === "list");
  log(`| ${k} | ${L.filter((r) => r.j.autoCorrect).length}/${L.length} | ${L.flatMap((r) => r.j.misses).filter((m) => m.type === "eksik malzeme").length} | ${L.flatMap((r) => r.j.misses).filter((m) => m.type !== "eksik malzeme").length} | ${L.reduce((a, r) => a + r.j.spurious.length, 0)} | ${rs.reduce((a, r) => a + (r.costUsd || 0), 0).toFixed(4)} |`);
}

// Doğrulayıcının kaçırdıkları: geçti ama gold'a göre eksik/yanlış
log();
log("## Doğrulayıcının geçirdiği ama kaynağa göre hatalı çıktılar");
for (const r of rows.filter((r) => r.ok && r.j.kind === "list" && r.j.verify.pass && !r.j.autoCorrect)) {
  log(`- ${r.id} ${r.config}: ${[...r.j.misses.map((m) => `${m.type}: ${m.want}`), ...r.j.spurious.map((s) => `fazla: ${s}`), ...(r.j.stepsOk ? [] : ["yapılış"]), ...r.j.alts.filter((a) => !a.ok).map((a) => `alternatif: ${a.grp.join("/")}`)].join("; ")}`);
}

// Kaynakta olmayan bilgiler: uydurulmuş süre/sıcaklık, "kaynakta yazıyor" denen ama yazmayan porsiyon
log();
log("## Kaynakta olmayan bilgiler");
for (const k of configs) {
  const ok = rows.filter((r) => r.config === k && r.ok);
  const inv = ok.filter((r) => r.j.inventedTimeTemp.length);
  const fab = ok.filter((r) => r.j.servingsFabricated);
  const withAssump = ok.filter((r) => r.j.assumptions.trim()).length;
  log(`- ${k}: uydurma süre/sıcaklık ${inv.length} tarifte${inv.length ? ` (${inv.map((r) => `${r.id}: ${r.j.inventedTimeTemp.join(", ")}`).join("; ")})` : ""}; kaynakta yazmayan "kaynak" porsiyon ${fab.length}${fab.length ? ` (${fab.map((r) => `${r.id}=${r.j.servings.value}`).join(", ")})` : ""}; varsayım notu yazılan ${withAssump}/${ok.length}`);
}

// Besin/porsiyon: doğruluk ölçülemez (gerçek değer yok); üretimdeki Sonnet'e göre sapma ve porsiyon temeli
log();
log("## Besin değeri ve porsiyon (doğruluk ölçülemez; üretimdeki 'sonnet' ayarına göre fark)");
for (const k of configs.filter((c) => c !== "sonnet")) {
  const pairs = common.map((id) => [byId[id].sonnet?.j, byId[id][k]?.j]).filter(([a, b]) => a && b && a.kcal && b.kcal);
  const ratios = pairs.map(([a, b]) => b.kcal / a.kcal);
  const sameServ = pairs.filter(([a, b]) => a.servings.value === b.servings.value && a.servings.basis === b.servings.basis).length;
  log(`- ${k}: kalori oranı (bu / sonnet) medyan ${q(ratios, 0.5)?.toFixed(2)}, aralık ${Math.min(...ratios).toFixed(2)}–${Math.max(...ratios).toFixed(2)}; porsiyon (değer+temel) aynı ${sameServ}/${pairs.length}`);
}

// Yönlendirici simülasyonu (gerçek sonuçlarla). Kaçınılmaz ikinci çağrı maliyeti ve süresi dahil.
log();
log("## Yönlendirici simülasyonu (gerçek ölçümlerle)");
log("| Yol | Örneklem | Güçlü modele geçiş | Son çıktı tam doğru (liste) | Doğrulayıcı geçirdi ama hatalı | $ / başarılı tarif | Üretime göre tasarruf | p50 / p90 sn |");
log("|---|---|---|---|---|---|---|---|");
const base = (id) => byId[id].sonnet;
function sim(label, cheap, strong, useCode) {
  const ids = Object.keys(byId).filter((id) => base(id) && (!cheap || byId[id][cheap]) && (!strong || byId[id][strong]));
  let esc = 0, usdSum = 0, succ = 0, correct = 0, lists = 0, silentBad = 0, baseUsd = 0;
  const ms = [];
  for (const id of ids) {
    baseUsd += base(id).costUsd || 0;
    if (useCode && gate(parseCaption(captions[id]), { appLang: "tr" }).accept) { succ++; ms.push(5); continue; }
    let final;
    let t = 0;
    if (!cheap) { final = byId[id][strong]; t = final.ms; usdSum += final.costUsd || 0; }
    else {
      const a = byId[id][cheap];
      usdSum += a.costUsd || 0;
      t = a.ms;
      final = a;
      if (!a.ok || !a.j.verify.pass) { esc++; const b = byId[id][strong]; usdSum += b.costUsd || 0; t += b.ms; final = b; }
    }
    ms.push(t);
    if (final.ok) succ++;
    if (final.ok && final.j.kind === "list") { lists++; if (final.j.autoCorrect) correct++; else if (cheap && final === byId[id][cheap]) silentBad++; }
  }
  log(`| ${label} | ${ids.length} | ${cheap ? pct(esc, ids.length) : "-"} | ${correct}/${lists} | ${silentBad} | ${(usdSum / Math.max(1, succ)).toFixed(4)} | ${pct(baseUsd - usdSum, baseUsd)} | ${(q(ms, 0.5) / 1000).toFixed(1)} / ${(q(ms, 0.9) / 1000).toFixed(1)} |`);
}
sim("Üretim: sonnet", null, "sonnet", false);
for (const k of configs.filter((c) => c !== "sonnet" && c.startsWith("sonnet"))) sim(`Tek model: ${k}`, null, k, false);
for (const k of configs.filter((c) => c.startsWith("haiku"))) {
  sim(`Tek model: ${k} (doğrulamasız)`, null, k, false);
  sim(`${k} → doğrulayıcı → sonnet`, k, "sonnet", false);
  for (const s of configs.filter((c) => c !== "sonnet" && c.startsWith("sonnet"))) sim(`${k} → doğrulayıcı → ${s}`, k, s, false);
}

// Örnek bazında: kim nerede daha iyi
log();
log("## Açıklama bazında (liste tarifleri): tam doğru olan yapılandırmalar");
for (const id of Object.keys(byId).sort()) {
  if (GOLD[id].kind !== "list") continue;
  const cells = configs.map((k) => {
    const r = byId[id][k];
    if (!r) return `${k}: -`;
    if (!r.ok) return `${k}: HATA`;
    return `${k}: ${r.j.autoCorrect ? "✓" : `✗(${[...r.j.misses.map((m) => (m.type === "eksik malzeme" ? "−" : "≠") + m.want), ...r.j.spurious.map((s) => "+" + s), ...(r.j.stepsOk ? [] : ["adım"]), ...r.j.alts.filter((a) => !a.ok).map((a) => "alt:" + a.grp.join("/"))].join(", ").slice(0, 120)})`}`;
  });
  log(`- ${id}: ${cells.join(" | ")}`);
}
log();
log("Not: 'tam doğru' otomatik ölçüttür (malzeme+miktar+birim gold'la, alternatifler, yapılış var/yok). Adımların içeriği metin olarak puanlanmaz; review.md'de elle incelenir.");
fs.writeFileSync(here("REPORT-models.md"), lines.join("\n"));
console.log(lines.join("\n"));

// Elle inceleme için yan yana dosya
const rv = [];
for (const id of Object.keys(byId).sort()) {
  rv.push(`\n## ${id} (${GOLD[id].kind})\n\nKAYNAK: ${captions[id]}\n`);
  for (const k of configs) {
    const r = byId[id][k];
    if (!r?.ok) { rv.push(`### ${k}: ${r ? r.error : "çalışmadı"}`); continue; }
    const x = r.recipe;
    rv.push(`### ${k} — ${x.title} | porsiyon ${x.servings ?? "-"} (${x.servings_basis}) | ${x.nutrition?.calories} kcal\n- Malzemeler: ${x.ingredients.map((i) => `${i.amount} ${i.name}`.trim()).join(" · ")}\n- Yapılış: ${(x.instructions || []).map((s, i) => `${i + 1}) ${s}`).join(" ")}\n- Varsayımlar: ${x.assumptions || "-"}`);
  }
}
fs.writeFileSync(here("review.md"), rv.join("\n"));
