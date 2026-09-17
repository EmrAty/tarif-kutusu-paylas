const BASE_URL = process.env.KV_REST_API_URL;
const TOKEN = process.env.KV_REST_API_TOKEN;

function assertConfigured() {
  if (!BASE_URL || !TOKEN) {
    const err = new Error("Sunucu yapılandırması eksik: veritabanı bağlantısı tanımlı değil.");
    err.status = 500;
    throw err;
  }
}

export async function redisGet(key) {
  assertConfigured();
  const res = await fetch(`${BASE_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) {
    const err = new Error("Veritabanına erişilemedi.");
    err.status = 502;
    throw err;
  }
  const data = await res.json();
  return data.result ?? null;
}

export async function redisDel(key) {
  assertConfigured();
  const res = await fetch(BASE_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(["DEL", key]),
  });
  if (!res.ok) {
    const err = new Error("Veritabanından silinemedi.");
    err.status = 502;
    throw err;
  }
}

export async function redisSet(key, value, ttlSeconds) {
  assertConfigured();
  const command = ttlSeconds ? ["SET", key, value, "EX", String(ttlSeconds)] : ["SET", key, value];
  const res = await fetch(BASE_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  if (!res.ok) {
    const err = new Error("Veritabanına yazılamadı.");
    err.status = 502;
    throw err;
  }
}

// Key yoksa yazar (SET NX EX). true: bu çağrı yazdı, false: key zaten vardı.
export async function redisSetNX(key, value, ttlSeconds) {
  assertConfigured();
  const res = await fetch(BASE_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(["SET", key, value, "NX", "EX", String(ttlSeconds)]),
  });
  if (!res.ok) {
    const err = new Error("Veritabanına yazılamadı.");
    err.status = 502;
    throw err;
  }
  const data = await res.json();
  return data.result === "OK";
}

export async function redisGetJSON(key, fallback) {
  const raw = await redisGet(key);
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

export async function redisSetJSON(key, value, ttlSeconds) {
  await redisSet(key, JSON.stringify(value), ttlSeconds);
}
