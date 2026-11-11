import {
  MAX_IMAGE_EDGE,
  FALLBACK_IMAGE_EDGE,
  JPEG_QUALITY_STEPS,
  MAX_IMAGE_BASE64_CHARS,
  IMAGE_ERROR_CODES,
  targetDimensions,
} from "../shared/imageLimits.js";

// Ekran görüntüleri sunucuya gitmeden önce küçültülüp JPEG'e çevriliyor
// (kurallar: shared/imageLimits.js). Modern telefon ekran görüntüleri ham
// base64 olarak birkaç MB tutuyor; birkaç tanesi Vercel'in istek sınırını
// aşıyor ve Claude zaten 1568 px'in üstünü küçültüyor.
//
// EXIF yönü: createImageBitmap(..., { imageOrientation: "from-image" }) ve
// tarayıcıların <img> varsayılanı (image-orientation: from-image) fotoğrafı
// doğru yönde çiziyor; çıkan JPEG'de EXIF yok, piksel zaten döndürülmüş.

export class ImageProcessError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

async function decode(file) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch (e) {
      // Bazı WebView'ler seçenekli çağrıyı desteklemiyor; <img> ile denenecek.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("decode"));
      el.src = url;
    });
    return img;
  } finally {
    // onload sonrası çizim için nesne hâlâ geçerli; URL'nin bırakılması güvenli.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function sourceSize(source) {
  return { width: source.naturalWidth || source.width, height: source.naturalHeight || source.height };
}

function encode(source, maxEdge, quality) {
  const { width, height } = sourceSize(source);
  const size = targetDimensions(width, height, maxEdge);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new ImageProcessError(IMAGE_ERROR_CODES.invalid);
  // Şeffaf PNG'ler JPEG'de siyaha dönmesin.
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, size.width, size.height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, size.width, size.height);
  const dataUrl = canvas.toDataURL("image/jpeg", quality);
  const match = /^data:image\/jpeg;base64,(.*)$/.exec(dataUrl);
  if (!match) throw new ImageProcessError(IMAGE_ERROR_CODES.invalid);
  return { base64: match[1], dataUrl, width: size.width, height: size.height };
}

// Dosyayı okunabilirliği koruyacak şekilde küçültür. Önce 1568 px / 0.85;
// hâlâ büyükse kaliteyi, en son boyutu (1280 px) düşürür.
export async function compressImageFile(file) {
  if (!file || (file.type && !file.type.startsWith("image/"))) throw new ImageProcessError(IMAGE_ERROR_CODES.unsupported);
  let source;
  try {
    source = await decode(file);
  } catch (e) {
    throw new ImageProcessError(IMAGE_ERROR_CODES.invalid);
  }
  try {
    for (const edge of [MAX_IMAGE_EDGE, FALLBACK_IMAGE_EDGE]) {
      for (const quality of JPEG_QUALITY_STEPS) {
        const out = encode(source, edge, quality);
        if (out.base64.length <= MAX_IMAGE_BASE64_CHARS) {
          return { mediaType: "image/jpeg", base64: out.base64, previewUrl: out.dataUrl, width: out.width, height: out.height };
        }
      }
    }
    throw new ImageProcessError(IMAGE_ERROR_CODES.tooLarge);
  } finally {
    if (typeof source.close === "function") source.close();
  }
}
