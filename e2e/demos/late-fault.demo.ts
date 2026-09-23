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
 *   LIMIT — a fault that fires LONG after the body returns is not charged to
 *           the test, and the test passes. This half is GREEN on purpose: the
 *           window is wider, not closed.
 *
 * WHY THE LIMIT HALF NO LONGER USES 600 ms. It did, and an independent verifier
 * ran the suite at load averages of 76-92 and watched it fail in BOTH runs —
 * the guard caught the 600 ms fault it is documented to miss (PR #8,
 * R2-FINDING G). That is the fail-closed direction, and it is also a
 * demonstration whose outcome depends on how busy the machine is, which is not
 * evidence. What made it timing-dependent: the 250 ms settle is a Node timer and
 * the fault is a browser timer, and under load the settle stretches while the
 * page's timer does not, so the two can swap order.
 *
 * So the half now schedules the fault 20 s after the body — far past the settle
 * and past the moment the test's context is closed, whatever the load — and
 * asserts the invariant that survives every load: a fault that has not fired by
 * the time the test's window closes is not charged to that test. The
 * WALL-CLOCK width of the window is pinned separately, deterministically, by a
 * unit test on `SETTLE_MS` itself (`e2e/harness/browser-errors.test.ts`), and
 * the RED half above still proves a fault inside the window is caught. The
 * 250 ms / 400 ms / 600 ms table in AGENTS.md is a QUIET-MACHINE measurement,
 * and says so.
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

test.describe("LIMIT: a fault 20 s after the body returns", () => {
  test("is MISSED, and this passing test is the documented limit", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { level: 1, name: "Vizra" }),
    ).toBeVisible();
    await throwLater(page, 20_000);
  });
});
