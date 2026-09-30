// Free hesabın kişisel tarif sınırı — istemci (App.jsx) ve sunucu
// (api/_lib/profile.js üzerinden data.js, recipe-jobs.js) aynı değeri okuyor.
// Sınır yalnızca YENİ kişisel tarif eklemeyi durdurur; sınırın üstündeki
// mevcut tarifler (ör. Plus kapandıktan sonra) silinmez, düzenlenebilir.
export const FREE_RECIPE_LIMIT = 15;

// Sunucunun limit hatasına eklediği kod; istemci mesajı kendi dilinde gösterir.
export const FREE_LIMIT_ERROR_CODE = "free_recipe_limit";
