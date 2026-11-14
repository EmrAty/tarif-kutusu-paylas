// Deney ucu (api/experiment.js): kapı, girdi kısıtı, sunucu tarafı bütçe tavanı, tekrar çağrı yok.
// Ağsız: bellek içi Redis (gerçek Lua, fengari) ve sahte Anthropic.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createMemoryRedis } from "./helpers/memoryRedis.mjs";

const KV = "https://kv.test";
process.env.KV_REST_API_URL = KV;
process.env.KV_REST_API_TOKEN = "test-token";
process.env.ANTHROPIC_API_KEY = "sk-test-SECRET-should-never-appear";
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-kid", alg: "RS256", use: "sig" };
function idToken(uid) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const h = enc({ alg: "RS256", kid: "test-kid", typ: "JWT" });
  const p = enc({ iss: "https://securetoken.google.com/tarif-kutusu", aud: "tarif-kutusu", sub: uid, iat: now, exp: now + 3600, firebase: { sign_in_provider: "anonymous" } });
  return `${h}.${p}.${crypto.sign("RSA-SHA256", Buffer.from(`${h}.${p}`), privateKey).toString("base64url")}`;
}

const db = new Map();
const memoryRedis = createMemoryRedis(db);
let anthropicCalls = [];
let anthropicReply = () => ({ status: 200, body: okBody(3000, 700) });
function okBody(inTok, outTok) {
  const recipe = { title: "T", servings: null, servings_unit: "porsiyon", prep_time_minutes: 10, difficulty: "Kolay", ingredients: [{ name: "un", amount: "1 su bardağı" }], instructions: ["karıştır"], nutrition: { calories: 1, protein_g: 1, carbs_g: 1, fat_g: 1 }, assumptions: "", portion: { dish_type: "diger", cooking_method: "firin", items: [] } };
  return { stop_reason: "end_turn", usage: { input_tokens: inTok, output_tokens: outTok }, content: [{ type: "text", text: JSON.stringify(recipe) }] };
}
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  if (url.startsWith(`${KV}/get/`)) {
    const key = decodeURIComponent(url.slice(`${KV}/get/`.length));
    const v = db.get(key);
    return json(200, { result: typeof v === "string" ? v : null });
  }
  if (url === `${KV}/pipeline`) return json(200, memoryRedis.pipeline(JSON.parse(init.body)));
  if (url === KV) {
    const cmd = JSON.parse(init.body);
    if (cmd[0].toUpperCase() === "SET" && cmd.includes("NX") && db.has(cmd[1])) return json(200, { result: null });
    if (cmd[0].toUpperCase() === "SET") {
      db.set(cmd[1], cmd[2]);
      return json(200, { result: "OK" });
    }
    if (cmd[0].toUpperCase() === "DEL") return json(200, { result: cmd.slice(1).reduce((n, k) => n + (db.delete(k) ? 1 : 0), 0) });
    return json(200, { result: memoryRedis.run(cmd) });
  }
  if (url.includes("securetoken@system.gserviceaccount.com")) return json(200, { keys: [jwk] });
  if (url === "https://api.anthropic.com/v1/messages") {
    anthropicCalls.push(JSON.parse(init.body));
    const { status, body } = anthropicReply();
    return json(status, body);
  }
  throw new Error(`beklenmeyen istek: ${url}`);
};

const { default: handler, CAP_MICRO_USD } = await import("../api/experiment.js");
async function call(method, body, { noAuth = false } = {}) {
  const out = { status: 200, body: undefined };
  const res = { status(c) { out.status = c; return this; }, json(p) { out.body = p; return this; }, setHeader() {} };
  await handler({ method, headers: noAuth ? {} : { authorization: `Bearer ${idToken("EXP")}` }, body, query: {} }, res);
  return out;
}
const enable = () => Object.assign(process.env, { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "experiment/cheap-extraction" });
const reset = () => { db.clear(); anthropicCalls = []; anthropicReply = () => ({ status: 200, body: okBody(3000, 700) }); };

test("izolasyon: production'a benzeyen ya da tanımsız Redis'te HİÇBİR Redis/ağ isteği olmadan 503", async () => {
  reset();
  enable();
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, i) => (seen.push(String(u)), realFetch(u, i));
  try {
    for (const url of ["https://cyclamen-island-12345.upstash.io", "", "not a url"]) {
      process.env.KV_REST_API_URL = url;
      const r = await call("POST", { id: "c01", config: "haiku" });
      assert.equal(r.status, 503, url);
      assert.equal(r.body.error, "isolation");
      assert.ok(!JSON.stringify(r.body).includes("12345"), "host tam olarak dönmemeli");
    }
  } finally {
    process.env.KV_REST_API_URL = KV;
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(seen, []);
  assert.equal(anthropicCalls.length, 0);
});

test("durum: Redis parmak izi gizli değer içermez, anahtar sayıları salt okunur", async () => {
  reset();
  enable();
  db.set("user:A:recipes", "[]");
  const st = await call("GET");
  assert.equal(st.status, 200);
  assert.equal(st.body.redis.ok, true);
  assert.equal(st.body.redis.looksProduction, false);
  assert.equal(st.body.redis.keys.user, 1);
  assert.ok(!JSON.stringify(st.body).includes("test-token"));
  assert.ok(!JSON.stringify(st.body).includes("kv.test"));
});

test("token yoksa 401 (ortam doğru olsa bile), sağlayıcıya gidilmez", async () => {
  reset();
  enable();
  assert.equal((await call("POST", { id: "c01", config: "haiku" }, { noAuth: true })).status, 401);
  assert.equal((await call("GET", undefined, { noAuth: true })).status, 401);
  assert.equal(anthropicCalls.length, 0);
});

test("production, başka dal ya da ortam bilgisi yoksa uç 404", async () => {
  reset();
  for (const env of [{ VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "experiment/cheap-extraction" }, { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "group-5-ci-release" }, { VERCEL_ENV: "", VERCEL_GIT_COMMIT_REF: "" }]) {
    Object.assign(process.env, env);
    assert.equal((await call("POST", { id: "c01", config: "haiku" })).status, 404);
    assert.equal((await call("GET")).status, 404);
  }
  assert.equal(anthropicCalls.length, 0);
});

test("serbest girdi reddedilir: bilinmeyen id/config, ek alan (model, prompt)", async () => {
  reset();
  enable();
  for (const body of [{ id: "x", config: "haiku" }, { id: "c01", config: "claude-opus-5-5" }, { id: "c01", config: "haiku", model: "claude-opus-5-5" }, { id: "c01", config: "haiku", caption: "serbest metin" }, { id: "c01", config: "__proto__" }]) {
    assert.equal((await call("POST", body)).status, 400, JSON.stringify(body));
  }
  assert.equal(anthropicCalls.length, 0);
});

test("başarılı çağrı: gerçek token'dan maliyet, sonuç saklanır, ikinci istek yeni çağrı yapmaz, anahtar yanıtta yok", async () => {
  reset();
  enable();
  const r = await call("POST", { id: "c01", config: "sonnet" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.equal(r.body.costUsd, (3000 * 2 + 700 * 10) / 1e6);
  assert.equal(anthropicCalls[0].model, "claude-sonnet-5");
  const again = await call("POST", { id: "c01", config: "sonnet" });
  assert.equal(again.body.cached, true);
  assert.equal(anthropicCalls.length, 1);
  const st = await call("GET");
  assert.equal(st.body.spentUsd, (3000 * 2 + 700 * 10) / 1e6);
  assert.equal(st.body.reservedUsd, 0);
  assert.equal(st.body.hasAnthropicKey, true);
  assert.ok(!JSON.stringify([r.body, st.body]).includes("SECRET"));
});

test("ayarlar isteğe doğru yansır (effort, düşünme kapalı, Haiku)", async () => {
  reset();
  enable();
  await call("POST", { id: "c01", config: "sonnet-low" });
  await call("POST", { id: "c01", config: "sonnet-nothink" });
  await call("POST", { id: "c01", config: "haiku-nothink" });
  assert.equal(anthropicCalls[0].output_config.effort, "low");
  assert.equal(anthropicCalls[0].thinking, undefined);
  assert.deepEqual(anthropicCalls[1].thinking, { type: "disabled" });
  assert.equal(anthropicCalls[2].model, "claude-haiku-5-5");
});

test("tavan: harcanan + en kötü durum > 3 $ ise sağlayıcıya hiç gidilmez (402)", async () => {
  reset();
  enable();
  db.set("exp:cheap-extraction:spent-micro", String(CAP_MICRO_USD - 100_000)); // 2,90 $ harcanmış
  const r = await call("POST", { id: "c02", config: "sonnet" }); // en kötü durum ~0,17 $
  assert.equal(r.status, 402);
  assert.equal(r.body.error, "budget_cap");
  assert.equal(anthropicCalls.length, 0);
  // Haiku'nun en kötü durumu (~0,01 $) sığar
  const h = await call("POST", { id: "c02", config: "haiku" });
  assert.equal(h.status, 200);
  assert.equal(anthropicCalls.length, 1);
});

test("4xx ayar hatası faturalanmaz ve kalıcı saklanır; zaman aşımı en kötü durum kadar harcanmış sayılır", async () => {
  reset();
  enable();
  anthropicReply = () => ({ status: 400, body: { error: { type: "invalid_request_error", message: "unsupported" } } });
  const bad = await call("POST", { id: "c03", config: "haiku" });
  assert.equal(bad.body.ok, false);
  assert.equal(bad.body.costUsd, 0);
  assert.equal((await call("POST", { id: "c03", config: "haiku" })).body.cached, true);
  // max_tokens'a takılan çağrı faturalanır (kullanım hatada da korunur)
  anthropicReply = () => ({ status: 200, body: { stop_reason: "max_tokens", usage: { input_tokens: 3000, output_tokens: 16000 }, content: [] } });
  const cut = await call("POST", { id: "c04", config: "haiku" });
  assert.equal(cut.body.ok, false);
  assert.equal(cut.body.costUsd, (3000 * 0.1 + 16000 * 0.5) / 1e6);
  const st = await call("GET");
  assert.equal(st.body.reservedUsd, 0);
  assert.equal(st.body.calls.length, 2);
});
