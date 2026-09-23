/**
 * THE WORKER-SCOPED HARNESS — why the LISTENING is worker-scoped and only the
 * ACCOUNTING is per test.
 *
 * THE HOLE THIS CLOSES. The guard used to be installed by the test-scoped
 * `vizraHarnessGuard` fixture, which Playwright sets up AFTER `beforeAll` has
 * run. An independent verifier walked through that with the idiom Playwright's
 * own documentation teaches for sharing a page:
 *
 *     let shared: Page;
 *     test.beforeAll(async ({ browser }) => {
 *       shared = await browser.newPage();
 *       await shared.goto("/");              // 404s a sub-resource, throws
 *     });
 *     test("…", async () => {
 *       await expect(shared.getByRole("heading", …)).toBeVisible();
 *     });
 *
 * `tsc` exit 0, `eslint` under the shipped config 0 errors, `npx playwright
 * test` **1 passed** — on a page that 404s and throws. The fixture's own
 * attachment read `{ contextsGuarded: 2, contextsUnguarded: 0,
 * creationViolations: [], records: [] }`: every control reported success while
 * the guard had observed nothing, because the page had already done everything
 * it was going to do before the listeners existed. The `beforeAll` context was
 * swept by `guardBrowser`'s existing-contexts loop, so it was neither a stray
 * nor a violation. Nobody writing that spec is evading anything.
 *
 * A documented residual is not a control when the bypass is an idiom honest
 * builders will write. So the listening moved.
 *
 * THE SHAPE. Two fixtures, and which is which matters:
 *
 *   - `vizraWorkerGuard` (WORKER-scoped, automatic, depends on `browser`)
 *     installs the creation guard and the BrowserContext-level listeners for
 *     the WORKER's lifetime, and appends every signal to one append-only
 *     buffer. The buffer is never truncated, so a record's INDEX is a
 *     monotonic sequence number.
 *   - `vizraHarnessGuard` (TEST-scoped, automatic) does the ACCOUNTING. At
 *     setup it takes ownership of everything recorded since the previous test
 *     finished — a `beforeAll` hook, a shared page touched between tests — and
 *     at teardown, after the settle, of everything recorded during the test.
 *     Both are judged under that test's allow-list and fail it by name, saying
 *     which phase produced them.
 *
 * MEASURED AGAINST THE INSTALLED 1.63.0, not assumed. A probe printed the
 * complete order:
 *
 *     worker-auto SETUP
 *       beforeAll
 *       test-auto SETUP → beforeEach → body → afterEach → test-auto TEARDOWN
 *       test-auto SETUP → beforeEach → body → afterEach → test-auto TEARDOWN
 *       afterAll
 *     worker-auto TEARDOWN
 *
 * So the listeners exist before the first `beforeAll`; `beforeEach` and
 * `afterEach` fall INSIDE the per-test window and are charged to that test; and
 * `afterAll` falls after the last test and before worker teardown.
 *
 * THE LATE EDGE, and the decision behind it. Signals produced in `afterAll`, or
 * after the last test in a worker, belong to no test. They are asserted in this
 * module's teardown, which **fails the run**: measured on 1.63.0, a throw from
 * a worker-fixture teardown gives `npx playwright test` **exit 1** with
 * "1 error was not a part of any test", even when every test passed. The
 * alternative — writing them into the per-run record the out-of-process check
 * reads — was considered and not taken: it is a second file format and a second
 * failure path for a case the run's own exit code already covers, and
 * `scripts/ci/check-e2e-lane.mjs` proves the lane runs exactly `npm run e2e`
 * with no exit-code laundering, so a non-zero exit IS a red lane. What that
 * costs is that the out-of-process check does not independently see this one
 * case; `check-e2e-lane.mjs` therefore asserts that `formatOrphans` is CALLED.
 *
 * WHAT THAT ASSERTION IS WORTH, stated accurately because it was overstated
 * here for three rounds. This comment used to end "so deleting it is not
 * silent". THAT WAS FALSE while the assertion was a regex over source with
 * comments crudely stripped: two independent verifiers measured three ways
 * through it with the call deleted — a TRAILING line comment
 * (`void 0; // formatOrphans(a, b)`), a STRING literal
 * (`const s = "formatOrphans(";`) and call-and-discard
 * (`void formatOrphans(a, b);`) each returned the guard to green. The first was
 * driven end to end: `tsc` 0, `check-e2e-lane.sh` 0, the canary 0, and an
 * `afterAll` that breaks a page PASSING. This is the one control the canary
 * cannot exercise and the out-of-process check does not see, so for the late
 * edge it was the only compensating control, and it was weaker than the
 * sentence claimed.
 *
 * The assertion now reads a PARSED TypeScript tree
 * (`scripts/ci/ts-source-facts.mjs`): a comment is not a node and a string
 * literal is not a call, so the first two defeats are gone by construction
 * rather than by a better regex; `void f()` and a SHADOWED callee are refused
 * explicitly; and `scripts/ci/require-checks_test.sh` drives all five shapes
 * red against a throwaway tree, with an unapplied mutation refused as "a
 * demonstration that does not mutate proves nothing".
 *
 * What it STILL cannot decide is whether the call's RESULT is used in a way
 * that matters: `const _ = formatOrphans(…)` and a call in unreachable code
 * both satisfy it. That needs a type checker and a reachability analysis, and
 * the general case is REVIEW-ONLY. See `AGENTS.md` § Residuals.
 *
 * STAMPED STILL IMPLIES GUARDED. Moving the listening into a second fixture
 * would otherwise have re-opened FINDING 11 one level up: a spec could
 * `test.extend({ vizraWorkerGuard: … })` with a no-op, keep the test-scoped
 * fixture and its stamp, and lose the guard. So a harness built here is BRANDED
 * — recorded in a module-private `WeakSet` that nothing outside this file can
 * add to — and `vizraHarnessGuard` throws BEFORE it stamps if what it was
 * handed is not branded. Replacing the worker fixture therefore costs the
 * stamp, which both floor checks refuse. The ESLint rule lists the name too, as
 * the early warning.
 */

import type { Browser, BrowserContext } from "@playwright/test";

import { guardBrowser, type BrowserGuard } from "./browser-errors";
import {
  armCreationGuard,
  patchBrowserPrototype,
  type CreationViolation,
} from "./creation-guard";

/**
 * Everything one worker's guard holds. The two `claimed*` cursors are the
 * accounting state: they say how much of each append-only buffer has already
 * been charged to a test, and they are advanced by `vizraHarnessGuard` in a
 * `finally`, so a test that times out or throws still hands the next test a
 * correct starting point.
 */
export type WorkerHarness = {
  readonly guard: BrowserGuard;
  /**
   * Refused attempts to create a browser, a persistent context or a raw CDP
   * session. A SEPARATE buffer from `guard.records`, deliberately: a violation
   * must never be judged against the per-test allow-list. "I expected this
   * 404" is a reasonable thing for a test to declare; "I expected to be able to
   * launch an unguarded browser" is not.
   */
  readonly violations: CreationViolation[];
  claimedRecords: number;
  claimedViolations: number;
  dispose(): void;
};

/**
 * The brand. A `WeakSet` and not a property, so it cannot be copied onto a
 * look-alike object by a spec: membership is only grantable by the one call
 * below, in this module, which no file outside `e2e/harness/**` can reach.
 */
const genuine = new WeakSet<object>();

/** Install the listeners and the creation guard for this worker's lifetime. */
export function createWorkerHarness(browser: Browser): WorkerHarness {
  // Before `guardBrowser`, so that a context created through the prototype at
  // any point in this worker — including inside `beforeAll` — is registered.
  patchBrowserPrototype(browser);

  const guard = guardBrowser(browser);
  const violations: CreationViolation[] = [];

  // Armed for the WORKER, not for one test. A browser launched in `beforeAll`
  // is exactly as unguarded as one launched in the body, so it is refused in
  // both. Playwright's own `browser` worker fixture is resolved BEFORE this one
  // (it is a declared dependency), so the runner's own launch — and an
  // overridden `browser` fixture's launch — happen while the guard is still
  // unarmed and are untouched. Demonstration D13g pins that.
  const disarm = armCreationGuard({
    registerContext: (context: BrowserContext) => guard.registerContext(context),
    recordViolation: (violation) => violations.push(violation),
  });

  const harness: WorkerHarness = {
    guard,
    violations,
    claimedRecords: 0,
    claimedViolations: 0,
    dispose: () => {
      disarm();
      guard.dispose();
    },
  };

  genuine.add(harness);
  return harness;
}

/** Was this object built by `createWorkerHarness`, in this module? */
export function isGenuineWorkerHarness(
  candidate: unknown,
): candidate is WorkerHarness {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    genuine.has(candidate as object)
  );
}

/**
 * The message a test fails with when it was handed something the harness did
 * not build. Exported so the harness tests can pin it.
 */
export const REPLACED_WORKER_GUARD =
  "vizra harness: the worker-scoped guard `vizraWorkerGuard` was replaced. That fixture is " +
  "where the browser-error listeners and the creation guard are installed, for the whole " +
  "worker — which is what covers a page opened in `beforeAll`, before any per-test fixture " +
  "exists. Replacing it would keep the runtime stamp and lose the guard, so this test refuses " +
  "to stamp itself and fails instead. See e2e/harness/worker-guard.ts.";
