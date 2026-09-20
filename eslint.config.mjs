import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

import vizra from "./eslint-rules/index.mjs";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // Pin the React version instead of leaving eslint-plugin-react to detect it
    // from the filesystem: under ESLint 10 that detection path calls the
    // removed `context.getFilename()` and crashes the run. Keep in step with
    // the `react` dependency in package.json.
    settings: { react: { version: "19.3" } },
  },
  {
    plugins: { vizra },
    rules: {
      // ADR-003 SSR identity. Both are errors, never warnings: a warning is a
      // privacy leak someone scrolls past.
      "vizra/no-identity-headers-in-cached-fetch": "error",
      "vizra/no-raw-fetch": ["error", { allow: ["lib/api/fetch.ts"] }],
      // Logging goes through a logger when one exists (ADR-002 requires a
      // redaction layer in it); stray console calls bypass redaction.
      "no-console": "error",
    },
  },
  {
    // Node scripts and the ESLint rules themselves: printing IS their output.
    // `vizra/no-raw-fetch` deliberately stays ON here — nothing under these
    // directories has any business touching global `fetch`, and switching the
    // rule off by directory is how the one file that mattered ended up
    // unguarded the first time.
    files: ["scripts/**/*.{mjs,js}", "eslint-rules/**/*.mjs"],
    rules: { "no-console": "off" },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated from vizra-core's OpenAPI spec by `npm run codegen`, and
    // verified byte-for-byte by `npm run check:contract`. Never hand-edited,
    // so never linted.
    "lib/api/generated.ts",
    // The vendored copy of core's contract (see contracts/manifest.json).
    "contracts/**",
    "coverage/**",
  ]),
]);

export default eslintConfig;
