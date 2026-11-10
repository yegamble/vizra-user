/**
 * LANE A RECORDS NO PIXELS — checked on the RESOLVED option values, at runtime.
 *
 * `playwright.config.ts` sets `screenshot: "off"`, `video: "off"` and a trace
 * without screencast frames, because the repositories are public and a
 * screenshot, a video or a screencast frame is pixels that no redactor or
 * scanner can read (security seat, PR B plan review, Q3 and F14).
 *
 * WHY AT RUNTIME. The first version of this control read the configuration's
 * SOURCE, and an independent verifier turned every recorder back on with that
 * reader green, by six routes: a second `defineConfig` argument, an assignment
 * to `config.use` after the declaration, `Object.assign` on the imported
 * `base.use` in the demos configuration, mutating a `devices[…]` descriptor
 * from a module the configuration imports, one `test.use({ … })` line in a spec,
 * and a second configuration file named by the canary script (PR #10 VERIFY,
 * E1–E6 and S6). Every one of them changes the value Playwright RESOLVES, and a
 * source reader asserts the text. So this checks the resolved value (war-room
 * rule R7: guard the effective value, not the text). The source reader in
 * `scripts/ci/check-e2e-lane.mjs` stays as the early warning.
 *
 * `screenshot`, `video` and `trace` are WORKER-scoped option fixtures in the
 * installed 1.63.0 (`playwright/lib/index.js:73, :74, :195`), so both harness
 * fixtures can depend on them: `vizraWorkerGuard` checks before the worker's
 * first `beforeAll`, and `vizraHarnessGuard` checks again before every test.
 *
 * WHAT A FAILURE SAYS. The option NAME and what it must be, never the value it
 * was given: an option value is spec-authored text, and it goes into a public
 * job log.
 *
 * WHAT THIS CHECK IS, AND IS NOT (PR #10 fix round 2; allowlist round). It is
 * an EARLY control: it fails the lane by name before a page exists. An option
 * value is an object the spec may construct, and the first version of this check
 * compared `JSON.stringify(value)`, which an object with a `toJSON()` (N1) or
 * with getters that answer differently to the check (N2) satisfied while
 * Playwright read `.mode` = "on" and recorded. So a value is now accepted only if
 * it is a primitive string, or a PLAIN object: prototype exactly
 * `Object.prototype`, not a Proxy, own keys exactly the literal's, every one an
 * enumerable DATA property (no getter or setter), no `toJSON`, no symbol key. It
 * is then compared field by field with `===`, never serialised. The intrinsics it
 * uses are captured when this module loads, which in a worker is while
 * `playwright.config.ts` is loaded, before any spec.
 *
 * THE CONTEXT OPTIONS TOO (war-room rule R7, sentinel F-2). `contextOptions` is
 * merged into every context a test creates (`_combinedContextOptions`,
 * `playwright/lib/index.js:264-345`, copied into each `newContext` by
 * `runBeforeCreateBrowserContext`), so one `test.use({ contextOptions: {
 * recordHar } })` recorded a HAR whatever `video` said. The TEST-scoped fixture
 * passes that EFFECTIVE value here as `contextOptions`; it must be a plain object
 * with no own `recordHar` or `recordVideo`, and `Object.prototype` must carry
 * neither (an inherited key reaches Playwright's read of the merged options).
 *
 * What still WRITES pixels or page data on the runner past this check, and is
 * unpublished only because the upload gate stages one file and nothing else: a
 * spec that leaves the harness, `page.screenshot`, `browser.startTracing`,
 * `context.tracing.start/stop({ path })`, `routeFromHAR(…, { update: true })`,
 * and `browser.newContext({ recordHar | recordVideo })` in a spec. Code a spec
 * runs can also subvert the runtime this check runs in (residual R-1's class,
 * AGENTS.md). The control for the PUBLISHED artifact is
 * `scripts/ci/redact-artifacts.sh`: it stages only `playwright-report/results.json`
 * and checks those bytes (AGENTS.md § Artifact privacy).
 */

import { types as nodeUtilTypes } from "node:util";

/** Exactly what `playwright.config.ts` sets. Any other resolved value is refused. */
export const LANE_A_RECORDERS = Object.freeze({
  screenshot: "off",
  video: "off",
  trace: Object.freeze({ mode: "retain-on-failure", sources: false, screenshots: false }),
});

export type RecorderName = keyof typeof LANE_A_RECORDERS | "contextOptions";

const NAMES: readonly (keyof typeof LANE_A_RECORDERS)[] = ["screenshot", "video", "trace"];

/** Context options that record the page, refused in the effective `contextOptions`. */
const RECORDING_CONTEXT_KEYS: readonly string[] = ["recordHar", "recordVideo"];

// Captured at module load, before any spec code exists in this process.
const isProxy = nodeUtilTypes.isProxy;
const getPrototypeOf = Object.getPrototypeOf;
const ownKeys = Reflect.ownKeys;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectPrototype = Object.prototype;
const hasOwn = Object.prototype.hasOwnProperty;

/**
 * Is `value` exactly `expected`? A primitive is compared with `===`. An object
 * literal expectation accepts only a plain, non-Proxy object whose own keys are
 * exactly the expected keys, each an enumerable data property whose value is
 * `===` the expected one. Nothing on the candidate is CALLED: no `toJSON`, no
 * getter, no method.
 */
function matches(value: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== "object") return value === expected;
  if (value === null || typeof value !== "object") return false;
  if (isProxy(value)) return false;
  if (getPrototypeOf(value) !== objectPrototype) return false;
  const keys = ownKeys(value);
  const wanted = ownKeys(expected as object);
  if (keys.length !== wanted.length) return false;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    let known = false;
    for (let at = 0; at < wanted.length; at += 1) if (wanted[at] === key) known = true;
    if (typeof key !== "string" || !known) return false;
    const descriptor = getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) return false;
    if (descriptor.value !== (expected as Record<string, unknown>)[key]) return false;
  }
  return true;
}

/**
 * Does the EFFECTIVE context options value record anything? It must be a plain,
 * non-Proxy object with no own `recordHar`/`recordVideo` (of any descriptor
 * kind), and `Object.prototype` must carry neither. Nothing on it is called.
 */
function contextOptionsRecord(value: unknown): boolean {
  if (value === undefined) return false;
  if (value === null || typeof value !== "object") return true;
  if (isProxy(value)) return true;
  if (getPrototypeOf(value) !== objectPrototype) return true;
  for (let index = 0; index < RECORDING_CONTEXT_KEYS.length; index += 1) {
    const key = RECORDING_CONTEXT_KEYS[index] as string;
    if (getOwnPropertyDescriptor(value, key) !== undefined) return true;
    if (getOwnPropertyDescriptor(objectPrototype, key) !== undefined) return true;
  }
  return false;
}

/**
 * The recorder options whose RESOLVED value is not exactly `LANE_A_RECORDERS`,
 * by name, plus `contextOptions` when the effective context options (passed
 * only by the test-scoped fixture) would record. An empty list means the lane is
 * configured to record no pixels.
 */
export function recorderProblems(
  resolved: Record<keyof typeof LANE_A_RECORDERS, unknown> & { contextOptions?: unknown },
): RecorderName[] {
  // A plain loop, not `Array.prototype.filter`: nothing a spec could patch on a
  // shared prototype sits between the check and its answer.
  const problems: RecorderName[] = [];
  for (let index = 0; index < NAMES.length; index += 1) {
    const name = NAMES[index] as keyof typeof LANE_A_RECORDERS;
    if (!matches(resolved[name], LANE_A_RECORDERS[name])) problems[problems.length] = name;
  }
  if (hasOwn.call(resolved, "contextOptions") && contextOptionsRecord(resolved.contextOptions)) {
    problems[problems.length] = "contextOptions";
  }
  return problems;
}

/** How the required value is written in a message: fixed text, from the literal. */
const REQUIRED: Record<RecorderName, string> = {
  screenshot: '"off"',
  video: '"off"',
  trace: '{ mode: "retain-on-failure", sources: false, screenshots: false }, as a plain object',
  contextOptions: "a plain object with no `recordHar` and no `recordVideo`",
};

/** The failure message: names and the required values, never the resolved ones. */
export function recorderMessage(names: readonly RecorderName[], where: string): string {
  const required = names.map((name) => `\`${name}\` must be ${REQUIRED[name]}`).join("; ");
  return (
    `Lane A records NO PIXELS, but ${where} the resolved recorder option(s) ` +
    `${names.map((name) => `\`${name}\``).join(", ")} are not exactly what playwright.config.ts sets ` +
    `(${required}). A \`test.use({ … })\`, a configuration edit, a CLI flag or a mutated device ` +
    "descriptor changed them, or supplied a value that is not a plain literal (a getter, a " +
    "`toJSON`, a Proxy or a class instance is refused whatever it reports). The repositories are " +
    "public, and a screenshot, a video, a trace screencast frame or a HAR body is page content no " +
    "redactor or scanner can read. See AGENTS.md § Artifact privacy."
  );
}
