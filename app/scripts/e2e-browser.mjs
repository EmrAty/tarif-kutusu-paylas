// Gerçek tarayıcıda uçtan uca deneme (elle çalıştırılır; CI'da değil — internet,
// gerçek Firebase anonim oturumu ve yerel Chrome gerekir):
//   npm run build && node scripts/e2e-browser.mjs [--chrome <yol>] [--out <klasör>]
// Yerel yığın (scripts/local-stack.mjs: gerçek api/ işleyicileri + bellek Redis)
// başlatılır; iki ayrı Chrome profili iki ayrı misafir hesap olur.
// Senaryo: A tarif ekler → QR paylaşımı oluşturur → sunucu kapatılır (bağlantı
// yok) → sayfa yeniden açılır: uygulama Service Worker'dan açılır, kayıtlı kopya
// salt okunur görünür, tarif detayı ve pişirme modu açılır → sunucu döner.
// B paylaşım bağlantısıyla tarifi kendi listesine ekler, aynı kod tekrar
// okutulunca kopya oluşmaz; çıkışta cihazdaki kopya silinir.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startLocalStack } from "./local-stack.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const CHROME = arg("--chrome", "C:/Program Files/Google/Chrome/Application/chrome.exe");
const OUT = arg("--out", fs.mkdtempSync(path.join(os.tmpdir(), "tk-e2e-")));
const PORT = Number(arg("--port", "4180"));
const ORIGIN = `http://localhost:${PORT}`;
const dbFile = path.join(OUT, "db.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

async function launchChrome(profile, debugPort) {
  const dir = path.join(OUT, profile);
  fs.mkdirSync(dir, { recursive: true });
  const proc = spawn(CHROME, [
    "--headless=new",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${dir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--lang=tr-TR",
    "--window-size=412,900",
    "about:blank",
  ], { stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return { proc, page: await connect(page.webSocketDebuggerUrl) };
    } catch {
      // henüz hazır değil
    }
    await sleep(200);
  }
  throw new Error("chrome başlamadı");
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  await send("Page.enable");
  await send("Runtime.enable");
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  return {
    send,
    evaluate,
    close: () => ws.close(),
    async goto(url) {
      await send("Page.navigate", { url }).catch(() => {});
      await sleep(1500);
    },
    async reload() {
      await send("Page.reload", { ignoreCache: false }).catch(() => {});
      await sleep(2000);
    },
    async waitFor(expression, { timeout = 20000, label = expression } = {}) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        try {
          const v = await evaluate(expression);
          if (v) return v;
        } catch {
          // sayfa geçişi
        }
        await sleep(300);
      }
      throw new Error(`zaman aşımı: ${label}`);
    },
    async text() {
      return evaluate("document.body ? document.body.innerText : ''");
    },
    async clickText(text, { exact = false } = {}) {
      const ok = await evaluate(`(() => {
        const want = ${JSON.stringify(text)};
        const els = [...document.querySelectorAll("button, a, [role=button], li, div, span, h3")].filter((e) => e.offsetParent !== null);
        const hit = els.filter((e) => ${exact ? "e.innerText.trim() === want" : "e.innerText.trim().includes(want)"})
          .sort((a, b) => a.innerText.length - b.innerText.length)[0];
        if (!hit) return false;
        (hit.closest("button") || hit).click();
        return true;
      })()`);
      if (!ok) throw new Error(`bulunamadı: ${text}`);
      await sleep(700);
    },
    async screenshot(name) {
      const r = await send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.data, "base64"));
    },
  };
}

// Firebase oturumunun ID token'ı (sayfanın kendi IndexedDB'sinden; çıktıya yazılmaz).
const TOKEN_JS = `new Promise((resolve) => {
  const req = indexedDB.open("firebaseLocalStorageDb");
  req.onsuccess = () => {
    const tx = req.result.transaction("firebaseLocalStorage", "readonly");
    const all = tx.objectStore("firebaseLocalStorage").getAll();
    all.onsuccess = () => {
      const u = (all.result || []).map((r) => r.value).find((v) => v && v.stsTokenManager);
      resolve(u ? { token: u.stsTokenManager.accessToken, uid: u.uid } : null);
    };
  };
  req.onerror = () => resolve(null);
})`;
const api = (page, method, url, body) =>
  page.evaluate(`(async () => {
    const t = await ${TOKEN_JS};
    const res = await fetch(${JSON.stringify(url)}, { method: ${JSON.stringify(method)}, headers: { Authorization: "Bearer " + t.token, "Content-Type": "application/json" }, body: ${body ? JSON.stringify(JSON.stringify(body)) : "undefined"} });
    return { status: res.status, body: await res.json().catch(() => null) };
  })()`);
const offlineKeys = (page) =>
  page.evaluate(`new Promise((resolve) => {
    const req = indexedDB.open("tarif-kutusu-offline");
    req.onsuccess = () => {
      try {
        const tx = req.result.transaction("kv", "readonly");
        const k = tx.objectStore("kv").getAllKeys();
        k.onsuccess = () => resolve(k.result.map(String));
      } catch (e) { resolve([]); }
    };
    req.onerror = () => resolve([]);
  })`);

const RECIPE = {
  id: "1790000000000-e2e001",
  createdAt: 1790000000000,
  title: "Fırın Makarna",
  category: "Öğle Yemeği ve Akşam Yemeği",
  isFavorite: false,
  addedBy: "Ayşe",
  servings: 4,
  servings_basis: "kaynak",
  ingredients: [
    { group: "Makarna", name: "kalem makarna", amount: "500 g" },
    { group: "Sos", name: "süt", amount: "2 su bardağı", estimated: true },
  ],
  instructions: ["Makarnayı haşla.", "Sosu hazırla.", "Fırında 20 dakika pişir."],
  tips: ["Üzerine kaşar rendele."],
  content_lang: "tr",
};

async function guestLogin(page) {
  await page.goto(ORIGIN + "/");
  // "Adın" penceresi (aile adı) senaryoyu kapatmasın.
  await page.evaluate(`localStorage.setItem("tarif-kutusu:person-name", "Deneme")`);
  await page.goto(ORIGIN + "/");
  await page.waitFor(`document.body.innerText.includes("Misafir Olarak Gir") || !!document.querySelector("main")`, { label: "giriş ekranı" });
  if ((await page.text()).includes("Misafir Olarak Gir")) await page.clickText("Misafir Olarak Gir");
  await page.waitFor(TOKEN_JS + ".then((t) => !!t)", { label: "anonim oturum" });
}

let stack = await startLocalStack({ port: PORT, dbFile });
console.log("stack", stack.url, "out", OUT);
const A = await launchChrome("profileA", 9301);
const pa = A.page;
let B;
try {
  // ---- Kullanıcı A ----
  await guestLogin(pa);
  const seed = await api(pa, "POST", "/api/data", { bucket: "recipes", scope: "personal", value: JSON.stringify([RECIPE]), baseVersion: 0 });
  check("A: tarif sunucuya yazıldı", seed.status === 200, `status ${seed.status}`);
  await pa.reload();
  await pa.waitFor(`document.body.innerText.includes("Fırın Makarna")`, { label: "liste" });
  await pa.waitFor(`navigator.serviceWorker.controller ? true : (location.reload(), false)`, { timeout: 30000, label: "SW denetimi" });
  await pa.waitFor(`document.body.innerText.includes("Fırın Makarna")`, { label: "liste (SW)" });
  const keys = await offlineKeys(pa);
  check("A: çevrimdışı kopya IndexedDB'de (hesap anahtarlı)", keys.some((k) => /^u:.+:recipes:personal$/.test(k)), keys.join(","));

  // QR
  await pa.clickText("Fırın Makarna");
  await pa.waitFor(`document.body.innerText.includes("QR ile paylaş")`, { label: "detay" });
  await pa.clickText("QR ile paylaş", { exact: true });
  await pa.waitFor(`!!document.querySelector('[role=dialog] svg[role=img]')`, { label: "QR görseli" });
  await pa.screenshot("01-share-qr");
  check("A: QR penceresi ve kod görseli", true);
  const share = await api(pa, "POST", "/api/data?resource=recipe-shares", { action: "create", scope: "personal", recipeId: RECIPE.id });
  check("A: aynı tarif için aynı paylaşım kodu", share.status === 200 && share.body.reused === true, JSON.stringify({ s: share.status, reused: share.body?.reused }));
  await pa.evaluate(`document.querySelector('[role=dialog] button[aria-label]').click()`);

  // ---- Bağlantı kopuyor ----
  await stack.close();
  await pa.goto(ORIGIN + "/");
  await pa.waitFor(`document.body.innerText.includes("Fırın Makarna")`, { timeout: 25000, label: "çevrimdışı liste" });
  const offText = await pa.text();
  check("çevrimdışı: uygulama SW'den açıldı ve kayıtlı tarif listede", offText.includes("Fırın Makarna"));
  check("çevrimdışı: kayıtlı kopya bandı", /kayıtlı kopya/i.test(offText), offText.slice(0, 160).replace(/\n/g, " | "));
  await pa.screenshot("02-offline-list");
  await pa.clickText("Fırın Makarna");
  await pa.waitFor(`document.body.innerText.includes("kalem makarna")`, { label: "çevrimdışı detay" });
  const detail = await pa.text();
  check("çevrimdışı: detay, malzeme ve püf noktası", detail.includes("kalem makarna") && detail.includes("kaşar"));
  await pa.screenshot("03-offline-detail");
  await pa.clickText("Pişirmeye Başla");
  await sleep(800);
  const cook = await pa.text();
  check("çevrimdışı: pişirme modu ve porsiyon ayarı açıldı", cook.includes("porsiyon hazırlayacaksın"));
  await pa.screenshot("04-offline-cook");

  // Çevrimdışı yazım denemesi sunucuyu etkilemez (sunucu kapalı zaten); dönüşte veri aynı.
  stack = await startLocalStack({ port: PORT, dbFile });
  await pa.goto(ORIGIN + "/");
  await pa.waitFor(`document.body.innerText.includes("Fırın Makarna") && !document.body.innerText.includes("kayıtlı kopya")`, { timeout: 25000, label: "çevrimiçi dönüş" });
  check("çevrimiçi dönüş: bant kalktı, liste sunucudan", true);

  // ---- Kullanıcı B ----
  B = await launchChrome("profileB", 9302);
  const pb = B.page;
  await guestLogin(pb);
  await pb.goto(`${ORIGIN}/?recipeShare=${share.body.token}`);
  await pb.waitFor(`document.body.innerText.includes("Paylaşılan tarif") && document.body.innerText.includes("kalem makarna")`, { timeout: 25000, label: "içe aktarma ekranı" });
  const imp = await pb.text();
  check("B: paylaşılan tarif önizlemesi (malzeme/adım/püf)", imp.includes("2 malzeme") && imp.includes("3 adım") && imp.includes("1 püf"), imp.slice(0, 200).replace(/\n/g, " | "));
  check("B: URL'den paylaşım kodu temizlendi", !(await pb.evaluate("location.search")).includes("recipeShare"));
  await pb.screenshot("05-import");
  await pb.clickText("Kaydet", { exact: true });
  await pb.waitFor(`document.body.innerText.includes("Pişirmeye Başla")`, { timeout: 20000, label: "kayıt sonrası detay" });
  const bList = await api(pb, "GET", "/api/data?bucket=recipes&scope=personal");
  const saved = JSON.parse(bList.body.value || "[]");
  check("B: tarif kendi listesinde, bağımsız kimlikle", saved.length === 1 && saved[0].id !== RECIPE.id && saved[0].shared_from && saved[0].addedBy !== "Ayşe", JSON.stringify(saved.map((r) => ({ id: r.id, by: r.addedBy, cat: r.category }))));
  check("B: bölümler/tahmini miktar/porsiyon korundu", saved[0]?.ingredients?.[1]?.estimated === true && saved[0]?.ingredients?.[0]?.group === "Makarna" && saved[0]?.servings === 4);

  await pb.goto(`${ORIGIN}/?recipeShare=${share.body.token}`);
  await pb.waitFor(`document.body.innerText.includes("zaten eklemişsin")`, { timeout: 20000, label: "tekrar okutma uyarısı" });
  check("B: aynı kod tekrar → 'zaten eklemişsin', kaydet kapalı", await pb.evaluate(`[...document.querySelectorAll("button")].find((b) => b.innerText.trim() === "Kaydet")?.disabled === true`));
  await pb.screenshot("06-already");

  // A paylaşımı durdurur → B açamaz
  const stop = await api(pa, "POST", "/api/data?resource=recipe-shares", { action: "revoke", scope: "personal", recipeId: RECIPE.id });
  check("A: paylaşım durduruldu", stop.body?.revoked === true);
  await pb.goto(`${ORIGIN}/?recipeShare=${share.body.token}`);
  await pb.waitFor(`document.body.innerText.includes("artık geçerli değil")`, { timeout: 20000, label: "geçersiz paylaşım" });
  check("B: durdurulan kod açılmıyor", true);

  // Hesap değişimi: B'nin oturumu kalkar, aynı cihazda yeni bir misafir açılır →
  // önceki hesabın çevrimdışı kopyası silinir. (Misafirde "Çıkış Yap" yok; kalıcı
  // hesapta çıkış aynı temizliği çağırır, birim testi: test/offlineCache.test.mjs.)
  const before = await offlineKeys(pb);
  const oldUid = (await pb.evaluate(TOKEN_JS)).uid;
  await pb.evaluate(`new Promise((r) => { const q = indexedDB.deleteDatabase("firebaseLocalStorageDb"); q.onsuccess = q.onerror = q.onblocked = () => r(true); })`);
  await pb.goto("about:blank");
  await guestLogin(pb);
  await sleep(2500);
  const newUid = (await pb.evaluate(TOKEN_JS)).uid;
  const after = await offlineKeys(pb);
  check("hesap değişimi: önceki hesabın çevrimdışı kopyası silindi", newUid !== oldUid && before.some((k) => k.includes(oldUid)) && !after.some((k) => k.includes(oldUid)), `önce ${before.length}, sonra ${after.join(",") || "-"}`);
  check("hesap değişimi: yeni hesap öncekinin tarifini görmüyor", !(await pb.text()).includes("Fırın Makarna"));
} catch (e) {
  check("senaryo tamamlandı", false, e.message);
  await pa.screenshot("zz-error-A").catch(() => {});
  if (B) await B.page.screenshot("zz-error-B").catch(() => {});
} finally {
  A.page.close();
  A.proc.kill();
  if (B) {
    B.page.close();
    B.proc.kill();
  }
  await stack.close().catch(() => {});
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} geçti. Ekran görüntüleri: ${OUT}`);
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
  process.exit(failed.length ? 1 : 0);
}
