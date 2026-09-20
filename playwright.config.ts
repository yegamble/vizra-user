/**
 * The browser lane (VZ-FOUND-008).
 *
 * WHAT IT DRIVES. Always a PRODUCTION build, never `next dev`:
 *
 *   - in CI, the built Docker image — the `e2e` workflow builds the same
 *     Dockerfile the release builds, runs the container, and points
 *     `E2E_BASE_URL` at it;
 *   - locally, `scripts/e2e/serve-production.mjs`, which assembles and runs the
 *     standalone server exactly as the image's `CMD` does.
 *
 * `e2e/specs/production-build.spec.ts` then ASSERTS that whatever answered is a
 * production build, on five independent markers, so a mistake here is a red
 * lane rather than a quietly wrong one.
 *
 * PROJECTS. Two, both Chromium, at the two viewports ADR-009 and
 * `docs/DESIGN_BRIEF.md` name: 1440 px desktop and 390 px mobile. The mobile
 * project also carries touch/mobile emulation, so it is a phone rather than a
 * narrow desktop window. Coverage is Chromium-only and is labelled as such —
 * the VZ-FOUND-008 ledger entry's negative case is exactly "Chromium-only
 * coverage is labelled as such; Safari not claimed", and nothing here claims
 * WebKit or Firefox.
 *
 * ARTIFACTS. Trace, screenshot and video are retained on failure and published
 * by the workflow, together with the HTML report. They are what makes a red
 * lane diagnosable from the run page alone.
 */

import { defineConfig, devices } from "@playwright/test";

import {
  DESKTOP_PROJECT,
  DESKTOP_VIEWPORT,
  MOBILE_PROJECT,
  MOBILE_VIEWPORT,
} from "./e2e/harness/required-projects";

/**
 * Where the harness points.
 *
 * `E2E_BASE_URL` set  → drive that origin and start no server (CI: the container).
 * `E2E_BASE_URL` unset → start the local production server on `E2E_LOCAL_PORT`.
 */
const externalBaseUrl = process.env.E2E_BASE_URL?.trim();
const localPort = Number(process.env.E2E_LOCAL_PORT ?? 3210);
const baseURL = externalBaseUrl && externalBaseUrl !== "" ? externalBaseUrl : `http://127.0.0.1:${localPort}`;

export default defineConfig({
  testDir: "./e2e",
  // The lane collects `*.spec.ts` ONLY. The fault-injection demonstrations live
  // in `e2e/demos/*.demo.ts` and are designed to FAIL; they are run by
  // `playwright.demos.config.ts` and must never enter this selection.
  testMatch: "**/*.spec.ts",

  fullyParallel: true,
  // A stray `.only` would silently shrink the lane to one test. In CI that is a
  // hard error; the coverage floor would catch it too, and both is correct.
  forbidOnly: !!process.env.CI,
  // A test that passes only on retry is not a pass for a gate.
  failOnFlakyTests: true,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,

  // 10 s of slack over the app's own API deadline (lib/config.ts:
  // DEFAULT_API_TIMEOUT_MS = 10 s), so a hung upstream shows up as the app's
  // real failure state rather than as a Playwright timeout.
  timeout: 30_000,
  expect: { timeout: 10_000 },

  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
    ["json", { outputFile: "playwright-report/results.json" }],
    // The floor: required projects must exist and must actually run tests.
    ["./e2e/harness/coverage-reporter.ts"],
  ],
  outputDir: "test-results",

  use: {
    baseURL,
    // `sources: false` keeps the SPEC'S OWN SOURCE out of the trace. The trace
    // is published as a CI artifact; the spec source is already in the
    // repository, so embedding it adds nothing to a debugging session and does
    // add a second copy of whatever a spec happens to contain. The D9
    // demonstration found the sentinel signature value surviving into
    // `src/<sha>.ts` inside trace.zip for exactly that reason — the redactor
    // rewrites URLs, and a bare constant in a spec is not a URL.
    trace: { mode: "retain-on-failure", sources: false },
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    // Bound every action, so a wedged page fails the lane instead of burning
    // the job's whole timeout.
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },

  projects: [
    {
      name: DESKTOP_PROJECT,
      use: { ...devices["Desktop Chrome"], viewport: DESKTOP_VIEWPORT },
    },
    {
      name: MOBILE_PROJECT,
      // Pixel 5 is a 393x851 Chromium phone profile; the viewport is overridden
      // to the 390 px the design brief names, keeping the touch/mobile/UA half
      // of the emulation.
      use: { ...devices["Pixel 5"], viewport: MOBILE_VIEWPORT },
    },
  ],

  // No `webServer` when an external base URL is given: CI owns the container's
  // lifecycle, and starting a second server here would silently test the wrong
  // thing if the URL were ever wrong.
  webServer: externalBaseUrl
    ? undefined
    : {
        command: `node scripts/e2e/serve-production.mjs --port ${localPort}`,
        url: `http://127.0.0.1:${localPort}/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          // Sentinel values: this lane exercises the frontend's own rendering,
          // and there is no vizra-core to talk to yet. They are recognisably
          // invalid so that a page which started depending on a real API would
          // fail visibly rather than appear to work.
          INTERNAL_API_BASE_URL: process.env.INTERNAL_API_BASE_URL ?? "http://api.sentinel.invalid:8080",
          PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN ?? `http://127.0.0.1:${localPort}`,
          NEXT_TELEMETRY_DISABLED: "1",
          NODE_ENV: "production",
        },
      },
});
