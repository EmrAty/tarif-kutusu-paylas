import React, { useCallback, useEffect, useRef, useState } from "react";
import { X, Camera, Image as ImageIcon, RefreshCw } from "lucide-react";
import { useLanguage } from "../i18n.jsx";
import { parseShareToken } from "./qrLink.js";
import { createFrameDecoder, decodeFromFile } from "./qrDecode.js";

const SCAN_INTERVAL_MS = 140; // ~7 scans/second
const NOT_OURS_COOLDOWN_MS = 2500;

function errorKey(err) {
  const name = err && err.name;
  if (name === "NotAllowedError" || name === "SecurityError") return "qr.permissionDenied";
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") return "qr.noCamera";
  if (name === "NotReadableError" || name === "TrackStartError") return "qr.cameraBusy";
  return "qr.cameraError";
}

const S = {
  backdrop: { position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, boxSizing: "border-box" },
  card: { width: "100%", maxWidth: 420, maxHeight: "100%", overflowY: "auto", background: "#fff", color: "#1f2a1f", borderRadius: 20, padding: 16, boxSizing: "border-box", display: "flex", flexDirection: "column", gap: 12 },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 },
  title: { margin: 0, fontSize: 18, fontWeight: 700 },
  iconBtn: { border: "none", background: "#eef0ec", borderRadius: 999, width: 40, height: 40, display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "inherit" },
  hint: { margin: 0, fontSize: 14, opacity: 0.8 },
  videoWrap: { position: "relative", width: "100%", aspectRatio: "1 / 1", background: "#0b0f0b", borderRadius: 16, overflow: "hidden" },
  video: { width: "100%", height: "100%", objectFit: "cover", display: "block" },
  frame: { position: "absolute", inset: "18%", border: "3px solid rgba(255,255,255,0.9)", borderRadius: 16, boxShadow: "0 0 0 999px rgba(0,0,0,0.35)", pointerEvents: "none" },
  center: { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 14, padding: 16, textAlign: "center" },
  msg: { margin: 0, fontSize: 14, lineHeight: 1.4, padding: "10px 12px", borderRadius: 12, background: "#fdf3d8", color: "#5a4300" },
  err: { margin: 0, fontSize: 14, lineHeight: 1.4, padding: "10px 12px", borderRadius: 12, background: "#fbe4e1", color: "#7a1f14" },
  btn: { border: "none", borderRadius: 12, minHeight: 44, padding: "0 16px", fontSize: 15, fontWeight: 600, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, cursor: "pointer", background: "#2d4a2d", color: "#fff" },
  btn2: { background: "#eef0ec", color: "#1f2a1f" },
};

export default function QrScanner({ onToken, onClose, cameraAvailable = true, currentOrigin }) {
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
    <div style={S.backdrop} role="dialog" aria-modal="true" aria-label={t("qr.scanTitle")}>
      <div style={S.card}>
        <div style={S.header}>
          <h2 style={S.title}>{t("qr.scanTitle")}</h2>
          <button type="button" style={S.iconBtn} onClick={close} aria-label={t("qr.close")}>
            <X size={20} />
          </button>
        </div>

        {showVideo && (
          <>
            <div style={S.videoWrap}>
              <video ref={videoRef} style={S.video} playsInline muted autoPlay />
              <div style={S.frame} />
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

        {!cameraAvailable && <p style={S.msg}>{t("qr.needsAppUpdate")}</p>}
        {status === "error" && errKey && <p style={S.err}>{t(errKey)}</p>}
        {notice && (
          <p style={S.msg} role="status">
            {t(notice)}
          </p>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {cameraAvailable && status === "error" && (
            <button type="button" style={S.btn} onClick={() => setRunId((n) => n + 1)}>
              <RefreshCw size={18} />
              {t("qr.retry")}
            </button>
          )}
          <button type="button" style={{ ...S.btn, ...S.btn2 }} onClick={() => fileRef.current && fileRef.current.click()}>
            <ImageIcon size={18} />
            {t("qr.pickImage")}
          </button>
          <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={onPickFile} />
        </div>
      </div>
    </div>
  );
}
