// Grup 5: yetki sözleşmesi — TÜM API uçları için tek tablo.
//
// Her uç, her yöntemle: token yok / bozuk / süresi geçmiş / başka Firebase
// projesi / başka yayıncı / tanınmayan anahtar / imzasız (alg none) / uid'siz
// token → 401; bu durumda Redis'e tek komut gitmez ve hiçbir dış servise
// (Anthropic, OpenAI, FCM, TikTok…) istek atılmaz. Silinmiş hesabın hâlâ geçerli
// token'ı yalnızca hesap silme ucunda (tekrar çağrılabilir olsun diye) kabul edilir.
// Yeni bir API dosyası eklenip bu tabloya yazılmazsa test düşer.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { invoke, resetDb, setRoutes, calls, redisLog, db, idToken, signedToken } from "./helpers/fakeServices.mjs";

const ENDPOINTS = {
  account: ["DELETE"],
  data: ["GET", "POST"],
  extract: ["POST"],
  families: ["GET", "POST"],
  "fcm-token": ["POST", "DELETE"],
  "fetch-caption": ["GET"],
  legacy: ["GET", "POST"],
  notify: ["POST"],
  profile: ["GET", "POST"],
  "recipe-jobs": ["GET", "POST"],
  "suggest-recipes": ["POST"],
  "translate-recipe": ["POST"],
};

// Uçların gövde/sorgu ile kimlik taşımaya çalışması da işe yaramamalı: bu
// alanlar her istekte gönderiliyor.
const SPOOF = { uid: "VICTIM", userId: "VICTIM", ownerUid: "VICTIM" };
const sampleRequest = {
  query: { bucket: "recipes", scope: "personal", id: "x", url: "https://www.tiktok.com/@a/video/1", ...SPOOF },
  body: {
    bucket: "recipes",
    scope: "personal",
    value: "[]",
    baseVersion: 0,
    link: "https://www.tiktok.com/@a/video/1",
    caption: "1 su bardağı mercimek",
    items: ["yumurta"],
    recipeId: "r1",
    target: "en",
    token: "fcm-token",
    platform: "android",
    familyId: "F1",
    recipeTitle: "Tarif",
    isPlus: true,
    action: "create",
    name: "Aile",
    requestId: "req-auth-1",
    sourceUrl: "https://www.instagram.com/p/X/",
    category: "Kahvaltı",
    ...SPOOF,
  },
};

const handlers = {};
for (const name of Object.keys(ENDPOINTS)) handlers[name] = (await import(`../api/${name}.js`)).default;

const now = Math.floor(Date.now() / 1000);
const BAD_TOKENS = {
  "token yok": null,
  "Bearer olmayan başlık": "__raw__",
  "bozuk token": "abc.def.ghi",
  "süresi geçmiş": signedToken({ iat: now - 7200, exp: now - 3600 }),
  "başka Firebase projesi (aud)": signedToken({ aud: "baska-proje" }),
  "başka yayıncı (iss)": signedToken({ iss: "https://securetoken.google.com/baska-proje" }),
  "tanınmayan anahtarla imzalı": signedToken({}, { foreign: true }),
  "bilinmeyen kid": signedToken({}, { kid: "baska-kid" }),
  "imzasız (alg none)": signedToken({}, { alg: "none" }),
  "uid'siz (sub yok)": signedToken({ sub: undefined }),
};

function callWith(name, method, token) {
  const opts = { method, query: sampleRequest.query, body: method === "GET" ? undefined : sampleRequest.body, uid: "ATTACKER" };
  if (token === "__raw__") opts.authorization = idToken("ATTACKER"); // geçerli token ama "Bearer " öneki yok
  else opts.token = token;
  return invoke(handlers[name], opts);
}

test("sözleşme tablosu api/ klasöründeki her ucu kapsıyor", () => {
  const files = fs
    .readdirSync(new URL("../api/", import.meta.url))
    .filter((f) => f.endsWith(".js"))
    .map((f) => f.replace(/\.js$/, ""))
    .sort();
  assert.deepEqual(files, Object.keys(ENDPOINTS).sort(), "yeni uç eklendiyse yetki tablosuna da yazılmalı");
});

for (const [label, token] of Object.entries(BAD_TOKENS)) {
  test(`401: ${label} — hiçbir uçta Redis'e ve dış servise gidilmez`, async () => {
    for (const [name, methods] of Object.entries(ENDPOINTS)) {
      for (const method of methods) {
        resetDb();
        setRoutes([]);
        const r = await callWith(name, method, token);
        assert.equal(r.status, 401, `${method} /api/${name} → ${r.status} ${JSON.stringify(r.body)}`);
        assert.deepEqual(redisLog, [], `${method} /api/${name} kimliksiz istekte Redis'e gitti: ${JSON.stringify(redisLog)}`);
        assert.deepEqual(
          calls.map((c) => c.url),
          [],
          `${method} /api/${name} kimliksiz istekte dış servise gitti`
        );
        assert.equal(JSON.stringify(r.body).includes("VICTIM"), false);
      }
    }
  });
}

test("401: silinmiş hesabın geçerli token'ı her yerde reddedilir, yalnızca DELETE /api/account tekrar çağrılabilir", async () => {
  for (const [name, methods] of Object.entries(ENDPOINTS)) {
    for (const method of methods) {
      resetDb();
      setRoutes([]);
      db.set("deleted-account:GONE", String(Date.now()));
      const before = new Map(db);
      const r = await invoke(handlers[name], { method, uid: "GONE", query: sampleRequest.query, body: method === "GET" ? undefined : sampleRequest.body });
      if (name === "account") {
        assert.notEqual(r.status, 401, "hesap silme silinmiş hesapta da çağrılabilmeli (idempotent)");
        continue;
      }
      assert.equal(r.status, 401, `${method} /api/${name} → ${r.status}`);
      assert.deepEqual(new Map(db), before, `${method} /api/${name} silinmiş hesap için veri yazdı`);
      assert.deepEqual(calls.map((c) => c.url), [], `${method} /api/${name} silinmiş hesap için dış servise gitti`);
    }
  }
});

test("kimlik yalnızca token'dan: gövde/sorgudaki uid başka kullanıcının verisine erişim sağlamaz", async () => {
  resetDb();
  setRoutes([]);
  db.set("user:VICTIM:recipes", JSON.stringify([{ id: "secret", title: "Kurbanın tarifi" }]));
  db.set("user:VICTIM:profile", JSON.stringify({ isPlus: false, families: [] }));
  const read = await invoke(handlers.data, { method: "GET", uid: "ATTACKER", query: sampleRequest.query });
  assert.equal(read.status, 200);
  assert.equal(JSON.stringify(read.body).includes("secret"), false);

  const write = await invoke(handlers.data, { method: "POST", uid: "ATTACKER", body: { ...sampleRequest.body, value: JSON.stringify([{ id: "x" }]), baseVersion: 0 } });
  assert.equal(write.status, 200, JSON.stringify(write.body));
  assert.equal(JSON.parse(db.get("user:VICTIM:recipes"))[0].id, "secret", "kurbanın listesi değişmemeli");
  assert.ok(db.has("user:ATTACKER:recipes"));

  const plus = await invoke(handlers.profile, { method: "POST", uid: "ATTACKER", body: { isPlus: true, uid: "VICTIM" } });
  assert.equal(plus.status, 200);
  assert.equal(JSON.parse(db.get("user:VICTIM:profile")).isPlus, false, "Plus test anahtarı yalnızca kendi profilini değiştirir");
  assert.equal(JSON.parse(db.get("user:ATTACKER:profile")).isPlus, true);
});

test("üye olmayan, aile kimliğini bilse de aile verisini okuyamaz/yazamaz, bildirim gönderemez", async () => {
  resetDb();
  setRoutes([]);
  db.set("family:F1:meta", JSON.stringify({ id: "F1", name: "Aile", ownerUid: "OWNER" }));
  db.set("family:F1:members", JSON.stringify({ OWNER: { name: "Sahip", joinedAt: 1 } }));
  db.set("family:F1:recipes", JSON.stringify([{ id: "fam-secret", title: "Aile tarifi" }]));
  db.set("user:OWNER:profile", JSON.stringify({ isPlus: true, families: ["F1"] }));
  db.set("user:OUT:profile", JSON.stringify({ isPlus: true, families: [] }));
  const familyQuery = { bucket: "recipes", scope: "family", familyId: "F1" };

  const read = await invoke(handlers.data, { method: "GET", uid: "OUT", query: familyQuery });
  assert.ok(read.status >= 400 && read.status < 500, `okuma ${read.status}`);
  assert.equal(JSON.stringify(read.body).includes("fam-secret"), false);

  const summary = await invoke(handlers.data, { method: "GET", uid: "OUT", query: { ...familyQuery, summary: "1" } });
  assert.ok(summary.status >= 400 && summary.status < 500, `özet ${summary.status}`);
  assert.equal(JSON.stringify(summary.body).includes("Aile tarifi"), false);

  const before = db.get("family:F1:recipes");
  const write = await invoke(handlers.data, { method: "POST", uid: "OUT", body: { ...familyQuery, value: "[]", baseVersion: 1 } });
  assert.ok(write.status >= 400 && write.status < 500, `yazma ${write.status}`);
  assert.equal(db.get("family:F1:recipes"), before, "aile listesi değişmemeli");

  const notify = await invoke(handlers.notify, { method: "POST", uid: "OUT", body: { familyId: "F1", recipeTitle: "x" } });
  assert.ok(notify.status >= 400 && notify.status < 500, `bildirim ${notify.status}`);
  assert.deepEqual(calls.map((c) => c.url), [], "FCM'e gidilmemeli");
});

test("yardımcı: geçerli test token'ı gerçekten kabul ediliyor (sözleşme testleri boşuna geçmiyor)", async () => {
  resetDb();
  setRoutes([]);
  const r = await invoke(handlers.profile, { method: "GET", token: idToken("OK") });
  assert.equal(r.status, 200);
});
