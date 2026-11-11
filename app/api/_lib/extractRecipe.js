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
  SERVINGS_UNITS,
} from "../../shared/portionEstimate.js";

// Tarif çıkarmanın TEK sunucu yolu: hem "Yeni Tarif Çıkar" (/api/extract,
// görsel + not olabilir) hem paylaşım paneli job'u (/api/recipe-jobs) bunu
// kullanıyor. Model, system prompt, JSON şeması ve token sınırı yalnızca burada
// belirleniyor; istemci bunların hiçbirini seçemez (Kasım 2026'ya kadar
// /api/extract istemcinin gönderdiği system/messages/max_tokens'ı olduğu gibi
// iletiyordu). Çıktı şemaya bağlı (her zaman geçerli JSON); max_tokens yüksek
// çünkü claude-sonnet-5 önce düşünüyor ve düşünme token'ları da bu bütçeden
// harcanıyor; zaman aşımı var.
const MODEL = "claude-sonnet-5";
const MAX_TOKENS = 16000;

const RECIPE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    servings: { anyOf: [{ type: "integer" }, { type: "null" }] },
    servings_unit: { type: "string", enum: SERVINGS_UNITS },
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
              main: { type: "boolean" },
            },
            required: ["name", "kind", "quantity", "unit", "size", "state", "quantity_in_source", "main"],
            additionalProperties: false,
          },
        },
      },
      required: ["dish_type", "cooking_method", "items"],
      additionalProperties: false,
    },
  },
  required: ["title", "servings", "servings_unit", "prep_time_minutes", "difficulty", "ingredients", "instructions", "nutrition", "assumptions", "portion"],
  additionalProperties: false,
};

export class ExtractError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind; // "config" | "timeout" | "network" | "provider" | "too_long" | "refused" | "parse"
    this.providerStatus = undefined;
  }
}

// Paylaşım paneli job'u: yalnızca link + açıklama/transkript.
export async function extractRecipeFromCaption({ link, caption, timeoutMs, language = DEFAULT_CONTENT_LANG }) {
  return extractRecipe({ link, caption, notes: "", images: [], timeoutMs, language });
}

// language: tarifin kullanıcıya görünen metinlerinin dili (uygulama dili); sayılar/şema değişmez.
// images: [{ mediaType, data }] — çağıran taraf shared/imageLimits.js ile doğrulamış olmalı.
export async function extractRecipe({ link, caption = "", notes = "", images = [], timeoutMs, language = DEFAULT_CONTENT_LANG }) {
  const lang = isContentLanguage(language) ? language : DEFAULT_CONTENT_LANG;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new ExtractError("Sunucu yapılandırması eksik: ANTHROPIC_API_KEY tanımlı değil.", "config");

  const content = [
    ...images.map((img) => ({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } })),
    { type: "text", text: buildRecipeUserText({ link, caption, notes, imageCount: images.length }) },
  ];

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
        max_tokens: MAX_TOKENS,
        system: recipeSystemPrompt(lang),
        messages: [{ role: "user", content }],
        output_config: { format: { type: "json_schema", schema: RECIPE_SCHEMA } },
      }),
    });
    data = await response.json().catch(() => null);
  } catch (e) {
    if (e.name === "AbortError") throw new ExtractError(`Tarif oluşturma ${Math.round(timeoutMs / 1000)} sn içinde bitmedi.`, "timeout");
    throw new ExtractError("Claude API'ye ulaşılamadı.", "network");
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok || !data) {
    const err = new ExtractError(`Claude API hatası (${response.status}): ${data?.error?.message || "bilinmeyen"}`, "provider");
    err.providerStatus = response.status;
    throw err;
  }
  if (data.stop_reason === "max_tokens") throw new ExtractError("Tarif çok uzun olduğu için tamamlanamadı.", "too_long");
  if (data.stop_reason === "refusal") throw new ExtractError("Bu içerikten tarif oluşturulamadı.", "refused");

  const text = (data.content || [])
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();
  let recipe;
  try {
    recipe = JSON.parse(text);
  } catch (e) {
    throw new ExtractError("Tarif ayrıştırılamadı.", "parse");
  }
  if (!recipe || typeof recipe.title !== "string" || !Array.isArray(recipe.ingredients)) {
    throw new ExtractError("Tarif ayrıştırılamadı.", "parse");
  }
  return { recipe: { ...applyPortionEstimate(recipe), content_lang: lang }, usage: data.usage, stopReason: data.stop_reason };
}
