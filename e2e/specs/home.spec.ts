/**
 * The first real journey: a visitor arrives at `/` and follows the one link on
 * the page to `/health`.
 *
 * This is deliberately small, because it is honest about what exists today —
 * `app/page.tsx` is an M0 placeholder with no app shell, no tokens and no
 * product surface. What it is NOT is a smoke test: the harness's guard is armed
 * for every assertion below, so this run also proves that the production build
 * loads, hydrates and navigates with no console error, no uncaught exception,
 * no failed request and no HTTP >= 400 response, at 1440 px and at 390 px.
 *
 * When the app shell lands, this file grows; it does not get replaced by a
 * screenshot.
 */

import { expect, test } from "../harness/test";

test.describe("home placeholder", () => {
  test("renders the placeholder and says no product surface exists yet", async ({
    page,
  }) => {
    const response = await page.goto("/");
    expect(response, "GET / returned no response").not.toBeNull();
    expect(response?.status(), "GET / must be 200").toBe(200);

    await expect(
      page.getByRole("heading", { level: 1, name: "Vizra" }),
    ).toBeVisible();
    await expect(
      page.getByText("No product surface is implemented yet"),
    ).toBeVisible();

    // The page must not invent data or claim a working feature (AGENTS.md,
    // "No mock data on a product path").
    await expect(page.getByRole("link", { name: "/health" })).toBeVisible();
  });

  test("hydrates without the page complaining", async ({ page }) => {
    await page.goto("/");
    // Hydration errors surface as console errors and as `pageerror`; the guard
    // fails the test on either. Waiting for the network to settle makes the
    // window in which they can arrive part of the test rather than after it.
    await page.waitForLoadState("networkidle");
    await expect(page.locator("main h1")).toHaveText("Vizra");
  });

  test("the only link on the placeholder reaches the health page", async ({
    page,
  }) => {
    await page.goto("/");
    // An explicit readiness wait before the click. `click()` auto-waits for the
    // link to be actionable, but only for `actionTimeout` (10 s), and an
    // independent verifier saw this click time out once at load averages of
    // 76-92 inside demonstration d11f, which runs the whole lane. Waiting for
    // the network to settle and the link to be visible first moves the wait
    // onto the page load it depends on, where the navigation timeout applies.
    // It asserts nothing new and relaxes nothing: the same link must be there.
    await page.waitForLoadState("networkidle");
    const healthLink = page.getByRole("link", { name: "/health" });
    await expect(healthLink).toBeVisible();
    await healthLink.click();
    await expect(page).toHaveURL(/\/health$/);
    await expect(page.getByTestId("health-status")).toHaveText("ok");
  });

  test("the layout fits the viewport with no horizontal overflow", async ({
    page,
  }, testInfo) => {
    await page.goto("/");
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    // A 390 px project that silently scrolled sideways would be a mobile
    // regression nobody sees in a 1440 px screenshot.
    expect(
      overflow.scrollWidth,
      `the document scrolls horizontally in project ${testInfo.project.name}: ` +
        `scrollWidth ${overflow.scrollWidth} > clientWidth ${overflow.clientWidth}`,
    ).toBeLessThanOrEqual(overflow.clientWidth);
  });
});
