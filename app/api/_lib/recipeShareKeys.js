// QR paylaşım kayıtlarının anahtarları ve hesap silmede temizlik (bkz. recipeShares.js).
// Ayrı modül: accountDeletion.js ile recipeShares.js arasında döngüsel içe aktarma olmasın.
import { redisDel, redisGetJSON } from "./redis.js";
import { SHARE_TOKEN_RE } from "../../shared/recipeShare.js";

export const shareKey = (token) => `recipe-share:${token}`;
export const shareIndexKey = (uid) => `user:${uid}:recipe-shares`;

// Hesap silinirken sahibin bütün paylaşımları durdurulur. (Kayıtlar okunurken
// sahibin hesabını ve tarifini zaten doğruladığı için bu yalnızca temizlik.)
export async function deleteSharesOf(uid) {
  const index = await redisGetJSON(shareIndexKey(uid), {});
  const tokens = Object.values(index && typeof index === "object" ? index : {})
    .map((v) => v && v.token)
    .filter((t) => typeof t === "string" && SHARE_TOKEN_RE.test(t));
  for (const t of tokens) await redisDel(shareKey(t));
  await redisDel(shareIndexKey(uid));
  return tokens.length;
}
