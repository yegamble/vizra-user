# VZ-FOUND-008 — browser test environment against the production build

Evidence for `vizra-user` PR3, branch `feat/m0-browser-env`, base `1a952b5`,
and — from "Round 6" below — for the **harness-hardening** PR, branch
`fix/m0-harness-hardening`, base `90896be`.
Issue: yegamble/vizra#1 (VZ-ISSUE-001). Execution plans (meta repo):
`docs/plans/2026-09-20-vizra-user-pr3-browser-env.md` (rounds 0–2),
`docs/plans/2026-09-20-vizra-user-pr3-replan-structural.md` (rounds 3–5) and
`docs/plans/2026-09-21-vizra-user-harness-hardening.md` (round 6).

**Status: READY_FOR_REVIEW.** Not VERIFIED — no ledger entry reaches VERIFIED on
a builder's own evidence.

This is the **chair's RE-PLAN round plus its first fix round**, written by a
different builder from the one that produced rounds 1 and 2. Rounds 1 and 2
closed Findings 1–8; the re-plan closed Findings 9 and 10 and moved the
guarantee to the runtime; this round closes **Finding 11**, which defeated that
runtime control rather than the lint layer. Four rounds, four different doors
into the same hole — a spec that does not go through the guarded harness `test`
runs green on a page that 404s and throws:

| Door | Found at | Patched by |
|---|---|---|
| 1 — `import * as pw from "@playwright/test"`, and the single-quoted named form | round 0 | an AST ESLint rule |
| 2 — `/* eslint-disable vizra/no-unguarded-playwright-import */` | round 1 | `linterOptions: { noInlineConfig: true }` |
| 3 — a spec at `e2e/other/x.spec.ts`, collected by Playwright, covered by no lint glob | round 2 | `testDir: ./e2e/specs`, the lint glob `e2e/**`, and the runtime stamp |
| 4 — `test.extend({ page: … })`: keep the stamp, remove the guard | round 3 (`f6f1f59`) | **this round** — one fixture, attached at the browser |

Doors 1–3 were each patched where they were found, and each fix was a **lint**
fix; lint inspects source, not what runs. The re-plan moved the guarantee to the
RUNTIME (D11, demonstrated **with no ESLint anywhere in the command**). Door 4
then showed the runtime control proving a slightly narrower proposition than the
ledger claims: the stamp certified "this test came from the harness `test`
object", not "this test ran the guard". This round makes those the same
sentence — one fixture holds both, and it guards the BROWSER rather than a page,
so a second page, a fresh context, a popup or an overridden fixture cannot move
the hole. See D13 below and the "WHY AT THE BROWSER, AND WHY ONE FIXTURE"
section of `AGENTS.md`.

### Round 5 — DOCS ONLY, no executable line changed

Verification at `c669e40` returned **PASS**: FINDING 11 closed, and the class
with it — the verifier's exploit plus ten more shapes all red with lint green,
the merged fixture failing closed at both layers in all three override
spellings, honest overrides still green, five consecutive clean runs of the real
suite, and zero removed test lines. Three REQUIRED/SHOULD follow-ups were raised
(**Findings 12, 13, 14**) and are **queued as their own slices, deliberately not
fixed here**.

What this round does is make every sentence true. Two passages in `AGENTS.md`
were **false as written**, and one limit each in the canary and the guard was
unstated:

| # | Passage | Was | Is |
|---|---|---|---|
| 12 | the own-browser residual | "importing a Playwright package and calling `chromium.launch()` … **What catches that:** `vizra/no-unguarded-playwright-import`" | stated in terms of *the object the harness was never handed*, with the three measured import-free routes, and "**nothing catches these today**" |
| 13 | artifact privacy | "**No URL query string leaves this repository, in any artifact**" | scheme-less `host:port/path?query` survives — which is how Playwright writes a step subtitle — with the three-line reduction, why D9 misses it, and why nothing can leak today |
| 14 | the canary | implied all four guarded kinds were covered | "**covers three of the four**"; `requestfailed` has no fixture and its removal is silent |
| — | two unstated limits | — | the flush window is finite (0 ms caught, 50 ms and 150 ms missed), and the `request` fixture is out of scope by design |

A false guarantee is worse than a stated gap, because it is trusted. These are
now stated.

### Round 6 — the harness-hardening slice: FINDINGS 12 and 14 CLOSED, the flush window widened

A separate PR (`fix/m0-harness-hardening`, base `90896be`), by a different
builder from the one that wrote rounds 3–5. Round 5 left three doors documented
as open and `AGENTS.md` saying, truthfully, "**nothing catches these today**".
This round makes that sentence obsolete for two of the three, and says exactly
what is left. **FINDING 13 (scheme-less URL redaction) is deliberately NOT in
this slice** — it is the artifact-privacy slice, and the hard rule that no spec
may authenticate, fill a credential or touch a signed URL is unchanged.

| Finding | Was | Now |
|---|---|---|
| **12** — three import-free routes reach a context or browser the harness was never handed | "nothing catches these today"; review only | **closed at runtime.** `e2e/harness/creation-guard.ts`: `Browser.prototype.newContext`/`newPage` patched so every context they produce is REGISTERED with the guard; `BrowserType.prototype.launch` / `launchPersistentContext` / `launchServer` / `connect` / `connectOverCDP` (and `_electron.launch`, `_android.launchServer`/`connect`) REFUSED while a test runs, with the attempt recorded so a swallowed throw still fails; plus the verifier's own teardown catch-all, that no live context on the browser is one the guard never registered. The six method names added to the lint rule as the early warning |
| **14** — no canary fixture for `requestfailed` | neutering that listener left the canary **green** | **closed.** `e2e/demos/aborted-request.demo.ts` — a sub-resource whose connection is refused with `route.abort("connectionrefused")`, hermetic where a closed port is not. All four listeners are now red by name when neutered |
| the flush window | 0 ms caught, 50 ms and 150 ms **missed**; called inherent | **widened to 250 ms**, measured at six delays, costing 250 ms per test (18-test lane `4.8 s → 6.9 s` at `--workers=2`), deterministic over 20 runs. Still finite: 400 ms is missed, and **D14 pins both ends** so the number in `AGENTS.md` cannot drift from the code |

**Why the prototype and not the instance, and why module load.** Measured
against the installed 1.63.0 rather than assumed: none of the BrowserType
methods is an own property; `chromium`, `firefox`, `webkit` and
`browser.browserType()` share ONE prototype; and that prototype's own prototype
(`ChannelOwner`) has none of the names, so there is no second hop to escape to.
The patch is installed while `playwright.config.ts` is being evaluated — before
any test file exists in the worker — and `Browser.prototype` is patched inside
that already-patched `launch`, before the Browser is handed to anyone. A spec
therefore cannot capture an unpatched original by any route, `beforeAll`
included.

**What round 6 leaves open, stated plainly.** A file under `e2e/harness/**` can
edit the guard (the reviewed CODEOWNERS directory; D12 makes neutering the
listeners a named CI failure). Playwright's private client internals
(`playwright._connection`, `BrowserType.prototype._connect`,
`browser._innerNewContext`) are not patched. A member access the lint rule
cannot read (`browser[name]()`) is caught by the runtime guard but not by lint.
FINDING 13 is untouched and queued.

**A defect this round's own demonstration found.** The first version of the two
new `check-e2e-lane.mjs` checks used `guard.includes("armCreationGuard")`.
D13q's controlled mutation removed the CALL and left the import — and the check
passed. Both now require a call. The pre-existing checks in that same block
(`guardBrowser`, `validatePolicy`, `unallowedRecords`, `claimSigner`) have the
same weakness and were **not** changed here; it is reported rather than silently
fixed.

#### Round 6 — what ran

| File | What it shows |
|---|---|
| `round6-gate-local-npm-run-ci.txt` | `npm run ci` — exit 0; vitest **14 files / 341 tests**, 0 skipped (baseline on `main`: 13 / 316) |
| `round6-lane-local.txt` | `npx playwright test` 18 passed, `coverage floor: OK (9/9 9/9)`, exit 0; `check-coverage-floor-ran.mjs` exit 0 (`18 verified`); `harness-canary.mjs` exit 0, "failed all **4** fault-injection fixtures … one per guarded kind". Target: the local production server — the BUILT-IMAGE run is the `e2e` lane on the head SHA, and this machine is arm64 |
| `round6-flush-window-measurements.txt` | the settle table at 0 / 100 / 250 / 400 ms and the measured cost |
| `round6-settle-determinism-20-runs.txt` | 20 consecutive `--workers=2` runs, every one exit 0 / 18 passed / floor OK / 18 stamps |
| `round6-demonstrate-summary.txt` | the full `npm run e2e:demos` run: **104 halves passed, 0 blocked, 0 failed** |

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
| 5 — the `if: failure()` upload had never executed and `if-no-files-found: warn` would hide a wrong path | NIT | `if-no-files-found: error`; the path proved on a throwaway PR | **`ci-artifact-proof.md`** — a real CI run, the artifact GitHub stored, downloaded and swept: 182 files, 8 archives, sentinel in **0** members, path readable in 46 |

### Round 2 — Findings 6, 7, 8

| Finding | Severity | Closed by | Demonstrated |
|---|---|---|---|
| 6 — `/* eslint-disable vizra/no-unguarded-playwright-import */` bought a spec a complete exemption: `npm run ci` 0, the full lane 0 with "20 passed, floor OK", both floor checks 0, the lane guard 0, on a page that 404s and throws | BLOCKER | `linterOptions: { noInlineConfig: true }` on the `e2e/specs/**` + `e2e/demos/**` block — every comment form at once, not the ones known today — plus `playwright/test` and `playwright` added to the rule's package list. Two tests pin it: the resolved config must carry the setting, and the behaviour must hold for each directive form | **D8**, six new halves (`d8-bypass-eslint-disable`, `-disable-all`, `-disable-next-line`, `-inline-severity`, `-unscoped-package`, `d8-eslint-disable-fails-npm-run-ci`) |
| 7 — the redact step and the upload step both carried bare `if: failure()`, so a redactor that exits non-zero still published the unredacted tree | REQUIRED | the redact step has `id: redact`; the upload is `if: failure() && steps.redact.outcome == 'success'`; the parser asserts exactly that relationship | **D7**, four new halves, plus 6 fixture cases in `require-checks_test.sh`, plus the forced-failure CI proof in **`ci-redactor-failure-proof.md`** — GitHub evaluated the gate and **skipped** the upload; **0 artifacts** published, against 48 files on the healthy run |
| 8 — AGENTS.md said no query string leaves the repository and then offered "headers readable" as a feature | SHOULD | the section now states what IS covered (query strings, fragments, `Location`) and tabulates every channel that is NOT, and adds the hard line: no spec may authenticate, fill a credential or touch a real signed URL until the artifact-privacy slice lands — asserted by `e2e/harness/no-credentials-in-specs.test.ts` | **D10** |

### Round 3 (the re-plan) — Findings 9 and 10, and the silent case

| Finding | Severity | Closed by | Demonstrated |
|---|---|---|---|
| 9 — a spec at `e2e/other/x.spec.ts` was collected by Playwright (`testDir: "./e2e"`) and linted by neither guard (both enumerated `e2e/specs` + `e2e/demos`): `npm run ci` 0, the lane 0 with `coverage floor: OK (10/9 10/9)`, the out-of-process floor 0, the credential sweep blind — on a page that 404s and throws | BLOCKER | **the guarantee moved to the runtime.** `e2e/harness/test.ts` stamps every test it runs with an HMAC over that test's identity under a per-run key a spec cannot read; `e2e/harness/stamp-reporter.ts` (in process) and `scripts/ci/check-coverage-floor-ran.mjs` (out of process) both fail a run in which a test SUCCEEDED without a valid stamp, naming the file. Collection narrowed to `e2e/specs` (`e2e/demos` for the demo runner) and the ESLint glob widened to `e2e/**` minus `e2e/harness/**`, so the file is neither collected nor unlinted — but neither of those is the control | **D11**, eleven halves: all three historical doors plus two forgery attempts plus the out-of-process half with the in-process reporter deleted |
| 10 — the workflow parser located the upload with `steps.find(...)`, so a SECOND, ungated `actions/upload-artifact` step passed; when the redactor fails, it publishes the unredacted tree | REQUIRED | `.filter`: every uploader step must carry `failure() && steps.redact.outcome == 'success'`, and an uploader that is not `actions/upload-artifact` is recognised as one | **D7b**, three halves, plus 4 fixture cases in `require-checks_test.sh` |
| residual — neutering `e2e/harness/browser-errors.ts` while leaving its identifiers in place is SILENT in CI: `npm run test` 0, `check-e2e-lane.sh` 0 (string presence only), the lane 0, and `npm run e2e:demos` is not a CI lane | (verifier's note) | `scripts/ci/harness-canary.mjs` runs in the required `e2e` lane and requires each of the three fault-injection fixtures to fail for its own reason (the "named reason" wording here was superseded in round 4 — see below — because it was overstated; the canary now asserts the exact SET of record kinds) | **D12**, five halves: each listener neutered in turn, plus 6 fixture cases in `require-checks_test.sh` |

### Round 4 — Finding 11, and the canary's overclaim

The re-plan held: at `f6f1f59` the verifier refused 13 forge attempts, ran the
`eslint-disable` door against a mutant ESLint config so lint was genuinely green
and the runtime still refused it by name, and closed Findings 9 and 10. It failed
on one new blocker, in the same family but against the **runtime** control.

| Finding | Severity | Closed by | Demonstrated |
|---|---|---|---|
| 11 — the stamp was an `auto` fixture and the guard was a `page` override, so `test.extend({ page: … })` kept the stamp and removed the guard: `npm run ci` 0, the lane 0 with "20 passed, floor OK, harness stamp: OK (20 verified)", the out-of-process check 0, the canary 0, the parser 0 — on a page that 404s and throws, from four lint-clean lines in a normal spec touching no gate file | BLOCKER | **one fixture, attached at the BROWSER.** The guard and the stamp are both in `vizraHarnessGuard`, so removing the guard removes the stamp that two checks require. It listens at BrowserContext level (`console`, `weberror`, `requestfailed`, `response` — all four checked in the installed 1.63.0 types), sweeps existing contexts and wraps `browser.newContext`/`newPage` for the test, restoring both afterwards | **D13**, eleven halves — eight attack shapes, the inverse control, and the two lint halves |
| canary overclaim — "each for its own named reason" was false for the console fixture: swapping its `console.error` for a 404 left the canary GREEN, because Chromium logs the failed load to the console | (verifier's residual) | one invocation per fixture, asserting the exact SET of record kinds — which kinds must be recorded AND which must not | **D12e**, two halves |

**The dependency list was decided by measurement, not by taste.** Three orderings
were tried and two were wrong:

| Fixture depends on | Guard installed | Page at assertion time | Result |
|---|---|---|---|
| `browser` only | before `page` ✅ | **closed** (`pages=0`) ❌ | flush is a no-op; the failure's own trace went from 21 members to 8 |
| `browser` + `page` | **after** an overridden `page` fixture ❌ | open ✅ | a spec that navigates inside its own fixture **passed** on a broken page |
| `browser` + `context` | before `page` ✅ | open (`pages=1`) ✅ | both — D13e2 now fails with all three records |

**What forging the runtime stamp would take** is stated in full in `AGENTS.md`
and in the header of `e2e/harness/stamp.ts`, and is not claimed to be
impossible: recovering the per-run key (absent from the worker's environment,
absent from disk while any test runs), or importing a sealed harness module
(`claimSigner()` refuses the second claim in a worker — D11d — and lint refuses
the reference), or editing `e2e/harness/**` / `playwright.config.ts` /
`eslint-rules/**` directly. Every one of those is a named edit in the diff.

`no-console` for `e2e/demos/**` moved from an inline comment to the config, because
with `noInlineConfig` a disable comment there is inert; the console call in a
demo IS the fault under demonstration.

One more defect surfaced during round 1, by the new tests rather than by a
reviewer: `ci-guard` never ran `npm ci`, so the parser-based lane guard could
not load its `yaml` dependency and 13 of the new regression cases failed in CI
with "Cannot find package 'yaml'". The job now installs from the lockfile, the
guard reports a missing parser as BLOCKED by name instead of throwing a
module-resolution stack, and `ci-guard`'s path filter now includes
`package.json` / `package-lock.json`.

## The lane
| File | What it shows |
|---|---|
| `gate-local-npm-run-ci.txt` | `npm run ci` — exit 0; vitest **12 files / 289 tests**, 0 skipped |
| `lane-against-built-image-local.txt` | `npm run e2e` against the **built Docker image** (arm64, local): 18 passed, `coverage floor: OK (desktop=9/9 mobile=9/9)`, `e2e harness stamp: OK (18 succeeding result(s) verified)`, the out-of-process floor-and-stamp guard exit 0, and the harness canary exit 0 with the exact kind sets |
| `browser-revision.txt` | the exact browser build the harness resolved |
| `server-production.log`, `server-development.log` | the two servers the demonstrations drove |

## The demonstrations
Red against a controlled mutation, green when restored. Summary of the run that
produced these files: `round6-demonstrate-summary.txt` — **104 halves passed, 0
blocked, 0 failed** (88 before round 6).

| # | Requirement | Transcripts |
|---|---|---|
| D1 | `console.error` fails the lane | `d1-console-error-{RED,GREEN}.txt` |
| D2 | a 404 sub-resource fails the lane | `d2-failed-request-{RED,GREEN}.txt` |
| D3 | an uncaught exception fails the lane | `d3-uncaught-exception-{RED,GREEN}.txt` |
| **D3b** | **a request that never completes fails the lane** — the FOURTH guarded kind, which had no fixture until round 6 | `d3b-aborted-request-{RED,GREEN}.txt` |
| D4a | zero tests collected fails | `d4a-zero-tests-{RED,GREEN}.txt` |
| D4b | a missing project fails | `d4b-missing-project-{RED,GREEN}.txt` |
| D4c | **deleting one test** drops a project below its floor | `d4c-floor-shortfall-{RED,GREEN}.txt` |
| D4c2 | **adding** a test without raising the floor stays green (a floor is a minimum) | `d4c2-floor-is-a-minimum-GREEN.txt` |
| D4d | the lane **refuses a filtered run** (the verifier's `--grep "reports liveness"`) | `d4d-filtered-run-{RED,GREEN}.txt` |
| D5 | pointing at `next dev` fails | `d5-dev-server-{RED,GREEN}.txt` |
| D6 | the built image carries no harness file or fixture token | `d6-image-fixtures-{RED,GREEN}.txt` |
| D7 | a weakened `e2e` workflow fails the lane guard — step deleted, echo-replaced, `\|\| true`, `if: false`, artifacts removed, `if-no-files-found: warn`, floor step removed, upload not gated on the redactor, gated on "ran" rather than "succeeded", redact step with no `id`, redact step `continue-on-error` | `d7-*.txt` (12) |
| D7b | **EVERY upload step is checked, not the first** — a second ungated `actions/upload-artifact`, an ungated uploader that is *not* `actions/upload-artifact`, and the control: a second upload that IS correctly gated passes | `d7b-*.txt` (3) |
| D7c | **the harness canary is a required part of the lane** — deleted, `if: false`, `continue-on-error`, and a workflow that pins `VIZRA_E2E_STAMP_KEY` | `d7c-*.txt` (4) |
| D8 | a spec reaching the unguarded `test` fails the gate — namespace, single quotes, dynamic `import()`, `require`, a re-export shim, **four inline-directive forms, the unscoped `playwright/test`**, and the whole `npm run lint` and `npm run ci` | `d8-*.txt` (14) |
| D9 | a signed-URL-shaped query string does not reach an uploaded artifact | `d9-artifact-leak-RED.txt`, `d9-redaction-runs-GREEN.txt`, `d9-artifact-redacted-GREEN.txt` |
| D10 | a spec that handles a credential fails the cheap lane | `d10-no-credentials-GREEN.txt`, `d10-credential-spec-RED.txt` |
| **D11** | **the runtime proof of harness.** Every half below runs Playwright directly — **no ESLint anywhere in the command** — so what is shown is the runtime, not the lint | `d11*-*.txt` (11) |
| D11a | door 1, the namespace import verbatim → the lane is RED with `succeeded WITHOUT the harness stamp` | `d11a-namespace-import-RED.txt` |
| D11b | door 2, `/* eslint-disable … */` **with `noInlineConfig` removed by a controlled mutation of `eslint.config.mjs`**, so lint genuinely lets the file through (GREEN half proves it does) — and the runtime catches it anyway | `d11b-lint-defeated-GREEN.txt`, `d11b-eslint-disable-RED.txt` |
| D11c | door 3, a spec at `e2e/other/__r1.spec.ts` — **not collected** (the lane still lists `Total: 18 tests in 3 files`) and **refused by lint** | `d11c-outside-not-collected-GREEN.txt`, `d11c-outside-refused-by-lint-RED.txt` |
| D11d | a door the verifier has not tried: the spec imports the sealed `e2e/harness/stamp` and signs itself → `the browser harness's stamp key has already been claimed in this worker` | `d11d-forge-via-sealed-module-RED.txt` |
| D11e | a second new door: the spec reads `process.env.VIZRA_E2E_STAMP_KEY`. The transcript shows both halves at once — the assertion that the variable is `undefined` PASSES, and the forged stamp `does not verify against this run's key` | `d11e-forge-via-environment-RED.txt` |
| D11f | the **out-of-process** half with the in-process reporter deleted from `playwright.config.ts` (the one-line edit the gated PR could make): the run itself is green ("20 passed"), and `check-coverage-floor-ran.mjs` is still RED — *"A lane whose proof is missing did not prove anything."* | `d11f-in-process-reporter-deleted-GREEN.txt`, `d11f-out-of-process-still-RED.txt` |
| D11 | and the clean tree: the lane prints `e2e harness stamp: OK` and the out-of-process check `carried a valid harness stamp` | `d11-clean-tree-*.txt` |
| **D12** | **the CI canary self-tests the guard.** Each of the four context listeners in `e2e/harness/browser-errors.ts` is removed in turn. **All four turn the lane red** since round 6 added the `requestfailed` fixture; before it, that one was honestly GREEN and the transcript said so rather than pretending otherwise. The `response` case is the sharp one: the fixture still FAILS (the 404 also logs a console error), so a canary that counted failures would pass — this one requires `http 404` and goes red | `d12-*.txt` (6) |
| **D12d** | **the `requestfailed` listener neutered is now RED by name** (round 6). The earlier transcript, in which the same mutation left the canary GREEN, is kept beside it as the record of the defect | `d12d-requestfailed-listener-neutered-RED.txt`, and the defect: `d12-requestfailed-listener-neutered-GREEN.txt` |
| D12e | **a fixture that fails for the WRONG reason.** `console.error(token)` in the console fixture is swapped for a 404. Under the old canary this was GREEN; it is now red with "failed for the WRONG reason: the guard recorded [response], [pageerror]" | `d12e-fixture-fault-type-swapped-RED.txt`, `d12e-fixture-restored-GREEN.txt` |
| **D13** | **stamped implies guarded.** Every half uses the same broken-page body and differs only in HOW the page was obtained. Fifteen runtime shapes red, two lint halves red, the honest overrides green | `d13*-*.txt` (20) |
| D13a | the verifier's Finding 11 exploit, verbatim — an overridden `page` fixture | `d13a-overridden-page-fixture-RED.txt` |
| D13b | a second page in the default context (`context.newPage()`), no fixture touched | `d13b-second-page-in-default-context-RED.txt` |
| D13c | `browser.newContext()` + `newPage()` inside the test body | `d13c-browser-newContext-in-body-RED.txt` |
| D13d | `browser.newPage()`, which makes its own context implicitly | `d13d-browser-newPage-in-body-RED.txt` |
| D13e | an overridden `context` fixture | `d13e-overridden-context-fixture-RED.txt` |
| D13e2 | an overridden `page` fixture that **navigates inside itself** and never in the body — the ordering case that decided the fixture's dependency list | `d13e2-override-navigates-in-the-fixture-RED.txt` |
| D13f | a **popup** the page opens with `window.open` | `d13f-popup-window-open-RED.txt` |
| D13g | an overridden **`browser`** fixture, via Playwright's built-in `playwright` fixture — no import, so lint cannot see this one at all and only the runtime catches it | `d13g-overridden-browser-fixture-RED.txt` |
| D13h | **the inverse control**: an HONEST `page` override (1024×768, `en-GB`) on a HEALTHY page stays GREEN. A harness nobody can extend is a harness people work around | `d13h-honest-override-stays-GREEN.txt` |
| D13i | the lint early warning: replacing `vizraHarnessGuard` is refused; overriding `page` stays clean | `d13i-harness-fixture-override-refused-RED.txt`, `d13i-page-override-stays-lint-clean-GREEN.txt` |
| **D13j** | **round 6 — FINDING 12, route 1.** `Object.getPrototypeOf(browser).newContext.call(browser)`, with the context **closed inside the body**. It is GUARDED, not merely detected, so its records survive the close — which a teardown-only check could not do | `d13j-prototype-newContext-RED.txt` |
| **D13k** | **route 2.** `browser.browserType().launch()` — refused at the call site, before anything is launched | `d13k-browserType-launch-RED.txt` |
| **D13l** | **route 3.** `playwright.chromium.launchPersistentContext(dir)` — a context on a second browser, through the built-in `playwright` fixture | `d13l-launchPersistentContext-RED.txt` |
| **D13m** | `connect` and `connectOverCDP`. Reachable with no server, because the refusal precedes the call | `d13m-connect-and-connectOverCDP-RED.txt` |
| **D13n** | **the swallowed refusal.** `try { await browser.browserType().launch(); } catch {}` — the attempt is recorded, so teardown fails it anyway. Without this, one `catch` would be an opt-out | `d13n-swallowed-refusal-still-RED.txt` |
| **D13o** | **the third layer, shown on its own.** With the creation guard's REGISTRATION cut by a controlled mutation, a stray context left open is named by the teardown assertion; restored, the same spec is caught by the registration instead, with the ordinary browser-error diagnostic | `d13o-registration-cut-teardown-catches-RED.txt`, `d13o-registration-restored-RED.txt` |
| **D13p** | **the lint half, red and green.** The GREEN half is load-bearing: with `bannedMethods` forced empty by a controlled mutation of `eslint.config.mjs`, ESLint passes a spec holding all three routes — which is exactly the state the verifier measured, and the reason the runtime halves are the control and lint is the early warning | `d13p-three-routes-lint-green-without-the-ban-GREEN.txt`, `d13p-three-routes-lint-refused-RED.txt` |
| **D13q** | deleting the creation guard, or the teardown assertion, from `e2e/harness/test.ts` fails `check-e2e-lane.sh` by name — the cheap early warning for an outright deletion, and the half that caught the first version of those checks being satisfied by the import line alone | `d13q-creation-guard-deleted-RED.txt`, `d13q-teardown-assertion-deleted-RED.txt`, `d13q-lane-guard-restored-GREEN.txt` |
| **D14** | **the flush window, made executable.** A fault 150 ms after the body returns MUST fail (red if the settle is ever shortened); a fault at 600 ms passes, and **that green half is the documented limit** — it goes red if the settle is lengthened past it, so the number in `AGENTS.md` cannot drift from the code | `d14-late-fault-150ms-RED.txt`, `d14-late-fault-600ms-is-the-LIMIT-GREEN.txt` |

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
- **D11b's GREEN half is load-bearing, and it is deliberately a WEAKENING.** It
  lints the bypass spec with a mutated `eslint.config.mjs` that has
  `linterOptions` stripped, and asserts ESLint reports no problem. Without that
  half, the RED half would be demonstrating the lint fix rather than the runtime
  one. Both mutant configurations (`eslint.config.no-inline-config.mjs`,
  `playwright.config.no-stamp-reporter.ts`) are generated by the script, deleted
  when it exits, and gitignored; neither is ever committed.
- **D11f's GREEN half is load-bearing for the same reason.** It shows the run
  going green once the in-process reporter is deleted — which is exactly what
  makes the RED half (the out-of-process check, still failing) mean something.
- **D12's `response` case is the one to read.** The fixture still fails when the
  `response` listener is dead, because the 404 also produces a console error. A
  canary that asserted "three tests failed" would have passed that mutation. The
  canary asserts each fixture's own diagnostic, so it does not.
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
- **Headers, bodies, console tokens, DOM snapshots and Playwright call
  parameters.** `redact-artifacts.sh` covers query strings, fragments and
  `Location` only. Every uncovered channel is now tabulated in `AGENTS.md` with
  where it survives, and the hard line that follows — no spec may authenticate,
  fill a credential or touch a real signed URL until the artifact-privacy slice
  lands — is asserted by `e2e/harness/no-credentials-in-specs.test.ts`, not left
  as prose. The redaction of those channels is explicitly **not** attempted in
  this PR; it is its own slice.
- **An API-backed journey** — there is no vizra-core; the frontend runs on
  sentinel configuration.
- **An unforgeable stamp.** The stamp is not claimed to be unforgeable, only to
  be unforgeable *by accident* and to make every forgery a named edit in the
  diff. `AGENTS.md` § "What forging a stamp would take" lists the three routes
  in full. Two of them are demonstrated failing (D11d, D11e); the third is
  editing `e2e/harness/**`, `playwright.config.ts` or `eslint-rules/**`, which
  `npm run test` and the D12 canary make loud but which no control in this
  repository can forbid.
- **A CONTEXT OR BROWSER THE HARNESS WAS NEVER HANDED is not guarded, and
  nothing catches it today** (verifier FINDING 12, OPEN — required, not
  blocking). The guard wraps the browser instance's OWN `newContext`/`newPage`,
  so any route around those own properties escapes. Three were measured, each
  from a spec importing only the harness `test`, each passing the **complete**
  gate — lint green, lane 0 with `20 passed, floor OK 10/9 10/9, stamp OK (20)`,
  out-of-process 0 — on a page that 404s a sub-resource and throws:
  `Object.getPrototypeOf(browser).newContext.call(browser)`,
  `browser.browserType().launch()`, and
  `playwright.chromium.launchPersistentContext(dir)`.
  (`Object.getPrototypeOf(browser).newPage.call(browser)` IS caught — the
  prototype's `newPage` calls `this.newContext`, the wrapper.)
  **An earlier version of this bullet, and of `AGENTS.md`, said the shape was
  "importing a Playwright package and calling `chromium.launch()`" and named the
  lint rule as what catches it. That was false**: `import { chromium }` is
  indeed red, but none of the three routes imports anything, so the rule never
  sees them — and neither do the stamp (such a test is still stamped), the
  floor, the canary or the parser. Review is the only control. Queued as the
  next harness slice: a teardown assertion that `browser.contexts()` holds no
  unguarded context, plus `.browserType(` / `.launch(` /
  `.launchPersistentContext(` in the lint rule. Not fixed in this PR.
- **The artifact redactor misses SCHEME-LESS URLs** (verifier FINDING 13, OPEN —
  required before M1). `host:port/path?query` matches neither the absolute
  program (needs `scheme://`) nor the relative one (must begin at `/`), and that
  is exactly how Playwright writes a `test.trace` step subtitle — so any
  `page.goto(signedUrl)` produces one. Measured: a sentinel went 3 members → 1
  after redaction, surviving in `test.trace`. **D9 does not exercise this path**:
  its sentinel is a sub-resource (`img.src = url`), and a sub-resource never
  becomes a step subtitle. Nothing can leak today — no spec touches a signed URL
  — and the hard rule in `AGENTS.md` is what holds that. `AGENTS.md`'s former
  absolute claim, "No URL query string leaves this repository, in any artifact",
  was false as written and is corrected. Queued with the artifact-privacy slice.
- **The canary covers three of the four guarded signal kinds** (verifier
  FINDING 14, OPEN — should). Neutering `console`, `weberror` or `response`
  turns it red; neutering **`requestfailed` leaves it green**, because none of
  the three fixtures produces a failed request (a 404 is a completed response).
  Queued: a fourth fixture against a closed port or an aborted route.
- **The flush window is finite.** A fault scheduled 0 ms after the test body
  returns is caught; the verifier measured 50 ms and 150 ms being missed.
  Inherent to asserting at a point in time, not a defect to redesign around.
- **Playwright's `request` fixture is out of the guard's scope, by design.** An
  `APIRequestContext` 404 is not a browser signal and does not fail a test — the
  spec asserts the status itself. Correct, and now stated.
- **`.github/CODEOWNERS` still enforces nothing** until a ruleset on `main`
  requires Code Owner review, which is an owner action outside any pull request.
  Wherever the evidence or `AGENTS.md` says "owner-reviewed", that precondition
  applies.
- **Arbitrary `run:` exfiltration** — `gh release upload`, `curl`, anything a
  step can execute. `check-e2e-lane.mjs` closes uploader *actions*, including
  ones that are not `actions/upload-artifact`; it cannot close `run:`, and does
  not claim to.
