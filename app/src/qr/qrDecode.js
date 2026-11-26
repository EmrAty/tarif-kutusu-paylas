import jsQR from "jsqr";

export async function decodeFromImageData(imageData) {
  if (!imageData || !imageData.data || !imageData.width || !imageData.height) return null;
  const result = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: "attemptBoth" });
  return result && result.data ? result.data : null;
}

async function makeBarcodeDetector() {
  try {
    const BD = typeof window !== "undefined" ? window.BarcodeDetector : undefined;
    if (!BD) return null;
    const formats = await BD.getSupportedFormats();
    if (!formats.includes("qr_code")) return null;
    return new BD({ formats: ["qr_code"] });
  } catch {
    return null;
  }
}

function sourceSize(source) {
  return {
    w: source.videoWidth || source.naturalWidth || source.width || 0,
    h: source.videoHeight || source.naturalHeight || source.height || 0,
  };
}

export function createFrameDecoder() {
  let detectorPromise = null;
  let canvas = null;
  let ctx = null;

  function getDetector() {
    if (!detectorPromise) detectorPromise = makeBarcodeDetector();
    return detectorPromise;
  }

  function jsqrFromSource(source, maxSide) {
    const { w, h } = sourceSize(source);
    if (!w || !h) return null;
    const scale = Math.min(1, maxSide / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));
    if (!canvas) {
      canvas = document.createElement("canvas");
      ctx = canvas.getContext("2d", { willReadFrequently: true });
    }
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== ch) canvas.height = ch;
    ctx.drawImage(source, 0, 0, cw, ch);
    return decodeFromImageData(ctx.getImageData(0, 0, cw, ch));
  }

  return {
    async detect(source, { maxSide = 960 } = {}) {
      const detector = await getDetector();
      if (detector) {
        try {
          const codes = await detector.detect(source);
          const hit = codes.find((c) => c.rawValue);
          if (hit) return hit.rawValue;
        } catch {
          // fall through to jsQR
        }
      }
      try {
        return await jsqrFromSource(source, maxSide);
      } catch {
        return null;
      }
    },
  };
}

async function loadImage(file) {
  if (typeof createImageBitmap === "function") {
    try {
      return { source: await createImageBitmap(file), cleanup: null };
    } catch {
      // try <img> below
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error("image load failed"));
      img.src = url;
    });
    return { source: img, cleanup: () => URL.revokeObjectURL(url) };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

export async function decodeFromFile(file) {
  if (!file) return null;
  let loaded;
  try {
    loaded = await loadImage(file);
  } catch {
    return null;
  }
  try {
    return await createFrameDecoder().detect(loaded.source, { maxSide: 1600 });
  } finally {
    if (typeof loaded.source.close === "function") loaded.source.close();
    if (loaded.cleanup) loaded.cleanup();
  }
}
