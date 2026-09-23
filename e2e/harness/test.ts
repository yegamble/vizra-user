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
  formatOrphans,
  formatPhasedFailure,
  unallowedRecords,
  unguardedContexts,
  validatePolicy,
  type BrowserErrorPolicy,
  type BrowserGuard,
} from "./browser-errors";
import { assertEnvironmentUnchanged, assertPageSnapshotSuppressed, takeEnvironmentChange } from "./ci-environment";
import { recorderMessage, recorderProblems } from "./recorders";
import { claimSigner, specPath, STAMP_ANNOTATION } from "./stamp";
import {
  createWorkerHarness,
  isGenuineWorkerHarness,
  REPLACED_WORKER_GUARD,
  type WorkerHarness,
} from "./worker-guard";

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
   * THE ACCOUNTING, per test — and the stamp.
   *
   * It used to be the LISTENING too, and that was the hole. A page opened and
   * navigated in `test.beforeAll` — the idiom Playwright's own documentation
   * teaches for sharing a page — did everything it was going to do before this
   * fixture existed, so the guard observed nothing and the test passed on a
   * page that 404s and throws. The listening moved to `vizraWorkerGuard`, which
   * Playwright sets up before the first `beforeAll` (measured, see
   * `e2e/harness/worker-guard.ts`); what is left here is charging each recorded
   * signal to exactly one test, and stamping.
   *
   * Automatic and not meant to be referenced by a spec.
   * `vizra/no-unguarded-playwright-import` refuses a spec that overrides this
   * name — as the early warning, not as the control.
   */
  vizraHarnessGuard: BrowserGuard;
};

export type VizraWorkerFixtures = {
  /**
   * THE LISTENING, for the whole worker. Automatic, worker-scoped, and set up
   * BEFORE any `beforeAll` hook runs — which is the entire point. See
   * `e2e/harness/worker-guard.ts` for the measured ordering, for why the
   * accounting stayed per test, and for how replacing this fixture costs the
   * stamp rather than silently costing the guard.
   */
  vizraWorkerGuard: WorkerHarness;
};

export const test = base.extend<VizraFixtures, VizraWorkerFixtures>({
  // An option fixture, so `test.use({ browserErrorPolicy: ... })` works at file
  // or describe scope and is visible in the diff of the spec that needs it.
  browserErrorPolicy: [DENY_ALL, { option: true }],

  // ---------------------------------------------------------------------
  // THE LISTENING — worker-scoped, automatic.
  // ---------------------------------------------------------------------
  //
  // IT DEPENDS ON `browser`, NOT ON `page`, AND THAT IS THE POINT. Attaching to
  // one page guarded one page: a verifier's exploit overrode the `page` fixture
  // to hand back a page from a context the guard had never seen, kept its
  // stamp, and passed on a page that 404s and throws. Guarding a second page
  // would only move the hole to a popup or a fresh context. So the guard is
  // installed on the BROWSER — at BrowserContext level, which covers every page
  // in every context, including popups and new tabs.
  //
  // AND IT IS WORKER-SCOPED, because a test-scoped fixture is set up after
  // `beforeAll` has already run. Depending on `browser` (worker-scoped) means
  // Playwright resolves the runner's own browser first, so the browser launch
  // this guard refuses during a test is untouched at worker setup — which is
  // what keeps an overridden `browser` fixture legal (D13g).
  vizraWorkerGuard: [
    // The callback parameter is `provide`, not `use`: `react-hooks/rules-of-hooks`
    // reads a call to `use(...)` inside a try/catch as a misplaced React hook,
    // and the try/catch is load-bearing here.
    async ({ browser, screenshot, video, trace }, provide) => {
      // LANE A RECORDS NO PIXELS, checked on the RESOLVED values before the
      // worker's first hook or test (e2e/harness/recorders.ts). A source reader
      // was green while six spellings turned the recorders back on; this is
      // checked where Playwright has already resolved every one of them. It
      // lives in this BRANDED fixture on purpose: replacing the fixture to drop
      // the check costs the stamp.
      const pixelOptions = recorderProblems({ screenshot, video, trace });
      if (pixelOptions.length > 0) {
        throw new Error(recorderMessage(pixelOptions, "in this worker"));
      }
      // BEFORE ANYTHING ELSE IN THE WORKER: the page-snapshot variables, in the
      // process that takes the snapshot. Two checks. The values CAPTURED when the
      // configuration loaded must satisfy the policy — a worker whose environment
      // was rewritten on the way here (`.npmrc` `node-options`, `NODE_OPTIONS`,
      // `$GITHUB_ENV`) fails. And the LIVE values must still equal that capture —
      // a spec's module scope runs when the worker loads the spec file, after
      // the capture and before this line; a change is restored and fails here,
      // before any `beforeAll` or test opens a page, so there is nothing to
      // snapshot (R3-FINDING J). See ./ci-environment.ts.
      assertPageSnapshotSuppressed("at worker start, before any hook or test");
      const harness = createWorkerHarness(browser);
      try {
        await provide(harness);

        // THE LATE EDGE FOR HOOKS. Anything recorded after the last test's
        // accounting belongs to no test: `afterAll`, or a page still doing
        // something after the final test finished. Measured on 1.63.0: a throw
        // here gives `npx playwright test` exit 1 with "1 error was not a part
        // of any test", even when every test passed — so a broken page visited
        // only in `afterAll` cannot leave the lane green.
        const orphanRecords = harness.guard.since(harness.claimedRecords);
        const orphanViolations = harness.violations.slice(
          harness.claimedViolations,
        );
        // AND THE LATE EDGE FOR THE ENVIRONMENT: `afterAll`, or the teardown of
        // a fixture the harness fixture depends on (an overridden `context`),
        // which runs after the last per-test check. Restored and red by name;
        // this one DETECTS rather than prevents, because the context may already
        // have closed (see ./ci-environment.ts).
        const environmentChange = takeEnvironmentChange(
          "at worker teardown, after the last test",
        );
        try {
          if (orphanRecords.length > 0 || orphanViolations.length > 0) {
            throw new Error(formatOrphans(orphanRecords, orphanViolations));
          }
        } catch (error) {
          // Both at once: the environment change is named FIRST, not lost.
          if (environmentChange !== undefined && error instanceof Error) {
            error.message = `${environmentChange}\n\n${error.message}`;
          }
          throw error;
        }
        if (environmentChange !== undefined) throw new Error(environmentChange);
      } finally {
        // The browser is shared by every test in this worker and outlives the
        // guard, so the wrapping and the listeners are restored however this
        // ends.
        harness.dispose();
      }
    },
    { scope: "worker", auto: true },
  ],

  // ---------------------------------------------------------------------
  // THE ACCOUNTING **AND** THE RUNTIME PROOF — test-scoped, automatic.
  // ---------------------------------------------------------------------
  //
  // WHY `context` IS A DECLARED DEPENDENCY, AND WHY NOT `page`. It is there
  // purely for ORDERING, and the ordering was measured rather than assumed:
  //
  //   - with neither, this fixture is set up first and torn down LAST. A probe
  //     printed `pages=0` at that moment: the context was already closed, so
  //     the flush had nothing to flush, late events were lost, and the trace of
  //     the failure this fixture reports had already been written (a
  //     demonstration that inspects that trace went from 21 members to 8).
  //   - depending on `page` fixes the teardown but moves the setup later still.
  //   - depending on `context` gives both. Playwright's `page` fixture does not
  //     close the page — the context does — so at this fixture's teardown the
  //     page is still open (`pages=1`, measured).
  //
  // A spec that overrides `page` to build its own context still gets the
  // default context created (this fixture depends on it). Any context that
  // already exists is guarded by the worker fixture, which ran first.
  vizraHarnessGuard: [
    async (
      { browser, context, browserErrorPolicy, vizraWorkerGuard, screenshot, video, trace },
      runTest,
      testInfo,
    ) => {
      // The same no-pixels check, per test, before the body: the second of the
      // two fixtures the harness owns, so dropping one does not drop the check.
      const pixelOptions = recorderProblems({ screenshot, video, trace });
      if (pixelOptions.length > 0) {
        throw new Error(recorderMessage(pixelOptions, "for this test"));
      }
      // STAMPED IMPLIES GUARDED, one level up. Moving the listening into a
      // second fixture would otherwise let a spec `test.extend` the WORKER
      // fixture with a no-op, keep this one and its stamp, and lose the guard —
      // exactly the shape that made FINDING 11 blocking. A harness built by
      // `createWorkerHarness` is branded in a module-private WeakSet that
      // nothing outside `worker-guard.ts` can add to, and this check runs
      // BEFORE the stamp is written, so a replaced worker fixture costs the
      // stamp and both floor checks refuse the run.
      if (!isGenuineWorkerHarness(vizraWorkerGuard)) {
        throw new Error(REPLACED_WORKER_GUARD);
      }
      const worker = vizraWorkerGuard;
      const guard = worker.guard;

      // A change since the last check — in `beforeAll`, or late in the previous
      // test — is restored before this test opens anything, and fails it by name.
      assertEnvironmentUnchanged("before this test, since the previous check");

      const policyProblems = validatePolicy(browserErrorPolicy);
      if (policyProblems.length > 0) {
        throw new Error(policyProblems.join("\n"));
      }

      const allowedBrowserErrors = browserErrorPolicy.allow;

      // Declared for ordering only (see the note above). The guard never
      // touches this context directly: it watches the browser, and this context
      // is guarded like any other.
      void context;

      // PHASE 1 — everything recorded since the previous test finished. That is
      // a `beforeAll` hook, or a shared page that did something between two
      // tests. Before the listening was worker-scoped this window did not exist
      // and its contents were invisible.
      const beforeBodyRecords = guard.since(worker.claimedRecords);
      const beforeBodyViolations = worker.violations.slice(
        worker.claimedViolations,
      );
      const bodyStartRecord = guard.cursor();
      const bodyStartViolation = worker.violations.length;

      // The stamp is written when the test STARTS, so a test that times out or
      // crashes is still stamped and the two checks stay independent of each
      // other.
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

      let failure: unknown;
      try {
        await runTest(guard);

        // AND AGAIN AFTER THE BODY, before this test's context is closed —
        // Playwright's recorder reads the variable during that close. A spec
        // that rewrote `process.env` in its body, `beforeEach` or `afterEach`
        // (or a `test.extend` fixture torn down before this one) is RESTORED
        // here and fails by name, so the close that follows reads the captured
        // value and writes no snapshot.
        assertPageSnapshotSuppressed("after the test body, before its context closes");

        // The page is still OPEN here — measured, not assumed (`pages=1`).
        // The settle lives in here too; see `flushGuardedPages`.
        await flushGuardedPages(guard);

        // PHASE 2 — everything recorded during this test: the body itself, and
        // `beforeEach`/`afterEach`, which the measured ordering puts inside
        // this window.
        const duringBodyRecords = guard.since(bodyStartRecord);
        const duringBodyViolations = worker.violations.slice(bodyStartViolation);

        // Contexts alive on THIS browser that the guard never registered. The
        // creation guard registers everything that goes through
        // `Browser.prototype`, so this is the catch-all for a route nobody has
        // thought of yet.
        const strays = unguardedContexts(browser, guard);

        // Attach everything observed, pass or fail: a passing run's record is
        // what makes "no errors" evidence rather than an absence of looking.
        await testInfo.attach("browser-signals.json", {
          body: JSON.stringify(
            {
              contextsGuarded: guard.contextCount(),
              contextsUnguarded: strays.length,
              creationViolations: [
                ...beforeBodyViolations,
                ...duringBodyViolations,
              ],
              recordsBeforeTestBody: beforeBodyRecords,
              recordsDuringTestBody: duringBodyRecords,
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
        const violations = [...beforeBodyViolations, ...duringBodyViolations];
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
                .map((stray) => `  an unguarded context, ${describeContext(stray)}`)
                .join("\n") +
              "\n\nSee e2e/harness/creation-guard.ts.",
          );
        }

        // Both phases are judged under the SAME per-test allow-list, and the
        // failure says which phase produced each signal — "before the test
        // body" is the sentence that would have saved four verification rounds.
        const unallowedBefore = unallowedRecords(
          beforeBodyRecords,
          allowedBrowserErrors,
        );
        const unallowedDuring = unallowedRecords(
          duringBodyRecords,
          allowedBrowserErrors,
        );
        if (unallowedBefore.length > 0 || unallowedDuring.length > 0) {
          throw new Error(
            formatPhasedFailure(
              unallowedBefore,
              unallowedDuring,
              allowedBrowserErrors,
            ),
          );
        }
      } catch (error) {
        failure = error;
      } finally {
        // Charge everything up to here to this test, so the next test starts
        // from a correct cursor even if this one timed out or threw. The
        // buffers themselves are never truncated — the index IS the sequence
        // number.
        worker.claimedRecords = guard.cursor();
        worker.claimedViolations = worker.violations.length;
      }

      // LAST, before this fixture hands back and the context closes: a change
      // made while the guard flushed the page (a page event handler) is
      // restored, and named — ahead of whatever else this test failed on,
      // rather than instead of it.
      const lateChange = takeEnvironmentChange(
        "at the end of the test, before its context closes",
      );
      if (lateChange !== undefined) {
        const also =
          failure === undefined
            ? ""
            : `\n\n${failure instanceof Error ? failure.message : String(failure)}`;
        throw new Error(`${lateChange}${also}`);
      }
      if (failure !== undefined) throw failure;
    },
    { auto: true },
  ],
});

export { expect };
