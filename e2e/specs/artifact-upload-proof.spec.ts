/**
 * THROWAWAY. This spec exists to fail once, in CI, so that the `e2e` lane's
 * `if: failure()` artifact path executes for the first time.
 *
 * The verifier's FINDING 5: both `e2e` runs in this repository's history were
 * green, so the upload step had never run and `if-no-files-found: warn` would
 * have turned a wrong path into a warning nobody reads. The VZ-FOUND-008 ledger
 * entry asks for "retained traces for a deliberately failing spec"; this is that
 * spec. The branch and its pull request are deleted once the run URL, the
 * artifact listing and the sentinel sweep are recorded.
 *
 * It fails for a REAL reason — the page requests a resource the production
 * server answers 404 — and it carries a signed-URL-shaped query string, so the
 * same run proves FINDING 4's fix on artifacts that GitHub actually stored.
 */

import { expect, test } from "../harness/test";

const SENTINEL_SIGNATURE = "SENTINEL-SIGNATURE-DO-NOT-SHIP";
const SIGNED_PATH =
  `/__vizra_e2e_fixture__/media/photo.jpg` +
  `?X-Amz-Signature=${SENTINEL_SIGNATURE}&X-Amz-Expires=60`;

test("DELIBERATE FAILURE: proves the CI artifact path executes", async ({ page }) => {
  await page.addInitScript((url) => {
    globalThis.addEventListener("DOMContentLoaded", () => {
      const img = new Image();
      img.src = url;
      document.body.appendChild(img);
    });
  }, SIGNED_PATH);

  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Vizra" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  // The browser-error guard fails this in teardown on the 404. Intended.
});
