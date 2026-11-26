import test from "node:test";
import assert from "node:assert/strict";
import { buildShareUrl, parseShareToken, readShareTokenFromLocation, TOKEN_RE } from "./qrLink.js";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUv-_";

test("buildShareUrl builds and validates", () => {
  assert.equal(buildShareUrl("https://tarifkutusu.app/", TOKEN), `https://tarifkutusu.app/?recipeShare=${TOKEN}`);
  assert.throws(() => buildShareUrl("https://tarifkutusu.app", "short"));
  assert.throws(() => buildShareUrl("https://tarifkutusu.app", "a b".repeat(10)));
  assert.ok(TOKEN_RE.test(TOKEN));
});

test("parseShareToken accepts known hosts", () => {
  for (const origin of ["https://tarifkutusu.app", "https://www.tarifkutusu.app", "https://preview.tarifkutusu.app", "https://tarif-kutusu-paylas.vercel.app", "http://localhost:5173", "http://127.0.0.1:3000"]) {
    assert.equal(parseShareToken(`  ${buildShareUrl(origin, TOKEN)}\n`), TOKEN, origin);
  }
});

test("parseShareToken accepts currentOrigin host only when given", () => {
  const url = buildShareUrl("https://my-preview.example.com", TOKEN);
  assert.equal(parseShareToken(url), null);
  assert.equal(parseShareToken(url, { currentOrigin: "https://my-preview.example.com" }), TOKEN);
});

test("parseShareToken rejects bad input", () => {
  assert.equal(parseShareToken(buildShareUrl("https://evil.example", TOKEN)), null);
  assert.equal(parseShareToken(`https://tarifkutusu.app.evil.com/?recipeShare=${TOKEN}`), null);
  assert.equal(parseShareToken(`https://tarifkutusu.app@evil.com/?recipeShare=${TOKEN}`), null);
  assert.equal(parseShareToken(`javascript:alert(1)//tarifkutusu.app/?recipeShare=${TOKEN}`), null);
  assert.equal(parseShareToken(`ftp://tarifkutusu.app/?recipeShare=${TOKEN}`), null);
  assert.equal(parseShareToken("merhaba"), null);
  assert.equal(parseShareToken(""), null);
  assert.equal(parseShareToken(null), null);
  assert.equal(parseShareToken("https://tarifkutusu.app/?recipeShare=short"), null);
  assert.equal(parseShareToken("https://tarifkutusu.app/"), null);
  assert.equal(parseShareToken(`https://tarifkutusu.app/?recipeShare=${TOKEN}&x=${"a".repeat(2100)}`), null);
});

test("readShareTokenFromLocation", () => {
  assert.equal(readShareTokenFromLocation({ search: `?recipeShare=${TOKEN}` }), TOKEN);
  assert.equal(readShareTokenFromLocation({ search: "?recipeShare=x" }), null);
  assert.equal(readShareTokenFromLocation({ search: "" }), null);
  assert.equal(readShareTokenFromLocation(undefined), null);
});
