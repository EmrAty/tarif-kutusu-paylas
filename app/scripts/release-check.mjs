#!/usr/bin/env node
// Grup 5: production'a çıkmadan önceki kapı (SALT OKUNUR — hiçbir şey push etmez).
//
//   npm run release:check -- <sha> --bypass-file <PREVIEW_BYPASS içeren dosya>
//
// Bir commit'in production'a çıkabilmesi için hepsi doğru olmalı:
//  1. commit origin'de var (push edilmiş)
//  2. main'e HIZLI İLERİ (fast-forward) gidebilir: origin/main bu commit'in atası.
//     Böylece production'a test edilen commit'in KENDİSİ çıkar, yeni bir merge
//     commit'i (test edilmemiş bir ağaç) oluşmaz.
//  3. GitHub Actions "CI / check" bu commit için başarılı
//  4. preview.tarifkutusu.app şu an bu commit'i yayınlıyor (/version.json)
// Hepsi geçerse yayın komutunu ve yayın sonrası kontrol komutunu yazdırır.
// Telefon testi ve bağımsız denetim gibi elle yapılan adımları DOĞRULAMAZ; onları
// sorar (bkz. RELEASE.md).
import { execFileSync } from "node:child_process";

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const flag = (name) => argv.includes(`--${name}`);
const git = (...a) => execFileSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const PREVIEW_URL = opt("preview-url") || "https://preview.tarifkutusu.app";
const VALUE_OPTIONS = new Set(["--bypass-file", "--preview-url"]);
const ref = argv.find((a, i) => !a.startsWith("--") && !VALUE_OPTIONS.has(argv[i - 1])) || "HEAD";

const results = [];
const ok = (name, detail) => results.push({ ok: true, name, detail });
const bad = (name, detail) => results.push({ ok: false, name, detail });

git("fetch", "--quiet", "origin");
let sha;
try {
  sha = git("rev-parse", "--verify", `${ref}^{commit}`);
} catch {
  console.error(`Commit bulunamadı: ${ref}`);
  process.exit(2);
}
const short = sha.slice(0, 7);

const remoteBranches = git("branch", "-r", "--contains", sha);
if (remoteBranches) ok("origin'de var", remoteBranches.split("\n").map((s) => s.trim()).join(", "));
else bad("origin'de var", "commit push edilmemiş");

try {
  git("merge-base", "--is-ancestor", "origin/main", sha);
  const ahead = git("rev-list", "--count", `origin/main..${sha}`);
  ok("main'e fast-forward", `${ahead} commit ileri`);
} catch {
  bad("main'e fast-forward", "origin/main bu commit'in atası değil — önce dalı main üzerine güncelle, yeniden test et");
}

const remote = git("remote", "get-url", "origin");
const repo = (remote.match(/github\.com[:/](.+?)(?:\.git)?$/) || [])[1];
try {
  const res = await fetch(`https://api.github.com/repos/${repo}/commits/${sha}/check-runs?per_page=100`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "tarif-kutusu-release-check" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  const runs = (await res.json()).check_runs || [];
  const ci = runs.filter((r) => r.name === "check");
  if (!ci.length) bad("CI / check", "bu commit için CI çalışmamış");
  else if (ci.some((r) => r.status !== "completed")) bad("CI / check", "hâlâ çalışıyor");
  else if (ci.every((r) => r.conclusion === "success")) ok("CI / check", "başarılı");
  else bad("CI / check", `sonuç: ${ci.map((r) => r.conclusion).join(", ")}`);
} catch (e) {
  bad("CI / check", e.message);
}

if (flag("skip-preview")) {
  bad("Preview bu commit'i yayınlıyor", "--skip-preview ile atlandı (yalnızca acil düzeltmede)");
} else {
  try {
    const out = execFileSync(
      process.execPath,
      ["scripts/verify-deploy.mjs", "--url", PREVIEW_URL, "--commit", sha, ...(opt("bypass-file") ? ["--bypass-file", opt("bypass-file")] : [])],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    ok("Preview bu commit'i yayınlıyor", "verify-deploy geçti");
    if (flag("verbose")) console.log(out);
  } catch (e) {
    const lines = String(e.stdout || e.message).split("\n").filter((l) => l.startsWith("✖"));
    bad("Preview bu commit'i yayınlıyor", lines.join(" | ") || "verify-deploy başarısız");
  }
}

console.log(`\nYayın adayı: ${short} (${git("log", "-1", "--format=%s", sha)})`);
for (const r of results) console.log(`${r.ok ? "✔" : "✖"} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
console.log(`
Elle onay gereken adımlar (bu betik doğrulamaz):
  [ ] Tarif TEST APK'sıyla telefon testi (RELEASE.md listesi) bu commit'te yapıldı
  [ ] Bağımsız denetim (varsa) bu commit için "production'a uygun" dedi
  [ ] Bu commit'te Redis veri biçimi değişikliği varsa geri dönüş notu yazıldı`);

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.log(`\n${failed.length} otomatik kontrol başarısız — production'a ÇIKMA.`);
  process.exit(1);
}
console.log(`
Otomatik kontroller geçti. Elle adımlar da tamamsa yayın (yalnızca fast-forward):
  git push origin ${sha}:refs/heads/main
Vercel production derlemesi bittikten sonra:
  npm run verify:deploy -- --url https://tarifkutusu.app --commit ${short}`);
