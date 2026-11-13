// Grup 5: bilerek KÜÇÜK bir lint seti. Amaç stil değil, uygulamayı çökerten ya
// da sessizce bozan hataları build'den önce yakalamak:
//  - react-hooks/rules-of-hooks: koşullu/erken return sonrası hook (Grup 3'te
//    FamiliesView'da yaşanan "hook sayısı değişti" çökmesi).
//  - no-undef: tanımsız değişken/fonksiyon (tek büyük App.jsx'te kolay kaçıyor).
//  - eslint:recommended içinden yalnızca hata türü kurallar (aşağıda).
// Yeni kural eklemeden önce: tüm kodda 0 bulgu olmalı, yoksa CI kırmızıya döner.
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  { ignores: ["dist/**", "android/**", "ios/**", "node_modules/**", "public/**"] },
  {
    files: ["**/*.{js,jsx,mjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      // __APP_VERSION__: vite.config.js `define` ile derlemede yazılıyor.
      globals: { ...globals.browser, ...globals.node, __APP_VERSION__: "readonly" },
    },
    // Koddaki exhaustive-deps yorumları bu sette açık olmayan kurala ait; uyarı üretmesin.
    linterOptions: { reportUnusedDisableDirectives: "off" },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "no-undef": "error",
      "no-dupe-keys": "error",
      "no-dupe-args": "error",
      "no-duplicate-case": "error",
      "no-unreachable": "error",
      "no-func-assign": "error",
      "no-import-assign": "error",
      "no-self-assign": "error",
      "no-unsafe-finally": "error",
      "no-unsafe-negation": "error",
      "valid-typeof": "error",
      "use-isnan": "error",
      "no-constant-binary-expression": "error",
    },
  },
];
