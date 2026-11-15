// Tarif çıkarma modeli (shared/extractModel.js): Preview'da test edilen model, onaydan sonra Production'da
// çalışacak modelin AYNISI olmalı. Deneme dalındaki "yalnız VERCEL_ENV=preview iken Haiku" kuralı kaldırıldı;
// bu test ortam ne olursa olsun isteğin Haiku 5.5'e gittiğini, istek gövdesinin ortamdan bağımsız olduğunu ve
// çeviri/kiler modellerinin bu karardan etkilenmediğini sabitler. Ağsız.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.ANTHROPIC_API_KEY = "test-key";
const bodies = [];
globalThis.fetch = async (url, init = {}) => {
  assert.equal(String(url), "https://api.anthropic.com/v1/messages");
  bodies.push(JSON.parse(init.body));
  const recipe = { title: "T", servings: null, servings_unit: "porsiyon", prep_time_minutes: 5, difficulty: "Kolay", ingredients: [{ name: "un", amount: "1 su bardağı", group: "", estimated: false }], instructions: ["karıştır"], nutrition: { calories: 1, protein_g: 1, carbs_g: 1, fat_g: 1 }, assumptions: "", portion: { dish_type: "diger", cooking_method: "firin", items: [] } };
  return new Response(JSON.stringify({ stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "text", text: JSON.stringify(recipe) }] }), { status: 200 });
};

const { extractionModel, EXTRACT_MODEL } = await import("../shared/extractModel.js");
const { extractRecipeFromCaption } = await import("../api/_lib/extractRecipe.js");

const ENVS = ["production", "preview", "development", "", undefined];

test("tarif çıkarma modeli Claude Haiku 5.5; Production dahil her ortamda aynı", () => {
  assert.equal(EXTRACT_MODEL, "claude-haiku-5-5");
  const prev = process.env.VERCEL_ENV;
  try {
    for (const env of ENVS) {
      if (env === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = env;
      assert.equal(extractionModel(), "claude-haiku-5-5", `VERCEL_ENV=${env}`);
    }
  } finally {
    if (prev === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = prev;
  }
});

test("Production ve Preview'da giden istek birebir aynı: Haiku 5.5, max_tokens 16000, thinking/effort gönderilmez", async () => {
  bodies.length = 0;
  const prev = process.env.VERCEL_ENV;
  const results = [];
  try {
    for (const env of ["production", "preview"]) {
      process.env.VERCEL_ENV = env;
      results.push(await extractRecipeFromCaption({ link: "https://www.tiktok.com/@a/video/1", caption: "1 su bardağı un", timeoutMs: 5000 }));
    }
  } finally {
    if (prev === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = prev;
  }
  assert.deepEqual(results.map((r) => r.model), ["claude-haiku-5-5", "claude-haiku-5-5"]);
  const [production, preview] = bodies;
  assert.deepEqual(production, preview, "ortama göre istek değişmemeli");
  assert.equal(production.model, "claude-haiku-5-5");
  assert.equal(production.max_tokens, 16000);
  assert.equal(production.thinking, undefined, "düşünme ayarı gönderilmemeli (varsayılan adaptive)");
  assert.equal(production.output_config.effort, undefined, "effort gönderilmemeli (varsayılan medium)");
  assert.equal(production.output_config.format.type, "json_schema");
  assert.equal(production.temperature, undefined);
});

test("çeviri ve kiler önerileri bu karardan etkilenmez (Sonnet 5'te kalır)", () => {
  const src = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
  const models = (text) => [...text.matchAll(/["'](claude-[a-z0-9-]+)["']/g)].map((m) => m[1]);
  assert.deepEqual(models(src("../api/translate-recipe.js")), ["claude-sonnet-5"]);
  assert.deepEqual(models(src("../api/suggest-recipes.js")), ["claude-sonnet-5"]);
  // Çıkarma modeli başka yerde sabit yazılmamalı (tek kaynak shared/extractModel.js).
  assert.deepEqual(models(src("../api/_lib/extractRecipe.js")), []);
});
