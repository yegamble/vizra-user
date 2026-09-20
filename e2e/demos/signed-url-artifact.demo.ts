/**
 * DEMONSTRATION D9 — a signed-URL-shaped query string must not survive into an
 * uploaded artifact.
 *
 * EXPECTED TO FAIL (that is the point): the failure is what makes Playwright
 * write a trace, and the trace is the artifact under test.
 *
 * THE LEAK THIS PINS. `e2e/harness/redact.ts` strips query strings from
 * everything the harness records. It cannot reach Playwright's own trace, which
 * the browser driver writes before any harness code sees it. An independent
 * verifier drove a page holding `?X-Amz-Signature=…` and found the value
 * redacted in every harness line and in `browser-signals.json`, and present
 * VERBATIM inside `trace.zip` members `1-trace.network` and `1-trace.trace` —
 * which the `e2e` workflow uploads as a 14-day downloadable artifact. From M1,
 * when vizra-core issues signed media URLs (ADR-005), that is a real credential
 * published to anyone who can read the run.
 *
 * `scripts/e2e/demonstrate.sh` (D9) runs this spec twice: once WITHOUT
 * `scripts/ci/redact-artifacts.sh` — where the sentinel below must be findable
 * inside the trace, or the demonstration is proving nothing — and once with it,
 * where `grep -r` over every unzipped member, binary files included, must find
 * it zero times while the host and path remain readable.
 *
 * The sentinel is deliberately low-entropy and self-describing. A realistic
 * high-entropy value committed to a repository is the exact habit that started
 * this: the first push of this harness had a token-shaped string flagged by the
 * secret scanner.
 */

import { expect, test } from "../harness/test";

/** Not a credential. Shaped like one, named so nobody mistakes it for one. */
export const SENTINEL_SIGNATURE = "SENTINEL-SIGNATURE-DO-NOT-SHIP";

const SIGNED_PATH =
  `/__vizra_e2e_fixture__/media/photo.jpg` +
  `?X-Amz-Signature=${SENTINEL_SIGNATURE}&X-Amz-Expires=60`;

test.describe("RED: a page holding a signed-URL-shaped query string", () => {
  test("fails, and the failure is what produces the trace under test", async ({ page }) => {
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
    // The guard fails this in teardown on the 404. That is intended: a passing
    // test retains no trace, and a trace is what this demonstration inspects.
  });
});
