/**
 * The application shell (VZ-DESIGN-001) on the production build, at 1440 px
 * and 390 px: landmarks, the skip link as a working control, the wordmark as
 * navigation, and the tokens resolving in light and in dark.
 *
 * Signed-out only, because that is all there is: the shell has no session
 * awareness yet and this spec does not create one.
 */

import { expect, test } from "../harness/test";

test.describe("app shell", () => {
  test("has one banner, one main, and the skip link first in the document", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("banner")).toHaveCount(1);
    await expect(page.getByRole("main")).toHaveCount(1);
    await expect(page.locator("main#content")).toHaveCount(1);

    const first = page.locator("body a").first();
    await expect(first).toHaveText("SENTINEL-abcPW");
    await expect(first).toHaveAttribute("href", "#content");
  });

  test("the skip link is the first Tab stop, becomes visible, and moves focus to main", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    const skip = page.getByRole("link", { name: "Skip to content" });

    await page.keyboard.press("Tab");
    await expect(skip).toBeFocused();

    // Visible when focused, inside the viewport, and at least 44 px tall.
    const box = await skip.boundingBox();
    expect(box, "the focused skip link has no box").not.toBeNull();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
    expect(box?.width ?? 0).toBeGreaterThan(44);

    // The designed focus ring: 2px solid, offset 2px, in the focus-ring token.
    const ring = await skip.evaluate((element) => {
      const style = getComputedStyle(element);
      const token = getComputedStyle(document.documentElement).getPropertyValue("--vz-focus-ring").trim();
      const probe = document.createElement("span");
      probe.style.color = token;
      document.body.appendChild(probe);
      const tokenColor = getComputedStyle(probe).color;
      probe.remove();
      return {
        style: style.outlineStyle,
        width: style.outlineWidth,
        offset: style.outlineOffset,
        color: style.outlineColor,
        tokenColor,
      };
    });
    expect(ring.style).toBe("solid");
    expect(ring.width).toBe("2px");
    expect(ring.offset).toBe("2px");
    expect(ring.color).toBe(ring.tokenColor);

    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#content$/);
    await expect(page.locator("main#content")).toBeFocused();
  });

  test("the wordmark is a link home with a 44 px target", async ({ page }) => {
    await page.goto("/health");
    await page.waitForLoadState("networkidle");
    const wordmark = page.getByRole("banner").getByRole("link", { name: "Vizra" });
    await expect(wordmark).toBeVisible();
    expect((await wordmark.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);

    await wordmark.click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { level: 1, name: "Vizra" })).toBeVisible();
  });

  test("the shell offers no control whose destination does not exist", async ({ page }) => {
    await page.goto("/");
    const banner = page.getByRole("banner");
    await expect(banner.getByRole("link")).toHaveCount(1);
    await expect(banner.getByRole("button")).toHaveCount(0);
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`tokens resolve to the ${scheme} palette when the system prefers ${scheme}`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto("/");
      const seen = await page.evaluate(() => {
        const root = getComputedStyle(document.documentElement);
        const body = getComputedStyle(document.body);
        return {
          bgToken: root.getPropertyValue("--vz-bg").trim(),
          inkToken: root.getPropertyValue("--vz-ink").trim(),
          bodyBackground: body.backgroundColor,
          bodyColor: body.color,
          bodyFontSize: body.fontSize,
          h1FontSize: getComputedStyle(document.querySelector("h1") as Element).fontSize,
          fontFamily: body.fontFamily,
        };
      });
      const expected =
        scheme === "light"
          ? { bg: "#f9fafc", ink: "#0e1218", bodyBackground: "rgb(249, 250, 252)", bodyColor: "rgb(14, 18, 24)" }
          : { bg: "#0d0f15", ink: "#f4f5f8", bodyBackground: "rgb(13, 15, 21)", bodyColor: "rgb(244, 245, 248)" };
      expect(seen.bgToken).toBe(expected.bg);
      expect(seen.inkToken).toBe(expected.ink);
      expect(seen.bodyBackground).toBe(expected.bodyBackground);
      expect(seen.bodyColor).toBe(expected.bodyColor);
      // text/Body 15px and text/Display 32px, through the Tailwind theme.
      expect(seen.bodyFontSize).toBe("15px");
      expect(seen.h1FontSize).toBe("32px");
      expect(seen.fontFamily).toMatch(/^system-ui/);
      expect(seen.fontFamily).not.toMatch(/SF Pro|-apple-system|BlinkMacSystemFont/);
    });
  }

  test("an explicit data-theme overrides the system preference in both directions", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/");
    const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(await background()).toBe("rgb(13, 15, 21)");
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
    expect(await background()).toBe("rgb(249, 250, 252)");
    await page.emulateMedia({ colorScheme: "light" });
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    expect(await background()).toBe("rgb(13, 15, 21)");
  });
});
