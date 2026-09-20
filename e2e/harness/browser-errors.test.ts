/**
 * Unit tests for the browser-error guard's decision logic, plus one structural
 * check on the specs themselves.
 *
 * WHY HERE AND NOT ONLY IN THE BROWSER LANE. The browser lane needs a build, a
 * server and a Chromium; these assertions need none of that, and they cover the
 * failure modes that would make the lane pass while proving nothing — an
 * allow-list that forgives the wrong kind, a blank reason that silences a
 * signal, a policy of the wrong shape, or a spec that quietly imports
 * Playwright's own unguarded `test`. Those are cheap to check and expensive to
 * discover later, so they run in `npm run test`.
 */

import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

import {
  DENY_ALL,
  formatFailure,
  guardBrowser,
  unallowedRecords,
  validatePolicy,
  type AllowedBrowserError,
  type BrowserErrorRecord,
} from "./browser-errors";

const e2eRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(e2eRoot, "..");

const consoleRecord: BrowserErrorRecord = {
  kind: "console",
  detail: "console.error: boom in the widget",
  where: "http://127.0.0.1:3210/",
};
const responseRecord: BrowserErrorRecord = {
  kind: "response",
  detail: "http 404: GET http://127.0.0.1:3210/missing.png",
  where: "http://127.0.0.1:3210/",
};
const pageErrorRecord: BrowserErrorRecord = {
  kind: "pageerror",
  detail: "pageerror: boom in the widget",
  where: "http://127.0.0.1:3210/",
};

describe("validatePolicy", () => {
  it("accepts the deny-all default", () => {
    expect(validatePolicy(DENY_ALL)).toEqual([]);
  });

  it("accepts a well-formed entry", () => {
    const policy = {
      allow: [{ kind: "response", match: /missing\.png/, reason: "not built yet (VZ-X)" }],
    };
    expect(validatePolicy(policy)).toEqual([]);
  });

  it("rejects a bare array, which Playwright would read as a fixture tuple", () => {
    // Measured against Playwright 1.63.0: `test.use({ x: [a, b] })` where `b`
    // is an object is parsed as [value, options], so `b` disappears. The policy
    // must therefore never be an array.
    const problems = validatePolicy([
      { kind: "console", match: /a/, reason: "r" },
      { kind: "console", match: /b/, reason: "r" },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("must be an object of the form { allow: [...] }");
  });

  it("rejects an entry with a blank reason", () => {
    for (const reason of ["", "   ", "\n\t"]) {
      const problems = validatePolicy({ allow: [{ kind: "console", match: /x/, reason }] });
      expect(problems.join("\n"), `reason ${JSON.stringify(reason)}`).toContain(
        "has no written reason",
      );
    }
  });

  it("rejects an entry with a missing reason", () => {
    expect(validatePolicy({ allow: [{ kind: "console", match: /x/ }] }).join("\n")).toContain(
      "has no written reason",
    );
  });

  it("rejects an unknown kind, so a typo cannot silently allow nothing", () => {
    const problems = validatePolicy({
      allow: [{ kind: "consoles", match: /x/, reason: "typo" }],
    });
    expect(problems.join("\n")).toContain("kind must be one of");
  });

  it("rejects a string match, which would never be applied as a pattern", () => {
    const problems = validatePolicy({
      allow: [{ kind: "console", match: "boom", reason: "looks right, matches nothing" }],
    });
    expect(problems.join("\n")).toContain("match must be a RegExp");
  });

  it("rejects a policy that is not an object at all", () => {
    for (const bad of [undefined, null, "console", 3]) {
      expect(validatePolicy(bad), String(bad)).not.toEqual([]);
    }
  });
});

describe("unallowedRecords", () => {
  it("lets nothing through by default", () => {
    expect(unallowedRecords([consoleRecord, responseRecord], [])).toHaveLength(2);
  });

  it("forgives only the matching kind", () => {
    // The same text, allowed as a console error, must NOT forgive the uncaught
    // exception: an allow-list that leaks across kinds is how a real crash gets
    // hidden behind an expected log line.
    const allow: AllowedBrowserError[] = [
      { kind: "console", match: /boom in the widget/, reason: "expected log" },
    ];
    const left = unallowedRecords([consoleRecord, pageErrorRecord], allow);
    expect(left).toEqual([pageErrorRecord]);
  });

  it("forgives only the matching pattern", () => {
    const allow: AllowedBrowserError[] = [
      { kind: "response", match: /other\.png/, reason: "a different asset" },
    ];
    expect(unallowedRecords([responseRecord], allow)).toEqual([responseRecord]);
  });

  it("forgives a record when kind and pattern both match", () => {
    const allow: AllowedBrowserError[] = [
      { kind: "response", match: /missing\.png/, reason: "not built yet" },
    ];
    expect(unallowedRecords([responseRecord], allow)).toEqual([]);
  });
});

/**
 * THE GUARD IS ATTACHED TO THE BROWSER, NOT TO ONE PAGE.
 *
 * WHY THIS BLOCK EXISTS. The guard used to live in an override of the `page`
 * fixture, beside a separate `auto` fixture that wrote the runtime stamp.
 * `test.extend` replaces one without the other, and an independent verifier did
 * exactly that — four lines of ordinary Playwright that keep the stamp and hand
 * back a page from a context the guard had never seen. The whole gate went green
 * on a page that 404s a sub-resource and throws on every load.
 *
 * The fix is that the guard now attaches at the BROWSER, at BrowserContext
 * level, so every context and page the test creates is covered. The behavioural
 * half of that is demonstrated against a real browser (D13, seven attack shapes
 * plus the honest-override control). These cases cover the parts that need no
 * browser at all, and in particular the one that would be a silent cross-test
 * bug rather than a visible failure: the worker's browser is SHARED, so a guard
 * that does not put back what it wrapped would make one test observe the next
 * test's pages.
 */
describe("guardBrowser", () => {
  type FakeContext = {
    handlers: Map<string, Array<(payload: unknown) => void>>;
    on: (event: string, handler: (payload: unknown) => void) => void;
    off: (event: string, handler: (payload: unknown) => void) => void;
    pages: () => unknown[];
  };

  const fakeContext = (): FakeContext => {
    const handlers = new Map<string, Array<(payload: unknown) => void>>();
    return {
      handlers,
      on: (event, handler) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      off: (event, handler) => {
        handlers.set(event, (handlers.get(event) ?? []).filter((one) => one !== handler));
      },
      pages: () => [],
    };
  };

  const fakeBrowser = (contexts: FakeContext[]) => {
    const created: FakeContext[] = [];
    const browser = {
      contexts: () => contexts,
      newContext: async () => {
        const context = fakeContext();
        created.push(context);
        return context;
      },
      newPage: async () => {
        const context = fakeContext();
        created.push(context);
        return { context: () => context };
      },
    };
    return { browser, created };
  };

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const guardOf = (browser: unknown) => guardBrowser(browser as any);
  /* eslint-enable @typescript-eslint/no-explicit-any */

  it("guards every context that already exists when it is installed", () => {
    // This is the case a spec-overridden `page` or `context` fixture produces:
    // the context is built before the harness fixture's body runs.
    const existing = [fakeContext(), fakeContext()];
    const { browser } = fakeBrowser(existing);
    const guard = guardOf(browser);

    expect(guard.contextCount()).toBe(2);
    for (const context of existing) {
      for (const event of ["console", "weberror", "requestfailed", "response"]) {
        expect(context.handlers.get(event), event).toHaveLength(1);
      }
    }
    guard.dispose();
  });

  it("guards a context created during the test, through browser.newContext", async () => {
    const { browser } = fakeBrowser([]);
    const guard = guardOf(browser);
    const context = (await browser.newContext()) as FakeContext;
    expect(guard.contextCount()).toBe(1);
    expect(context.handlers.get("console")).toHaveLength(1);
    guard.dispose();
  });

  it("guards the context behind browser.newPage too", async () => {
    const { browser } = fakeBrowser([]);
    const guard = guardOf(browser);
    const page = (await browser.newPage()) as { context: () => FakeContext };
    expect(guard.contextCount()).toBe(1);
    expect(page.context().handlers.get("weberror")).toHaveLength(1);
    guard.dispose();
  });

  it("guards a context once, however many times it is offered", async () => {
    const shared = fakeContext();
    const { browser } = fakeBrowser([shared, shared]);
    const guard = guardOf(browser);
    expect(guard.contextCount()).toBe(1);
    expect(shared.handlers.get("console")).toHaveLength(1);
    guard.dispose();
  });

  it("RESTORES the wrapped methods, so the shared worker browser is left as found", async () => {
    const { browser } = fakeBrowser([]);
    const originalNewContext = browser.newContext;
    const originalNewPage = browser.newPage;

    const guard = guardOf(browser);
    expect(browser.newContext, "newContext must be wrapped while guarding").not.toBe(
      originalNewContext,
    );
    expect(browser.newPage).not.toBe(originalNewPage);

    guard.dispose();
    expect(browser.newContext, "and put back afterwards").toBe(originalNewContext);
    expect(browser.newPage).toBe(originalNewPage);

    // And a context created after disposal is NOT guarded: otherwise one test's
    // fixture would record the next test's pages, in the same worker.
    const later = (await browser.newContext()) as FakeContext;
    expect(later.handlers.get("console") ?? []).toHaveLength(0);
  });

  it("detaches every listener on dispose", () => {
    const existing = [fakeContext()];
    const { browser } = fakeBrowser(existing);
    const guard = guardOf(browser);
    guard.dispose();
    for (const event of ["console", "weberror", "requestfailed", "response"]) {
      expect(existing[0]?.handlers.get(event) ?? [], event).toHaveLength(0);
    }
    expect(guard.contextCount()).toBe(0);
  });

  it("leaves no own property behind when the methods live on a PROTOTYPE", async () => {
    // Which is the real shape: Playwright's `Browser` methods are prototype
    // methods. Restoring a copy onto the instance would shadow the prototype for
    // the rest of the worker's life and make a second guard wrap the wrapper, so
    // the guard deletes the own property instead.
    const created: FakeContext[] = [];
    class FakeBrowser {
      contexts(): FakeContext[] {
        return [];
      }
      async newContext(): Promise<FakeContext> {
        const context = fakeContext();
        created.push(context);
        return context;
      }
      async newPage(): Promise<{ context: () => FakeContext }> {
        const context = fakeContext();
        created.push(context);
        return { context: () => context };
      }
    }
    const browser = new FakeBrowser();
    const guard = guardOf(browser);
    expect(Object.prototype.hasOwnProperty.call(browser, "newContext")).toBe(true);

    guard.dispose();
    expect(
      Object.prototype.hasOwnProperty.call(browser, "newContext"),
      "the wrapper must be removed, not replaced by a copy",
    ).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(browser, "newPage")).toBe(false);
    expect(browser.newContext).toBe(FakeBrowser.prototype.newContext);

    // And the restored prototype method still works, called on the instance.
    const after = await browser.newContext();
    expect(after.handlers.get("console") ?? []).toHaveLength(0);
  });

  it("nests and unwinds cleanly, so a stacked guard cannot strand a wrapper", async () => {
    // Not a shape the harness produces today, but the failure mode — a wrapper
    // left installed forever — is silent, and silence is what this whole slice
    // exists to refuse.
    const { browser } = fakeBrowser([]);
    const original = browser.newContext;
    const outer = guardOf(browser);
    const inner = guardOf(browser);
    inner.dispose();
    outer.dispose();
    expect(browser.newContext).toBe(original);
  });
});

describe("formatFailure", () => {
  it("names every unallowed signal and where it happened", () => {
    const message = formatFailure([consoleRecord, responseRecord], []);
    expect(message).toContain("console.error: boom in the widget");
    expect(message).toContain("http 404");
    expect(message).toContain("http://127.0.0.1:3210/");
    expect(message).toContain("No allow-list is in force");
  });

  it("prints the allow-list in force, with its reasons, when there is one", () => {
    const message = formatFailure(
      [responseRecord],
      [{ kind: "console", match: /boom/, reason: "the widget logs on purpose" }],
    );
    expect(message).toContain("the widget logs on purpose");
  });
});

/**
 * STRUCTURAL: every real spec and demo satisfies the guarded-import rule.
 *
 * WHAT THIS USED TO BE, AND WHY IT CHANGED. It was a regex over each spec's
 * source:
 *
 *     /^\s*import\s+\{[^}]*\}\s+from\s+"@playwright\/test";?$/gm
 *
 * requiring braces AND double quotes. An independent verifier put two specs
 * into `e2e/specs/` whose page 404s and throws an uncaught error on every
 * load — `import * as pw from "@playwright/test"` and the named form with
 * single quotes — and got `npm run ci` exit 0 and `npm run e2e` exit 0,
 * "20 passed, coverage floor: OK". Matching import syntax is guessing at
 * spellings.
 *
 * The enforcement is now an AST rule, `vizra/no-unguarded-playwright-import`,
 * whose own cases live in `eslint-rules/no-unguarded-playwright-import.test.mjs`
 * and cover every spelling: named, namespace, default, side-effect, `require`,
 * dynamic `import()`, either quote style, re-exports, and a local shim that
 * re-exports the raw binding.
 *
 * This block keeps the other half — that the rule is actually APPLIED to the
 * real files. A perfect rule wired to no files protects nothing, and "is it
 * configured for this path" is not something the rule's own unit tests can
 * answer. So it runs the repository's real ESLint configuration over every
 * real spec and demo, and fails if any of them reports a violation or if the
 * sweep finds no files at all.
 */
describe("specs use the guarded test", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (/\.(spec|demo)\.ts$/.test(entry)) {
        files.push(full);
      }
    }
  };
  walk(e2eRoot);

  it("finds the specs at all (an empty sweep would pass vacuously)", () => {
    expect(files.length).toBeGreaterThanOrEqual(4);
  });

  it("applies the guarded-import rule to every one of them", async () => {
    // The repository's REAL configuration, not a hand-built one: the property
    // under test is that eslint.config.mjs wires the rule to these paths.
    const eslint = new ESLint({ cwd: repoRoot });
    const results = await eslint.lintFiles(files);

    // A file ESLint decided not to lint at all would silently pass, so assert
    // the sweep covered every file first.
    expect(results.map((result) => result.filePath).sort()).toEqual(
      files.map((file) => path.resolve(file)).sort(),
    );

    const violations = results.flatMap((result) =>
      result.messages
        .filter((message) => message.ruleId === "vizra/no-unguarded-playwright-import")
        .map((message) => `${path.relative(repoRoot, result.filePath)}:${message.line} ${message.message}`),
    );
    expect(violations, violations.join("\n")).toEqual([]);
  });

  /**
   * INLINE DIRECTIVES ARE OFF for these directories.
   *
   * The rule was, until `linterOptions: { noInlineConfig: true }`, optional: an
   * independent verifier put `/* eslint-disable vizra/no-unguarded-playwright-import *​/`
   * above an unguarded import in a spec whose page 404s a sub-resource and
   * throws on every load, and got `npm run ci` exit 0, the full lane exit 0
   * with "20 passed, coverage floor: OK", both floor checks exit 0 and the lane
   * guard exit 0. `reportUnusedDisableDirectives` cannot help, because the
   * directive is USED; and this very sweep lints through the same ESLint, so it
   * inherited the suppression.
   *
   * Two assertions, because either alone rots: the SETTING must be present in
   * the resolved configuration, and the BEHAVIOUR must hold for every comment
   * form — a future ESLint could keep the option and change what it covers.
   */
  it("the resolved config for e2e/specs and e2e/demos forbids inline config", async () => {
    const eslint = new ESLint({ cwd: repoRoot });
    for (const file of ["e2e/specs/home.spec.ts", "e2e/demos/console-error.demo.ts"]) {
      const config = (await eslint.calculateConfigForFile(path.join(repoRoot, file))) as {
        linterOptions?: { noInlineConfig?: boolean };
      };
      expect(
        config.linterOptions?.noInlineConfig,
        `${file} must resolve to linterOptions.noInlineConfig === true, or one comment ` +
          "turns the browser-error guard off for that file",
      ).toBe(true);
    }
  });

  it.each([
    ["/* eslint-disable vizra/no-unguarded-playwright-import */", "block disable, rule named"],
    ["/* eslint-disable */", "block disable, no rule named"],
    ["/* eslint vizra/no-unguarded-playwright-import: \"off\" */", "inline severity override"],
  ])("an inline directive (%s) does not exempt a spec", async (directive) => {
    const eslint = new ESLint({ cwd: repoRoot });
    const [result] = await eslint.lintText(
      `${directive}\nimport { test } from "@playwright/test";\nexport default test;\n`,
      { filePath: path.join(repoRoot, "e2e/specs/__inline_directive__.spec.ts") },
    );
    const message = result?.messages.find(
      (candidate) => candidate.ruleId === "vizra/no-unguarded-playwright-import",
    );
    expect(message, `the directive suppressed the rule: ${directive}`).toBeDefined();
    expect(message?.severity, "and it must still be an error").toBe(2);
  });

  it("eslint-disable-next-line does not exempt the line after it either", async () => {
    const eslint = new ESLint({ cwd: repoRoot });
    const [result] = await eslint.lintText(
      `// eslint-disable-next-line vizra/no-unguarded-playwright-import\n` +
        `import { test } from "@playwright/test";\nexport default test;\n`,
      { filePath: path.join(repoRoot, "e2e/specs/__inline_directive_next__.spec.ts") },
    );
    const message = result?.messages.find(
      (candidate) => candidate.ruleId === "vizra/no-unguarded-playwright-import",
    );
    expect(message).toBeDefined();
    expect(message?.severity).toBe(2);
  });

  it("the unscoped `playwright/test` spelling is refused by the rule, not by luck", async () => {
    // It used to pass lint and RUN; it failed the lane only because loading a
    // second runner copy breaks the real tests. That is an accident, not a
    // control.
    const eslint = new ESLint({ cwd: repoRoot });
    const [result] = await eslint.lintText(
      `import * as pw from "playwright/test";\nexport default pw.test;\n`,
      { filePath: path.join(repoRoot, "e2e/specs/__unscoped__.spec.ts") },
    );
    const message = result?.messages.find(
      (candidate) => candidate.ruleId === "vizra/no-unguarded-playwright-import",
    );
    expect(message).toBeDefined();
    expect(message?.severity).toBe(2);
  });

  /**
   * THE CLASS, NOT THE DIRECTORY.
   *
   * The two assertions above ask about `e2e/specs/home.spec.ts` and
   * `e2e/demos/console-error.demo.ts` — two files that exist. That is what let
   * the third bypass through: `eslint.config.mjs` named `e2e/specs/**` and
   * `e2e/demos/**` while `playwright.config.ts` collected `**​/*.spec.ts` from
   * the whole of `e2e/`, and an independent verifier put a spec at
   * `e2e/other/__r1.spec.ts` that ran, was linted by nothing, and took `npm run
   * ci` and the full lane to exit 0 on a page that 404s and throws.
   *
   * So the question is asked of EVERY file the sweep finds AND of paths in
   * directories that do not exist yet. A configuration that covers today's two
   * directories and not tomorrow's passes the tests above and fails these.
   */
  it("resolves the rule to severity 2 with noInlineConfig for every file under e2e/", async () => {
    const eslint = new ESLint({ cwd: repoRoot });
    const everything: string[] = [];
    const walkAll = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (dir === e2eRoot && entry === "harness") continue;
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walkAll(full);
        else if (/\.ts$/.test(entry)) everything.push(full);
      }
    };
    walkAll(e2eRoot);
    expect(everything.length, "an empty sweep would pass vacuously").toBeGreaterThanOrEqual(4);

    for (const file of everything) {
      const config = (await eslint.calculateConfigForFile(file)) as {
        rules?: Record<string, unknown>;
        linterOptions?: { noInlineConfig?: boolean };
      };
      const severity = config.rules?.["vizra/no-unguarded-playwright-import"];
      expect(
        Array.isArray(severity) ? severity[0] : severity,
        `${path.relative(repoRoot, file)} must resolve the guarded-import rule to severity 2`,
      ).toBe(2);
      expect(
        config.linterOptions?.noInlineConfig,
        `${path.relative(repoRoot, file)} must resolve linterOptions.noInlineConfig === true`,
      ).toBe(true);
    }
  });

  it.each([
    ["e2e/other/__r1.spec.ts", "the verifier's third bypass, in a directory that does not exist"],
    ["e2e/nested/deeper/__x.spec.ts", "a directory two levels down"],
    ["e2e/__loose.spec.ts", "a spec directly under e2e/"],
    ["e2e/specs/helpers/__helper.ts", "a helper beside a spec, not itself a spec"],
  ])("%s (%s) is covered by the rule at severity 2", async (relative) => {
    const eslint = new ESLint({ cwd: repoRoot });
    const config = (await eslint.calculateConfigForFile(path.join(repoRoot, relative))) as {
      rules?: Record<string, unknown>;
      linterOptions?: { noInlineConfig?: boolean };
    };
    const severity = config.rules?.["vizra/no-unguarded-playwright-import"];
    expect(Array.isArray(severity) ? severity[0] : severity).toBe(2);
    expect(config.linterOptions?.noInlineConfig).toBe(true);
  });

  it("e2e/harness stays exempt — it is the module that imports the real Playwright", async () => {
    // The exemption is deliberate and it is the only one. If this ever starts
    // failing, the harness has been brought under its own rule and cannot work;
    // if the assertion is deleted, the exemption stops being a stated decision.
    const eslint = new ESLint({ cwd: repoRoot });
    const config = (await eslint.calculateConfigForFile(
      path.join(repoRoot, "e2e/harness/test.ts"),
    )) as { rules?: Record<string, unknown> };
    expect(config.rules?.["vizra/no-unguarded-playwright-import"]).toBeUndefined();
  });

  /**
   * THE SEALED MODULES. `e2e/harness/stamp.ts` holds the per-run key that proves
   * at runtime which tests went through the guard. A spec that could import it
   * could sign a stamp for a test the guard never ran — so the rule refuses the
   * reference. `claimSigner()` refuses a second claim inside a worker as well,
   * which is the half that does not depend on lint; this is the half that fails
   * in seconds.
   */
  it.each([
    ['import { claimSigner } from "../harness/stamp";', "a named import"],
    ['import * as s from "../harness/stamp";', "a namespace import"],
    ['const s = require("../harness/stamp");', "require"],
    ['const s = await import("../harness/stamp");', "a dynamic import"],
    ['import x from "../harness/stamp-reporter";', "the reporter"],
  ])("a spec may not reach the sealed stamp module (%s)", async (line) => {
    const eslint = new ESLint({ cwd: repoRoot });
    const [result] = await eslint.lintText(
      `import { test } from "../harness/test";\n${line}\nexport default test;\n`,
      { filePath: path.join(repoRoot, "e2e/specs/__sealed__.spec.ts") },
    );
    const message = result?.messages.find(
      (candidate) => candidate.ruleId === "vizra/no-unguarded-playwright-import",
    );
    expect(message, `the sealed module was reachable: ${line}`).toBeDefined();
    expect(message?.severity).toBe(2);
    expect(message?.message).toContain("per-run key");
  });

  /**
   * THE HARNESS-OWNED FIXTURES. The guard and the runtime stamp live in one
   * automatic fixture so that removing the guard removes the stamp. Replacing
   * that fixture from a spec is refused at lint time — the early warning for the
   * exact move that let a verifier keep a valid stamp while the guard never ran.
   */
  it.each([
    ["vizraHarnessGuard", "the combined guard-and-stamp fixture"],
    ["vizraHarnessStamp", "its previous name, so the old shape fails loudly"],
    ["browserErrorPolicy", "the allow-list option fixture"],
  ])("a spec may not replace the harness fixture %s (%s)", async (fixture) => {
    const eslint = new ESLint({ cwd: repoRoot });
    const [result] = await eslint.lintText(
      `import { test as base } from "../harness/test";\n` +
        `const test = base.extend({ ${fixture}: async ({}, run) => { await run(); } });\n` +
        `export default test;\n`,
      { filePath: path.join(repoRoot, "e2e/specs/__fixture_override__.spec.ts") },
    );
    const message = result?.messages.find(
      (candidate) => candidate.ruleId === "vizra/no-unguarded-playwright-import",
    );
    expect(message, `overriding ${fixture} was allowed`).toBeDefined();
    expect(message?.severity).toBe(2);
    expect(message?.message).toContain("may not replace the harness's own fixture");
  });

  it("but overriding `page`, `context` or `browser` stays legal — the guard covers them", async () => {
    // This is the inverse control, and it matters as much as the ban. The guard
    // attaches at the BROWSER, so a spec that overrides `page` for a viewport or
    // a locale is guarded rather than exempt. A harness nobody can extend is a
    // harness people work around, and banning `.extend` wholesale would have
    // been the easy, wrong fix.
    const eslint = new ESLint({ cwd: repoRoot });
    for (const fixture of ["page", "context", "browser"]) {
      const [result] = await eslint.lintText(
        `import { test as base } from "../harness/test";\n` +
          `const test = base.extend({ ${fixture}: async ({ browser }, run) => { await run(await browser.newPage()); } });\n` +
          `export default test;\n`,
        { filePath: path.join(repoRoot, "e2e/specs/__honest_override__.spec.ts") },
      );
      expect(
        result?.messages.filter(
          (candidate) => candidate.ruleId === "vizra/no-unguarded-playwright-import",
        ),
        `overriding ${fixture} must stay legal`,
      ).toEqual([]);
    }
  });

  it("other harness modules stay importable — the seal is narrow, not a blanket ban", async () => {
    // e2e/specs/production-build.spec.ts legitimately imports
    // ../harness/production-build. Sealing the whole directory would have broken
    // it, and a rule that breaks legitimate code gets switched off.
    const eslint = new ESLint({ cwd: repoRoot });
    const [result] = await eslint.lintText(
      `import { probeProductionBuild } from "../harness/production-build";\n` +
        `import { test } from "../harness/test";\nexport default [test, probeProductionBuild];\n`,
      { filePath: path.join(repoRoot, "e2e/specs/__narrow__.spec.ts") },
    );
    expect(
      result?.messages.filter(
        (candidate) => candidate.ruleId === "vizra/no-unguarded-playwright-import",
      ),
    ).toEqual([]);
  });

  it("the rule is configured as an error for e2e/specs, not a warning", async () => {
    // A rule set to "warn" would report and let the gate pass. Asked of the
    // real config, for a real path, with a spelling the old regex missed.
    const eslint = new ESLint({ cwd: repoRoot });
    const [result] = await eslint.lintText(
      `import * as pw from "@playwright/test";\nconst test = pw.test;\nexport default test;\n`,
      { filePath: path.join(repoRoot, "e2e/specs/__rule_is_wired__.spec.ts") },
    );
    const message = result?.messages.find(
      (candidate) => candidate.ruleId === "vizra/no-unguarded-playwright-import",
    );
    expect(message, "the rule did not fire on a namespace import in e2e/specs/").toBeDefined();
    expect(message?.severity, "the rule must be an error, never a warning").toBe(2);
  });
});
