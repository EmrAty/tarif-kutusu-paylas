package com.tarifkutusu.app;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.ViewGroup;
import android.widget.ImageView;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    // İçerik uzak sunucudan (Vercel) yüklendiği için JS hiç çalışmayabilir
    // (ör. internet yokken) - o durumda açılış görselinde takılı kalmamak için tavan.
    private static final long SPLASH_TIMEOUT_MS = 10000;

    private ImageView splashOverlay;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ShareReceiverPlugin.class);
        registerPlugin(NativeSplashPlugin.class);
        super.onCreate(savedInstanceState);

        showSplashOverlay();

        // Android 13+ (API 33) sistem bildirimleri göstermek için elle onay
        // istiyor - aile bildirimi ("canı çekti") özelliği bunsuz sessizce
        // görünmez kalır.
        if (Build.VERSION.SDK_INT >= 33
                && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                        != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, new String[] { Manifest.permission.POST_NOTIFICATIONS }, 1001);
        }
    }

    /**
     * Tam ekran açılış görseli. Android 12+ sistem splash API'si yalnızca "arka plan
     * rengi + ortada ikon" gösterebildiği için (bkz. values/styles.xml), markanın tam
     * ekran görseli TWA'daki gibi WebView'in üzerine kendi ImageView'imizle çiziliyor.
     * JS hazır olunca NativeSplashPlugin üzerinden kaldırılıyor.
     */
    private void showSplashOverlay() {
        splashOverlay = new ImageView(this);
        splashOverlay.setImageResource(R.drawable.splash);
        splashOverlay.setScaleType(ImageView.ScaleType.CENTER_CROP);
        splashOverlay.setBackgroundColor(ContextCompat.getColor(this, R.color.splashBackground));
        addContentView(
            splashOverlay,
            new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        );
        new Handler(Looper.getMainLooper()).postDelayed(this::hideSplashOverlay, SPLASH_TIMEOUT_MS);
    }

    void hideSplashOverlay() {
        runOnUiThread(() -> {
            final ImageView overlay = splashOverlay;
            if (overlay == null) return;
            splashOverlay = null;
            overlay
                .animate()
                .alpha(0f)
                .setDuration(250)
                .withEndAction(() -> {
                    ViewGroup parent = (ViewGroup) overlay.getParent();
                    if (parent != null) parent.removeView(overlay);
                })
                .start();
        });
    }

    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        ShareReceiverPlugin.notifyShare(intent);
    }
}
