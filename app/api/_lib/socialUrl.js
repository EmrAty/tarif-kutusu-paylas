import dns from "node:dns";
import net from "node:net";

// Sunucunun dışarıya attığı her sosyal medya isteği buradan geçer (SSRF koruması).
//
// İki politika:
// - "social": kullanıcıdan gelen link ve onun redirect zinciri. Yalnızca gerçekten
//   desteklenen platformların alan adları (ve alt alan adları) kabul edilir.
// - "public": TikTok sayfasının JSON'undan gelen CDN adresleri (altyazı/video).
//   Bu host'lar sık değiştiği için allowlist yok; bunun yerine https + IP
//   literal'i yok + DNS çözümü özel/iç ağ adresine gitmiyor şartı aranır.
//
// Her iki politikada redirect'ler otomatik izlenmez: her Location yeniden
// doğrulanır, sonra elle devam edilir.

// Alan adı → platform. Alt alan adları (www., m., vm., vt., music.) dahildir;
// hepsi platformun kendi kontrolündeki alan adları.
const PLATFORM_DOMAINS = [
  ["tiktok.com", "tiktok"],
  ["instagram.com", "instagram"],
  ["youtube.com", "youtube"],
  ["youtu.be", "youtube"],
];

export const SUPPORTED_LINK_MESSAGE = "Desteklenmeyen link. Sadece TikTok, YouTube ve Instagram linkleri destekleniyor.";
const MAX_URL_LENGTH = 2000;

export class UnsafeUrlError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnsafeUrlError";
    this.unsafeUrl = true;
  }
}

function normalizeHostname(hostname) {
  return String(hostname || "").toLowerCase().replace(/\.$/, "");
}

function isIpLiteral(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "");
  return net.isIP(host) !== 0 || /^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host);
}

function platformOf(hostname) {
  for (const [domain, platform] of PLATFORM_DOMAINS) {
    if (hostname === domain || hostname.endsWith(`.${domain}`)) return platform;
  }
  return null;
}

function parse(raw) {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text || text.length > MAX_URL_LENGTH) return null;
  try {
    return new URL(text);
  } catch (e) {
    return null;
  }
}

// Kullanıcının verdiği link. http:// ile gelen desteklenen bir link https'e
// yükseltilir (sunucu hiçbir zaman http'ye istek atmaz). Geçersizse null.
export function parseSocialUrl(raw, { allowHttpUpgrade = true } = {}) {
  const url = parse(raw);
  if (!url) return null;
  if (url.protocol === "http:" && allowHttpUpgrade) url.protocol = "https:";
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.port && url.port !== "443") return null;
  url.port = "";
  const hostname = normalizeHostname(url.hostname);
  if (!hostname || isIpLiteral(hostname)) return null;
  const platform = platformOf(hostname);
  if (!platform) return null;
  url.hostname = hostname;
  return { url: url.href, platform, hostname };
}

export function isSupportedSocialUrl(raw) {
  return parseSocialUrl(raw) !== null;
}

export function isTikTokUrl(raw) {
  return parseSocialUrl(raw)?.platform === "tiktok";
}

// ---------- "public" politika: özel/iç ağ adres kontrolü ----------

function ipv4ToInt(ip) {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

const PRIVATE_V4 = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
].map(([base, bits]) => [ipv4ToInt(base), bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0]);

export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const value = ipv4ToInt(ip);
    return PRIVATE_V4.some(([base, mask]) => ((value & mask) >>> 0) === base);
  }
  if (net.isIPv6(ip)) {
    const words = parseIPv6(ip);
    // Ayrıştırılamayan adres güvenli tarafta: özel sayılır.
    return !words || isPrivateIPv6(words);
  }
  return true;
}

// IPv6 adresini yazım biçiminden bağımsız olarak 8 adet 16 bitlik sayıya çevirir:
// "::1", "0:0:0:0:0:0:0:1", "0000::0001", "::ffff:7f00:1", "::ffff:127.0.0.1" ve
// "fe80::1%eth0" (bölge kimliği atılır) aynı biçime iner. Geçersizse null.
export function parseIPv6(input) {
  let text = String(input).trim().toLowerCase();
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  // Sonda gömülü IPv4 (ör. ::ffff:10.0.0.1) iki 16 bitlik gruba çevrilir.
  const v4 = text.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) {
    if (!net.isIPv4(v4[2])) return null;
    const n = ipv4ToInt(v4[2]);
    text = `${v4[1]}${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const toWords = (part) => (part === "" ? [] : part.split(":"));
  const head = toWords(halves[0]);
  const tail = halves.length === 2 ? toWords(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  const words = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    words.push(parseInt(g, 16));
  }
  return words.length === 8 ? words : null;
}

const embeddedV4 = (hi, lo) => `${hi >>> 8}.${hi & 0xff}.${lo >>> 8}.${lo & 0xff}`;

function isPrivateIPv6(w) {
  const zeroPrefix = (n) => w.slice(0, n).every((x) => x === 0);
  // ::/128 (belirsiz) ve ::1/128 (loopback)
  if (zeroPrefix(7) && (w[7] === 0 || w[7] === 1)) return true;
  // ::ffff:0:0/96 — IPv4-mapped: içindeki IPv4 adresine göre karar verilir.
  if (zeroPrefix(5) && w[5] === 0xffff) return isPrivateAddress(embeddedV4(w[6], w[7]));
  // ::/96 — eski "IPv4-compatible" biçim (::127.0.0.1): yine gömülü IPv4.
  if (zeroPrefix(6)) return isPrivateAddress(embeddedV4(w[6], w[7]));
  // ::ffff:0:0:0/96 (SIIT) ve 100::/64 (discard): genel internette yok.
  if (zeroPrefix(4) && w[4] === 0xffff && w[5] === 0) return true;
  if (w[0] === 0x0100 && w[1] === 0 && w[2] === 0 && w[3] === 0) return true;
  // 64:ff9b::/96 ve 64:ff9b:1::/48 — NAT64 (iç ağa çevirebilir; ihtiyatla özel).
  if (w[0] === 0x0064 && w[1] === 0xff9b) return true;
  // 2001::/32 Teredo, 2001:db8::/32 dokümantasyon, 2001:10::/28 ORCHID: özel.
  if (w[0] === 0x2001 && (w[1] === 0 || w[1] === 0x0db8 || (w[1] & 0xfff0) === 0x0010)) return true;
  // 2002::/16 — 6to4: içindeki IPv4'e göre.
  if (w[0] === 0x2002) return isPrivateAddress(embeddedV4(w[1], w[2]));
  if ((w[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((w[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((w[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 eski site-local
  if ((w[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

let lookupAll = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true });
// Testler gerçek DNS'e çıkmasın diye.
export function __setDnsLookupForTests(fn) {
  lookupAll = fn;
}

async function assertPublicHost(hostname) {
  if (!hostname.includes(".") || /(^|\.)(localhost|local|internal|intranet|home|lan|corp)$/.test(hostname)) {
    throw new UnsafeUrlError("İç ağ adresine istek atılamaz.");
  }
  let addresses;
  try {
    addresses = await lookupAll(hostname);
  } catch (e) {
    throw new UnsafeUrlError("Adres çözümlenemedi.");
  }
  if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new UnsafeUrlError("İç ağ adresine istek atılamaz.");
  }
}

async function validateForPolicy(rawUrl, policy) {
  if (policy === "social") {
    const parsed = parseSocialUrl(rawUrl, { allowHttpUpgrade: false });
    if (!parsed) throw new UnsafeUrlError(SUPPORTED_LINK_MESSAGE);
    return parsed.url;
  }
  const url = parse(rawUrl);
  if (!url || url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
    throw new UnsafeUrlError("Güvensiz adres.");
  }
  const hostname = normalizeHostname(url.hostname);
  if (!hostname || isIpLiteral(hostname)) throw new UnsafeUrlError("Güvensiz adres.");
  // Platformun kendi alan adları (ör. v16-webapp.tiktok.com) allowlist'te;
  // diğer CDN host'ları DNS ile özel/iç ağ kontrolünden geçer.
  if (!platformOf(hostname)) await assertPublicHost(hostname);
  return url.href;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
export const MAX_REDIRECTS = 5;

// Güvenli GET: her adımda URL doğrulanır, redirect elle izlenir, zaman aşımı
// gövdenin okunmasını da kapsar. read(res, finalUrl) gövdeyi okuyup sonucu döner.
export async function safeFetch(rawUrl, { policy = "social", timeoutMs = 15_000, maxRedirects = MAX_REDIRECTS, ...init } = {}, read = (res) => res) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let current = rawUrl;
    for (let hop = 0; ; hop++) {
      current = await validateForPolicy(current, policy);
      const res = await fetch(current, { ...init, method: "GET", redirect: "manual", signal: controller.signal });
      if (REDIRECT_STATUSES.has(res.status)) {
        const location = res.headers.get("location");
        await res.body?.cancel?.().catch(() => {});
        if (!location) throw new UnsafeUrlError("Yönlendirme adresi yok.");
        if (hop >= maxRedirects) throw new UnsafeUrlError("Çok fazla yönlendirme.");
        let next;
        try {
          next = new URL(location, current).href;
        } catch (e) {
          throw new UnsafeUrlError("Geçersiz yönlendirme adresi.");
        }
        current = next;
        continue;
      }
      return await read(res, current);
    }
  } finally {
    clearTimeout(timer);
  }
}

// Gövdeyi en fazla maxBytes okur; aşılırsa okumayı keser ve hata fırlatır.
export async function readTextLimited(res, maxBytes) {
  const declared = Number(res.headers.get("content-length")) || 0;
  if (declared > maxBytes) {
    await res.body?.cancel?.().catch(() => {});
    throw new UnsafeUrlError("Yanıt çok büyük.");
  }
  if (!res.body) return "";
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > maxBytes) throw new UnsafeUrlError("Yanıt çok büyük.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}
