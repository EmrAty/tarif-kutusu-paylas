import React, { useState, useEffect, useRef } from "react";
import { ChefHat, Link2, Loader2, AlertCircle, Check, Plus } from "lucide-react";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "./firebase.js";
import { COLORS, SERIF, BODY, uid, storageGet, authedFetch } from "./App.jsx";
import { CATEGORIES } from "../shared/recipeExtraction.js";
import { useLanguage } from "./i18n.jsx";

// Android paylaşım paneli. Native ShareActivity, kaynak uygulamanın (TikTok vb.)
// üstünde açtığı yarım ekranlık pencerede bu sayfayı "?sharePanel=1" ile
// yüklüyor (bkz. main.jsx ve app/android/.../ShareActivity.java). Normal
// uygulama burada hiç render edilmiyor: sadece link + açıklama + kategori alınıp
// /api/recipe-jobs'a gönderiliyor, tarif sunucuda hazırlanıyor.
//
// Kayıt hedefi tek seçim: kendi tariflerin (varsayılan) ya da üyesi olduğun
// bir aile. Aileler yalnızca Plus + gerçek üyelik varsa (GET /api/families,
// ana uygulamanın kullandığı aynı uç) listeleniyor; sunucu seçimi job
// kabulünde ve kayıttan önce yeniden doğruluyor.
const PERSONAL_TARGET = "personal";
// Plus/aile bilgisi istek dönmeden bilinmiyor. "Aileler yükleniyor…" satırı
// Free kullanıcıya hiç görünmesin diye yalnızca bu cihazda son sonuç "Plus +
// aile var" idiyse gösteriliyor (ilk açılışta da gösterilmiyor).
const FAMILIES_HINT_KEY = "tarif-kutusu:share-panel-has-families";

function readFamiliesHint() {
  try {
    return window.localStorage.getItem(FAMILIES_HINT_KEY) === "1";
  } catch (e) {
    return false;
  }
}

function writeFamiliesHint(hasFamilies) {
  try {
    if (hasFamilies) window.localStorage.setItem(FAMILIES_HINT_KEY, "1");
    else window.localStorage.removeItem(FAMILIES_HINT_KEY);
  } catch (e) {
    // depolama yoksa yalnızca yükleniyor satırı gösterilmez
  }
}
function sharedLinkFrom(text) {
  const found = (text || "").match(/https?:\/\/[^\s]+/g) || [];
  return found.find((u) => /tiktok\.com|youtu\.be|youtube\.com|instagram\.com/i.test(u)) || "";
}

const SPIN_CSS = `.spin { animation: spin 1s linear infinite; } @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`;

export default function SharePanel() {
  const { t, categoryLabel, language } = useLanguage();
  const bridge = typeof window !== "undefined" ? window.TarifKutusuShare : undefined;
  const [authChecked, setAuthChecked] = useState(false);
  const [authUser, setAuthUser] = useState(null);
  const [link, setLink] = useState("");
  const [caption, setCaption] = useState("");
  const [fetchingCaption, setFetchingCaption] = useState(false);
  const [captionError, setCaptionError] = useState("");
  const [category, setCategory] = useState("");
  const [status, setStatus] = useState("idle"); // "idle" | "sending" | "sent"
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [familyInfo, setFamilyInfo] = useState({ status: "idle", families: [] }); // "idle" | "loading" | "ready" | "error"
  const [target, setTarget] = useState(PERSONAL_TARGET);
  const [expectFamilies] = useState(readFamiliesHint);
  const requestIdRef = useRef(uid());

  useEffect(() => {
    document.body.style.background = COLORS.paper;
    try {
      const shared = JSON.parse(bridge?.getSharedText() || "{}");
      setLink(sharedLinkFrom([shared.text, shared.title].filter(Boolean).join(" ")));
    } catch (e) {
      setLink("");
    }
    bridge?.ready();
  }, [bridge]);

  useEffect(() => onAuthStateChanged(auth, (user) => {
    setAuthUser(user);
    setAuthChecked(true);
  }), []);

  useEffect(() => {
    // Aile listesi yalnızca oturum hazır olunca ve tek istekle alınıyor; panelin
    // geri kalanı bunu beklemiyor. Başarısız olursa yalnızca "Kendime" kalıyor.
    if (!authUser) return;
    let cancelled = false;
    setFamilyInfo({ status: "loading", families: [] });
    authedFetch("/api/families")
      .then((data) => {
        if (cancelled) return;
        const families = data.isPlus && Array.isArray(data.families) ? data.families : [];
        writeFamiliesHint(families.length > 0);
        setFamilyInfo({ status: "ready", families: families.map((f) => ({ id: f.id, name: f.name })) });
      })
      .catch(() => {
        if (!cancelled) setFamilyInfo({ status: "error", families: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [authUser]);

  // Seçili aile listede yoksa (liste yenilendi/boş geldi) hedef kişisele döner.
  useEffect(() => {
    if (target !== PERSONAL_TARGET && !familyInfo.families.some((f) => f.id === target)) {
      setTarget(PERSONAL_TARGET);
    }
  }, [familyInfo, target]);

  useEffect(() => {
    // Açıklama "Yeni Tarif Çıkar" ekranındaki (AddForm) ile aynı uçtan, aynı
    // şekilde geliyor. Panel Claude'u beklemiyor, hemen açılıyor.
    if (!link) return;
    let cancelled = false;
    setFetchingCaption(true);
    setCaptionError("");
    fetch("/api/fetch-caption?url=" + encodeURIComponent(link))
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.ok && data.caption) setCaption(data.caption);
        else setCaptionError(t("errors.captionFetchFailed"));
      })
      .catch(() => {
        if (!cancelled) setCaptionError(t("errors.captionFetchFailed"));
      })
      .finally(() => {
        if (!cancelled) setFetchingCaption(false);
      });
    return () => {
      cancelled = true;
    };
  }, [link]);

  const handleSubmit = async () => {
    setError("");
    if (!category) {
      setError(t("errors.needCategory"));
      return;
    }
    if (!caption.trim()) {
      setError(t("sharePanel.errorCaptionRequired"));
      return;
    }
    setStatus("sending");
    try {
      const data = await authedFetch("/api/recipe-jobs", {
        method: "POST",
        body: {
          // Her panel tek bir requestId taşıyor: çift dokunuş ya da hatadan
          // sonraki yeniden deneme ikinci bir tarif oluşturmuyor.
          requestId: requestIdRef.current,
          sourceUrl: link,
          caption: caption.trim(),
          category,
          addedBy: storageGet("person-name")?.value || "",
          // Tarif metinleri uygulamanın dilinde üretilsin (kaynak videonun dili değil).
          language,
          ...(target === PERSONAL_TARGET ? { target: "personal" } : { target: "family", familyId: target }),
        },
      });
      if (!data.jobId) throw new Error(t("sharePanel.errorJobStartFailed"));
      setStatus("sent");
      // Panel kapanana kadar yukarı kaydırılıp uygulama açılırsa aynı link
      // "Yeni Tarif Çıkar"a tekrar taşınmasın (eski APK'da bu metot yok).
      if (typeof bridge?.jobAccepted === "function") bridge.jobAccepted();
      setNote(
        data.notifyDevices === 0
          ? t("sharePanel.noNotifyNote")
          : t("sharePanel.willNotify")
      );
      // Panel yalnızca sunucu job'ı kabul ettikten sonra kapanıyor.
      setTimeout(() => bridge?.close(), 1400);
    } catch (e) {
      setStatus("idle");
      setError(e.message || t("sharePanel.errorJobStartFailed"));
    }
  };

  const labelStyle = {
    display: "block",
    fontSize: "11px",
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    color: COLORS.inkSoft,
    marginBottom: "6px",
  };

  const frame = (children) => (
    <div style={{ background: COLORS.paper, padding: "14px 18px 24px", fontFamily: BODY, color: COLORS.ink }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "14px" }}>
        <ChefHat size={20} color={COLORS.forest} />
        <h1 style={{ fontFamily: SERIF, fontSize: "20px", color: COLORS.forest, margin: 0 }}>{t("appName")}</h1>
      </div>
      {children}
      <style>{SPIN_CSS}</style>
    </div>
  );

  const openInApp = () => bridge?.openInApp();

  if (!link) {
    return frame(
      <div>
        <p style={{ fontSize: "14px", color: COLORS.inkSoft, margin: "0 0 16px" }}>
          {t("sharePanel.noLinkFound")}
        </p>
        <button
          onClick={() => bridge?.close()}
          style={{ padding: "12px 18px", borderRadius: "10px", background: COLORS.forest, color: "#F3EFE6", border: "none", fontWeight: 700, fontSize: "15px" }}
        >
          {t("common.close")}
        </button>
      </div>
    );
  }

  if (!authChecked) {
    return frame(
      <div style={{ display: "flex", alignItems: "center", gap: "8px", color: COLORS.inkSoft, fontSize: "14px" }}>
        <Loader2 size={16} className="spin" /> {t("sharePanel.preparing")}
      </div>
    );
  }

  if (!authUser) {
    return frame(
      <div>
        <p style={{ fontSize: "14px", color: COLORS.inkSoft, margin: "0 0 16px" }}>
          {t("sharePanel.needLogin")}
        </p>
        <button
          onClick={openInApp}
          style={{ padding: "12px 18px", borderRadius: "10px", background: COLORS.mustard, color: COLORS.forestDark, border: "none", fontWeight: 700, fontSize: "15px" }}
        >
          {t("sharePanel.openInApp")}
        </button>
      </div>
    );
  }

  if (status === "sent") {
    return frame(
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "10px", paddingTop: "28px", textAlign: "center" }}>
        <Check size={34} color={COLORS.forest} />
        <p style={{ fontFamily: SERIF, fontSize: "19px", color: COLORS.forest, margin: 0 }}>{t("sharePanel.recipePreparing")}</p>
        <p style={{ fontSize: "13px", color: COLORS.inkSoft, margin: 0 }}>{note}</p>
      </div>
    );
  }

  return frame(
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          borderRadius: "8px",
          border: `1px solid ${COLORS.line}`,
          background: COLORS.panel,
          padding: "10px 12px",
          marginBottom: "16px",
        }}
      >
        <Link2 size={15} color={COLORS.inkSoft} style={{ flexShrink: 0 }} />
        <span style={{ fontSize: "13px", color: COLORS.inkSoft, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{link}</span>
      </div>

      <label style={labelStyle}>
        {t("sharePanel.captionLabel")}
        {fetchingCaption && (
          <span style={{ marginLeft: "8px", fontWeight: 400, textTransform: "none", color: COLORS.mustardDark }}>{t("addForm.autoFetching")}</span>
        )}
      </label>
      {captionError && <div style={{ fontSize: "12px", color: COLORS.inkSoft, marginBottom: "6px" }}>{captionError}</div>}
      <textarea
        value={caption}
        onChange={(e) => setCaption(e.target.value)}
        placeholder={t("sharePanel.captionPlaceholder")}
        rows={4}
        style={{
          width: "100%",
          borderRadius: "8px",
          border: `1px solid ${COLORS.line}`,
          background: COLORS.panel,
          color: COLORS.ink,
          padding: "10px 12px",
          fontSize: "14px",
          outline: "none",
          boxSizing: "border-box",
          marginBottom: "16px",
          resize: "vertical",
        }}
      />

      <label style={labelStyle}>{t("addForm.categoryLabel")}</label>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginBottom: "16px" }}>
        {CATEGORIES.map((cat) => {
          const selected = category === cat;
          return (
            <button
              key={cat}
              type="button"
              onClick={() => setCategory(cat)}
              style={{
                padding: "10px 16px",
                borderRadius: "9999px",
                fontSize: "14px",
                fontWeight: 600,
                border: `1px solid ${selected ? COLORS.forest : COLORS.line}`,
                background: selected ? COLORS.forest : "transparent",
                color: selected ? "#F3EFE6" : COLORS.inkSoft,
                cursor: "pointer",
              }}
            >
              {categoryLabel(cat)}
            </button>
          );
        })}
      </div>

      {familyInfo.families.length > 0 && (
        <>
          <label style={labelStyle}>{t("sharePanel.saveToLabel")}</label>
          <div role="radiogroup" style={{ display: "flex", flexDirection: "column", gap: "6px", marginBottom: "16px" }}>
            {[{ id: PERSONAL_TARGET, name: t("sharePanel.saveToPersonal") }, ...familyInfo.families].map((option) => {
              const selected = target === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setTarget(option.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    width: "100%",
                    padding: "10px 12px",
                    borderRadius: "10px",
                    border: `1px solid ${selected ? COLORS.forest : COLORS.line}`,
                    background: COLORS.panel,
                    color: selected ? COLORS.forest : COLORS.ink,
                    fontSize: "14px",
                    fontWeight: selected ? 700 : 500,
                    textAlign: "left",
                    cursor: "pointer",
                  }}
                >
                  <span
                    style={{
                      width: "16px",
                      height: "16px",
                      borderRadius: "50%",
                      border: `2px solid ${selected ? COLORS.forest : COLORS.line}`,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                      boxSizing: "border-box",
                    }}
                  >
                    {selected && <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: COLORS.forest }} />}
                  </span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{option.name}</span>
                </button>
              );
            })}
          </div>
        </>
      )}
      {familyInfo.status === "loading" && expectFamilies && (
        <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: COLORS.inkSoft, marginBottom: "12px" }}>
          <Loader2 size={12} className="spin" /> {t("sharePanel.familiesLoading")}
        </div>
      )}
      {familyInfo.status === "error" && (
        <div style={{ fontSize: "12px", color: COLORS.inkSoft, marginBottom: "12px" }}>{t("sharePanel.familiesLoadFailed")}</div>
      )}

      {error && (
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: "8px",
            fontSize: "14px",
            padding: "10px 12px",
            borderRadius: "8px",
            background: "#F5E4E0",
            color: COLORS.danger,
            marginBottom: "12px",
          }}
        >
          <AlertCircle size={16} style={{ marginTop: "2px", flexShrink: 0 }} />
          <span>{error}</span>
        </div>
      )}

      <button
        onClick={handleSubmit}
        disabled={status === "sending"}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: "8px",
          padding: "16px",
          borderRadius: "12px",
          fontSize: "16px",
          fontWeight: 700,
          background: COLORS.mustard,
          color: COLORS.forestDark,
          border: "none",
          cursor: status === "sending" ? "default" : "pointer",
          opacity: status === "sending" ? 0.6 : 1,
        }}
      >
        {status === "sending" ? <Loader2 size={18} className="spin" /> : <Plus size={18} />}
        {status === "sending" ? t("sharePanel.sending") : t("sharePanel.addRecipe")}
      </button>

      <button
        onClick={openInApp}
        style={{ width: "100%", marginTop: "10px", padding: "10px", background: "transparent", border: "none", color: COLORS.inkSoft, fontSize: "13px", cursor: "pointer" }}
      >
        {t("sharePanel.openInAppHint")}
      </button>
    </div>
  );
}
