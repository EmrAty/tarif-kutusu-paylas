import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { startLocalStack } from "../scripts/local-stack.mjs";

let tmp, dist, dbFile, stack;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "local-stack-"));
  dist = path.join(tmp, "dist");
  fs.mkdirSync(dist);
  fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>t</title>");
  fs.writeFileSync(path.join(dist, "privacy.html"), "<h1>privacy</h1>");
  fs.writeFileSync(path.join(tmp, "secret.txt"), "secret");
  dbFile = path.join(tmp, "db.json");
  stack = await startLocalStack({ port: 0, dist, dbFile });
});

after(async () => {
  await stack?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const rawGet = (base, rawPath) =>
  new Promise((resolve, reject) => {
    const u = new URL(base);
    http
      .get({ host: u.hostname, port: u.port, path: rawPath }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      })
      .on("error", reject);
  });

const redis = (s, command) =>
  fetch(s.redisUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${s.redisToken}` },
    body: JSON.stringify(command),
  }).then((r) => r.json());

test("index served with vercel.json security headers", async () => {
  const res = await fetch(`${stack.url}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.match(await res.text(), /<title>t<\/title>/);
});

test("rewrite /privacy -> privacy.html", async () => {
  const res = await fetch(`${stack.url}/privacy`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /privacy/);
});

test("unknown path is 404 (no SPA fallback)", async () => {
  assert.equal((await fetch(`${stack.url}/nope`)).status, 404);
});

test("path traversal is refused", async () => {
  for (const p of ["/../secret.txt", "/%2e%2e/secret.txt", "/..%2fsecret.txt", "/%00"]) {
    const status = await rawGet(stack.url, p);
    assert.ok(status === 404 || status === 400, `${p} -> ${status}`);
  }
});

test("/api/data without auth is 401 JSON with no-store", async () => {
  const res = await fetch(`${stack.url}/api/data?bucket=recipes&scope=user`);
  assert.equal(res.status, 401);
  assert.match(res.headers.get("content-type"), /application\/json/);
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  assert.ok((await res.json()).error);
});

test("_lib and unknown api names are 404", async () => {
  assert.equal((await fetch(`${stack.url}/api/_lib/redis`)).status, 404);
  assert.equal((await fetch(`${stack.url}/api/does-not-exist`)).status, 404);
});

test("redis endpoint requires its bearer token", async () => {
  const res = await fetch(stack.redisUrl, { method: "POST", body: JSON.stringify(["GET", "x"]) });
  assert.equal(res.status, 401);
});

test("db persists across restart (strings, hashes, zsets)", async () => {
  assert.deepEqual(await redis(stack, ["SET", "k1", "v1"]), { result: "OK" });
  await redis(stack, ["HSET", "h1", "f", "x"]);
  await redis(stack, ["ZADD", "z1", "5", "m"]);
  await stack.close();
  assert.ok(fs.existsSync(dbFile));

  stack = await startLocalStack({ port: 0, dist, dbFile });
  assert.deepEqual(await redis(stack, ["GET", "k1"]), { result: "v1" });
  assert.deepEqual(await redis(stack, ["HMGET", "h1", "f"]), { result: ["x"] });
  assert.deepEqual(await redis(stack, ["ZCARD", "z1"]), { result: 1 });
  const viaGet = await fetch(`${stack.redisUrl}/get/k1`, { headers: { Authorization: `Bearer ${stack.redisToken}` } });
  assert.deepEqual(await viaGet.json(), { result: "v1" });
});
