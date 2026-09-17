package com.tarifkutusu.app;

import android.annotation.SuppressLint;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
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

    private WebView webView;
    private View sheet;
    private View loading;
    private View errorBox;
    private String sharedText = "";
    private String sharedTitle = "";
    private boolean closing = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        readShareIntent(getIntent());
        setContentView(R.layout.activity_share);

        sheet = findViewById(R.id.share_sheet);
        loading = findViewById(R.id.share_loading);
        errorBox = findViewById(R.id.share_error);
        webView = findViewById(R.id.share_webview);

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
        Intent intent = new Intent(this, MainActivity.class);
        intent.setAction(Intent.ACTION_SEND);
        intent.setType("text/plain");
        intent.putExtra(Intent.EXTRA_TEXT, sharedText);
        intent.putExtra(Intent.EXTRA_SUBJECT, sharedTitle);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        startActivity(intent);
        finish();
        overridePendingTransition(0, 0);
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

        @JavascriptInterface
        public void openInApp() {
            runOnUiThread(ShareActivity.this::openInMainApp);
        }
    }
}
