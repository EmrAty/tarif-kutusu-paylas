// Liste başlıkları çevirisi: sunucu tek istekte en çok MAX_TITLES_PER_CALL başlık çevirir,
// kalanlar sonraki istekte gelir. Bu yardımcı, istenen tüm başlıklar yanıtta olana kadar
// (ilerleme olduğu sürece, sert tur sınırıyla) isteği tekrarlar. `request` enjekte edilir.
export const MAX_TITLE_ROUNDS = 10;

export async function fetchAllTitles({ wanted, request, maxRounds = MAX_TITLE_ROUNDS }) {
  const titles = {};
  const want = [...new Set(wanted)];
  const covered = () => want.filter((t) => typeof titles[t] === "string" && titles[t]).length;
  let rounds = 0;
  let error = null;
  while (rounds < maxRounds && covered() < want.length) {
    const before = covered();
    let data;
    rounds++;
    try {
      data = await request();
    } catch (e) {
      error = e; // eldeki kısmi sonuç korunur
      break;
    }
    Object.assign(titles, (data && data.titles) || {});
    // İlerleme yoksa (hata, hız sınırı, atlanan başlık) tekrar denemek döngüye sokar.
    if (!(data && data.translated > 0) || covered() <= before) break;
  }
  return { titles, rounds, complete: covered() >= want.length, error };
}
