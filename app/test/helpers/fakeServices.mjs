// Grup 2 regresyon testleri için ortak sahte ortam: bellek içi Redis (Upstash
// REST + /pipeline), sahte Firebase ID token'ı (Google JWKS taklidi) ve rota
// tabanlı sahte fetch. Dış ağa hiç istek gitmez; tanımlanmamış her istek testi
// düşürür. Bu modül, test edilen API modüllerinden ÖNCE import edilmeli
// (ortam değişkenlerini ayarlıyor).
import crypto from "node:crypto";

export const KV = "https://kv.test";
process.env.KV_REST_API_URL = KV;
process.env.KV_REST_API_TOKEN = "test-token";
process.env.ANTHROPIC_API_KEY = "test-key";
delete process.env.OPENAI_API_KEY;
delete process.env.AI_KILL_SWITCH;
delete process.env.AI_GLOBAL_HOURLY_LIMIT;
delete process.env.AI_GLOBAL_DAILY_LIMIT;

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-kid", alg: "RS256", use: "sig" };

export function idToken(uid, { anonymous = false } = {}) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const header = enc({ alg: "RS256", kid: "test-kid", typ: "JWT" });
  const payload = enc({
    iss: "https://securetoken.google.com/tarif-kutusu",
    aud: "tarif-kutusu",
    sub: uid,
    iat: now,
    exp: now + 3600,
    firebase: { sign_in_provider: anonymous ? "anonymous" : "password" },
  });
  const sig = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
  return `${header}.${payload}.${sig}`;
}

// ---------- bellek içi Redis ----------
// Grup 1'in ortak motoru (test/helpers/memoryRedis.mjs): GET/SET/MGET, gerçek Lua
// ile EVAL (sürümlü kovalar), INCR/DECR, sıralı küme (kira), HASH ve /pipeline.
// Tek motor kullanılıyor ki AI koruması ile sürümlü yazım aynı ortamda
// birlikte sınansın.
import { createMemoryRedis } from "./memoryRedis.mjs";

export const db = new Map(); // key -> string | { type: "zset"|"hash"|"list", ... }
const memory = createMemoryRedis(db);
export const redisLog = [];
export let redisDown = false;
export function setRedisDown(value) {
  redisDown = value;
}
// Seçili komutlarda Redis hatası (HTTP 500) taklidi: fn(command) true dönerse o
// istek başarısız olur. Kira sızıntısı gibi "ara adımda Redis çöktü" testleri için.
let redisFault = null;
export function setRedisFault(fn) {
  redisFault = fn || null;
}

// Komut çalışmadan hemen önce araya girmek için (ör. job'un EVAL'inden önce
// başka bir istemcinin yazması). fn(command) async olabilir.
let redisHook = null;
export function setRedisHook(fn) {
  redisHook = fn || null;
}

export function runRedis(command) {
  redisLog.push(command);
  return memory.run(command);
}

// Kiradaki üye sayısı (ai:inflight:<havuz>:<uid>).
export function zsetSize(key) {
  const v = db.get(key);
  return v && v.type === "zset" ? v.map.size : 0;
}

// ---------- sahte fetch ----------
export const calls = [];
let routes = [];
export function setRoutes(list) {
  routes = list;
  calls.length = 0;
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
export { json };

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url.startsWith(KV)) {
    if (redisDown) return json(500, { error: "down" });
    if (redisFault) {
      const commands =
        url === `${KV}/pipeline`
          ? JSON.parse(init.body)
          : url.startsWith(`${KV}/get/`)
            ? [["GET", decodeURIComponent(url.slice(`${KV}/get/`.length))]]
            : [JSON.parse(init.body)];
      if (commands.some((c) => redisFault(c))) return json(500, { error: "fault" });
    }
    // Upstash gibi: komut hatası 400 + {error}; pipeline'da her eleman kendi
    // sonucunu ya da hatasını taşır.
    const single = (command) => {
      try {
        return json(200, { result: runRedis(command) });
      } catch (e) {
        return json(400, { error: e.message });
      }
    };
    if (redisHook && url === KV) {
      const hook = redisHook;
      await hook(JSON.parse(init.body));
    }
    if (url.startsWith(`${KV}/get/`)) return single(["GET", decodeURIComponent(url.slice(`${KV}/get/`.length))]);
    if (url === `${KV}/pipeline`) {
      const commands = JSON.parse(init.body);
      commands.forEach((c) => redisLog.push(c));
      return json(200, memory.pipeline(commands));
    }
    if (url === KV) return single(JSON.parse(init.body));
  }
  if (url.includes("securetoken@system.gserviceaccount.com")) return json(200, { keys: [jwk] });
  calls.push({ url, init });
  for (const [match, respond] of routes) {
    if (typeof match === "function" ? match(url) : url.startsWith(match)) return respond(url, init);
  }
  throw new Error(`Testte beklenmeyen dış istek: ${url}`);
};

// ---------- handler çağırıcı ----------
export async function invoke(handler, { method = "POST", uid = "U1", anonymous = false, token, body, query = {}, ip = "203.0.113.7" } = {}) {
  const headers = { "x-real-ip": ip };
  if (token !== null) headers.authorization = `Bearer ${token || idToken(uid, { anonymous })}`;
  const out = { status: 200, body: undefined, headers: {} };
  const res = {
    status(code) {
      out.status = code;
      return this;
    },
    json(payload) {
      out.body = payload;
      return this;
    },
    setHeader(name, value) {
      out.headers[name.toLowerCase()] = value;
    },
  };
  await handler({ method, headers, body, query }, res);
  return out;
}

export function resetDb() {
  db.clear();
  redisLog.length = 0;
  redisDown = false;
  redisFault = null;
  redisHook = null;
}
