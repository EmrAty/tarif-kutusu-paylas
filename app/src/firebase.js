import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";

// Bu değerler Firebase konsolundaki proje ayarlarından ("Web app" config) geliyor.
// Gizli değildir — Firebase web config'i tarayıcıda görünmesi normal olan public bir
// tanımlayıcı kümesidir, güvenlik gerçek erişim kurallarıyla (Firebase Console'da
// Authentication > Settings) sağlanır. Kendi proje değerlerinle değiştir.
const firebaseConfig = {
  apiKey: "AIzaSyB9EptcLQLySYfZ87Ed59XFPYlK7ZpfqR0",
  authDomain: "tarif-kutusu.firebaseapp.com",
  projectId: "tarif-kutusu",
  storageBucket: "tarif-kutusu.firebasestorage.app",
  messagingSenderId: "821289337714",
  appId: "1:821289337714:web:f124f1e033a7126c6753eb",
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
