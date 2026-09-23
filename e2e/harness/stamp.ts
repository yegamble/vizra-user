/**
 * PROOF, AT RUNTIME, THAT A TEST WENT THROUGH THE GUARDED HARNESS.
 *
 * THE DEFECT CLASS THIS CLOSES. Three independent verification rounds found
 * three different ways for a spec to run WITHOUT `e2e/harness/test.ts` and go
 * green on a page that 404s a sub-resource and throws on every load:
 *
 *   1. `import * as pw from "@playwright/test"` — a spelling the regex missed;
 *   2. `/* eslint-disable vizra/no-unguarded-playwright-import *​/` — one comment;
 *   3. a spec at `e2e/other/x.spec.ts` — collected by Playwright
 *      (`**​/*.spec.ts` under `e2e/`), linted by neither guard.
 *
 * Each was patched where it was found, and each time the guarantee still rested
 * on LINT: on matching import syntax, or on a list of directories. Lint can
 * always be side-stepped, because the thing it inspects is not the thing that
 * runs.
 *
 * So the control moved to the RUNTIME. Every test the harness runs is stamped,
 * in fixture teardown, with an HMAC over that test's identity. Two checks refuse
 * a run in which a test SUCCEEDED without a valid stamp:
 * `e2e/harness/stamp-reporter.ts` inside the Playwright process, and
 * `scripts/ci/check-coverage-floor-ran.mjs` from outside it, against the
 * finished JSON report. A spec that reaches the raw runner — by any syntax, from
 * any directory, with any lint suppression — produces no stamp and is RED, with
 * its file named.
 *
 * WHERE THE KEY LIVES, AND WHY A SPEC IN A WORKER CANNOT READ IT.
 *
 *   - The Playwright MAIN process mints 32 random bytes at config load and
 *     keeps them in `VIZRA_E2E_STAMP_KEY` so that forked workers inherit them.
 *     NOT CLOSED: `npx playwright test` collects spec files IN the main process
 *     (`InProcessLoaderHost`), after config load, so by reading, a spec's module
 *     scope can read the key there during collection. Whether that is a working
 *     forgery was not established and no probe was built (PR #8 verifier finding
 *     V-D; pre-existing since PR #7). The fix is queued for PR B.
 *   - In a WORKER (`TEST_WORKER_INDEX` is set), this module captures the value
 *     and immediately `delete`s it from `process.env`. That happens while the
 *     configuration is being loaded — `WorkerMain.runTestGroup` calls
 *     `_loadIfNeeded()` (which re-executes `playwright.config.ts`) BEFORE
 *     `loadTestFile`, verified against the installed
 *     `playwright/lib/worker/workerProcessEntry.js` — so no test file has been
 *     evaluated yet and no spec, and no process a spec spawns, ever sees it.
 *   - `claimSigner()` is ONE-SHOT in a worker. `playwright.config.ts` imports
 *     `e2e/harness/test.ts`, which claims it during that same configuration
 *     load. Every later caller — a spec that imports this module by name — gets
 *     a throw, not a signer.
 *   - The reporter writes the key to `.vizra-e2e/stamp-key.json` only in
 *     `onEnd`, after the last test has finished, so the out-of-process check can
 *     verify it while no running spec can read **this run's** key. The FILE is
 *     readable mid-run and a spec can open it — an independent verifier did,
 *     and got 123 bytes. What it gets is the PREVIOUS run's key: the key is
 *     minted fresh by the main process on every run (verified across three
 *     consecutive runs), so a stamp signed with what is on disk does not verify
 *     against the run in progress. On a fresh CI checkout the file does not
 *     exist at all — it is gitignored, no workflow caches it, and it is not in
 *     the artifact upload paths. This bullet used to say "no running spec can
 *     read it", which was false as written; the security property it was
 *     describing holds.
 *
 * WHAT FORGING THE STAMP WOULD TAKE. Honestly, and in full:
 *
 *   a. recovering the 32-byte per-run key from inside a spec — it is not in the
 *      worker's environment, not on disk while any test is running, and not
 *      derivable from anything in the report; it IS in the main process's
 *      environment while spec files are collected there (above); or
 *   b. importing `e2e/harness/stamp` (or the reporter) from a spec and calling
 *      the signer — which `claimSigner()` already refuses in a worker, and which
 *      `vizra/no-unguarded-playwright-import` refuses at lint time as a sealed
 *      module; or
 *   c. editing `e2e/harness/**`, `playwright.config.ts` or `eslint-rules/**`
 *      directly. Those are `.github/CODEOWNERS` paths, `npm run test` fails if
 *      the rule or the wiring is neutered, and the `e2e` lane's canary step
 *      (`scripts/ci/harness-canary.mjs`) turns the lane red if the guard itself
 *      stops failing a broken page.
 *
 * None of those is an accident, and each is a named edit in the diff. That is
 * the honest strength of this control: it converts "a spec can quietly opt out"
 * into "someone has to deliberately disable a gate, in a file whose job is to be
 * a gate". The residual is listed in AGENTS.md rather than hidden here.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import process from "node:process";

/** The annotation type the harness stamps onto every test it runs. */
export const STAMP_ANNOTATION = "vizra-harness-stamp";

/**
 * Where the reporter drops the key for the out-of-process check, AFTER the run.
 * Repository-root-relative. Gitignored, and deliberately not under
 * `test-results/` or `playwright-report/`, which the workflow uploads.
 */
export const STAMP_KEY_FILE = path.join(".vizra-e2e", "stamp-key.json");

const ENV_KEY = "VIZRA_E2E_STAMP_KEY";

/**
 * Bumped whenever the payload shape changes, so an old stamp can never verify
 * against a new identity by coincidence.
 */
const STAMP_VERSION = "v1";

/** The identity a stamp commits to. Every field is available on all three sides. */
export type StampIdentity = {
  /** Playwright project name, e.g. `desktop-chromium-1440`. */
  project: string;
  /** Spec path, POSIX, relative to the config's `rootDir`. */
  file: string;
  /** The test's own title (not the describe path). */
  title: string;
  /** The worker that ran this attempt. */
  workerIndex: number;
  /** The attempt number: 0 for the first, 1 for the first retry. */
  retry: number;
};

export type StampSigner = (identity: StampIdentity) => string;

/**
 * Playwright sets `TEST_WORKER_INDEX` in the worker process constructor, before
 * the configuration or any test file is loaded
 * (`playwright/lib/worker/workerProcessEntry.js`).
 */
const inWorker = process.env.TEST_WORKER_INDEX !== undefined;

let workerKey: Buffer | undefined;
let claimed = false;

if (inWorker) {
  const hex = process.env[ENV_KEY];
  if (hex === undefined || hex === "") {
    // Fail CLOSED and loudly. This means the Playwright main process did not
    // mint a key — i.e. `playwright.config.ts` no longer imports the harness
    // entry — and a silent fallback here would be a signer with no secret.
    throw new Error(
      `${ENV_KEY} is not set in this Playwright worker, so the browser harness cannot ` +
        "prove at runtime that a test went through it. The main process mints the key when " +
        "`playwright.config.ts` imports `./e2e/harness/test`; restore that import. " +
        "This is BLOCKED, not a pass (AGENTS.md).",
    );
  }
  workerKey = Buffer.from(hex, "hex");
  // THE LINE THAT MAKES THE KEY UNREADABLE FROM A SPEC. Test files are loaded
  // after the configuration, so by the time any spec source is evaluated the
  // variable is gone from this process and from every process it spawns.
  delete process.env[ENV_KEY];
} else if (process.env[ENV_KEY] === undefined || process.env[ENV_KEY] === "") {
  // The main process. The value stays in the environment on purpose: that is
  // how forked workers receive it. `scripts/ci/check-e2e-lane.mjs` refuses a
  // workflow that sets it, so CI can never pin it to a known value.
  process.env[ENV_KEY] = randomBytes(32).toString("hex");
}

function mainProcessKey(): Buffer {
  const hex = process.env[ENV_KEY];
  if (hex === undefined || hex === "") {
    throw new Error(`${ENV_KEY} is missing from the Playwright main process.`);
  }
  return Buffer.from(hex, "hex");
}

function sign(key: Buffer, identity: StampIdentity): string {
  return createHmac("sha256", key)
    .update(
      [
        STAMP_VERSION,
        identity.project,
        identity.file,
        identity.title,
        String(identity.workerIndex),
        String(identity.retry),
      ].join("\u0000"),
      "utf8",
    )
    .digest("hex");
}

/**
 * Hand the signer to the harness entry — ONCE per worker.
 *
 * `e2e/harness/test.ts` calls this at module load, and `playwright.config.ts`
 * imports that module, so the claim happens during configuration load, before
 * any test file exists in the worker. A spec that later imports this module and
 * calls `claimSigner()` gets the throw below.
 *
 * In the main process it is not one-shot: Playwright may load the configuration
 * more than once there, no test ever runs there, and the key is in the
 * environment anyway.
 */
export function claimSigner(): StampSigner {
  if (!inWorker) {
    const key = mainProcessKey();
    return (identity) => sign(key, identity);
  }
  if (claimed || workerKey === undefined) {
    throw new Error(
      "the browser harness's stamp key has already been claimed in this worker. " +
        "`e2e/harness/test.ts` claims it while playwright.config.ts is loaded, before any " +
        "test file is evaluated, so this call comes from something that is not the harness " +
        "entry — a spec importing e2e/harness/stamp to sign itself, for example. " +
        "Import { test, expect } from e2e/harness/test.",
    );
  }
  const key = workerKey;
  workerKey = undefined;
  claimed = true;
  return (identity) => sign(key, identity);
}

/**
 * The key, for the reporter (main process only) to verify stamps and to write
 * to `STAMP_KEY_FILE` after the run. Throws in a worker, so a spec cannot reach
 * the key through this door either.
 */
export function reporterKeyHex(): string {
  if (inWorker) {
    throw new Error("the stamp key is not readable from a Playwright worker process.");
  }
  return mainProcessKey().toString("hex");
}

/** Constant-time comparison of a candidate stamp against the expected one. */
export function verifyStamp(keyHex: string, identity: StampIdentity, candidate: unknown): boolean {
  if (typeof candidate !== "string") return false;
  if (!/^[0-9a-f]{64}$/.test(candidate)) return false;
  let key: Buffer;
  try {
    key = Buffer.from(keyHex, "hex");
  } catch {
    return false;
  }
  if (key.length === 0) return false;
  const expected = sign(key, identity);
  try {
    return timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

/** A spec path as all three sides spell it: POSIX, relative to `rootDir`. */
export function specPath(rootDir: string, file: string): string {
  return path.relative(rootDir, file).split(path.sep).join("/");
}

/** True when this process is a Playwright worker. Exported for the harness tests. */
export function runningInWorker(): boolean {
  return inWorker;
}

/** The environment variable name, so tests can assert it is gone. */
export const STAMP_KEY_ENV = ENV_KEY;
