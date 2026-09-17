import { waitUntil } from "@vercel/functions";
import { requireUser } from "./_lib/auth.js";
import { redisGet, redisSet, redisGetJSON, redisSetJSON, redisSetNX } from "./_lib/redis.js";
import { getProfile, FREE_RECIPE_LIMIT } from "./_lib/profile.js";
import { fetchCaptionFor } from "./_lib/caption.js";
import { extractRecipeFromText } from "./_lib/extractRecipe.js";
import { notifyUserDevices } from "./_lib/fcm.js";

// Android share-intent akışı (TikTok/Instagram/YouTube -> Paylaş -> Tarif Kutusu)
// için: link kabul edilir edilmez hızlıca {jobId} döner, asıl Claude/kaydetme
// işini waitUntil() ile response gönderildikten SONRA da (client bağlantısı
// kesilse/WebView arka plana alınsa bile) tamamlar. /api/extract.js ve normal
// "Yeni Tarif Çıkar" akışına dokunulmadı, bu tamamen paralel bir yol.
//
// Vercel'in varsayılan davranışı (supportsCancellation açık değilse - bu
// projede vercel.json hiç yok, yani kapalı) zaten client disconnect olunca
// fonksiyonu öldürmüyor; waitUntil ekstra olarak response'u ERKEN göndermemizi
// (kullanıcı hemen geri dönebilsin) ama arka plandaki işin yine de fonksiyonun
// maxDuration'ına kadar garantili tamamlanmasını sağlıyor.
export const config = { maxDuration: 60 };

function genId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function jobKey(uid, jobId) {
  return `job:${uid}:${jobId}`;
}

function dedupeKey(uid, sourceUrl) {
  return `job-dedupe:${uid}:${encodeURIComponent(sourceUrl)}`;
}

async function patchJob(uid, jobId, patch) {
  const key = jobKey(uid, jobId);
  const current = (await redisGetJSON(key, null)) || {};
  const next = { ...current, ...patch };
  await redisSetJSON(key, next);
  return next;
}

// Job'ı gerçekten çalıştırıp bitiren asıl fonksiyon — recipe-jobs.js'in POST
// handler'ı bunu waitUntil() içine sarıyor. Sırasıyla: 50 limit kontrolü (Claude
// çağrısından ÖNCE) -> video açıklaması -> Claude ile tarif çıkarma -> normal
// kişisel tarif şemasına kaydetme -> job'ı completed yapma -> ANCAK BUNDAN SONRA
// FCM gönderme (bildirime basınca henüz Redis'e yazılmamış bir tarife gidilmesin
// diye). Herhangi bir adım patlarsa job "failed" olur ve kullanıcıya (mümkünse)
// "Tarif oluşturulamadı" bildirimi gider - sonsuza kadar "processing" kalmaz.
async function processRecipeJob({ uid, jobId, sourceUrl, sharedText }) {
  try {
    await patchJob(uid, jobId, { status: "processing" });

    const profile = await getProfile(uid);
    if (!profile.isPlus) {
      const existing = (await redisGetJSON(`user:${uid}:recipes`, [])) || [];
      if (existing.length >= FREE_RECIPE_LIMIT) {
        const err = new Error(`Ücretsiz hesaplarda en fazla ${FREE_RECIPE_LIMIT} kişisel tarif olabilir.`);
        err.code = "limit";
        throw err;
      }
    }

    let caption = "";
    try {
      const result = await fetchCaptionFor(sourceUrl);
      caption = result?.caption || "";
    } catch (e) {
      // Video açıklaması otomatik alınamadı - aşağıda paylaşılan ham metne
      // (varsa) düşülüyor, Claude yine de o metinden bir şeyler çıkarmayı dener.
    }
    if (!caption.trim() && sharedText && sharedText.trim()) {
      caption = sharedText.trim();
    }

    const parsed = await extractRecipeFromText({ link: sourceUrl, caption, notes: "" });

    const recipeId = genId();
    const recipe = {
      id: recipeId,
      createdAt: Date.now(),
      link: sourceUrl,
      // Kategori bilinçli olarak boş bırakılıyor - RecipeDetail zaten
      // kategorisiz tariflerde "kategori seç" bandını gösteriyor (mevcut
      // özellik), kullanıcı bildirime basıp tarife girince onu tamamlıyor.
      category: "",
      isFavorite: false,
      addedBy: "",
      ...parsed,
    };

    const recipesKey = `user:${uid}:recipes`;
    const currentList = (await redisGetJSON(recipesKey, [])) || [];
    await redisSet(recipesKey, JSON.stringify([recipe, ...currentList]));

    // Tarif Redis'e başarıyla yazıldıktan SONRA job'ı completed yapıp FCM
    // gönderiyoruz - kullanıcı bildirime bastığında tarif orada olmalı.
    await patchJob(uid, jobId, { status: "completed", recipeId });

    await notifyUserDevices(uid, {
      title: "Tarifin hazır 🍝",
      body: recipe.title ? `${recipe.title} tarifin hazır.` : "Tarifin hazır.",
      data: { type: "recipe_ready", recipeId },
    });
  } catch (e) {
    await patchJob(uid, jobId, { status: "failed", error: e.message || "Bilinmeyen hata" }).catch(() => {});
    await notifyUserDevices(uid, {
      title: "Tarif oluşturulamadı",
      body: "Paylaştığın videodan tarif çıkarılamadı. Uygulamadan tekrar deneyebilirsin.",
      data: { type: "recipe_failed" },
    }).catch(() => {});
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    res.status(e.status || 401).json({ error: e.message });
    return;
  }

  const { sourceUrl, sharedText } = req.body || {};
  if (!sourceUrl || typeof sourceUrl !== "string" || !/^https?:\/\//i.test(sourceUrl.trim())) {
    res.status(400).json({ error: "Geçersiz video linki." });
    return;
  }
  const trimmedUrl = sourceUrl.trim();

  // Idempotency: aynı link 90 saniye içinde tekrar gelirse (ör. share intent
  // yanlışlıkla iki kez tetiklenirse) yeni bir job açmak yerine mevcut olanı
  // döndürüyoruz - basit bir Redis SET NX kilidi, yeni bir sistem değil.
  const jobId = genId();
  const dKey = dedupeKey(user.uid, trimmedUrl);
  let acquired;
  try {
    acquired = await redisSetNX(dKey, jobId, 90);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
    return;
  }

  if (!acquired) {
    const existingId = await redisGet(dKey).catch(() => null);
    const targetId = existingId || jobId;
    const existingJob = await redisGetJSON(jobKey(user.uid, targetId), null).catch(() => null);
    res.status(200).json({ jobId: targetId, status: existingJob?.status || "queued", duplicate: true });
    return;
  }

  const jobRecord = {
    id: jobId,
    userId: user.uid,
    sourceUrl: trimmedUrl,
    status: "queued",
    createdAt: Date.now(),
    recipeId: null,
    error: null,
  };
  await redisSetJSON(jobKey(user.uid, jobId), jobRecord);

  waitUntil(
    processRecipeJob({
      uid: user.uid,
      jobId,
      sourceUrl: trimmedUrl,
      sharedText: typeof sharedText === "string" ? sharedText : "",
    })
  );

  res.status(200).json({ jobId, status: "queued" });
}
