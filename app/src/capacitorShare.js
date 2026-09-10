import { registerPlugin } from "@capacitor/core";

// Android tarafındaki özel ShareReceiverPlugin (app/android/.../ShareReceiverPlugin.java)
// ile eşleşen JS köprüsü - web'de kullanılmıyor, sadece Capacitor Android üzerinde.
const ShareReceiver = registerPlugin("ShareReceiver");

export default ShareReceiver;
