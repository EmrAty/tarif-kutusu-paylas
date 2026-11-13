import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { writeFileSync } from "fs";
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
  return { commit: sha || null, ref: ref || null, env: process.env.VERCEL_ENV || "local" };
}
function safeGit(command) {
  try {
    return execSync(command, { cwd: __dirname, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
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
      },
    },
  ],
  define: {
    __APP_VERSION__: JSON.stringify(buildVersion),
  },
});
