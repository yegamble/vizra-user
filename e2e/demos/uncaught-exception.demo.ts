/**
 * DEMONSTRATION D3 — an uncaught exception in the page fails the lane.
 *
 * EXPECTED TO FAIL (red half). See `console-error.demo.ts` for why these live
 * outside the lane's `*.spec.ts` selection and why the fault is injected rather
 * than routed.
 *
 * This is the signal a smoke test misses most often: the visible page is
 * correct, the assertions pass, and a handler threw. In production that is a
 * dead control or a half-applied mutation; here it must be a red lane.
 */

import { expect, test } from "../harness/test";

const FIXTURE_MESSAGE =
  "__vizra_e2e_fixture__ uncaught exception demonstration (D3)";

/** Throw asynchronously, so nothing in the page's own load path catches it. */
async function throwInThePage(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.addInitScript((message) => {
    globalThis.addEventListener("DOMContentLoaded", () => {
      setTimeout(() => {
        throw new Error(message);
      }, 0);
    });
  }, FIXTURE_MESSAGE);
}

test.describe("RED: an uncaught exception", () => {
  test("fails even though every assertion in the body passes", async ({
    page,
  }) => {
    await throwInThePage(page);

    await page.goto("/");
    await expect(
      page.getByRole("heading", { level: 1, name: "Vizra" }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "/health" })).toBeVisible();
  });
});

test.describe("GREEN: the same exception, allow-listed with a written reason", () => {
  test.use({
    browserErrorPolicy: {
      allow: [
        {
          kind: "pageerror",
          match: /__vizra_e2e_fixture__ uncaught exception demonstration/,
          reason:
            "D3 green half: the demonstration throws this on purpose. In real use an uncaught " +
            "exception should essentially never be allow-listed — it is here only to show the " +
            "mechanism is the same for every kind.",
        },
        {
          kind: "console",
          match: /__vizra_e2e_fixture__ uncaught exception demonstration/,
          reason:
            "D3 green half: Chromium may also surface the same throw on the console.",
        },
      ],
    },
  });

  test("passes once the deliberate throw is declared", async ({ page }) => {
    await throwInThePage(page);

    await page.goto("/");
    await expect(
      page.getByRole("heading", { level: 1, name: "Vizra" }),
    ).toBeVisible();
  });
});
