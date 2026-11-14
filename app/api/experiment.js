// DENEME UCU — yalnızca experiment/cheap-extraction dalının korumalı Preview dağıtımında çalışır.
// Amaç: Vercel'de zaten tanımlı Anthropic anahtarını DIŞARI ÇIKARMADAN, sabit bir açıklama kümesinde
// sabit model ayarlarını karşılaştırmak. Genel bir AI ucu DEĞİLDİR:
//  - Girdi yalnızca { id, config }: id sabit EXPERIMENT_CORPUS'tan, config aşağıdaki sabit listeden.
//    Serbest metin, model adı, prompt ya da parametre kabul edilmez.
//  - VERCEL_ENV !== "preview" ya da dal experiment/cheap-extraction değilse 404 (main/production'da dosya hiç yok).
//  - Erişim Vercel Deployment Protection'ın arkasında (Preview'lar Vercel Authentication ile korunuyor) ve
//    diğer tüm uçlar gibi Firebase kimliği ister (authContract.test.mjs sözleşmesi).
//  - Toplam harcama Redis'te atomik olarak tutulur; her çağrıdan ÖNCE en kötü durum (tahmini girdi + max_tokens
//    çıktı) ayrılır, tavanı (3 $) aşacaksa çağrı başlatılmaz. Yanıt gelmezse ayrılan tutar harcanmış sayılır.
//  - Aynı (id, config) bir kez çağrılır; sonuç Redis'te saklanır, tekrar istek yeni çağrı yapmaz.
//  - Bildirim göndermez, kullanıcı verisine dokunmaz. Anahtar hiçbir yanıtta yer almaz.
import { requireUser } from "./_lib/auth.js";
import { extractRecipe, RECIPE_SCHEMA } from "./_lib/extractRecipe.js";
import { recipeSystemPrompt, buildRecipeUserText } from "../shared/recipeExtraction.js";
import { redisEval, redisGetJSON, redisSetJSON, redisSetNX, redisDel, redisCommand } from "./_lib/redis.js";
import { EXPERIMENT_CORPUS } from "./_lib/experimentCorpus.js";

export const config = { maxDuration: 300 };

const BRANCH = "experiment/cheap-extraction";
export const CAP_MICRO_USD = 3_000_000; // 3,00 $
const MAX_TOKENS = 16000; // extractRecipe ile aynı
const CLAUDE_TIMEOUT_MS = 200_000;
const NS = "exp:cheap-extraction";
const K = { spent: `${NS}:spent-micro`, reserved: `${NS}:reserved-micro`, ledger: `${NS}:ledger`, result: (id, c) => `${NS}:result:${id}|${c}`, lock: (id, c) => `${NS}:lock:${id}|${c}` };
const TTL = 30 * 24 * 3600;

// $/MTok (claude-api fiyat tablosu, 2026-11-03). Haiku 5.5: ≤100K girdi kartı.
const PRICE = { "claude-sonnet-5": [2.0, 10.0], "claude-haiku-5-5": [0.1, 0.5] };
export const CONFIGS = {
  sonnet: { model: "claude-sonnet-5" },
  "sonnet-low": { model: "claude-sonnet-5", effort: "low" },
  "sonnet-nothink": { model: "claude-sonnet-5", thinking: { type: "disabled" } },
  haiku: { model: "claude-haiku-5-5" },
  "haiku-nothink": { model: "claude-haiku-5-5", thinking: { type: "disabled" } },
};
const byId = new Map(EXPERIMENT_CORPUS.map((c) => [c.id, c]));

const microUsd = (model, inTok, outTok) => Math.ceil(((inTok || 0) * PRICE[model][0] + (outTok || 0) * PRICE[model][1]));
const SYS_CHARS = recipeSystemPrompt("tr").length + JSON.stringify(RECIPE_SCHEMA).length;
// Tutucu: ~2,3 karakter/token + max_tokens kadar çıktı
const worstCaseMicro = (item, model) =>
  microUsd(model, Math.ceil((SYS_CHARS + buildRecipeUserText({ link: item.url, caption: item.caption, notes: "", imageCount: 0 }).length) / 2.3), MAX_TOKENS);

const RESERVE_LUA = `
local spent = tonumber(redis.call("GET", KEYS[1]) or "0")
local reserved = tonumber(redis.call("GET", KEYS[2]) or "0")
local cap = tonumber(ARGV[1])
local wc = tonumber(ARGV[2])
if spent + reserved + wc > cap then return {0, spent, reserved} end
redis.call("SET", KEYS[2], string.format("%d", reserved + wc))
return {1, spent, reserved + wc}`;
const SETTLE_LUA = `
local spent = tonumber(redis.call("GET", KEYS[1]) or "0")
local reserved = tonumber(redis.call("GET", KEYS[2]) or "0")
reserved = reserved - tonumber(ARGV[1])
if reserved < 0 then reserved = 0 end
spent = spent + tonumber(ARGV[2])
redis.call("SET", KEYS[1], string.format("%d", spent))
redis.call("SET", KEYS[2], string.format("%d", reserved))
return {spent, reserved}`;

export function experimentEnabled(env = process.env) {
  return env.VERCEL_ENV === "preview" && env.VERCEL_GIT_COMMIT_REF === BRANCH;
}

async function status() {
  const [spent, reserved] = await Promise.all([redisCommand(["GET", K.spent]), redisCommand(["GET", K.reserved])]);
  const ledger = (await redisCommand(["LRANGE", K.ledger, "0", "999"])) || [];
  return {
    enabled: true,
    branch: process.env.VERCEL_GIT_COMMIT_REF,
    commit: (process.env.VERCEL_GIT_COMMIT_SHA || "").slice(0, 7),
    hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
    capUsd: CAP_MICRO_USD / 1e6,
    spentUsd: Number(spent || 0) / 1e6,
    reservedUsd: Number(reserved || 0) / 1e6,
    calls: ledger.map((s) => JSON.parse(s)),
    corpusIds: EXPERIMENT_CORPUS.map((c) => c.id),
    configs: Object.keys(CONFIGS),
  };
}

async function run(id, configName) {
  const item = byId.get(id);
  const cfg = CONFIGS[configName];
  const cached = await redisGetJSON(K.result(id, configName), null);
  if (cached) return { status: 200, body: { ...cached, cached: true } };
  if (!(await redisSetNX(K.lock(id, configName), "1", 330))) return { status: 409, body: { error: "Bu çift şu anda çalışıyor." } };
  try {
    const wc = worstCaseMicro(item, cfg.model);
    const [okFlag, spent, reserved] = await redisEval(RESERVE_LUA, [K.spent, K.reserved], [CAP_MICRO_USD, wc]);
    if (Number(okFlag) !== 1) {
      return { status: 402, body: { error: "budget_cap", spentUsd: Number(spent) / 1e6, reservedUsd: Number(reserved) / 1e6, worstCaseUsd: wc / 1e6, capUsd: CAP_MICRO_USD / 1e6 } };
    }
    const t0 = Date.now();
    let rec;
    let charge;
    try {
      const r = await extractRecipe({ link: item.url, caption: item.caption, language: "tr", timeoutMs: CLAUDE_TIMEOUT_MS, ...cfg });
      charge = microUsd(cfg.model, r.usage?.input_tokens, r.usage?.output_tokens);
      rec = { ok: true, usage: r.usage, stopReason: r.stopReason, recipe: r.recipe };
    } catch (e) {
      if (e.usage) charge = microUsd(cfg.model, e.usage.input_tokens, e.usage.output_tokens);
      else if (e.kind === "timeout" || e.kind === "network") charge = wc; // yanıt yok: faturalanmış olabilir
      else charge = 0; // 4xx ayar hatası vb.: faturalanmaz
      rec = { ok: false, error: `${e.kind || "error"}: ${String(e.message).slice(0, 300)}`, kind: e.kind, providerStatus: e.providerStatus, usage: e.usage, stopReason: e.stopReason, chargeIsEstimate: !e.usage && charge > 0 };
    }
    const ms = Date.now() - t0;
    const [spentAfter] = await redisEval(SETTLE_LUA, [K.spent, K.reserved], [wc, charge]);
    const result = { id, config: configName, model: cfg.model, ms, costUsd: charge / 1e6, ...rec, at: new Date().toISOString() };
    // Başarılı ya da kalıcı (4xx) sonuç saklanır; zaman aşımı/ağ hatası tekrar denenebilir.
    const final = rec.ok || (rec.providerStatus >= 400 && rec.providerStatus < 500 && rec.providerStatus !== 429) || !!rec.usage;
    if (final) await redisSetJSON(K.result(id, configName), result, TTL);
    await redisCommand(["LPUSH", K.ledger, JSON.stringify({ id, config: configName, model: cfg.model, ms, costUsd: charge / 1e6, ok: rec.ok, usage: rec.usage || null, error: rec.ok ? null : rec.error, at: result.at })]);
    await redisCommand(["EXPIRE", K.ledger, String(TTL)]);
    return { status: 200, body: { ...result, spentUsd: Number(spentAfter) / 1e6 } };
  } finally {
    await redisDel(K.lock(id, configName)).catch(() => {});
  }
}

export default async function handler(req, res) {
  try {
    await requireUser(req);
  } catch (e) {
    res.status(e.status || 401).json({ error: e.message });
    return;
  }
  if (!experimentEnabled()) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  try {
    if (req.method === "GET") {
      res.status(200).json(await status());
      return;
    }
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    const keys = Object.keys(body);
    if (keys.some((k) => k !== "id" && k !== "config")) {
      res.status(400).json({ error: "Yalnızca id ve config kabul edilir." });
      return;
    }
    if (typeof body.id !== "string" || !byId.has(body.id) || typeof body.config !== "string" || !Object.hasOwn(CONFIGS, body.config)) {
      res.status(400).json({ error: "Bilinmeyen id ya da config." });
      return;
    }
    const out = await run(body.id, body.config);
    res.status(out.status).json(out.body);
  } catch (e) {
    res.status(500).json({ error: "Deney isteği tamamlanamadı." });
  }
}
