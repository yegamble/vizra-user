/**
 * DEMONSTRATION D14 — a request that NEVER COMPLETES fails the lane.
 *
 * EXPECTED TO FAIL (red half). See `console-error.demo.ts` for why these live
 * outside the lane's `*.spec.ts` selection.
 *
 * WHY THIS FIXTURE HAD TO EXIST. The guard watches four browser signals; the
 * canary covered three. An independent verifier measured the consequence
 * exactly: neutering the `console`, `weberror` or `response` listener in
 * `e2e/harness/browser-errors.ts` turns `scripts/ci/harness-canary.mjs` red,
 * and neutering `requestfailed` left it **green**. None of the other three
 * fixtures produces a `requestfailed` record — a 404 is a COMPLETED response,
 * not a failed request — so the one kind that catches aborted requests,
 * connection refused and DNS failures could have been dropped from the guard
 * and no lane would have noticed. That is the exact defect class the canary
 * exists to close.
 *
 * WHY AN ABORTED ROUTE AND NOT A CLOSED PORT. A request to a port that happens
 * to be closed is a fault that depends on the machine: a runner with something
 * listening on that port turns this fixture green and nobody is told. An
 * aborted route is hermetic — `route.abort("connectionrefused")` produces the
 * same `net::ERR_CONNECTION_REFUSED` the browser would report for a refused
 * connection, on every machine, with no network involved. Nothing is mocked in
 * a product path: the interception exists only in this file, and
 * `scripts/ci/check-no-test-fixtures-in-image.sh` proves the built image
 * contains neither this file nor the token below.
 *
 * MEASURED KIND SET (not assumed): `{requestfailed, console}` and NOT
 * `{response, pageerror}` — Chromium also logs the failed load on the console,
 * exactly as it does for the 404 fixture. The fault is a sub-resource, in the
 * same shape as D2, so that the ONLY difference between the two fixtures is the
 * one under demonstration: D2's request completes with a 404 status, this one
 * never completes at all. That difference is why the `response` listener cannot
 * stand in for the `requestfailed` one.
 */

import { expect, test } from "../harness/test";

const ABORTED_PATH = "/__vizra_e2e_fixture__/aborted-on-purpose.bin";

/**
 * Ask for a sub-resource whose connection is refused before it can complete.
 * `page.route` is registered before navigation so the very first attempt is the
 * one that fails.
 */
async function requestAnAbortedResource(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.route(`**${ABORTED_PATH}`, (route) =>
    route.abort("connectionrefused"),
  );
  await page.addInitScript((path) => {
    globalThis.addEventListener("DOMContentLoaded", () => {
      // A sub-resource, exactly as in D2: an image's failure to load raises no
      // exception in the page, so this fixture demonstrates `requestfailed`
      // and not `pageerror`.
      const img = new Image();
      img.src = path;
      document.body.appendChild(img);
    });
  }, ABORTED_PATH);
}

test.describe("RED: a request that never completes", () => {
  test("fails even though nothing on the page looks wrong", async ({
    page,
  }) => {
    await requestAnAbortedResource(page);

    await page.goto("/");
    await expect(
      page.getByRole("heading", { level: 1, name: "Vizra" }),
    ).toBeVisible();
  });
});

test.describe("GREEN: the same failed request, allow-listed with a written reason", () => {
  test.use({
    browserErrorPolicy: {
      allow: [
        {
          kind: "requestfailed",
          match: /aborted-on-purpose\.bin/,
          reason:
            "D14 green half: the demonstration refuses this connection on purpose. A real entry " +
            "would name the ledger ID of the upstream that is expected to be absent.",
        },
        {
          kind: "console",
          match: /aborted-on-purpose\.bin|Failed to load resource/,
          reason:
            "D14 green half: Chromium also reports the refused connection on the console; the " +
            "same deliberate failure, seen through a second signal.",
        },
      ],
    },
  });

  test("passes once the deliberate failure is declared", async ({ page }) => {
    await requestAnAbortedResource(page);

    await page.goto("/");
    await expect(
      page.getByRole("heading", { level: 1, name: "Vizra" }),
    ).toBeVisible();
  });
});
