// Gerçek açıklamaları uygulamanın kendi (ücretsiz) okuma koduyla çeker. AI çağrısı yok.
import fs from "node:fs";
import { tiktokCaption } from "../../app/api/_lib/tiktok.js";
const urls = fs.readFileSync(new URL("./urls.txt", import.meta.url), "utf8").split(/\r?\n/).filter(Boolean);
const out = [];
for (const [i, url] of urls.entries()) {
  const t = Date.now();
  let r = null;
  try { r = await tiktokCaption(url); } catch {}
  out.push({ id: `c${String(i + 1).padStart(2, "0")}`, url, fetchMs: Date.now() - t, caption: r?.caption ?? null });
  console.log(out.at(-1).id, r ? r.caption.length : "NULL", Date.now() - t, "ms");
}
fs.writeFileSync(new URL("./corpus.json", import.meta.url), JSON.stringify(out, null, 1));
