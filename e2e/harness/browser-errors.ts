/**
 * The browser-error guard.
 *
 * WHY THIS EXISTS. The meta `AGENTS.md` ("Required workflow", step 4) requires
 * that a UI change be exercised in the running production-mode UI with
 * network/console errors inspected. A harness that merely asserts some text is
 * on the page passes while the page is quietly throwing, 404-ing its own
 * assets, or hydrating into a broken tree — and every later slice would inherit
 * that false green. So the harness treats four browser-observable signals as
 * FAILURES by default, for every test, whether or not the test looked:
 *
 *   1. `console` messages of type `error`            (page logged an error)
 *   2. `pageerror`                                   (uncaught exception / rejection)
 *   3. `requestfailed`                               (request never completed)
 *   4. any response with HTTP status >= 400          (including sub-resources)
 *
 * DEFAULT-DENY, WITH A WRITTEN REASON AS THE ONLY EXIT. A test may allow a
 * signal only by declaring it, with a `reason` string that is not empty. The
 * allow-list is per test (or per describe block) via `test.use`, so it can
 * never be widened globally by accident:
 *
 *     test.describe("...", () => {
 *       test.use({
 *         browserErrorPolicy: {
 *           allow: [
 *             { kind: "response", match: /\/favicon\.ico$/, reason: "no icon yet (VZ-...)" },
 *           ],
 *         },
 *       });
 *       ...
 *     });
 *
 * An entry with a blank reason is itself an error: "allow-listed with a written
 * reason" has to mean the reason exists, or the mechanism is decoration.
 *
 * WHY THE POLICY IS AN OBJECT AND NOT A BARE ARRAY. Measured on 2026-09-20
 * against Playwright 1.63.0: a `test.use` value that is an array of EXACTLY TWO
 * objects is parsed by Playwright as a `[value, options]` fixture tuple, so a
 * two-entry allow-list silently arrives as its first entry alone. It happened
 * to fail closed here, but a safety control whose second entry can vanish
 * without a word is not a control. `{ allow: [...] }` cannot be mistaken for a
 * tuple, and `validatePolicy` below rejects anything that is not that shape
 * rather than coercing it. `e2e/harness/browser-errors.test.ts` pins that
 * behaviour in vitest, so it is checked by the cheap lane too.
 *
 * WHEN IT LISTENS AND WHEN IT ASSERTS — two different times, and conflating
 * them was a blocking finding of its own. The listeners are installed by a
 * WORKER-scoped fixture, before the first `beforeAll` runs, so nothing is
 * missed for being early. The ASSERTION is in the per-test fixture's teardown,
 * after the test body, so a test cannot pass by simply not looking; each signal
 * is charged to exactly one test by the cursor arithmetic in `worker-guard.ts`,
 * and the failure names the phase. Before asserting, the guard settles (see
 * `SETTLE_MS`) and makes one round trip into each page (`page.evaluate`) to
 * flush events the browser has emitted but the driver has not yet delivered —
 * without it an error raised by the last action of a test could arrive after
 * the assertion and be lost.
 */

import type {
  Browser,
  BrowserContext,
  ConsoleMessage,
  Page,
  Request,
  Response,
  WebError,
} from "@playwright/test";

import { redactExternalText, redactUrl } from "./redact";

/** The four signal kinds the guard watches. */
export type BrowserErrorKind =
  | "console"
  | "pageerror"
  | "requestfailed"
  | "response";

/** One recorded signal. `where` is the URL or the page URL at the time. */
export type BrowserErrorRecord = {
  readonly kind: BrowserErrorKind;
  /** Human-readable one-liner used for matching and for the failure message. */
  readonly detail: string;
  readonly where: string;
};

/**
 * One allow-list entry. Every field is required on purpose.
 *
 * - `kind` narrows to a single signal type, so allowing a 404 cannot also
 *   silence an uncaught exception.
 * - `match` is tested against `detail`.
 * - `reason` must be non-blank: this is the "written reason" the contract asks
 *   for, and a blank one fails the test rather than passing silently.
 */
export type AllowedBrowserError = {
  readonly kind: BrowserErrorKind;
  readonly match: RegExp;
  readonly reason: string;
};

// Every URL below goes through `redact.ts` first — origin and path are kept,
// query strings and fragments are not. See that module for why a test harness
// is where a signed URL leaks into a log.
//
// And every string the PAGE controls goes through `redactExternalText`, which
// redacts URLs and then makes what is left inert. A console message is text the
// page chose; it is copied into a failure message, printed by the `list`
// reporter, and lands in the GitHub Actions log, where a line beginning `::` is
// a workflow command. From M1 that text is also product content, and from
// federation it is a remote instance's display name or error string. See
// FINDING 13 of the artifact-privacy plan review.
function describeConsole(message: ConsoleMessage): string {
  const location = message.location();
  const at = location.url
    ? ` (${redactUrl(location.url)}:${location.lineNumber}:${location.columnNumber})`
    : "";
  return `console.error: ${redactExternalText(message.text())}${at}`;
}

function describeRequestFailed(request: Request): string {
  const failure = request.failure();
  return `requestfailed: ${request.method()} ${redactUrl(request.url())} — ${failure?.errorText ?? "unknown error"}`;
}

function describeResponse(response: Response): string {
  return `http ${response.status()}: ${response.request().method()} ${redactUrl(response.url())}`;
}

/** Best-effort page URL for a record's `where`; never throws. */
function pageUrl(page: Page | null | undefined): string {
  try {
    return page ? redactUrl(page.url()) : "";
  } catch {
    return "";
  }
}

/**
 * THE GUARD, ATTACHED AT THE BROWSER — not at one page.
 *
 * WHY NOT `page.on(...)`. It used to be exactly that, inside an override of the
 * `page` fixture, and an independent verifier walked straight through it with
 * four lines of ordinary Playwright:
 *
 *     const test = base.extend({
 *       page: async ({ browser }, provide) => {
 *         const ctx = await browser.newContext();
 *         await provide(await ctx.newPage());
 *       },
 *     });
 *
 * `test.extend` replaces one fixture without the other, so the spec kept its
 * harness stamp — the stamp fixture was separate and still ran — while the
 * guard was simply gone. `npm run ci` exit 0, the lane exit 0 with "20 passed,
 * coverage floor: OK, harness stamp: OK (20 verified)", both floor checks exit
 * 0, the canary exit 0, the workflow parser exit 0, on a page that 404s a
 * sub-resource and throws on every load. The stamp proved "this test came from
 * the harness `test` object"; the ledger claims "this test ran the guard".
 *
 * Tying the guard to a second page would only move the hole: the next one is a
 * popup, a new tab, or `browser.newContext()` in the test body. So the guard is
 * attached to the BROWSER for the WORKER's lifetime, at BrowserContext level.
 * Worker-scoped, because a test-scoped attachment starts only AFTER `beforeAll`
 * has run, and a page opened and navigated in a hook was therefore never
 * observed at all — a blocking finding of its own; see
 * `e2e/harness/worker-guard.ts` for the measured ordering and the accounting
 * that charges each signal to exactly one test.
 * `console`, `weberror`, `requestfailed` and `response` all exist on
 * `BrowserContext` in the installed Playwright 1.63.0 types
 * (`playwright-core/types/types.d.ts`, checked, not assumed), and a context
 * event fires for EVERY page in that context, popups and new tabs included.
 *
 * Coverage, therefore:
 *
 *   - the default `context`/`page` fixtures;
 *   - a spec that overrides `page` or `context` (their context already exists
 *     when this runs, and is swept);
 *   - `browser.newContext()` and `browser.newPage()` called during the test
 *     (both are wrapped for the worker's lifetime and restored afterwards);
 *   - a page opened and navigated in `beforeAll`/`beforeEach`, or shared with an
 *     earlier test: recorded, and charged to a test by phase;
 *   - `context.newPage()`, and popups/new tabs the page opens itself (a context
 *     listener covers every page in the context);
 *   - a spec that overrides the `browser` fixture — the harness fixture takes
 *     `browser` as a dependency, so it guards whichever browser the spec built.
 *
 * THE WRAPPING BELOW IS ON THE BROWSER INSTANCE'S OWN PROPERTIES, and that is
 * no longer the whole story. An independent verifier measured three routes that
 * produce a context without going through them, each from a spec importing only
 * the harness `test`, each passing the complete gate on a page that 404s and
 * throws:
 *
 *     Object.getPrototypeOf(browser).newContext.call(browser)
 *     browser.browserType().launch()
 *     playwright.chromium.launchPersistentContext(dir)
 *
 * (`Object.getPrototypeOf(browser).newPage.call(browser)` was already caught,
 * because the prototype's `newPage` calls `this.newContext` — the wrapper.)
 * `e2e/harness/creation-guard.ts` closes all three at runtime: the prototype
 * route is REGISTERED with the guard below (so a context created and closed
 * inside the body still has its signals recorded), and a launch or a persistent
 * context during the test is REFUSED. `unguardedContexts` here is the third
 * layer — a teardown assertion that no live context on the harness's browser is
 * one the guard never registered, which catches a creation path nobody has
 * thought of yet. Read `creation-guard.ts` for what is still open.
 *
 * The own-property wrapping is kept even though the prototype patch now covers
 * the same calls: it is the layer that holds if the prototype patch is ever
 * removed, and the D13 demonstrations pin both.
 *
 * ALSO NOT COVERED, by design: Playwright's `request` fixture. The kinds below
 * are BROWSER signals; an `APIRequestContext` 404 is not one and does not fail
 * a test. And the flush window is finite — see `SETTLE_MS` below for how wide
 * it is and what it costs.
 */
export type BrowserGuard = {
  /**
   * Everything observed, in order, across every guarded context, for the
   * lifetime of the guard — which is the WORKER's lifetime, not one test's.
   *
   * APPEND-ONLY, NEVER TRUNCATED, so the INDEX of a record is a monotonic
   * sequence number and `since()` is exact rather than best-effort. That is
   * what lets `vizraHarnessGuard` charge each signal to exactly one test: the
   * records before its setup cursor came from a hook or a shared page, the
   * ones after came from the test body, and the ones left at the end of the
   * worker came from `afterAll` and belong to no test at all.
   */
  readonly records: BrowserErrorRecord[];
  /** The next sequence number — i.e. how many records exist so far. */
  cursor(): number;
  /** Every record appended at or after `cursor`. */
  since(cursor: number): BrowserErrorRecord[];
  /** Every page currently open in a guarded context (for the flush). */
  pages(): Page[];
  /** How many contexts the guard is watching — asserted by the harness tests. */
  contextCount(): number;
  /**
   * Start watching a context. Idempotent, and the entry point the creation
   * guard uses for a context produced by a route that never touched this
   * browser instance's own `newContext` / `newPage`.
   */
  registerContext(context: BrowserContext): void;
  /** Is this context one the guard is watching? */
  isGuarded(context: BrowserContext): boolean;
  /** Restore the wrapped methods and detach every listener. */
  dispose(): void;
};

export function guardBrowser(browser: Browser): BrowserGuard {
  const records: BrowserErrorRecord[] = [];
  const guarded = new Set<BrowserContext>();
  const detach: Array<() => void> = [];

  const push = (kind: BrowserErrorKind, detail: string, where: string) => {
    records.push({ kind, detail, where });
  };

  const guardContext = (context: BrowserContext): void => {
    if (guarded.has(context)) return;
    guarded.add(context);

    const onConsole = (message: ConsoleMessage) => {
      if (message.type() === "error") {
        push("console", describeConsole(message), pageUrl(message.page()));
      }
    };
    const onWebError = (webError: WebError) => {
      push(
        "pageerror",
        `pageerror: ${redactExternalText(webError.error().message)}`,
        pageUrl(webError.page()),
      );
    };
    const onRequestFailed = (request: Request) => {
      push("requestfailed", describeRequestFailed(request), frameOwnerUrl(request));
    };
    const onResponse = (response: Response) => {
      if (response.status() >= 400) {
        push("response", describeResponse(response), frameOwnerUrl(response.request()));
      }
    };

    // `weberror` is the BrowserContext spelling of the page-level `pageerror`,
    // and it carries the page that produced it.
    context.on("console", onConsole);
    context.on("weberror", onWebError);
    context.on("requestfailed", onRequestFailed);
    context.on("response", onResponse);

    detach.push(() => {
      context.off("console", onConsole);
      context.off("weberror", onWebError);
      context.off("requestfailed", onRequestFailed);
      context.off("response", onResponse);
    });
  };

  // Contexts that already exist when the guard is installed — which is what a
  // spec-overridden `page` or `context` fixture produces, because those are
  // built before this fixture's body runs.
  for (const context of browser.contexts()) guardContext(context);

  // Contexts and pages created DURING the test.
  //
  // The browser is WORKER-SCOPED and shared by every test in this worker, so
  // `dispose()` must put it back exactly as it was found — including whether
  // these were own properties at all. Restoring a `bind`-ed copy would leave an
  // own property shadowing the prototype method for the rest of the worker's
  // life, and a second guard would then wrap the wrapper. So the previous
  // descriptor state is recorded and either restored or deleted.
  type NewContextArgs = Parameters<Browser["newContext"]>;
  type NewPageArgs = Parameters<Browser["newPage"]>;
  type Wrappable = {
    newContext: Browser["newContext"];
    newPage: Browser["newPage"];
  };
  const target = browser as Wrappable;

  const hadOwnNewContext = Object.prototype.hasOwnProperty.call(browser, "newContext");
  const hadOwnNewPage = Object.prototype.hasOwnProperty.call(browser, "newPage");
  const previousNewContext = target.newContext;
  const previousNewPage = target.newPage;

  target.newContext = async (...args: NewContextArgs): Promise<BrowserContext> => {
    const context = await previousNewContext.apply(browser, args);
    guardContext(context);
    return context;
  };
  target.newPage = async (...args: NewPageArgs): Promise<Page> => {
    const page = await previousNewPage.apply(browser, args);
    guardContext(page.context());
    return page;
  };

  return {
    records,
    cursor: () => records.length,
    since: (cursor: number) => records.slice(Math.max(0, cursor)),
    pages: () => [...guarded].flatMap((context) => safePages(context)),
    contextCount: () => guarded.size,
    registerContext: guardContext,
    isGuarded: (context: BrowserContext) => guarded.has(context),
    dispose: () => {
      if (hadOwnNewContext) target.newContext = previousNewContext;
      else delete (target as Partial<Wrappable>).newContext;
      if (hadOwnNewPage) target.newPage = previousNewPage;
      else delete (target as Partial<Wrappable>).newPage;
      for (const off of detach.splice(0)) off();
      guarded.clear();
    },
  };
}

/** `context.pages()` on a closed context throws; a closed context has none. */
function safePages(context: BrowserContext): Page[] {
  try {
    return context.pages();
  } catch {
    return [];
  }
}

/** The page URL that owns a request, without letting Playwright throw at us. */
function frameOwnerUrl(request: Request): string {
  try {
    return pageUrl(request.frame().page());
  } catch {
    return "";
  }
}

/**
 * Give the browser one round trip so events already emitted are delivered
 * before the guard asserts. A closed page is not an error here — the test may
 * legitimately have closed it — so the round trip is best-effort.
 */
export async function flushBrowserEvents(page: Page): Promise<void> {
  if (page.isClosed()) return;
  try {
    // Two round trips: the first lets in-flight microtasks settle, the second
    // guarantees the driver has drained everything the first one produced.
    await page.evaluate(
      () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
    );
    await page.evaluate(() => true);
  } catch {
    // Navigation or teardown raced us; whatever was already recorded stands.
  }
}

/**
 * THE SETTLE, AND EXACTLY WHAT IT BUYS.
 *
 * The guard asserts at a point in time, so there has always been a window after
 * the test body returns in which a fault is missed. An independent verifier
 * measured how wide it was: a fault scheduled `0 ms` after the body returns was
 * caught, and faults at **50 ms and 150 ms were missed**. In other words the
 * window was "whatever the driver had already delivered" — which for a Next.js
 * page means a hydration effect, a deferred fetch or a lazily loaded chunk that
 * throws just after the last assertion is invisible.
 *
 * So the flush now waits a fixed, bounded 250 ms before its round trips.
 * MEASURED ON THIS MACHINE (macOS arm64, Chromium 1243), faults scheduled at
 * 0 / 50 / 150 / 250 / 400 / 600 ms after the body returns:
 *
 *   settle    0 ms  ->  caught: 0                  missed: 50 150 250 400 600
 *   settle  100 ms  ->  caught: 0 50               missed: 150 250 400 600
 *   settle  250 ms  ->  caught: 0 50 150 250       missed: 400 600
 *   settle  400 ms  ->  caught: 0 50 150 250 400   missed: 600
 *
 * COST, measured on the real 18-test lane against the production server:
 * 250 ms per test, which is `3.2 s -> 4.4 s` at the local worker count and
 * `4.8 s -> 6.9 s` in the CI shape (`--workers=2`, 9 tests per worker). The
 * demonstration D14 records the numbers and the 20-run determinism check.
 *
 * THIS WIDENS THE WINDOW; IT DOES NOT CLOSE IT. A fault at 400 ms is still
 * missed, and no finite wait changes that. AGENTS.md states the limit as
 * "≥ 250 ms is caught, 400 ms is not", which is what was measured, rather than
 * implying the class is covered.
 */
const SETTLE_MS = 250;

/** Flush every page the guard is watching, so no page can hide a late event. */
export async function flushGuardedPages(guard: BrowserGuard): Promise<void> {
  // One bounded drain for the whole test, not one per page: the cost is a
  // constant per test rather than a multiple of how many pages it opened.
  await new Promise<void>((resolve) => setTimeout(resolve, SETTLE_MS));
  for (const page of guard.pages()) {
    await flushBrowserEvents(page);
  }
}

/**
 * THE THIRD LAYER: contexts alive on the harness's browser that the guard never
 * registered.
 *
 * `creation-guard.ts` registers a context created by any route through
 * `Browser.prototype.newContext` / `newPage`, and refuses a second browser
 * outright. This is the catch-all underneath both: whatever route produced it,
 * a live context on THIS browser that the guard is not watching means a page
 * ran unobserved, and the test must fail naming it.
 *
 * It is deliberately not the only control, because it cannot be: a context
 * created and closed inside the test body is gone by teardown (which is why the
 * prototype route is guarded rather than merely detected), and a separately
 * launched browser has contexts of its own that `browser.contexts()` cannot see
 * (which is why launching one is refused).
 *
 * Never throws: a disconnected browser has no contexts to report, and a control
 * that can make the lane flaky is not a control.
 */
export function unguardedContexts(
  browser: Browser,
  guard: BrowserGuard,
): BrowserContext[] {
  try {
    return browser.contexts().filter((context) => !guard.isGuarded(context));
  } catch {
    return [];
  }
}

/**
 * A one-line description of a context for a failure message. Every URL goes
 * through `redact.ts` for the same reason every record does: a failure message
 * is published as a CI artifact, and a query string is where a signed URL
 * leaks. Never throws — a closed context simply has no pages.
 */
export function describeContext(context: BrowserContext): string {
  const urls = safePages(context).map((page) => pageUrl(page));
  return urls.length === 0
    ? "no open pages"
    : `${urls.length} page(s): ${urls.join(", ")}`;
}

/** The per-test policy. An object, never a bare array — see the header. */
export type BrowserErrorPolicy = {
  readonly allow: readonly AllowedBrowserError[];
};

export const DENY_ALL: BrowserErrorPolicy = { allow: [] };

const KINDS: readonly BrowserErrorKind[] = [
  "console",
  "pageerror",
  "requestfailed",
  "response",
];

/**
 * Refuse a policy that is the wrong shape, or an allow-list entry that does not
 * actually say anything. Every rejection is a thrown test failure, never a
 * coerced default: the failure modes this guards are exactly the ones where a
 * quiet default would mean "allow more than intended".
 */
export function validatePolicy(policy: unknown): string[] {
  const problems: string[] = [];

  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    return [
      `browserErrorPolicy must be an object of the form { allow: [...] }, got ${
        Array.isArray(policy) ? "an array" : typeof policy
      }. ` +
        "A bare array is not accepted: Playwright reads a two-element array as a fixture tuple, " +
        "which would silently drop the second allow-list entry.",
    ];
  }

  const allow = (policy as { allow?: unknown }).allow;
  if (!Array.isArray(allow)) {
    return [
      "browserErrorPolicy.allow must be an array of { kind, match, reason } entries.",
    ];
  }

  allow.forEach((raw, index) => {
    const entry = raw as Partial<AllowedBrowserError>;
    const label = `browserErrorPolicy.allow[${index}]`;
    if (
      typeof entry?.kind !== "string" ||
      !KINDS.includes(entry.kind as BrowserErrorKind)
    ) {
      problems.push(
        `${label}.kind must be one of ${KINDS.join(", ")}, got ${String(entry?.kind)}.`,
      );
    }
    if (!(entry?.match instanceof RegExp)) {
      problems.push(
        `${label}.match must be a RegExp. A string would be matched by identity rather than ` +
          "by pattern, which silently allows nothing or everything depending on the reader.",
      );
    }
    if (typeof entry?.reason !== "string" || entry.reason.trim() === "") {
      problems.push(
        `${label} (${String(entry?.kind)}, ${String(entry?.match)}) has no written reason. ` +
          "An allow-list entry without a reason is a silenced failure; write why it is expected.",
      );
    }
  });

  return problems;
}

/** The records that no allow-list entry covers. */
export function unallowedRecords(
  records: readonly BrowserErrorRecord[],
  allowed: readonly AllowedBrowserError[],
): BrowserErrorRecord[] {
  return records.filter(
    (record) =>
      !allowed.some(
        (entry) =>
          entry.kind === record.kind && entry.match.test(record.detail),
      ),
  );
}

/** One record, as every failure message renders it. */
function renderRecord(record: BrowserErrorRecord): string {
  return `  [${record.kind}] ${record.detail}\n      at: ${record.where}`;
}

/** The allow-list footer, shared by every failure message. */
function renderAllowList(allowed: readonly AllowedBrowserError[]): string[] {
  if (allowed.length > 0) {
    return [
      "Allow-list in force for this test:",
      ...allowed.map(
        (entry) => `  ${entry.kind} ${String(entry.match)} — ${entry.reason}`,
      ),
    ];
  }
  return [
    "No allow-list is in force. If one of these is genuinely expected, declare it with",
    "test.use({ browserErrorPolicy: { allow: [{ kind, match, reason }] } }) and say why in the reason.",
  ];
}

/**
 * The failure message when signals arrive in either phase of a test.
 *
 * THE PHASE IS NAMED FIRST, and that is the point of the whole worker-scoped
 * rewrite. "The page was already in this state when your test started" and
 * "your test did this" send a reader to completely different places, and for
 * four verification rounds the first sentence could not be said at all —
 * anything a `beforeAll` hook did was invisible, so the test passed.
 */
export function formatPhasedFailure(
  before: readonly BrowserErrorRecord[],
  during: readonly BrowserErrorRecord[],
  allowed: readonly AllowedBrowserError[],
): string {
  const sections: string[] = [];
  if (before.length > 0) {
    sections.push(
      `${before.length} BEFORE THE TEST BODY — a hook (beforeAll/beforeEach) or a page shared ` +
        "with an earlier test produced these, and the page was already in this state when the " +
        "test started:",
      ...before.map(renderRecord),
    );
  }
  if (during.length > 0) {
    sections.push(`${during.length} DURING THE TEST:`, ...during.map(renderRecord));
  }
  return [
    `The page produced ${before.length + during.length} browser error(s) that no allow-list ` +
      "entry covers.",
    "AGENTS.md: console and network errors are failures, not noise.",
    "",
    ...sections,
    "",
    ...renderAllowList(allowed),
  ].join("\n");
}

/**
 * The worker-teardown message for signals that belong to no test at all.
 *
 * `afterAll` runs after the last test's accounting and before the worker
 * fixture tears down — measured on the installed 1.63.0 — so a page a hook
 * breaks once the suite is over is recorded by the listeners and charged to
 * nobody. A per-test allow-list cannot reach here, because there is no test to
 * carry one, so this is default-deny with no exit.
 */
export function formatOrphans(
  records: readonly BrowserErrorRecord[],
  violations: readonly { readonly detail: string }[],
): string {
  return [
    `${records.length + violations.length} browser signal(s) were produced AFTER THE LAST TEST ` +
      "in this worker finished — an afterAll/afterEach hook, or a page still running once the " +
      "suite was over. They belong to no test, so no test could fail for them; this worker " +
      "fails the run instead.",
    "AGENTS.md: console and network errors are failures, not noise.",
    "",
    ...records.map(renderRecord),
    ...violations.map((violation) => `  ${violation.detail}`),
    "",
    "A per-test allow-list cannot reach here, because there is no test to carry it. If a hook",
    "legitimately produces a signal, do that work in `beforeAll` — where the first test of the",
    "group owns it — or in a test.",
    "",
    "See e2e/harness/worker-guard.ts.",
  ].join("\n");
}

/**
 * The single-phase failure message, listing every unallowed signal and the
 * allow-list in force.
 *
 * THE FIXTURE NO LONGER CALLS THIS — it calls `formatPhasedFailure`, because a
 * signal now has to be attributed to "before the test body" or "during it", and
 * saying which is the whole point of the worker-scoped listening. This is kept
 * exported and pinned by `browser-errors.test.ts` as the one-phase renderer:
 * it is the shape `scripts/ci/harness-canary.mjs`'s comment refers to when it
 * describes the `[kind]` markers, and both formatters share `renderRecord` and
 * `renderAllowList`, so the message contract cannot drift between them.
 */
export function formatFailure(
  unallowed: readonly BrowserErrorRecord[],
  allowed: readonly AllowedBrowserError[],
): string {
  const lines = [
    `The page produced ${unallowed.length} browser error(s) that no allow-list entry covers.`,
    "AGENTS.md: console and network errors are failures, not noise.",
    "",
    ...unallowed.map(
      (record) =>
        `  [${record.kind}] ${record.detail}\n      at: ${record.where}`,
    ),
  ];
  if (allowed.length > 0) {
    lines.push("", "Allow-list in force for this test:");
    for (const entry of allowed) {
      lines.push(`  ${entry.kind} ${String(entry.match)} — ${entry.reason}`);
    }
  } else {
    lines.push(
      "",
      "No allow-list is in force. If one of these is genuinely expected, declare it with",
      "test.use({ browserErrorPolicy: { allow: [{ kind, match, reason }] } }) and say why in the reason.",
    );
  }
  return lines.join("\n");
}
