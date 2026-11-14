// HAIKU DENEMESİ (trial/haiku-extraction): model yalnızca Vercel Preview'da Haiku 5.5'e geçer.
// İstek gövdesinin geri kalanı (prompt, şema, max_tokens) değişmez; düşünme/effort parametresi gönderilmez
// (Haiku 5.5 varsayılanı: adaptive düşünme, effort medium — "düşünmesiz" sürüm DEĞİL). Ağsız.
import test from "node:test";
import assert from "node:assert/strict";

process.env.ANTHROPIC_API_KEY = "test-key";
const bodies = [];
globalThis.fetch = async (url, init = {}) => {
  assert.equal(String(url), "https://api.anthropic.com/v1/messages");
  bodies.push(JSON.parse(init.body));
  const recipe = { title: "T", servings: null, servings_unit: "porsiyon", prep_time_minutes: 5, difficulty: "Kolay", ingredients: [{ name: "un", amount: "1 su bardağı" }], instructions: ["karıştır"], nutrition: { calories: 1, protein_g: 1, carbs_g: 1, fat_g: 1 }, assumptions: "", portion: { dish_type: "diger", cooking_method: "firin", items: [] } };
  return new Response(JSON.stringify({ stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "text", text: JSON.stringify(recipe) }] }), { status: 200 });
};

const { extractionModel, TRIAL_EXTRACT_MODEL, PRODUCTION_EXTRACT_MODEL } = await import("../shared/extractModel.js");
const { extractRecipeFromCaption } = await import("../api/_lib/extractRecipe.js");

test("model seçimi: yalnız VERCEL_ENV=preview → Haiku 5.5; production/yerel/boş → Sonnet 5", () => {
  assert.equal(TRIAL_EXTRACT_MODEL, "claude-haiku-5-5");
  assert.equal(PRODUCTION_EXTRACT_MODEL, "claude-sonnet-5");
  assert.equal(extractionModel({ VERCEL_ENV: "preview" }), "claude-haiku-5-5");
  for (const env of [{ VERCEL_ENV: "production" }, { VERCEL_ENV: "development" }, {}, { VERCEL_ENV: "" }]) {
    assert.equal(extractionModel(env), "claude-sonnet-5", JSON.stringify(env));
  }
});

test("Preview'da istek Haiku 5.5'e gider; prompt/şema/max_tokens aynı; düşünme/effort parametresi yok", async () => {
  bodies.length = 0;
  const prev = process.env.VERCEL_ENV;
  try {
    process.env.VERCEL_ENV = "production";
    const a = await extractRecipeFromCaption({ link: "https://www.tiktok.com/@a/video/1", caption: "1 su bardağı un", timeoutMs: 5000 });
    process.env.VERCEL_ENV = "preview";
    const b = await extractRecipeFromCaption({ link: "https://www.tiktok.com/@a/video/1", caption: "1 su bardağı un", timeoutMs: 5000 });
    assert.equal(a.model, "claude-sonnet-5");
    assert.equal(b.model, "claude-haiku-5-5");
  } finally {
    if (prev === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = prev;
  }
  const [sonnet, haiku] = bodies;
  assert.equal(sonnet.model, "claude-sonnet-5");
  assert.equal(haiku.model, "claude-haiku-5-5");
  for (const body of [sonnet, haiku]) {
    assert.equal(body.thinking, undefined, "düşünme ayarı gönderilmemeli (varsayılan adaptive)");
    assert.equal(body.output_config.effort, undefined, "effort gönderilmemeli (varsayılan medium)");
    assert.equal(body.temperature, undefined);
  }
  const { model: _m1, ...restSonnet } = sonnet;
  const { model: _m2, ...restHaiku } = haiku;
  assert.deepEqual(restHaiku, restSonnet, "model dışında istek birebir aynı olmalı");
  assert.equal(haiku.max_tokens, 16000);
});
