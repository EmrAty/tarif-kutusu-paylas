// ÜCRETLİ karşılaştırma koşumu (Anthropic API) — yalnız çağrı yapar ve kaydeder; puanlama analyze.mjs'te.
//
//   node runModels.mjs --dry-run [--configs …] [--ids …|--set pilot]
//   node runModels.mjs --key-file <dosya> --cap-usd 3 --configs sonnet,haiku --set pilot
//
// Güvenlik:
//  - Anahtar yalnız --key-file'dan (ya da ANTHROPIC_API_KEY'den) süreç içinde okunur; hiçbir yere yazılmaz/basılmaz.
//  - ledger.json TÜM önceki ücretli çağrıları tutar. Her çağrıdan ÖNCE: harcanan + bu çağrının EN KÖTÜ
//    durumu (tahmini girdi + max_tokens kadar çıktı) > tavan ise çağrı başlatılmaz.
//  - Zaman aşımı/ağ hatasında çağrı faturalanmış olabilir: en kötü durum tutarı "olası" harcamaya eklenir.
//  - Çağrılar sırayla (eşzamansız değil) yapılır; tamamlanmış (id, config) çifti tekrar çağrılmaz.
import fs from "node:fs";
import { extractRecipe, RECIPE_SCHEMA } from "../../app/api/_lib/extractRecipe.js";
import { recipeSystemPrompt, buildRecipeUserText } from "../../app/shared/recipeExtraction.js";
import { GOLD as GOLD_DEV } from "./gold.mjs";
import { GOLD as GOLD_TEST } from "./gold-test.mjs";

// $/MTok — claude-api skill fiyat tablosu (önbellek 2026-11-03). Haiku 5.5: ≤100K girdi kartı.
export const PRICE = { "claude-sonnet-5": [2.0, 10.0], "claude-haiku-5-5": [0.1, 0.5] };
// Desteklenen ayarlar (skill belgeleri): Sonnet 5 → adaptive varsayılan, disabled kabul, effort low–max (varsayılan high),
// budget_tokens 400. Haiku 5.5 → adaptive varsayılan, disabled (effort ≤ high), effort varsayılan medium.
export const CONFIGS = {
  sonnet: { model: "claude-sonnet-5" }, // üretimdeki ayar: adaptive, effort high (varsayılan)
  "sonnet-low": { model: "claude-sonnet-5", effort: "low" }, // adaptive, daha az düşünme
  "sonnet-nothink": { model: "claude-sonnet-5", thinking: { type: "disabled" } },
  haiku: { model: "claude-haiku-5-5" }, // adaptive, effort medium (varsayılan)
  "haiku-nothink": { model: "claude-haiku-5-5", thinking: { type: "disabled" } },
};
const MAX_TOKENS = 16000; // extractRecipe ile aynı (en kötü durum çıktı sınırı)
const PILOT = ["c01", "c09", "c19", "c23", "t13"];

const args = process.argv.slice(2);
const arg = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const dry = args.includes("--dry-run");
const cap = Number(arg("--cap-usd"));
const which = (arg("--configs") || Object.keys(CONFIGS).join(",")).split(",");
for (const k of which) if (!CONFIGS[k]) throw new Error(`bilinmeyen yapılandırma: ${k}`);
const here = (f) => new URL(`./${f}`, import.meta.url);
const load = (f, d) => (fs.existsSync(here(f)) ? JSON.parse(fs.readFileSync(here(f), "utf8")) : d);

const all = [
  ...load("corpus.json", []).map((c) => ({ ...c, gold: GOLD_DEV[c.id] })),
  ...load("corpus-test.json", []).map((c) => ({ ...c, gold: GOLD_TEST[c.id] })),
].filter((c) => c.caption && c.gold.kind !== "fetch_failed");
const idsArg = arg("--ids") || (arg("--set") === "pilot" ? PILOT.join(",") : null);
const items = idsArg ? all.filter((c) => idsArg.split(",").includes(c.id)) : all;

const sysChars = recipeSystemPrompt("tr").length + JSON.stringify(RECIPE_SCHEMA).length;
// Tutucu girdi tahmini: Türkçe ~2,3 karakter/token (yeni tokenizer ~%30 fazla sayar).
const estIn = (it) => Math.ceil((sysChars + buildRecipeUserText({ link: it.url, caption: it.caption, notes: "", imageCount: 0 }).length) / 2.3);
const usd = (model, inTok, outTok) => (inTok * PRICE[model][0] + outTok * PRICE[model][1]) / 1e6;
const worstCase = (it, cfg) => usd(cfg.model, estIn(it), MAX_TOKENS);

const ledger = load("ledger.json", { calls: [] });
const spentConfirmed = () => ledger.calls.reduce((a, c) => a + (c.costUsd || 0), 0);
const spentPossible = () => ledger.calls.reduce((a, c) => a + (c.costUsd || 0) + (c.possiblyBilledUsd || 0), 0);
const results = load("results-models.json", {});
const done = (id, k) => results[`${id}|${k}`]?.ok === true || results[`${id}|${k}`]?.final === true;

const pending = [];
for (const k of which) for (const it of items) if (!done(it.id, k)) pending.push({ it, k });

if (dry) {
  const typical = { sonnet: 1709, "sonnet-low": 1000, "sonnet-nothink": 720, haiku: 1200, "haiku-nothink": 800 };
  let typ = 0;
  let worst = 0;
  for (const { it, k } of pending) {
    typ += usd(CONFIGS[k].model, estIn(it), typical[k]);
    worst += worstCase(it, CONFIGS[k]);
  }
  console.log(`Bekleyen çağrı: ${pending.length} (${items.length} açıklama × ${which.join(", ")})`);
  console.log(`Defterdeki harcama: kesin $${spentConfirmed().toFixed(4)}, olası dahil $${spentPossible().toFixed(4)}`);
  console.log(`Bu çağrılar için tahmini ~$${typ.toFixed(3)}; en kötü durum (hepsi max_tokens) $${worst.toFixed(2)}`);
  process.exit(0);
}

const keyFile = arg("--key-file");
if (keyFile) process.env.ANTHROPIC_API_KEY = fs.readFileSync(keyFile, "utf8").replace(/^﻿/, "").trim();
if (!process.env.ANTHROPIC_API_KEY) throw new Error("API anahtarı yok (--key-file ya da ANTHROPIC_API_KEY).");
if (!(cap > 0)) throw new Error("--cap-usd zorunlu.");

let stopped = false;
for (const { it, k } of pending) {
  const cfg = CONFIGS[k];
  const wc = worstCase(it, cfg);
  if (spentPossible() + wc > cap) {
    console.log(`DURDU: harcanan (olası dahil) $${spentPossible().toFixed(4)} + bu çağrının en kötü durumu $${wc.toFixed(4)} > tavan $${cap}.`);
    stopped = true;
    break;
  }
  const t0 = Date.now();
  const entry = { ts: new Date().toISOString(), id: it.id, config: k, model: cfg.model };
  let rec;
  try {
    const r = await extractRecipe({ link: it.url, caption: it.caption, language: "tr", timeoutMs: 160_000, ...cfg });
    entry.usage = r.usage;
    entry.costUsd = usd(cfg.model, r.usage.input_tokens, r.usage.output_tokens);
    rec = { ok: true, ms: Date.now() - t0, usage: r.usage, costUsd: entry.costUsd, stopReason: r.stopReason, recipe: r.recipe };
  } catch (e) {
    entry.error = `${e.kind || "error"}: ${String(e.message).slice(0, 200)}`;
    if (e.usage) {
      entry.usage = e.usage;
      entry.costUsd = usd(cfg.model, e.usage.input_tokens, e.usage.output_tokens);
    } else if (e.kind === "timeout" || e.kind === "network") {
      entry.possiblyBilledUsd = wc; // yanıt gelmedi ama faturalanmış olabilir
    } else {
      entry.costUsd = 0; // 4xx (ör. desteklenmeyen ayar): faturalanmaz
    }
    // 4xx ayar hatası kalıcıdır: tekrar denenmesin
    rec = { ok: false, final: e.kind === "provider" && e.providerStatus >= 400 && e.providerStatus < 500, ms: Date.now() - t0, error: entry.error, providerStatus: e.providerStatus, usage: e.usage, costUsd: entry.costUsd || 0 };
  }
  entry.ms = Date.now() - t0;
  ledger.calls.push(entry);
  results[`${it.id}|${k}`] = { id: it.id, config: k, model: cfg.model, ...rec };
  fs.writeFileSync(here("ledger.json"), JSON.stringify(ledger, null, 1));
  fs.writeFileSync(here("results-models.json"), JSON.stringify(results, null, 1));
  console.log(`${it.id} ${k.padEnd(14)} ${rec.ok ? "ok  " : "HATA"} ${String(entry.ms).padStart(6)}ms in=${entry.usage?.input_tokens ?? "-"} out=${entry.usage?.output_tokens ?? "-"} $${(entry.costUsd || 0).toFixed(4)} | toplam $${spentConfirmed().toFixed(4)}${rec.ok ? "" : ` | ${entry.error}`}`);
}
console.log(`Bitti${stopped ? " (tavan nedeniyle erken)" : ""}. Kesin harcama $${spentConfirmed().toFixed(4)}, olası dahil $${spentPossible().toFixed(4)}.`);
