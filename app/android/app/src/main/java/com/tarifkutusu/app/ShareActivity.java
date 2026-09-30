package com.tarifkutusu.app;

import android.annotation.SuppressLint;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.MotionEvent;
import android.view.VelocityTracker;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.animation.DecelerateInterpolator;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.accessibility.AccessibilityNodeInfoCompat.AccessibilityActionCompat;
import org.json.JSONObject;

/**
 * TikTok/Instagram/YouTube -> Paylaş -> Tarif Kutusu akışı. Tam ekran uygulamayı
 * açmak yerine, kaynak uygulamanın üstünde ekranın yaklaşık %78'ini kaplayan bir
 * panel açar; panel kapanınca Android kullanıcıyı kendiliğinden geldiği
 * uygulamaya döndürür (hiçbir paket adı bilinmiyor/yazılı değil).
 *
 * Panelin içeriği webde (SharePanel.jsx, "?sharePanel=1") duruyor ve burada düz
 * bir WebView'de gösteriliyor. Capacitor köprüsü bilerek kullanılmadı: ikinci
 * bir BridgeActivity tüm eklentileri yeniden yükler, @capacitor/push-notifications
 * statik köprüsünü bu kısa ömürlü panele bağlar ve tema/pencere ayarlarını
 * kendi ezer. WebView aynı uygulama sürecinde olduğu için Firebase oturumu ana
 * uygulamayla ortak (aynı origin, aynı WebView veri dizini).
 */
public class ShareActivity extends AppCompatActivity {

    private static final String PANEL_URL = "https://tarif-kutusu-paylas.vercel.app/?sharePanel=1";
    private static final String PANEL_HOST = "tarif-kutusu-paylas.vercel.app";
    private static final long SLIDE_MS = 220;
    // İçerik uzaktan geldiği için JS hiç çalışmayabilir; yükleniyor katmanı
    // sonsuza kadar kalmasın diye tavan.
    private static final long READY_TIMEOUT_MS = 12000;
    // Tutamaçtan yukarı sürükleme: tam uygulamaya geçmek için ya bu kadar
    // yukarı çekmek ya da (en az MIN_FLING_DP çekip) bu hızda fırlatmak lazım.
    // Karartma alanı ekranın ~%22'si (tipik telefonda ~170-190dp); 72dp onun
    // yarısından az, bilinçli bir çekiş ama zorlayıcı değil.
    private static final float EXPAND_DISTANCE_DP = 72f;
    private static final float EXPAND_VELOCITY_DP_S = 800f;
    private static final float MIN_FLING_DP = 24f;
    private static final long EXPAND_MS = 200;
    private static final long SNAP_BACK_MS = 180;

    private WebView webView;
    private View sheet;
    private View loading;
    private View errorBox;
    private String sharedText = "";
    private String sharedTitle = "";
    private boolean closing = false;
    // Panel job'ı gönderdikten sonra tam uygulamaya geçilirse link "Yeni Tarif
    // Çıkar"a tekrar taşınmıyor (aynı tarif ikinci kez oluşturulmasın).
    private volatile boolean jobAccepted = false;
    private View expandFill;
    private float density;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        readShareIntent(getIntent());
        setContentView(R.layout.activity_share);

        sheet = findViewById(R.id.share_sheet);
        loading = findViewById(R.id.share_loading);
        errorBox = findViewById(R.id.share_error);
        webView = findViewById(R.id.share_webview);
        expandFill = findViewById(R.id.share_expand_fill);
        density = getResources().getDisplayMetrics().density;

        findViewById(R.id.share_scrim).setOnClickListener(v -> closePanel());
        findViewById(R.id.share_error_close).setOnClickListener(v -> closePanel());

        // Kenardan kenara çizimde (targetSdk 35+) panel gezinme çubuğunun ve
        // klavyenin altında kalmasın.
        ViewCompat.setOnApplyWindowInsetsListener(sheet, (view, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.ime());
            view.setPadding(view.getPaddingLeft(), view.getPaddingTop(), view.getPaddingRight(), bars.bottom);
            return insets;
        });

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                closePanel();
            }
        });

        setupWebView();
        setupExpandGesture();
        webView.loadUrl(PANEL_URL);

        sheet.post(() -> {
            sheet.setTranslationY(sheet.getHeight());
            sheet.animate().translationY(0f).setDuration(SLIDE_MS).start();
        });
        new Handler(Looper.getMainLooper()).postDelayed(this::hideLoading, READY_TIMEOUT_MS);
    }

    private void readShareIntent(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return;
        if (intent.getType() == null || !intent.getType().startsWith("text/")) return;
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        sharedText = text == null ? "" : text;
        sharedTitle = subject == null ? "" : subject;
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void setupWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        webView.setBackgroundColor(Color.parseColor("#F3EFE6"));
        webView.addJavascriptInterface(new ShareBridge(), "TarifKutusuShare");
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (PANEL_HOST.equals(url.getHost())) return false;
                // Panel dışına çıkan her bağlantı (ör. video linki) sistem
                // tarayıcısında açılsın, bu pencerede değil.
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, url));
                } catch (ActivityNotFoundException e) {
                    // açacak uygulama yoksa sessizce yoksay
                }
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showError();
            }
        });
    }

    /**
     * Tutamaçtan yukarı sürükleyince tam uygulama. Dinleyici yalnızca tutamaç
     * satırında ve altındaki ince şeritte; WebView'ın kendi dokunma/kaydırma
     * olayları hiç görülmüyor. Aşağı hareket paneli oynatmıyor (eski davranış).
     */
    @SuppressLint("ClickableViewAccessibility")
    private void setupExpandGesture() {
        final float touchSlop = ViewConfiguration.get(this).getScaledTouchSlop();
        final float expandDistance = EXPAND_DISTANCE_DP * density;
        final float expandVelocity = EXPAND_VELOCITY_DP_S * density;
        final float minFling = MIN_FLING_DP * density;

        View.OnTouchListener listener = new View.OnTouchListener() {
            private float downY;
            private boolean dragging;
            private VelocityTracker velocity;

            @Override
            public boolean onTouch(View v, MotionEvent event) {
                if (closing) return true;
                switch (event.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        downY = event.getRawY();
                        dragging = false;
                        sheet.animate().cancel();
                        recycle();
                        velocity = VelocityTracker.obtain();
                        velocity.addMovement(event);
                        return true;
                    case MotionEvent.ACTION_MOVE: {
                        if (velocity != null) velocity.addMovement(event);
                        float up = downY - event.getRawY();
                        if (!dragging && up > touchSlop) {
                            dragging = true;
                            showExpandFill();
                        }
                        if (dragging) sheet.setTranslationY(-clampLift(up));
                        return true;
                    }
                    case MotionEvent.ACTION_UP: {
                        float up = downY - event.getRawY();
                        float upVelocity = 0f;
                        if (velocity != null) {
                            velocity.addMovement(event);
                            velocity.computeCurrentVelocity(1000);
                            upVelocity = -velocity.getYVelocity();
                        }
                        recycle();
                        if (dragging && (up >= expandDistance || (up >= minFling && upVelocity >= expandVelocity))) {
                            expandToApp();
                        } else if (dragging) {
                            snapBack();
                        }
                        dragging = false;
                        return true;
                    }
                    case MotionEvent.ACTION_CANCEL:
                        recycle();
                        if (dragging) snapBack();
                        dragging = false;
                        return true;
                    default:
                        return true;
                }
            }

            private void recycle() {
                if (velocity != null) {
                    velocity.recycle();
                    velocity = null;
                }
            }
        };

        View handle = findViewById(R.id.share_drag_handle);
        handle.setOnTouchListener(listener);
        findViewById(R.id.share_drag_extension).setOnTouchListener(listener);

        // Ekran okuyucu kullanıcıları sürükleyemediği için aynı işi yapan
        // "genişlet" eylemi (düz dokunuş bunu tetiklemiyor).
        ViewCompat.replaceAccessibilityAction(handle, AccessibilityActionCompat.ACTION_EXPAND, getString(R.string.share_expand), (view, args) -> {
            expandToApp();
            return true;
        });
    }

    /** Panel en fazla ekranın tepesine kadar kalkabilir. */
    private float clampLift(float up) {
        return Math.max(0f, Math.min(up, sheet.getTop()));
    }

    /** Panelin arkasındaki krem dolguyu, panelin yuvarlak köşelerinin altından başlatır. */
    private void showExpandFill() {
        expandFill.setTranslationY(sheet.getTop() + 20 * density);
        expandFill.setVisibility(View.VISIBLE);
    }

    private void snapBack() {
        sheet.animate()
            .translationY(0f)
            .setDuration(SNAP_BACK_MS)
            .setInterpolator(new DecelerateInterpolator())
            .withEndAction(() -> expandFill.setVisibility(View.GONE))
            .start();
    }

    /** Panel ekranın tepesine kadar büyür, sonra tam uygulama açılır. */
    private void expandToApp() {
        if (closing) return;
        closing = true;
        if (expandFill.getVisibility() != View.VISIBLE) showExpandFill();
        sheet.animate()
            .translationY(-sheet.getTop())
            .setDuration(EXPAND_MS)
            .setInterpolator(new DecelerateInterpolator())
            .withEndAction(this::launchFullApp)
            .start();
    }

    private void hideLoading() {
        if (loading.getVisibility() == View.VISIBLE) loading.setVisibility(View.GONE);
    }

    private void showError() {
        loading.setVisibility(View.GONE);
        webView.setVisibility(View.GONE);
        errorBox.setVisibility(View.VISIBLE);
    }

    private void closePanel() {
        if (closing) return;
        closing = true;
        sheet.animate().translationY(sheet.getHeight()).setDuration(SLIDE_MS).withEndAction(() -> {
            finish();
            overridePendingTransition(0, 0);
        }).start();
    }

    /** Paylaşımı ana uygulamaya (eski tam ekran "Yeni Tarif Çıkar" akışı) devreder. */
    private void openInMainApp() {
        startActivity(mainAppIntent(true));
        finish();
        overridePendingTransition(0, 0);
    }

    /**
     * Yukarı sürüklemenin sonu. Paylaşım henüz gönderilmediyse link, "Uygulamada
     * aç" ile aynı yoldan (ACTION_SEND -> ShareReceiverPlugin -> "Yeni Tarif
     * Çıkar") taşınıyor; gönderildiyse uygulama olduğu gibi açılıyor. MainActivity
     * singleTask: çalışıyorsa onNewIntent ile öne gelir, ikinci bir köprü açılmaz.
     */
    private void launchFullApp() {
        startActivity(mainAppIntent(!jobAccepted));
        finish();
        overridePendingTransition(android.R.anim.fade_in, android.R.anim.fade_out);
    }

    private Intent mainAppIntent(boolean withShare) {
        Intent intent = new Intent(this, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (!withShare) {
            intent.setAction(Intent.ACTION_MAIN);
            intent.addCategory(Intent.CATEGORY_LAUNCHER);
            return intent;
        }
        intent.setAction(Intent.ACTION_SEND);
        intent.setType("text/plain");
        intent.putExtra(Intent.EXTRA_TEXT, sharedText);
        intent.putExtra(Intent.EXTRA_SUBJECT, sharedTitle);
        return intent;
    }

    @Override
    protected void onDestroy() {
        if (webView != null) webView.destroy();
        super.onDestroy();
    }

    /** SharePanel.jsx'in kullandığı köprü (window.TarifKutusuShare). */
    private class ShareBridge {
        @JavascriptInterface
        public String getSharedText() {
            JSONObject data = new JSONObject();
            try {
                data.put("text", sharedText);
                data.put("title", sharedTitle);
            } catch (Exception e) {
                return "{}";
            }
            return data.toString();
        }

        @JavascriptInterface
        public void ready() {
            runOnUiThread(ShareActivity.this::hideLoading);
        }

        @JavascriptInterface
        public void close() {
            runOnUiThread(ShareActivity.this::closePanel);
        }

        /** SharePanel.jsx: sunucu job'ı kabul etti. */
        @JavascriptInterface
        public void jobAccepted() {
            jobAccepted = true;
        }

        @JavascriptInterface
        public void openInApp() {
            runOnUiThread(ShareActivity.this::openInMainApp);
        }
    }
}
