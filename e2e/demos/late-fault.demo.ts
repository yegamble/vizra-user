/**
 * DEMONSTRATION D14 — THE FLUSH WINDOW, made executable.
 *
 * The guard asserts at a point in time, so a fault that fires after the test
 * body returns is a race the harness can only win for a bounded interval. An
 * independent verifier measured how bounded it was: `0 ms` caught, **50 ms and
 * 150 ms missed**. That is not an abstract limitation — a Next.js page whose
 * hydration effect throws just after the last assertion was invisible.
 *
 * `flushGuardedPages` now waits a fixed 250 ms before its round trips, and
 * `browser-errors.ts` carries the measurement table and the cost. This file
 * pins BOTH ENDS of the new boundary, because a limit stated only in prose is a
 * limit nobody notices moving:
 *
 *   RED   — a fault 150 ms after the body returns MUST fail the test. If the
 *           settle is ever shortened or removed, this half goes green and
 *           `scripts/e2e/demonstrate.sh` reports the failure.
 *   LIMIT — a fault 600 ms after the body returns is MISSED, and the test
 *           passes. This half is GREEN on purpose. It is the honest half: the
 *           window is wider, not closed, and if someone widens the settle far
 *           enough to catch this, the number in AGENTS.md is wrong and this
 *           half says so.
 *
 * The fault is the same uncaught exception D3 uses, scheduled from the last
 * line of the body so that "after the body returns" means what it says.
 */

import { expect, test } from "../harness/test";

const FIXTURE_MESSAGE = "__vizra_e2e_fixture__ late fault demonstration (D14)";

/** Schedule the throw `delay` ms from now, then return immediately. */
async function throwLater(
  page: import("@playwright/test").Page,
  delay: number,
): Promise<void> {
  await page.evaluate(
    ([message, ms]) => {
      setTimeout(
        () => {
          throw new Error(String(message));
        },
        Number(ms),
      );
    },
    [FIXTURE_MESSAGE, delay] as const,
  );
}

test.describe("RED: a fault 150 ms after the body returns", () => {
  test("is caught, because the flush settles for 250 ms first", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { level: 1, name: "Vizra" }),
    ).toBeVisible();
    await throwLater(page, 150);
  });
});

test.describe("LIMIT: a fault 600 ms after the body returns", () => {
  test("is MISSED, and this passing test is the documented limit", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { level: 1, name: "Vizra" }),
    ).toBeVisible();
    await throwLater(page, 600);
  });
});
