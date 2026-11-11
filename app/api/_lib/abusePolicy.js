// AI uçlarının kötüye kullanım sınırları — TEK yer. Bunlar ürün kotası DEĞİL:
// normal bir kullanıcının (Free ya da Plus) hiç ulaşmayacağı, yalnızca bot/script
// davranışını kesen güvenlik tavanları. Kullanıcıya "günde X tarif" diye
// gösterilmez; aşılırsa anlaşılır bir "biraz bekle" mesajı döner.
//
// Pencereler sabit (fixed window): { seconds, user, anon }.
//   user = kalıcı (e-posta/Google) hesap, anon = misafir (anonim Firebase) hesap.
// Misafir hesap saniyeler içinde yeniden üretilebildiği için hem UID başına daha
// sıkı, hem de aşağıdaki IP tavanına tabi.
//
// Ortam değişkeniyle ayarlanabilenler (Vercel → Settings → Environment Variables):
//   AI_KILL_SWITCH=1             → bütün AI çağrıları hemen 503 (acil durum).
//   AI_GLOBAL_HOURLY_LIMIT=<n>   → tüm sistemde saatlik AI çağrısı tavanı.
//   AI_GLOBAL_DAILY_LIMIT=<n>    → tüm sistemde günlük AI çağrısı tavanı.
//   AI_USER_* / AI_ANON_*        → UID başına tüm AI uçlarının toplam tavanı (aşağıda).

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86400;

export const RATE_LIMITS = {
  // Yeni Tarif Çıkar (/api/extract) — görsel içerebilir, en pahalı çağrı.
  extract: [
    { seconds: MINUTE, user: 8, anon: 5 },
    { seconds: HOUR, user: 100, anon: 40 },
    { seconds: DAY, user: 400, anon: 120 },
  ],
  // Paylaşım paneli job'u (/api/recipe-jobs POST) — Claude + gerekirse transkripsiyon.
  recipeJob: [
    { seconds: MINUTE, user: 8, anon: 5 },
    { seconds: HOUR, user: 100, anon: 40 },
    { seconds: DAY, user: 400, anon: 120 },
  ],
  // Elimde Bunlar Var (/api/suggest-recipes).
  suggest: [
    { seconds: MINUTE, user: 8, anon: 5 },
    { seconds: HOUR, user: 60, anon: 30 },
    { seconds: DAY, user: 300, anon: 100 },
  ],
  // Çeviri (/api/translate-recipe) — yalnızca önbellek ıskalarında sayılır;
  // önbellekten dönen çeviri hiç sayılmaz.
  translate: [
    { seconds: MINUTE, user: 30, anon: 15 },
    { seconds: HOUR, user: 300, anon: 120 },
    { seconds: DAY, user: 1500, anon: 400 },
  ],
  // Video açıklaması (/api/fetch-caption) — AI değil ama dışarıya istek atıyor.
  caption: [
    { seconds: MINUTE, user: 30, anon: 20 },
    { seconds: HOUR, user: 300, anon: 150 },
  ],
};

// Misafir hesaplarda aynı IP'den gelen tüm AI çağrıları (yeni UID üretmek bu
// tavanı aşmaz). Mobil operatörler CGNAT ile çok kullanıcıyı aynı IP'de
// toplayabildiği için yüksek tutuldu ve yalnızca misafirlere uygulanıyor.
export const ANON_IP_LIMITS = [
  { seconds: MINUTE, limit: 30 },
  { seconds: HOUR, limit: 200 },
];
export const ANON_IP_CAPTION_LIMITS = [
  { seconds: MINUTE, limit: 60 },
  { seconds: HOUR, limit: 400 },
];

// Aynı anda süren pahalı AI işi (UID başına). "heavy" havuzu Yeni Tarif Çıkar ile
// paylaşım job'larını birlikte sayar. ttlSeconds: fonksiyon öldürülse bile kira
// bu süre sonunda kendiliğinden düşer (sonsuza kadar kilit kalmaz).
export const CONCURRENCY = {
  heavy: { user: 5, anon: 3, ttlSeconds: 330 },
  suggest: { user: 2, anon: 2, ttlSeconds: 120 },
};

// Hangi eylem hangi eşzamanlılık havuzunu kullanıyor (yoksa yalnızca hız sınırı).
export const ACTION_POOL = { extract: "heavy", recipeJob: "heavy", suggest: "suggest" };

// Global güvenlik tavanı: tüm kullanıcıların toplam AI çağrısı. Varsayılanlar
// kapalı test ölçeğinin çok üstünde; asıl para sınırı sağlayıcı panelindeki
// harcama limitidir (kod dışı).
export const GLOBAL_DEFAULTS = { hourly: 600, daily: 4000 };
// Global sayaca giren (gerçekten AI sağlayıcısına giden) eylemler.
export const GLOBAL_ACTIONS = new Set(["extract", "recipeJob", "suggest", "translate"]);

function envInt(name, fallback) {
  const raw = process.env[name];
  const value = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

export function globalLimits() {
  return {
    hourly: envInt("AI_GLOBAL_HOURLY_LIMIT", GLOBAL_DEFAULTS.hourly),
    daily: envInt("AI_GLOBAL_DAILY_LIMIT", GLOBAL_DEFAULTS.daily),
  };
}

// UID başına TÜM AI uçlarının toplamı (extract + recipeJob + suggest + translate).
// Uç bazlı sınırların toplamı saatte ~560 olduğu için tek bir hesap global tavanın
// (600) neredeyse tamamını tüketebiliyordu. Bu bir ürün kotası DEĞİL, emniyet
// kemeri: uygulamada hiçbir yerde "kalan hakkın" gösterilmez, aşılırsa normal
// "biraz bekle" (429 rate_limited) mesajı döner.
//   Saatte 120: bir saatte 30–40 tarif çıkarıp onlarca tarifi çevirmek bile sığar.
//   Günde 600: gün boyu her 3 dakikada bir AI çağrısı.
// Ayrıca hiçbir UID global tavanın USER_SHARE_OF_GLOBAL'ından fazlasını alamaz
// (global tavan env ile düşürülürse kullanıcı tavanı da kendiliğinden düşer).
//   AI_USER_HOURLY_LIMIT / AI_USER_DAILY_LIMIT   → kalıcı hesap
//   AI_ANON_HOURLY_LIMIT / AI_ANON_DAILY_LIMIT   → misafir hesap
export const USER_AI_DEFAULTS = {
  user: { hourly: 120, daily: 600 },
  anon: { hourly: 60, daily: 200 },
};
export const USER_SHARE_OF_GLOBAL = 0.2;

export function userAiLimits(isAnonymous) {
  const base = isAnonymous ? USER_AI_DEFAULTS.anon : USER_AI_DEFAULTS.user;
  const prefix = isAnonymous ? "AI_ANON" : "AI_USER";
  const global = globalLimits();
  const cap = (value, globalValue) => Math.min(value, Math.max(1, Math.floor(globalValue * USER_SHARE_OF_GLOBAL)));
  return {
    hourly: cap(envInt(`${prefix}_HOURLY_LIMIT`, base.hourly), global.hourly),
    daily: cap(envInt(`${prefix}_DAILY_LIMIT`, base.daily), global.daily),
  };
}

export function killSwitchOn() {
  return /^(1|true|on|yes)$/i.test(process.env.AI_KILL_SWITCH || "");
}
