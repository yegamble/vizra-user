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
 * ARTIFACTS. A failing test keeps its TRACE (network, DOM snapshots, console,
 * step log) and `error-context.md`; the workflow publishes them, redacted, on a
 * red lane. NO PIXELS are recorded: `screenshot` and `video` are "off", and the
 * trace records no screencast (`screenshots: false`). The repositories are
 * PUBLIC, and a screenshot of a page is pixels no redactor or scanner can read
 * (security seat, PR B plan review, Q3 and F14). THE CONTROL is at runtime:
 * `e2e/harness/recorders.ts`, called by both harness fixtures, refuses any
 * RESOLVED value other than these three, however it was produced (a second
 * `defineConfig` argument, a later assignment, a mutated device descriptor, a
 * spec's `test.use`). `check-e2e-lane.mjs` reads the literals below as an early
 * warning only. The demos configuration inherits them. What the trace still
 * carries, and the capture APIs a spec can still call, are listed in AGENTS.md
 * § Artifact privacy.
 */

import { defineConfig, devices } from "@playwright/test";

import {
  DESKTOP_PROJECT,
  DESKTOP_VIEWPORT,
  MOBILE_PROJECT,
  MOBILE_VIEWPORT,
} from "./e2e/harness/required-projects";
// LOAD-BEARING SIDE EFFECT, not decoration. This configuration is executed in
// the Playwright main process AND in every worker, before any test file is
// loaded (`WorkerMain.runTestGroup` calls `_loadIfNeeded()` — which re-executes
// this file — before `loadTestFile`). Importing the guarded entry here is what
// lets `e2e/harness/stamp.ts` take the per-run key out of the worker's
// environment, and lets the harness claim the one-shot signer, before a spec
// could do either. Removing this import does not make the lane green on a
// broken page — the stamp reporter still refuses an unstamped pass — but it
// does put the key back within a spec's reach. See e2e/harness/stamp.ts.
import "./e2e/harness/test";

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
  // `./e2e/specs`, NOT `./e2e`. The wider root was a hole an independent
  // verifier walked through: Playwright collected `**​/*.spec.ts` under `e2e/`
  // while both source guards enumerated `e2e/specs` and `e2e/demos`, so a spec
  // at `e2e/other/x.spec.ts` RAN and was linted by nothing — `npm run ci` exit
  // 0, the lane exit 0 with "coverage floor: OK (10/9 10/9)" — on a page that
  // 404s a sub-resource and throws on every load. Narrowing the collection root
  // means such a file is not collected at all, and widening the ESLint glob to
  // `e2e/**` (minus `e2e/harness/**`) means it is refused if anyone writes one.
  // Both halves are demonstrated; neither alone is the control, which is the
  // runtime stamp.
  testDir: "./e2e/specs",
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
    // The runtime proof of harness: every test that SUCCEEDED must carry the
    // stamp `e2e/harness/test.ts` writes, verified against this run's key. A
    // spec that reached `@playwright/test` directly — by any syntax, from any
    // directory, with any lint suppression — has no stamp and turns the run red,
    // with its file named. `scripts/ci/check-coverage-floor-ran.mjs` re-checks
    // the same stamps from the finished report, so deleting this line from the
    // array does not remove the control.
    ["./e2e/harness/stamp-reporter.ts"],
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
    //
    // NO PIXELS. `screenshots: false` stops the trace's screencast frames;
    // `screenshot` and `video` "off" stop the per-test PNG and WebM. Measured on
    // a failing demo before this change: 2 PNGs, 2 WebMs, and 3 + 2 screencast
    // frames inside the two traces; after it, none of the three. The harness
    // refuses any other RESOLVED value at runtime; the lane guard warns early
    // on another literal here, and on a project that sets one of these keys.
    trace: { mode: "retain-on-failure", sources: false, screenshots: false },
    screenshot: "off",
    video: "off",
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
