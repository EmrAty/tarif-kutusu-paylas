import React, { useState, useEffect, useCallback } from "react";
import {
  ChefHat, Plus, Minus, Link2, ExternalLink, Trash2, Loader2, ArrowLeft, AlertCircle,
  FileText, Pencil, Check, ChevronDown, Star, Search, ShoppingCart, Clock, Gauge, Undo2, X, Package, Download,
} from "lucide-react";

const COLORS = {
  paper: "#F3EFE6",
  panel: "#FFFFFF",
  ink: "#2A2620",
  inkSoft: "#5C564A",
  forest: "#2F4A3D",
  forestDark: "#1E3129",
  mustard: "#C9911F",
  mustardDark: "#9C6F14",
  line: "#D8D0BE",
  danger: "#A23B2E",
};

const SERIF = "Charter, 'Iowan Old Style', 'Georgia', 'Times New Roman', serif";
const BODY = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const LABELSANS = "'Helvetica Neue Condensed', 'Arial Narrow', Arial, sans-serif";
const CARD_SHADOW = "0 1px 2px rgba(42,38,32,0.05), 0 8px 24px rgba(42,38,32,0.06)";

const CATEGORIES = ["Kahvaltı", "Öğle Yemeği ve Akşam Yemeği", "Soslar", "Atıştırmalıklar", "Tatlılar"];

const LEGACY_CATEGORY_MAP = {
  "Öğle Yemeği": "Öğle Yemeği ve Akşam Yemeği",
  "Akşam Yemeği": "Öğle Yemeği ve Akşam Yemeği",
  "Atıştırmalık & Soslar": "Atıştırmalıklar",
};

function uid() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const STORAGE_PREFIX = "tarif-kutusu:";

function storageGet(key) {
  try {
    const value = window.localStorage.getItem(STORAGE_PREFIX + key);
    return value === null ? null : { value };
  } catch (e) {
    return null;
  }
}

function storageSet(key, value) {
  window.localStorage.setItem(STORAGE_PREFIX + key, value);
}

// recipes / shopping-list / pantry-items ailenin tamamı arasında paylaşılır
// (sunucudaki ortak veritabanına gider); person-name ise yukarıdaki gibi
// sadece bu cihaza özel kalır.
async function sharedGet(key) {
  try {
    const res = await fetch("/api/store?key=" + encodeURIComponent(key));
    if (!res.ok) return null;
    const data = await res.json();
    return data.value == null ? null : { value: data.value };
  } catch (e) {
    return null;
  }
}

async function sharedSet(key, value) {
  await fetch("/api/store", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value }),
  });
}


async function extractRecipe({ link, caption, notes, images }) {
  const system = `Sen bir yemek tarifi çıkarma asistanısın. Sana bir sosyal medya (TikTok/YouTube) yemek videosuna dair bilgi verilecek — bu, videonun tam açıklama/altyazı metni olabilir, kullanıcının videoyu izlerken gördüğü malzemeler hakkında yazdığı kısa bir not olabilir, ve/veya videodan alınmış ekran görüntüleri olabilir (görüntülerde video açıklaması, altyazı, ya da ekranda görünen malzeme/tarif yazıları olabilir — görsellerdeki TÜM metni dikkatlice oku). Hangisi verilirse verilsin, bundan yapılandırılmış tarif bilgisi çıkar.

SADECE ve SADECE aşağıdaki şemaya uyan HAM JSON döndür. Markdown yok, açıklama yok, backtick yok, başka hiçbir metin yok:

{
  "title": string,
  "servings": number,
  "prep_time_minutes": number,
  "difficulty": string, // "Kolay", "Orta" veya "Zor" değerlerinden biri
  "ingredients": [ { "name": string, "amount": string } ],
  "instructions": [ string ],
  "nutrition": {
    "calories": number,
    "protein_g": number,
    "carbs_g": number,
    "fat_g": number
  },
  "assumptions": string
}

Nutrition alanındaki değerler porsiyon başına DEĞİL, tarifteki TÜM malzemelerin toplamı olsun (tarifin bütünü için toplam kalori, protein, karbonhidrat, yağ).

Eğer sana verilen metin/görsellerde malzemeler açıkça ve eksiksiz yazılı DEĞİLSE ve sen bu yemeğin genel bilgine dayanarak malzemelerin bir kısmını ya da tamamını kendin tahmin ettiysen, bunu "assumptions" alanında AÇIKÇA belirt (örn: "Malzemelerin bir kısmı bu yemeğin tipik tarifine göre tarafımca tamamlandı."). Malzemeler zaten eksiksiz yazılıysa bunu belirtmene gerek yok.

Miktarlar net değilse o yemeğin tipik bir porsiyonuna göre makul tahminler yap ve bunu "assumptions" alanında belirt. Yapılış adımları verilmemişse "instructions" alanını boş dizi olarak döndür, uydurma. "prep_time_minutes" ve "difficulty" belirtilmemişse tarifin niteliğine göre makul bir tahmin yap. Tüm metinler Türkçe olsun.`;

  const textSection = `Video linki: ${link || "(verilmedi)"}

${caption.trim() ? `Video açıklaması / altyazısı:\n"""\n${caption}\n"""` : "(Video açıklaması verilmedi.)"}

${notes.trim() ? `Kullanıcının notu: ${notes}` : ""}

${images && images.length > 0 ? `(Ayrıca ${images.length} adet ekran görüntüsü ekte, içindeki tüm yazıları oku.)` : ""}`;

  const contentBlocks = [];
  (images || []).forEach((img) => {
    contentBlocks.push({
      type: "image",
      source: { type: "base64", media_type: img.mediaType, data: img.base64 },
    });
  });
  contentBlocks.push({ type: "text", text: textSection });

  // Tarayıcıdan doğrudan api.anthropic.com'a anahtarsız istek atılamaz (401 döner
  // ve bir API anahtarını istemci koduna gömmek güvensizdir). Bu yüzden istek kendi
  // barındırdığımız /api/extract proxy'sine gidiyor; o, anahtarı sunucu tarafında
  // tutup Anthropic API'yi bizim adımıza çağırıyor.
  const endpoint = import.meta.env.VITE_EXTRACT_API_URL || "/api/extract";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system,
      messages: [{ role: "user", content: contentBlocks }],
    }),
  });

  if (!response.ok) throw new Error("API isteği başarısız oldu");
  const data = await response.json();
  const text = (data.content || [])
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();
  const clean = text.replace(/^```json\s*|^```\s*|```$/g, "").trim();
  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch (e) {
    throw new Error("Tarif ayrıştırılamadı, lütfen açıklama metnini kontrol edip tekrar dene.");
  }
  return parsed;
}

export default function TarifKutusu() {
  const [recipes, setRecipes] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState("list");
  const [activeId, setActiveId] = useState(null);
  const [link, setLink] = useState("");
  const [caption, setCaption] = useState("");
  const [notes, setNotes] = useState("");
  const [images, setImages] = useState([]);
  const [category, setCategory] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [undoState, setUndoState] = useState(null); // { recipe, index }
  const undoTimerRef = React.useRef(null);
  const [personName, setPersonName] = useState("");
  const [nameLoaded, setNameLoaded] = useState(false);
  const [nameDraft, setNameDraft] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = storageGet("person-name");
        if (!cancelled && res && res.value) setPersonName(res.value);
      } catch (e) {
        // henüz isim girilmemiş
      } finally {
        if (!cancelled) setNameLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSaveName = async () => {
    const trimmed = nameDraft.trim();
    if (!trimmed) return;
    setPersonName(trimmed);
    try {
      storageSet("person-name", trimmed);
    } catch (e) {
      // yazma başarısız olsa da yerel görünüm güncel kalsın
    }
  };

  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const sharedLink = params.get("link");
      if (sharedLink && sharedLink.trim()) {
        setLink(sharedLink.trim());
        setView("add");
      }
    } catch (e) {
      // URL okunamazsa sessizce geç
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await sharedGet("recipes");
        if (!cancelled && res && res.value) {
          const parsed = JSON.parse(res.value);
          let migrated = false;
          const next = parsed.map((r) => {
            if (r.category && LEGACY_CATEGORY_MAP[r.category]) {
              migrated = true;
              return { ...r, category: LEGACY_CATEGORY_MAP[r.category] };
            }
            return r;
          });
          setRecipes(next);
          if (migrated) {
            try {
              await sharedSet("recipes", JSON.stringify(next));
            } catch (e) {
              // geçiş kaydedilemese de mevcut oturumda güncel görünüm kalsın
            }
          }
        }
      } catch (e) {
        // henüz kayıtlı tarif yok
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = useCallback(async (updated) => {
    setRecipes(updated);
    try {
      await sharedSet("recipes", JSON.stringify(updated));
    } catch (e) {
      // yazma başarısız olsa da yerel görünüm güncel kalsın
    }
  }, []);

  const handleExtract = async () => {
    setError("");
    if (!caption.trim() && !notes.trim() && images.length === 0) {
      setError("Açıklamayı yapıştıramıyorsan sorun değil — en azından bir ekran görüntüsü yükle ya da birkaç kelime not yaz.");
      return;
    }
    if (!category) {
      setError("Yemeğin hangi kategoriye ait olduğunu seçmen lazım.");
      return;
    }
    setBusy(true);
    try {
      const parsed = await extractRecipe({ link, caption, notes, images });
      const recipe = {
        id: uid(),
        createdAt: Date.now(),
        link: link.trim(),
        category,
        isFavorite: false,
        addedBy: personName || "",
        ...parsed,
      };
      const updated = [recipe, ...recipes];
      await persist(updated);
      setLink("");
      setCaption("");
      setNotes("");
      setImages([]);
      setCategory("");
      setActiveId(recipe.id);
      setView("detail");
    } catch (e) {
      setError(e.message || "Bir şeyler ters gitti, tekrar dener misin?");
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (id) => {
    const index = recipes.findIndex((r) => r.id === id);
    if (index === -1) return;
    const removed = recipes[index];
    const updated = recipes.filter((r) => r.id !== id);
    await persist(updated);
    setView("list");

    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    setUndoState({ recipe: removed, index });
    undoTimerRef.current = setTimeout(() => setUndoState(null), 6000);
  };

  const handleUndoDelete = async () => {
    if (!undoState) return;
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    const restored = [...recipes];
    restored.splice(undoState.index, 0, undoState.recipe);
    await persist(restored);
    setUndoState(null);
  };

  const handleRename = async (id, newTitle) => {
    const trimmed = newTitle.trim();
    if (!trimmed) return;
    const updated = recipes.map((r) => (r.id === id ? { ...r, title: trimmed } : r));
    await persist(updated);
  };

  const handleToggleFavorite = async (id) => {
    const updated = recipes.map((r) => (r.id === id ? { ...r, isFavorite: !r.isFavorite } : r));
    await persist(updated);
  };

  const handleChangeCategory = async (id, newCategory) => {
    const updated = recipes.map((r) => (r.id === id ? { ...r, category: newCategory } : r));
    await persist(updated);
  };

  const handleManualSave = async (data) => {
    const recipe = { id: uid(), createdAt: Date.now(), isFavorite: false, addedBy: personName || "", ...data };
    const updated = [recipe, ...recipes];
    await persist(updated);
    setActiveId(recipe.id);
    setView("detail");
  };

  const handleEditSave = async (id, data) => {
    const updated = recipes.map((r) => (r.id === id ? { ...r, ...data } : r));
    await persist(updated);
    setView("detail");
  };

  const active = recipes.find((r) => r.id === activeId);

  return (
    <div
      style={{
        width: "100%",
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        background: COLORS.paper,
        color: COLORS.ink,
        fontFamily: BODY,
      }}
    >
      <Header view={view} onBack={() => setView("list")} />

      <div
        style={{
          flex: 1,
          width: "100%",
          maxWidth: "1100px",
          margin: "0 auto",
          padding: "24px 16px",
          display: "flex",
          flexDirection: "column",
          gap: "24px",
        }}
        className="md-row"
      >
        <style>{`
          @media (min-width: 768px) {
            .md-row { flex-direction: row !important; align-items: flex-start; }
            .md-sidebar { width: 260px !important; flex-shrink: 0; }
            .md-detail-row { flex-direction: row !important; }
            .md-nutrition { width: 220px !important; flex-shrink: 0; }
          }
        `}</style>

        <div className="md-sidebar" style={{ width: "100%" }}>
          <Sidebar
            recipes={recipes}
            loaded={loaded}
            activeId={activeId}
            onSelect={(id) => {
              setActiveId(id);
              setView("detail");
            }}
            onAdd={() => {
              setError("");
              setView((v) => (v === "add" ? "list" : "add"));
            }}
            onManual={() => setView((v) => (v === "manual" ? "list" : "manual"))}
            onPantry={() => setView((v) => (v === "pantry" ? "list" : "pantry"))}
            onShopping={() => setView((v) => (v === "shopping" ? "list" : "shopping"))}
            onToggleFavorite={handleToggleFavorite}
            onDelete={handleDelete}
          />
        </div>

        <main style={{ minWidth: 0, flex: 1 }}>
          {view === "list" && <EmptyState onAdd={() => setView("add")} />}

          {view === "add" && (
            <AddForm
              link={link}
              caption={caption}
              notes={notes}
              images={images}
              category={category}
              busy={busy}
              error={error}
              setLink={setLink}
              setCaption={setCaption}
              setNotes={setNotes}
              setImages={setImages}
              setCategory={setCategory}
              onSubmit={handleExtract}
              onCancel={() => setView("list")}
            />
          )}

          {view === "manual" && (
            <RecipeEditor heading="Yeni Tarif Oluştur" initial={null} onSave={handleManualSave} onCancel={() => setView("list")} />
          )}

          {view === "edit" && active && (
            <RecipeEditor
              heading="Tarifi Düzenle"
              initial={active}
              onSave={(data) => handleEditSave(active.id, data)}
              onCancel={() => setView("detail")}
            />
          )}

          {view === "detail" && active && (
            <RecipeDetail
              recipe={active}
              onDelete={() => handleDelete(active.id)}
              onRename={(newTitle) => handleRename(active.id, newTitle)}
              onToggleFavorite={() => handleToggleFavorite(active.id)}
              onChangeCategory={(cat) => handleChangeCategory(active.id, cat)}
              onEdit={() => setView("edit")}
            />
          )}

          {view === "shopping" && <ShoppingList recipes={recipes} />}

          {view === "pantry" && (
            <PantryFinder
              recipes={recipes}
              onSelectRecipe={(id) => {
                setActiveId(id);
                setView("detail");
              }}
            />
          )}
        </main>
      </div>

      {nameLoaded && !personName && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(42,38,32,0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 60,
            padding: "20px",
          }}
        >
          <div
            style={{
              background: COLORS.panel,
              borderRadius: "14px",
              padding: "28px",
              maxWidth: "340px",
              width: "100%",
              boxShadow: CARD_SHADOW,
              textAlign: "center",
            }}
          >
            <h2 style={{ fontFamily: SERIF, fontSize: "20px", color: COLORS.ink, margin: "0 0 8px" }}>
              Merhaba!
            </h2>
            <p style={{ fontSize: "14px", color: COLORS.inkSoft, margin: "0 0 20px" }}>
              Ailenle paylaştığın bu Tarif Kutusu'nda eklediğin tarifler senin isminle görünsün.
              Bu, sadece bu cihazda bir kere sorulur.
            </p>
            <input
              type="text"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSaveName();
              }}
              placeholder="Adın"
              autoFocus
              style={{
                width: "100%",
                borderRadius: "8px",
                border: `1px solid ${COLORS.line}`,
                background: COLORS.paper,
                color: COLORS.ink,
                padding: "10px 12px",
                fontSize: "14px",
                outline: "none",
                boxSizing: "border-box",
                marginBottom: "16px",
                textAlign: "center",
              }}
            />
            <button
              onClick={handleSaveName}
              disabled={!nameDraft.trim()}
              style={{
                width: "100%",
                padding: "10px 16px",
                borderRadius: "8px",
                fontSize: "14px",
                fontWeight: 600,
                background: COLORS.mustard,
                color: COLORS.forestDark,
                border: "none",
                cursor: nameDraft.trim() ? "pointer" : "default",
                opacity: nameDraft.trim() ? 1 : 0.5,
              }}
            >
              Devam Et
            </button>
          </div>
        </div>
      )}

      {undoState && (
        <div
          style={{
            position: "fixed",
            left: "50%",
            bottom: "20px",
            transform: "translateX(-50%)",
            display: "flex",
            alignItems: "center",
            gap: "12px",
            background: COLORS.forestDark,
            color: "#F3EFE6",
            padding: "12px 16px",
            borderRadius: "10px",
            boxShadow: "0 6px 20px rgba(0,0,0,0.25)",
            zIndex: 50,
            fontSize: "14px",
          }}
        >
          <span>"{undoState.recipe.title || "İsimsiz tarif"}" silindi.</span>
          <button
            onClick={handleUndoDelete}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "6px",
              background: COLORS.mustard,
              color: COLORS.forestDark,
              border: "none",
              borderRadius: "8px",
              padding: "6px 10px",
              fontSize: "13px",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            <Undo2 size={14} />
            Geri Al
          </button>
          <button
            onClick={() => setUndoState(null)}
            aria-label="Kapat"
            style={{ background: "transparent", border: "none", color: "#C9C2AE", cursor: "pointer", padding: "4px" }}
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

function Header({ view, onBack }) {
  return (
    <header style={{ width: "100%", background: COLORS.forest }}>
      <div
        style={{
          maxWidth: "1100px",
          margin: "0 auto",
          padding: "20px 16px 18px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
          {view !== "list" ? (
            <button
              onClick={onBack}
              aria-label="Listeye dön"
              style={{
                padding: "8px",
                borderRadius: "9999px",
                background: "transparent",
                border: "none",
                cursor: "pointer",
              }}
            >
              <ArrowLeft size={18} color="#F3EFE6" />
            </button>
          ) : (
            <div style={{ padding: "9px", borderRadius: "9999px", background: COLORS.mustard }}>
              <ChefHat size={17} color={COLORS.forestDark} />
            </div>
          )}
          <div>
            <h1
              style={{
                fontFamily: SERIF,
                fontWeight: 400,
                color: "#F8F5EC",
                fontSize: "25px",
                letterSpacing: "0.015em",
                lineHeight: 1,
                margin: 0,
              }}
            >
              Tarif Kutusu
            </h1>
            <p
              style={{
                fontFamily: SERIF,
                fontStyle: "italic",
                fontSize: "13px",
                color: COLORS.mustard,
                margin: "5px 0 0",
                letterSpacing: "0.01em",
              }}
            >
              Videoyu kaydetme, tarifini çıkar
            </p>
          </div>
        </div>
      </div>
      <div style={{ height: "3px", background: `linear-gradient(90deg, ${COLORS.mustard}, ${COLORS.mustard} 60%, transparent)` }} />
    </header>
  );
}

function Sidebar({ recipes, loaded, activeId, onSelect, onAdd, onManual, onPantry, onShopping, onToggleFavorite, onDelete }) {
  const [listOpen, setListOpen] = useState(true);
  const [openCats, setOpenCats] = useState({});
  const [favOpen, setFavOpen] = useState(false);
  const [query, setQuery] = useState("");

  const toggleCat = (cat) => {
    setOpenCats((prev) => ({ ...prev, [cat]: !prev[cat] }));
  };

  const isSearching = query.trim().length > 0;
  const q = query.trim().toLocaleLowerCase("tr");
  const matches = (r) => (r.title || "").toLocaleLowerCase("tr").includes(q);

  const byCategory = (cat) => recipes.filter((r) => (r.category || "Diğer") === cat && (!isSearching || matches(r)));
  const favorites = recipes.filter((r) => r.isFavorite && (!isSearching || matches(r)));
  const uncategorized = recipes.filter((r) => !CATEGORIES.includes(r.category) && (!isSearching || matches(r)));
  const listExpanded = isSearching ? true : listOpen;

  const renderRecipeButton = (r) => {
    const isActive = activeId === r.id;
    return (
      <div
        key={r.id}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "4px",
          borderRadius: "6px",
          border: `1px solid ${isActive ? COLORS.forest : "transparent"}`,
          background: isActive ? COLORS.forest : "transparent",
        }}
      >
        <button
          onClick={() => onSelect(r.id)}
          style={{
            flex: 1,
            minWidth: 0,
            textAlign: "left",
            padding: "10px 4px 10px 10px",
            background: "transparent",
            border: "none",
            color: isActive ? "#F3EFE6" : COLORS.ink,
            cursor: "pointer",
          }}
        >
          <div style={{ fontSize: "13px", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {r.title || "İsimsiz tarif"}
          </div>
          <div style={{ fontSize: "11px", marginTop: "2px", color: isActive ? "#C9C2AE" : COLORS.inkSoft }}>
            {r.addedBy ? `${r.addedBy} · ` : ""}
            {new Date(r.createdAt).toLocaleDateString("tr-TR")}
          </div>
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleFavorite(r.id);
          }}
          aria-label="Favori"
          style={{ padding: "8px", background: "transparent", border: "none", cursor: "pointer", flexShrink: 0 }}
        >
          <Star
            size={15}
            color={r.isFavorite ? COLORS.mustard : isActive ? "#C9C2AE" : COLORS.inkSoft}
            fill={r.isFavorite ? COLORS.mustard : "none"}
          />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete(r.id);
          }}
          aria-label="Tarifi sil"
          style={{ padding: "8px", background: "transparent", border: "none", cursor: "pointer", flexShrink: 0 }}
        >
          <Trash2 size={14} color={isActive ? "#C9C2AE" : COLORS.inkSoft} />
        </button>
      </div>
    );
  };

  return (
    <aside>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          borderRadius: "8px",
          border: `1px solid ${COLORS.line}`,
          background: COLORS.panel,
          padding: "8px 10px",
          marginTop: "16px",
        }}
      >
        <Search size={14} color={COLORS.inkSoft} />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Tarif ara…"
          style={{ flex: 1, minWidth: 0, background: "transparent", border: "none", outline: "none", fontSize: "13px", color: COLORS.ink }}
        />
        {query && (
          <button
            onClick={() => setQuery("")}
            aria-label="Aramayı temizle"
            style={{ background: "transparent", border: "none", cursor: "pointer", color: COLORS.inkSoft, padding: "2px" }}
          >
            <X size={13} />
          </button>
        )}
      </div>

      <div style={{ marginTop: "20px", paddingBottom: "10px", borderBottom: `2px solid ${COLORS.forest}` }}>
        <button
          onClick={() => setListOpen((o) => !o)}
          aria-expanded={listExpanded}
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: "transparent",
            border: "none",
            cursor: "pointer",
            padding: "4px 4px",
          }}
        >
          <span
            style={{
              fontFamily: SERIF,
              fontSize: "20px",
              color: COLORS.ink,
            }}
          >
            Yemekler {recipes.length > 0 ? <span style={{ color: COLORS.inkSoft, fontSize: "15px" }}>({recipes.length})</span> : ""}
          </span>
          <span
            style={{
              width: "26px",
              height: "26px",
              borderRadius: "9999px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: COLORS.forest,
              color: "#F3EFE6",
              flexShrink: 0,
            }}
          >
            {listExpanded ? <Minus size={15} strokeWidth={3} /> : <Plus size={15} strokeWidth={3} />}
          </span>
        </button>

        <div style={{ display: "grid", gridTemplateRows: listExpanded ? "1fr" : "0fr", transition: "grid-template-rows 300ms ease" }}>
          <div style={{ overflow: "hidden" }}>
            {!loaded && <div style={{ fontSize: "14px", color: COLORS.inkSoft, padding: "0 4px 8px" }}>Yükleniyor…</div>}

            {loaded && recipes.length === 0 && (
              <div
                style={{
                  fontSize: "14px",
                  color: COLORS.inkSoft,
                  padding: "12px",
                  borderRadius: "8px",
                  border: `1px dashed ${COLORS.line}`,
                  marginBottom: "2px",
                }}
              >
                Henüz tarif yok. İlk tarifini eklemek için yukarıdaki butona bas.
              </div>
            )}

            {loaded && recipes.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: "6px", padding: "2px 2px 4px" }}>
                {recipes.some((r) => r.isFavorite) && (
                  <div style={{ borderRadius: "8px", border: `1px solid ${COLORS.line}`, overflow: "hidden" }}>
                    <button
                      onClick={() => setFavOpen((o) => !o)}
                      aria-expanded={isSearching ? true : favOpen}
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "10px 12px",
                        background: COLORS.panel,
                        border: "none",
                        cursor: "pointer",
                        textAlign: "left",
                      }}
                    >
                      <span style={{ fontSize: "13px", fontWeight: 600, color: COLORS.ink, display: "flex", alignItems: "center", gap: "6px" }}>
                        <Star size={13} color={COLORS.mustard} fill={COLORS.mustard} />
                        Favoriler <span style={{ fontWeight: 400, color: COLORS.inkSoft }}>({favorites.length})</span>
                      </span>
                      <ChevronDown
                        size={15}
                        style={{
                          color: COLORS.inkSoft,
                          flexShrink: 0,
                          transform: (isSearching ? true : favOpen) ? "rotate(180deg)" : "rotate(0deg)",
                          transition: "transform 250ms ease",
                        }}
                      />
                    </button>
                    <div
                      style={{
                        display: "grid",
                        gridTemplateRows: (isSearching ? true : favOpen) ? "1fr" : "0fr",
                        transition: "grid-template-rows 280ms ease",
                      }}
                    >
                      <div style={{ overflow: "hidden" }}>
                        <div style={{ display: "flex", flexDirection: "column", gap: "4px", padding: "0 6px 8px" }}>
                          {favorites.length === 0 ? (
                            <div style={{ fontSize: "12px", color: COLORS.inkSoft, padding: "0 6px 8px" }}>Sonuç yok.</div>
                          ) : (
                            favorites.map(renderRecipeButton)
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {CATEGORIES.map((cat) => {
                  const items = byCategory(cat);
                  if (isSearching && items.length === 0) return null;
                  const catOpen = isSearching ? true : !!openCats[cat];
                  return (
                    <div key={cat} style={{ borderRadius: "8px", border: `1px solid ${COLORS.line}`, overflow: "hidden" }}>
                      <button
                        onClick={() => toggleCat(cat)}
                        aria-expanded={catOpen}
                        style={{
                          width: "100%",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          padding: "10px 12px",
                          background: COLORS.panel,
                          border: "none",
                          cursor: "pointer",
                          textAlign: "left",
                        }}
                      >
                        <span style={{ fontSize: "13px", fontWeight: 600, color: COLORS.ink }}>
                          {cat} <span style={{ fontWeight: 400, color: COLORS.inkSoft }}>({items.length})</span>
                        </span>
                        <ChevronDown
                          size={15}
                          style={{
                            color: COLORS.inkSoft,
                            flexShrink: 0,
                            transform: catOpen ? "rotate(180deg)" : "rotate(0deg)",
                            transition: "transform 250ms ease",
                          }}
                        />
                      </button>

                      <div style={{ display: "grid", gridTemplateRows: catOpen ? "1fr" : "0fr", transition: "grid-template-rows 280ms ease" }}>
                        <div style={{ overflow: "hidden" }}>
                          {items.length === 0 ? (
                            <div style={{ fontSize: "12px", color: COLORS.inkSoft, padding: "0 12px 10px" }}>
                              {isSearching ? "Sonuç yok." : "Bu kategoride henüz tarif yok."}
                            </div>
                          ) : (
                            <div style={{ display: "flex", flexDirection: "column", gap: "4px", padding: "0 6px 8px" }}>
                              {items.map(renderRecipeButton)}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}

                {uncategorized.length > 0 && (!isSearching || uncategorized.length > 0) && (
                  <div style={{ borderRadius: "8px", border: `1px dashed ${COLORS.danger}`, overflow: "hidden" }}>
                    <button
                      onClick={() => toggleCat("__uncategorized")}
                      aria-expanded={isSearching ? true : !!openCats.__uncategorized}
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "10px 12px",
                        background: COLORS.panel,
                        border: "none",
                        cursor: "pointer",
                        textAlign: "left",
                      }}
                    >
                      <span style={{ fontSize: "13px", fontWeight: 600, color: COLORS.danger }}>
                        Diğer (kategorisiz) <span style={{ fontWeight: 400, color: COLORS.inkSoft }}>({uncategorized.length})</span>
                      </span>
                      <ChevronDown
                        size={15}
                        style={{
                          color: COLORS.inkSoft,
                          flexShrink: 0,
                          transform: (isSearching ? true : !!openCats.__uncategorized) ? "rotate(180deg)" : "rotate(0deg)",
                          transition: "transform 250ms ease",
                        }}
                      />
                    </button>
                    <div
                      style={{
                        display: "grid",
                        gridTemplateRows: (isSearching ? true : !!openCats.__uncategorized) ? "1fr" : "0fr",
                        transition: "grid-template-rows 280ms ease",
                      }}
                    >
                      <div style={{ overflow: "hidden" }}>
                        <div style={{ fontSize: "11px", color: COLORS.inkSoft, padding: "0 12px 6px" }}>
                          Kategori seçiminden önce eklendiler — açıp kategori atayabilirsin.
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: "4px", padding: "0 6px 8px" }}>
                          {uncategorized.map(renderRecipeButton)}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>


      <button
        onClick={onAdd}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: "8px",
          padding: "12px 16px",
          borderRadius: "8px",
          fontSize: "14px",
          fontWeight: 600,
          background: COLORS.mustard,
          color: COLORS.forestDark,
          border: "none",
          cursor: "pointer",
          marginTop: "24px",
        }}
      >
        <Plus size={16} strokeWidth={2.5} />
        Yeni Tarif Çıkar
      </button>

      <button
        onClick={onManual}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: "8px",
          padding: "10px 16px",
          borderRadius: "8px",
          fontSize: "14px",
          fontWeight: 600,
          background: COLORS.panel,
          color: COLORS.ink,
          border: `1px solid ${COLORS.line}`,
          cursor: "pointer",
          marginTop: "8px",
        }}
      >
        <Pencil size={15} />
        Tarifi Kendin Oluştur
      </button>

      <button
        onClick={onShopping}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: "8px",
          padding: "10px 16px",
          borderRadius: "8px",
          fontSize: "14px",
          fontWeight: 600,
          background: COLORS.panel,
          color: COLORS.forest,
          border: `1px solid ${COLORS.forest}`,
          cursor: "pointer",
          marginTop: "8px",
        }}
      >
        <ShoppingCart size={16} />
        Alışveriş Listesi
      </button>

      <button
        onClick={onPantry}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: "8px",
          padding: "10px 16px",
          borderRadius: "8px",
          fontSize: "14px",
          fontWeight: 600,
          background: COLORS.panel,
          color: COLORS.mustardDark,
          border: `1px solid ${COLORS.mustard}`,
          cursor: "pointer",
          marginTop: "8px",
        }}
      >
        <Package size={16} />
        Elimde Bunlar Var
      </button>

    </aside>
  );
}

function EmptyState({ onAdd }) {
  return (
    <div
      style={{
        minHeight: "320px",
        borderRadius: "10px",
        border: `1px dashed ${COLORS.line}`,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        padding: "64px 24px",
      }}
    >
      <div style={{ padding: "12px", borderRadius: "9999px", background: "#EAE3D2", marginBottom: "16px" }}>
        <FileText size={22} color={COLORS.forest} />
      </div>
      <h2 style={{ fontFamily: SERIF, fontSize: "18px", color: COLORS.ink, margin: "0 0 4px" }}>Kutun henüz boş</h2>
      <p style={{ fontSize: "14px", color: COLORS.inkSoft, maxWidth: "360px", margin: "0 0 20px" }}>
        Beğendiğin bir tarif videosunun linkini ve açıklama metnini yapıştır, malzemeleri ve besin
        değerlerini senin yerine ben çıkarayım.
      </p>
      <button
        onClick={onAdd}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          padding: "10px 16px",
          borderRadius: "8px",
          fontSize: "14px",
          fontWeight: 600,
          background: COLORS.forest,
          color: "#F3EFE6",
          border: "none",
          cursor: "pointer",
        }}
      >
        <Plus size={16} strokeWidth={2.5} />
        Tarif Ekle
      </button>
    </div>
  );
}

function AddForm({ link, caption, notes, images, category, busy, error, setLink, setCaption, setNotes, setImages, setCategory, onSubmit, onCancel }) {
  const [fetchingCaption, setFetchingCaption] = useState(false);
  const [captionFetchError, setCaptionFetchError] = useState("");
  const fetchedForLinkRef = React.useRef("");

  const tryAutoFetchCaption = useCallback(async (rawLink) => {
    const trimmed = (rawLink || "").trim();
    if (!trimmed || !/^https?:\/\//i.test(trimmed) || !/tiktok\.com|youtu\.be|youtube\.com/i.test(trimmed)) return;
    if (fetchedForLinkRef.current === trimmed) return;
    fetchedForLinkRef.current = trimmed;
    setFetchingCaption(true);
    setCaptionFetchError("");
    try {
      const res = await fetch("/api/fetch-caption?url=" + encodeURIComponent(trimmed));
      const data = await res.json();
      if (res.ok && data.caption) {
        setCaption((prev) => (prev && prev.trim() ? prev : data.caption));
      } else if (!res.ok) {
        setCaptionFetchError("Açıklama otomatik alınamadı, elle yapıştırabilirsin.");
      }
    } catch (e) {
      setCaptionFetchError("Açıklama otomatik alınamadı, elle yapıştırabilirsin.");
    } finally {
      setFetchingCaption(false);
    }
  }, [setCaption]);

  useEffect(() => {
    if (link && link.trim()) tryAutoFetchCaption(link);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const labelStyle = {
    display: "block",
    fontSize: "11px",
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    color: COLORS.inkSoft,
    marginBottom: "6px",
  };
  const inputStyle = {
    width: "100%",
    borderRadius: "8px",
    border: `1px solid ${COLORS.line}`,
    background: COLORS.paper,
    color: COLORS.ink,
    padding: "10px 12px",
    fontSize: "14px",
    outline: "none",
    boxSizing: "border-box",
  };

  const handleImageSelect = (e) => {
    const files = Array.from(e.target.files || []);
    files.forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        const match = /^data:(.+);base64,(.*)$/.exec(result || "");
        if (match) {
          setImages((prev) => [...prev, { id: uid(), mediaType: match[1], base64: match[2], previewUrl: result }]);
        }
      };
      reader.readAsDataURL(file);
    });
    e.target.value = "";
  };

  const removeImage = (id) => setImages((prev) => prev.filter((img) => img.id !== id));

  return (
    <div style={{ borderRadius: "14px", border: `1px solid ${COLORS.line}`, background: COLORS.panel, padding: "24px", boxShadow: CARD_SHADOW }}>
      <h2 style={{ fontFamily: SERIF, fontSize: "18px", color: COLORS.ink, margin: "0 0 4px" }}>Yeni Tarif Çıkar</h2>
      <p style={{ fontSize: "14px", color: COLORS.inkSoft, margin: "0 0 20px" }}>
        En kolay yol: TikTok'ta gördüğün açıklama ya da malzeme yazısının <strong>ekran görüntüsünü</strong> al ve
        aşağıya yükle — kopyala-yapıştır uğraşına gerek yok. İstersen açıklamayı yapıştırabilir ya da gördüklerini
        birkaç kelimeyle not olarak yazabilirsin.
      </p>

      <label style={labelStyle}>Video linki</label>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          borderRadius: "8px",
          border: `1px solid ${COLORS.line}`,
          background: COLORS.paper,
          padding: "10px 12px",
          marginBottom: "16px",
        }}
      >
        <Link2 size={15} color={COLORS.inkSoft} />
        <input
          type="text"
          value={link}
          onChange={(e) => setLink(e.target.value)}
          onBlur={(e) => tryAutoFetchCaption(e.target.value)}
          placeholder="https://www.tiktok.com/... veya youtube.com/..."
          style={{ flex: 1, background: "transparent", border: "none", outline: "none", fontSize: "14px", color: COLORS.ink }}
        />
      </div>

      <label style={labelStyle}>Ekran görüntüsü (önerilen)</label>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", marginBottom: "16px" }}>
        {images.map((img) => (
          <div key={img.id} style={{ position: "relative", width: "72px", height: "72px", flexShrink: 0 }}>
            <img
              src={img.previewUrl}
              alt=""
              style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "8px", border: `1px solid ${COLORS.line}` }}
            />
            <button
              onClick={() => removeImage(img.id)}
              aria-label="Görseli kaldır"
              style={{
                position: "absolute",
                top: "-6px",
                right: "-6px",
                width: "20px",
                height: "20px",
                borderRadius: "9999px",
                background: COLORS.danger,
                color: "#FFFFFF",
                border: "none",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <X size={12} />
            </button>
          </div>
        ))}
        <label
          style={{
            width: "72px",
            height: "72px",
            flexShrink: 0,
            borderRadius: "8px",
            border: `1px dashed ${COLORS.forest}`,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "4px",
            cursor: "pointer",
            color: COLORS.forest,
          }}
        >
          <Plus size={18} />
          <span style={{ fontSize: "10px", fontWeight: 600 }}>Ekle</span>
          <input type="file" accept="image/*" multiple onChange={handleImageSelect} style={{ display: "none" }} />
        </label>
      </div>

      <label style={labelStyle}>
        Açıklama / altyazı metni (opsiyonel)
        {fetchingCaption && (
          <span style={{ marginLeft: "8px", fontWeight: 400, textTransform: "none", color: COLORS.mustardDark }}>
            Otomatik getiriliyor…
          </span>
        )}
      </label>
      {captionFetchError && (
        <div style={{ fontSize: "12px", color: COLORS.inkSoft, marginBottom: "6px" }}>{captionFetchError}</div>
      )}
      <textarea
        value={caption}
        onChange={(e) => setCaption(e.target.value)}
        placeholder="Videonun altındaki açıklamayı ya da altyazı metnini buraya yapıştır…"
        rows={4}
        style={{ ...inputStyle, marginBottom: "16px", resize: "vertical" }}
      />

      <label style={labelStyle}>Gördüğün malzemeler (opsiyonel)</label>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Örn. tavuklu, yumurtalı, galeta unlu kızartma…"
        rows={2}
        style={{ ...inputStyle, marginBottom: "16px", resize: "vertical" }}
      />

      <label style={labelStyle}>Kategori</label>

      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginBottom: "8px" }}>
        {CATEGORIES.map((cat) => {
          const selected = category === cat;
          return (
            <button
              key={cat}
              type="button"
              onClick={() => setCategory(cat)}
              style={{
                padding: "8px 14px",
                borderRadius: "9999px",
                fontSize: "13px",
                fontWeight: 600,
                border: `1px solid ${selected ? COLORS.forest : COLORS.line}`,
                background: selected ? COLORS.forest : "transparent",
                color: selected ? "#F3EFE6" : COLORS.inkSoft,
                cursor: "pointer",
              }}
            >
              {cat}
            </button>
          );
        })}
      </div>

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
            marginTop: "12px",
          }}
        >
          <AlertCircle size={16} style={{ marginTop: "2px", flexShrink: 0 }} />
          <span>{error}</span>
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: "12px", marginTop: "16px" }}>
        <button
          onClick={onSubmit}
          disabled={busy}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "10px 16px",
            borderRadius: "8px",
            fontSize: "14px",
            fontWeight: 600,
            background: COLORS.mustard,
            color: COLORS.forestDark,
            border: "none",
            cursor: busy ? "default" : "pointer",
            opacity: busy ? 0.6 : 1,
          }}
        >
          {busy ? <Loader2 size={16} className="spin" /> : <ChefHat size={16} />}
          {busy ? "Çıkarılıyor…" : "Tarifi Çıkar"}
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          style={{ padding: "10px 16px", borderRadius: "8px", fontSize: "14px", fontWeight: 500, background: "transparent", color: COLORS.inkSoft, border: "none", cursor: "pointer" }}
        >
          Vazgeç
        </button>
      </div>
      <style>{`.spin { animation: spin 1s linear infinite; } @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function RecipeDetail({ recipe, onDelete, onRename, onToggleFavorite, onChangeCategory, onEdit }) {
  const { title, servings, category, prep_time_minutes, difficulty, ingredients = [], instructions = [], nutrition = {}, assumptions, link, isFavorite, addedBy } = recipe;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title || "");

  useEffect(() => {
    setDraft(title || "");
    setEditing(false);
  }, [title]);

  const commit = () => {
    if (draft.trim() && draft.trim() !== title) onRename(draft.trim());
    setEditing(false);
  };

  const hasValidCategory = CATEGORIES.includes(category);

  const metaParts = [
    servings ? `${servings} porsiyon` : null,
    hasValidCategory ? category : null,
    prep_time_minutes ? `${prep_time_minutes} dk` : null,
    difficulty || null,
    addedBy ? `Ekleyen: ${addedBy}` : null,
  ].filter(Boolean);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      <div style={{ borderRadius: "14px", border: `1px solid ${COLORS.line}`, background: COLORS.panel, padding: "24px", boxShadow: CARD_SHADOW }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "16px" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontFamily: SERIF,
                fontStyle: "italic",
                fontSize: "13px",
                letterSpacing: "0.01em",
                color: COLORS.mustardDark,
                marginBottom: "6px",
                display: "flex",
                alignItems: "center",
                gap: "6px",
                flexWrap: "wrap",
              }}
            >
              {metaParts.length > 0 ? metaParts.join(" · ") : "Tarif"}
            </div>
            {editing ? (
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commit();
                    if (e.key === "Escape") {
                      setDraft(title || "");
                      setEditing(false);
                    }
                  }}
                  style={{
                    fontFamily: SERIF,
                    fontSize: "26px",
                    color: COLORS.ink,
                    border: "none",
                    borderBottom: `2px solid ${COLORS.mustard}`,
                    background: "transparent",
                    outline: "none",
                    flex: 1,
                    minWidth: 0,
                    padding: "0 0 2px",
                  }}
                />
                <button
                  onClick={commit}
                  aria-label="Adı kaydet"
                  style={{ padding: "6px", borderRadius: "8px", background: COLORS.forest, border: "none", color: "#F3EFE6", cursor: "pointer", flexShrink: 0 }}
                >
                  <Check size={16} />
                </button>
              </div>
            ) : (
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <h2 style={{ fontFamily: SERIF, fontSize: "26px", color: COLORS.ink, margin: 0, lineHeight: 1.2 }}>
                  {title || "İsimsiz tarif"}
                </h2>
                <button
                  onClick={() => setEditing(true)}
                  aria-label="Adı düzenle"
                  style={{ padding: "6px", borderRadius: "8px", background: "transparent", border: "none", color: COLORS.inkSoft, cursor: "pointer", flexShrink: 0 }}
                >
                  <Pencil size={15} />
                </button>
              </div>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "4px", flexShrink: 0 }}>
            <button
              onClick={onToggleFavorite}
              aria-label="Favori"
              style={{ padding: "8px", borderRadius: "8px", background: "transparent", border: "none", color: COLORS.mustard, cursor: "pointer" }}
            >
              <Star size={18} fill={isFavorite ? COLORS.mustard : "none"} />
            </button>
            <button
              onClick={onDelete}
              aria-label="Tarifi sil"
              style={{ padding: "8px", borderRadius: "8px", background: "transparent", border: "none", color: COLORS.danger, cursor: "pointer" }}
            >
              <Trash2 size={17} />
            </button>
          </div>
        </div>

        {!hasValidCategory && (
          <div style={{ marginTop: "16px", padding: "12px", borderRadius: "8px", background: "#F5E4E0" }}>
            <div style={{ fontSize: "13px", color: COLORS.danger, marginBottom: "8px" }}>
              Bu tarifin kategorisi yok, bu yüzden "Yemekler" listesinde ve aramada görünmüyordu. Bir kategori seç:
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
              {CATEGORIES.map((cat) => (
                <button
                  key={cat}
                  onClick={() => onChangeCategory(cat)}
                  style={{
                    padding: "6px 12px",
                    borderRadius: "9999px",
                    fontSize: "12px",
                    fontWeight: 600,
                    border: `1px solid ${COLORS.forest}`,
                    background: "transparent",
                    color: COLORS.forest,
                    cursor: "pointer",
                  }}
                >
                  {cat}
                </button>
              ))}
            </div>
          </div>
        )}

        <button
          onClick={onEdit}
          style={{
            marginTop: "16px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "8px",
            padding: "10px 16px",
            borderRadius: "8px",
            fontSize: "13px",
            fontWeight: 600,
            background: "transparent",
            color: COLORS.forest,
            border: `1px solid ${COLORS.forest}`,
            cursor: "pointer",
          }}
        >
          <Pencil size={14} />
          Tarifi Düzenle (malzeme, yapılış, besin değerleri)
        </button>
      </div>

      <div className="md-detail-row" style={{ display: "flex", flexDirection: "column", gap: "20px", alignItems: "flex-start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "20px", flex: 1, width: "100%", minWidth: 0 }}>
          <ExpandableSection title="Malzemeler" badge={`${ingredients.length}`}>
            {ingredients.length === 0 ? (
              <p style={{ fontSize: "14px", color: COLORS.inkSoft, margin: 0 }}>Malzeme bulunamadı.</p>
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "8px" }}>
                {ingredients.map((ing, i) => (
                  <li key={i} style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "12px", fontSize: "14px" }}>
                    <span style={{ color: COLORS.ink }}>{ing.name}</span>
                    <span style={{ flexShrink: 0, whiteSpace: "nowrap", color: COLORS.inkSoft }}>{ing.amount}</span>
                  </li>
                ))}
              </ul>
            )}
          </ExpandableSection>

          <ExpandableSection title="Yapılışı" badge={instructions.length ? `${instructions.length} adım` : null}>
            {instructions.length === 0 ? (
              <p style={{ fontSize: "14px", color: COLORS.inkSoft, margin: 0 }}>
                Açıklama metninde yapılış adımları yoktu — aşağıdaki linkten videoyu izleyebilirsin.
              </p>
            ) : (
              <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "12px" }}>
                {instructions.map((step, i) => (
                  <li key={i} style={{ display: "flex", gap: "12px", fontSize: "14px" }}>
                    <span
                      style={{
                        flexShrink: 0,
                        width: "24px",
                        height: "24px",
                        borderRadius: "9999px",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: "12px",
                        fontWeight: 600,
                        background: COLORS.forest,
                        color: "#F3EFE6",
                      }}
                    >
                      {i + 1}
                    </span>
                    <span style={{ paddingTop: "2px", color: COLORS.ink }}>{step}</span>
                  </li>
                ))}
              </ol>
            )}
          </ExpandableSection>

          {link && (
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "8px",
                padding: "12px 16px",
                borderRadius: "8px",
                fontSize: "14px",
                fontWeight: 600,
                background: COLORS.forest,
                color: "#F3EFE6",
                textDecoration: "none",
              }}
            >
              <ExternalLink size={16} />
              Videoyu Aç, Yapılışını İzle
            </a>
          )}
        </div>

        <div className="md-nutrition" style={{ width: "100%" }}>
          <NutritionLabel nutrition={nutrition} servings={servings} />
        </div>
      </div>

      {assumptions && (
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: "8px",
            fontSize: "13px",
            padding: "10px 12px",
            borderRadius: "8px",
            background: "#EFE9D8",
            color: COLORS.inkSoft,
          }}
        >
          <AlertCircle size={14} style={{ marginTop: "2px", flexShrink: 0 }} />
          <span>{assumptions}</span>
        </div>
      )}
    </div>
  );
}

function ShoppingList({ recipes }) {
  const [selected, setSelected] = useState([]);
  const [checked, setChecked] = useState({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await sharedGet("shopping-list");
        if (!cancelled && res && res.value) {
          const data = JSON.parse(res.value);
          setSelected(data.selected || []);
          setChecked(data.checked || {});
        }
      } catch (e) {
        // henüz alışveriş listesi yok
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = useCallback(async (nextSelected, nextChecked) => {
    setSelected(nextSelected);
    setChecked(nextChecked);
    try {
      await sharedSet("shopping-list", JSON.stringify({ selected: nextSelected, checked: nextChecked }));
    } catch (e) {
      // yazma başarısız olsa da yerel görünüm güncel kalsın
    }
  }, []);

  const toggleSelect = (id) => {
    const next = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
    persist(next, checked);
  };

  const toggleChecked = (key) => {
    persist(selected, { ...checked, [key]: !checked[key] });
  };

  const clearChecked = () => persist(selected, {});

  const chosenRecipes = recipes.filter((r) => selected.includes(r.id));
  const totalIngredients = chosenRecipes.reduce((sum, r) => sum + (r.ingredients || []).length, 0);
  const checkedCount = Object.values(checked).filter(Boolean).length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      <div style={{ borderRadius: "14px", border: `1px solid ${COLORS.line}`, background: COLORS.panel, padding: "24px", boxShadow: CARD_SHADOW }}>
        <h2 style={{ fontFamily: SERIF, fontSize: "20px", color: COLORS.ink, margin: "0 0 4px", display: "flex", alignItems: "center", gap: "8px" }}>
          <ShoppingCart size={19} color={COLORS.forest} />
          Alışveriş Listesi
        </h2>
        <p style={{ fontSize: "14px", color: COLORS.inkSoft, margin: "0 0 16px" }}>
          Listeye eklemek istediğin tarifleri seç, malzemelerini tek bir listede birleştireyim.
        </p>

        {!loaded ? (
          <p style={{ fontSize: "14px", color: COLORS.inkSoft, margin: 0 }}>Yükleniyor…</p>
        ) : recipes.length === 0 ? (
          <p style={{ fontSize: "14px", color: COLORS.inkSoft, margin: 0 }}>Henüz kayıtlı tarif yok.</p>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
            {recipes.map((r) => {
              const isSel = selected.includes(r.id);
              return (
                <button
                  key={r.id}
                  onClick={() => toggleSelect(r.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                    padding: "8px 14px",
                    borderRadius: "9999px",
                    fontSize: "13px",
                    fontWeight: 600,
                    border: `1px solid ${isSel ? COLORS.forest : COLORS.line}`,
                    background: isSel ? COLORS.forest : "transparent",
                    color: isSel ? "#F3EFE6" : COLORS.inkSoft,
                    cursor: "pointer",
                  }}
                >
                  {isSel && <Check size={13} />}
                  {r.title || "İsimsiz tarif"}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {chosenRecipes.length > 0 && (
        <div style={{ borderRadius: "14px", border: `1px solid ${COLORS.line}`, background: COLORS.panel, padding: "24px", boxShadow: CARD_SHADOW }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" }}>
            <h3 style={{ fontFamily: SERIF, fontSize: "17px", color: COLORS.ink, margin: 0 }}>
              Malzemeler{" "}
              <span style={{ fontFamily: BODY, fontSize: "13px", fontWeight: 400, color: COLORS.inkSoft }}>
                ({checkedCount}/{totalIngredients} alındı)
              </span>
            </h3>
            <button
              onClick={clearChecked}
              style={{ fontSize: "12px", color: COLORS.inkSoft, background: "transparent", border: "none", cursor: "pointer", textDecoration: "underline" }}
            >
              İşaretleri temizle
            </button>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
            {chosenRecipes.map((r) => (
              <div key={r.id}>
                <div style={{ fontSize: "12px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: COLORS.mustardDark, marginBottom: "8px" }}>
                  {r.title || "İsimsiz tarif"}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  {(r.ingredients || []).length === 0 ? (
                    <div style={{ fontSize: "13px", color: COLORS.inkSoft }}>Malzeme bulunamadı.</div>
                  ) : (
                    r.ingredients.map((ing, i) => {
                      const key = `${r.id}::${i}`;
                      const isChecked = !!checked[key];
                      return (
                        <label
                          key={key}
                          style={{ display: "flex", alignItems: "center", gap: "10px", cursor: "pointer", padding: "4px 0" }}
                        >
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => toggleChecked(key)}
                            style={{ width: "16px", height: "16px", accentColor: COLORS.forest, flexShrink: 0 }}
                          />
                          <span
                            style={{
                              flex: 1,
                              fontSize: "14px",
                              color: isChecked ? COLORS.inkSoft : COLORS.ink,
                              textDecoration: isChecked ? "line-through" : "none",
                            }}
                          >
                            {ing.name}
                          </span>
                          <span style={{ fontSize: "13px", color: COLORS.inkSoft, flexShrink: 0 }}>{ing.amount}</span>
                        </label>
                      );
                    })
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
function ExpandableSection({ title, badge, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ borderRadius: "14px", border: `1px solid ${COLORS.line}`, background: COLORS.panel, overflow: "hidden", boxShadow: CARD_SHADOW }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "16px 20px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
        }}
        aria-expanded={open}
      >
        <span style={{ display: "flex", alignItems: "baseline", gap: "8px" }}>
          <span style={{ fontSize: "13px", fontWeight: 700, letterSpacing: "0.02em", color: COLORS.ink }}>{title}</span>
          {badge && (
            <span style={{ fontSize: "11px", color: COLORS.inkSoft }}>{badge}</span>
          )}
        </span>
        <ChevronDown
          size={17}
          style={{
            color: COLORS.inkSoft,
            transform: open ? "rotate(180deg)" : "rotate(0deg)",
            transition: "transform 250ms ease",
            flexShrink: 0,
          }}
        />
      </button>
      <div style={{ display: "grid", gridTemplateRows: open ? "1fr" : "0fr", transition: "grid-template-rows 280ms ease" }}>
        <div style={{ overflow: "hidden" }}>
          <div style={{ padding: "0 20px 20px", borderTop: `1px solid ${COLORS.line}`, marginTop: "0" }}>
            <div style={{ paddingTop: "16px" }}>{children}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function NutritionLabel({ nutrition, servings }) {
  const [open, setOpen] = useState(false);
  const cal = nutrition.calories ?? "—";
  const protein = nutrition.protein_g ?? "—";
  const carbs = nutrition.carbs_g ?? "—";
  const fat = nutrition.fat_g ?? "—";

  return (
    <div style={{ background: "#FFFFFF", border: `3px solid ${COLORS.ink}`, borderRadius: "2px", padding: "12px", fontFamily: LABELSANS, boxShadow: CARD_SHADOW }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          width: "100%",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          padding: 0,
          textAlign: "left",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "8px",
        }}
        aria-expanded={open}
      >
        <span style={{ fontSize: "18px", fontWeight: 800, color: COLORS.ink, lineHeight: 1 }}>Besin Değerleri</span>
        <ChevronDown
          size={18}
          style={{ color: COLORS.ink, flexShrink: 0, transform: open ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 250ms ease" }}
        />
      </button>

      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          padding: "8px 0 6px",
          marginTop: "6px",
          borderTop: `6px solid ${COLORS.ink}`,
          borderBottom: open ? `6px solid ${COLORS.ink}` : "none",
        }}
      >
        <span style={{ fontSize: "14px", fontWeight: 700, color: COLORS.ink }}>Kalori</span>
        <span style={{ fontSize: "20px", fontWeight: 800, color: COLORS.ink }}>{cal}</span>
      </div>

      <div style={{ display: "grid", gridTemplateRows: open ? "1fr" : "0fr", transition: "grid-template-rows 280ms ease" }}>
        <div style={{ overflow: "hidden" }}>
          <div style={{ fontSize: "11px", padding: "6px 0 4px", borderBottom: `1px solid ${COLORS.ink}`, color: COLORS.ink }}>
            Tarifin tamamı {servings ? `(${servings} porsiyonluk tarif)` : ""}
          </div>

          <NutritionRow label="Protein" value={protein} unit="g" />
          <NutritionRow label="Karbonhidrat" value={carbs} unit="g" />
          <NutritionRow label="Yağ" value={fat} unit="g" last />

          <div style={{ fontSize: "10px", paddingTop: "8px", marginTop: "4px", color: COLORS.inkSoft, lineHeight: 1.4 }}>
            * Değerler yapay zeka tahminidir, kesin ölçüm değildir.
          </div>
        </div>
      </div>
    </div>
  );
}

function NutritionRow({ label, value, unit, last }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        padding: "6px 0",
        borderBottom: last ? "none" : `1px solid ${COLORS.line}`,
      }}
    >
      <span style={{ fontSize: "14px", color: COLORS.ink }}>{label}</span>
      <span style={{ fontSize: "14px", fontWeight: 700, color: COLORS.ink }}>
        {value}
        {value !== "—" ? unit : ""}
      </span>
    </div>
  );
}

function RecipeEditor({ heading, initial, onSave, onCancel }) {
  const [title, setTitle] = useState(initial?.title || "");
  const [category, setCategory] = useState(initial?.category || "");
  const [servings, setServings] = useState(initial?.servings != null ? String(initial.servings) : "");
  const [prepTime, setPrepTime] = useState(initial?.prep_time_minutes != null ? String(initial.prep_time_minutes) : "");
  const [difficulty, setDifficulty] = useState(initial?.difficulty || "");
  const [link, setLink] = useState(initial?.link || "");
  const [ingredients, setIngredients] = useState(() =>
    initial?.ingredients && initial.ingredients.length > 0
      ? initial.ingredients.map((ing) => ({ _key: uid(), name: ing.name || "", amount: ing.amount || "" }))
      : [{ _key: uid(), name: "", amount: "" }]
  );
  const [instructions, setInstructions] = useState(() =>
    initial?.instructions && initial.instructions.length > 0
      ? initial.instructions.map((s) => ({ _key: uid(), text: s }))
      : [{ _key: uid(), text: "" }]
  );
  const [calories, setCalories] = useState(initial?.nutrition?.calories != null ? String(initial.nutrition.calories) : "");
  const [protein, setProtein] = useState(initial?.nutrition?.protein_g != null ? String(initial.nutrition.protein_g) : "");
  const [carbs, setCarbs] = useState(initial?.nutrition?.carbs_g != null ? String(initial.nutrition.carbs_g) : "");
  const [fat, setFat] = useState(initial?.nutrition?.fat_g != null ? String(initial.nutrition.fat_g) : "");
  const [error, setError] = useState("");

  const labelStyle = {
    display: "block",
    fontSize: "11px",
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    color: COLORS.inkSoft,
    marginBottom: "6px",
  };
  const inputStyle = {
    width: "100%",
    borderRadius: "8px",
    border: `1px solid ${COLORS.line}`,
    background: COLORS.paper,
    color: COLORS.ink,
    padding: "10px 12px",
    fontSize: "14px",
    outline: "none",
    boxSizing: "border-box",
  };

  const updateIngredient = (key, field, value) => {
    setIngredients((prev) => prev.map((ing) => (ing._key === key ? { ...ing, [field]: value } : ing)));
  };
  const addIngredient = () => setIngredients((prev) => [...prev, { _key: uid(), name: "", amount: "" }]);
  const removeIngredient = (key) => setIngredients((prev) => (prev.length > 1 ? prev.filter((ing) => ing._key !== key) : prev));

  const updateInstruction = (key, value) => {
    setInstructions((prev) => prev.map((s) => (s._key === key ? { ...s, text: value } : s)));
  };
  const addInstruction = () => setInstructions((prev) => [...prev, { _key: uid(), text: "" }]);
  const removeInstruction = (key) => setInstructions((prev) => (prev.length > 1 ? prev.filter((s) => s._key !== key) : prev));

  const handleSave = () => {
    if (!title.trim()) {
      setError("Tarife bir isim vermen lazım.");
      return;
    }
    if (!category) {
      setError("Bir kategori seçmen lazım.");
      return;
    }
    setError("");

    const cleanIngredients = ingredients.filter((i) => i.name.trim()).map((i) => ({ name: i.name.trim(), amount: i.amount.trim() }));
    const cleanInstructions = instructions.filter((s) => s.text.trim()).map((s) => s.text.trim());

    onSave({
      title: title.trim(),
      category,
      servings: servings.trim() ? Number(servings) : undefined,
      prep_time_minutes: prepTime.trim() ? Number(prepTime) : undefined,
      difficulty: difficulty || undefined,
      link: link.trim(),
      ingredients: cleanIngredients,
      instructions: cleanInstructions,
      nutrition: {
        calories: calories.trim() ? Number(calories) : undefined,
        protein_g: protein.trim() ? Number(protein) : undefined,
        carbs_g: carbs.trim() ? Number(carbs) : undefined,
        fat_g: fat.trim() ? Number(fat) : undefined,
      },
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      <div style={{ borderRadius: "14px", border: `1px solid ${COLORS.line}`, background: COLORS.panel, padding: "24px", boxShadow: CARD_SHADOW }}>
        <h2 style={{ fontFamily: SERIF, fontSize: "20px", color: COLORS.ink, margin: "0 0 4px" }}>{heading}</h2>
        <p style={{ fontSize: "13px", color: COLORS.inkSoft, margin: "0 0 20px" }}>
          Alanları istediğin gibi doldur ya da düzenle. Boş bıraktığın satırlar kaydedilmez.
        </p>

        <label style={labelStyle}>Tarif Adı</label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Örn. Çıtır Tavuk"
          style={{ ...inputStyle, marginBottom: "16px" }}
        />

        <label style={labelStyle}>Kategori</label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginBottom: "16px" }}>
          {CATEGORIES.map((cat) => {
            const selected = category === cat;
            return (
              <button
                key={cat}
                onClick={() => setCategory(cat)}
                style={{
                  padding: "8px 14px",
                  borderRadius: "9999px",
                  fontSize: "13px",
                  fontWeight: 600,
                  border: `1px solid ${selected ? COLORS.forest : COLORS.line}`,
                  background: selected ? COLORS.forest : "transparent",
                  color: selected ? "#F3EFE6" : COLORS.inkSoft,
                  cursor: "pointer",
                }}
              >
                {cat}
              </button>
            );
          })}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "16px" }}>
          <div>
            <label style={labelStyle}>Porsiyon</label>
            <input
              type="number"
              min="0"
              value={servings}
              onChange={(e) => setServings(e.target.value)}
              placeholder="4"
              style={inputStyle}
            />
          </div>
          <div>
            <label style={labelStyle}>Hazırlık Süresi (dk)</label>
            <input
              type="number"
              min="0"
              value={prepTime}
              onChange={(e) => setPrepTime(e.target.value)}
              placeholder="30"
              style={inputStyle}
            />
          </div>
        </div>

        <label style={labelStyle}>Zorluk</label>
        <div style={{ display: "flex", gap: "8px", marginBottom: "16px" }}>
          {["Kolay", "Orta", "Zor"].map((d) => {
            const selected = difficulty === d;
            return (
              <button
                key={d}
                onClick={() => setDifficulty(selected ? "" : d)}
                style={{
                  padding: "8px 14px",
                  borderRadius: "9999px",
                  fontSize: "13px",
                  fontWeight: 600,
                  border: `1px solid ${selected ? COLORS.forest : COLORS.line}`,
                  background: selected ? COLORS.forest : "transparent",
                  color: selected ? "#F3EFE6" : COLORS.inkSoft,
                  cursor: "pointer",
                }}
              >
                {d}
              </button>
            );
          })}
        </div>

        <label style={labelStyle}>Video linki (opsiyonel)</label>
        <input
          type="text"
          value={link}
          onChange={(e) => setLink(e.target.value)}
          placeholder="https://..."
          style={inputStyle}
        />
      </div>

      <div style={{ borderRadius: "14px", border: `1px solid ${COLORS.line}`, background: COLORS.panel, padding: "24px", boxShadow: CARD_SHADOW }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "14px" }}>
          <h3 style={{ fontFamily: SERIF, fontSize: "17px", color: COLORS.ink, margin: 0 }}>Malzemeler</h3>
          <button
            onClick={addIngredient}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "4px",
              fontSize: "12px",
              fontWeight: 600,
              color: COLORS.forest,
              background: "transparent",
              border: "none",
              cursor: "pointer",
            }}
          >
            <Plus size={13} /> Malzeme Ekle
          </button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {ingredients.map((ing) => (
            <div key={ing._key} style={{ display: "flex", gap: "8px" }}>
              <input
                type="text"
                value={ing.name}
                onChange={(e) => updateIngredient(ing._key, "name", e.target.value)}
                placeholder="Malzeme (örn. Tavuk göğsü)"
                style={{ ...inputStyle, flex: 2 }}
              />
              <input
                type="text"
                value={ing.amount}
                onChange={(e) => updateIngredient(ing._key, "amount", e.target.value)}
                placeholder="Miktar (örn. 500 g)"
                style={{ ...inputStyle, flex: 1 }}
              />
              <button
                onClick={() => removeIngredient(ing._key)}
                aria-label="Malzemeyi kaldır"
                style={{ padding: "8px", background: "transparent", border: "none", color: COLORS.danger, cursor: "pointer", flexShrink: 0 }}
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>
      </div>

      <div style={{ borderRadius: "14px", border: `1px solid ${COLORS.line}`, background: COLORS.panel, padding: "24px", boxShadow: CARD_SHADOW }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "14px" }}>
          <h3 style={{ fontFamily: SERIF, fontSize: "17px", color: COLORS.ink, margin: 0 }}>Yapılışı</h3>
          <button
            onClick={addInstruction}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "4px",
              fontSize: "12px",
              fontWeight: 600,
              color: COLORS.forest,
              background: "transparent",
              border: "none",
              cursor: "pointer",
            }}
          >
            <Plus size={13} /> Adım Ekle
          </button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {instructions.map((step, i) => (
            <div key={step._key} style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
              <span
                style={{
                  flexShrink: 0,
                  marginTop: "10px",
                  width: "22px",
                  height: "22px",
                  borderRadius: "9999px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "11px",
                  fontWeight: 700,
                  background: COLORS.forest,
                  color: "#F3EFE6",
                }}
              >
                {i + 1}
              </span>
              <textarea
                value={step.text}
                onChange={(e) => updateInstruction(step._key, e.target.value)}
                placeholder={`${i + 1}. adımı yaz…`}
                rows={2}
                style={{ ...inputStyle, flex: 1, resize: "vertical" }}
              />
              <button
                onClick={() => removeInstruction(step._key)}
                aria-label="Adımı kaldır"
                style={{ padding: "8px", background: "transparent", border: "none", color: COLORS.danger, cursor: "pointer", flexShrink: 0, marginTop: "2px" }}
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>
      </div>

      <div style={{ borderRadius: "14px", border: `1px solid ${COLORS.line}`, background: COLORS.panel, padding: "24px", boxShadow: CARD_SHADOW }}>
        <h3 style={{ fontFamily: SERIF, fontSize: "17px", color: COLORS.ink, margin: "0 0 14px" }}>Besin Değerleri (tarifin tamamı)</h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
          <div>
            <label style={labelStyle}>Kalori</label>
            <input type="number" min="0" value={calories} onChange={(e) => setCalories(e.target.value)} placeholder="0" style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Protein (g)</label>
            <input type="number" min="0" value={protein} onChange={(e) => setProtein(e.target.value)} placeholder="0" style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Karbonhidrat (g)</label>
            <input type="number" min="0" value={carbs} onChange={(e) => setCarbs(e.target.value)} placeholder="0" style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Yağ (g)</label>
            <input type="number" min="0" value={fat} onChange={(e) => setFat(e.target.value)} placeholder="0" style={inputStyle} />
          </div>
        </div>
      </div>

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
          }}
        >
          <AlertCircle size={16} style={{ marginTop: "2px", flexShrink: 0 }} />
          <span>{error}</span>
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        <button
          onClick={handleSave}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "10px 16px",
            borderRadius: "8px",
            fontSize: "14px",
            fontWeight: 600,
            background: COLORS.mustard,
            color: COLORS.forestDark,
            border: "none",
            cursor: "pointer",
          }}
        >
          <Check size={16} />
          Kaydet
        </button>
        <button
          onClick={onCancel}
          style={{ padding: "10px 16px", borderRadius: "8px", fontSize: "14px", fontWeight: 500, background: "transparent", color: COLORS.inkSoft, border: "none", cursor: "pointer" }}
        >
          Vazgeç
        </button>
      </div>
    </div>
  );
}

function normalizeText(s) {
  return (s || "").toLocaleLowerCase("tr").trim();
}

function ingredientIsAvailable(ingredientName, pantryItems) {
  const norm = normalizeText(ingredientName);
  if (!norm) return false;
  return pantryItems.some((item) => {
    const it = normalizeText(item);
    if (!it) return false;
    return norm.includes(it) || it.includes(norm);
  });
}

function PantryFinder({ recipes, onSelectRecipe }) {
  const [items, setItems] = useState([]);
  const [draft, setDraft] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await sharedGet("pantry-items");
        if (!cancelled && res && res.value) setItems(JSON.parse(res.value));
      } catch (e) {
        // henüz kayıtlı malzeme yok
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const persistItems = useCallback(async (next) => {
    setItems(next);
    try {
      await sharedSet("pantry-items", JSON.stringify(next));
    } catch (e) {
      // yazma başarısız olsa da yerel görünüm güncel kalsın
    }
  }, []);

  const addItem = () => {
    const val = draft.trim();
    if (!val) return;
    if (!items.some((i) => normalizeText(i) === normalizeText(val))) {
      persistItems([...items, val]);
    }
    setDraft("");
  };

  const removeItem = (val) => {
    persistItems(items.filter((i) => i !== val));
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addItem();
    }
  };

  const results = recipes
    .map((r) => {
      const ingredients = r.ingredients || [];
      const total = ingredients.length;
      const matched = ingredients.filter((ing) => ingredientIsAvailable(ing.name, items));
      const missing = ingredients.filter((ing) => !ingredientIsAvailable(ing.name, items));
      const ratio = total > 0 ? matched.length / total : 0;
      return { recipe: r, total, matchedCount: matched.length, missing, ratio };
    })
    .filter((x) => x.total > 0 && x.matchedCount > 0)
    .sort((a, b) => b.ratio - a.ratio || b.matchedCount - a.matchedCount);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      <div style={{ borderRadius: "14px", border: `1px solid ${COLORS.line}`, background: COLORS.panel, padding: "24px", boxShadow: CARD_SHADOW }}>
        <h2 style={{ fontFamily: SERIF, fontSize: "20px", color: COLORS.ink, margin: "0 0 4px", display: "flex", alignItems: "center", gap: "8px" }}>
          <Package size={19} color={COLORS.mustardDark} />
          Elimde Bunlar Var
        </h2>
        <p style={{ fontSize: "14px", color: COLORS.inkSoft, margin: "0 0 16px" }}>
          Evde olan malzemeleri tek tek yaz (Enter'a bas ya da virgül koy), bu malzemelerle yapabileceğin kayıtlı tarifleri bulayım.
        </p>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            borderRadius: "8px",
            border: `1px solid ${COLORS.line}`,
            background: COLORS.paper,
            padding: "8px 10px",
            marginBottom: "12px",
          }}
        >
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Örn. tavuk, yumurta, soğan…"
            style={{ flex: 1, minWidth: 0, background: "transparent", border: "none", outline: "none", fontSize: "14px", color: COLORS.ink }}
          />
          <button
            onClick={addItem}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "4px",
              padding: "6px 12px",
              borderRadius: "8px",
              fontSize: "12px",
              fontWeight: 700,
              background: COLORS.mustard,
              color: COLORS.forestDark,
              border: "none",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            <Plus size={13} />
            Ekle
          </button>
        </div>

        {!loaded ? (
          <p style={{ fontSize: "13px", color: COLORS.inkSoft, margin: 0 }}>Yükleniyor…</p>
        ) : items.length === 0 ? (
          <p style={{ fontSize: "13px", color: COLORS.inkSoft, margin: 0 }}>Henüz malzeme eklemedin.</p>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
            {items.map((item) => (
              <span
                key={item}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  padding: "5px 6px 5px 12px",
                  borderRadius: "9999px",
                  fontSize: "12px",
                  fontWeight: 600,
                  background: COLORS.forest,
                  color: "#F3EFE6",
                }}
              >
                {item}
                <button
                  onClick={() => removeItem(item)}
                  aria-label="Malzemeyi kaldır"
                  style={{ background: "transparent", border: "none", cursor: "pointer", color: "#C9C2AE", padding: "2px", display: "flex" }}
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {items.length > 0 && (
        <div>
          {results.length === 0 ? (
            <div style={{ borderRadius: "10px", border: `1px dashed ${COLORS.line}`, padding: "24px", textAlign: "center" }}>
              <p style={{ fontSize: "14px", color: COLORS.inkSoft, margin: 0 }}>
                Bu malzemelerle eşleşen kayıtlı tarif bulamadım. Başka malzeme eklemeyi dener misin?
              </p>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              {results.map(({ recipe, total, matchedCount, missing, ratio }) => {
                const isFull = matchedCount === total;
                return (
                  <button
                    key={recipe.id}
                    onClick={() => onSelectRecipe(recipe.id)}
                    style={{
                      textAlign: "left",
                      borderRadius: "10px",
                      border: `1px solid ${isFull ? COLORS.forest : COLORS.line}`,
                      background: COLORS.panel,
                      padding: "16px",
                      cursor: "pointer",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", marginBottom: missing.length > 0 ? "8px" : 0 }}>
                      <div style={{ fontFamily: SERIF, fontSize: "16px", color: COLORS.ink }}>{recipe.title || "İsimsiz tarif"}</div>
                      <span
                        style={{
                          flexShrink: 0,
                          fontSize: "11px",
                          fontWeight: 700,
                          padding: "4px 10px",
                          borderRadius: "9999px",
                          background: isFull ? COLORS.forest : "#EFE9D8",
                          color: isFull ? "#F3EFE6" : COLORS.mustardDark,
                        }}
                      >
                        {isFull ? "Tam eşleşme" : `${matchedCount}/${total} malzeme var`}
                      </span>
                    </div>
                    {missing.length > 0 && (
                      <div style={{ fontSize: "12px", color: COLORS.inkSoft }}>
                        Eksik: {missing.map((m) => m.name).join(", ")}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
