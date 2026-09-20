/**
 * `/health` in a real browser.
 *
 * `lib/health.test.ts` already asserts the payload shape in vitest. This adds
 * the two things a unit test cannot: the production server actually renders the
 * route per request, and it does so without the page erroring.
 *
 * It also pins the route's honesty. `app/health/page.tsx` is LIVENESS ONLY and
 * says so in prose; the assertions below fail if that page ever starts claiming
 * readiness or leaking build metadata to an anonymous visitor.
 */

import { expect, test } from "../harness/test";

test.describe("health page", () => {
  test("reports liveness for vizra-user", async ({ page }) => {
    const response = await page.goto("/health");
    expect(response?.status(), "GET /health must be 200").toBe(200);

    await expect(page.getByTestId("health-status")).toHaveText("ok");
    await expect(page.getByTestId("health-service")).toHaveText("vizra-user");
    await expect(page.getByTestId("health-scope")).toHaveText("liveness");
  });

  test("does not claim readiness and leaks no build metadata", async ({
    page,
  }) => {
    await page.goto("/health");
    const body = (await page.locator("body").innerText()).toLowerCase();

    // Liveness is not readiness: this process knows nothing about vizra-core,
    // PostgreSQL, the cache or storage, and the page must not imply otherwise.
    // The word boundary matters — the page legitimately points at core's
    // `/readyz`, and `readyz` is not a claim of readiness.
    expect(body).toContain("liveness only");
    expect(body, "the liveness page must not claim readiness").not.toMatch(
      /\bready\b/,
    );
    expect(
      body,
      "the liveness page must not report dependency health",
    ).not.toMatch(
      /\b(postgres|postgresql|database|redis|valkey|storage)\b.*\b(ok|healthy|up)\b/,
    );

    // The route is unauthenticated. An anonymous visitor has no reason to learn
    // the build (lib/health.ts states this as a decision; this asserts it).
    expect(body).not.toMatch(/\b(commit|revision|build id|version)\b/);
  });

  test("is rendered per request rather than served from a build-time cache", async ({
    page,
  }) => {
    // `export const dynamic = "force-dynamic"` exists so a wedged process
    // cannot answer "ok" from a prerender. A prerendered copy would be
    // advertised as cacheable; a per-request render must not be.
    const response = await page.goto("/health");
    const headers = response?.headers() ?? {};
    expect(
      headers["x-nextjs-prerender"],
      "/health must not be prerendered",
    ).toBeUndefined();
    expect(
      headers["cache-control"] ?? "",
      "/health must not be publicly cacheable",
    ).not.toMatch(/max-age=[1-9]/);
  });
});
