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
