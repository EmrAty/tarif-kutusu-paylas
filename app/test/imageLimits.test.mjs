// Problem 9 — ekran görüntüsü boyut/sayı kuralları (shared/imageLimits.js).
// Tarayıcıdaki canvas sıkıştırması (src/imageCompress.js) Node'da çalışmadığı
// için burada saf hesap ve doğrulama mantığı sınanıyor; tarayıcı tarafı ayrıca
// gerçek tarayıcıda denendi.
import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_IMAGES,
  MAX_IMAGE_EDGE,
  MAX_IMAGE_BASE64_CHARS,
  MAX_TOTAL_BASE64_CHARS,
  targetDimensions,
  base64Bytes,
  validateImageBatch,
} from "../shared/imageLimits.js";

test("büyük telefon ekran görüntüsü uzun kenarı 1568 px'e küçülür, en-boy oranı korunur", () => {
  const out = targetDimensions(1440, 3200);
  assert.equal(out.height, MAX_IMAGE_EDGE);
  assert.equal(out.width, 706);
  assert.equal(out.scaled, true);
  assert.ok(Math.abs(out.width / out.height - 1440 / 3200) < 0.002);
  const landscape = targetDimensions(4032, 3024);
  assert.equal(landscape.width, MAX_IMAGE_EDGE);
  assert.equal(landscape.height, 1176);
});

test("küçük görsel büyütülmez", () => {
  assert.deepEqual(targetDimensions(720, 1280), { width: 720, height: 1280, scaled: false });
  assert.deepEqual(targetDimensions(1568, 1000), { width: 1568, height: 1000, scaled: false });
});

test("bozuk boyutlarda en az 1 px döner (bölme hatası yok)", () => {
  assert.deepEqual(targetDimensions(0, 0), { width: 1, height: 1, scaled: false });
  const thin = targetDimensions(20000, 3);
  assert.equal(thin.width, MAX_IMAGE_EDGE);
  assert.equal(thin.height, 1);
});

test("base64Bytes doğru bayt sayısını verir", () => {
  assert.equal(base64Bytes(Buffer.from("abc").toString("base64")), 3);
  assert.equal(base64Bytes(Buffer.from("abcd").toString("base64")), 4);
  assert.equal(base64Bytes(Buffer.from("abcde").toString("base64")), 5);
});

const img = (chars, mediaType = "image/jpeg") => ({ mediaType, data: "A".repeat(chars) });

test("kabul edilebilir yük: 6 tipik sıkıştırılmış ekran görüntüsü (~400 KB base64) geçer ve Vercel sınırının altında kalır", () => {
  const batch = Array.from({ length: MAX_IMAGES }, () => img(400_000));
  assert.equal(validateImageBatch(batch), null);
  const bodyBytes = JSON.stringify({ images: batch, caption: "x".repeat(20000) }).length;
  assert.ok(bodyBytes < 4.5 * 1024 * 1024, `istek gövdesi ${bodyBytes} bayt`);
  assert.ok(MAX_TOTAL_BASE64_CHARS + 100_000 < 4.5 * 1024 * 1024);
});

test("aşırı görsel sayısı reddedilir", () => {
  assert.deepEqual(validateImageBatch(Array.from({ length: MAX_IMAGES + 1 }, () => img(8))), { code: "too_many_images" });
});

test("tek görsel ve toplam yük sınırları ayrı ayrı uygulanır", () => {
  assert.equal(validateImageBatch([img(MAX_IMAGE_BASE64_CHARS + 4)]).code, "image_too_large");
  const each = 1_000_000;
  const count = Math.ceil(MAX_TOTAL_BASE64_CHARS / each) + 0;
  assert.equal(validateImageBatch(Array.from({ length: count }, () => img(each))).code, "images_total_too_large");
});

test("desteklenmeyen tür ve bozuk veri anlamlı kodla reddedilir", () => {
  assert.equal(validateImageBatch([img(8, "image/heic")]).code, "image_unsupported");
  assert.equal(validateImageBatch([{ mediaType: "image/png", data: "not base64!" }]).code, "image_invalid");
  assert.equal(validateImageBatch([{ mediaType: "image/png" }]).code, "image_invalid");
  assert.equal(validateImageBatch("x").code, "image_invalid");
  assert.equal(validateImageBatch([]), null);
  assert.equal(validateImageBatch(undefined), null);
});
