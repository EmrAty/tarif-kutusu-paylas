// Deneyi korumalı Preview'daki /api/experiment ucu üzerinden çalıştırır. Anthropic anahtarı Vercel'de kalır.
//
//   node runRemote.mjs --base <preview-url> --status
//   node runRemote.mjs --base <preview-url> --configs sonnet,haiku --ids c01,c09   (ya da --set pilot / --all)
//
// - Vercel koruma atlama anahtarı yalnızca git dışı local.properties'ten (PREVIEW_BYPASS) okunur; basılmaz.
// - Firebase: geçici ANONİM hesap açılır, iş bitince accounts:delete ile silinir (uid yalnızca silinemezse yazılır).
// - Bütçe tavanı (3 $) SUNUCUDA uygulanır; 402 gelirse durur. Çağrılar sırayla.
// - Çıktılar: results-models.json ve ledger.json (sunucudaki defterin kopyası) → analyze.mjs.
import fs from "node:fs";

const args = process.argv.slice(2);
const arg = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const BASE = (arg("--base") || "").replace(/\/$/, "");
// Yalnızca deney dağıtımı: dal adresi (*.vercel.app; Türkiye'den TLS sıfırlanıyor) ya da ona bağlanan exp.tarifkutusu.app.
// Production (tarifkutusu.app, www.) ve Grup 5 Preview'ı (preview.tarifkutusu.app) reddedilir.
if (!/^https:\/\/([\w.-]+\.vercel\.app|exp\.tarifkutusu\.app)$/.test(BASE) || /^https:\/\/tarif-kutusu-paylas\.vercel\.app$/.test(BASE)) {
  throw new Error("--base deney dağıtımı olmalı (exp.tarifkutusu.app ya da dalın *.vercel.app adresi); production/preview.tarifkutusu.app DEĞİL.");
}
const PROPS = arg("--props") || "C:/Users/emrea/tk-clone-group3-apk/app/android/local.properties";
const BYPASS = (fs.readFileSync(PROPS, "utf8").match(/^PREVIEW_BYPASS=(.*)$/m) || [])[1]?.trim();
if (!BYPASS) throw new Error("PREVIEW_BYPASS bulunamadı.");
const FIREBASE_WEB_KEY = "AIzaSyB9EptcLQLySYfZ87Ed59XFPYlK7ZpfqR0"; // istemcide zaten herkese açık web anahtarı
const PILOT = ["c01", "c09", "c19", "c23", "t13"];
const here = (f) => new URL(`./${f}`, import.meta.url);
const load = (f, d) => (fs.existsSync(here(f)) ? JSON.parse(fs.readFileSync(here(f), "utf8")) : d);

async function signIn() {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_WEB_KEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ returnSecureToken: true }) });
  const j = await r.json();
  if (!j.idToken) throw new Error("Geçici anonim hesap açılamadı.");
  return { uid: j.localId, idToken: j.idToken, refreshToken: j.refreshToken, at: Date.now() };
}
async function fresh(s) {
  if (Date.now() - s.at < 45 * 60 * 1000) return s;
  const r = await fetch(`https://securetoken.googleapis.com/v1/token?key=${FIREBASE_WEB_KEY}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(s.refreshToken)}` });
  const j = await r.json();
  return { ...s, idToken: j.id_token, refreshToken: j.refresh_token, at: Date.now() };
}
const headers = (s) => ({ Authorization: `Bearer ${s.idToken}`, "x-vercel-protection-bypass": BYPASS, "Content-Type": "application/json" });

let session = await signIn();
const cleanup = async () => {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:delete?key=${FIREBASE_WEB_KEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: session.idToken }) }).catch(() => null);
  if (!r?.ok) console.log(`UYARI: geçici anonim hesap silinemedi, uid ${session.uid}`);
};

try {
  const st = await (await fetch(`${BASE}/api/experiment`, { headers: headers(session) })).json().catch(() => ({}));
  if (!st.enabled) throw new Error(`Deney ucu etkin değil: ${JSON.stringify(st).slice(0, 200)}`);
  const summary = { commit: st.commit, branch: st.branch, hasAnthropicKey: st.hasAnthropicKey, capUsd: st.capUsd, spentUsd: st.spentUsd, reservedUsd: st.reservedUsd, calls: st.calls.length };
  console.log("Durum:", JSON.stringify(summary));
  const results = load("results-models.json", {});
  const syncLedger = (s) => fs.writeFileSync(here("ledger.json"), JSON.stringify({ source: BASE, calls: s.calls }, null, 1));
  syncLedger(st);
  if (!args.includes("--status")) {
    if (!st.hasAnthropicKey) throw new Error("Preview ortamında ANTHROPIC_API_KEY yok.");
    const configs = (arg("--configs") || st.configs.join(",")).split(",");
    const ids = args.includes("--all") ? st.corpusIds : (arg("--ids") || (arg("--set") === "pilot" ? PILOT.join(",") : "")).split(",").filter(Boolean);
    const order = arg("--order") === "id" ? ids.flatMap((id) => configs.map((c) => [id, c])) : configs.flatMap((c) => ids.map((id) => [id, c]));
    for (const [id, config] of order) {
      if (results[`${id}|${config}`]?.ok) continue;
      session = await fresh(session);
      const t = Date.now();
      const r = await fetch(`${BASE}/api/experiment`, { method: "POST", headers: headers(session), body: JSON.stringify({ id, config }), signal: AbortSignal.timeout(295_000) }).catch((e) => ({ status: 0, json: async () => ({ error: e.name }) }));
      const body = await r.json().catch(() => ({}));
      if (r.status === 402) {
        console.log(`TAVAN: sunucu çağrıyı başlatmadı (${id} ${config}); harcanan $${body.spentUsd}, ayrılmış $${body.reservedUsd}, bu çağrının en kötü durumu $${body.worstCaseUsd}.`);
        break;
      }
      if (r.status !== 200) {
        console.log(`${id} ${config} HTTP ${r.status} ${JSON.stringify(body).slice(0, 160)}`);
        continue;
      }
      results[`${id}|${config}`] = { id, config, model: body.model, ok: body.ok, ms: body.ms, roundTripMs: Date.now() - t, usage: body.usage, costUsd: body.costUsd, stopReason: body.stopReason, recipe: body.recipe, error: body.error };
      fs.writeFileSync(here("results-models.json"), JSON.stringify(results, null, 1));
      console.log(`${id} ${config.padEnd(14)} ${body.ok ? "ok  " : "HATA"} ${String(body.ms).padStart(6)}ms in=${body.usage?.input_tokens ?? "-"} out=${body.usage?.output_tokens ?? "-"} $${(body.costUsd || 0).toFixed(4)} | sunucu toplam $${body.spentUsd?.toFixed(4) ?? "?"}${body.cached ? " (önbellek)" : ""}${body.ok ? "" : ` | ${body.error}`}`);
    }
    syncLedger(await (await fetch(`${BASE}/api/experiment`, { headers: headers(await fresh(session)) })).json());
  }
} finally {
  await cleanup();
}
