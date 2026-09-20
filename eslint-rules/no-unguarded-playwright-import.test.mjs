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

ruleTester.run("no-unguarded-playwright-import", rule, {
  valid: [
    // The one legitimate import: the guarded harness entry.
    {
      code: `import { expect, test } from "../harness/test";\ntest("x", async ({ page }) => { await page.goto("/"); });`,
      filename: SPEC,
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
  ],
});
