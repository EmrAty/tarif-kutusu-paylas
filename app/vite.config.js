import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Her `vite build` çalıştığında değişen bir sürüm damgası: uygulama içindeki
// "güncelleme mevcut" bandı, çalışan bundle'daki bu değeri /version.json'daki
// güncel değerle karşılaştırarak yeni bir deploy olduğunu anlıyor.
const buildVersion = String(Date.now());

export default defineConfig({
  plugins: [
    react(),
    {
      name: "write-app-version",
      apply: "build",
      closeBundle() {
        writeFileSync(
          path.resolve(__dirname, "dist", "version.json"),
          JSON.stringify({ version: buildVersion })
        );
      },
    },
  ],
  define: {
    __APP_VERSION__: JSON.stringify(buildVersion),
  },
});
