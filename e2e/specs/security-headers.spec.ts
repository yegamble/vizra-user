/**
 * The security response headers, read off the PRODUCTION server's real
 * responses (war-room queue row 5; the definition is lib/security/headers.ts).
 *
 * `lib/security/headers.test.ts` proves what the policy SAYS. This proves the
 * two things only a browser can: that the running build actually SENDS it on
 * a document, and that the browser actually ENFORCES it — an inline script
 * without the request's nonce does not run. A policy that is present but
 * report-only, or present but satisfied by everything, fails the second test.
 *
 * No request here carries identity and nothing is typed into a page.
 */

import { expect, test } from "../harness/test";

const ROUTES = ["/", "/health"] as const;

function nonceOf(policy: string | undefined): string | undefined {
  return /script-src [^;]*'nonce-([^']+)'/.exec(policy ?? "")?.[1];
}

test.describe("security headers on the production build", () => {
  for (const route of ROUTES) {
    test(`${route} is served with the enforcing policy and the static headers`, async ({
      page,
    }) => {
      const response = await page.goto(route);
      expect(response?.status(), `GET ${route} must be 200`).toBe(200);
      const headers = response?.headers() ?? {};

      const policy = headers["content-security-policy"];
      expect(policy, "no Content-Security-Policy header").toBeDefined();
      expect(
        headers["content-security-policy-report-only"],
        "the policy must be enforcing, not report-only",
      ).toBeUndefined();

      const scriptSrc = /(?:^|; )script-src ([^;]*)/.exec(policy ?? "")?.[1] ?? "";
      expect(scriptSrc).toMatch(/^'self' 'nonce-[A-Za-z0-9+/]{22}==' 'strict-dynamic'$/);
      expect(policy, "no unsafe-* source anywhere in a production policy").not.toMatch(/unsafe-/);
      expect(policy).toMatch(/(?:^|; )frame-ancestors 'none'(?:;|$)/);
      expect(policy).toMatch(/(?:^|; )default-src 'self'(?:;|$)/);
      expect(policy).toMatch(/(?:^|; )object-src 'none'(?:;|$)/);
      expect(policy).toMatch(/(?:^|; )base-uri 'self'(?:;|$)/);

      expect(headers["x-content-type-options"]).toBe("nosniff");
      expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
      expect(headers["permissions-policy"]).toMatch(/camera=\(\).*geolocation=\(\).*microphone=\(\)/);
      expect(headers["x-powered-by"], "the framework must not be advertised").toBeUndefined();

      // Every script element the server rendered carries THIS response's
      // nonce. (Browsers hide the attribute's content from selectors, so read
      // the property.)
      const nonce = nonceOf(policy);
      const scriptNonces = await page.evaluate(() =>
        Array.from(document.querySelectorAll("script"), (script) => script.nonce),
      );
      expect(scriptNonces.length, "the page rendered no script at all").toBeGreaterThan(0);
      expect(new Set(scriptNonces)).toEqual(new Set([nonce]));
    });
  }

  test("the nonce is different on every response", async ({ page }) => {
    const first = nonceOf((await page.goto("/"))?.headers()["content-security-policy"]);
    const second = nonceOf((await page.goto("/"))?.headers()["content-security-policy"]);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first).not.toBe(second);
  });

  test("a static asset is served nosniff too", async ({ page }) => {
    const stylesheet = page.waitForResponse(
      (response) => new URL(response.url()).pathname.startsWith("/_next/static/") &&
        response.url().endsWith(".css"),
    );
    await page.goto("/");
    const headers = (await stylesheet).headers();
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["content-type"]).toMatch(/^text\/css/);
  });
});

test.describe("the policy is enforced, not merely sent", () => {
  test.use({
    browserErrorPolicy: {
      allow: [
        {
          kind: "console",
          match: /Content Security Policy directive[\s\S]*script-src/,
          reason:
            "VZ-DESIGN-001 / queue row 5 negative test: this test injects an inline script " +
            "WITHOUT the nonce to prove the browser refuses it. The refusal is reported as " +
            "this console error; it is the expected outcome, not a defect in the page.",
        },
      ],
    },
  });

  test("an inline script without the nonce does not run", async ({ page }) => {
    const response = await page.goto("/");
    await page.waitForLoadState("networkidle");
    const nonce = nonceOf(response?.headers()["content-security-policy"]);
    expect(nonce, "the response carried no script nonce").toBeDefined();

    // The markup is PARSED, which is how injected HTML reaches a page: a
    // `srcdoc` frame inherits this document's policy and its scripts are
    // parser-inserted. (A script element built with `createElement` is the
    // wrong probe: under `'strict-dynamic'` Chromium runs it, by design, as a
    // script loaded by trusted code.) Two scripts go in: one without the
    // nonce, which must not run, and one with this response's nonce, which
    // must — the control that proves the frame executes scripts at all and
    // that the flag would have been visible had the first one run.
    const outcome = await page.evaluate(
      (responseNonce) =>
        new Promise<{ plainRan: boolean; noncedRan: boolean }>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("the probe frame did not load within 5 s")), 5_000);
          const frame = document.createElement("iframe");
          frame.title = "CSP probe";
          frame.srcdoc =
            "<script>parent.__vizraInjected = true;</scr" + "ipt>" +
            `<script nonce="${responseNonce}">parent.__vizraControl = true;</scr` + "ipt>";
          frame.addEventListener("load", () => {
            clearTimeout(timer);
            resolve({
              plainRan: "__vizraInjected" in window,
              noncedRan: "__vizraControl" in window,
            });
          });
          document.body.appendChild(frame);
        }),
      nonce ?? "",
    );

    expect(outcome.noncedRan, "the control script WITH the nonce did not run: the probe proves nothing").toBe(true);
    expect(outcome.plainRan, "the injected inline script without the nonce executed").toBe(false);
  });
});
