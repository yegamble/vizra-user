import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts", "**/*.test.mjs"],
    exclude: ["node_modules/**", ".next/**", "contracts/**"],
    // A run that collected nothing is not a pass: an empty selection (a broken
    // glob, a renamed directory) would otherwise exit 0 with no tests.
    passWithNoTests: false,
  },
});
