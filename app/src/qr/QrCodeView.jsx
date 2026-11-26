import React, { useMemo } from "react";
import qrcode from "qrcode-generator";

const QUIET = 4;

// dark/light: modül ve zemin rengi. Okunabilirlik için dark her zaman koyu, light açık olmalı.
export default function QrCodeView({ value, size = 240, label, dark = "#000", light = "#fff" }) {
  const model = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(String(value ?? ""));
    qr.make();
    const n = qr.getModuleCount();
    let d = "";
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) d += `M${c + QUIET} ${r + QUIET}h1v1h-1z`;
      }
    }
    return { n, d };
  }, [value]);
  const total = model.n + QUIET * 2;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${total} ${total}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label={label}
      style={{ display: "block", maxWidth: "100%", height: "auto", background: light, borderRadius: 8 }}
    >
      <rect width={total} height={total} fill={light} />
      <path d={model.d} fill={dark} />
    </svg>
  );
}
