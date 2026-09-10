import { requireUser } from "./_lib/auth.js";
import { redisGet } from "./_lib/redis.js";

// Aile hesapları/Plus özelliği eklenmeden önce tüm uygulama tek bir paylaşımlı
// listeydi ("recipes" / "shopping-list" / "pantry-items" anahtarları, kimliğe
// bağlı değildi). Bu eski veriler hâlâ Redis'te duruyor — bu endpoint, giriş
// yapmış herhangi bir kullanıcının bunları görüp kişisel listesine ya da bir
// aileye "içe aktarabilmesini" sağlıyor, otomatik/sessizce taşımıyor (hangi
// hesabın/ailenin bu eski veriyi devralacağına insan karar vermeli).
export default async function handler(req, res) {
  try {
    await requireUser(req);
  } catch (e) {
    res.status(e.status || 401).json({ error: e.message });
    return;
  }
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  try {
    const [recipes, shoppingList, pantryItems] = await Promise.all([
      redisGet("recipes"),
      redisGet("shopping-list"),
      redisGet("pantry-items"),
    ]);
    res.status(200).json({ recipes: recipes || null, shoppingList: shoppingList || null, pantryItems: pantryItems || null });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
}
