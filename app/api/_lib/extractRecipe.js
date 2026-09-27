import { recipeSystemPrompt, buildRecipeUserText } from "../../shared/recipeExtraction.js";
import { DEFAULT_CONTENT_LANG, isContentLanguage } from "../../shared/recipeLocales.js";
import {
  applyPortionEstimate,
  PORTION_DISH_TYPES,
  PORTION_METHODS,
  PORTION_KINDS,
  PORTION_UNITS,
  PORTION_SIZES,
  PORTION_STATES,
} from "../../shared/portionEstimate.js";

// /api/extract ile aynı model ve prompt. Farklar: çıktı şemaya bağlı (her zaman
// geçerli JSON), max_tokens daha yüksek (claude-sonnet-5 varsayılan olarak önce
// düşünüyor ve düşünme token'ları da bu bütçeden harcanıyor), zaman aşımı var.
const MODEL = "claude-sonnet-5";

const RECIPE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    servings: { anyOf: [{ type: "integer" }, { type: "null" }] },
    prep_time_minutes: { type: "number" },
    difficulty: { type: "string", enum: ["Kolay", "Orta", "Zor"] },
    ingredients: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, amount: { type: "string" } },
        required: ["name", "amount"],
        additionalProperties: false,
      },
    },
    instructions: { type: "array", items: { type: "string" } },
    nutrition: {
      type: "object",
      properties: {
        calories: { type: "number" },
        protein_g: { type: "number" },
        carbs_g: { type: "number" },
        fat_g: { type: "number" },
      },
      required: ["calories", "protein_g", "carbs_g", "fat_g"],
      additionalProperties: false,
    },
    assumptions: { type: "string" },
    portion: {
      type: "object",
      properties: {
        dish_type: { type: "string", enum: PORTION_DISH_TYPES },
        cooking_method: { type: "string", enum: PORTION_METHODS },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              kind: { type: "string", enum: PORTION_KINDS },
              quantity: { anyOf: [{ type: "number" }, { type: "null" }] },
              unit: { type: "string", enum: PORTION_UNITS },
              size: { anyOf: [{ type: "string", enum: PORTION_SIZES }, { type: "null" }] },
              state: { type: "string", enum: PORTION_STATES },
              quantity_in_source: { type: "boolean" },
            },
            required: ["name", "kind", "quantity", "unit", "size", "state", "quantity_in_source"],
            additionalProperties: false,
          },
        },
      },
      required: ["dish_type", "cooking_method", "items"],
      additionalProperties: false,
    },
  },
  required: ["title", "servings", "prep_time_minutes", "difficulty", "ingredients", "instructions", "nutrition", "assumptions", "portion"],
  additionalProperties: false,
};

// language: tarifin kullanıcıya görünen metinlerinin dili (uygulama dili); sayılar/şema değişmez.
export async function extractRecipeFromCaption({ link, caption, timeoutMs, language = DEFAULT_CONTENT_LANG }) {
  const lang = isContentLanguage(language) ? language : DEFAULT_CONTENT_LANG;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Sunucu yapılandırması eksik: ANTHROPIC_API_KEY tanımlı değil.");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let data;
  try {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 16000,
        system: recipeSystemPrompt(lang),
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: buildRecipeUserText({ link, caption, notes: "", imageCount: 0 }) }],
          },
        ],
        output_config: { format: { type: "json_schema", schema: RECIPE_SCHEMA } },
      }),
    });
    data = await response.json().catch(() => null);
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`Tarif oluşturma ${Math.round(timeoutMs / 1000)} sn içinde bitmedi.`);
    throw new Error("Claude API'ye ulaşılamadı.");
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok || !data) {
    throw new Error(`Claude API hatası (${response.status}): ${data?.error?.message || "bilinmeyen"}`);
  }
  if (data.stop_reason === "max_tokens") throw new Error("Tarif çok uzun olduğu için tamamlanamadı.");
  if (data.stop_reason === "refusal") throw new Error("Bu içerikten tarif oluşturulamadı.");

  const text = (data.content || [])
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();
  let recipe;
  try {
    recipe = JSON.parse(text);
  } catch (e) {
    throw new Error("Tarif ayrıştırılamadı.");
  }
  if (!recipe || typeof recipe.title !== "string" || !Array.isArray(recipe.ingredients)) {
    throw new Error("Tarif ayrıştırılamadı.");
  }
  return { recipe: { ...applyPortionEstimate(recipe), content_lang: lang }, usage: data.usage, stopReason: data.stop_reason };
}
