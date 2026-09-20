/**
 * THROWAWAY. Makes the `e2e` lane go red so the artifact steps execute.
 *
 * Paired with a forced failure of the redaction step in this branch's copy of
 * .github/workflows/e2e.yml, to demonstrate FINDING 7: when the redactor itself
 * exits non-zero, NOTHING is uploaded. Before the fix both steps carried a bare
 * `if: failure()`, which is true whenever any earlier step failed, so the
 * unredacted tree was published anyway.
 *
 * The branch and its pull request are deleted once the run URL and the empty
 * artifact listing are recorded.
 */

import { expect, test } from "../harness/test";

test("DELIBERATE FAILURE: makes the artifact steps run", async ({ page }) => {
  await page.addInitScript(() => {
    globalThis.addEventListener("DOMContentLoaded", () => {
      const img = new Image();
      img.src = "/__vizra_e2e_fixture__/redactor-failure-proof.png";
      document.body.appendChild(img);
    });
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Vizra" })).toBeVisible();
  await page.waitForLoadState("networkidle");
});
