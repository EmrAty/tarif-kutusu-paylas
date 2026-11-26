export const SHARE_PARAM = "recipeShare";
export const TOKEN_RE = /^[A-Za-z0-9_-]{22,64}$/;

const MAX_INPUT = 2048;
const ALLOWED_HOSTS = new Set([
  "tarifkutusu.app",
  "www.tarifkutusu.app",
  "preview.tarifkutusu.app",
  "tarif-kutusu-paylas.vercel.app",
  "localhost",
  "127.0.0.1",
]);

export function buildShareUrl(origin, token) {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) throw new Error("invalid share token");
  return `${String(origin).replace(/\/+$/, "")}/?${SHARE_PARAM}=${token}`;
}

function hostOf(origin) {
  if (!origin) return null;
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return null;
  }
}

export function parseShareToken(text, { currentOrigin } = {}) {
  if (typeof text !== "string") return null;
  const input = text.trim();
  if (!input || input.length > MAX_INPUT) return null;
  let url;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.host.toLowerCase();
  const own = hostOf(currentOrigin);
  if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase()) && host !== own) return null;
  const token = url.searchParams.get(SHARE_PARAM);
  return token && TOKEN_RE.test(token) ? token : null;
}

export function readShareTokenFromLocation(location) {
  try {
    const token = new URLSearchParams(location?.search || "").get(SHARE_PARAM);
    return token && TOKEN_RE.test(token) ? token : null;
  } catch {
    return null;
  }
}
