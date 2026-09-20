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
 * WHEN IT ASSERTS. In fixture teardown, after the test body, so a test cannot
 * pass by simply not looking. Before asserting, the guard makes one round trip
 * into the page (`page.evaluate`) to flush events that the browser has emitted
 * but the driver has not yet delivered — without it an error raised by the last
 * action of a test could arrive after the assertion and be lost.
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

import { redactUrl, redactUrlsInText } from "./redact";

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
function describeConsole(message: ConsoleMessage): string {
  const location = message.location();
  const at = location.url
    ? ` (${redactUrl(location.url)}:${location.lineNumber}:${location.columnNumber})`
    : "";
  return `console.error: ${redactUrlsInText(message.text())}${at}`;
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
 * attached to the BROWSER for the test's lifetime, at BrowserContext level —
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
 *     (both are wrapped for the test's lifetime and restored afterwards);
 *   - `context.newPage()`, and popups/new tabs the page opens itself (a context
 *     listener covers every page in the context);
 *   - a spec that overrides the `browser` fixture — the harness fixture takes
 *     `browser` as a dependency, so it guards whichever browser the spec built.
 *
 * NOT COVERED, and nothing else catches it today. The wrapping below is on the
 * browser instance's OWN properties, so any route to a context that does not go
 * through them escapes. An independent verifier measured three, each from a
 * spec importing only the harness `test`, each passing the complete gate on a
 * page that 404s and throws:
 *
 *     Object.getPrototypeOf(browser).newContext.call(browser)
 *     browser.browserType().launch()
 *     playwright.chromium.launchPersistentContext(dir)
 *
 * (`Object.getPrototypeOf(browser).newPage.call(browser)` IS caught, because the
 * prototype's `newPage` calls `this.newContext` — the wrapper.) None of the
 * three imports a Playwright package, so `vizra/no-unguarded-playwright-import`
 * cannot see them; the runtime stamp, the coverage floor, the canary and the
 * workflow parser do not either. Review is the only control. This module used
 * to describe the residual as "a spec that launches its OWN browser, which
 * requires importing a Playwright package … refused by the lint rule"; that was
 * false, and AGENTS.md § Residuals now states it in terms of the OBJECT the
 * harness was never handed. Closing it — a teardown assertion that
 * `browser.contexts()` holds no unguarded context, plus three method names in
 * the lint rule — is queued as the next harness slice and is NOT done here.
 *
 * ALSO NOT COVERED, by design: Playwright's `request` fixture. The kinds below
 * are BROWSER signals; an `APIRequestContext` 404 is not one and does not fail
 * a test. And the flush window is finite — a fault scheduled 0 ms after the
 * body returns is caught, one at 50 ms or 150 ms is not.
 */
export type BrowserGuard = {
  /** Everything observed, in order, across every guarded context. */
  readonly records: BrowserErrorRecord[];
  /** Every page currently open in a guarded context (for the flush). */
  pages(): Page[];
  /** How many contexts the guard is watching — asserted by the harness tests. */
  contextCount(): number;
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
        `pageerror: ${redactUrlsInText(webError.error().message)}`,
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
    pages: () => [...guarded].flatMap((context) => safePages(context)),
    contextCount: () => guarded.size,
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

/** Flush every page the guard is watching, so no page can hide a late event. */
export async function flushGuardedPages(guard: BrowserGuard): Promise<void> {
  for (const page of guard.pages()) {
    await flushBrowserEvents(page);
  }
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

/** The failure message, listing every unallowed signal and the allow-list in force. */
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
