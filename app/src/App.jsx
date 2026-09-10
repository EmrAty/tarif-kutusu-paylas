import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  ChefHat, Plus, Minus, Link2, ExternalLink, Trash2, Loader2, ArrowLeft, AlertCircle,
  FileText, Pencil, Check, ChevronDown, Star, Search, ShoppingCart, Clock, Gauge, Undo2, X, Package, Download,
  Mail, LogOut, Users, Crown, Settings, UserCircle, Copy, Sparkles, LogIn, Bell,
} from "lucide-react";
import { auth, googleProvider, requestFcmToken } from "./firebase.js";
import {
  onAuthStateChanged,
  signInWithPopup,
  signInWithCredential,
  GoogleAuthProvider,
  EmailAuthProvider,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInAnonymously,
  linkWithPopup,
  linkWithCredential,
  signOut,
} from "firebase/auth";
import { Capacitor } from "@capacitor/core";
import { App as CapacitorApp } from "@capacitor/app";
import { SplashScreen } from "@capacitor/splash-screen";
import { FirebaseAuthentication } from "@capacitor-firebase/authentication";
import ShareReceiver from "./capacitorShare.js";
import NativeSplash from "./capacitorSplash.js";

// Google, gömülü (embedded) WebView'lerde OAuth popup'ını User-Agent'a bakarak
// engelliyor ("disallowed_useragent") - TWA gerçek Chrome kullandığı için sorun
// değildi, ama Capacitor'ın kendi WebView'inde signInWithPopup hiç sonuçlanmadan
// asılı kalıyordu. Native Android'de bunun yerine cihazın kendi Google Sign-In
// arayüzü (@capacitor-firebase/authentication) kullanılıp dönen id token'la
// Firebase JS SDK'sında oturum açılıyor - auth nesnesi (onAuthStateChanged,
// authedFetch vb.) hiç değişmiyor, sadece kimlik bilgisini alma yöntemi farklı.
// Native tarafta ASIL hangi adımın patladığını görebilmek için (Google Sign-In
// arayüzünün kendisi mi, yoksa Firebase'e id token'ı teslim etme kısmı mı) tüm
// akış tek bir try/catch'te, hatanın orijinal mesajı korunarak fırlatılıyor.
async function nativeGoogleCredential() {
  let result;
  try {
    result = await FirebaseAuthentication.signInWithGoogle();
  } catch (e) {
    throw new Error(`Google Sign-In: ${e.message || e.code || JSON.stringify(e)}`);
  }
  const idToken = result?.credential?.idToken;
  if (!idToken) throw new Error("Google girişi iptal edildi ya da id token alınamadı.");
  return GoogleAuthProvider.credential(idToken);
}

async function googleSignIn() {
  if (Capacitor.isNativePlatform()) {
    const credential = await nativeGoogleCredential();
    return signInWithCredential(auth, credential);
  }
  return signInWithPopup(auth, googleProvider);
}

// Bu Google hesabı daha önce (misafirden bağımsız) gerçek bir hesap olarak
// kullanılmışsa, Firebase "credential-already-in-use" hatasıyla bağlamayı
// reddediyor - bu durumda amaç zaten "bu Google hesabıyla devam et" olduğu
// için, bağlamak yerine doğrudan o mevcut hesaba geçiş yapıyoruz (misafirin
// üzerindeki veri, gerçek hesaba otomatik taşınmıyor - Firebase'in birleştirme
// desteği yok).
async function googleLink(user) {
  if (Capacitor.isNativePlatform()) {
    const credential = await nativeGoogleCredential();
    try {
      return await linkWithCredential(user, credential);
    } catch (e) {
      if (e.code === "auth/credential-already-in-use") {
        return signInWithCredential(auth, credential);
      }
      throw e;
    }
  }
  try {
    return await linkWithPopup(user, googleProvider);
  } catch (e) {
    if (e.code === "auth/credential-already-in-use") {
      const credential = GoogleAuthProvider.credentialFromError(e);
      if (credential) return signInWithCredential(auth, credential);
    }
    throw e;
  }
}

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

const FREE_RECIPE_LIMIT = 50;
const MAX_FAMILIES = 2;
const PERSONAL = "personal";

function isFamilyRecipeScope(recipe) {
  return (recipe._scopes || [recipe._scope]).some((s) => s && s !== PERSONAL);
}

// Kişisel veriler ("personal") sadece o hesaba, aile verileri ("family:<id>")
// o ailenin tüm üyelerine ait — hangisi olduğu her istekte scope/familyId ile
// belirtiliyor. Kimlik doğrulaması Firebase ID token'ıyla yapılıyor.
async function authedFetch(path, { method = "GET", body } = {}) {
  const user = auth.currentUser;
  if (!user) throw new Error("Oturum bulunamadı.");
  const token = await user.getIdToken();
  const res = await fetch(path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "İstek başarısız oldu.");
  return data;
}

function scopeQuery(scopeKey) {
  return scopeKey === PERSONAL ? { scope: "personal" } : { scope: "family", familyId: scopeKey };
}

async function bucketGet(bucket, scopeKey) {
  const { scope, familyId } = scopeQuery(scopeKey);
  const qs = new URLSearchParams({ bucket, scope, ...(familyId ? { familyId } : {}) });
  try {
    const data = await authedFetch(`/api/data?${qs.toString()}`);
    return data.value == null ? null : { value: data.value };
  } catch (e) {
    return null;
  }
}

async function bucketSet(bucket, scopeKey, value) {
  const { scope, familyId } = scopeQuery(scopeKey);
  await authedFetch("/api/data", { method: "POST", body: { bucket, scope, familyId, value } });
}

async function fetchFamilies(memberName) {
  const qs = memberName ? `?name=${encodeURIComponent(memberName)}` : "";
  return authedFetch(`/api/families${qs}`);
}

async function createFamily(name, memberName) {
  return authedFetch("/api/families", { method: "POST", body: { action: "create", name, memberName } });
}

async function joinFamily(code, memberName) {
  return authedFetch("/api/families", { method: "POST", body: { action: "join", code, memberName } });
}

async function leaveFamily(familyId) {
  return authedFetch("/api/families", { method: "POST", body: { action: "leave", familyId } });
}

async function deleteFamily(familyId) {
  return authedFetch("/api/families", { method: "POST", body: { action: "delete", familyId } });
}

async function setPlusFlag(isPlus) {
  return authedFetch("/api/profile", { method: "POST", body: { isPlus } });
}

async function fetchLegacyData() {
  return authedFetch("/api/legacy");
}

async function registerFcmToken(token) {
  return authedFetch("/api/fcm-token", { method: "POST", body: { token } });
}

async function sendFamilyNotification(familyId, recipeTitle, senderName) {
  return authedFetch("/api/notify", { method: "POST", body: { familyId, recipeTitle, senderName } });
}

async function suggestFromPantry(items) {
  return authedFetch("/api/suggest-recipes", { method: "POST", body: { items } });
}

const LEGACY_BUCKET_MAP = { recipes: "recipes", shoppingList: "shopping-list", pantryItems: "pantry-items" };

// Aile hesapları eklenmeden önceki tek paylaşımlı listeyi ("recipes" vb. sabit
// anahtarlar) seçilen bir hedefe (kişisel ya da bir aile) aktarır — hedefte o
// veri türü zaten doluysa üzerine yazmaz, sessizce atlar.
async function importLegacyInto(scopeKey) {
  const legacy = await fetchLegacyData();
  const results = {};
  for (const [legacyKey, bucket] of Object.entries(LEGACY_BUCKET_MAP)) {
    const legacyValue = legacy[legacyKey];
    if (!legacyValue) {
      results[bucket] = "yok";
      continue;
    }
    const current = await bucketGet(bucket, scopeKey);
    if (current && current.value) {
      results[bucket] = "atlandı (hedefte zaten veri var)";
      continue;
    }
    await bucketSet(bucket, scopeKey, legacyValue);
    results[bucket] = "aktarıldı";
  }
  return results;
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
  const idToken = await auth.currentUser.getIdToken();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
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

function mapAuthError(code) {
  switch (code) {
    case "auth/invalid-email":
      return "E-posta adresi geçersiz görünüyor.";
    case "auth/user-not-found":
    case "auth/wrong-password":
    case "auth/invalid-credential":
      return "E-posta veya şifre hatalı.";
    case "auth/email-already-in-use":
      return "Bu e-posta ile zaten bir hesap var, giriş yapmayı dene.";
    case "auth/weak-password":
      return "Şifre en az 6 karakter olmalı.";
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
      return "";
    default:
      return "Bir şeyler ters gitti, tekrar dener misin?";
  }
}

function useUpdateAvailable() {
  const [updateAvailable, setUpdateAvailable] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      try {
        const res = await fetch(`/version.json?t=${Date.now()}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && data.version && data.version !== __APP_VERSION__) {
          setUpdateAvailable(true);
        }
      } catch (e) {
        // sürüm kontrolü başarısız olursa sessizce geç, bir sonraki denemede tekrar bakılır
      }
    };

    check();
    const intervalId = setInterval(check, 5 * 60 * 1000);
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return updateAvailable;
}

function UpdateBanner({ onUpdate }) {
  return (
    <div
      style={{
        width: "100%",
        background: COLORS.mustard,
        color: COLORS.forestDark,
        padding: "10px 16px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "12px",
        fontSize: "13px",
        fontWeight: 600,
        flexWrap: "wrap",
      }}
    >
      <span>Yeni bir güncelleme mevcut.</span>
      <button
        onClick={onUpdate}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "6px",
          background: COLORS.forestDark,
          color: "#F8F5EC",
          border: "none",
          borderRadius: "9999px",
          padding: "6px 14px",
          fontSize: "13px",
          fontWeight: 700,
          cursor: "pointer",
        }}
      >
        <Download size={14} />
        Şimdi Güncelle
      </button>
    </div>
  );
}

export default function TarifKutusu() {
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
  const [authChecked, setAuthChecked] = useState(false);
  const [authUser, setAuthUser] = useState(null);
  const [isPlus, setIsPlus] = useState(false);
  const [families, setFamilies] = useState([]); // [{ id, name, inviteCode, members:[{uid,email,isAnonymous}] }]
  const [familiesLoaded, setFamiliesLoaded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [modalView, setModalView] = useState(null); // "account" | "families" | "plus" | "settings" | null
  const [manualPrefill, setManualPrefill] = useState(null);
  const updateAvailable = useUpdateAvailable();

  useEffect(() => {
    // Misafir girişi artık Firebase'in anonim oturum açma yöntemiyle yapılıyor:
    // gerçek bir hesapla aynı şekilde kalıcı bir uid alıyor (bir daha sorulmuyor),
    // istenirse sonradan Google/e-posta hesabına bağlanıp verisi korunabiliyor.
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setAuthUser(user);
      setAuthChecked(true);
    });
    return unsubscribe;
  }, []);

  const handleGuestEntry = () => signInAnonymously(auth);

  const handleSignOut = () => signOut(auth);

  const showAuthGate = authChecked && !authUser;

  const loadFamiliesState = useCallback(async () => {
    try {
      const data = await fetchFamilies(personName);
      setIsPlus(!!data.isPlus);
      setFamilies(data.families || []);
    } catch (e) {
      // bilgi alınamazsa sessizce geç, bir sonraki denemede tekrar bakılır
    } finally {
      setFamiliesLoaded(true);
    }
  }, [personName]);

  useEffect(() => {
    if (authUser) loadFamiliesState();
  }, [authUser, loadFamiliesState]);

  useEffect(() => {
    // Aile üyeleri arasında "canı çekti" bildirimi alabilmek için, giriş
    // yapılınca sessizce bir push bildirim izni/token'ı almayı dener — VAPID
    // anahtarı tanımlı değilse ya da tarayıcı desteklemiyorsa (requestFcmToken
    // içinde) sessizce hiçbir şey yapmaz.
    if (!authUser) return;
    let cancelled = false;
    (async () => {
      const token = await requestFcmToken();
      if (token && !cancelled) {
        try {
          await registerFcmToken(token);
        } catch (e) {
          // kaydedilemezse sessizce geç, bir sonraki oturumda tekrar denenir
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authUser]);

  const handleSendNotification = useCallback(async (recipe) => {
    const familyScopes = (recipe._scopes || [recipe._scope]).filter((s) => s && s !== PERSONAL);
    if (!familyScopes.length) return;
    await Promise.all(
      familyScopes.map((familyId) =>
        sendFamilyNotification(familyId, recipe.title || "bir yemek", personName)
      )
    );
  }, [personName]);

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
      const directLink = params.get("link");
      if (directLink && directLink.trim()) {
        setLink(directLink.trim());
        setView("add");
        return;
      }

      // Android paylaşım hedefi (manifest.json share_target) buraya
      // ?title=&text=&url= ile GET yapıyor; TikTok/YouTube linkini ayıklıyoruz.
      const combined = [params.get("url"), params.get("text"), params.get("title")]
        .filter(Boolean)
        .join(" ");
      if (combined) {
        const found = combined.match(/https?:\/\/[^\s]+/g) || [];
        const sharedLink =
          found.find((u) => /tiktok\.com|youtu\.be|youtube\.com|instagram\.com/i.test(u)) || found[0];
        if (sharedLink) {
          setLink(sharedLink);
          setView("add");
        }
      }
    } catch (e) {
      // URL okunamazsa sessizce geç
    }
  }, []);

  // --- Android (Capacitor) kabuğuna özel entegrasyonlar ---
  // Aşağıdaki üç useEffect sadece native Android'de çalışır (Capacitor.isNativePlatform()
  // web'de/Vercel'deki normal tarayıcı sürümünde false döner), web davranışını etkilemez.

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    // WebView içeriği (bu React uygulaması) yüklenip ilk render'ı yapınca açılış
    // ekranlarını kapat: SplashScreen sistemin (Android 12+) splash'ı,
    // NativeSplash ise MainActivity'nin tam ekran marka görseli.
    SplashScreen.hide();
    NativeSplash.hide().catch(() => {});
  }, []);

  useEffect(() => {
    // Android'in paylaşım menüsünden ("Tarif Kutusu") ACTION_SEND ile gelen
    // TikTok/Instagram/YouTube linkini, yukarıdaki web share_target akışıyla
    // aynı mantıkla (regex ile URL ayıklama) "Yeni Tarif Çıkar" ekranına aktarır.
    // Uygulama kapalıyken paylaşılırsa getInitialShare, açıkken paylaşılırsa
    // "shareReceived" olayı bu veriyi taşır.
    if (!Capacitor.isNativePlatform()) return;
    const applyShared = (data) => {
      if (!data) return;
      const combined = [data.text, data.title].filter(Boolean).join(" ");
      const found = combined.match(/https?:\/\/[^\s]+/g) || [];
      const sharedLink =
        found.find((u) => /tiktok\.com|youtu\.be|youtube\.com|instagram\.com/i.test(u)) || found[0];
      if (sharedLink) {
        setLink(sharedLink);
        setView("add");
      }
    };
    ShareReceiver.getInitialShare().then(applyShared).catch(() => {});
    let listenerHandle;
    ShareReceiver.addListener("shareReceived", applyShared).then((h) => {
      listenerHandle = h;
    });
    return () => {
      if (listenerHandle) listenerHandle.remove();
    };
  }, []);

  useEffect(() => {
    // Android donanım geri tuşu: önce açık modal, sonra drawer, sonra ekran
    // içi "geri" (Header'daki ok ile aynı davranış: her zaman listeye döner),
    // hiçbiri yoksa uygulamayı kapatmadan arka plana alır.
    if (!Capacitor.isNativePlatform()) return;
    let listenerHandle;
    CapacitorApp.addListener("backButton", () => {
      if (modalView) {
        setModalView(null);
      } else if (menuOpen) {
        setMenuOpen(false);
      } else if (view !== "list") {
        setView("list");
      } else {
        CapacitorApp.minimizeApp();
      }
    }).then((h) => {
      listenerHandle = h;
    });
    return () => {
      if (listenerHandle) listenerHandle.remove();
    };
  }, [view, menuOpen, modalView]);

  const [recipeBuckets, setRecipeBuckets] = useState({ [PERSONAL]: [] });
  const [saveTargets, setSaveTargets] = useState([PERSONAL]);

  const loadRecipeBucket = useCallback(async (scopeKey) => {
    try {
      const res = await bucketGet("recipes", scopeKey);
      const parsed = res && res.value ? JSON.parse(res.value) : [];
      let migrated = false;
      const next = parsed.map((r) => {
        if (r.category && LEGACY_CATEGORY_MAP[r.category]) {
          migrated = true;
          return { ...r, category: LEGACY_CATEGORY_MAP[r.category] };
        }
        return r;
      });
      setRecipeBuckets((prev) => ({ ...prev, [scopeKey]: next }));
      if (migrated) {
        try {
          await bucketSet("recipes", scopeKey, JSON.stringify(next));
        } catch (e) {
          // geçiş kaydedilemese de mevcut oturumda güncel görünüm kalsın
        }
      }
    } catch (e) {
      // henüz kayıtlı tarif yok
    }
  }, []);

  useEffect(() => {
    if (!authUser) return;
    let cancelled = false;
    (async () => {
      await loadRecipeBucket(PERSONAL);
      if (!cancelled) setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [authUser, loadRecipeBucket]);

  useEffect(() => {
    if (!familiesLoaded) return;
    families.forEach((f) => {
      if (!(f.id in recipeBuckets)) loadRecipeBucket(f.id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [familiesLoaded, families]);

  const familyNameById = useMemo(() => {
    const map = {};
    families.forEach((f) => {
      map[f.id] = f.name;
    });
    return map;
  }, [families]);

  // Aynı tarif birden fazla yere (kişisel + bir ya da iki aile) kaydedilebiliyor —
  // her yerde AYNI id'yle saklanıyor. Burada id'ye göre tekilleştirip, o tarifin
  // ait olduğu tüm yerleri "_scopes" dizisinde topluyoruz ki "Yemekler" listesinde
  // aynı yemek birden fazla kez görünmesin.
  const recipes = useMemo(() => {
    const byId = new Map();
    const addFrom = (scopeKey, list) => {
      list.forEach((r) => {
        const existing = byId.get(r.id);
        if (existing) {
          existing._scopes.push(scopeKey);
        } else {
          byId.set(r.id, { ...r, _scopes: [scopeKey] });
        }
      });
    };
    addFrom(PERSONAL, recipeBuckets[PERSONAL] || []);
    families.forEach((f) => addFrom(f.id, recipeBuckets[f.id] || []));
    return Array.from(byId.values());
  }, [recipeBuckets, families]);

  const persistScope = useCallback(async (scopeKey, updatedList) => {
    const cleaned = updatedList.map(({ _scope, _scopes, ...rest }) => rest);
    setRecipeBuckets((prev) => ({ ...prev, [scopeKey]: cleaned }));
    try {
      await bucketSet("recipes", scopeKey, JSON.stringify(cleaned));
    } catch (e) {
      // yazma başarısız olsa da yerel görünüm güncel kalsın
    }
  }, []);

  // Bir tarifin kayıtlı olduğu TÜM yerlere aynı değişikliği uygular (favori,
  // kategori, isim, düzenleme) — sadece bir kopyasını güncelleyip diğerlerini
  // eski hâlde bırakmamak için.
  const applyToAllScopes = useCallback(
    async (id, updater) => {
      const recipe = recipes.find((r) => r.id === id);
      if (!recipe) return;
      await Promise.all(
        recipe._scopes.map((scopeKey) => {
          const list = (recipeBuckets[scopeKey] || []).map((r) => (r.id === id ? updater(r) : r));
          return persistScope(scopeKey, list);
        })
      );
    },
    [recipes, recipeBuckets, persistScope]
  );

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
    if (saveTargets.includes(PERSONAL) && !isPlus && (recipeBuckets[PERSONAL] || []).length >= FREE_RECIPE_LIMIT) {
      setError(`Ücretsiz hesaplarda en fazla ${FREE_RECIPE_LIMIT} kişisel tarif olabilir. Sınırsız eklemek için Plus'a geç.`);
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
      await Promise.all(saveTargets.map((scopeKey) => persistScope(scopeKey, [recipe, ...(recipeBuckets[scopeKey] || [])])));
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
    const recipe = recipes.find((r) => r.id === id);
    if (!recipe) return;
    const removalInfo = recipe._scopes.map((scopeKey) => {
      const list = recipeBuckets[scopeKey] || [];
      const index = list.findIndex((r) => r.id === id);
      return { scopeKey, index, item: list[index] };
    });
    await Promise.all(
      removalInfo.map(({ scopeKey }) => persistScope(scopeKey, (recipeBuckets[scopeKey] || []).filter((r) => r.id !== id)))
    );
    setView("list");

    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    setUndoState({ title: recipe.title, removalInfo });
    undoTimerRef.current = setTimeout(() => setUndoState(null), 6000);
  };

  const handleUndoDelete = async () => {
    if (!undoState) return;
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    await Promise.all(
      undoState.removalInfo.map(({ scopeKey, index, item }) => {
        if (!item) return null;
        const list = [...(recipeBuckets[scopeKey] || [])];
        list.splice(index, 0, item);
        return persistScope(scopeKey, list);
      })
    );
    setUndoState(null);
  };

  const handleRename = async (id, newTitle) => {
    const trimmed = newTitle.trim();
    if (!trimmed) return;
    await applyToAllScopes(id, (r) => ({ ...r, title: trimmed }));
  };

  const handleToggleFavorite = async (id) => {
    await applyToAllScopes(id, (r) => ({ ...r, isFavorite: !r.isFavorite }));
  };

  const handleChangeCategory = async (id, newCategory) => {
    await applyToAllScopes(id, (r) => ({ ...r, category: newCategory }));
  };

  const handleManualSave = async (data) => {
    const recipe = { id: uid(), createdAt: Date.now(), isFavorite: false, addedBy: personName || "", ...data };
    await Promise.all(saveTargets.map((scopeKey) => persistScope(scopeKey, [recipe, ...(recipeBuckets[scopeKey] || [])])));
    setManualPrefill(null);
    setActiveId(recipe.id);
    setView("detail");
  };

  const handleEditSave = async (id, data) => {
    await applyToAllScopes(id, (r) => ({ ...r, ...data }));
    setView("detail");
  };

  const [shoppingInitialContext, setShoppingInitialContext] = useState(PERSONAL);
  const addRecipeToShoppingList = async (recipe) => {
    const scopes = recipe._scopes && recipe._scopes.length ? recipe._scopes : [PERSONAL];
    await Promise.all(
      scopes.map(async (scopeKey) => {
        try {
          const res = await bucketGet("shopping-list", scopeKey);
          const data = res && res.value ? JSON.parse(res.value) : {};
          const selected = data.selected || [];
          if (!selected.includes(recipe.id)) {
            await bucketSet("shopping-list", scopeKey, JSON.stringify({ ...data, selected: [...selected, recipe.id] }));
          }
        } catch (e) {
          // eklenemezse sessizce geç, kullanıcı Alışveriş Listesi'nden elle seçebilir
        }
      })
    );
    setShoppingInitialContext(scopes[0]);
    setView("shopping");
  };

  const active = recipes.find((r) => r.id === activeId);

  if (!authChecked) {
    return (
      <div
        style={{
          width: "100%",
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: COLORS.paper,
        }}
      >
        <Loader2 size={28} color={COLORS.forest} className="spin" />
        <style>{`.spin { animation: spin 1s linear infinite; } @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  if (showAuthGate) {
    return <AuthGate onGuest={handleGuestEntry} />;
  }

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
      {updateAvailable && <UpdateBanner onUpdate={() => window.location.reload()} />}
      <Header view={view} onBack={() => setView("list")} authUser={authUser} onSignOut={handleSignOut} onOpenMenu={() => setMenuOpen(true)} />

      <SideMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        isPlus={isPlus}
        onNavigate={(target) => {
          if (target === "favorites") {
            setView(target);
          } else {
            setModalView(target);
          }
          setMenuOpen(false);
        }}
      />

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
            isPlus={isPlus}
            familyNameById={familyNameById}
            onSelect={(id) => {
              setActiveId(id);
              setView("detail");
            }}
            onAdd={() => {
              setError("");
              setSaveTargets([PERSONAL]);
              setView((v) => (v === "add" ? "list" : "add"));
            }}
            onManual={() => {
              setManualPrefill(null);
              setSaveTargets([PERSONAL]);
              setView((v) => (v === "manual" ? "list" : "manual"));
            }}
            onPantry={() => setView((v) => (v === "pantry" ? "list" : "pantry"))}
            onShopping={() => setView((v) => (v === "shopping" ? "list" : "shopping"))}
            onToggleFavorite={handleToggleFavorite}
            onDelete={handleDelete}
            onSendNotification={handleSendNotification}
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
              saveTargets={saveTargets}
              setSaveTargets={setSaveTargets}
              isPlus={isPlus}
              families={families}
              onSubmit={handleExtract}
              onCancel={() => setView("list")}
            />
          )}

          {view === "manual" && (
            <RecipeEditor
              heading="Yeni Tarif Oluştur"
              initial={manualPrefill}
              isNew
              saveTargets={saveTargets}
              setSaveTargets={setSaveTargets}
              isPlus={isPlus}
              families={families}
              personalCount={(recipeBuckets[PERSONAL] || []).length}
              onSave={handleManualSave}
              onCancel={() => {
                setManualPrefill(null);
                setView("list");
              }}
            />
          )}

          {view === "edit" && active && (
            <RecipeEditor
              heading="Tarifi Düzenle"
              initial={active}
              isPlus={isPlus}
              families={families}
              onSave={(data) => handleEditSave(active.id, data)}
              onCancel={() => setView("detail")}
            />
          )}

          {view === "detail" && active && (
            <RecipeDetail
              recipe={active}
              familyNameById={familyNameById}
              onDelete={() => handleDelete(active.id)}
              onRename={(newTitle) => handleRename(active.id, newTitle)}
              onToggleFavorite={() => handleToggleFavorite(active.id)}
              onChangeCategory={(cat) => handleChangeCategory(active.id, cat)}
              onEdit={() => setView("edit")}
              onAddToShopping={() => addRecipeToShoppingList(active)}
              onSendNotification={() => handleSendNotification(active)}
            />
          )}

          {view === "shopping" && (
            <ShoppingList key={shoppingInitialContext} recipes={recipes} isPlus={isPlus} families={families} initialContext={shoppingInitialContext} />
          )}

          {view === "pantry" && (
            <PantryFinder
              recipes={recipes}
              isPlus={isPlus}
              families={families}
              onSelectRecipe={(id) => {
                setActiveId(id);
                setView("detail");
              }}
              onCreateFromSuggestion={(suggestion) => {
                setManualPrefill({
                  title: suggestion.title,
                  ingredients: suggestion.ingredients || [],
                  instructions: suggestion.instructions || [],
                });
                setSaveTargets([PERSONAL]);
                setView("manual");
              }}
            />
          )}

          {view === "favorites" && (
            <FavoritesView
              recipes={recipes}
              familyNameById={familyNameById}
              onSelect={(id) => {
                setActiveId(id);
                setView("detail");
              }}
            />
          )}
        </main>
      </div>

      {modalView === "families" && (
        <ModalSheet title="Aileler" onClose={() => setModalView(null)}>
          <FamiliesView
            isPlus={isPlus}
            families={families}
            personName={personName}
            currentUid={authUser?.uid}
            onReload={loadFamiliesState}
            onOpenPlus={() => setModalView("plus")}
            onImportFamily={(familyId) => loadRecipeBucket(familyId)}
          />
        </ModalSheet>
      )}

      {modalView === "plus" && (
        <ModalSheet title="Plus" onClose={() => setModalView(null)}>
          <PlusView
            isPlus={isPlus}
            onToggle={async (next) => {
              await setPlusFlag(next);
              await loadFamiliesState();
            }}
          />
        </ModalSheet>
      )}

      {modalView === "account" && (
        <ModalSheet title="Hesabım" onClose={() => setModalView(null)}>
          <AccountView
            authUser={authUser}
            personName={personName}
            onSignOut={handleSignOut}
            onImportPersonal={() => loadRecipeBucket(PERSONAL)}
          />
        </ModalSheet>
      )}

      {modalView === "settings" && (
        <ModalSheet title="Ayarlar" onClose={() => setModalView(null)}>
          <SettingsView personName={personName} nameDraft={nameDraft} setNameDraft={setNameDraft} onSaveName={handleSaveName} />
        </ModalSheet>
      )}

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
          <span>"{undoState.title || "İsimsiz tarif"}" silindi.</span>
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

function Header({ view, onBack, authUser, onSignOut, onOpenMenu }) {
  return (
    <header style={{ width: "100%", background: COLORS.forest, position: "relative" }}>
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
          {authUser && !authUser.isAnonymous && (
            <button
              onClick={onSignOut}
              aria-label="Çıkış yap"
              title={authUser.email ? `${authUser.email} · Çıkış yap` : "Çıkış yap"}
              style={{
                position: "absolute",
                top: "16px",
                right: "16px",
                display: "flex",
                alignItems: "center",
                gap: "4px",
                padding: "6px 10px",
                borderRadius: "9999px",
                background: "rgba(243,239,230,0.12)",
                border: "none",
                color: "#F3EFE6",
                fontSize: "12px",
                cursor: "pointer",
              }}
            >
              <LogOut size={13} />
            </button>
          )}
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
            <button
              onClick={onOpenMenu}
              aria-label="Menüyü aç"
              style={{ padding: "9px", borderRadius: "9999px", background: COLORS.mustard, border: "none", cursor: "pointer", display: "flex" }}
            >
              <ChefHat size={17} color={COLORS.forestDark} />
            </button>
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

function SideMenu({ open, onClose, isPlus, onNavigate }) {
  const items = [
    { key: "account", label: "Hesabım", icon: UserCircle },
    { key: "favorites", label: "Favoriler", icon: Star },
    { key: "families", label: "Aileler", icon: Users },
    { key: "plus", label: "Plus", icon: Crown },
    { key: "settings", label: "Ayarlar", icon: Settings },
  ];

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(42,38,32,0.45)",
          opacity: open ? 1 : 0,
          pointerEvents: open ? "auto" : "none",
          transition: "opacity 220ms ease",
          zIndex: 70,
        }}
      />
      <div
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          bottom: 0,
          width: "260px",
          maxWidth: "80vw",
          background: COLORS.paper,
          boxShadow: "4px 0 24px rgba(0,0,0,0.25)",
          transform: open ? "translateX(0)" : "translateX(-100%)",
          transition: "transform 240ms ease",
          zIndex: 71,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div style={{ background: COLORS.forest, padding: "22px 20px 16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <div style={{ padding: "8px", borderRadius: "9999px", background: COLORS.mustard }}>
              <ChefHat size={16} color={COLORS.forestDark} />
            </div>
            <span style={{ fontFamily: SERIF, fontSize: "18px", color: "#F8F5EC" }}>Tarif Kutusu</span>
            {isPlus && (
              <span
                style={{
                  marginLeft: "auto",
                  display: "flex",
                  alignItems: "center",
                  gap: "4px",
                  fontSize: "10px",
                  fontWeight: 700,
                  color: COLORS.forestDark,
                  background: COLORS.mustard,
                  padding: "3px 8px",
                  borderRadius: "9999px",
                }}
              >
                <Crown size={10} /> PLUS
              </span>
            )}
          </div>
        </div>
        <div style={{ height: "3px", background: `linear-gradient(90deg, ${COLORS.mustard}, ${COLORS.mustard} 60%, transparent)`, flexShrink: 0 }} />
        <nav style={{ display: "flex", flexDirection: "column", padding: "14px 10px" }}>
          {items.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => onNavigate(key)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "12px",
                padding: "12px 12px",
                borderRadius: "8px",
                background: "transparent",
                border: "none",
                color: COLORS.ink,
                fontFamily: BODY,
                fontSize: "14px",
                fontWeight: 500,
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              <Icon size={17} color={key === "plus" ? COLORS.mustardDark : COLORS.forest} />
              {label}
            </button>
          ))}
        </nav>
      </div>
    </>
  );
}

function ModalSheet({ title, onClose, children }) {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 80, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div
        onClick={onClose}
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(42,38,32,0.45)",
          backdropFilter: "blur(4px)",
          WebkitBackdropFilter: "blur(4px)",
        }}
      />
      <div
        style={{
          position: "relative",
          width: "100%",
          maxWidth: "560px",
          height: "92vh",
          background: COLORS.paper,
          borderRadius: "20px 20px 0 0",
          boxShadow: "0 -8px 40px rgba(0,0,0,0.3)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
        className="md-modal-sheet"
      >
        <style>{`
          @media (min-width: 768px) {
            .md-modal-sheet { height: 88vh !important; border-radius: 20px !important; margin-bottom: 24px; }
          }
        `}</style>
        <div style={{ flexShrink: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "18px 20px",
              background: COLORS.forest,
              borderRadius: "20px 20px 0 0",
            }}
          >
            <h2 style={{ fontFamily: SERIF, fontSize: "19px", color: "#F8F5EC", margin: 0 }}>{title}</h2>
            <button
              onClick={onClose}
              aria-label="Kapat"
              style={{ background: "rgba(243,239,230,0.12)", border: "none", borderRadius: "9999px", cursor: "pointer", color: "#F3EFE6", padding: "6px", display: "flex" }}
            >
              <X size={18} />
            </button>
          </div>
          <div style={{ height: "3px", background: `linear-gradient(90deg, ${COLORS.mustard}, ${COLORS.mustard} 60%, transparent)` }} />
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "20px" }}>{children}</div>
      </div>
    </div>
  );
}

function AuthGate({ onGuest }) {
  const [mode, setMode] = useState("login"); // "login" | "signup"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

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
    marginBottom: "10px",
  };

  const handleGoogle = async () => {
    setError("");
    setBusy(true);
    try {
      await googleSignIn();
    } catch (e) {
      setError(e.code ? mapAuthError(e.code) : e.message);
    } finally {
      setBusy(false);
    }
  };

  const handleGuestClick = async () => {
    setError("");
    setBusy(true);
    try {
      await onGuest();
    } catch (e) {
      setError("Misafir girişi başarısız oldu, tekrar dener misin?");
    } finally {
      setBusy(false);
    }
  };

  const handleEmailSubmit = async (e) => {
    e.preventDefault();
    setError("");
    if (!email.trim() || !password) {
      setError("E-posta ve şifreni gir.");
      return;
    }
    setBusy(true);
    try {
      if (mode === "signup") {
        await createUserWithEmailAndPassword(auth, email.trim(), password);
      } else {
        await signInWithEmailAndPassword(auth, email.trim(), password);
      }
    } catch (e) {
      setError(mapAuthError(e.code));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        width: "100%",
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: COLORS.paper,
        padding: "20px",
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: "360px",
          background: COLORS.panel,
          borderRadius: "16px",
          padding: "32px 28px",
          boxShadow: CARD_SHADOW,
          textAlign: "center",
        }}
      >
        <div
          style={{
            width: "48px",
            height: "48px",
            borderRadius: "9999px",
            background: COLORS.mustard,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            margin: "0 auto 14px",
          }}
        >
          <ChefHat size={22} color={COLORS.forestDark} />
        </div>
        <h1 style={{ fontFamily: SERIF, fontSize: "22px", color: COLORS.ink, margin: "0 0 6px" }}>
          Tarif Kutusu
        </h1>
        <p style={{ fontSize: "13px", color: COLORS.inkSoft, margin: "0 0 22px" }}>
          {mode === "login" ? "Hesabınla giriş yap." : "Google ile ya da e-postayla hemen bir hesap aç."}
        </p>

        {mode === "signup" && (
          <>
            <button
              type="button"
              onClick={handleGoogle}
              disabled={busy}
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
                cursor: busy ? "default" : "pointer",
                opacity: busy ? 0.6 : 1,
                marginBottom: "14px",
              }}
            >
              <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
                <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 6.1 29.6 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.7-.4-3.5z"/>
                <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.6 15.9 18.9 13 24 13c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 6.1 29.6 4 24 4 16.2 4 9.5 8.4 6.3 14.7z"/>
                <path fill="#4CAF50" d="M24 44c5.5 0 10.4-1.9 14.3-5.1l-6.6-5.4C29.6 35.4 26.9 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.6 5.1C9.4 39.6 16.1 44 24 44z"/>
                <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.2 4.2-4 5.5l6.6 5.4C41.5 36 44 30.5 44 24c0-1.3-.1-2.7-.4-3.5z"/>
              </svg>
              Google ile Kaydol
            </button>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", margin: "0 0 14px" }}>
              <div style={{ flex: 1, height: "1px", background: COLORS.line }} />
              <span style={{ fontSize: "11px", color: COLORS.inkSoft }}>veya e-postayla</span>
              <div style={{ flex: 1, height: "1px", background: COLORS.line }} />
            </div>
          </>
        )}

        <form onSubmit={handleEmailSubmit}>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="E-posta"
            autoComplete="email"
            style={inputStyle}
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Şifre"
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            style={inputStyle}
          />

          {error && (
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: "6px",
                fontSize: "13px",
                padding: "8px 10px",
                borderRadius: "8px",
                background: "#F5E4E0",
                color: COLORS.danger,
                marginBottom: "12px",
                textAlign: "left",
              }}
            >
              <AlertCircle size={14} style={{ marginTop: "2px", flexShrink: 0 }} />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
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
              background: COLORS.mustard,
              color: COLORS.forestDark,
              border: "none",
              cursor: busy ? "default" : "pointer",
              opacity: busy ? 0.6 : 1,
            }}
          >
            {busy ? <Loader2 size={16} className="spin" /> : <Mail size={15} />}
            {mode === "signup" ? "E-posta ile Kaydol" : "Giriş Yap"}
          </button>
        </form>

        <button
          type="button"
          onClick={() => {
            setError("");
            setMode((m) => (m === "login" ? "signup" : "login"));
          }}
          style={{
            marginTop: "16px",
            background: "transparent",
            border: "none",
            color: COLORS.forest,
            fontSize: "13px",
            fontWeight: 600,
            cursor: "pointer",
            textDecoration: "underline",
          }}
        >
          {mode === "login" ? "Hesabın yok mu? Kaydol" : "Zaten hesabın var mı? Giriş yap"}
        </button>

        <div style={{ height: "1px", background: COLORS.line, margin: "20px 0 14px" }} />

        <button
          type="button"
          onClick={handleGuestClick}
          disabled={busy}
          style={{
            width: "100%",
            padding: "10px 16px",
            borderRadius: "8px",
            fontSize: "13px",
            fontWeight: 600,
            background: "transparent",
            color: COLORS.inkSoft,
            border: `1px solid ${COLORS.line}`,
            cursor: busy ? "default" : "pointer",
            opacity: busy ? 0.6 : 1,
          }}
        >
          Misafir Olarak Gir
        </button>
      </div>
      <style>{`.spin { animation: spin 1s linear infinite; } @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// Bir tarif hem kişisel hem bir ya da iki ailede kayıtlı olabilir — hepsini
// okunabilir isimlere çeviriyor (örn. ["Kişisel", "Yılmazlar"]).
function scopeLabels(recipe, familyNameById) {
  const scopes = recipe._scopes || [recipe._scope];
  return scopes.map((s) => (s === PERSONAL ? "Kişisel" : familyNameById?.[s] || "Aile"));
}

function Sidebar({ recipes, loaded, activeId, isPlus, familyNameById, onSelect, onAdd, onManual, onPantry, onShopping, onToggleFavorite, onDelete, onSendNotification }) {
  const [listOpen, setListOpen] = useState(true);
  const [openCats, setOpenCats] = useState({});
  const [favOpen, setFavOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [longPressId, setLongPressId] = useState(null);
  const [quickNotify, setQuickNotify] = useState({ id: null, status: "idle" }); // "idle" | "sending" | "sent" | "error"
  const pressTimerRef = useRef(null);
  const longPressFiredRef = useRef(false);

  const startPress = (r) => {
    if (!isFamilyRecipeScope(r)) return;
    longPressFiredRef.current = false;
    pressTimerRef.current = setTimeout(() => {
      longPressFiredRef.current = true;
      setLongPressId(r.id);
    }, 500);
  };
  const cancelPress = () => {
    if (pressTimerRef.current) {
      clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
  };
  const handleQuickNotify = async (r) => {
    if (quickNotify.id === r.id && quickNotify.status === "sending") return;
    setQuickNotify({ id: r.id, status: "sending" });
    try {
      await onSendNotification(r);
      setQuickNotify({ id: r.id, status: "sent" });
      setTimeout(() => {
        setQuickNotify({ id: null, status: "idle" });
        setLongPressId(null);
      }, 1500);
    } catch (e) {
      setQuickNotify({ id: r.id, status: "error" });
      setTimeout(() => setQuickNotify({ id: null, status: "idle" }), 2000);
    }
  };

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
    const isFam = isFamilyRecipeScope(r);
    const notifyOpen = isFam && longPressId === r.id;
    const notifyStatus = quickNotify.id === r.id ? quickNotify.status : "idle";
    return (
      <div key={r.id} style={{ borderRadius: "6px", overflow: "hidden" }}>
        <div
          onPointerDown={() => startPress(r)}
          onPointerUp={cancelPress}
          onPointerLeave={cancelPress}
          onPointerCancel={cancelPress}
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
            onClick={() => {
              if (longPressFiredRef.current) {
                longPressFiredRef.current = false;
                return;
              }
              onSelect(r.id);
            }}
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
              {(() => {
                const labels = scopeLabels(r, familyNameById).filter((l) => l !== "Kişisel");
                return labels.length > 0 ? `${labels.join(" + ")} · ` : "";
              })()}
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
        {isFam && (
          <div style={{ display: "grid", gridTemplateRows: notifyOpen ? "1fr" : "0fr", transition: "grid-template-rows 220ms ease" }}>
            <div style={{ overflow: "hidden" }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  padding: "6px 8px 8px",
                  marginTop: "2px",
                  borderRadius: "6px",
                  border: `1px solid ${COLORS.line}`,
                  background: COLORS.panel,
                }}
              >
                <button
                  onClick={() => handleQuickNotify(r)}
                  disabled={notifyStatus === "sending"}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                    padding: "6px 10px",
                    borderRadius: "9999px",
                    border: "none",
                    background: "transparent",
                    color: notifyStatus === "error" ? COLORS.danger : notifyStatus === "sent" ? COLORS.forest : COLORS.mustardDark,
                    fontSize: "12px",
                    fontWeight: 600,
                    cursor: notifyStatus === "sending" ? "default" : "pointer",
                    opacity: notifyStatus === "sending" ? 0.5 : 1,
                  }}
                >
                  {notifyStatus === "sending" ? (
                    <Loader2 size={15} className="spin" />
                  ) : notifyStatus === "sent" ? (
                    <Check size={15} />
                  ) : (
                    <Bell size={15} />
                  )}
                  {notifyStatus === "sent"
                    ? "Bildirim gönderildi"
                    : notifyStatus === "error"
                    ? "Bildirim gönderilemedi"
                    : "Canımın çektiğini bildir"}
                </button>
                <button
                  onClick={() => setLongPressId(null)}
                  aria-label="Kapat"
                  style={{ marginLeft: "auto", padding: "6px", background: "transparent", border: "none", color: COLORS.inkSoft, cursor: "pointer" }}
                >
                  <X size={13} />
                </button>
              </div>
            </div>
          </div>
        )}
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
            Yemekler{" "}
            {isPlus ? (
              recipes.length > 0 ? <span style={{ color: COLORS.inkSoft, fontSize: "15px" }}>({recipes.length})</span> : ""
            ) : (
              <span style={{ color: COLORS.inkSoft, fontSize: "15px" }}>
                ({recipes.length}/{FREE_RECIPE_LIMIT})
              </span>
            )}
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

function SaveTargetPicker({ saveTargets, setSaveTargets, isPlus, families }) {
  const options = [
    { key: PERSONAL, label: "Kişisel Tariflerim" },
    ...(isPlus ? families.map((f) => ({ key: f.id, label: f.name })) : []),
  ];

  const toggle = (key) => {
    setSaveTargets((prev) => {
      if (prev.includes(key)) {
        const next = prev.filter((k) => k !== key);
        return next.length === 0 ? prev : next; // en az bir yer seçili kalmalı
      }
      return [...prev, key];
    });
  };

  return (
    <>
      <label
        style={{
          display: "block",
          fontSize: "11px",
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color: COLORS.inkSoft,
          marginBottom: "6px",
        }}
      >
        Kaydetme yeri {options.length > 1 && <span style={{ textTransform: "none", fontWeight: 400 }}>(birden fazla seçebilirsin)</span>}
      </label>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginBottom: "16px" }}>
        {options.map((opt) => {
          const selected = saveTargets.includes(opt.key);
          return (
            <button
              key={opt.key}
              type="button"
              onClick={() => toggle(opt.key)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
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
              {selected && <Check size={13} />}
              {opt.label}
            </button>
          );
        })}
      </div>
    </>
  );
}

function AddForm({ link, caption, notes, images, category, busy, error, setLink, setCaption, setNotes, setImages, setCategory, saveTargets, setSaveTargets, isPlus, families, onSubmit, onCancel }) {
  const [fetchingCaption, setFetchingCaption] = useState(false);
  const [captionFetchError, setCaptionFetchError] = useState("");
  const fetchedForLinkRef = React.useRef("");

  const tryAutoFetchCaption = useCallback(async (rawLink) => {
    const trimmed = (rawLink || "").trim();
    if (!trimmed || !/^https?:\/\//i.test(trimmed) || !/tiktok\.com|youtu\.be|youtube\.com|instagram\.com/i.test(trimmed)) return;
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
          placeholder="https://www.tiktok.com/... veya instagram.com/... veya youtube.com/..."
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

      <SaveTargetPicker saveTargets={saveTargets} setSaveTargets={setSaveTargets} isPlus={isPlus} families={families} />

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

function RecipeDetail({ recipe, familyNameById, onDelete, onRename, onToggleFavorite, onChangeCategory, onEdit, onAddToShopping, onSendNotification }) {
  const { title, servings, category, prep_time_minutes, difficulty, ingredients = [], instructions = [], nutrition = {}, assumptions, link, isFavorite, addedBy } = recipe;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title || "");
  const [notifyState, setNotifyState] = useState("idle"); // "idle" | "sending" | "sent" | "error"

  const isFamilyRecipe = isFamilyRecipeScope(recipe);

  const handleNotifyClick = async () => {
    if (notifyState === "sending") return;
    setNotifyState("sending");
    try {
      await onSendNotification();
      setNotifyState("sent");
      setTimeout(() => setNotifyState("idle"), 2500);
    } catch (e) {
      setNotifyState("error");
      setTimeout(() => setNotifyState("idle"), 2500);
    }
  };

  useEffect(() => {
    setDraft(title || "");
    setEditing(false);
  }, [title]);

  const commit = () => {
    if (draft.trim() && draft.trim() !== title) onRename(draft.trim());
    setEditing(false);
  };

  const hasValidCategory = CATEGORIES.includes(category);
  const scopeLabel = scopeLabels(recipe, familyNameById).join(" + ");

  const metaParts = [
    servings ? `${servings} porsiyon` : null,
    hasValidCategory ? category : null,
    prep_time_minutes ? `${prep_time_minutes} dk` : null,
    difficulty || null,
    addedBy ? `Ekleyen: ${addedBy}` : null,
    scopeLabel,
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
            {isFamilyRecipe && (
              <button
                onClick={handleNotifyClick}
                disabled={notifyState === "sending"}
                aria-label="Bildirim gönder"
                title={
                  notifyState === "sent"
                    ? "Bildirim gönderildi"
                    : notifyState === "error"
                    ? "Bildirim gönderilemedi"
                    : "Ailene bu yemeği canının çektiğini bildir"
                }
                style={{
                  padding: "8px",
                  borderRadius: "8px",
                  background: "transparent",
                  border: "none",
                  color: notifyState === "error" ? COLORS.danger : notifyState === "sent" ? COLORS.forest : COLORS.mustardDark,
                  cursor: notifyState === "sending" ? "default" : "pointer",
                  opacity: notifyState === "sending" ? 0.5 : 1,
                }}
              >
                {notifyState === "sending" ? (
                  <Loader2 size={18} className="spin" />
                ) : notifyState === "sent" ? (
                  <Check size={18} />
                ) : (
                  <Bell size={18} />
                )}
              </button>
            )}
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

        <button
          onClick={onAddToShopping}
          style={{
            marginTop: "8px",
            width: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "8px",
            padding: "10px 16px",
            borderRadius: "8px",
            fontSize: "13px",
            fontWeight: 600,
            background: COLORS.forest,
            color: "#F3EFE6",
            border: "none",
            cursor: "pointer",
          }}
        >
          <ShoppingCart size={14} />
          Alışveriş Listesine Ekle
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

function normalizeIngredientName(name) {
  return (name || "").toLocaleLowerCase("tr").trim().replace(/\s+/g, " ");
}

function parseAmount(amount) {
  const m = /^([\d.,]+)\s*(.*)$/.exec((amount || "").trim());
  if (!m) return null;
  const num = parseFloat(m[1].replace(",", "."));
  if (Number.isNaN(num)) return null;
  return { num, unit: m[2].trim().toLocaleLowerCase("tr") };
}

// Aynı malzeme farklı tariflerde geçiyorsa (aynı ada normalize edilince) tek satırda
// birleştiriyor: aynı birimdeki miktarları toplar, farklı/okunaksız miktarları "+" ile yan yana yazar.
function mergeIngredients(chosenRecipes) {
  const map = new Map();
  chosenRecipes.forEach((r) => {
    (r.ingredients || []).forEach((ing) => {
      const key = normalizeIngredientName(ing.name);
      if (!key) return;
      if (!map.has(key)) map.set(key, { name: ing.name, parts: [] });
      map.get(key).parts.push(ing.amount || "");
    });
  });
  return Array.from(map.entries()).map(([key, { name, parts }]) => {
    const byUnit = new Map();
    const others = [];
    parts.forEach((p) => {
      const parsed = parseAmount(p);
      if (parsed) {
        byUnit.set(parsed.unit, (byUnit.get(parsed.unit) || 0) + parsed.num);
      } else if (p.trim()) {
        others.push(p.trim());
      }
    });
    const amountParts = [
      ...Array.from(byUnit.entries()).map(([unit, sum]) => `${Number.isInteger(sum) ? sum : sum.toFixed(1)}${unit ? " " + unit : ""}`),
      ...others,
    ];
    return { key, name, amount: amountParts.join(" + ") };
  });
}

function ContextTabs({ context, setContext, isPlus, families }) {
  const contexts = [{ key: PERSONAL, label: "Kişisel" }, ...(isPlus ? families.map((f) => ({ key: f.id, label: f.name })) : [])];
  if (contexts.length <= 1) return null;
  return (
    <div style={{ display: "flex", gap: "6px", marginBottom: "16px", flexWrap: "wrap" }}>
      {contexts.map((c) => {
        const selected = context === c.key;
        return (
          <button
            key={c.key}
            onClick={() => setContext(c.key)}
            style={{
              padding: "6px 14px",
              borderRadius: "9999px",
              fontSize: "12px",
              fontWeight: 700,
              border: `1px solid ${selected ? COLORS.forest : COLORS.line}`,
              background: selected ? COLORS.forest : "transparent",
              color: selected ? "#F3EFE6" : COLORS.inkSoft,
              cursor: "pointer",
            }}
          >
            {c.label}
          </button>
        );
      })}
    </div>
  );
}

function ShoppingList({ recipes, isPlus, families, initialContext }) {
  const [context, setContext] = useState(initialContext || PERSONAL);
  const [selected, setSelected] = useState([]);
  const [checked, setChecked] = useState({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    (async () => {
      try {
        const res = await bucketGet("shopping-list", context);
        if (!cancelled) {
          const data = res && res.value ? JSON.parse(res.value) : {};
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
  }, [context]);

  const persist = useCallback(
    async (nextSelected, nextChecked) => {
      setSelected(nextSelected);
      setChecked(nextChecked);
      try {
        await bucketSet("shopping-list", context, JSON.stringify({ selected: nextSelected, checked: nextChecked }));
      } catch (e) {
        // yazma başarısız olsa da yerel görünüm güncel kalsın
      }
    },
    [context]
  );

  // Bir tarif birden fazla yere (kişisel + aile) kaydedilmiş olabilir — hangi
  // context'te olursak olalım, o context'e ait olan tariflerin hepsi seçilebilir.
  const contextRecipes = recipes.filter((r) => (r._scopes || [r._scope]).includes(context));

  const toggleSelect = (id) => {
    const next = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
    persist(next, checked);
  };

  const toggleChecked = (key) => {
    persist(selected, { ...checked, [key]: !checked[key] });
  };

  const clearChecked = () => persist(selected, {});

  const chosenRecipes = contextRecipes.filter((r) => selected.includes(r.id));
  const mergedIngredients = mergeIngredients(chosenRecipes);
  const checkedCount = mergedIngredients.filter((i) => checked[i.key]).length;

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

        <ContextTabs context={context} setContext={setContext} isPlus={isPlus} families={families} />

        {!loaded ? (
          <p style={{ fontSize: "14px", color: COLORS.inkSoft, margin: 0 }}>Yükleniyor…</p>
        ) : contextRecipes.length === 0 ? (
          <p style={{ fontSize: "14px", color: COLORS.inkSoft, margin: 0 }}>Bu listede henüz kayıtlı tarif yok.</p>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
            {contextRecipes.map((r) => {
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
                ({checkedCount}/{mergedIngredients.length} alındı)
              </span>
            </h3>
            <button
              onClick={clearChecked}
              style={{ fontSize: "12px", color: COLORS.inkSoft, background: "transparent", border: "none", cursor: "pointer", textDecoration: "underline" }}
            >
              İşaretleri temizle
            </button>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            {mergedIngredients.map((ing) => {
              const isChecked = !!checked[ing.key];
              return (
                <label key={ing.key} style={{ display: "flex", alignItems: "center", gap: "10px", cursor: "pointer", padding: "4px 0" }}>
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => toggleChecked(ing.key)}
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
            })}
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

function RecipeEditor({ heading, initial, isNew, saveTargets, setSaveTargets, isPlus, families, personalCount, onSave, onCancel }) {
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
    if (isNew && saveTargets.includes(PERSONAL) && !isPlus && personalCount >= FREE_RECIPE_LIMIT) {
      setError(`Ücretsiz hesaplarda en fazla ${FREE_RECIPE_LIMIT} kişisel tarif olabilir. Sınırsız eklemek için Plus'a geç.`);
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

        {isNew && <SaveTargetPicker saveTargets={saveTargets} setSaveTargets={setSaveTargets} isPlus={isPlus} families={families} />}

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

function PantryFinder({ recipes, isPlus, families, onSelectRecipe, onCreateFromSuggestion }) {
  const [context, setContext] = useState(PERSONAL);
  const [items, setItems] = useState([]);
  const [draft, setDraft] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [suggestions, setSuggestions] = useState(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    (async () => {
      try {
        const res = await bucketGet("pantry-items", context);
        if (!cancelled) setItems(res && res.value ? JSON.parse(res.value) : []);
      } catch (e) {
        // henüz kayıtlı malzeme yok
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [context]);

  const persistItems = useCallback(
    async (next) => {
      setItems(next);
      try {
        await bucketSet("pantry-items", context, JSON.stringify(next));
      } catch (e) {
        // yazma başarısız olsa da yerel görünüm güncel kalsın
      }
    },
    [context]
  );

  const handleSuggest = async () => {
    setSuggesting(true);
    setSuggestError("");
    setSuggestions(null);
    try {
      const data = await suggestFromPantry(items);
      setSuggestions(data.suggestions || []);
    } catch (e) {
      setSuggestError(e.message || "Öneriler alınamadı, tekrar dener misin?");
    } finally {
      setSuggesting(false);
    }
  };

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

  const contextRecipes = recipes.filter((r) => (r._scopes || [r._scope]).includes(context));

  const results = contextRecipes
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

        <ContextTabs context={context} setContext={setContext} isPlus={isPlus} families={families} />

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

      {items.length > 0 && (
        <div style={{ borderRadius: "14px", border: `1px solid ${COLORS.mustard}`, background: COLORS.panel, padding: "24px", boxShadow: CARD_SHADOW }}>
          <h3 style={{ fontFamily: SERIF, fontSize: "17px", color: COLORS.ink, margin: "0 0 4px", display: "flex", alignItems: "center", gap: "8px" }}>
            <Sparkles size={16} color={COLORS.mustardDark} />
            AI'dan Tarif Fikri İste
          </h3>
          <p style={{ fontSize: "13px", color: COLORS.inkSoft, margin: "0 0 14px" }}>
            Kayıtlı tariflerinle eşleşme bulunmasa da, elindeki malzemelerle yapay zekadan yeni fikirler isteyebilirsin.
          </p>
          <button
            onClick={handleSuggest}
            disabled={suggesting}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              padding: "10px 16px",
              borderRadius: "8px",
              fontSize: "13px",
              fontWeight: 700,
              background: COLORS.mustard,
              color: COLORS.forestDark,
              border: "none",
              cursor: suggesting ? "default" : "pointer",
              opacity: suggesting ? 0.6 : 1,
            }}
          >
            {suggesting ? <Loader2 size={15} className="spin" /> : <Sparkles size={15} />}
            {suggesting ? "Düşünülüyor…" : "Fikir İste"}
          </button>

          {suggestError && (
            <div style={{ fontSize: "13px", color: COLORS.danger, marginTop: "12px" }}>{suggestError}</div>
          )}

          {suggestions && suggestions.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginTop: "16px" }}>
              {suggestions.map((s, i) => (
                <div key={i} style={{ borderRadius: "10px", border: `1px solid ${COLORS.line}`, padding: "14px" }}>
                  <div style={{ fontFamily: SERIF, fontSize: "16px", color: COLORS.ink, marginBottom: "4px" }}>{s.title}</div>
                  {s.why && <div style={{ fontSize: "13px", color: COLORS.inkSoft, marginBottom: "6px" }}>{s.why}</div>}
                  {s.extra_needed && s.extra_needed.length > 0 && (
                    <div style={{ fontSize: "12px", color: COLORS.mustardDark, marginBottom: "8px" }}>
                      Ekstra gerekli: {s.extra_needed.join(", ")}
                    </div>
                  )}
                  <button
                    onClick={() => onCreateFromSuggestion(s)}
                    style={{
                      fontSize: "12px",
                      fontWeight: 700,
                      color: COLORS.forest,
                      background: "transparent",
                      border: `1px solid ${COLORS.forest}`,
                      borderRadius: "8px",
                      padding: "6px 12px",
                      cursor: "pointer",
                    }}
                  >
                    Bu Tarifi Kaydet
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FavoritesView({ recipes, familyNameById, onSelect }) {
  const favorites = recipes.filter((r) => r.isFavorite);
  return (
    <div style={{ borderRadius: "14px", border: `1px solid ${COLORS.line}`, background: COLORS.panel, padding: "24px", boxShadow: CARD_SHADOW }}>
      <h2 style={{ fontFamily: SERIF, fontSize: "20px", color: COLORS.ink, margin: "0 0 4px", display: "flex", alignItems: "center", gap: "8px" }}>
        <Star size={19} color={COLORS.mustard} fill={COLORS.mustard} />
        Favoriler
      </h2>
      <p style={{ fontSize: "14px", color: COLORS.inkSoft, margin: "0 0 16px" }}>Yıldızladığın tüm tarifler burada.</p>
      {favorites.length === 0 ? (
        <p style={{ fontSize: "14px", color: COLORS.inkSoft, margin: 0 }}>Henüz favori tarifin yok.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {favorites.map((r) => (
            <button
              key={r.id}
              onClick={() => onSelect(r.id)}
              style={{
                textAlign: "left",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "12px",
                padding: "12px 14px",
                borderRadius: "10px",
                border: `1px solid ${COLORS.line}`,
                background: COLORS.paper,
                cursor: "pointer",
              }}
            >
              <span style={{ fontFamily: SERIF, fontSize: "15px", color: COLORS.ink }}>{r.title || "İsimsiz tarif"}</span>
              <span style={{ fontSize: "12px", color: COLORS.inkSoft, flexShrink: 0 }}>
                {scopeLabels(r, familyNameById).join(" + ")}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function FamiliesView({ isPlus, families, personName, currentUid, onReload, onOpenPlus, onImportFamily }) {
  const [nameDraft, setNameDraft] = useState("");
  const [codeDraft, setCodeDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [importState, setImportState] = useState({});
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  // Plus kapatılmış ama hâlâ üyesi olduğu aileler varsa (ör. Plus'ı kapattı), onları
  // görüp ayrılabilsin diye upsell sadece hiç ailesi yoksa tam ekran gösteriliyor.
  if (!isPlus && families.length === 0) {
    return (
      <div style={{ borderRadius: "14px", border: `1px solid ${COLORS.line}`, background: COLORS.panel, padding: "28px", boxShadow: CARD_SHADOW, textAlign: "center" }}>
        <Users size={26} color={COLORS.forest} style={{ marginBottom: "10px" }} />
        <h2 style={{ fontFamily: SERIF, fontSize: "18px", color: COLORS.ink, margin: "0 0 8px" }}>Aile özelliği Plus'a özel</h2>
        <p style={{ fontSize: "14px", color: COLORS.inkSoft, margin: "0 0 16px" }}>
          Bir aile oluşturup tariflerini ev halkınla paylaşmak için Plus'a geçmen gerekiyor.
        </p>
        <button
          onClick={onOpenPlus}
          style={{ padding: "10px 18px", borderRadius: "8px", fontWeight: 700, background: COLORS.mustard, color: COLORS.forestDark, border: "none", cursor: "pointer" }}
        >
          Plus'ı İncele
        </button>
      </div>
    );
  }

  const atLimit = families.length >= MAX_FAMILIES;
  const inputStyle = {
    flex: 1,
    minWidth: 0,
    borderRadius: "8px",
    border: `1px solid ${COLORS.line}`,
    background: COLORS.paper,
    color: COLORS.ink,
    padding: "10px 12px",
    fontSize: "14px",
    outline: "none",
    boxSizing: "border-box",
  };

  const handleCreate = async () => {
    setError("");
    if (!nameDraft.trim()) {
      setError("Aileye bir isim ver.");
      return;
    }
    setBusy(true);
    try {
      await createFamily(nameDraft.trim(), personName);
      setNameDraft("");
      await onReload();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const handleJoin = async () => {
    setError("");
    if (!codeDraft.trim()) {
      setError("Davet kodunu gir.");
      return;
    }
    setBusy(true);
    try {
      await joinFamily(codeDraft.trim(), personName);
      setCodeDraft("");
      await onReload();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const handleLeave = async (familyId) => {
    setBusy(true);
    try {
      await leaveFamily(familyId);
      await onReload();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (familyId) => {
    setBusy(true);
    try {
      await deleteFamily(familyId);
      setConfirmDeleteId(null);
      await onReload();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const handleImport = async (familyId) => {
    setImportState((prev) => ({ ...prev, [familyId]: "checking" }));
    try {
      await importLegacyInto(familyId);
      await onImportFamily(familyId);
      setImportState((prev) => ({ ...prev, [familyId]: "done" }));
    } catch (e) {
      setImportState((prev) => ({ ...prev, [familyId]: "hata" }));
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      {families.map((f) => (
        <div key={f.id} style={{ borderRadius: "14px", border: `1px solid ${COLORS.line}`, background: COLORS.panel, padding: "24px", boxShadow: CARD_SHADOW }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "10px" }}>
            <h3 style={{ fontFamily: SERIF, fontSize: "18px", color: COLORS.ink, margin: 0 }}>{f.name}</h3>
            {f.ownerUid === currentUid ? (
              confirmDeleteId === f.id ? (
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ fontSize: "12px", color: COLORS.danger }}>Emin misin?</span>
                  <button
                    onClick={() => handleDelete(f.id)}
                    disabled={busy}
                    style={{ fontSize: "12px", fontWeight: 700, color: "#fff", background: COLORS.danger, border: "none", borderRadius: "6px", padding: "4px 10px", cursor: "pointer" }}
                  >
                    Evet, Sil
                  </button>
                  <button
                    onClick={() => setConfirmDeleteId(null)}
                    style={{ fontSize: "12px", color: COLORS.inkSoft, background: "transparent", border: "none", cursor: "pointer" }}
                  >
                    Vazgeç
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmDeleteId(f.id)}
                  disabled={busy}
                  style={{ fontSize: "12px", color: COLORS.danger, background: "transparent", border: "none", cursor: "pointer" }}
                >
                  Aileyi Sil
                </button>
              )
            ) : (
              <button
                onClick={() => handleLeave(f.id)}
                disabled={busy}
                style={{ fontSize: "12px", color: COLORS.danger, background: "transparent", border: "none", cursor: "pointer" }}
              >
                Aileden Ayrıl
              </button>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "10px", flexWrap: "wrap" }}>
            <span style={{ fontSize: "12px", color: COLORS.inkSoft }}>Davet kodu:</span>
            <code
              style={{
                fontSize: "14px",
                fontWeight: 700,
                letterSpacing: "0.05em",
                color: COLORS.forestDark,
                background: "#EFE9D8",
                padding: "3px 8px",
                borderRadius: "6px",
              }}
            >
              {f.inviteCode}
            </code>
            <button
              onClick={() => navigator.clipboard?.writeText(f.inviteCode)}
              aria-label="Kodu kopyala"
              style={{ background: "transparent", border: "none", cursor: "pointer", color: COLORS.inkSoft, display: "flex" }}
            >
              <Copy size={13} />
            </button>
          </div>
          <div style={{ fontSize: "13px", color: COLORS.inkSoft, marginBottom: "12px" }}>
            Üyeler: {f.members.map((m) => m.name || m.email || (m.isAnonymous ? "Misafir kullanıcı" : "Kullanıcı")).join(", ")}
          </div>
          <button
            onClick={() => handleImport(f.id)}
            disabled={importState[f.id] === "checking"}
            style={{
              fontSize: "12px",
              color: COLORS.forest,
              background: "transparent",
              border: `1px solid ${COLORS.forest}`,
              borderRadius: "8px",
              padding: "6px 10px",
              cursor: "pointer",
            }}
          >
            {importState[f.id] === "checking" ? "Kontrol ediliyor…" : "Eski paylaşılan tarifleri bu aileye aktar"}
          </button>
          {importState[f.id] === "done" && <div style={{ fontSize: "12px", color: COLORS.forest, marginTop: "6px" }}>Aktarıldı (varsa).</div>}
          {importState[f.id] === "hata" && <div style={{ fontSize: "12px", color: COLORS.danger, marginTop: "6px" }}>İçe aktarma başarısız oldu.</div>}
        </div>
      ))}

      {!isPlus && (
        <div style={{ borderRadius: "14px", border: `1px dashed ${COLORS.mustard}`, background: COLORS.panel, padding: "20px", textAlign: "center" }}>
          <p style={{ fontSize: "13px", color: COLORS.inkSoft, margin: "0 0 10px" }}>
            Plus kapalıyken mevcut ailelerinden ayrılabilirsin, ama yeni bir aile kuramaz ya da katılamazsın.
          </p>
          <button
            onClick={onOpenPlus}
            style={{ padding: "8px 14px", borderRadius: "8px", fontWeight: 700, fontSize: "13px", background: COLORS.mustard, color: COLORS.forestDark, border: "none", cursor: "pointer" }}
          >
            Plus'ı İncele
          </button>
        </div>
      )}

      {isPlus && (
      <div style={{ borderRadius: "14px", border: `1px solid ${COLORS.line}`, background: COLORS.panel, padding: "24px", boxShadow: CARD_SHADOW }}>
        <h3 style={{ fontFamily: SERIF, fontSize: "17px", color: COLORS.ink, margin: "0 0 4px" }}>Yeni Aile</h3>
        <p style={{ fontSize: "13px", color: COLORS.inkSoft, margin: "0 0 12px" }}>
          En fazla {MAX_FAMILIES} aileye üye olabilirsin{atLimit ? " — şu an sınırdasın." : "."}
        </p>

        <div style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
          <input
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            placeholder="Aile adı (örn. Yılmazlar)"
            style={inputStyle}
            disabled={atLimit}
          />
          <button
            onClick={handleCreate}
            disabled={busy || atLimit}
            style={{
              padding: "10px 16px",
              borderRadius: "8px",
              fontWeight: 700,
              background: COLORS.mustard,
              color: COLORS.forestDark,
              border: "none",
              cursor: "pointer",
              opacity: atLimit ? 0.5 : 1,
              flexShrink: 0,
            }}
          >
            Oluştur
          </button>
        </div>

        <div style={{ display: "flex", gap: "8px" }}>
          <input
            value={codeDraft}
            onChange={(e) => setCodeDraft(e.target.value.toUpperCase())}
            placeholder="Davet kodunu gir"
            style={inputStyle}
            disabled={atLimit}
          />
          <button
            onClick={handleJoin}
            disabled={busy || atLimit}
            style={{
              padding: "10px 16px",
              borderRadius: "8px",
              fontWeight: 700,
              background: COLORS.forest,
              color: "#F3EFE6",
              border: "none",
              cursor: "pointer",
              opacity: atLimit ? 0.5 : 1,
              flexShrink: 0,
            }}
          >
            Katıl
          </button>
        </div>

        {error && (
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: "8px",
              fontSize: "13px",
              padding: "10px 12px",
              borderRadius: "8px",
              background: "#F5E4E0",
              color: COLORS.danger,
              marginTop: "12px",
            }}
          >
            <AlertCircle size={14} style={{ marginTop: "2px", flexShrink: 0 }} />
            <span>{error}</span>
          </div>
        )}
      </div>
      )}
    </div>
  );
}

function PlusView({ isPlus, onToggle }) {
  const [busy, setBusy] = useState(false);

  const handleToggle = async () => {
    setBusy(true);
    try {
      await onToggle(!isPlus);
    } finally {
      setBusy(false);
    }
  };

  const benefits = [
    "Kişisel tariflerinde 50 sınırı tamamen kalkar",
    "En fazla 2 aile oluşturabilir ya da davetle katılabilirsin",
    "Aile tarifleri, o ailenin tüm üyeleri tarafından görülür",
  ];

  return (
    <div style={{ borderRadius: "14px", border: `1px solid ${COLORS.mustard}`, background: COLORS.panel, padding: "28px", boxShadow: CARD_SHADOW, textAlign: "center" }}>
      <div
        style={{
          width: "52px",
          height: "52px",
          borderRadius: "9999px",
          background: COLORS.mustard,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          margin: "0 auto 14px",
        }}
      >
        <Crown size={24} color={COLORS.forestDark} />
      </div>
      <h2 style={{ fontFamily: SERIF, fontSize: "22px", color: COLORS.ink, margin: "0 0 8px" }}>Tarif Kutusu Plus</h2>
      <ul
        style={{
          listStyle: "none",
          padding: 0,
          margin: "0 0 20px",
          display: "flex",
          flexDirection: "column",
          gap: "10px",
          textAlign: "left",
          maxWidth: "320px",
          marginLeft: "auto",
          marginRight: "auto",
        }}
      >
        {benefits.map((b) => (
          <li key={b} style={{ display: "flex", alignItems: "flex-start", gap: "8px", fontSize: "14px", color: COLORS.ink }}>
            <Sparkles size={15} color={COLORS.mustardDark} style={{ marginTop: "2px", flexShrink: 0 }} />
            {b}
          </li>
        ))}
      </ul>
      <p style={{ fontSize: "12px", color: COLORS.inkSoft, marginBottom: "16px" }}>
        Ödeme sistemi henüz eklenmedi — şimdilik bu bir test anahtarı.
      </p>
      <button
        onClick={handleToggle}
        disabled={busy}
        style={{
          padding: "10px 20px",
          borderRadius: "9999px",
          fontWeight: 700,
          fontSize: "14px",
          background: isPlus ? "transparent" : COLORS.mustard,
          color: isPlus ? COLORS.danger : COLORS.forestDark,
          border: isPlus ? `1px solid ${COLORS.danger}` : "none",
          cursor: busy ? "default" : "pointer",
          opacity: busy ? 0.6 : 1,
        }}
      >
        {isPlus ? "Plus'ı Kapat (test)" : "Plus'ı Etkinleştir (test)"}
      </button>
    </div>
  );
}

function AccountView({ authUser, personName, onSignOut, onImportPersonal }) {
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState("");
  const [importState, setImportState] = useState(null);
  const [emailMode, setEmailMode] = useState(null); // "create" | "login" | null
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailError, setEmailError] = useState("");

  const handleLinkGoogle = async () => {
    setLinkError("");
    setLinking(true);
    try {
      await googleLink(authUser);
    } catch (e) {
      setLinkError(e.message || mapAuthError(e.code) || "Bağlanamadı, tekrar dener misin?");
    } finally {
      setLinking(false);
    }
  };

  const openEmailForm = (mode) => {
    setEmailMode(mode);
    setEmail("");
    setPassword("");
    setEmailError("");
  };

  const handleEmailSubmit = async (e) => {
    e.preventDefault();
    if (!email.trim() || !password) {
      setEmailError("E-posta ve şifreni gir.");
      return;
    }
    setEmailError("");
    setEmailBusy(true);
    try {
      if (emailMode === "create") {
        // Misafirin uid'i korunuyor (linkWithCredential) - tüm tarifleri kalıyor.
        try {
          await linkWithCredential(authUser, EmailAuthProvider.credential(email.trim(), password));
        } catch (e2) {
          if (e2.code === "auth/email-already-in-use") {
            // Bu e-posta zaten başka bir hesapta - bağlamak yerine o hesaba geç.
            await signInWithEmailAndPassword(auth, email.trim(), password);
          } else {
            throw e2;
          }
        }
      } else {
        // Giriş Yap: mevcut bir hesaba geçiliyor, misafir verisi otomatik taşınmıyor.
        await signInWithEmailAndPassword(auth, email.trim(), password);
      }
      setEmailMode(null);
    } catch (e2) {
      setEmailError(mapAuthError(e2.code) || e2.message);
    } finally {
      setEmailBusy(false);
    }
  };

  const handleImport = async () => {
    setImportState("checking");
    try {
      await importLegacyInto(PERSONAL);
      await onImportPersonal();
      setImportState("done");
    } catch (e) {
      setImportState("hata");
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      <div style={{ borderRadius: "14px", border: `1px solid ${COLORS.line}`, background: COLORS.panel, padding: "24px", boxShadow: CARD_SHADOW }}>
        <h2 style={{ fontFamily: SERIF, fontSize: "20px", color: COLORS.ink, margin: "0 0 4px", display: "flex", alignItems: "center", gap: "8px" }}>
          <UserCircle size={19} color={COLORS.forest} />
          Hesabım
        </h2>
        <p style={{ fontSize: "14px", color: COLORS.ink, margin: "12px 0 4px" }}>
          {authUser?.isAnonymous ? "Misafir kullanıcı" : authUser?.email || "Hesap"}
        </p>
        {personName && <p style={{ fontSize: "13px", color: COLORS.inkSoft, margin: "0 0 16px" }}>Görünen isim: {personName}</p>}

        {authUser?.isAnonymous && (
          <div style={{ padding: "14px", borderRadius: "10px", background: "#EFE9D8", marginBottom: "16px" }}>
            <p style={{ fontSize: "13px", color: COLORS.ink, margin: "0 0 10px" }}>
              Misafir hesabı kaybolabilir (ör. tarayıcı verisi silinirse). Bir hesap oluşturursan ya da mevcut
              hesabına girersen tariflerin güvenceye alınır.
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
              <button
                onClick={handleLinkGoogle}
                disabled={linking}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  padding: "8px 14px",
                  borderRadius: "8px",
                  fontWeight: 700,
                  fontSize: "13px",
                  background: COLORS.forest,
                  color: "#F3EFE6",
                  border: "none",
                  cursor: linking ? "default" : "pointer",
                  opacity: linking ? 0.6 : 1,
                }}
              >
                <LogIn size={13} />
                Google ile Bağla
              </button>
              <button
                type="button"
                onClick={() => openEmailForm(emailMode === "create" ? null : "create")}
                style={{
                  padding: "8px 14px",
                  borderRadius: "8px",
                  fontWeight: 700,
                  fontSize: "13px",
                  background: emailMode === "create" ? COLORS.forest : COLORS.panel,
                  color: emailMode === "create" ? "#F3EFE6" : COLORS.ink,
                  border: `1px solid ${COLORS.forest}`,
                  cursor: "pointer",
                }}
              >
                Hesap Oluştur
              </button>
              <button
                type="button"
                onClick={() => openEmailForm(emailMode === "login" ? null : "login")}
                style={{
                  padding: "8px 14px",
                  borderRadius: "8px",
                  fontWeight: 600,
                  fontSize: "13px",
                  background: emailMode === "login" ? COLORS.forest : "transparent",
                  color: emailMode === "login" ? "#F3EFE6" : COLORS.inkSoft,
                  border: `1px solid ${COLORS.line}`,
                  cursor: "pointer",
                }}
              >
                Giriş Yap
              </button>
            </div>
            {linkError && <div style={{ fontSize: "12px", color: COLORS.danger, marginTop: "8px" }}>{linkError}</div>}

            {emailMode && (
              <form onSubmit={handleEmailSubmit} style={{ marginTop: "12px" }}>
                {emailMode === "login" && (
                  <p style={{ fontSize: "12px", color: COLORS.inkSoft, margin: "0 0 8px" }}>
                    Mevcut bir hesaba giriş yapıyorsun - misafirdeki tarifler bu hesaba otomatik taşınmaz.
                  </p>
                )}
                <input
                  type="email"
                  placeholder="E-posta"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  style={{
                    width: "100%",
                    borderRadius: "8px",
                    border: `1px solid ${COLORS.line}`,
                    background: COLORS.paper,
                    color: COLORS.ink,
                    padding: "9px 11px",
                    fontSize: "13px",
                    outline: "none",
                    boxSizing: "border-box",
                    marginBottom: "8px",
                  }}
                />
                <input
                  type="password"
                  placeholder="Şifre"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  style={{
                    width: "100%",
                    borderRadius: "8px",
                    border: `1px solid ${COLORS.line}`,
                    background: COLORS.paper,
                    color: COLORS.ink,
                    padding: "9px 11px",
                    fontSize: "13px",
                    outline: "none",
                    boxSizing: "border-box",
                    marginBottom: "8px",
                  }}
                />
                {emailError && <div style={{ fontSize: "12px", color: COLORS.danger, marginBottom: "8px" }}>{emailError}</div>}
                <button
                  type="submit"
                  disabled={emailBusy}
                  style={{
                    padding: "8px 14px",
                    borderRadius: "8px",
                    fontWeight: 700,
                    fontSize: "13px",
                    background: COLORS.mustard,
                    color: COLORS.forestDark,
                    border: "none",
                    cursor: emailBusy ? "default" : "pointer",
                    opacity: emailBusy ? 0.6 : 1,
                  }}
                >
                  {emailBusy ? "…" : emailMode === "create" ? "Hesap Oluştur" : "Giriş Yap"}
                </button>
              </form>
            )}
          </div>
        )}

        {!authUser?.isAnonymous && (
          <button
            onClick={onSignOut}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "6px",
              padding: "8px 14px",
              borderRadius: "8px",
              fontSize: "13px",
              fontWeight: 600,
              background: "transparent",
              color: COLORS.danger,
              border: `1px solid ${COLORS.danger}`,
              cursor: "pointer",
            }}
          >
            <LogOut size={13} /> Çıkış Yap
          </button>
        )}
      </div>

      <div style={{ borderRadius: "14px", border: `1px solid ${COLORS.line}`, background: COLORS.panel, padding: "24px", boxShadow: CARD_SHADOW }}>
        <h3 style={{ fontFamily: SERIF, fontSize: "16px", color: COLORS.ink, margin: "0 0 8px" }}>Eski Tarif Kutusu Verisi</h3>
        <p style={{ fontSize: "13px", color: COLORS.inkSoft, margin: "0 0 12px" }}>
          Aile özellikleri eklenmeden önce herkesin gördüğü eski paylaşılan tarifler varsa, kişisel listen boşken
          buradan kişisel listene aktarabilirsin.
        </p>
        <button
          onClick={handleImport}
          disabled={importState === "checking"}
          style={{
            fontSize: "13px",
            color: COLORS.forest,
            background: "transparent",
            border: `1px solid ${COLORS.forest}`,
            borderRadius: "8px",
            padding: "8px 14px",
            cursor: "pointer",
          }}
        >
          {importState === "checking" ? "Kontrol ediliyor…" : "Kişisel Listeme Aktar"}
        </button>
        {importState === "done" && <div style={{ fontSize: "12px", color: COLORS.forest, marginTop: "8px" }}>Aktarıldı (varsa).</div>}
        {importState === "hata" && <div style={{ fontSize: "12px", color: COLORS.danger, marginTop: "8px" }}>İçe aktarma başarısız oldu.</div>}
      </div>
    </div>
  );
}

function SettingsView({ personName, nameDraft, setNameDraft, onSaveName }) {
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!nameDraft && personName) setNameDraft(personName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSave = () => {
    if (!nameDraft.trim()) return;
    onSaveName();
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
  };

  return (
    <div style={{ borderRadius: "14px", border: `1px solid ${COLORS.line}`, background: COLORS.panel, padding: "24px", boxShadow: CARD_SHADOW }}>
      <h2 style={{ fontFamily: SERIF, fontSize: "20px", color: COLORS.ink, margin: "0 0 4px", display: "flex", alignItems: "center", gap: "8px" }}>
        <Settings size={19} color={COLORS.forest} />
        Ayarlar
      </h2>
      <p style={{ fontSize: "14px", color: COLORS.inkSoft, margin: "12px 0 6px" }}>Görünen ismin</p>
      <div style={{ display: "flex", gap: "8px" }}>
        <input
          value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
          style={{
            flex: 1,
            borderRadius: "8px",
            border: `1px solid ${COLORS.line}`,
            background: COLORS.paper,
            color: COLORS.ink,
            padding: "10px 12px",
            fontSize: "14px",
            outline: "none",
            boxSizing: "border-box",
          }}
        />
        <button
          onClick={handleSave}
          style={{ padding: "10px 16px", borderRadius: "8px", fontWeight: 700, background: COLORS.mustard, color: COLORS.forestDark, border: "none", cursor: "pointer" }}
        >
          Kaydet
        </button>
      </div>
      {saved && <div style={{ fontSize: "12px", color: COLORS.forest, marginTop: "8px" }}>Kaydedildi.</div>}
    </div>
  );
}
