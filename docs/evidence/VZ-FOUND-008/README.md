# VZ-FOUND-008 — browser test environment against the production build

Evidence for `vizra-user` PR3, branch `feat/m0-browser-env`, base `1a952b5`.
Issue: yegamble/vizra#1 (VZ-ISSUE-001). Execution plan (meta repo):
`docs/plans/2026-09-20-vizra-user-pr3-browser-env.md`.

**Status: READY_FOR_REVIEW.** Not VERIFIED — an independent verifier has not
reproduced this, and no ledger entry may reach VERIFIED on a builder's own
evidence.

## Environment
See `environment.txt` for the machine-written record. In summary: Darwin arm64,
Node v22.14.0, Playwright 1.63.0, Chromium `chromium-1243` /
`chromium_headless_shell-1243` (Chrome for Testing 153.0.8010.12), ffmpeg
`ffmpeg-1011` — see `browser-revision.txt`.

**Platform caveat.** These transcripts are from the owner's **arm64** machine,
which ADR-009 explicitly says is not the acceptance platform. The acceptance
platform is GitHub-hosted `ubuntu-24.04`, linux/amd64, and the `e2e` lane runs
there on every pull request. The local image built and driven below is a native
arm64 build and carries no support claim; it proves the path, not the platform.
CI on the pull-request head SHA is the evidence that counts for the platform.

## Reproduce
```
npm ci
npm run e2e:install
INTERNAL_API_BASE_URL=http://api.sentinel.invalid:8080 \
  PUBLIC_ORIGIN=http://127.0.0.1:3211 npm run build
npm run e2e          # the lane, against the local standalone production server
npm run e2e:demos    # every transcript in this directory, regenerated
```
`npm run e2e:demos` fails if any RED half passes or any GREEN half fails —
"the demonstration did not demonstrate" is treated as a failure.

## The lane
| File | What it shows |
|---|---|
| `gate-local-npm-run-ci.txt` | `npm run ci` (lint, typecheck, vitest, production build) — exit 0 |
| `lane-against-built-image-local.txt` | `npm run e2e` against the **built Docker image** (arm64, local): 18 tests, 9 per project, exit 0, coverage floor OK |
| `browser-revision.txt` | the exact browser build the harness resolved |
| `server-production.log`, `server-development.log` | the two servers the demonstrations drove |

## The demonstrations
Every one is red against a controlled mutation and green when restored. The
summary of the run that produced these files is `demonstrate-summary.txt`
(18 halves passed, 0 blocked, 0 failed).

| # | Requirement | RED | GREEN |
|---|---|---|---|
| D1 | a page that logs `console.error` fails the lane | `d1-console-error-RED.txt` | `d1-console-error-GREEN.txt` |
| D2 | a page that requests a resource returning 404 fails the lane | `d2-failed-request-RED.txt` | `d2-failed-request-GREEN.txt` |
| D3 | an uncaught exception in the page fails the lane | `d3-uncaught-exception-RED.txt` | `d3-uncaught-exception-GREEN.txt` |
| D4a | the lane fails when ZERO tests are collected | `d4a-zero-tests-RED.txt` | `d4a-zero-tests-GREEN.txt` |
| D4b | the lane fails when a required project is missing | `d4b-missing-project-RED.txt` | `d4b-missing-project-GREEN.txt` |
| D5 | the lane fails when pointed at a dev server | `d5-dev-server-RED.txt` | `d5-dev-server-GREEN.txt` |
| D6 | the built image contains no harness file and no fixture token | `d6-image-fixtures-RED.txt` | `d6-image-fixtures-GREEN.txt` |
| D7 | a weakened `e2e` workflow fails the lane guard | `d7-lane-guard-RED.txt` | `d7-lane-guard-GREEN.txt` |
| D8 | a spec importing Playwright's unguarded `test` fails `npm run test` | `d8-bypass-guard-RED.txt` | `d8-bypass-guard-GREEN.txt` |

Notes on the RED halves, because the mutation matters more than the exit code:

- **D1–D3** inject the fault with `page.addInitScript` against the unmodified
  production server. The test bodies still pass every assertion they make; the
  guard fails them in teardown. That is the property under test: a spec cannot
  pass by not looking.
- **D2** produces *two* signals from one fault — the 404 response and
  Chromium's own console error — and the green half allow-lists each kind
  separately, which is why the allow-list is per kind rather than per message.
- **D4a** uses a `--grep` that matches nothing. Playwright's own exit code
  answers "did anything fail"; `d4a-zero-tests-RED.txt` shows the coverage
  reporter answering "did anything run", and overriding the status to failed.
- **D4b** runs a generated configuration with the 390 px project removed —
  the exact edit that would look like tidy-up in a diff.
- **D5** points the same specs at `next dev`. `d5-dev-server-RED.txt` shows all
  five production markers tripping independently: dev-only bundles, the HMR
  WebSocket, `<nextjs-portal>`, the build id `development`, and
  `cache-control: no-cache, must-revalidate` on `/_next/static`.
- **D6** builds an image with the harness deliberately copied in (a per-file
  `.dockerignore` is used so the mutation can actually happen) and shows the
  guard naming the files.

## One defect found by CI on the first push, and fixed
The first push committed the Next dev server's HMR WebSocket URL —
`ws://127.0.0.1:3212/_next/hmr?id=<opaque>` — into the D5 transcript, and the
repository's secret scanner flagged it. That value was an ephemeral Next HMR
session id and harmless — but the scanner read the shape correctly: the
harness was copying opaque query-string values out of a page into failure
messages, CI logs and committed evidence. The next such value would be a signed
media URL from vizra-core, and the meta `AGENTS.md` says never to log private
signed URLs.

`e2e/harness/redact.ts` now strips the query string and fragment from every URL
the harness prints, at capture rather than at print, keeping origin and path.
`e2e/harness/redact.test.ts` pins it. The flagged string itself is deliberately
not reproduced anywhere in this repository — not in the fix, not in the tests,
not here — because committing a token-shaped high-entropy string into a test
file is the habit this module exists to break. The transcripts in this directory
were regenerated afterwards and contain no raw query string.

## What did NOT run, and is not claimed
- **Safari / WebKit.** Chromium only, by design (the VZ-FOUND-008 ledger entry's
  negative case). Nothing here claims Safari behaviour.
- **Accessibility.** No axe or other engine is installed. VZ-A11Y-001 is M1; the
  seam is documented in `e2e/harness/test.ts`.
- **Visual baselines.** `toHaveScreenshot` is unused and no baseline is
  committed — approving one is a separate, reviewed act.
- **linux/amd64.** Not built or run locally (this machine is arm64 and ADR-009
  forbids treating it as the acceptance platform). The `e2e` lane covers it.
- **A real vizra-core.** The frontend is driven with sentinel configuration;
  no API-backed journey exists yet, and none is asserted.
