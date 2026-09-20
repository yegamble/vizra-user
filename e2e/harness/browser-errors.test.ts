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

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
 * STRUCTURAL: no spec may import Playwright's own `test`.
 *
 * `e2e/harness/test.ts` is the only guarded entry point. A spec that wrote
 * `import { test } from "@playwright/test"` would compile, run, pass — and be
 * exempt from the console/network guard, which is the one thing this harness
 * exists to provide. That is not a hypothetical: it is the shortest path a
 * hurried author takes, and the editor autocompletes it.
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

  it.each(files.map((file) => [path.relative(e2eRoot, file), file]))(
    "%s imports test from the harness, not from @playwright/test",
    (_label, file) => {
      const source = readFileSync(file, "utf8");
      const bareImports = source.match(/^\s*import\s+\{[^}]*\}\s+from\s+"@playwright\/test";?$/gm) ?? [];
      const valueImports = bareImports.filter((line) => !/^\s*import\s+type\s/.test(line));
      expect(
        valueImports,
        `${file} imports values from @playwright/test directly. Import { test, expect } from ` +
          `the harness instead, or the browser-error guard does not apply to this spec.`,
      ).toEqual([]);
    },
  );
});
