import { extractionModel } from "./shared/extractModel.js";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { writeFileSync, readFileSync, readdirSync } from "fs";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Her `vite build` çalıştığında değişen bir sürüm damgası: uygulama içindeki
// "güncelleme mevcut" bandı, çalışan bundle'daki bu değeri /version.json'daki
// güncel değerle karşılaştırarak yeni bir deploy olduğunu anlıyor.
const buildVersion = String(Date.now());

// Grup 5: hangi commit'in yayında olduğu /version.json'dan okunabilsin (yayın
// sonrası kontrol `npm run verify:deploy` bunu onaylanan commit ile karşılaştırır).
// Vercel derlemede VERCEL_GIT_COMMIT_SHA / _REF / VERCEL_ENV verir; yerelde git'e
// bakılır, o da yoksa alan boş kalır. İstemci yalnızca `version` alanını okur.
function gitInfo() {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA || safeGit("git rev-parse HEAD");
  const ref = process.env.VERCEL_GIT_COMMIT_REF || safeGit("git rev-parse --abbrev-ref HEAD");
  // Sunucunun kullanacağı tarif çıkarma modeli (shared/extractModel.js); verify:deploy bunu kontrol eder.
  return { commit: sha || null, ref: ref || null, env: process.env.VERCEL_ENV || "local", extractModel: extractionModel() };
}
function safeGit(command) {
  try {
    return execSync(command, { cwd: __dirname, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}

// Çevrimdışı açılış için Service Worker (bkz. src/sw/swLogic.js): derlenen her
// /assets dosyası önceden önbelleğe alınır; sürüm damgası değişince eski önbellek
// temizlenir. Acil geri dönüş: TK_DISABLE_SW=1 ile derlenirse sw.js kendini ve
// önbelleklerini kaldıran bir betik olur (kayıtlı cihazlar bir sonraki açılışta temizlenir).
function buildServiceWorker() {
  const dist = path.resolve(__dirname, "dist");
  if (process.env.TK_DISABLE_SW === "1") {
    return `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n.startsWith("tk-")).map((n) => caches.delete(n))))
      .then(() => self.registration.unregister())
  );
});
`;
  }
  const assets = readdirSync(path.join(dist, "assets"))
    .filter((f) => !f.endsWith(".map"))
    .map((f) => `/assets/${f}`)
    .sort();
  const logic = readFileSync(path.resolve(__dirname, "src/sw/swLogic.js"), "utf8").replace(/^export /gm, "");
  const main = readFileSync(path.resolve(__dirname, "src/sw/swMain.js"), "utf8");
  return `// Üretildi: vite.config.js (kaynak src/sw/). Elle düzenleme.
const SW_BUILD = ${JSON.stringify(buildVersion)};
const SW_ASSETS = ${JSON.stringify(assets)};
${logic}
${main}`;
}

export default defineConfig({
  plugins: [
    react(),
    {
      name: "write-app-version",
      apply: "build",
      closeBundle() {
        writeFileSync(
          path.resolve(__dirname, "dist", "version.json"),
          JSON.stringify({ version: buildVersion, ...gitInfo() })
        );
        writeFileSync(path.resolve(__dirname, "dist", "sw.js"), buildServiceWorker());
      },
    },
  ],
  define: {
    __APP_VERSION__: JSON.stringify(buildVersion),
  },
});
