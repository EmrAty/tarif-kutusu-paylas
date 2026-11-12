// Grup 3 production öncesi SALT OKUNUR denetim.
//
// Kullanım (kimlik bilgisi yalnızca ortam değişkeninden; çıktıya yazılmaz):
//   KV_REST_API_URL=... KV_REST_API_TOKEN=... node scripts/audit-group3-readonly.mjs
//
// Yalnızca SCAN / GET / MGET / HLEN çalıştırır; başka her komutu kod düzeyinde
// reddeder. Veri içeriği (tarif, isim, e-posta, token) YAZDIRMAZ; yalnızca
// sayılar, biçim sınıfları ve tutarsız kayıtların aile/uid kimlikleri.
//
// Raporlar:
//   1. Aile üyeliği tutarlılığı: profilde aile var ama üye listesinde yok
//      (Grup 3'ün sıkı kontrolüyle 403 alacak kullanıcılar → "tekrar katıl"),
//      ve tersi; silinmiş aileye işaret eden profiller.
//   2. Legacy global anahtarların biçimi (recipes / shopping-list / pantry-items):
//      api/legacy.js ile aynı sınıflandırma (missing/empty/ok/invalid).
//   3. Push kayıtları: eski şemadaki (platformsuz) token sayısı.
import { classifyLegacyValue } from "../api/legacy.js";

const READ_ONLY = new Set(["SCAN", "GET", "MGET", "HLEN"]);

export function makeReadOnlyClient(command) {
  return async (cmd) => {
    const op = String(cmd[0]).toUpperCase();
    if (!READ_ONLY.has(op)) throw new Error(`Salt okunur denetimde izin verilmeyen komut: ${op}`);
    return command(cmd);
  };
}

async function scanAll(run, pattern) {
  const keys = [];
  let cursor = "0";
  do {
    const [next, batch] = await run(["SCAN", cursor, "MATCH", pattern, "COUNT", "500"]);
    keys.push(...batch);
    cursor = String(next);
  } while (cursor !== "0");
  return keys;
}

const parse = (raw, fallback) => {
  try {
    return raw == null ? fallback : JSON.parse(raw);
  } catch (e) {
    return undefined;
  }
};

export async function auditGroup3(run) {
  const report = { families: { profilesChecked: 0, profileOnly: [], membersOnly: [], missingFamily: [], unreadable: [] }, legacy: {}, push: {} };

  // 1) Aile üyeliği
  const profileKeys = (await scanAll(run, "user:*:profile")).filter((k) => /^user:[^:]+:profile$/.test(k));
  const memberOf = new Map(); // familyId -> Set(uid) (profillerden)
  for (const key of profileKeys) {
    const uid = key.split(":")[1];
    const profile = parse(await run(["GET", key]), null);
    report.families.profilesChecked++;
    if (profile === undefined || (profile && !Array.isArray(profile.families ?? []))) {
      report.families.unreadable.push({ key });
      continue;
    }
    for (const id of profile?.families || []) {
      if (!memberOf.has(id)) memberOf.set(id, new Set());
      memberOf.get(id).add(uid);
    }
  }
  const familyIds = new Set([...memberOf.keys()]);
  for (const key of await scanAll(run, "family:*:members")) {
    if (/^family:[^:]+:members$/.test(key)) familyIds.add(key.split(":")[1]);
  }
  for (const id of familyIds) {
    const [metaRaw, membersRaw] = await run(["MGET", `family:${id}:meta`, `family:${id}:members`]);
    const members = parse(membersRaw, {});
    if (members === undefined) {
      report.families.unreadable.push({ key: `family:${id}:members` });
      continue;
    }
    const fromProfiles = memberOf.get(id) || new Set();
    if (metaRaw == null) {
      if (fromProfiles.size) report.families.missingFamily.push({ familyId: id, uids: [...fromProfiles] });
      continue;
    }
    for (const uid of fromProfiles) if (!members[uid]) report.families.profileOnly.push({ familyId: id, uid });
    for (const uid of Object.keys(members)) if (!fromProfiles.has(uid)) report.families.membersOnly.push({ familyId: id, uid });
  }

  // 2) Legacy global anahtarlar
  for (const bucket of ["recipes", "shopping-list", "pantry-items"]) {
    const { value, ...status } = classifyLegacyValue(bucket, await run(["GET", bucket]));
    void value;
    report.legacy[bucket] = status;
  }

  // 3) Push kayıtları
  const legacyTokenKeys = await scanAll(run, "user:*:fcmTokens");
  let legacyTokens = 0;
  for (const key of legacyTokenKeys) {
    const list = parse(await run(["GET", key]), []);
    if (Array.isArray(list)) legacyTokens += list.length;
  }
  const targetKeys = await scanAll(run, "user:*:pushTargets");
  let v2Targets = 0;
  for (const key of targetKeys) v2Targets += Number(await run(["HLEN", key])) || 0;
  report.push = { usersWithLegacyList: legacyTokenKeys.length, legacyTokens, usersWithV2: targetKeys.length, v2Targets };
  return report;
}

// Doğrudan çalıştırılınca Upstash REST'e bağlanır.
if (process.argv[1]?.replace(/\\/g, "/").endsWith("/scripts/audit-group3-readonly.mjs")) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    console.error("KV_REST_API_URL ve KV_REST_API_TOKEN ortam değişkenleri gerekli (değerleri yazdırılmaz).");
    process.exit(1);
  }
  const run = makeReadOnlyClient(async (cmd) => {
    const res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(cmd) });
    if (!res.ok) throw new Error(`Redis isteği başarısız (${res.status})`);
    const data = await res.json();
    if (data.error) throw new Error("Redis komut hatası");
    return data.result;
  });
  const report = await auditGroup3(run);
  console.log(JSON.stringify(report, null, 2));
}
