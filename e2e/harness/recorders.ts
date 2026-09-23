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
 * WHAT THIS CHECK IS, AND IS NOT (PR #10 fix round 2). It is the EARLY control:
 * it fails the lane by name before a page exists. It is NOT the control that
 * holds regardless: an option value is an object the spec may construct, and the
 * first version of this check compared `JSON.stringify(value)`, which an object
 * with a `toJSON()` (N1) or with getters that answer differently to the check
 * (N2) satisfied while Playwright read `.mode` = "on" and recorded. So a value is
 * now accepted only if it is a primitive string, or a PLAIN object: prototype
 * exactly `Object.prototype`, not a Proxy, own keys exactly the literal's, every
 * one an enumerable DATA property (no getter or setter), no `toJSON`, no symbol
 * key. It is then compared field by field with `===`, never serialised. The
 * intrinsics it uses are captured when this module loads, which in a worker is
 * while `playwright.config.ts` is loaded, before any spec. Code a spec runs can
 * still subvert the runtime this check runs in (that is residual R-1's class,
 * stated in AGENTS.md), which is why the control that holds regardless is the
 * upload gate: `scripts/ci/redact-artifacts.sh` refuses any image or video in
 * what would be uploaded.
 */

import { types as nodeUtilTypes } from "node:util";

/** Exactly what `playwright.config.ts` sets. Any other resolved value is refused. */
export const LANE_A_RECORDERS = Object.freeze({
  screenshot: "off",
  video: "off",
  trace: Object.freeze({ mode: "retain-on-failure", sources: false, screenshots: false }),
});

export type RecorderName = keyof typeof LANE_A_RECORDERS;

const NAMES: readonly RecorderName[] = ["screenshot", "video", "trace"];

// Captured at module load, before any spec code exists in this process.
const isProxy = nodeUtilTypes.isProxy;
const getPrototypeOf = Object.getPrototypeOf;
const ownKeys = Reflect.ownKeys;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectPrototype = Object.prototype;

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
 * The recorder options whose RESOLVED value is not exactly `LANE_A_RECORDERS`,
 * by name. An empty list means the lane is configured to record no pixels.
 */
export function recorderProblems(resolved: Record<RecorderName, unknown>): RecorderName[] {
  // A plain loop, not `Array.prototype.filter`: nothing a spec could patch on a
  // shared prototype sits between the check and its answer.
  const problems: RecorderName[] = [];
  for (let index = 0; index < NAMES.length; index += 1) {
    const name = NAMES[index] as RecorderName;
    if (!matches(resolved[name], LANE_A_RECORDERS[name])) problems[problems.length] = name;
  }
  return problems;
}

/** How the required value is written in a message: fixed text, from the literal. */
const REQUIRED: Record<RecorderName, string> = {
  screenshot: '"off"',
  video: '"off"',
  trace: '{ mode: "retain-on-failure", sources: false, screenshots: false }, as a plain object',
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
    "public, and a screenshot, a video or a trace screencast frame is pixels no redactor or " +
    "scanner can read. See AGENTS.md § Artifact privacy."
  );
}
