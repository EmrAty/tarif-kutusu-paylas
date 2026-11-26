import test from "node:test";
import assert from "node:assert/strict";
import qrcode from "qrcode-generator";
import { decodeFromImageData } from "./qrDecode.js";
import { buildShareUrl } from "./qrLink.js";

function rasterize(text, scale = 8, quiet = 4) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const size = (n + quiet * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!qr.isDark(r, c)) continue;
      for (let y = 0; y < scale; y++) {
        for (let x = 0; x < scale; x++) {
          const i = (((r + quiet) * scale + y) * size + (c + quiet) * scale + x) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
      }
    }
  }
  return { data, width: size, height: size };
}

test("round-trips a share URL", async () => {
  const url = buildShareUrl("https://tarifkutusu.app", "AbCdEfGhIjKlMnOpQrStUv-_");
  assert.equal(await decodeFromImageData(rasterize(url)), url);
});

test("blank image returns null", async () => {
  const data = new Uint8ClampedArray(200 * 200 * 4).fill(255);
  assert.equal(await decodeFromImageData({ data, width: 200, height: 200 }), null);
  assert.equal(await decodeFromImageData(null), null);
});
