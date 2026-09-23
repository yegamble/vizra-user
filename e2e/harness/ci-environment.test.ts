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
  assertEnvironmentUnchanged,
  assertPageSnapshotSuppressed,
  captureEnvironment,
  ENVIRONMENT_CHANGED,
  environmentChanges,
  PAGE_SNAPSHOT_NOT_SUPPRESSED,
  pageSnapshotProblem,
  takeEnvironmentChange,
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
    const env = { CI: "true", PLAYWRIGHT_NO_COPY_PROMPT: "" };
    expect(() => assertPageSnapshotSuppressed("at worker start", env, captureEnvironment(env))).toThrow(
      /PLAYWRIGHT_NO_COPY_PROMPT is not "1".*\[checked at worker start\]/s,
    );
  });

  it("does not throw when the property holds", () => {
    const env = { CI: "true", PLAYWRIGHT_NO_COPY_PROMPT: "1" };
    expect(() => assertPageSnapshotSuppressed("at worker start", env, captureEnvironment(env))).not.toThrow();
  });
});

// PR #8, R3-FINDING J. The check used to read the LIVE environment and return
// early when `CI` was unset, so a spec that deleted `CI` switched the check off.
// It now compares the live values with the ones captured at configuration load.
describe("the capture taken at configuration load", () => {
  const job = () => ({ CI: "true", PLAYWRIGHT_NO_COPY_PROMPT: "1" }) as Record<string, string | undefined>;

  it("THE VERIFIER'S TWO LINES fail by name — deleting CI is itself the difference", () => {
    const live = job();
    const captured = captureEnvironment(live);
    delete live.CI;
    live.PLAYWRIGHT_NO_COPY_PROMPT = "";
    // The OLD behaviour, for the record: judged live, the policy is silent.
    expect(pageSnapshotProblem(live)).toBeUndefined();
    // Judged against the capture, it is not.
    expect(() => assertPageSnapshotSuppressed("after the test body", live, captured)).toThrow(ENVIRONMENT_CHANGED);
  });

  it("RESTORES the captured values before it throws — that is what makes a pre-close check a prevention", () => {
    const live = job();
    const captured = captureEnvironment(live);
    delete live.CI;
    live.PLAYWRIGHT_NO_COPY_PROMPT = "";
    expect(() => assertEnvironmentUnchanged("after the test body", live, captured)).toThrow();
    expect(live).toEqual({ CI: "true", PLAYWRIGHT_NO_COPY_PROMPT: "1" });
    expect(environmentChanges(live, captured)).toEqual([]);
  });

  it("restores an UNSET capture by deleting the key, not by storing the string \"undefined\"", () => {
    const live: Record<string, string | undefined> = {};
    const captured = captureEnvironment(live);
    live.PLAYWRIGHT_NO_COPY_PROMPT = "1";
    live.CI = "1";
    expect(takeEnvironmentChange("x", live, captured)).toContain(ENVIRONMENT_CHANGED);
    expect("CI" in live).toBe(false);
    expect("PLAYWRIGHT_NO_COPY_PROMPT" in live).toBe(false);
  });

  it("fails on a change even outside CI — a spec may not write either variable anywhere", () => {
    const live: Record<string, string | undefined> = {};
    const captured = captureEnvironment(live);
    live.PLAYWRIGHT_NO_COPY_PROMPT = "";
    expect(() => assertEnvironmentUnchanged("x", live, captured)).toThrow(ENVIRONMENT_CHANGED);
  });

  it("names each changed key and whether it was set or unset, and never echoes a value", () => {
    const live = job();
    const captured = captureEnvironment(live);
    delete live.CI;
    live.PLAYWRIGHT_NO_COPY_PROMPT = "::error::injected";
    const message = takeEnvironmentChange("at worker start", live, captured) ?? "";
    expect(message).toContain("`CI` (set at configuration load, unset now)");
    expect(message).toContain("`PLAYWRIGHT_NO_COPY_PROMPT` (set at configuration load, a different value now)");
    expect(message).toContain("[detected at worker start]");
    expect(message).not.toContain("::error::injected");
  });

  it("is silent when nothing changed (the inverse control)", () => {
    const live = job();
    expect(takeEnvironmentChange("x", live, captureEnvironment(live))).toBeUndefined();
    expect(() => assertPageSnapshotSuppressed("x", live, captureEnvironment(live))).not.toThrow();
  });

  it("judges the POLICY on the capture, so a later live change cannot switch it off", () => {
    const captured = captureEnvironment({ CI: "true", PLAYWRIGHT_NO_COPY_PROMPT: "" });
    const live = {} as Record<string, string | undefined>;
    expect(() => assertPageSnapshotSuppressed("x", live, captured)).toThrow(PAGE_SNAPSHOT_NOT_SUPPRESSED);
  });

  // PR #8 closing round, FINDING V-A. The policy used to be keyed on `CI` alone,
  // and GitHub documents that a job CAN overwrite `CI` ("Currently you can
  // overwrite the value of the `CI` variable"), so a pre-load route that emptied
  // `CI` as well as the variable left the policy silent. `GITHUB_ACTIONS` is a
  // default a job cannot overwrite by a DIRECT `env:` or `$GITHUB_ENV` assignment
  // (a `BASH_ENV` or `$GITHUB_PATH` route can still remove it; AGENTS.md).
  it("V-A: applies the policy when GITHUB_ACTIONS was \"true\" at capture, even with CI emptied too", () => {
    const captured = captureEnvironment({ CI: "", PLAYWRIGHT_NO_COPY_PROMPT: "", GITHUB_ACTIONS: "true" });
    expect(pageSnapshotProblem(captured)).toContain(PAGE_SNAPSHOT_NOT_SUPPRESSED);
    expect(() => assertPageSnapshotSuppressed("at worker start", { ...captured }, captured)).toThrow(
      /PLAYWRIGHT_NO_COPY_PROMPT is not "1".*\[checked at worker start\]/s,
    );
  });

  it("V-A: GITHUB_ACTIONS anything but \"true\" does not switch the policy on (the inverse control)", () => {
    expect(pageSnapshotProblem({ GITHUB_ACTIONS: "false", PLAYWRIGHT_NO_COPY_PROMPT: "" })).toBeUndefined();
    expect(pageSnapshotProblem({ GITHUB_ACTIONS: "true", PLAYWRIGHT_NO_COPY_PROMPT: "1" })).toBeUndefined();
  });

  it("V-A: a spec that deletes GITHUB_ACTIONS is a named change, restored like the other two", () => {
    const live: Record<string, string | undefined> = { GITHUB_ACTIONS: "true", PLAYWRIGHT_NO_COPY_PROMPT: "1" };
    const captured = captureEnvironment(live);
    delete live.GITHUB_ACTIONS;
    expect(takeEnvironmentChange("x", live, captured)).toContain("`GITHUB_ACTIONS`");
    expect(live.GITHUB_ACTIONS).toBe("true");
  });

  it("the capture is frozen", () => {
    const captured = captureEnvironment({ CI: "1", PLAYWRIGHT_NO_COPY_PROMPT: "1" });
    expect(Object.isFrozen(captured)).toBe(true);
  });
});
