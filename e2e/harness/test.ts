/**
 * The `test` every spec must import.
 *
 * It is Playwright's `test` with two extra, non-optional things:
 *
 *   1. the browser-error guard runs in fixture teardown for EVERY test, so no
 *      spec can pass while the page is logging errors, throwing, or 404-ing its
 *      own resources;
 *   2. an automatic fixture STAMPS every test this `test` runs, and
 *      `e2e/harness/stamp-reporter.ts` (inside the run) and
 *      `scripts/ci/check-coverage-floor-ran.mjs` (from outside it, against the
 *      finished JSON report) both refuse a run in which a test SUCCEEDED
 *      without a valid stamp, naming the file.
 *
 * (2) is what makes (1) structural rather than advisory. Three verification
 * rounds each found a different way for a spec to reach the raw
 * `@playwright/test` runner and go green on a page that 404s and throws — a
 * namespace import, an `eslint-disable` comment, a spec in a directory no lint
 * glob covered. Every fix until now was a lint fix, and lint inspects source
 * rather than what runs. The stamp is written by the fixture, with a key a spec
 * cannot read; see `e2e/harness/stamp.ts` for where the key lives and for an
 * honest account of what forging one would take. `vizra/no-unguarded-playwright-import`
 * is still enforced — as the EARLY WARNING that fails in seconds in `npm run ci`,
 * not as the guarantee.
 *
 * The stamp is written when the test STARTS, not when it ends: a test that
 * times out, crashes the worker or fails in teardown is still stamped, so the
 * two checks stay independent of each other and the lane cannot be made flaky by
 * the control itself.
 *
 * ACCESSIBILITY SEAM (not filled here, deliberately). VZ-A11Y-001 is M1. When
 * it lands, the axe run belongs in exactly this file as a second teardown
 * assertion beside the error guard — same default-deny shape, same per-test
 * allow-list with a written reason — so that every existing spec gains it at
 * once. No accessibility engine is installed in this PR and none is claimed.
 *
 * VISUAL BASELINES are deliberately absent too: `toHaveScreenshot` is not used
 * anywhere, because approving a baseline is a reviewed act of its own and this
 * PR must not smuggle one in.
 */

import { test as base, expect } from "@playwright/test";

import {
  collectBrowserErrors,
  DENY_ALL,
  flushBrowserEvents,
  formatFailure,
  unallowedRecords,
  validatePolicy,
  type BrowserErrorPolicy,
} from "./browser-errors";
import { claimSigner, specPath, STAMP_ANNOTATION } from "./stamp";

/**
 * Claimed at MODULE LOAD, which in a worker happens while `playwright.config.ts`
 * is being loaded — before any test file is evaluated, because
 * `WorkerMain.runTestGroup` calls `_loadIfNeeded()` before `loadTestFile`. The
 * claim is one-shot per worker, so a spec that later imports `./stamp` and calls
 * `claimSigner()` itself gets a throw rather than a signer. The signer is never
 * exported from this module.
 */
const signStamp = claimSigner();

export type VizraFixtures = {
  /**
   * Signals this test expects the page to produce. Default: none — every
   * console error, page error, failed request and HTTP >= 400 response fails.
   * Set it with `test.use({ browserErrorPolicy: { allow: [...] } })`; each
   * entry needs a `kind`, a RegExp `match` and a non-blank `reason`.
   */
  browserErrorPolicy: BrowserErrorPolicy;

  /**
   * The runtime proof that this test went through this module. Automatic and
   * not meant to be referenced by a spec; it exists so that a test the harness
   * did NOT run is distinguishable from one it did, at runtime rather than by
   * reading the spec's import line.
   */
  vizraHarnessStamp: void;
};

export const test = base.extend<VizraFixtures>({
  // An option fixture, so `test.use({ browserErrorPolicy: ... })` works at file
  // or describe scope and is visible in the diff of the spec that needs it.
  browserErrorPolicy: [DENY_ALL, { option: true }],

  // THE RUNTIME PROOF. `auto: true`, so it runs for every test this `test`
  // starts — including a test that never touches `page`. The annotation is an
  // HMAC over the test's own identity under a per-run key a spec cannot read
  // (e2e/harness/stamp.ts); `@playwright/test`'s own `test` produces nothing of
  // the kind, so a spec that bypasses this module is RED at runtime in both the
  // in-process reporter and the out-of-process report check, by name.
  vizraHarnessStamp: [
    async ({}, runTest, testInfo) => {
      testInfo.annotations.push({
        type: STAMP_ANNOTATION,
        description: signStamp({
          project: testInfo.project.name,
          file: specPath(testInfo.config.rootDir, testInfo.file),
          title: testInfo.title,
          workerIndex: testInfo.workerIndex,
          retry: testInfo.retry,
        }),
      });
      await runTest();
    },
    { auto: true },
  ],

  // Override `page` so the guard is armed before the test body can navigate,
  // and asserted after the test body has finished — including when the body
  // never looked at the console at all.
  page: async ({ page, browserErrorPolicy }, runTest, testInfo) => {
    const policyProblems = validatePolicy(browserErrorPolicy);
    if (policyProblems.length > 0) {
      throw new Error(policyProblems.join("\n"));
    }
    const allowedBrowserErrors = browserErrorPolicy.allow;

    const records = collectBrowserErrors(page);

    await runTest(page);

    await flushBrowserEvents(page);

    // Attach everything observed, pass or fail: a passing run's record is what
    // makes "no errors" evidence rather than an absence of looking.
    await testInfo.attach("browser-signals.json", {
      body: JSON.stringify(
        {
          records,
          allowed: allowedBrowserErrors.map((entry) => ({
            kind: entry.kind,
            match: String(entry.match),
            reason: entry.reason,
          })),
        },
        null,
        2,
      ),
      contentType: "application/json",
    });

    const unallowed = unallowedRecords(records, allowedBrowserErrors);
    if (unallowed.length > 0) {
      throw new Error(formatFailure(unallowed, allowedBrowserErrors));
    }
  },
});

export { expect };
