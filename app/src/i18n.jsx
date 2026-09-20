import React, { createContext, useContext, useState, useCallback, useMemo } from "react";

// Merkezi dil/çeviri sistemi. Tek kaynak burası: App.jsx ve SharePanel.jsx
// hiçbir yerde kendi language state'ini tutmuyor, hepsi <LanguageProvider>
// (main.jsx'te iki giriş noktasını da sarıyor) üzerinden gelen tek Context'i
// useLanguage() ile okuyor.
//
// YENİ BİR DİL EKLEMEK İÇİN (örn. İspanyolca):
//   1) LANGUAGES dizisine { code: "es", label: "Español" } ekle.
//   2) translations nesnesine tr/en'deki TÜM anahtarları karşılayan bir "es"
//      bloğu ekle (eksik anahtar kalırsa aşağıdaki t() otomatik olarak
//      DEFAULT_LANGUAGE'e - yani Türkçe'ye - düşer, uygulama kırılmaz).
//   3) CATEGORY_LABELS ve DIFFICULTY_LABELS nesnelerine de "es" çevirilerini ekle
//      (kategori/zorluk DEĞERLERİ hep Türkçe kalır, bunlar sadece görünen etiket).
//   Başka hiçbir dosyada değişiklik gerekmiyor.

const STORAGE_KEY = "tarif-kutusu:language";
const DEFAULT_LANGUAGE = "tr";

export const LANGUAGES = [
  { code: "tr", label: "Türkçe" },
  { code: "en", label: "English" },
];

// Kategori/zorluk DEĞERLERİ (Redis'te saklanan, filtreleme ve tarif şemasında
// kullanılan string'ler - shared/recipeExtraction.js'teki CATEGORIES ve Claude
// prompt'undaki "Kolay"/"Orta"/"Zor" ile birebir aynı) hiçbir zaman değişmiyor.
// Burada sadece KULLANICIYA GÖSTERİLEN etiket çevriliyor; stored value, filtreleme
// ve mevcut tariflerle eşleşme bundan etkilenmiyor.
const CATEGORY_LABELS = {
  en: {
    "Kahvaltı": "Breakfast",
    "Öğle Yemeği ve Akşam Yemeği": "Lunch & Dinner",
    "Soslar": "Sauces",
    "Atıştırmalıklar": "Snacks",
    "Tatlılar": "Desserts",
  },
};

const DIFFICULTY_LABELS = {
  en: {
    "Kolay": "Easy",
    "Orta": "Medium",
    "Zor": "Hard",
  },
};

const translations = {
  tr: {
    // Genel / tekrar kullanılan
    "common.close": "Kapat",
    "common.cancel": "Vazgeç",
    "common.save": "Kaydet",
    "common.saved": "Kaydedildi.",
    "common.loading": "Yükleniyor…",
    "common.noResults": "Sonuç yok.",
    "common.checking": "Kontrol ediliyor…",
    "common.untitledRecipe": "İsimsiz tarif",
    "common.recipeWord": "Tarif",
    "common.personal": "Kişisel",
    "common.removeIngredient": "Malzemeyi kaldır",
    "common.genericError": "Bir şeyler ters gitti, tekrar dener misin?",

    // Header
    "header.tagline": "Videoyu kaydetme, tarifini çıkar",
    "header.signOut": "Çıkış yap",
    "header.backToList": "Listeye dön",
    "header.openMenu": "Menüyü aç",

    // Şef şapkası menüsü
    "menu.account": "Hesabım",
    "menu.favorites": "Favoriler",
    "menu.families": "Aileler",
    "menu.plus": "Plus",
    "menu.settings": "Ayarlar",

    // Güncelleme bandı
    "update.available": "Yeni bir güncelleme mevcut.",
    "update.button": "Şimdi Güncelle",

    // İlk isim sorma ekranı
    "welcome.title": "Merhaba!",
    "welcome.body": "Ailenle paylaştığın bu Tarif Kutusu'nda eklediğin tarifler senin isminle görünsün. Bu, sadece bu cihazda bir kere sorulur.",
    "welcome.placeholder": "Adın",
    "welcome.continue": "Devam Et",

    // Silme sonrası "geri al" çubuğu
    "undo.deleted": '"{title}" silindi.',
    "undo.button": "Geri Al",

    // Giriş / kayıt / misafir (AuthGate)
    "auth.subtitleLogin": "Hesabınla giriş yap.",
    "auth.subtitleSignup": "Google ile ya da e-postayla hemen bir hesap aç.",
    "auth.googleSignup": "Google ile Kaydol",
    "auth.orEmail": "veya e-postayla",
    "auth.emailPlaceholder": "E-posta",
    "auth.passwordPlaceholder": "Şifre",
    "auth.emailSignup": "E-posta ile Kaydol",
    "auth.login": "Giriş Yap",
    "auth.switchToSignup": "Hesabın yok mu? Kaydol",
    "auth.switchToLogin": "Zaten hesabın var mı? Giriş yap",
    "auth.guest": "Misafir Olarak Gir",
    "auth.errorGuestFailed": "Misafir girişi başarısız oldu, tekrar dener misin?",
    "auth.errorEmailRequired": "E-posta ve şifreni gir.",
    "auth.errorInvalidEmail": "E-posta adresi geçersiz görünüyor.",
    "auth.errorWrongCredentials": "E-posta veya şifre hatalı.",
    "auth.errorEmailInUse": "Bu e-posta ile zaten bir hesap var, giriş yapmayı dene.",
    "auth.errorWeakPassword": "Şifre en az 6 karakter olmalı.",

    // Genel API/ağ hataları
    "errors.sessionNotFound": "Oturum bulunamadı.",
    "errors.requestFailed": "İstek başarısız oldu.",
    "errors.apiRequestFailed": "API isteği başarısız oldu",
    "errors.parseFailed": "Tarif ayrıştırılamadı, lütfen açıklama metnini kontrol edip tekrar dene.",
    "errors.captionFetchFailed": "Açıklama otomatik alınamadı, elle yapıştırabilirsin.",
    "errors.needDescriptionOrImage": "Açıklamayı yapıştıramıyorsan sorun değil — en azından bir ekran görüntüsü yükle ya da birkaç kelime not yaz.",
    "errors.needCategory": "Yemeğin hangi kategoriye ait olduğunu seçmen lazım.",
    "errors.freeLimit": "Ücretsiz hesaplarda en fazla {limit} kişisel tarif olabilir. Sınırsız eklemek için Plus'a geç.",
    "errors.notifyFailed": "Bildirim gönderilemedi",
    "errors.googleSignInCancelled": "Google girişi iptal edildi ya da id token alınamadı.",

    // notifyResultMessage
    "notify.sent": "Bildirim gönderildi",
    "notify.noOtherMembers": "Ailede başka üye yok",
    "notify.noOneRegistered": "Kimsenin bildirim kaydı yok",
    "notify.failed": "Gönderilemedi",
    "notify.failedWithReason": "Gönderilemedi: {reason}",
    "notify.partial": "Kısmen gönderildi ({sent}/{attempted})",

    // Sidebar (ana tarif listesi)
    "sidebar.searchPlaceholder": "Tarif ara…",
    "sidebar.clearSearch": "Aramayı temizle",
    "sidebar.mealsTitle": "Yemekler",
    "sidebar.favorite": "Favori",
    "sidebar.deleteRecipe": "Tarifi sil",
    "sidebar.notifyFamily": "Canımın çektiğini bildir",
    "sidebar.emptyList": "Henüz tarif yok. İlk tarifini eklemek için yukarıdaki butona bas.",
    "sidebar.favoritesSection": "Favoriler",
    "sidebar.categoryEmpty": "Bu kategoride henüz tarif yok.",
    "sidebar.otherCategory": "Diğer (kategorisiz)",
    "sidebar.otherCategoryHint": "Kategori seçiminden önce eklendiler — açıp kategori atayabilirsin.",
    "sidebar.addRecipe": "Yeni Tarif Çıkar",
    "sidebar.createManually": "Tarifi Kendin Oluştur",
    "sidebar.shoppingList": "Alışveriş Listesi",
    "sidebar.pantry": "Elimde Bunlar Var",

    // Boş liste ekranı
    "empty.title": "Kutun henüz boş",
    "empty.body": "Beğendiğin bir tarif videosunun linkini ve açıklama metnini yapıştır, malzemeleri ve besin değerlerini senin yerine ben çıkarayım.",
    "empty.button": "Tarif Ekle",

    // SaveTargetPicker
    "saveTarget.label": "Kaydetme yeri",
    "saveTarget.multiHint": "(birden fazla seçebilirsin)",
    "saveTarget.personal": "Kişisel Tariflerim",

    // Yeni Tarif Çıkar (AddForm)
    "addForm.title": "Yeni Tarif Çıkar",
    "addForm.introPart1": "En kolay yol: TikTok'ta gördüğün açıklama ya da malzeme yazısının",
    "addForm.introStrong": "ekran görüntüsünü",
    "addForm.introPart2": "al ve aşağıya yükle — kopyala-yapıştır uğraşına gerek yok. İstersen açıklamayı yapıştırabilir ya da gördüklerini birkaç kelimeyle not olarak yazabilirsin.",
    "addForm.videoLink": "Video linki",
    "addForm.linkPlaceholder": "https://www.tiktok.com/... veya instagram.com/... veya youtube.com/...",
    "addForm.screenshotLabel": "Ekran görüntüsü (önerilen)",
    "addForm.removeImage": "Görseli kaldır",
    "addForm.addImage": "Ekle",
    "addForm.captionLabel": "Açıklama / altyazı metni (opsiyonel)",
    "addForm.autoFetching": "Otomatik getiriliyor…",
    "addForm.captionPlaceholder": "Videonun altındaki açıklamayı ya da altyazı metnini buraya yapıştır…",
    "addForm.notesLabel": "Gördüğün malzemeler (opsiyonel)",
    "addForm.notesPlaceholder": "Örn. tavuklu, yumurtalı, galeta unlu kızartma…",
    "addForm.categoryLabel": "Kategori",
    "addForm.extracting": "Çıkarılıyor…",
    "addForm.extract": "Tarifi Çıkar",

    // Tarif Detay
    "detail.servings": "{n} porsiyon",
    "detail.prepTime": "{n} dk",
    "detail.addedBy": "Ekleyen: {name}",
    "detail.fallbackTitle": "Tarif",
    "detail.saveName": "Adı kaydet",
    "detail.editName": "Adı düzenle",
    "detail.notifyButton": "Bildirim gönder",
    "detail.notifyTitle": "Ailene bu yemeği canının çektiğini bildir",
    "detail.noCategoryWarning": 'Bu tarifin kategorisi yok, bu yüzden "Yemekler" listesinde ve aramada görünmüyordu. Bir kategori seç:',
    "detail.startCooking": "Pişirmeye Başla",
    "detail.editRecipe": "Tarifi Düzenle (malzeme, yapılış, besin değerleri)",
    "detail.addToShopping": "Alışveriş Listesine Ekle",
    "detail.ingredients": "Malzemeler",
    "detail.noIngredients": "Malzeme bulunamadı.",
    "detail.instructions": "Yapılışı",
    "detail.stepsCount": "{n} adım",
    "detail.noInstructions": "Açıklama metninde yapılış adımları yoktu — aşağıdaki linkten videoyu izleyebilirsin.",
    "detail.watchVideo": "Videoyu Aç, Yapılışını İzle",

    // Besin değerleri etiketi
    "nutrition.title": "Besin Değerleri",
    "nutrition.calories": "Kalori",
    "nutrition.wholeRecipe": "Tarifin tamamı",
    "nutrition.servingsNote": "({servings} porsiyonluk tarif)",
    "nutrition.protein": "Protein",
    "nutrition.carbs": "Karbonhidrat",
    "nutrition.fat": "Yağ",
    "nutrition.disclaimer": "* Değerler yapay zeka tahminidir, kesin ölçüm değildir.",

    // Alışveriş Listesi
    "shopping.title": "Alışveriş Listesi",
    "shopping.intro": "Listeye eklemek istediğin tarifleri seç, malzemelerini tek bir listede birleştireyim.",
    "shopping.emptyContext": "Bu listede henüz kayıtlı tarif yok.",
    "shopping.ingredientsTitle": "Malzemeler",
    "shopping.pickedCount": "({checked}/{total} alındı)",
    "shopping.clearChecks": "İşaretleri temizle",

    // Pişirmeye Başla (CookMode)
    "cook.beforeStart": "Hazırlanmadan Önce",
    "cook.stepCounter": "Adım {current} / {total}",
    "cook.instructionsFallback": "Yapılış",
    "cook.congrats": "Tebrikler!",
    "cook.mealReady": "Yemeğiniz hazır. Afiyet olsun! 🍽️",
    "cook.prev": "Önceki",
    "cook.next": "Sonraki",
    "cook.complete": "Tamamla ✓",
    "cook.backToRecipe": "Tarife Dön",

    // Tarifi Kendin Oluştur / Düzenle (RecipeEditor)
    "editor.headingNew": "Yeni Tarif Oluştur",
    "editor.headingEdit": "Tarifi Düzenle",
    "editor.hint": "Alanları istediğin gibi doldur ya da düzenle. Boş bıraktığın satırlar kaydedilmez.",
    "editor.nameLabel": "Tarif Adı",
    "editor.namePlaceholder": "Örn. Çıtır Tavuk",
    "editor.servingsLabel": "Porsiyon",
    "editor.prepTimeLabel": "Hazırlık Süresi (dk)",
    "editor.difficultyLabel": "Zorluk",
    "editor.videoLinkLabel": "Video linki (opsiyonel)",
    "editor.addIngredient": "Malzeme Ekle",
    "editor.ingredientNamePlaceholder": "Malzeme (örn. Tavuk göğsü)",
    "editor.ingredientAmountPlaceholder": "Miktar (örn. 500 g)",
    "editor.addStep": "Adım Ekle",
    "editor.stepPlaceholder": "{n}. adımı yaz…",
    "editor.removeStep": "Adımı kaldır",
    "editor.nutritionTitle": "Besin Değerleri (tarifin tamamı)",
    "editor.protein": "Protein (g)",
    "editor.carbs": "Karbonhidrat (g)",
    "editor.fat": "Yağ (g)",
    "editor.errorNeedTitle": "Tarife bir isim vermen lazım.",
    "editor.errorNeedCategory": "Bir kategori seçmen lazım.",

    // Elimde Bunlar Var (PantryFinder)
    "pantry.title": "Elimde Bunlar Var",
    "pantry.intro": "Evde olan malzemeleri tek tek yaz (Enter'a bas ya da virgül koy), bu malzemelerle yapabileceğin kayıtlı tarifleri bulayım.",
    "pantry.itemPlaceholder": "Örn. tavuk, yumurta, soğan…",
    "pantry.add": "Ekle",
    "pantry.noItems": "Henüz malzeme eklemedin.",
    "pantry.noMatches": "Bu malzemelerle eşleşen kayıtlı tarif bulamadım. Başka malzeme eklemeyi dener misin?",
    "pantry.fullMatch": "Tam eşleşme",
    "pantry.partialMatch": "{matched}/{total} malzeme var",
    "pantry.missing": "Eksik: {list}",
    "pantry.aiTitle": "AI'dan Tarif Fikri İste",
    "pantry.aiIntro": "Kayıtlı tariflerinle eşleşme bulunmasa da, elindeki malzemelerle yapay zekadan yeni fikirler isteyebilirsin.",
    "pantry.thinking": "Düşünülüyor…",
    "pantry.getIdeas": "Fikir İste",
    "pantry.suggestError": "Öneriler alınamadı, tekrar dener misin?",
    "pantry.extraNeeded": "Ekstra gerekli: {list}",
    "pantry.kcal": "kcal",
    "pantry.proteinShort": "g protein",
    "pantry.carbShort": "g karb",
    "pantry.fatShort": "g yağ",
    "pantry.saved": "Kaydedildi ✓",
    "pantry.saving": "Kaydediliyor…",
    "pantry.saveRecipe": "Tarifi Kaydet",
    "pantry.saveError": "Kaydedilemedi, tekrar dener misin?",

    // Kategori Seç modalı
    "categoryModal.title": "Kategori Seç",
    "categoryModal.subtitle": "Bu tarifi hangi kategoriye kaydedelim?",

    // Favoriler
    "favorites.title": "Favoriler",
    "favorites.subtitle": "Yıldızladığın tüm tarifler burada.",
    "favorites.empty": "Henüz favori tarifin yok.",

    // Aileler
    "families.plusOnlyTitle": "Aile özelliği Plus'a özel",
    "families.plusOnlyBody": "Bir aile oluşturup tariflerini ev halkınla paylaşmak için Plus'a geçmen gerekiyor.",
    "families.reviewPlus": "Plus'ı İncele",
    "families.errorNameRequired": "Aileye bir isim ver.",
    "families.errorCodeRequired": "Davet kodunu gir.",
    "families.confirmDelete": "Emin misin?",
    "families.confirmDeleteYes": "Evet, Sil",
    "families.deleteFamily": "Aileyi Sil",
    "families.leaveFamily": "Aileden Ayrıl",
    "families.inviteCode": "Davet kodu:",
    "families.copyCode": "Kodu kopyala",
    "families.members": "Üyeler: {list}",
    "families.guestUser": "Misafir kullanıcı",
    "families.genericUser": "Kullanıcı",
    "families.fallbackName": "Aile",
    "families.importButton": "Eski paylaşılan tarifleri bu aileye aktar",
    "families.imported": "Aktarıldı (varsa).",
    "families.importFailed": "İçe aktarma başarısız oldu.",
    "families.plusOffHint": "Plus kapalıyken mevcut ailelerinden ayrılabilirsin, ama yeni bir aile kuramaz ya da katılamazsın.",
    "families.newFamilyTitle": "Yeni Aile",
    "families.maxHint": "En fazla {max} aileye üye olabilirsin",
    "families.atLimitSuffix": " — şu an sınırdasın.",
    "families.notAtLimitSuffix": ".",
    "families.namePlaceholder": "Aile adı (örn. Yılmazlar)",
    "families.create": "Oluştur",
    "families.codePlaceholder": "Davet kodunu gir",
    "families.join": "Katıl",

    // Plus
    "plus.benefit1": "Kişisel tariflerinde 50 sınırı tamamen kalkar",
    "plus.benefit2": "En fazla 2 aile oluşturabilir ya da davetle katılabilirsin",
    "plus.benefit3": "Aile tarifleri, o ailenin tüm üyeleri tarafından görülür",
    "plus.testNote": "Ödeme sistemi henüz eklenmedi — şimdilik bu bir test anahtarı.",
    "plus.disable": "Plus'ı Kapat (test)",
    "plus.enable": "Plus'ı Etkinleştir (test)",

    // Hesabım
    "account.title": "Hesabım",
    "account.accountFallback": "Hesap",
    "account.displayName": "Görünen isim: {name}",
    "account.guestWarning": "Misafir hesabı kaybolabilir (ör. tarayıcı verisi silinirse). Bir hesap oluşturursan ya da mevcut hesabına girersen tariflerin güvenceye alınır.",
    "account.linkGoogle": "Google ile Bağla",
    "account.createAccount": "Hesap Oluştur",
    "account.loginHint": "Mevcut bir hesaba giriş yapıyorsun - misafirdeki tarifler bu hesaba otomatik taşınmaz.",
    "account.signOut": "Çıkış Yap",
    "account.legacyTitle": "Eski Tarif Kutusu Verisi",
    "account.legacyBody": "Aile özellikleri eklenmeden önce herkesin gördüğü eski paylaşılan tarifler varsa, kişisel listen boşken buradan kişisel listene aktarabilirsin.",
    "account.importToPersonal": "Kişisel Listeme Aktar",
    "account.linkFailed": "Bağlanamadı, tekrar dener misin?",

    // Ayarlar
    "settings.title": "Ayarlar",
    "settings.displayNameLabel": "Görünen ismin",
    "settings.languageLabel": "Dil",
    "settings.languageModalTitle": "Dil Seç",

    // Android Paylaşım Paneli
    "sharePanel.noLinkFound": "Paylaşılan içerikte TikTok, Instagram ya da YouTube linki bulamadım.",
    "sharePanel.preparing": "Hazırlanıyor…",
    "sharePanel.needLogin": "Tarifi kaydedebilmem için önce Tarif Kutusu'nu açıp giriş yapman (ya da misafir olarak girmen) gerekiyor.",
    "sharePanel.openInApp": "Uygulamada Aç",
    "sharePanel.recipePreparing": "Tarif hazırlanıyor",
    "sharePanel.captionLabel": "Video açıklaması",
    "sharePanel.captionPlaceholder": "Videonun açıklaması ya da gördüğün malzemeler…",
    "sharePanel.errorCaptionRequired": "Açıklama alınamadı — videoda gördüklerini birkaç kelimeyle yaz.",
    "sharePanel.errorJobStartFailed": "Tarif hazırlama işlemi başlatılamadı.",
    "sharePanel.sending": "Gönderiliyor…",
    "sharePanel.addRecipe": "Tarife Ekle",
    "sharePanel.openInAppHint": "Uygulamada aç (ekran görüntüsü ekle, aileye kaydet)",
    "sharePanel.noNotifyNote": "Bildirim kaydın yok; tarif hazır olunca uygulamada görünecek.",
    "sharePanel.willNotify": "Hazır olunca bildirim göndereceğiz.",
  },

  en: {
    "common.close": "Close",
    "common.cancel": "Cancel",
    "common.save": "Save",
    "common.saved": "Saved.",
    "common.loading": "Loading…",
    "common.noResults": "No results.",
    "common.checking": "Checking…",
    "common.untitledRecipe": "Untitled recipe",
    "common.recipeWord": "Recipe",
    "common.personal": "Personal",
    "common.removeIngredient": "Remove ingredient",
    "common.genericError": "Something went wrong, want to try again?",

    "header.tagline": "Skip saving the video, get the recipe",
    "header.signOut": "Sign out",
    "header.backToList": "Back to list",
    "header.openMenu": "Open menu",

    "menu.account": "My Account",
    "menu.favorites": "Favorites",
    "menu.families": "Families",
    "menu.plus": "Plus",
    "menu.settings": "Settings",

    "update.available": "A new update is available.",
    "update.button": "Update Now",

    "welcome.title": "Hi there!",
    "welcome.body": "Recipes you add to this shared Tarif Kutusu should show up under your name. You'll only be asked this once on this device.",
    "welcome.placeholder": "Your name",
    "welcome.continue": "Continue",

    "undo.deleted": '"{title}" was deleted.',
    "undo.button": "Undo",

    "auth.subtitleLogin": "Sign in to your account.",
    "auth.subtitleSignup": "Create an account instantly with Google or email.",
    "auth.googleSignup": "Sign up with Google",
    "auth.orEmail": "or with email",
    "auth.emailPlaceholder": "Email",
    "auth.passwordPlaceholder": "Password",
    "auth.emailSignup": "Sign up with Email",
    "auth.login": "Sign In",
    "auth.switchToSignup": "Don't have an account? Sign up",
    "auth.switchToLogin": "Already have an account? Sign in",
    "auth.guest": "Continue as Guest",
    "auth.errorGuestFailed": "Guest sign-in failed, want to try again?",
    "auth.errorEmailRequired": "Enter your email and password.",
    "auth.errorInvalidEmail": "That email address doesn't look right.",
    "auth.errorWrongCredentials": "Wrong email or password.",
    "auth.errorEmailInUse": "There's already an account with this email, try signing in instead.",
    "auth.errorWeakPassword": "Password must be at least 6 characters.",

    "errors.sessionNotFound": "No session found.",
    "errors.requestFailed": "The request failed.",
    "errors.apiRequestFailed": "The API request failed",
    "errors.parseFailed": "Couldn't parse the recipe, please check the description text and try again.",
    "errors.captionFetchFailed": "Couldn't fetch the description automatically, you can paste it in by hand.",
    "errors.needDescriptionOrImage": "No worries if you can't paste the description — just upload a screenshot or jot down a few words instead.",
    "errors.needCategory": "You need to pick which category this dish belongs to.",
    "errors.freeLimit": "Free accounts can have up to {limit} personal recipes. Go Plus for unlimited.",
    "errors.notifyFailed": "Couldn't send the notification",
    "errors.googleSignInCancelled": "Google sign-in was cancelled or no id token was received.",

    "notify.sent": "Notification sent",
    "notify.noOtherMembers": "No other members in this family",
    "notify.noOneRegistered": "No one has notifications registered",
    "notify.failed": "Couldn't send",
    "notify.failedWithReason": "Couldn't send: {reason}",
    "notify.partial": "Partially sent ({sent}/{attempted})",

    "sidebar.searchPlaceholder": "Search recipes…",
    "sidebar.clearSearch": "Clear search",
    "sidebar.mealsTitle": "Meals",
    "sidebar.favorite": "Favorite",
    "sidebar.deleteRecipe": "Delete recipe",
    "sidebar.notifyFamily": "Let them know I'm craving this",
    "sidebar.emptyList": "No recipes yet. Tap the button above to add your first one.",
    "sidebar.favoritesSection": "Favorites",
    "sidebar.categoryEmpty": "No recipes in this category yet.",
    "sidebar.otherCategory": "Other (uncategorized)",
    "sidebar.otherCategoryHint": "Added before category selection existed — open this to assign one.",
    "sidebar.addRecipe": "Extract New Recipe",
    "sidebar.createManually": "Create Your Own Recipe",
    "sidebar.shoppingList": "Shopping List",
    "sidebar.pantry": "What I Have",

    "empty.title": "Your box is empty",
    "empty.body": "Paste the link and description of a recipe video you liked, and I'll pull out the ingredients and nutrition facts for you.",
    "empty.button": "Add Recipe",

    "saveTarget.label": "Save to",
    "saveTarget.multiHint": "(you can pick more than one)",
    "saveTarget.personal": "My Personal Recipes",

    "addForm.title": "Extract New Recipe",
    "addForm.introPart1": "Easiest way: take a",
    "addForm.introStrong": "screenshot",
    "addForm.introPart2": "of the description or ingredient list you see on TikTok and upload it below — no copy-pasting needed. You can also paste the description or jot down what you saw in a few words.",
    "addForm.videoLink": "Video link",
    "addForm.linkPlaceholder": "https://www.tiktok.com/... or instagram.com/... or youtube.com/...",
    "addForm.screenshotLabel": "Screenshot (recommended)",
    "addForm.removeImage": "Remove image",
    "addForm.addImage": "Add",
    "addForm.captionLabel": "Description / caption text (optional)",
    "addForm.autoFetching": "Fetching automatically…",
    "addForm.captionPlaceholder": "Paste the caption or subtitle text from under the video here…",
    "addForm.notesLabel": "Ingredients you noticed (optional)",
    "addForm.notesPlaceholder": "E.g. chicken, egg, breadcrumbs…",
    "addForm.categoryLabel": "Category",
    "addForm.extracting": "Extracting…",
    "addForm.extract": "Extract Recipe",

    "detail.servings": "{n} servings",
    "detail.prepTime": "{n} min",
    "detail.addedBy": "Added by: {name}",
    "detail.fallbackTitle": "Recipe",
    "detail.saveName": "Save name",
    "detail.editName": "Edit name",
    "detail.notifyButton": "Send notification",
    "detail.notifyTitle": "Let your family know you're craving this",
    "detail.noCategoryWarning": 'This recipe has no category, so it wasn\'t showing up in "Meals" or in search. Pick one:',
    "detail.startCooking": "Start Cooking",
    "detail.editRecipe": "Edit Recipe (ingredients, steps, nutrition)",
    "detail.addToShopping": "Add to Shopping List",
    "detail.ingredients": "Ingredients",
    "detail.noIngredients": "No ingredients found.",
    "detail.instructions": "Instructions",
    "detail.stepsCount": "{n} steps",
    "detail.noInstructions": "The description didn't include any steps — you can watch the video from the link below.",
    "detail.watchVideo": "Open Video, Watch How It's Made",

    "nutrition.title": "Nutrition Facts",
    "nutrition.calories": "Calories",
    "nutrition.wholeRecipe": "Whole recipe",
    "nutrition.servingsNote": "(recipe makes {servings} servings)",
    "nutrition.protein": "Protein",
    "nutrition.carbs": "Carbs",
    "nutrition.fat": "Fat",
    "nutrition.disclaimer": "* Values are AI estimates, not exact measurements.",

    "shopping.title": "Shopping List",
    "shopping.intro": "Pick the recipes you want to add to the list, and I'll merge their ingredients into one.",
    "shopping.emptyContext": "No recipes saved in this list yet.",
    "shopping.ingredientsTitle": "Ingredients",
    "shopping.pickedCount": "({checked}/{total} picked up)",
    "shopping.clearChecks": "Clear checks",

    "cook.beforeStart": "Before You Start",
    "cook.stepCounter": "Step {current} / {total}",
    "cook.instructionsFallback": "Instructions",
    "cook.congrats": "Well done!",
    "cook.mealReady": "Your meal is ready. Enjoy! 🍽️",
    "cook.prev": "Previous",
    "cook.next": "Next",
    "cook.complete": "Finish ✓",
    "cook.backToRecipe": "Back to Recipe",

    "editor.headingNew": "Create New Recipe",
    "editor.headingEdit": "Edit Recipe",
    "editor.hint": "Fill in or edit the fields as you like. Rows you leave blank won't be saved.",
    "editor.nameLabel": "Recipe Name",
    "editor.namePlaceholder": "E.g. Crispy Chicken",
    "editor.servingsLabel": "Servings",
    "editor.prepTimeLabel": "Prep Time (min)",
    "editor.difficultyLabel": "Difficulty",
    "editor.videoLinkLabel": "Video link (optional)",
    "editor.addIngredient": "Add Ingredient",
    "editor.ingredientNamePlaceholder": "Ingredient (e.g. Chicken breast)",
    "editor.ingredientAmountPlaceholder": "Amount (e.g. 500 g)",
    "editor.addStep": "Add Step",
    "editor.stepPlaceholder": "Write step {n}…",
    "editor.removeStep": "Remove step",
    "editor.nutritionTitle": "Nutrition Facts (whole recipe)",
    "editor.protein": "Protein (g)",
    "editor.carbs": "Carbs (g)",
    "editor.fat": "Fat (g)",
    "editor.errorNeedTitle": "You need to give the recipe a name.",
    "editor.errorNeedCategory": "You need to pick a category.",

    "pantry.title": "What I Have",
    "pantry.intro": "Type in the ingredients you have at home one by one (press Enter or a comma), and I'll find saved recipes you can make with them.",
    "pantry.itemPlaceholder": "E.g. chicken, egg, onion…",
    "pantry.add": "Add",
    "pantry.noItems": "You haven't added any ingredients yet.",
    "pantry.noMatches": "I couldn't find a saved recipe matching these ingredients. Want to add more?",
    "pantry.fullMatch": "Full match",
    "pantry.partialMatch": "{matched}/{total} ingredients on hand",
    "pantry.missing": "Missing: {list}",
    "pantry.aiTitle": "Ask AI for Recipe Ideas",
    "pantry.aiIntro": "Even without a match among your saved recipes, you can ask AI for new ideas using what you have on hand.",
    "pantry.thinking": "Thinking…",
    "pantry.getIdeas": "Get Ideas",
    "pantry.suggestError": "Couldn't get suggestions, want to try again?",
    "pantry.extraNeeded": "Extra needed: {list}",
    "pantry.kcal": "kcal",
    "pantry.proteinShort": "g protein",
    "pantry.carbShort": "g carbs",
    "pantry.fatShort": "g fat",
    "pantry.saved": "Saved ✓",
    "pantry.saving": "Saving…",
    "pantry.saveRecipe": "Save Recipe",
    "pantry.saveError": "Couldn't save, want to try again?",

    "categoryModal.title": "Pick a Category",
    "categoryModal.subtitle": "Which category should this recipe be saved under?",

    "favorites.title": "Favorites",
    "favorites.subtitle": "All the recipes you've starred are here.",
    "favorites.empty": "No favorite recipes yet.",

    "families.plusOnlyTitle": "The family feature is Plus-only",
    "families.plusOnlyBody": "You need to go Plus to create a family and share your recipes with your household.",
    "families.reviewPlus": "See Plus",
    "families.errorNameRequired": "Give the family a name.",
    "families.errorCodeRequired": "Enter the invite code.",
    "families.confirmDelete": "Are you sure?",
    "families.confirmDeleteYes": "Yes, Delete",
    "families.deleteFamily": "Delete Family",
    "families.leaveFamily": "Leave Family",
    "families.inviteCode": "Invite code:",
    "families.copyCode": "Copy code",
    "families.members": "Members: {list}",
    "families.guestUser": "Guest user",
    "families.genericUser": "User",
    "families.fallbackName": "Family",
    "families.importButton": "Import old shared recipes into this family",
    "families.imported": "Imported (if any).",
    "families.importFailed": "Import failed.",
    "families.plusOffHint": "With Plus off you can still leave your existing families, but you can't create or join a new one.",
    "families.newFamilyTitle": "New Family",
    "families.maxHint": "You can be a member of up to {max} families",
    "families.atLimitSuffix": " — you're at the limit right now.",
    "families.notAtLimitSuffix": ".",
    "families.namePlaceholder": "Family name (e.g. The Smiths)",
    "families.create": "Create",
    "families.codePlaceholder": "Enter the invite code",
    "families.join": "Join",

    "plus.benefit1": "The 50-recipe limit on personal recipes is completely removed",
    "plus.benefit2": "Create up to 2 families or join others by invite",
    "plus.benefit3": "Family recipes are visible to every member of that family",
    "plus.testNote": "Payments aren't set up yet — for now this is just a test switch.",
    "plus.disable": "Turn Off Plus (test)",
    "plus.enable": "Turn On Plus (test)",

    "account.title": "My Account",
    "account.accountFallback": "Account",
    "account.displayName": "Display name: {name}",
    "account.guestWarning": "A guest account can be lost (e.g. if browser data is cleared). Create an account or sign in to an existing one to keep your recipes safe.",
    "account.linkGoogle": "Link with Google",
    "account.createAccount": "Create Account",
    "account.loginHint": "You're signing in to an existing account - recipes from the guest account won't move over automatically.",
    "account.signOut": "Sign Out",
    "account.legacyTitle": "Old Tarif Kutusu Data",
    "account.legacyBody": "If there are old shared recipes from before family accounts existed, you can import them into your personal list here while it's empty.",
    "account.importToPersonal": "Import to My List",
    "account.linkFailed": "Couldn't link, want to try again?",

    "settings.title": "Settings",
    "settings.displayNameLabel": "Your display name",
    "settings.languageLabel": "Language",
    "settings.languageModalTitle": "Choose Language",

    "sharePanel.noLinkFound": "I couldn't find a TikTok, Instagram, or YouTube link in what was shared.",
    "sharePanel.preparing": "Preparing…",
    "sharePanel.needLogin": "To save this recipe, first open Tarif Kutusu and sign in (or continue as a guest).",
    "sharePanel.openInApp": "Open in App",
    "sharePanel.recipePreparing": "Preparing recipe",
    "sharePanel.captionLabel": "Video description",
    "sharePanel.captionPlaceholder": "The video's description or ingredients you noticed…",
    "sharePanel.errorCaptionRequired": "Couldn't get the description — write down a few words of what you saw in the video.",
    "sharePanel.errorJobStartFailed": "Couldn't start preparing the recipe.",
    "sharePanel.sending": "Sending…",
    "sharePanel.addRecipe": "Add Recipe",
    "sharePanel.openInAppHint": "Open in app (add a screenshot, save to a family)",
    "sharePanel.noNotifyNote": "You don't have notifications registered; the recipe will show up in the app once it's ready.",
    "sharePanel.willNotify": "We'll send a notification once it's ready.",
  },
};

const STORAGE_LANGUAGES = new Set(LANGUAGES.map((l) => l.code));

function readStoredLanguage() {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value && STORAGE_LANGUAGES.has(value) ? value : null;
  } catch (e) {
    return null;
  }
}

// React component ağacının dışındaki (hook kullanamayan) düz yardımcı
// fonksiyonlar için (örn. App.jsx'teki authedFetch/extractRecipe) - useLanguage()
// context'iyle AYNI localStorage anahtarını okuyor, yani hâlâ tek merkezi kaynak.
export function translate(key, vars) {
  const language = readStoredLanguage() || DEFAULT_LANGUAGE;
  const dict = translations[language] || translations[DEFAULT_LANGUAGE];
  let str = dict[key];
  if (str === undefined) str = translations[DEFAULT_LANGUAGE][key] ?? key;
  if (vars) {
    Object.keys(vars).forEach((k) => {
      str = str.replaceAll(`{${k}}`, vars[k]);
    });
  }
  return str;
}

const LanguageContext = createContext(null);

export function LanguageProvider({ children }) {
  const [language, setLanguageState] = useState(() => readStoredLanguage() || DEFAULT_LANGUAGE);

  const setLanguage = useCallback((code) => {
    if (!STORAGE_LANGUAGES.has(code)) return;
    setLanguageState(code);
    try {
      window.localStorage.setItem(STORAGE_KEY, code);
    } catch (e) {
      // yazılamazsa da mevcut oturumda dil değişikliği uygulanmaya devam eder
    }
  }, []);

  const t = useCallback(
    (key, vars) => {
      const dict = translations[language] || translations[DEFAULT_LANGUAGE];
      let str = dict[key];
      if (str === undefined) str = translations[DEFAULT_LANGUAGE][key] ?? key;
      if (vars) {
        Object.keys(vars).forEach((k) => {
          str = str.replaceAll(`{${k}}`, vars[k]);
        });
      }
      return str;
    },
    [language]
  );

  const categoryLabel = useCallback(
    (category) => (CATEGORY_LABELS[language] && CATEGORY_LABELS[language][category]) || category,
    [language]
  );

  const difficultyLabel = useCallback(
    (difficulty) => (DIFFICULTY_LABELS[language] && DIFFICULTY_LABELS[language][difficulty]) || difficulty,
    [language]
  );

  const value = useMemo(
    () => ({ language, setLanguage, t, categoryLabel, difficultyLabel }),
    [language, setLanguage, t, categoryLabel, difficultyLabel]
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error("useLanguage must be used within LanguageProvider");
  return ctx;
}
