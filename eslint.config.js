import eslint from "@eslint/js"
import tseslint from "typescript-eslint"
import prettier from "eslint-config-prettier"

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    ignores: ["dist/", "node_modules/", "src/vendor/", ".claude/"],
  },
  {
    // MV3 service worker (plain JS, browser globals + chrome.* APIs).
    // Lives outside the main typescript build; needs its own globals
    // declaration so eslint's no-undef rule passes.
    files: ["src/browser-ext/**/*.js"],
    languageOptions: {
      globals: {
        chrome: "readonly",
        console: "readonly",
        document: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        globalThis: "readonly",
        // SW-context global: navigator.locks serialises debugger-attach
        // attempts after MV3 SW respawn.
        navigator: "readonly",
        // Page-context globals: these appear inside the `func` arg of
        // chrome.scripting.executeScript blocks which run in the
        // injected page, not the SW. Listed as readonly so the SW's
        // own no-undef check doesn't flag them.
        window: "readonly",
        HTMLInputElement: "readonly",
        HTMLTextAreaElement: "readonly",
        MouseEvent: "readonly",
        InputEvent: "readonly",
        KeyboardEvent: "readonly",
        Event: "readonly",
        getComputedStyle: "readonly",
        CSS: "readonly",
      },
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
)
