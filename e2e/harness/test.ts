/**
 * The `test` every spec must import.
 *
 * It is Playwright's `test` with two extra, non-optional things:
 *
 *   1. the browser-error guard runs for EVERY test, over EVERY context and page
 *      the test creates, so no spec can pass while a page is logging errors,
 *      throwing, or 404-ing its own resources;
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
  DENY_ALL,
  describeContext,
  flushGuardedPages,
  formatFailure,
  guardBrowser,
  unallowedRecords,
  unguardedContexts,
  validatePolicy,
  type BrowserErrorPolicy,
  type BrowserGuard,
} from "./browser-errors";
import {
  armCreationGuard,
  patchBrowserPrototype,
  type CreationViolation,
} from "./creation-guard";
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
   * THE GUARD AND THE STAMP, IN ONE AUTOMATIC FIXTURE.
   *
   * They used to be two: an `auto` fixture that stamped, and a `page` override
   * that guarded. `test.extend` replaces one without the other, and an
   * independent verifier did exactly that — kept the stamp, replaced `page`,
   * and got the whole gate green on a page that 404s and throws. One fixture
   * means "stamped" implies "guarded": removing the guard removes the stamp,
   * which both the in-process reporter and the out-of-process check already
   * refuse.
   *
   * Automatic and not meant to be referenced by a spec.
   * `vizra/no-unguarded-playwright-import` refuses a spec that overrides this
   * name — as the early warning, not as the control.
   */
  vizraHarnessGuard: BrowserGuard;
};

export const test = base.extend<VizraFixtures>({
  // An option fixture, so `test.use({ browserErrorPolicy: ... })` works at file
  // or describe scope and is visible in the diff of the spec that needs it.
  browserErrorPolicy: [DENY_ALL, { option: true }],

  // THE GUARD **AND** THE RUNTIME PROOF, in one `auto: true` fixture that a
  // spec cannot replace without losing the stamp.
  //
  // IT DEPENDS ON `browser`, NOT ON `page`, AND THAT IS THE POINT. Attaching to
  // one page guarded one page: the verifier's exploit overrode the `page`
  // fixture to hand back a page from a context the guard had never seen, kept
  // its stamp, and passed on a page that 404s and throws. Guarding a second page
  // would only move the hole to a popup or a fresh context. So the guard is
  // installed on the BROWSER — at BrowserContext level, which covers every page
  // in every context, including popups and new tabs — for this test's lifetime,
  // and `guardBrowser` restores what it wrapped in teardown. If a spec overrides
  // the `browser` fixture, Playwright hands THAT browser here and it is the one
  // guarded.
  //
  // WHY `context` IS A DECLARED DEPENDENCY, AND WHY NOT `page`. It is there
  // purely for ORDERING, and the ordering was measured rather than assumed:
  //
  //   - depending on `browser` alone, Playwright sets this automatic fixture up
  //     FIRST and therefore tears it down LAST. A probe printed `pages=0` at
  //     that moment: the context was already closed, so the flush had nothing
  //     to flush, late events were lost, and the trace of the failure this
  //     fixture reports had already been written (a demonstration that inspects
  //     that trace went from 21 members to 8).
  //   - depending on `page` fixes the teardown but moves the setup: the guard
  //     is installed after an overridden `page` fixture has already built its
  //     context, so a spec that navigates INSIDE its own fixture and never in
  //     the body escaped. Measured: that spec passed on a broken page.
  //   - depending on `context` gives both. Playwright's `page` fixture does not
  //     close the page — the context does — so at this fixture's teardown the
  //     page is still open (`pages=1`, measured) while the wrapping was
  //     installed before `page` was ever created. The pre-navigation spec above
  //     now fails with all three records.
  //
  // A spec that overrides `page` to build its own context still gets the
  // default context created (this fixture depends on it); that costs one unused
  // context per test and is what makes the wrapper present before the override
  // runs. Any context that already exists is swept as well.
  vizraHarnessGuard: [
    async ({ browser, context, browserErrorPolicy }, runTest, testInfo) => {
      const policyProblems = validatePolicy(browserErrorPolicy);
      if (policyProblems.length > 0) {
        throw new Error(policyProblems.join("\n"));
      }

      const allowedBrowserErrors = browserErrorPolicy.allow;

      // Declared for ordering only (see the note above). The guard never
      // touches this context directly: it watches the browser, and this context
      // is guarded like any other.
      void context;

      const guard = guardBrowser(browser);

      // THE CREATION GUARD (e2e/harness/creation-guard.ts). The wrapping above
      // is on this browser instance's OWN `newContext` / `newPage`, and a
      // verifier measured three import-free routes around it: the prototype's
      // `newContext`, `browser.browserType().launch()` and
      // `launchPersistentContext`. Armed here for exactly this test, it
      // registers a context produced by any route through `Browser.prototype`
      // and REFUSES a browser or persistent context launched during the body.
      // Disarmed in `finally`, so the runner's own worker-browser launch and an
      // overridden `browser` fixture — both resolved before this body runs —
      // are untouched.
      patchBrowserPrototype(browser);
      const violations: CreationViolation[] = [];
      const disarm = armCreationGuard({
        registerContext: guard.registerContext,
        recordViolation: (violation) => violations.push(violation),
      });

      // The stamp is written when the test STARTS, so a test that times out or
      // crashes is still stamped and the two checks stay independent of each
      // other. It cannot be written without this fixture running, and this
      // fixture is where the guard is installed: stamped implies guarded.
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

      try {
        await runTest(guard);

        // The page is still OPEN here — measured, not assumed (`pages=1`).
        // Playwright's `page` fixture does not close the page; the `context`
        // fixture does, and this fixture is torn down before it.
        await flushGuardedPages(guard);

        // Contexts alive on THIS browser that the guard never registered. The
        // creation guard registers everything that goes through
        // `Browser.prototype`, so this is the catch-all for a route nobody has
        // thought of yet — it is read before `dispose()` clears the set.
        const strays = unguardedContexts(browser, guard);

        // Attach everything observed, pass or fail: a passing run's record is
        // what makes "no errors" evidence rather than an absence of looking.
        await testInfo.attach("browser-signals.json", {
          body: JSON.stringify(
            {
              contextsGuarded: guard.contextCount(),
              contextsUnguarded: strays.length,
              creationViolations: violations,
              records: guard.records,
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

        // Reported BEFORE the browser-error records: a test that reached an
        // unguarded browser has no trustworthy record set to report, so
        // "the guard did not see everything" must be the headline, not a
        // footnote under whatever the guarded pages happened to log.
        if (violations.length > 0) {
          throw new Error(
            `${violations.length} attempt(s) to create a browser or context the harness was ` +
              "never handed.\nAGENTS.md: a test that passes must have run under the guard.\n\n" +
              violations.map((violation) => `  ${violation.detail}`).join("\n\n"),
          );
        }
        if (strays.length > 0) {
          throw new Error(
            `${strays.length} context(s) the harness was never handed are open on this browser ` +
              "at the end of the test.\nAGENTS.md: a test that passes must have run under the " +
              "guard, over every context it created.\n\n" +
              strays
                .map((context) => `  an unguarded context, ${describeContext(context)}`)
                .join("\n") +
              "\n\nSee e2e/harness/creation-guard.ts.",
          );
        }

        const unallowed = unallowedRecords(guard.records, allowedBrowserErrors);
        if (unallowed.length > 0) {
          throw new Error(formatFailure(unallowed, allowedBrowserErrors));
        }
      } finally {
        disarm();
        // The browser is worker-scoped and shared by every test in this worker.
        // Leaving a wrapper or a listener behind would make one test's fixture
        // observe the next test's pages, so it is restored however this ends.
        guard.dispose();
      }
    },
    { auto: true },
  ],
});

export { expect };
