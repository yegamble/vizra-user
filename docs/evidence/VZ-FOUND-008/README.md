# VZ-FOUND-008 — browser test environment against the production build

Evidence for `vizra-user` PR3, branch `feat/m0-browser-env`, base `1a952b5`.
Issue: yegamble/vizra#1 (VZ-ISSUE-001). Execution plan (meta repo):
`docs/plans/2026-09-20-vizra-user-pr3-browser-env.md`.

**Status: READY_FOR_REVIEW.** Not VERIFIED — no ledger entry reaches VERIFIED on
a builder's own evidence. This is **fix round 1 of 2** after an independent
verifier returned FAIL on `112291e` with two blocking findings and three more.

## Environment
See `environment.txt` (machine-written). Darwin arm64, Node v22.14.0,
Playwright 1.63.0, Chromium `chromium-1243` / `chromium_headless_shell-1243`
(Chrome for Testing 153.0.8010.12), ffmpeg `ffmpeg-1011` — `browser-revision.txt`.

**Platform caveat.** These transcripts come from the owner's **arm64** machine,
which ADR-009 says is not the acceptance platform. The acceptance platform is
GitHub-hosted `ubuntu-24.04`, linux/amd64, and the `e2e` lane runs there on
every pull request. The local image built and driven below is a native arm64
build with no support claim. **CI on the head SHA is the platform evidence.**

## Reproduce
```
npm ci
npm run e2e:install
INTERNAL_API_BASE_URL=http://api.sentinel.invalid:8080 \
  PUBLIC_ORIGIN=http://127.0.0.1:3211 npm run build
npm run e2e          # the lane, against the local standalone production server
npm run e2e:demos    # every transcript in this directory, regenerated
```
`npm run e2e:demos` fails if any RED half passes or any GREEN half fails.

## What the verifier found, and what changed

| Finding | Severity | Closed by | Demonstrated |
|---|---|---|---|
| 1 — a spec bypasses the browser-error guard with `import * as pw` or single quotes; the whole gate went green on a page that 404s and throws | BLOCKER | the ESLint rule `vizra/no-unguarded-playwright-import` (AST, not regex), plus `/e2e/specs/` and `/e2e/demos/` in CODEOWNERS | **D8**, eight halves |
| 2 — `check-e2e-lane.sh` never asserted the step that runs Playwright; deleting or echo-replacing it left the guard OK and the `e2e` check green | BLOCKER | the guard now PARSES the workflow (`scripts/ci/check-e2e-lane.mjs`) and asserts the step graph | **D7**, eight halves, plus 13 cases in `require-checks_test.sh` |
| 3 — the coverage floor was 1 per project, so `--grep` ran one test and reported OK | SHOULD | minima moved to `e2e/harness/required-projects.json` at today's counts (9/9), filtered runs refused, and the floor re-checked from the report by a separate CI step | **D4c, D4c2, D4d** |
| 4 — a `?X-Amz-Signature=…` value was redacted in every harness line and present verbatim inside uploaded `trace.zip` members | REQUIRED | `scripts/ci/redact-artifacts.sh` runs before upload; `trace.sources` disabled | **D9** |
| 5 — the `if: failure()` upload had never executed and `if-no-files-found: warn` would hide a wrong path | NIT | `if-no-files-found: error`; the path proved on a throwaway PR (see `ci-artifact-proof.md`) | see that file |

## The lane
| File | What it shows |
|---|---|
| `gate-local-npm-run-ci.txt` | `npm run ci` — exit 0; vitest **9 files / 206 tests**, 0 skipped |
| `lane-against-built-image-local.txt` | `npm run e2e` against the **built Docker image** (arm64, local): 18 passed, `coverage floor: OK (desktop=9/9 mobile=9/9)`, and the out-of-process floor guard exit 0 |
| `browser-revision.txt` | the exact browser build the harness resolved |
| `server-production.log`, `server-development.log` | the two servers the demonstrations drove |

## The demonstrations
Red against a controlled mutation, green when restored. Summary of the run that
produced these files: `demonstrate-summary.txt` — **39 halves passed, 0 blocked,
0 failed.**

| # | Requirement | Transcripts |
|---|---|---|
| D1 | `console.error` fails the lane | `d1-console-error-{RED,GREEN}.txt` |
| D2 | a 404 sub-resource fails the lane | `d2-failed-request-{RED,GREEN}.txt` |
| D3 | an uncaught exception fails the lane | `d3-uncaught-exception-{RED,GREEN}.txt` |
| D4a | zero tests collected fails | `d4a-zero-tests-{RED,GREEN}.txt` |
| D4b | a missing project fails | `d4b-missing-project-{RED,GREEN}.txt` |
| D4c | **deleting one test** drops a project below its floor | `d4c-floor-shortfall-{RED,GREEN}.txt` |
| D4c2 | **adding** a test without raising the floor stays green (a floor is a minimum) | `d4c2-floor-is-a-minimum-GREEN.txt` |
| D4d | the lane **refuses a filtered run** (the verifier's `--grep "reports liveness"`) | `d4d-filtered-run-{RED,GREEN}.txt` |
| D5 | pointing at `next dev` fails | `d5-dev-server-{RED,GREEN}.txt` |
| D6 | the built image carries no harness file or fixture token | `d6-image-fixtures-{RED,GREEN}.txt` |
| D7 | a weakened `e2e` workflow fails the lane guard — **step deleted, echo-replaced, `\|\| true`, `if: false`**, artifacts removed, `if-no-files-found: warn`, floor step removed | `d7-*.txt` (8) |
| D8 | a spec reaching the unguarded `test` fails the gate — **namespace, single quotes, dynamic `import()`, `require`, a re-export shim**, and the whole `npm run lint` | `d8-*.txt` (8) |
| D9 | a signed-URL-shaped query string does not reach an uploaded artifact | `d9-artifact-leak-RED.txt`, `d9-redaction-runs-GREEN.txt`, `d9-artifact-redacted-GREEN.txt` |

Notes where the mutation matters more than the exit code:

- **D7** uses the verifier's three mutations verbatim. `d7-lane-step-deleted-RED`
  and `d7-lane-step-echoed-RED` are the two that the previous grep-based guard
  printed "OK" for, and that nothing downstream caught.
- **D8** writes the verifier's own spec body — a page that requests
  `/VERIFIER_EV3_MISSING.png` (404) and throws `VERIFIER_EV3_UNCAUGHT` on every
  load — behind each import spelling in turn. Only the import line changes.
  `d8-bypass-fails-the-gate-RED` shows the namespace spelling now failing
  `npm run lint`, which is the step that used to exit 0;
  `d8-guarded-import-catches-the-page-RED` shows the same body, imported
  correctly, being caught at run time by the browser-error guard.
- **D9's RED half is load-bearing.** If the sentinel were not present in the
  raw artifacts, the green half would prove nothing.
  `d9-artifact-leak-RED.txt` names the two members that carried it
  (`1-trace.network`, `1-trace.trace`) and
  `d9-artifact-redacted-GREEN.txt` shows `members containing the sentinel: 0`
  with `members still naming the request path: 6` — redacted, still debuggable.

### Two things D9 found that the fix had missed
Recorded because they are the reason the demonstration exists rather than a
paragraph claiming redaction works:

1. the first redactor matched only **absolute** URLs, and the trace recorded
   the path relatively (`/__vizra_e2e_fixture__/media/photo.jpg?…`), which a
   Next application produces everywhere;
2. a HAR `*.network` member stores the query **a second time, parsed**
   (`"queryString":[{"name":"X-Amz-Signature","value":"…"}]`), which no URL
   rewriting can reach.

Both are closed; the sweep (`scripts/e2e/sweep-artifacts.sh`) greps every
member, binary files included, so the exclusion of `.png`/`.webm` from
rewriting is verified rather than assumed.

## What did NOT run, and is not claimed
- **linux/amd64** — this machine is arm64. The `e2e` lane on the head SHA is the
  platform evidence; the local image build carries no support claim.
- **Safari / WebKit** — not installed, not configured, not claimed.
- **Accessibility** — no engine (VZ-A11Y-001, M1). Seam documented in
  `e2e/harness/test.ts`.
- **Visual baselines** — `toHaveScreenshot` unused; none committed.
- **Request/response BODIES** — `redact-artifacts.sh` covers query strings and
  fragments, not `postData` or stored response blobs. Stated in that script's
  header and in `AGENTS.md`, not silently assumed.
- **An API-backed journey** — there is no vizra-core; the frontend runs on
  sentinel configuration.
