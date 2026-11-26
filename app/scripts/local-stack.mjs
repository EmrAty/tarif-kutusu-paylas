// Yerel uçtan uca yığın: gerçek web istemcisi (dist) + gerçek /api/* işleyicileri,
// bellek içi (Upstash REST uyumlu) Redis üzerinde. Production/Preview'a dokunmaz.
// Kimlik doğrulama gerçektir (Firebase ID token'ları Google JWKS ile doğrulanır);
// hiçbir yetki atlatması yoktur. Kullanım: README-local-stack.md
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createMemoryRedis } from "../test/helpers/memoryRedis.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, "..");
const API_DIR = path.join(APP_DIR, "api");
const MAX_BODY = 6 * 1024 * 1024;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

// ---------- kalıcılık ----------
const replacer = (_k, v) => (v instanceof Map ? { $map: [...v.entries()] } : v);
const reviver = (_k, v) => (v && typeof v === "object" && Array.isArray(v.$map) ? new Map(v.$map) : v);

export function serializeDb(db) {
  return JSON.stringify([...db.entries()], replacer);
}
export function loadDb(db, file) {
  if (!file || !fs.existsSync(file)) return;
  const entries = JSON.parse(fs.readFileSync(file, "utf8"), reviver);
  for (const [k, v] of entries) db.set(k, v);
}
function writeDbAtomic(db, file) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, serializeDb(db));
  fs.renameSync(tmp, file);
}

const READ_ONLY = new Set(["GET", "MGET", "EXISTS", "TTL", "PTTL", "KEYS", "SCAN", "PING", "HGET", "HMGET", "HGETALL", "HLEN", "HKEYS", "LRANGE", "LLEN", "ZRANGE", "ZRANGEBYSCORE", "ZCARD", "ZCOUNT", "ZSCORE", "ZRANK"]);

// Aynı süreçte yeniden başlatmada Redis adresi/anahtarı sabit kalır: işleyici
// modülleri KV_REST_API_URL'i import anında okuyup önbelleğe alır.
let sticky = null;

// ---------- vercel.json ----------
function pathToRegex(source) {
  let out = "";
  for (let i = 0; i < source.length; ) {
    const rest = source.slice(i);
    if (rest.startsWith("(.*)")) { out += "(.*)"; i += 4; continue; }
    const m = /^:([A-Za-z0-9_]+)/.exec(rest);
    if (m) { out += "([^/]+)"; i += m[0].length; continue; }
    out += source[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    i += 1;
  }
  return new RegExp(`^${out}$`);
}

function loadVercelConfig() {
  const cfg = JSON.parse(fs.readFileSync(path.join(APP_DIR, "vercel.json"), "utf8"));
  const rewrites = new Map((cfg.rewrites || []).map((r) => [r.source, r.destination]));
  const headers = (cfg.headers || []).map((h) => ({ re: pathToRegex(h.source), headers: h.headers }));
  return { rewrites, headers };
}

// ---------- Upstash REST uyumlu Redis ----------
function startRedisServer({ db, token, port, onMutate }) {
  const memory = createMemoryRedis(db);
  const mutating = (c) => Array.isArray(c) && !READ_ONLY.has(String(c[0]).toUpperCase());
  const send = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json", Connection: "close" });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer(async (req, res) => {
    try {
      if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { error: "Unauthorized" });
      const url = new URL(req.url, "http://x");
      if (req.method === "GET" && url.pathname.startsWith("/get/")) {
        try {
          return send(res, 200, { result: memory.run(["GET", decodeURIComponent(url.pathname.slice(5))]) });
        } catch (e) {
          return send(res, 400, { error: e.message });
        }
      }
      if (req.method !== "POST") return send(res, 405, { error: "method" });
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (url.pathname === "/pipeline") {
        const out = memory.pipeline(body);
        if (body.some(mutating)) onMutate();
        return send(res, 200, out);
      }
      if (url.pathname === "/") {
        try {
          const result = memory.run(body);
          if (mutating(body)) onMutate();
          return send(res, 200, { result });
        } catch (e) {
          return send(res, 400, { error: e.message });
        }
      }
      return send(res, 404, { error: "not found" });
    } catch (e) {
      return send(res, 400, { error: String(e.message || e) });
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port || 0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

// ---------- Vercel benzeri req/res ----------
function adaptRes(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => {
    if (!res.getHeader("content-type")) res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(obj));
    return res;
  };
  res.send = (x) => {
    if (x !== null && typeof x === "object" && !Buffer.isBuffer(x)) return res.json(x);
    if (!res.getHeader("content-type")) res.setHeader("Content-Type", Buffer.isBuffer(x) ? "application/octet-stream" : "text/html; charset=utf-8");
    res.end(x);
    return res;
  };
  res.redirect = (a, b) => {
    const [code, url] = b === undefined ? [307, a] : [a, b];
    res.statusCode = code;
    res.setHeader("Location", url);
    res.end();
    return res;
  };
  return res;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error("too large"), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

function parseQuery(search) {
  const query = {};
  for (const [k, v] of new URLSearchParams(search)) {
    if (k in query) query[k] = Array.isArray(query[k]) ? [...query[k], v] : [query[k], v];
    else query[k] = v;
  }
  return query;
}

// ---------- ana sunucu ----------
export async function startLocalStack({ port = 4173, host = "127.0.0.1", dist = path.join(APP_DIR, "dist"), dbFile } = {}) {
  const distDir = path.resolve(dist);
  const db = new Map();
  if (dbFile) loadDb(db, dbFile);

  let timer = null;
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (dbFile) writeDbAtomic(db, dbFile);
  };
  const onMutate = () => {
    if (!dbFile || timer) return;
    timer = setTimeout(() => { timer = null; try { writeDbAtomic(db, dbFile); } catch (e) { console.error("db write failed:", e.message); } }, 300);
  };

  if (!sticky) sticky = { token: crypto.randomBytes(24).toString("hex"), port: 0 };
  let redis;
  try {
    redis = await startRedisServer({ db, token: sticky.token, port: sticky.port, onMutate });
  } catch (e) {
    if (!sticky.port) throw e;
    throw new Error(`Redis port ${sticky.port} could not be reused: ${e.message}`);
  }
  sticky.port = redis.port;
  const redisUrl = `http://127.0.0.1:${redis.port}`;
  process.env.KV_REST_API_URL = redisUrl;
  process.env.KV_REST_API_TOKEN = sticky.token;

  const vercel = loadVercelConfig();
  const handlers = new Map();
  const loadHandler = async (name) => {
    if (!handlers.has(name)) {
      const file = path.join(API_DIR, `${name}.js`);
      if (!fs.existsSync(file)) {
        handlers.set(name, null);
      } else {
        const mod = await import(pathToFileURL(file).href);
        handlers.set(name, typeof mod.default === "function" ? mod.default : null);
      }
    }
    return handlers.get(name);
  };

  const applyHeaders = (res, pathname) => {
    for (const rule of vercel.headers) {
      if (rule.re.test(pathname)) for (const h of rule.headers) res.setHeader(h.key, h.value);
    }
  };
  const plain = (res, status, text) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(res.req && res.req.method === "HEAD" ? undefined : text);
  };

  async function serveApi(req, res, url) {
    const m = /^\/api\/([a-z0-9-]+)\/?$/.exec(url.pathname);
    const handler = m ? await loadHandler(m[1]) : null;
    if (!handler) return res.status(404).json({ error: "Not found" });
    req.query = parseQuery(url.search);
    if (req.method !== "GET" && req.method !== "HEAD") {
      let raw;
      try {
        raw = await readBody(req);
      } catch (e) {
        if (e.status === 413) return res.status(413).json({ error: "Payload too large" });
        throw e;
      }
      const text = raw.toString("utf8");
      if ((req.headers["content-type"] || "").includes("application/json") && text) {
        try {
          req.body = JSON.parse(text);
        } catch {
          return res.status(400).json({ error: "Invalid JSON" });
        }
      } else req.body = text;
    }
    if (!req.headers["x-real-ip"]) req.headers["x-real-ip"] = req.socket.remoteAddress || "127.0.0.1";
    try {
      await handler(req, res);
    } catch (e) {
      console.error(`handler ${m[1]} threw:`, e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n") : e);
      if (!res.headersSent) res.status(500).json({ error: "Internal error" });
      else res.end();
    }
  }

  function serveStatic(req, res, url) {
    if (req.method !== "GET" && req.method !== "HEAD") return plain(res, 405, "Method Not Allowed");
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return plain(res, 400, "Bad Request");
    }
    if (pathname.includes("\0")) return plain(res, 400, "Bad Request");
    pathname = vercel.rewrites.get(pathname) || pathname;
    if (pathname.endsWith("/")) pathname += "index.html";
    const file = path.resolve(distDir, "." + path.posix.normalize("/" + pathname));
    if (file !== distDir && !file.startsWith(distDir + path.sep)) return plain(res, 404, "Not Found");
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return plain(res, 404, "Not Found");
    }
    if (!stat.isFile()) return plain(res, 404, "Not Found");
    res.statusCode = 200;
    res.setHeader("Content-Type", TYPES[path.extname(file).toLowerCase()] || "application/octet-stream");
    res.setHeader("Content-Length", stat.size);
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).on("error", () => res.destroy()).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      res.statusCode = 400;
      return res.end();
    }
    res.on("finish", () => console.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`));
    adaptRes(res);
    applyHeaders(res, url.pathname);
    try {
      if (url.pathname.startsWith("/api/") || url.pathname === "/api") await serveApi(req, res, url);
      else serveStatic(req, res, url);
    } catch (e) {
      console.error("request failed:", e && e.message);
      if (!res.headersSent) res.status(500).json({ error: "Internal error" });
      else res.end();
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const addr = server.address();
  const url = `http://${host.includes(":") ? `[${host}]` : host}:${addr.port}`;

  let closed = false;
  return {
    url,
    redisUrl,
    redisToken: sticky.token,
    db,
    flush,
    async close() {
      if (closed) return;
      closed = true;
      flush();
      server.closeAllConnections?.();
      redis.server.closeAllConnections?.();
      await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => redis.server.close(r))]);
    },
  };
}

// ---------- CLI ----------
function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const [k, inline] = a.slice(2).split("=");
    opts[k] = inline !== undefined ? inline : argv[++i];
  }
  return opts;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const dbFile = args.db ? path.resolve(args.db) : undefined;
  const stack = await startLocalStack({
    port: args.port !== undefined ? Number(args.port) : 4173,
    host: args.host || "127.0.0.1",
    dist: args.dist ? path.resolve(args.dist) : undefined,
    dbFile,
  });
  console.log(`local-stack ready ${stack.url} (redis: memory, db: ${dbFile || "none"})`);
  const stop = async () => {
    await stack.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
