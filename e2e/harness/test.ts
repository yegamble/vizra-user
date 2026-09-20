/**
 * The `test` every spec must import.
 *
 * It is Playwright's `test` with one extra, non-optional thing: the
 * browser-error guard runs in fixture teardown for EVERY test, so no spec can
 * pass while the page is logging errors, throwing, or 404-ing its own
 * resources. Importing `@playwright/test`'s `test` directly in a spec would
 * bypass the guard, so `e2e/harness/no-bare-playwright-import.test.ts` asserts
 * that no spec does (it is a vitest test, run by `npm run test`, so the
 * violation is caught by the cheap lane rather than only by the expensive one).
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

export type VizraFixtures = {
  /**
   * Signals this test expects the page to produce. Default: none — every
   * console error, page error, failed request and HTTP >= 400 response fails.
   * Set it with `test.use({ browserErrorPolicy: { allow: [...] } })`; each
   * entry needs a `kind`, a RegExp `match` and a non-blank `reason`.
   */
  browserErrorPolicy: BrowserErrorPolicy;
};

export const test = base.extend<VizraFixtures>({
  // An option fixture, so `test.use({ browserErrorPolicy: ... })` works at file
  // or describe scope and is visible in the diff of the spec that needs it.
  browserErrorPolicy: [DENY_ALL, { option: true }],

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
