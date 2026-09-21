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
    // THE BROWSER HARNESS. Every file under `e2e/` except the harness itself
    // must take `test`/`expect` from the guarded harness entry and must not
    // reach `@playwright/test` at all.
    //
    // THE GLOB IS `e2e/**`, NOT `e2e/specs/** + e2e/demos/**`, and that is the
    // whole point. It used to name the two directories, while
    // `playwright.config.ts` collected `**​/*.spec.ts` under `e2e/`: an
    // independent verifier put a spec at `e2e/other/x.spec.ts` and it RAN,
    // linted by neither this rule nor the credential sweep — `npm run ci` exit
    // 0, the lane exit 0 with "coverage floor: OK (10/9 10/9)" — on a page that
    // 404s a sub-resource and throws on every load. A list of directories is a
    // guess about where people will put files. `e2e/**` minus the one directory
    // that must be exempt is not.
    //
    // `e2e/harness/**` is ignored deliberately: it is the module that must
    // import the real Playwright, and `.github/CODEOWNERS` covers it.
    //
    // This rule is the EARLY WARNING — it fails in seconds in `npm run ci`. It
    // is no longer the guarantee: the guarantee is the runtime stamp in
    // `e2e/harness/stamp.ts`, which a spec cannot pass by editing its import
    // line, its directory, or a comment.
    files: ["e2e/**/*.ts"],
    ignores: ["e2e/harness/**"],
    // NO INLINE CONFIG IN THESE DIRECTORIES. The rule below was, until this
    // line, optional: an independent verifier put
    // `/* eslint-disable vizra/no-unguarded-playwright-import */` above an
    // unguarded import in a spec whose page 404s a sub-resource and throws on
    // every load, and got `npm run ci` exit 0, the full lane exit 0 with
    // "20 passed, coverage floor: OK", both floor checks exit 0 and the lane
    // guard exit 0. `reportUnusedDisableDirectives` does not help, because the
    // directive is USED; and the vitest sweep lints through this same
    // configuration, so it inherited the suppression too.
    //
    // `noInlineConfig` turns off EVERY inline comment form at once —
    // `eslint-disable`, `eslint-disable-next-line`, `/* eslint rule: off */`,
    // `/* global */` — rather than naming the ones known today. A control that
    // is off by default for any file that asks is not default-deny, and
    // AGENTS.md states as reviewed contract that a spec may not reach
    // `@playwright/test` at all.
    linterOptions: { noInlineConfig: true },
    rules: {
      "vizra/no-unguarded-playwright-import": [
        "error",
        {
          harnessEntry: "e2e/harness/test",
          // The modules that hold the runtime stamp key. A spec that imported
          // one of them could ask it to sign a stamp for a test the guard never
          // ran. `claimSigner()` already refuses a second claim inside a worker,
          // so this is the cheap half of a control that also holds at runtime.
          sealedModules: ["e2e/harness/stamp", "e2e/harness/stamp-reporter"],
          // The fixtures the harness owns. `test.extend` may not replace these:
          // the browser-error guard and the runtime stamp live in
          // `vizraHarnessGuard`, so replacing it is how a spec would keep the
          // stamp and lose the guard — which is exactly what a verifier did to
          // the previous two-fixture design. Overriding `page`, `context` or
          // `browser` is NOT banned and must not be: the guard attaches at the
          // browser and covers whatever those fixtures produce, and a harness
          // nobody can extend is a harness people work around.
          //
          // `vizraHarnessStamp` is the fixture's old name, kept in the list so
          // that a spec written against the previous design fails loudly rather
          // than silently declaring an unused fixture.
          harnessFixtures: [
            "vizraHarnessGuard",
            "vizraHarnessStamp",
            "browserErrorPolicy",
          ],
        },
      ],
    },
  },
  {
    // The demonstrations deliberately make a page log an error — the console
    // call IS the fault under demonstration — and with `noInlineConfig` above
    // they can no longer say so with a disable comment. Turning `no-console`
    // off here, by configuration, is the honest replacement: it is visible in
    // this file, it is scoped to `e2e/demos/**`, and it does not reach any
    // product path or any spec. `e2e/specs/**` keeps `no-console` as an error.
    files: ["e2e/demos/**/*.ts"],
    rules: { "no-console": "off" },
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
    // Playwright's own output: the HTML report bundles minified third-party
    // JavaScript, and test-results holds traces and screenshots. Linting them
    // produced 3095 problems and a red `npm run ci` the first time a lane ran
    // before the gate did — a failure with nothing to do with this
    // repository's code. They are gitignored; this keeps them out of lint too.
    "playwright-report/**",
    "test-results/**",
  ]),
]);

export default eslintConfig;
