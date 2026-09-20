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

import type { Page, Request, Response, ConsoleMessage } from "@playwright/test";

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

/**
 * Attach the collectors to a page and return the accumulating record list.
 *
 * Listeners are attached before any navigation so that errors raised during the
 * first document load are caught too.
 */
export function collectBrowserErrors(page: Page): BrowserErrorRecord[] {
  const records: BrowserErrorRecord[] = [];
  const push = (kind: BrowserErrorKind, detail: string) => {
    records.push({ kind, detail, where: redactUrl(page.url()) });
  };

  page.on("console", (message) => {
    if (message.type() === "error") push("console", describeConsole(message));
  });
  page.on("pageerror", (error) => {
    push("pageerror", `pageerror: ${redactUrlsInText(error.message)}`);
  });
  page.on("requestfailed", (request) => {
    push("requestfailed", describeRequestFailed(request));
  });
  page.on("response", (response) => {
    if (response.status() >= 400) push("response", describeResponse(response));
  });

  return records;
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
