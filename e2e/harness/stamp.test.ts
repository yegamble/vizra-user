/**
 * The runtime proof-of-harness, tested where it is cheap.
 *
 * WHAT THESE COVER, AND WHAT THEY DO NOT. The property that matters — "a spec
 * that reaches `@playwright/test` directly cannot pass" — is a RUNTIME property
 * and is demonstrated as one, red and green, by `scripts/e2e/demonstrate.sh`
 * (D11) against a real browser and a real production build. These tests cover
 * the parts that can be wrong without any browser at all:
 *
 *   - the signature is over the test's IDENTITY, so a stamp cannot be moved to
 *     another test, another project, another attempt or another file;
 *   - the two implementations of the construction — `e2e/harness/stamp.ts` for
 *     the harness and the in-process reporter, `scripts/ci/stamp-verify.mjs`
 *     for the out-of-process CI step — agree. They are written twice because one
 *     is TypeScript inside Playwright and the other is plain ESM outside it, and
 *     a construction duplicated in two files is a construction that drifts. This
 *     is the pin that makes the duplication safe;
 *   - the three shared constants (annotation type, key file, hex shape) agree
 *     too, for the same reason.
 */

import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  claimSigner,
  runningInWorker,
  specPath,
  STAMP_ANNOTATION,
  STAMP_KEY_ENV,
  STAMP_KEY_FILE,
  verifyStamp,
  type StampIdentity,
} from "./stamp";

// The CI-side implementation, imported as the CI step imports it.
import {
  countedAsSuccess,
  STAMP_ANNOTATION as MJS_ANNOTATION,
  STAMP_KEY_FILE as MJS_KEY_FILE,
  stampFor,
  stampVerifies,
} from "../../scripts/ci/stamp-verify.mjs";

const KEY = randomBytes(32).toString("hex");
const OTHER_KEY = randomBytes(32).toString("hex");

const identity: StampIdentity = {
  project: "desktop-chromium-1440",
  file: "home.spec.ts",
  title: "renders the placeholder",
  workerIndex: 0,
  retry: 0,
};

describe("the two implementations of the stamp agree", () => {
  it("verifies a stamp the CI-side implementation produced", () => {
    expect(verifyStamp(KEY, identity, stampFor(KEY, identity))).toBe(true);
  });

  it("agrees on the annotation type and the key file", () => {
    expect(MJS_ANNOTATION).toBe(STAMP_ANNOTATION);
    expect(MJS_KEY_FILE.split("/").join("")).toBe(STAMP_KEY_FILE.split(/[\\/]/).join(""));
  });

  it("agrees on which results must be stamped", () => {
    // `passed` counts. So does a `failed` result on a `test.fail()`-marked test,
    // because Playwright reports that as expected and the run stays green — an
    // unstamped one of those would be exactly the hole this control exists for.
    expect(countedAsSuccess({ expectedStatus: "passed" }, { status: "passed" })).toBe(true);
    expect(countedAsSuccess({ expectedStatus: "failed" }, { status: "failed" })).toBe(true);
    expect(countedAsSuccess({ expectedStatus: "passed" }, { status: "failed" })).toBe(false);
    expect(countedAsSuccess({ expectedStatus: "passed" }, { status: "skipped" })).toBe(false);
    expect(countedAsSuccess({ expectedStatus: "passed" }, { status: "timedOut" })).toBe(false);
  });
});

describe("a stamp commits to the test's identity", () => {
  const cases: ReadonlyArray<[string, StampIdentity]> = [
    ["a different project", { ...identity, project: "mobile-chromium-390" }],
    ["a different file", { ...identity, file: "health.spec.ts" }],
    ["a different title", { ...identity, title: "renders something else" }],
    ["a different worker", { ...identity, workerIndex: 1 }],
    ["a different attempt", { ...identity, retry: 1 }],
  ];

  it.each(cases)("a stamp for %s does not verify here", (_what, other) => {
    // The point: a spec cannot copy a legitimate stamp off another test, or off
    // its own earlier attempt, and have it accepted.
    expect(verifyStamp(KEY, identity, stampFor(KEY, other))).toBe(false);
    expect(stampVerifies(KEY, identity, stampFor(KEY, other))).toBe(false);
  });

  it("a stamp made with another key does not verify", () => {
    expect(verifyStamp(KEY, identity, stampFor(OTHER_KEY, identity))).toBe(false);
  });

  it("refuses anything that is not a 64-character lowercase hex string", () => {
    const stamp = stampFor(KEY, identity);
    for (const candidate of [
      undefined,
      null,
      123,
      "",
      "not-a-stamp",
      stamp.toUpperCase(),
      stamp.slice(0, 63),
      `${stamp}0`,
      { description: stamp },
    ]) {
      expect(verifyStamp(KEY, identity, candidate), JSON.stringify(candidate)).toBe(false);
      expect(stampVerifies(KEY, identity, candidate), JSON.stringify(candidate)).toBe(false);
    }
  });

  it("refuses a stamp when the key itself is unusable", () => {
    const stamp = stampFor(KEY, identity);
    for (const badKey of ["", "zz", "not hex"]) {
      expect(stampVerifies(badKey, identity, stamp), badKey).toBe(false);
    }
  });
});

describe("the key is a main-process secret", () => {
  it("is not claimed from a worker in this process (vitest is not one)", () => {
    expect(runningInWorker()).toBe(false);
  });

  it("hands out a working signer in the main process", () => {
    // Not one-shot here on purpose: Playwright may load the configuration more
    // than once in the main process, and no test ever runs there. The one-shot
    // behaviour is a WORKER property and is demonstrated at runtime (D11c).
    const first = claimSigner();
    const second = claimSigner();
    expect(first(identity)).toBe(second(identity));
    expect(first(identity)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("names the environment variable the worker deletes", () => {
    // Pinned so that renaming it in stamp.ts without renaming it in
    // scripts/ci/check-e2e-lane.mjs (which refuses a workflow that sets it) is a
    // visible change rather than a silently unguarded name.
    expect(STAMP_KEY_ENV).toBe("VIZRA_E2E_STAMP_KEY");
  });
});

describe("specPath", () => {
  it("is POSIX and relative, so all three sides spell a file the same way", () => {
    expect(specPath("/repo/e2e/specs", "/repo/e2e/specs/home.spec.ts")).toBe("home.spec.ts");
    expect(specPath("/repo/e2e/specs", "/repo/e2e/specs/nested/home.spec.ts")).toBe(
      "nested/home.spec.ts",
    );
  });
});
