// Testlerde zamana değil duruma göre beklemek için ortak yardımcılar (Grup 5).
//
// Neden: "50 ms bekle, sonra say" gibi sabit beklemeler yavaş/yüklü makinede
// (CI, paralel çalışan test dosyaları) yetmiyor; test rastgele düşüyor ve geride
// kalan işler bir sonraki testin sayaçlarını kirletiyordu. Bunun yerine:
//  - waitFor(koşul): koşul doğru olana kadar kısa aralıklarla bakar; süre
//    dolarsa açıklayıcı bir hatayla düşer (sonsuza kadar beklemez).
//  - drainBackground(): Vercel'in waitUntil() ile arka plana attığı işleri
//    (recipe-jobs) toplar ve hepsi bitene kadar bekler.
//
// Bu modül import edildiğinde @vercel/functions'ın okuduğu istek bağlamını
// kurar; böylece üretim kodu değişmeden waitUntil'e verilen promise'ler burada
// izlenir. Üretimde bu bağlamı Vercel'in kendisi sağlar.

const background = new Set();
const SYMBOL = Symbol.for("@vercel/request-context");
if (!globalThis[SYMBOL]) {
  const context = {
    waitUntil(promise) {
      const tracked = Promise.resolve(promise)
        .catch(() => {})
        .finally(() => background.delete(tracked));
      background.add(tracked);
    },
  };
  globalThis[SYMBOL] = { get: () => context };
}

export const backgroundCount = () => background.size;

const DEFAULT_TIMEOUT = Number(process.env.TEST_WAIT_TIMEOUT_MS) || 10_000;
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(condition, { timeout = DEFAULT_TIMEOUT, interval = 5, message = "koşul" } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await condition();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`waitFor zaman aşımı (${timeout} ms): ${message}`);
    await tick(interval);
  }
}

// Arka plandaki tüm waitUntil işleri bitene kadar bekler (iş yeni iş açarsa onu da).
export async function drainBackground({ timeout = DEFAULT_TIMEOUT } = {}) {
  const started = Date.now();
  while (background.size) {
    if (Date.now() - started > timeout) throw new Error(`drainBackground: ${background.size} arka plan işi ${timeout} ms içinde bitmedi`);
    await Promise.race([Promise.allSettled([...background]), tick(50)]);
  }
}
