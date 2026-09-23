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
 * source reader asserts the text. So the guarantee moved to the resolved value,
 * whatever spelling produced it (war-room rule R7: guard the effective value,
 * not the text). The source reader in `scripts/ci/check-e2e-lane.mjs` stays as
 * the early warning; it is no longer the control.
 *
 * `screenshot`, `video` and `trace` are WORKER-scoped option fixtures in the
 * installed 1.63.0 (`playwright/lib/index.js:73, :74, :195`), so both harness
 * fixtures can depend on them: `vizraWorkerGuard` checks before the worker's
 * first `beforeAll`, and `vizraHarnessGuard` checks again before every test.
 *
 * WHAT A FAILURE SAYS. The option NAME and what it must be, never the value it
 * was given: an option value is spec-authored text, and it goes into a public
 * job log.
 */

/** Exactly what `playwright.config.ts` sets. Any other resolved value is refused. */
export const LANE_A_RECORDERS = Object.freeze({
  screenshot: "off",
  video: "off",
  trace: Object.freeze({ mode: "retain-on-failure", sources: false, screenshots: false }),
});

export type RecorderName = keyof typeof LANE_A_RECORDERS;

const NAMES: readonly RecorderName[] = ["screenshot", "video", "trace"];

/** A stable serialisation with sorted keys, so key order is not a difference. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.keys(inner as Record<string, unknown>)
            .sort()
            .map((key) => [key, (inner as Record<string, unknown>)[key]]),
        )
      : inner,
  );
}

/**
 * The recorder options whose RESOLVED value differs from `LANE_A_RECORDERS`,
 * by name. An empty list means the lane records no pixels.
 */
export function recorderProblems(resolved: Record<RecorderName, unknown>): RecorderName[] {
  return NAMES.filter((name) => canonical(resolved[name]) !== canonical(LANE_A_RECORDERS[name]));
}

/** The failure message: names and the required values, never the resolved ones. */
export function recorderMessage(names: readonly RecorderName[], where: string): string {
  const required = names.map((name) => `\`${name}\` must be ${canonical(LANE_A_RECORDERS[name])}`).join("; ");
  return (
    `Lane A records NO PIXELS, but ${where} the resolved recorder option(s) ` +
    `${names.map((name) => `\`${name}\``).join(", ")} differ from what playwright.config.ts sets ` +
    `(${required}). A \`test.use({ … })\`, a configuration edit, a CLI flag or a mutated device ` +
    "descriptor changed them. The repositories are public, and a screenshot, a video or a trace " +
    "screencast frame is pixels no redactor or scanner can read. See AGENTS.md § Artifact privacy."
  );
}
