import React, { useCallback, useEffect, useRef, useState } from "react";
import { X, Camera, Image as ImageIcon, RefreshCw } from "lucide-react";
import { useLanguage } from "../i18n.jsx";
import { parseShareToken } from "./qrLink.js";
import { createFrameDecoder, decodeFromFile } from "./qrDecode.js";
import { QR_COLORS, QR_SHEET_CSS, QR_STYLES } from "./qrTheme.js";

const SCAN_INTERVAL_MS = 140; // ~7 scans/second
const NOT_OURS_COOLDOWN_MS = 2500;

function errorKey(err) {
  const name = err && err.name;
  if (name === "NotAllowedError" || name === "SecurityError") return "qr.permissionDenied";
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") return "qr.noCamera";
  if (name === "NotReadableError" || name === "TrackStartError") return "qr.cameraBusy";
  return "qr.cameraError";
}

// Görünüm: qrTheme.js (dokulu yeşil kart, hardal vurgular, animasyonlu açılış).
const S = {
  hint: { margin: 0, fontSize: 13, textAlign: "center", color: QR_COLORS.paperSoft },
  videoWrap: { position: "relative", width: "100%", aspectRatio: "1 / 1", background: "#0E1A13", borderRadius: 20, overflow: "hidden", boxShadow: "inset 0 0 0 1px rgba(226,188,102,0.25)" },
  video: { width: "100%", height: "100%", objectFit: "cover", display: "block" },
  frame: { position: "absolute", inset: "17%", borderRadius: 18, boxShadow: "0 0 0 999px rgba(14,26,19,0.45)", pointerEvents: "none" },
  center: { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: QR_COLORS.paper, fontSize: 14, padding: 16, textAlign: "center" },
};

// Çerçevenin dört köşesindeki hardal köşebentler.
const CORNER = 34;
const cornerStyle = (pos) => ({
  position: "absolute",
  width: CORNER,
  height: CORNER,
  borderColor: QR_COLORS.mustard,
  borderStyle: "solid",
  borderWidth: 0,
  ...(pos.includes("t") ? { top: -3, borderTopWidth: 4 } : { bottom: -3, borderBottomWidth: 4 }),
  ...(pos.includes("l") ? { left: -3, borderLeftWidth: 4 } : { right: -3, borderRightWidth: 4 }),
  borderTopLeftRadius: pos === "tl" ? 18 : 0,
  borderTopRightRadius: pos === "tr" ? 18 : 0,
  borderBottomLeftRadius: pos === "bl" ? 18 : 0,
  borderBottomRightRadius: pos === "br" ? 18 : 0,
});

export default function QrScanner({ onToken, onClose, cameraAvailable = true, currentOrigin, closing = false }) {
  const { t } = useLanguage();
  const videoRef = useRef(null);
  const fileRef = useRef(null);
  const aliveRef = useRef(true);
  const doneRef = useRef(false);
  const streamRef = useRef(null);
  const timerRef = useRef(null);
  const lastNotOursRef = useRef(0);
  const onTokenRef = useRef(onToken);
  const originRef = useRef(currentOrigin);
  onTokenRef.current = onToken;
  originRef.current = currentOrigin;

  const [status, setStatus] = useState(cameraAvailable ? "starting" : "idle"); // starting | scanning | error | idle
  const [errKey, setErrKey] = useState(null);
  const [notice, setNotice] = useState(null);
  const [runId, setRunId] = useState(0);

  const stopCamera = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const stream = streamRef.current;
    streamRef.current = null;
    if (stream) stream.getTracks().forEach((tr) => tr.stop());
    const v = videoRef.current;
    if (v) {
      try {
        v.srcObject = null;
      } catch {
        // ignore
      }
    }
  }, []);

  const handleText = useCallback(
    (text) => {
      if (doneRef.current) return true;
      const token = parseShareToken(text, { currentOrigin: originRef.current });
      if (token) {
        doneRef.current = true;
        stopCamera();
        try {
          if (navigator.vibrate) navigator.vibrate(60);
        } catch {
          // ignore
        }
        onTokenRef.current && onTokenRef.current(token);
        return true;
      }
      return false;
    },
    [stopCamera]
  );

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      stopCamera();
    };
  }, [stopCamera]);

  useEffect(() => {
    if (!cameraAvailable || doneRef.current) return undefined;
    let cancelled = false;
    setStatus("starting");
    setErrKey(null);

    async function start() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || (typeof window !== "undefined" && window.isSecureContext === false)) {
        setErrKey("qr.cameraUnsupported");
        setStatus("error");
        return;
      }
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      } catch (err) {
        if (cancelled || !aliveRef.current) return;
        setErrKey(errorKey(err));
        setStatus("error");
        return;
      }
      if (cancelled || !aliveRef.current) {
        stream.getTracks().forEach((tr) => tr.stop());
        return;
      }
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) {
        stopCamera();
        return;
      }
      video.srcObject = stream;
      try {
        await video.play();
      } catch {
        // autoplay attribute usually covers this
      }
      if (cancelled || !aliveRef.current) return;
      setStatus("scanning");

      const decoder = createFrameDecoder();
      let busy = false;
      const tick = async () => {
        if (cancelled || !aliveRef.current || doneRef.current) return;
        if (!busy && video.readyState >= 2 && video.videoWidth > 0) {
          busy = true;
          try {
            const text = await decoder.detect(video);
            if (text && !cancelled && aliveRef.current && !handleText(text)) {
              const now = Date.now();
              if (now - lastNotOursRef.current > NOT_OURS_COOLDOWN_MS) {
                lastNotOursRef.current = now;
                setNotice("qr.notOurCode");
              }
            }
          } catch {
            // keep scanning
          }
          busy = false;
        }
        if (!cancelled && aliveRef.current && !doneRef.current) timerRef.current = setTimeout(tick, SCAN_INTERVAL_MS);
      };
      tick();
    }
    start();

    return () => {
      cancelled = true;
      stopCamera();
    };
  }, [cameraAvailable, runId, handleText, stopCamera]);

  // Kapanış animasyonu başlarken kamera hemen bırakılır (geri tuşu yolu dahil).
  useEffect(() => {
    if (closing) stopCamera();
  }, [closing, stopCamera]);

  // Hide the "not ours" notice after a while.
  useEffect(() => {
    if (!notice) return undefined;
    const id = setTimeout(() => setNotice(null), NOT_OURS_COOLDOWN_MS);
    return () => clearTimeout(id);
  }, [notice]);

  async function onPickFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    let text = null;
    try {
      text = await decodeFromFile(file);
    } catch {
      text = null;
    }
    if (!aliveRef.current) return;
    if (!text) {
      setNotice("qr.imageNoCode");
      return;
    }
    if (!handleText(text)) setNotice("qr.notOurCode");
  }

  function close() {
    stopCamera();
    onClose && onClose();
  }

  const showVideo = cameraAvailable && status !== "error";

  return (
    <div className={`qr-root${closing ? " is-closing" : ""}`} style={QR_STYLES.root} role="dialog" aria-modal="true" aria-label={t("qr.scanTitle")}>
      <style>{QR_SHEET_CSS}</style>
      <div className="qr-backdrop" style={QR_STYLES.backdrop} onClick={close} />
      <div className="qr-card" style={QR_STYLES.card}>
        <div style={QR_STYLES.header}>
          <h2 style={QR_STYLES.title}>{t("qr.scanTitle")}</h2>
          <button type="button" style={QR_STYLES.closeBtn} onClick={close} aria-label={t("qr.close")}>
            <X size={20} />
          </button>
        </div>

        {showVideo && (
          <>
            <div style={S.videoWrap}>
              <video ref={videoRef} style={S.video} playsInline muted autoPlay />
              <div style={S.frame}>
                {["tl", "tr", "bl", "br"].map((p) => (
                  <span key={p} style={cornerStyle(p)} />
                ))}
              </div>
              {status === "starting" && (
                <div style={S.center}>
                  <Camera size={18} style={{ marginRight: 8 }} />
                  {t("qr.starting")}
                </div>
              )}
            </div>
            <p style={S.hint}>{t("qr.scanHint")}</p>
          </>
        )}

        {!cameraAvailable && <p style={QR_STYLES.note}>{t("qr.needsAppUpdate")}</p>}
        {status === "error" && errKey && <p style={QR_STYLES.error}>{t(errKey)}</p>}
        {notice && (
          <p style={QR_STYLES.note} role="status">
            {t(notice)}
          </p>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {cameraAvailable && status === "error" && (
            <button type="button" style={QR_STYLES.solidGoldBtn} onClick={() => setRunId((n) => n + 1)}>
              <RefreshCw size={18} />
              {t("qr.retry")}
            </button>
          )}
          <button type="button" style={QR_STYLES.goldBtn} onClick={() => fileRef.current && fileRef.current.click()}>
            <ImageIcon size={18} color={QR_COLORS.gold} />
            {t("qr.pickImage")}
          </button>
          <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={onPickFile} />
        </div>
      </div>
    </div>
  );
}
