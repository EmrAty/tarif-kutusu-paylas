// Fable denetim bulgusu F1 — "Elimde Bunlar Var" öneri ucu (api/suggest-recipes.js)
// model çıktısını doğrulamadan istemciye iletiyordu: json_schema yok, stop_reason
// kontrolü yok, max_tokens 4096 (düşünme token'ları da buradan düşer). Biçimsiz
// çıktı istemcide render'ı çökertebiliyor ya da kişisel listeye kalıcı yazılıyordu.
// Anthropic hep taklit; gerçek çağrı/para yok.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setRoutes, calls, invoke, resetDb, json, db, zsetSize, drainBackground } from "./helpers/fakeServices.mjs";

const { default: suggest, normalizeSuggestions } = await import("../api/suggest-recipes.js");
const { __setClockForTests } = await import("../api/_lib/aiGuard.js");
__setClockForTests(() => Date.UTC(2026, 10, 11, 9, 30, 20));
const { SUGGESTIONS_SCHEMA, normalizeSuggestion, MAX_SUGGESTIONS } = await import("../shared/pantrySuggestions.js");

const ANTHROPIC = "https://api.anthropic.com/v1/messages";
const items = ["yumurta", "domates"];

const GOOD = {
  title: "Menemen",
  why: "Yumurta ve domates elinde var.",
  extra_needed: ["biber"],
  ingredients: [
    { name: "yumurta", amount: "3 adet" },
    { name: "domates", amount: "2 adet" },
  ],
  instructions: ["Domatesi pişir.", "Yumurtayı ekle."],
  nutrition: { calories: 420, protein_g: 21, carbs_g: 12, fat_g: 30 },
};

const claude = (payload, extra = {}) => () =>
  json(200, {
    stop_reason: "end_turn",
    content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) }],
    usage: { output_tokens: 10 },
    ...extra,
  });
const anthropicCalls = () => calls.filter((c) => c.url === ANTHROPIC);
const lease = (uid) => zsetSize(`ai:inflight:suggest:${uid}`);
const globalHour = () => {
  let total = 0;
  for (const [key, value] of db) if (key.startsWith("rl:global:ai:3600:") && typeof value === "string") total += Number(value);
  return total;
};

async function reset(route) {
  await drainBackground();
  resetDb();
  setRoutes([[ANTHROPIC, route]]);
}

// Yanıt yazıldığı anda kiranın bırakılmış olduğunu da ölçer.
async function call(uid, route) {
  await reset(route);
  let atResponse = null;
  const r = await invoke(suggest, { uid, body: { items }, onRespond: () => (atResponse = lease(uid)) });
  return { ...r, atResponse };
}

// ---------- (a) istek gövdesi ----------

test("istek: model claude-sonnet-5, json_schema çıktı biçimi, max_tokens 16000", async () => {
  const r = await call("REQ", claude({ suggestions: [GOOD] }));
  assert.equal(r.status, 200);
  const body = JSON.parse(anthropicCalls()[0].init.body);
  assert.equal(body.model, "claude-sonnet-5");
  assert.equal(body.max_tokens, 16000);
  assert.equal(body.thinking, undefined, "thinking parametresi eklenmez (extract ile aynı varsayılan)");
  assert.equal(body.output_config?.format?.type, "json_schema");
  assert.deepEqual(body.output_config.format.schema, SUGGESTIONS_SCHEMA);
});

test("şema: tüm alanlar zorunlu, bilinmeyen alan yok, desteklenmeyen dizi sınırı yok", () => {
  const item = SUGGESTIONS_SCHEMA.properties.suggestions.items;
  assert.equal(SUGGESTIONS_SCHEMA.additionalProperties, false);
  assert.deepEqual(SUGGESTIONS_SCHEMA.required, ["suggestions"]);
  assert.equal(item.additionalProperties, false);
  assert.deepEqual([...item.required].sort(), ["extra_needed", "ingredients", "instructions", "nutrition", "title", "why"]);
  assert.equal(item.properties.ingredients.items.additionalProperties, false);
  assert.deepEqual(item.properties.ingredients.items.required, ["name", "amount"]);
  assert.equal(item.properties.nutrition.additionalProperties, false);
  assert.deepEqual(item.properties.nutrition.required, ["calories", "protein_g", "carbs_g", "fat_g"]);
  const text = JSON.stringify(SUGGESTIONS_SCHEMA);
  assert.ok(!/minItems|maxItems/.test(text));
});

// ---------- (b) stop_reason ----------

test("stop_reason max_tokens: hata, kısmi öneri dönülmez; kira bırakılır", async () => {
  const r = await call("MAXT", claude({ suggestions: [GOOD] }, { stop_reason: "max_tokens" }));
  assert.equal(r.status, 502);
  assert.equal(r.body.suggestions, undefined);
  assert.equal(JSON.stringify(r.body).includes("Menemen"), false);
  assert.equal(r.atResponse, 0);
});

test("stop_reason refusal: 422, öneri dönülmez; kira bırakılır", async () => {
  const r = await call("REF", claude({ suggestions: [GOOD] }, { stop_reason: "refusal" }));
  assert.equal(r.status, 422);
  assert.equal(r.body.suggestions, undefined);
  assert.equal(r.atResponse, 0);
});

// ---------- (c) biçimsiz çıktı ----------

test("suggestions dizi değil (nesne) → 502", async () => {
  const r = await call("OBJ", claude({ suggestions: { 0: GOOD } }));
  assert.equal(r.status, 502);
  assert.equal(r.body.suggestions, undefined);
  assert.equal(r.atResponse, 0);
});

test("hiç geçerli öneri yok (boş dizi / hepsi başlıksız) → 502", async () => {
  for (const payload of [{ suggestions: [] }, { suggestions: [{ ...GOOD, title: { tr: "x" } }, null, "metin"] }, {}, []]) {
    const r = await call("EMPTY", claude(payload));
    assert.equal(r.status, 502, JSON.stringify(payload));
    assert.equal(r.atResponse, 0);
  }
});

test("biçimsiz alanlar normalize edilir; bilinmeyen alanlar atılır", async () => {
  const r = await call(
    "BAD",
    claude({
      suggestions: [
        { ...GOOD, title: { tr: "nesne" } }, // atılır
        {
          title: "  Domatesli Yumurta  ",
          why: { a: 1 },
          extra_needed: "biber",
          ingredients: [null, "tuz", { name: "", amount: "1" }, { name: "yumurta", amount: 2 }, { name: { x: 1 }, amount: "1" }, { name: "domates", amount: "1 adet", extra: "x" }],
          instructions: "Hepsini pişir.",
          nutrition: "çok",
          evil: "<script>",
        },
        { ...GOOD, title: "Kısmi besin", instructions: ["  ", 5, "Pişir."], nutrition: { calories: "300", protein_g: 10, carbs_g: Infinity, fat_g: null } },
      ],
      extra: true,
    })
  );
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body), ["suggestions"]);
  assert.equal(r.body.suggestions.length, 2);
  const [a, b] = r.body.suggestions;
  assert.deepEqual(a, {
    title: "Domatesli Yumurta",
    why: "",
    extra_needed: [],
    ingredients: [
      { name: "yumurta", amount: "" },
      { name: "domates", amount: "1 adet" },
    ],
    instructions: [],
  });
  assert.equal(b.title, "Kısmi besin");
  assert.deepEqual(b.instructions, ["Pişir."]);
  assert.deepEqual(b.nutrition, { protein_g: 10 });
  assert.equal(r.atResponse, 0);
});

test("en çok 5 öneri döner (model 9 döndürse de)", async () => {
  const nine = Array.from({ length: 9 }, (_, i) => ({ ...GOOD, title: `Öneri ${i + 1}` }));
  const r = await call("NINE", claude({ suggestions: nine }));
  assert.equal(r.status, 200);
  assert.equal(r.body.suggestions.length, MAX_SUGGESTIONS);
  assert.deepEqual(r.body.suggestions.map((s) => s.title), ["Öneri 1", "Öneri 2", "Öneri 3", "Öneri 4", "Öneri 5"]);
});

test("metin uzunlukları sınırlanır", () => {
  const s = normalizeSuggestion({ ...GOOD, title: "x".repeat(5000), why: "y".repeat(5000), instructions: ["z".repeat(50_000)] });
  assert.ok(s.title.length <= 120);
  assert.ok(s.why.length <= 400);
  assert.ok(s.instructions[0].length <= 1500);
});

// ---------- (d) geçerli çıktı ----------

test("geçerli çıktı aynen geçer (``` sarmalı da zararsız)", async () => {
  const payload = { suggestions: [GOOD, { ...GOOD, title: "Şakşuka", extra_needed: [] }, { ...GOOD, title: "Omlet" }] };
  let r = await call("OK", claude(payload));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, payload);
  assert.equal(r.atResponse, 0);
  r = await call("OK2", claude("```json\n" + JSON.stringify(payload) + "\n```"));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, payload);
  assert.deepEqual(normalizeSuggestions(payload), payload.suggestions);
});

// ---------- (e) sağlayıcı hataları, kira ve sayaçlar ----------

test("sağlayıcı hesabı kullanılamıyor (kredi/anahtar) → 503 ai_unavailable; gövde sızmaz", async () => {
  const route = () => json(400, { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the API." } });
  const r = await call("CRED", route);
  assert.equal(r.status, 503);
  assert.equal(r.body.code, "ai_unavailable");
  assert.equal(JSON.stringify(r.body).includes("credit"), false);
  assert.equal(r.atResponse, 0);
  const r401 = await call("KEY", () => json(401, { error: { type: "authentication_error", message: "invalid x-api-key" } }));
  assert.equal(r401.body.code, "ai_unavailable");
});

test("yoğunluk 529 → 503 ai_capacity; diğer sağlayıcı hatası → 502; ayrıştırılamayan metin → 502", async () => {
  let r = await call("BUSY", () => json(529, { error: { message: "overloaded" } }));
  assert.equal(r.status, 503);
  assert.equal(r.body.code, "ai_capacity");
  r = await call("P500", () => json(500, { error: { message: "secret detail" } }));
  assert.equal(r.status, 502);
  assert.equal(JSON.stringify(r.body).includes("secret"), false);
  r = await call("JUNK", claude("bu json değil"));
  assert.equal(r.status, 502);
  assert.equal(r.atResponse, 0);
});

test("ağ hatası/zaman aşımı → 502; kira bırakılır", async () => {
  const r = await call("NET", () => {
    throw new TypeError("fetch failed");
  });
  assert.equal(r.status, 502);
  assert.equal(r.atResponse, 0);
});

test("maliyet sayacı: Claude'a giden her istek (hatalı çıktı dahil) bir kez sayılır; doğrulama redleri sayılmaz", async () => {
  await reset(claude({ suggestions: "bozuk" }));
  await invoke(suggest, { uid: "CNT", body: { items: [] } }); // 400
  assert.equal(globalHour(), 0);
  const r = await invoke(suggest, { uid: "CNT", body: { items } });
  assert.equal(r.status, 502);
  assert.equal(globalHour(), 1);
  assert.equal(anthropicCalls().length, 1);
  assert.equal(lease("CNT"), 0);
});

// ---------- istemci savunma katmanı ----------

test("istemci: PantryFinder ve kayıt yolu normalize fonksiyonlarını kullanır", () => {
  const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(app, /import \{ normalizeSuggestion, normalizeSuggestions \} from "\.\.\/shared\/pantrySuggestions\.js";/);
  assert.match(app, /setSuggestions\(normalizeSuggestions\(data\)\)/);
  assert.ok(!/data\.suggestions \|\| \[\]/.test(app));
  const save = app.slice(app.indexOf("const handleSavePantrySuggestion"), app.indexOf("const [shoppingInitialContext"));
  assert.match(save, /const clean = normalizeSuggestion\(suggestion\)/);
  assert.match(save, /instructions: clean\.instructions/);
  assert.ok(!/suggestion\.instructions|suggestion\.ingredients/.test(save), "kayda ham model çıktısı girmez");
});

test("istemci kaydı: biçimsiz öneriden yalnız metin dizileri çıkar", () => {
  const s = normalizeSuggestion({ title: "Çorba", instructions: "tek metin", ingredients: [null, { name: "su", amount: null }], nutrition: { calories: 100 } });
  assert.deepEqual(s, { title: "Çorba", why: "", extra_needed: [], ingredients: [{ name: "su", amount: "" }], instructions: [], nutrition: { calories: 100 } });
  assert.equal(normalizeSuggestion(null), null);
  assert.equal(normalizeSuggestion({ title: "   " }), null);
  assert.equal(normalizeSuggestion([GOOD]), null);
});
