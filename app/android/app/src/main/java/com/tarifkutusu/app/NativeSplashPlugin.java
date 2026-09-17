package com.tarifkutusu.app;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * MainActivity'nin tam ekran açılış görselini JS hazır olunca kaldırmak için.
 * (@capacitor/splash-screen bunu yapamıyor: Android 12+ splash API'si tam ekran
 * görsel desteklemiyor, bkz. MainActivity#showSplashOverlay.)
 */
@CapacitorPlugin(name = "NativeSplash")
public class NativeSplashPlugin extends Plugin {

    @PluginMethod
    public void hide(PluginCall call) {
        if (getActivity() instanceof MainActivity) {
            ((MainActivity) getActivity()).hideSplashOverlay();
        }
        call.resolve();
    }
}
