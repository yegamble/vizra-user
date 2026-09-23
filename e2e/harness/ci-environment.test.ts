/**
 * The runtime page-snapshot assertion's decision logic.
 *
 * The END-TO-END halves — a committed `.npmrc` blanking the variable inside the
 * Playwright process, and the environment a `$GITHUB_ENV` write would produce —
 * are demonstrations D16b and D16c, which run the real lane. These are the unit
 * layer underneath, including the inverse controls: a check that refused
 * everything would pass every red half and be useless.
 */

import { describe, expect, it } from "vitest";

import {
  assertPageSnapshotSuppressed,
  PAGE_SNAPSHOT_NOT_SUPPRESSED,
  pageSnapshotProblem,
} from "./ci-environment";

describe("pageSnapshotProblem", () => {
  it("is silent outside CI, whatever the variable says — developers keep the snapshot locally", () => {
    expect(pageSnapshotProblem({})).toBeUndefined();
    expect(pageSnapshotProblem({ PLAYWRIGHT_NO_COPY_PROMPT: "" })).toBeUndefined();
  });

  it("passes in CI when the variable is exactly \"1\" (the inverse control)", () => {
    expect(pageSnapshotProblem({ CI: "true", PLAYWRIGHT_NO_COPY_PROMPT: "1" })).toBeUndefined();
  });

  it("refuses the EMPTY string — the value the verifier's .npmrc line produced", () => {
    expect(pageSnapshotProblem({ CI: "true", PLAYWRIGHT_NO_COPY_PROMPT: "" })).toContain(
      PAGE_SNAPSHOT_NOT_SUPPRESSED,
    );
  });

  it("refuses the variable being UNSET, and says so", () => {
    expect(pageSnapshotProblem({ CI: "true" })).toContain("UNSET");
  });

  it("refuses \"0\" and \"true\" too: the requirement is exactly \"1\", not truthiness", () => {
    // "0" and "true" both happen to suppress the snapshot today, because
    // Playwright gates on truthiness. The requirement is the literal "1" so
    // that the lane guard's static rule and this runtime rule are one rule.
    expect(pageSnapshotProblem({ CI: "true", PLAYWRIGHT_NO_COPY_PROMPT: "0" })).toBeDefined();
    expect(pageSnapshotProblem({ CI: "true", PLAYWRIGHT_NO_COPY_PROMPT: "true" })).toBeDefined();
  });

  it("never ECHOES the value it refused — it arrived by a route nothing vetted", () => {
    const problem = pageSnapshotProblem({ CI: "1", PLAYWRIGHT_NO_COPY_PROMPT: "::error::injected" });
    expect(problem).toBeDefined();
    expect(problem).not.toContain("::error::injected");
  });
});

describe("assertPageSnapshotSuppressed", () => {
  it("throws with the named message and says WHEN it checked", () => {
    expect(() =>
      assertPageSnapshotSuppressed("at worker start", { CI: "true", PLAYWRIGHT_NO_COPY_PROMPT: "" }),
    ).toThrow(/PLAYWRIGHT_NO_COPY_PROMPT is not "1".*\[checked at worker start\]/s);
  });

  it("does not throw when the property holds", () => {
    expect(() =>
      assertPageSnapshotSuppressed("at worker start", { CI: "true", PLAYWRIGHT_NO_COPY_PROMPT: "1" }),
    ).not.toThrow();
  });
});
