package com.tarifkutusu.app;

import android.content.Intent;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Android'in paylaşım menüsünden (TikTok/Instagram/YouTube -> "Tarif Kutusu")
 * gelen ACTION_SEND intent'lerini JS tarafına aktarır. Uygulama kapalıyken
 * paylaşılırsa {@link MainActivity#onCreate} içinde, uygulama zaten açıkken
 * paylaşılırsa {@link MainActivity#onNewIntent} içinde yakalanan veri burada
 * saklanır ve JS ilk fırsatta (getInitialShare çağrısı ya da "shareReceived"
 * olayı ile) alır.
 */
@CapacitorPlugin(name = "ShareReceiver")
public class ShareReceiverPlugin extends Plugin {

    static ShareReceiverPlugin instance;

    @Override
    public void load() {
        instance = this;
    }

    static JSObject extractShareData(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return null;
        if (intent.getType() == null || !intent.getType().startsWith("text/")) return null;
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        if (text == null && subject == null) return null;
        JSObject data = new JSObject();
        data.put("text", text == null ? "" : text);
        data.put("title", subject == null ? "" : subject);
        return data;
    }

    /** MainActivity'nin onNewIntent'inden, uygulama açıkken yeni bir paylaşım gelince çağrılır. */
    static void notifyShare(Intent intent) {
        JSObject data = extractShareData(intent);
        if (data != null && instance != null) {
            instance.notifyListeners("shareReceived", data);
        }
    }

    /** JS açılışta bunu çağırıp, soğuk başlangıçta bekleyen bir paylaşım olup olmadığını sorar. */
    @PluginMethod
    public void getInitialShare(PluginCall call) {
        Intent intent = getActivity() != null ? getActivity().getIntent() : null;
        JSObject data = extractShareData(intent);
        if (data == null) {
            call.resolve(new JSObject());
            return;
        }
        // Aynı paylaşımın sayfa yenilenince (reload) tekrar tekrar açılmaması için
        // action'ı temizliyoruz - getIntent() bir daha ACTION_SEND döndürmeyecek.
        if (getActivity() != null) {
            getActivity().getIntent().setAction(Intent.ACTION_MAIN);
        }
        call.resolve(data);
    }
}
