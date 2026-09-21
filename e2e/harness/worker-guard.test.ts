/**
 * The worker-scoped harness, asserted without launching a browser.
 *
 * WHAT THESE PIN. The demonstrations (D15) prove the real behaviour against a
 * real broken page and are the evidence that matters; they need Docker, a
 * production build and a browser, so they are not a CI lane. These run in
 * `npm run ci`, and they pin the two properties a reader has to trust:
 *
 *   1. the BRAND — a harness this module did not build is not accepted, which
 *      is what keeps "stamped implies guarded" true now that the listening and
 *      the stamp live in two fixtures;
 *   2. the ACCOUNTING — the record buffer is append-only, so `cursor()` and
 *      `since()` charge every signal to exactly one test and none to two.
 *
 * `createWorkerHarness` itself takes a real `Browser`, so it is exercised by
 * the lane and by D15 rather than here; what is unit-testable is the brand's
 * refusal and the cursor arithmetic the accounting rests on.
 */

import { describe, expect, it } from "vitest";

import {
  guardBrowser,
  formatOrphans,
  formatPhasedFailure,
  type BrowserErrorRecord,
} from "./browser-errors";
import { isGenuineWorkerHarness, REPLACED_WORKER_GUARD } from "./worker-guard";

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

describe("the worker harness brand", () => {
  it("refuses anything this module did not build", () => {
    // The exact shape a spec would hand back from
    // `test.extend({ vizraWorkerGuard: … })`: structurally identical, and not
    // ours. A property or a marker field could be copied; WeakSet membership
    // cannot be, from outside this module.
    const lookAlike = {
      guard: {},
      violations: [],
      claimedRecords: 0,
      claimedViolations: 0,
      dispose() {},
    };
    expect(isGenuineWorkerHarness(lookAlike)).toBe(false);
    expect(isGenuineWorkerHarness(undefined)).toBe(false);
    expect(isGenuineWorkerHarness(null)).toBe(false);
    expect(isGenuineWorkerHarness("vizraWorkerGuard")).toBe(false);
  });

  it("says why, and names the file, when it refuses", () => {
    // The message is what a builder sees; it has to explain the property, not
    // just assert it.
    expect(REPLACED_WORKER_GUARD).toContain("vizraWorkerGuard");
    expect(REPLACED_WORKER_GUARD).toContain("beforeAll");
    expect(REPLACED_WORKER_GUARD).toContain("refuses to stamp itself");
    expect(REPLACED_WORKER_GUARD).toContain("e2e/harness/worker-guard.ts");
  });
});

describe("the accounting cursor", () => {
  type FakeContext = {
    on: (event: string, handler: (payload: unknown) => void) => void;
    off: (event: string, handler: (payload: unknown) => void) => void;
    pages: () => unknown[];
  };
  const fakeContext = (): FakeContext & {
    fire: (event: string, payload: unknown) => void;
  } => {
    const handlers = new Map<string, Array<(payload: unknown) => void>>();
    return {
      on: (event, handler) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      off: () => {},
      pages: () => [],
      fire: (event, payload) => {
        for (const handler of handlers.get(event) ?? []) handler(payload);
      },
    };
  };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const guardOf = (browser: unknown) => guardBrowser(browser as any);
  /* eslint-enable @typescript-eslint/no-explicit-any */

  it("is a monotonic sequence number over an append-only buffer", () => {
    const context = fakeContext();
    const guard = guardOf({ contexts: () => [context] });

    expect(guard.cursor()).toBe(0);
    context.fire("console", {
      type: () => "error",
      text: () => "one",
      location: () => ({ url: "", lineNumber: 0, columnNumber: 0 }),
      page: () => null,
    });
    const afterFirst = guard.cursor();
    expect(afterFirst).toBe(1);

    context.fire("console", {
      type: () => "error",
      text: () => "two",
      location: () => ({ url: "", lineNumber: 0, columnNumber: 0 }),
      page: () => null,
    });

    // The phase split the harness relies on: everything since the previous
    // test's claim, and nothing it already charged.
    expect(guard.since(0)).toHaveLength(2);
    expect(guard.since(afterFirst)).toHaveLength(1);
    expect(guard.since(afterFirst)[0]?.detail).toContain("two");
    expect(guard.since(guard.cursor())).toHaveLength(0);
    // Never truncated: an earlier cursor still resolves.
    expect(guard.records).toHaveLength(2);
    guard.dispose();
  });

  it("clamps a nonsense cursor rather than throwing", () => {
    const guard = guardOf({ contexts: () => [] });
    expect(guard.since(-5)).toHaveLength(0);
    expect(guard.since(999)).toHaveLength(0);
    guard.dispose();
  });
});

describe("formatPhasedFailure", () => {
  it("names the BEFORE phase, which is the sentence four rounds could not say", () => {
    const message = formatPhasedFailure([responseRecord], [], []);
    expect(message).toContain("BEFORE THE TEST BODY");
    expect(message).toContain("beforeAll");
    expect(message).toContain("http 404");
    expect(message).not.toContain("DURING THE TEST");
    // The headline the canary and every D13 half greps for must survive.
    expect(message).toContain("browser error(s) that no allow-list entry covers");
  });

  it("names the DURING phase on its own, and both together", () => {
    expect(formatPhasedFailure([], [consoleRecord], [])).toContain("DURING THE TEST");
    const both = formatPhasedFailure([responseRecord], [consoleRecord], []);
    expect(both).toContain("BEFORE THE TEST BODY");
    expect(both).toContain("DURING THE TEST");
    expect(both).toContain("produced 2 browser error(s)");
  });

  it("prints the allow-list in force, or says there is none", () => {
    expect(formatPhasedFailure([], [consoleRecord], [])).toContain(
      "No allow-list is in force",
    );
    expect(
      formatPhasedFailure([], [consoleRecord], [
        { kind: "console", match: /boom/, reason: "expected by VZ-TEST-001" },
      ]),
    ).toContain("expected by VZ-TEST-001");
  });
});

describe("formatOrphans", () => {
  it("says the signals belong to no test, and that no allow-list can reach them", () => {
    const message = formatOrphans([consoleRecord], []);
    expect(message).toContain("AFTER THE LAST TEST");
    expect(message).toContain("afterAll");
    expect(message).toContain("this worker fails the run instead");
    expect(message).toContain("A per-test allow-list cannot reach here");
    expect(message).toContain("boom in the widget");
  });

  it("counts refused creations as well as browser signals", () => {
    const message = formatOrphans([consoleRecord], [
      { detail: "vizra harness: `chromium.launch` was called during a test" },
    ]);
    expect(message).toContain("2 browser signal(s)");
    expect(message).toContain("chromium.launch");
  });
});
