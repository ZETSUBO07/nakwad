import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

// Any Thai character in app code means a string that should live in src/i18n and be read through t().
const THAI = "/[\\u0E00-\\u0E7F]/";
const thaiMessage = "Put Thai text in src/i18n/th.ts and read it with t().";

export default tseslint.config(
  { ignores: ["dist/", "dev-dist/", "coverage/", "node_modules/", "playwright-report/", "test-results/"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: { globals: { ...globals.browser, __APP_VERSION__: "readonly" } },
  },
  {
    files: ["src/**/*.ts"],
    ignores: ["src/i18n/**"],
    rules: {
      "no-restricted-syntax": ["error",
        { selector: `Literal[value=${THAI}]`, message: thaiMessage },
        { selector: `TemplateElement[value.raw=${THAI}]`, message: thaiMessage },
      ],
    },
  },
  {
    files: ["*.config.{js,ts}", "tests/**/*.ts"],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // tests build deliberately broken data and reach into it; `!` keeps them short
    files: ["tests/**/*.ts"],
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
  },
);
