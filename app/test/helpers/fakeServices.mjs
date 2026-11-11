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
export const db = new Map(); // key -> string | Map (zset)
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

function zset(key) {
  let z = db.get(key);
  if (!(z instanceof Map)) {
    z = new Map();
    db.set(key, z);
  }
  return z;
}

export function runRedis([op, ...args]) {
  redisLog.push([op, ...args]);
  switch (op.toUpperCase()) {
    case "GET":
      return db.has(args[0]) ? db.get(args[0]) : null;
    case "SET": {
      const [key, value, ...opts] = args;
      if (opts.includes("NX") && db.has(key)) return null;
      db.set(key, value);
      return "OK";
    }
    case "DEL":
      return args.reduce((n, key) => n + (db.delete(key) ? 1 : 0), 0);
    case "INCR":
    case "DECR": {
      const next = Number(db.get(args[0]) || 0) + (op.toUpperCase() === "INCR" ? 1 : -1);
      db.set(args[0], String(next));
      return next;
    }
    case "HSET": {
      const h = db.get(args[0]) instanceof Map ? db.get(args[0]) : new Map();
      db.set(args[0], h);
      for (let i = 1; i < args.length; i += 2) h.set(args[i], args[i + 1]);
      return (args.length - 1) / 2;
    }
    case "HMGET": {
      const h = db.get(args[0]);
      return args.slice(1).map((f) => (h instanceof Map && h.has(f) ? h.get(f) : null));
    }
    case "EXPIRE":
    case "PEXPIRE":
      return db.has(args[0]) ? 1 : 0;
    case "ZADD":
      zset(args[0]).set(args[2], Number(args[1]));
      return 1;
    case "ZREM":
      return zset(args[0]).delete(args[1]) ? 1 : 0;
    case "ZCARD":
      return zset(args[0]).size;
    case "ZREMRANGEBYSCORE": {
      const z = zset(args[0]);
      const max = args[2] === "+inf" ? Infinity : Number(args[2]);
      let n = 0;
      for (const [member, score] of z) if (score <= max) n += z.delete(member) ? 1 : 0;
      return n;
    }
    default:
      throw new Error(`Test Redis'i bu komutu desteklemiyor: ${op}`);
  }
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
    if (url.startsWith(`${KV}/get/`)) return json(200, { result: runRedis(["GET", decodeURIComponent(url.slice(`${KV}/get/`.length))]) });
    if (url === `${KV}/pipeline`) return json(200, JSON.parse(init.body).map((c) => ({ result: runRedis(c) })));
    if (url === KV) return json(200, { result: runRedis(JSON.parse(init.body)) });
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
}
