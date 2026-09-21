/**
 * WHAT THE RUNNERS COLLECT, pinned.
 *
 * THE HOLE THIS CLOSES. `playwright.config.ts` used to say
 * `testDir: "./e2e"` with `testMatch: "**​/*.spec.ts"`, while both source guards
 * enumerated `e2e/specs` and `e2e/demos`. An independent verifier put one file
 * at `e2e/other/__r1.spec.ts` whose page 404s a sub-resource and throws on every
 * load, and measured: ESLint exit 0 (the rule was not configured for that path),
 * `npm run ci` exit 0, the full lane exit 0 with
 * `coverage floor: OK (10/9 10/9)`, the out-of-process floor exit 0, and the
 * credential sweep blind to the file.
 *
 * Two independent changes close it, and both are asserted — here for the
 * collection root, and in `browser-errors.test.ts` for the lint glob:
 *
 *   - the lane collects `e2e/specs` only, and the demo runner `e2e/demos` only,
 *     so a file anywhere else is not collected at all;
 *   - the lint glob is `e2e/**` minus `e2e/harness/**`, so a file anywhere else
 *     is refused if anyone writes one.
 *
 * Neither is the guarantee. The guarantee is the runtime stamp
 * (`e2e/harness/stamp.ts`), which does not care where a file lives. These
 * assertions stop the collection root being quietly widened again, which is the
 * edit that made the third bypass possible.
 */

import { describe, expect, it } from "vitest";

import laneConfig from "../../playwright.config";
import demosConfig from "../../playwright.demos.config";

describe("the browser lane's collection root", () => {
  it("collects e2e/specs, and nothing wider", () => {
    expect(laneConfig.testDir).toBe("./e2e/specs");
  });

  it("still collects only *.spec.ts inside it", () => {
    // The demonstrations in e2e/demos/*.demo.ts are DESIGNED to fail; they must
    // never enter the lane's selection.
    expect(laneConfig.testMatch).toBe("**/*.spec.ts");
  });

  it("registers both the coverage floor and the runtime proof of harness", () => {
    // Both are re-checked out of process, so deleting either from this array is
    // caught; this assertion makes the deletion visible in the cheap lane too.
    const reporters = (laneConfig.reporter as ReadonlyArray<readonly unknown[]>).map(
      (entry) => String(entry[0]),
    );
    expect(reporters).toContain("./e2e/harness/coverage-reporter.ts");
    expect(reporters).toContain("./e2e/harness/stamp-reporter.ts");
  });
});

describe("the demonstration runner's collection root", () => {
  it("collects e2e/demos, and nothing wider", () => {
    // `playwright.demos.config.ts` spreads the lane config, whose testDir is now
    // `./e2e/specs`, so this override is load-bearing rather than cosmetic.
    expect(demosConfig.testDir).toBe("./e2e/demos");
  });

  it("collects only *.demo.ts inside it", () => {
    expect(demosConfig.testMatch).toBe("**/*.demo.ts");
  });

  it("proves the demos themselves went through the harness", () => {
    const reporters = (demosConfig.reporter as ReadonlyArray<readonly unknown[]>).map(
      (entry) => String(entry[0]),
    );
    expect(reporters).toContain("./e2e/harness/stamp-reporter.ts");
  });
});
