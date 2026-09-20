/**
 * DEMONSTRATION D2 — a page that requests a resource returning 404 fails the lane.
 *
 * EXPECTED TO FAIL (red half). See `console-error.demo.ts` for why these live
 * outside the lane's `*.spec.ts` selection and why the fault is injected rather
 * than routed.
 *
 * The 404 is REAL: the production server answers `/__vizra_e2e_fixture__/...`
 * with its own 404, exactly as it would for a mistyped asset path in a product
 * page. Nothing is mocked and no route is added.
 *
 * The green half allow-lists precisely what the red half produced, kind by
 * kind — which is the point of the allow-list being per kind and per pattern:
 * forgiving a 404 must not also forgive an uncaught exception.
 */

import { expect, test } from "../harness/test";

const MISSING_PATH = "/__vizra_e2e_fixture__/missing-on-purpose.png";

/** Inject a sub-resource request for a path the production server will 404. */
async function requestAMissingImage(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.addInitScript((path) => {
    globalThis.addEventListener("DOMContentLoaded", () => {
      const img = new Image();
      img.src = path;
      document.body.appendChild(img);
    });
  }, MISSING_PATH);
}

test.describe("RED: a sub-resource that 404s", () => {
  test("fails even though the visible page is perfectly fine", async ({
    page,
  }) => {
    await requestAMissingImage(page);

    await page.goto("/");
    await expect(
      page.getByRole("heading", { level: 1, name: "Vizra" }),
    ).toBeVisible();
    await page.waitForLoadState("networkidle");
  });
});

test.describe("GREEN: the same 404, allow-listed with a written reason", () => {
  test.use({
    browserErrorPolicy: {
      allow: [
        {
          kind: "response",
          match: /__vizra_e2e_fixture__\/missing-on-purpose\.png/,
          reason:
            "D2 green half: the demonstration asks for a path that does not exist, on purpose. " +
            "A real entry would name the ledger ID of the asset that is not built yet.",
        },
        {
          kind: "console",
          match: /missing-on-purpose\.png|Failed to load resource/,
          reason:
            "D2 green half: Chromium also reports the failed sub-resource load on the console; " +
            "the same deliberate 404, seen through a second signal.",
        },
        {
          kind: "requestfailed",
          match: /missing-on-purpose\.png/,
          reason:
            "D2 green half: same deliberate 404, should the browser report it as a failed request.",
        },
      ],
    },
  });

  test("passes once the deliberate 404 is declared", async ({ page }) => {
    await requestAMissingImage(page);

    await page.goto("/");
    await expect(
      page.getByRole("heading", { level: 1, name: "Vizra" }),
    ).toBeVisible();
    await page.waitForLoadState("networkidle");
  });
});
