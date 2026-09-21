/**
 * Production-build markers.
 *
 * WHY. The contract requires the UI to be exercised in the **production-mode**
 * build (meta `AGENTS.md`, step 4; ADR-009). A harness that happily drives
 * `next dev` would be testing a different application: different bundles,
 * different error overlay, different caching, different React behaviour —
 * and it would be green the whole time. So "this is a production build" is an
 * assertion the lane makes, not an assumption the lane relies on.
 *
 * MEASURED, NOT GUESSED. On 2026-09-20 the same commit was served two ways —
 * the standalone production server and `next dev` — with Next 16.3.5 and
 * Turbopack, and the observable differences were recorded:
 *
 *   | marker                              | production                              | development                  |
 *   |-------------------------------------|-----------------------------------------|------------------------------|
 *   | RSC flight build id (`"b"`)         | e.g. `qOH9pGJV11s0_G5FluuOi`            | `development`                |
 *   | dev client bundles requested        | none                                    | hmr-client, next-devtools, … |
 *   | WebSocket opened by the page        | none                                    | the HMR socket               |
 *   | `<nextjs-portal>` element           | absent                                  | present (dev overlay)        |
 *   | `cache-control` on `/_next/static/**` | `public, max-age=31536000, immutable` | `no-cache, must-revalidate`  |
 *
 * All five are asserted. Any single one failing fails the spec: a future Next
 * release may retire one of them, and the lane should go red and be fixed
 * deliberately rather than quietly lose its only real check.
 */

import type { Page, Response } from "@playwright/test";

import { redactUrl } from "./redact";

/**
 * Request URL substrings that only a Next development server serves. Taken
 * from the measured dev document, not from memory.
 */
const DEV_ONLY_ASSET_MARKERS = [
  "hmr-client",
  "next-devtools",
  "webpack-hmr",
  "hot-update",
  "polyfill-nomodule",
  "__nextjs_original-stack-frame",
  "__nextjs_launch-editor",
] as const;

export type ProductionEvidence = {
  /** Every request URL the page issued while the probe was attached. */
  readonly requestedUrls: readonly string[];
  /** Every WebSocket URL the page opened. */
  readonly webSocketUrls: readonly string[];
  /** `cache-control` seen on each `/_next/static/` response. */
  readonly staticCacheControl: readonly string[];
};

export type ProductionProbe = {
  readonly evidence: ProductionEvidence;
  /** Main-frame document responses, newest last. Their bodies carry the build id. */
  readonly documentResponses: Response[];
};

/**
 * Attach the network half of the probe. Must be called before navigation.
 */
export function probeProductionBuild(page: Page): ProductionProbe {
  const requestedUrls: string[] = [];
  const webSocketUrls: string[] = [];
  const staticCacheControl: string[] = [];
  const documentResponses: Response[] = [];

  // Redacted at capture, not at print: nothing downstream — a failure message,
  // an attached artifact, a committed transcript — can then leak a query string
  // by forgetting to call the redactor. The markers below only ever look at the
  // path, so nothing is lost.
  page.on("request", (request) => {
    requestedUrls.push(redactUrl(request.url()));
  });
  page.on("websocket", (ws) => {
    webSocketUrls.push(redactUrl(ws.url()));
  });
  page.on("response", (response) => {
    if (response.url().includes("/_next/static/")) {
      staticCacheControl.push(
        response.headers()["cache-control"] ?? "(absent)",
      );
    }
    const request = response.request();
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      documentResponses.push(response);
    }
  });

  return {
    evidence: { requestedUrls, webSocketUrls, staticCacheControl },
    documentResponses,
  };
}

/**
 * Read the RSC flight build id out of the SERVER'S document, not the live DOM.
 *
 * Next streams the flight payload through inline `self.__next_f.push(...)`
 * scripts, and the root chunk carries `"b":"<buildId>"` — the literal string
 * `development` when the server is `next dev`. It must be read from the
 * response body: measured on 2026-09-20, once React has hydrated, `__next_f`
 * is drained to an empty array AND the inline scripts are gone from the DOM,
 * so reading either from the page returns nothing and the marker would quietly
 * become "could not check".
 *
 * Returns `null` when no build id can be found, which the caller treats as a
 * failure rather than a pass.
 */
export async function readFlightBuildId(
  probe: ProductionProbe,
): Promise<string | null> {
  const response = probe.documentResponses.at(-1);
  if (!response) return null;
  let body: string;
  try {
    body = await response.text();
  } catch {
    return null;
  }
  // The flight payload is embedded as a JavaScript string literal inside an
  // inline <script>, so its own quotes arrive backslash-escaped
  // (`\"b\":\"<id>\"`). Unescape before matching, or the marker silently finds
  // nothing and degrades into "could not check".
  const normalized = body.replace(/\\"/g, '"');
  const ids = [...normalized.matchAll(/"b":"([^"]*)"/g)]
    .map((match) => match[1])
    .filter((id): id is string => typeof id === "string" && id !== "");
  if (ids.length === 0) return null;
  // If any occurrence says `development`, that is the answer: a dev server must
  // never be masked by a second, innocuous match elsewhere in the payload.
  return ids.includes("development") ? "development" : (ids[0] as string);
}

/** Is the Next dev-overlay custom element in the document? */
export async function hasDevOverlay(page: Page): Promise<boolean> {
  return page.evaluate(() => document.querySelector("nextjs-portal") !== null);
}

/**
 * Every marker, as a list of problems. Empty list means "this is a production
 * build" by all five independent measures.
 */
export async function productionBuildProblems(
  page: Page,
  probe: ProductionProbe,
): Promise<string[]> {
  const problems: string[] = [];
  const { requestedUrls, webSocketUrls, staticCacheControl } = probe.evidence;

  // 1. dev-only client bundles
  const devAssets = requestedUrls.filter((url) => {
    const decoded = decodeURIComponent(url);
    return DEV_ONLY_ASSET_MARKERS.some((marker) => decoded.includes(marker));
  });
  if (devAssets.length > 0) {
    problems.push(
      `the page requested development-only bundles, so this is not a production build:\n` +
        devAssets.map((url) => `    ${url}`).join("\n"),
    );
  }

  // 2. the HMR socket
  if (webSocketUrls.length > 0) {
    problems.push(
      `the page opened ${webSocketUrls.length} WebSocket(s); the production build opens none ` +
        `(a dev server opens the HMR socket):\n` +
        webSocketUrls.map((url) => `    ${url}`).join("\n"),
    );
  }

  // 3. the dev overlay
  if (await hasDevOverlay(page)) {
    problems.push(
      "the Next development overlay (<nextjs-portal>) is in the document.",
    );
  }

  // 4. the build id
  const buildId = await readFlightBuildId(probe);
  if (buildId === null) {
    problems.push(
      "no RSC flight build id could be read from the main-frame document response. Either the " +
        "page is not a Next App Router response, or Next changed the flight payload shape — fix " +
        "this marker rather than dropping it.",
    );
  } else if (buildId === "development") {
    problems.push(
      `the RSC flight build id is "development": this server is \`next dev\`.`,
    );
  }

  // 5. immutable static assets
  if (staticCacheControl.length === 0) {
    problems.push(
      "no /_next/static/ response was observed, so the immutable-caching marker could not be " +
        "checked. A production page load always fetches at least one built asset.",
    );
  } else {
    const mutable = staticCacheControl.filter(
      (value) => !value.includes("immutable"),
    );
    if (mutable.length > 0) {
      problems.push(
        `/_next/static/ responses are not immutably cached, which is the development behaviour:\n` +
          mutable.map((value) => `    cache-control: ${value}`).join("\n"),
      );
    }
  }

  return problems;
}
