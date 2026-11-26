// QR pencerelerinin (okutma + paylaşma) ortak görünümü: açılış ekranındaki dokulu
// yeşil zemin, hardal vurgular, diğer pencerelerdeki gibi bulanık arka plan ve
// açılış/kapanış animasyonu. Renkler App.jsx COLORS ile aynı aileden.

export const QR_SHEET_IN_MS = 260;
export const QR_SHEET_EXIT_MS = 200;

export const QR_COLORS = {
  green: "#2C5537",
  greenDeep: "#1F3D29",
  mustard: "#C9911F",
  gold: "#E2BC66",
  paper: "#F3EFE6",
  paperSoft: "rgba(243,239,230,0.78)",
  // QR karesi: koyu yeşil modüller, açık hardal zemin. Okuyucular koyu modül /
  // açık zemin bekler (ters renkli kodu birçok tarayıcı okuyamaz); kontrast ~10:1.
  codeDark: "#1E3129",
  codeLight: "#F2DDA4",
};

// Açılış ekranındaki keten dokulu yeşil: ince çapraz iplik çizgileri + sol üstte
// hafif altın parıltı.
export const LINEN_BACKGROUND = {
  backgroundColor: QR_COLORS.green,
  backgroundImage: [
    "radial-gradient(120% 70% at 0% 0%, rgba(226,188,102,0.26), rgba(226,188,102,0) 48%)",
    "repeating-linear-gradient(0deg, rgba(255,255,255,0.035) 0px, rgba(255,255,255,0.035) 1px, rgba(255,255,255,0) 1px, rgba(255,255,255,0) 3px)",
    "repeating-linear-gradient(90deg, rgba(0,0,0,0.07) 0px, rgba(0,0,0,0.07) 1px, rgba(0,0,0,0) 1px, rgba(0,0,0,0) 3px)",
    `linear-gradient(180deg, ${QR_COLORS.green}, ${QR_COLORS.greenDeep})`,
  ].join(", "),
};

export const QR_SHEET_CSS = `
  @keyframes qrBackdropIn { from { opacity: 0; } to { opacity: 1; } }
  @keyframes qrBackdropOut { from { opacity: 1; } to { opacity: 0; } }
  @keyframes qrCardIn { from { opacity: 0; transform: translateY(32px) scale(0.96); } to { opacity: 1; transform: translateY(0) scale(1); } }
  @keyframes qrCardOut { from { opacity: 1; transform: translateY(0) scale(1); } to { opacity: 0; transform: translateY(32px) scale(0.96); } }
  .qr-backdrop { animation: qrBackdropIn ${QR_SHEET_IN_MS}ms ease-out both; }
  .qr-card { animation: qrCardIn ${QR_SHEET_IN_MS}ms cubic-bezier(0.22, 0.8, 0.24, 1) both; }
  .qr-root.is-closing .qr-backdrop { animation: qrBackdropOut ${QR_SHEET_EXIT_MS}ms ease-in both; }
  .qr-root.is-closing .qr-card { animation: qrCardOut ${QR_SHEET_EXIT_MS}ms ease-in both; }
  .qr-root button:focus-visible { outline: 2px solid ${QR_COLORS.gold}; outline-offset: 2px; }
  @media (prefers-reduced-motion: reduce) {
    .qr-backdrop, .qr-card, .qr-root.is-closing .qr-backdrop, .qr-root.is-closing .qr-card { animation: none !important; }
  }
`;

export const QR_STYLES = {
  root: { position: "fixed", inset: 0, zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, boxSizing: "border-box" },
  backdrop: { position: "absolute", inset: 0, background: "rgba(42,38,32,0.5)", backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)" },
  card: {
    ...LINEN_BACKGROUND,
    position: "relative",
    width: "100%",
    maxWidth: 400,
    maxHeight: "100%",
    overflowY: "auto",
    boxSizing: "border-box",
    borderRadius: 24,
    padding: 18,
    color: QR_COLORS.paper,
    boxShadow: "0 18px 50px rgba(0,0,0,0.38), inset 0 0 0 1px rgba(226,188,102,0.22)",
    display: "flex",
    flexDirection: "column",
    gap: 14,
  },
  header: { display: "flex", alignItems: "center", gap: 10 },
  title: { margin: 0, flex: 1, minWidth: 0, fontFamily: "Charter, 'Iowan Old Style', Georgia, 'Times New Roman', serif", fontSize: 20, fontWeight: 600, color: QR_COLORS.paper, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  closeBtn: { border: "none", background: "rgba(243,239,230,0.14)", color: QR_COLORS.paper, borderRadius: 999, width: 38, height: 38, flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer" },
  // Hardal halkalı ana düğme (koyu zeminde okunur: krem yazı, hardal çerçeve).
  goldBtn: { border: `2px solid ${QR_COLORS.mustard}`, background: "rgba(201,145,31,0.16)", color: QR_COLORS.paper, borderRadius: 14, minHeight: 48, padding: "0 16px", fontSize: 15, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, cursor: "pointer" },
  solidGoldBtn: { border: "none", background: QR_COLORS.mustard, color: "#2A2620", borderRadius: 14, minHeight: 48, padding: "0 16px", fontSize: 15, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, cursor: "pointer" },
  quietBtn: { border: "1px solid rgba(243,239,230,0.28)", background: "transparent", color: QR_COLORS.paperSoft, borderRadius: 14, minHeight: 44, padding: "0 14px", fontSize: 14, fontWeight: 600, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, cursor: "pointer" },
  note: { margin: 0, fontSize: 14, lineHeight: 1.45, padding: "10px 12px", borderRadius: 12, background: "rgba(201,145,31,0.2)", color: QR_COLORS.paper, border: "1px solid rgba(226,188,102,0.35)" },
  error: { margin: 0, fontSize: 14, lineHeight: 1.45, padding: "10px 12px", borderRadius: 12, background: "rgba(162,59,46,0.32)", color: "#FBE9E5", border: "1px solid rgba(251,233,229,0.25)" },
  // QR karesinin çevresi: hardal çerçeveli açık zemin.
  codeTile: { alignSelf: "center", background: QR_COLORS.codeLight, padding: 12, borderRadius: 20, border: `3px solid ${QR_COLORS.mustard}`, boxShadow: "0 10px 28px rgba(0,0,0,0.3)" },
};
