/**
 * DEMONSTRATION D1 — a page that logs `console.error` fails the lane.
 *
 * THIS FILE IS EXPECTED TO FAIL. `playwright.config.ts` matches `*.spec.ts`
 * only, so the lane never collects it; `scripts/e2e/demonstrate.sh` runs it
 * through `playwright.demos.config.ts` and asserts a NON-ZERO exit for the red
 * half, then runs the green half below and asserts zero.
 *
 * WHY THE FAULT IS INJECTED RATHER THAN ROUTED. A throwaway `app/` route would
 * be a real route in a real build, one `.dockerignore` mistake away from
 * shipping. There is no route here: `page.addInitScript` evaluates the fault in
 * the browser, against the unmodified production server, and the fault exists
 * only in this file. `scripts/ci/check-no-test-fixtures-in-image.sh` proves the
 * built image contains neither this file nor the token below.
 */

import { expect, test } from "../harness/test";

const FIXTURE_TOKEN = "__vizra_e2e_fixture__ console.error demonstration (D1)";

test.describe("RED: an unexpected console.error", () => {
  test("fails even though the test body itself asserts nothing about the console", async ({
    page,
  }) => {
    await page.addInitScript((token) => {
      // eslint-disable-next-line no-console -- the fault under demonstration
      console.error(token);
    }, FIXTURE_TOKEN);

    await page.goto("/");
    // The body passes. The guard in e2e/harness/test.ts must fail the test
    // anyway, in teardown — that is the whole point.
    await expect(
      page.getByRole("heading", { level: 1, name: "Vizra" }),
    ).toBeVisible();
  });
});

test.describe("GREEN: the same console.error, allow-listed with a written reason", () => {
  test.use({
    browserErrorPolicy: {
      allow: [
        {
          kind: "console",
          match: /__vizra_e2e_fixture__ console\.error demonstration/,
          reason:
            "D1 green half: the demonstration deliberately logs this, and the allow-list is the " +
            "only sanctioned way past the guard. A real allow-list entry would name the ledger ID.",
        },
      ],
    },
  });

  test("passes, and only this exact message is forgiven", async ({ page }) => {
    await page.addInitScript((token) => {
      // eslint-disable-next-line no-console -- the fault under demonstration
      console.error(token);
    }, FIXTURE_TOKEN);

    await page.goto("/");
    await expect(
      page.getByRole("heading", { level: 1, name: "Vizra" }),
    ).toBeVisible();
  });
});
