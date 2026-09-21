/**
 * Cases for `vizra/no-unguarded-playwright-import`.
 *
 * The two INVALID cases marked "verifier" are the exact spellings an
 * independent verifier used to walk through the previous regex-based guard,
 * with a spec whose page 404s and throws on every load. Both gave the whole
 * gate exit 0. They are reproduced verbatim so the fix is tested against the
 * thing that broke it, not against a paraphrase of it.
 *
 * `@typescript-eslint/parser` is used because the exemptions this rule grants
 * are TypeScript-only syntax (`import type`, `{ type X }`, and inline
 * `import("…").Page` type positions). Testing them under a JavaScript parser
 * would test nothing.
 */

import tsParser from "@typescript-eslint/parser";
import { RuleTester } from "eslint";
import { describe, it } from "vitest";

import rule from "./no-unguarded-playwright-import.mjs";

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: "latest",
    sourceType: "module",
    parserOptions: { ecmaFeatures: { jsx: false } },
  },
});

const SPEC = "e2e/specs/example.spec.ts";
const DEMO = "e2e/demos/example.demo.ts";
/**
 * The modules that hold the runtime proof-of-harness key, as
 * `eslint.config.mjs` passes them. A file that could reach one of them could
 * sign a stamp for a test the browser-error guard never ran.
 */
const SEALED = ["e2e/harness/stamp", "e2e/harness/stamp-reporter"];
/**
 * The fixtures the harness owns, as `eslint.config.mjs` passes them.
 * `test.extend` may not replace these — the guard and the runtime stamp live in
 * one of them, and taking them apart is how a verifier kept a valid stamp while
 * the browser-error guard never ran.
 */
const HARNESS_FIXTURES = [
  "vizraHarnessGuard",
  "vizraWorkerGuard",
  "vizraHarnessStamp",
  "browserErrorPolicy",
];

ruleTester.run("no-unguarded-playwright-import", rule, {
  valid: [
    // The one legitimate import: the guarded harness entry.
    {
      code: `import { expect, test } from "../harness/test";\ntest("x", async ({ page }) => { await page.goto("/"); });`,
      filename: SPEC,
    },
    // BAN 3's inverse control. The honest fixture overrides — a viewport, a
    // locale, a second context — name none of the creation methods and stay
    // clean. A harness nobody can extend is a harness people work around.
    {
      name: "an honest page override that only sets a viewport stays valid",
      code: `import { test as base } from "../harness/test";\nconst test = base.extend({\n  page: async ({ browser }, provide) => {\n    const context = await browser.newContext({ viewport: { width: 1024, height: 768 }, locale: "en-GB" });\n    await provide(await context.newPage());\n  },\n});\nexport default test;`,
      filename: SPEC,
      options: [{ harnessEntry: "e2e/harness/test", harnessFixtures: HARNESS_FIXTURES }],
    },
    {
      name: "context.newCDPSession is NOT banned — it drives a page the harness already guards",
      code: `import { test } from "../harness/test";\ntest("x", async ({ page, context }) => { await context.newCDPSession(page); });`,
      filename: SPEC,
      options: [{ harnessEntry: "e2e/harness/test" }],
    },
    {
      name: "browser.newContext and browser.newPage are NOT banned — they go through the guard",
      code: `import { test } from "../harness/test";\ntest("x", async ({ browser }) => { const c = await browser.newContext(); await c.newPage(); });`,
      filename: SPEC,
      options: [{ harnessEntry: "e2e/harness/test" }],
    },
    {
      name: "an empty bannedMethods list turns ban 3 off, so the option is honest about what it controls",
      code: `import { test } from "../harness/test";\ntest("x", async ({ browser }) => { await browser.browserType().launch(); });`,
      filename: SPEC,
      options: [{ harnessEntry: "e2e/harness/test", bannedMethods: [] }],
    },
    // Single quotes are fine when the SOURCE is right — the rule is about the
    // module, never about how the string is punctuated.
    {
      code: `import { test } from '../harness/test';`,
      filename: SPEC,
    },
    // An explicit extension, and the `@/` alias, resolve to the same entry.
    { code: `import { test } from "../harness/test.ts";`, filename: SPEC },
    { code: `import { test } from "@/e2e/harness/test";`, filename: SPEC },
    // Demos import the same entry, from the same relative depth.
    { code: `import { expect, test } from "../harness/test";`, filename: DEMO },
    // Importing OTHER names from other modules is none of this rule's business.
    {
      code: `import { probeProductionBuild } from "../harness/production-build";`,
      filename: SPEC,
    },
    { code: `import path from "node:path";`, filename: SPEC },
    // A local identifier called `test` that is not imported at all.
    { code: `const test = 1;\nexport default test;`, filename: SPEC },
    // TYPE POSITIONS that cannot yield a runnable test.
    {
      code: `import type { Page } from "@playwright/test";\nexport function f(p: Page) { return p; }`,
      filename: SPEC,
    },
    {
      code: `import { type Page, type Response } from "@playwright/test";\nexport type P = Page | Response;`,
      filename: SPEC,
    },
    {
      code: `export async function go(page: import("@playwright/test").Page) { await page.goto("/"); }`,
      filename: DEMO,
    },
    // A package whose name merely STARTS WITH a banned one is a different
    // package and must not be reported — the match is on the whole name or a
    // path segment boundary, never on a prefix.
    { code: `import x from "@playwright/test-extras-not-real";`, filename: SPEC },
    { code: `import x from "playwright-extra";`, filename: SPEC },
    { code: `import x from "playwrightish";`, filename: SPEC },
  ],

  invalid: [
    // ---- the verifier's two bypasses, verbatim -----------------------------
    {
      name: "verifier bypass (a): namespace import",
      code: `import * as pw from "@playwright/test";\nconst test = pw.test;`,
      filename: SPEC,
      errors: [{ messageId: "packageReference" }],
    },
    {
      name: "verifier bypass (b): single quotes",
      code: `import { expect, test } from '@playwright/test';`,
      filename: SPEC,
      errors: [{ messageId: "packageReference" }],
    },

    // ---- every other spelling ---------------------------------------------
    {
      name: "named import, double quotes (the only one the old regex caught)",
      code: `import { expect, test } from "@playwright/test";`,
      filename: SPEC,
      errors: [{ messageId: "packageReference" }],
    },
    {
      name: "default import",
      code: `import pw from "@playwright/test";`,
      filename: SPEC,
      errors: [{ messageId: "packageReference" }],
    },
    {
      name: "side-effect import (no specifiers, still runs the module)",
      code: `import "@playwright/test";`,
      filename: SPEC,
      errors: [{ messageId: "packageReference" }],
    },
    {
      name: "require()",
      code: `const { test } = require("@playwright/test");`,
      filename: SPEC,
      errors: [{ messageId: "packageReference" }],
    },
    {
      name: "dynamic import() in a value position",
      code: `const pw = await import("@playwright/test");\nconst test = pw.test;`,
      filename: SPEC,
      errors: [{ messageId: "packageReference" }],
    },
    {
      name: "dynamic import() with a template literal",
      code: "const pw = await import(`@playwright/test`);",
      filename: SPEC,
      errors: [{ messageId: "packageReference" }],
    },
    {
      name: "the bare string handed to anything at all",
      code: `const mod = loader("@playwright/test");`,
      filename: SPEC,
      errors: [{ messageId: "packageReference" }],
    },
    {
      name: "a subpath of the package",
      code: `import { test } from "@playwright/test/reporter";`,
      filename: SPEC,
      errors: [{ messageId: "packageReference" }],
    },
    {
      name: "multi-line named import (caught before, must stay caught)",
      code: `import {\n  test,\n  expect,\n} from "@playwright/test";`,
      filename: SPEC,
      errors: [{ messageId: "packageReference" }],
    },

    // ---- re-exports, which make the raw binding reachable -----------------
    {
      name: "re-export named",
      code: `export { test, expect } from "@playwright/test";`,
      filename: SPEC,
      errors: [{ messageId: "reExport" }],
    },
    {
      name: "re-export all",
      code: `export * from "@playwright/test";`,
      filename: SPEC,
      errors: [{ messageId: "reExport" }],
    },

    // ---- the shim: `test` from anywhere but the harness entry -------------
    {
      name: "a local shim that re-exports the raw test does not work",
      code: `import { test, expect } from "./shim";`,
      filename: SPEC,
      errors: [{ messageId: "wrongSource" }, { messageId: "wrongSource" }],
    },
    {
      name: "renaming on the way in does not launder it",
      code: `import { test as t } from "./shim";`,
      filename: SPEC,
      errors: [{ messageId: "wrongSource" }],
    },
    {
      name: "renaming something else INTO `test` does not launder it either",
      code: `import { raw as test } from "./shim";`,
      filename: SPEC,
      errors: [{ messageId: "wrongSource" }],
    },
    {
      name: "a sibling harness module is not the harness ENTRY",
      code: `import { test } from "../harness/browser-errors";`,
      filename: SPEC,
      errors: [{ messageId: "wrongSource" }],
    },

    // ---- type-only, but of the names that matter --------------------------
    {
      name: "import type { test } is refused",
      code: `import type { test } from "@playwright/test";`,
      filename: SPEC,
      errors: [{ messageId: "typeImportOfGuardedName" }],
    },
    {
      name: "a type-only NAMESPACE import is refused",
      code: `import type * as pw from "@playwright/test";`,
      filename: SPEC,
      errors: [{ messageId: "typeImportOfGuardedName" }],
    },
    {
      name: "a mixed import is a value import",
      code: `import { type Page, test } from "@playwright/test";`,
      filename: SPEC,
      errors: [{ messageId: "packageReference" }],
    },

    // ---- the UNSCOPED package, which re-exports the same runner ----------
    // A verifier found that `import * as pw from "playwright/test"` passed
    // lint and RAN. It failed the lane only because loading a second runner
    // copy breaks the real tests — a module-loading accident, not a control.
    {
      name: "playwright/test namespace (the verifier's unscoped spelling)",
      code: `import * as pw from "playwright/test";\nconst test = pw.test;`,
      filename: SPEC,
      errors: [{ messageId: "packageReference" }],
    },
    {
      name: "playwright/test named form",
      code: `import { expect, test } from "playwright/test";`,
      filename: SPEC,
      errors: [{ messageId: "packageReference" }],
    },
    {
      name: "the unscoped library itself — a spec has no business launching a browser",
      code: `import { chromium } from "playwright";`,
      filename: SPEC,
      errors: [{ messageId: "packageReference" }],
    },
    {
      name: "a subpath of the unscoped package",
      code: `const { test } = require("playwright/lib/index");`,
      filename: SPEC,
      errors: [{ messageId: "packageReference" }],
    },

    // ---- the same bans apply to demos -------------------------------------
    {
      name: "a demo may not bypass the guard either",
      code: `import * as pw from "@playwright/test";`,
      filename: DEMO,
      errors: [{ messageId: "packageReference" }],
    },
    {
      name: "a demo may not use the unscoped spelling either",
      code: `import * as pw from "playwright/test";`,
      filename: DEMO,
      errors: [{ messageId: "packageReference" }],
    },

    // ---- the SEALED modules -----------------------------------------------
    // `e2e/harness/stamp.ts` holds the per-run key that proves at runtime which
    // tests went through the guard. A file that can reach it could sign a stamp
    // for a test the guard never ran — the one forgery the runtime control
    // cannot make impossible on its own, so it is refused here as well. The
    // spelling-agnostic catch-all covers every way of naming it, exactly as it
    // does for the package.
    {
      name: "a spec may not import the sealed stamp module",
      code: `import { claimSigner } from "../harness/stamp";`,
      filename: SPEC,
      options: [{ harnessEntry: "e2e/harness/test", sealedModules: SEALED }],
      errors: [{ messageId: "sealedModule" }],
    },
    {
      name: "namespace import of the sealed module",
      code: `import * as stamp from "../harness/stamp";`,
      filename: SPEC,
      options: [{ harnessEntry: "e2e/harness/test", sealedModules: SEALED }],
      errors: [{ messageId: "sealedModule" }],
    },
    {
      name: "require() of the sealed module",
      code: `const stamp = require("../harness/stamp");`,
      filename: SPEC,
      options: [{ harnessEntry: "e2e/harness/test", sealedModules: SEALED }],
      errors: [{ messageId: "sealedModule" }],
    },
    {
      name: "dynamic import of the sealed module",
      code: `const stamp = await import("../harness/stamp");`,
      filename: SPEC,
      options: [{ harnessEntry: "e2e/harness/test", sealedModules: SEALED }],
      errors: [{ messageId: "sealedModule" }],
    },
    {
      name: "an explicit extension resolves to the same sealed module",
      code: `import { claimSigner } from "../harness/stamp.ts";`,
      filename: SPEC,
      options: [{ harnessEntry: "e2e/harness/test", sealedModules: SEALED }],
      errors: [{ messageId: "sealedModule" }],
    },
    {
      name: "the @/ alias resolves to the same sealed module",
      code: `import { claimSigner } from "@/e2e/harness/stamp";`,
      filename: SPEC,
      options: [{ harnessEntry: "e2e/harness/test", sealedModules: SEALED }],
      errors: [{ messageId: "sealedModule" }],
    },
    {
      name: "the stamp reporter is sealed too",
      code: `import StampReporter from "../harness/stamp-reporter";`,
      filename: SPEC,
      options: [{ harnessEntry: "e2e/harness/test", sealedModules: SEALED }],
      errors: [{ messageId: "sealedModule" }],
    },
    {
      name: "a demo may not reach the sealed module either",
      code: `import { claimSigner } from "../harness/stamp";`,
      filename: DEMO,
      options: [{ harnessEntry: "e2e/harness/test", sealedModules: SEALED }],
      errors: [{ messageId: "sealedModule" }],
    },
    {
      name: "a bare string naming the sealed module is refused, like the package",
      code: `const where = "../harness/stamp";\nexport default where;`,
      filename: SPEC,
      options: [{ harnessEntry: "e2e/harness/test", sealedModules: SEALED }],
      errors: [{ messageId: "sealedModule" }],
    },

    // ---- the HARNESS-OWNED fixtures ---------------------------------------
    // The browser-error guard and the runtime stamp live in ONE automatic
    // fixture. They used to be two — an `auto` fixture that stamped and a `page`
    // override that guarded — and an independent verifier took them apart with
    // `test.extend({ page: … })`: the spec kept its valid stamp, the guard never
    // ran, and the whole gate went green on a page that 404s a sub-resource and
    // throws. Replacing the harness's own fixture is refused here as the early
    // warning; the control is that an unstamped pass is refused at runtime.
    {
      name: "a spec may not replace the harness's guard fixture",
      code: `import { test as base } from "../harness/test";\nconst test = base.extend({ vizraHarnessGuard: [async ({}, run) => { await run(); }, { auto: true }] });\nexport default test;`,
      filename: SPEC,
      options: [{ harnessEntry: "e2e/harness/test", harnessFixtures: HARNESS_FIXTURES }],
      errors: [{ messageId: "harnessFixtureOverride", data: { name: "vizraHarnessGuard" } }],
    },
    {
      name: "the fixture's previous name is refused too, so the old shape fails loudly",
      code: `import { test as base } from "../harness/test";\nconst test = base.extend({ vizraHarnessStamp: async ({}, run) => { await run(); } });\nexport default test;`,
      filename: SPEC,
      options: [{ harnessEntry: "e2e/harness/test", harnessFixtures: HARNESS_FIXTURES }],
      errors: [{ messageId: "harnessFixtureOverride" }],
    },
    {
      name: "a quoted key is the same override",
      code: `import { test as base } from "../harness/test";\nconst test = base.extend({ "vizraHarnessGuard": async ({}, run) => { await run(); } });\nexport default test;`,
      filename: SPEC,
      options: [{ harnessEntry: "e2e/harness/test", harnessFixtures: HARNESS_FIXTURES }],
      errors: [{ messageId: "harnessFixtureOverride" }],
    },
    {
      name: "the allow-list option fixture may not be replaced either",
      code: `import { test as base } from "../harness/test";\nconst test = base.extend({ browserErrorPolicy: [{ allow: [] }, { option: true }] });\nexport default test;`,
      filename: SPEC,
      options: [{ harnessEntry: "e2e/harness/test", harnessFixtures: HARNESS_FIXTURES }],
      errors: [{ messageId: "harnessFixtureOverride" }],
    },
    {
      name: "a computed key cannot be read, so it fails closed",
      code: `import { test as base } from "../harness/test";\nconst k = "vizraHarnessGuard";\nconst test = base.extend({ [k]: async ({}, run) => { await run(); } });\nexport default test;`,
      filename: SPEC,
      options: [{ harnessEntry: "e2e/harness/test", harnessFixtures: HARNESS_FIXTURES }],
      errors: [{ messageId: "harnessFixtureUnreadable" }],
    },
    {
      name: "a spread cannot be read, so it fails closed",
      code: `import { test as base } from "../harness/test";\nconst extra = {};\nconst test = base.extend({ ...extra });\nexport default test;`,
      filename: SPEC,
      options: [{ harnessEntry: "e2e/harness/test", harnessFixtures: HARNESS_FIXTURES }],
      errors: [{ messageId: "harnessFixtureUnreadable" }],
    },
    {
      name: "a fixtures object hoisted into a variable cannot be read either",
      code: `import { test as base } from "../harness/test";\nconst fixtures = {};\nconst test = base.extend(fixtures);\nexport default test;`,
      filename: SPEC,
      options: [{ harnessEntry: "e2e/harness/test", harnessFixtures: HARNESS_FIXTURES }],
      errors: [{ messageId: "harnessFixtureUnreadable" }],
    },
    // --- BAN 3: the import-free routes to an unguarded browser ------------
    // All three were measured by an independent verifier passing the COMPLETE
    // gate on a page that 404s a sub-resource and throws on every load — lint
    // green, lane exit 0, floor OK, stamp OK, out-of-process exit 0 — because
    // none of them imports a Playwright package. Reproduced verbatim.
    {
      name: "verifier: browser.browserType().launch() — two reportable members",
      code: `import { test } from "../harness/test";\ntest("x", async ({ browser }) => { const own = await browser.browserType().launch(); await own.newPage(); });`,
      filename: SPEC,
      options: [{ harnessEntry: "e2e/harness/test" }],
      errors: [
        { messageId: "unguardedCreation", data: { name: "launch" } },
        { messageId: "unguardedCreation", data: { name: "browserType" } },
      ],
    },
    {
      name: "verifier: playwright.chromium.launchPersistentContext(dir)",
      code: `import { test } from "../harness/test";\ntest("x", async ({ playwright }) => { await playwright.chromium.launchPersistentContext("/tmp/x"); });`,
      filename: SPEC,
      options: [{ harnessEntry: "e2e/harness/test" }],
      errors: [{ messageId: "unguardedCreation", data: { name: "launchPersistentContext" } }],
    },
    {
      name: "connect and connectOverCDP reach a browser the harness never launched",
      code: `import { test } from "../harness/test";\ntest("x", async ({ browser }) => { await browser.browserType().connect("ws://h/1"); await browser.browserType().connectOverCDP("http://h"); });`,
      filename: SPEC,
      options: [{ harnessEntry: "e2e/harness/test" }],
      errors: [
        { messageId: "unguardedCreation", data: { name: "connect" } },
        { messageId: "unguardedCreation", data: { name: "browserType" } },
        { messageId: "unguardedCreation", data: { name: "connectOverCDP" } },
        { messageId: "unguardedCreation", data: { name: "browserType" } },
      ],
    },
    {
      name: "launchServer plus connect is the same escape in two steps",
      code: `import { test } from "../harness/test";\ntest("x", async ({ playwright }) => { const s = await playwright.chromium.launchServer(); await playwright.chromium.connect(s.wsEndpoint()); });`,
      filename: SPEC,
      options: [{ harnessEntry: "e2e/harness/test" }],
      errors: [
        { messageId: "unguardedCreation", data: { name: "launchServer" } },
        { messageId: "unguardedCreation", data: { name: "connect" } },
      ],
    },
    {
      name: "naming the member without calling it is reportable too",
      code: `import { test } from "../harness/test";\ntest("x", async ({ browser }) => { const f = browser.browserType; await f.call(browser).launch(); });`,
      filename: SPEC,
      options: [{ harnessEntry: "e2e/harness/test" }],
      errors: [
        { messageId: "unguardedCreation", data: { name: "browserType" } },
        { messageId: "unguardedCreation", data: { name: "launch" } },
      ],
    },
    {
      name: "a computed member with a literal key is read as well",
      code: `import { test } from "../harness/test";\ntest("x", async ({ playwright }) => { await playwright.chromium["launch"](); });`,
      filename: SPEC,
      options: [{ harnessEntry: "e2e/harness/test" }],
      errors: [{ messageId: "unguardedCreation", data: { name: "launch" } }],
    },
    {
      name: "verifier FINDING 2: browser.newBrowserCDPSession() reaches a page no context owns",
      code: `import { test } from "../harness/test";\ntest("x", async ({ browser }) => { const s = await browser.newBrowserCDPSession(); await s.send("Target.createTarget", { url: "/" }); });`,
      filename: SPEC,
      options: [{ harnessEntry: "e2e/harness/test" }],
      errors: [{ messageId: "unguardedCreation", data: { name: "newBrowserCDPSession" } }],
    },
    {
      name: "the worker-scoped harness fixture may not be replaced either",
      code: `import { test as base } from "../harness/test";\nconst test = base.extend({ vizraWorkerGuard: [async ({}, run) => { await run(); }, { scope: "worker", auto: true }] });\nexport default test;`,
      filename: SPEC,
      options: [{ harnessEntry: "e2e/harness/test", harnessFixtures: HARNESS_FIXTURES }],
      errors: [{ messageId: "harnessFixtureOverride" }],
    },
    {
      name: "a demo is guarded by ban 3 too",
      code: `import { test } from "../harness/test";\ntest("x", async ({ browser }) => { await browser.browserType().launch(); });`,
      filename: DEMO,
      options: [{ harnessEntry: "e2e/harness/test" }],
      // The outer member (`.launch`) is visited before the inner
      // (`.browserType`), and both start at the same column, so this is the
      // order ESLint reports. Pinned rather than sorted: a change in either
      // would mean the rule started reading a different node.
      errors: [
        { messageId: "unguardedCreation", data: { name: "launch" } },
        { messageId: "unguardedCreation", data: { name: "browserType" } },
      ],
    },
    {
      name: "an overridden browser fixture written IN A SPEC is refused: a second browser belongs in e2e/harness/**",
      code: `import { test as base } from "../harness/test";\nconst test = base.extend({\n  browser: [async ({ playwright }, provide) => { const b = await playwright.chromium.launch(); await provide(b); await b.close(); }, { scope: "worker" }],\n});\nexport default test;`,
      filename: SPEC,
      options: [{ harnessEntry: "e2e/harness/test", harnessFixtures: HARNESS_FIXTURES }],
      errors: [{ messageId: "unguardedCreation", data: { name: "launch" } }],
    },
    {
      name: "a demo may not replace the harness fixture either",
      code: `import { test as base } from "../harness/test";\nconst test = base.extend({ vizraHarnessGuard: async ({}, run) => { await run(); } });\nexport default test;`,
      filename: DEMO,
      options: [{ harnessEntry: "e2e/harness/test", harnessFixtures: HARNESS_FIXTURES }],
      errors: [{ messageId: "harnessFixtureOverride" }],
    },
  ],
});
