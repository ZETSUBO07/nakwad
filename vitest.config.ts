import { defineConfig } from "vitest/config";

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify("test") },
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/core/**", "src/i18n/**"],
      exclude: ["src/core/index.ts", "src/core/types.ts"],
      reporter: ["text-summary", "text"],
      // spec: core/ test coverage at least 90%
      thresholds: { "src/core/**": { lines: 90, statements: 90, functions: 90, branches: 85 } },
    },
  },
});
