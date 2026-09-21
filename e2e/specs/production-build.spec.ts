/**
 * The lane is pointed at a PRODUCTION build — asserted, not assumed.
 *
 * Without this spec the whole harness is one wrong `E2E_BASE_URL` away from
 * testing `next dev`: a different bundle graph, a dev error overlay that
 * swallows what the guard is meant to catch, different caching, different React
 * behaviour — all of it green. Every later UI slice proves itself through this
 * harness, so this is the assertion that keeps the rest meaningful.
 *
 * Five independent markers, all measured on 2026-09-20 against this repository
 * at Next 16.3.5 (see `e2e/harness/production-build.ts` for the table). They
 * are asserted together: if a future Next release retires one, this spec should
 * go red and be fixed deliberately, not silently lose its only real check.
 */

import {
  probeProductionBuild,
  productionBuildProblems,
} from "../harness/production-build";
import { expect, test } from "../harness/test";

test.describe("the target is the production build", () => {
  test("shows every production marker and no development marker", async ({
    page,
  }) => {
    // Attach before navigating: the dev bundles and the HMR socket are
    // requested during the first document load.
    const probe = probeProductionBuild(page);

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const problems = await productionBuildProblems(page, probe);
    expect(
      problems,
      "this is not a production build — the browser lane must never run against `next dev`:\n" +
        problems.map((problem) => `  - ${problem}`).join("\n"),
    ).toEqual([]);
  });

  test("the same markers hold on a dynamic route", async ({ page }) => {
    // `/health` is `force-dynamic`, so it exercises the server-render path
    // rather than a prerendered document. A dev server would fail here too.
    const probe = probeProductionBuild(page);

    await page.goto("/health");
    await page.waitForLoadState("networkidle");

    const problems = await productionBuildProblems(page, probe);
    expect(problems, problems.join("\n")).toEqual([]);
  });
});
