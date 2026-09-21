# Evidence — re-vendor the API contract from vizra-core `main`

Slice: re-point `contracts/manifest.json` at a commit that exists, and make
something read it. Branch `chore/revendor-core-main`; meta issue
`yegamble/vizra#1`.

Recorded on macOS arm64 (Darwin arm64), node v22.14.0, npm 10.9.2,
git 2.50.1, at code head **`549e589e2cc99a66cc8d0c01166d44bbd209db89`** — every
transcript below names that SHA. The only later commit on this branch is the
one that adds this directory, which changes nothing the transcripts ran
against. ADR-009's acceptance platform is GitHub `ubuntu-24.04` / linux/amd64;
the local runs below carry no platform claim, and the CI run on the head SHA is
the one that does.

## What changed, and what did not

`provenance.txt` is the file to read first. It shows, with the commands:

| Claim | Where |
|---|---|
| The vendored bytes are core's blob at `main@415a6d19cfc0acedd8ad84c1857c95db0ed63627` — `git hash-object` here equals `git rev-parse 415a6d1:api/openapi.yaml` there (`58030e7f…`), same sha256 `128d0509…`, same 10695 bytes | `provenance.txt` §1 |
| The commit PR #1 recorded (`b0dbeb6…`) is **not** an ancestor of core's `main` and its branch `feat/m0-foundation` no longer exists on `origin` | `provenance.txt` §2 |
| `api/openapi.yaml` is **byte-identical** between `b0dbeb6` and `415a6d1` — the same blob id. Zero paths, operations, schemas, status codes or security schemes differ, and no prose or whitespace moved: core's squash-merge carried the contract across unmodified | `provenance.txt` §3 |
| Consequently neither `contracts/vizra-core/api/openapi.yaml` nor `lib/api/generated.ts` appears in the re-vendor commit's diff — `git diff --stat main...HEAD -- contracts/ lib/` is one file, `contracts/manifest.json`. No existing code or test needed changing, because the contract did not move | `provenance.txt` §4 |

The contract's `SEARCH_HMAC_KEY` naming is **unchanged here on purpose**: the
chair has ruled that core renames its `VIZRA_SEARCH_HMAC_KEY` variable to match
in a later core slice, which will need a further re-vendor. Nothing in this PR
pre-empts it.

## Red/green demonstrations

`bash scripts/demonstrate-contract.sh` — 12 recorded outcomes, all as
described (`demonstrate-summary.txt`). The script refuses to run on a dirty
tree and restores every mutation with `git checkout --` in a trap.

| Transcript | Mutation | Result |
|---|---|---|
| `d1-handedited-client-RED.txt` / `-GREEN.txt` | one line added to `lib/api/generated.ts` | `check:contract` exit 1, naming the first differing line; exit 0 restored |
| `d2-edited-spec-RED.txt` / `-GREEN.txt` | two lines appended to the vendored spec | exit 1 on sha256, bytes and blob id; exit 0 restored |
| `d3-nonlocal-ref-RED.txt` / `-GREEN.txt` | a spec whose `$ref` points at `https://attacker.example/…` | `check-spec-refs.mjs` exit 1 naming line and value; exit 0 on the vendored spec (9 in-document refs) |
| `d4a-feature-branch-RED.txt` | manifest re-pointed at `feat/m0-foundation` + `b0dbeb6…` — **PR #1's actual state, which passed every lane** | exit 1 |
| `d4b-short-commit-RED.txt` | `source_commit` abbreviated to 7 characters | exit 1 |
| `d4c-wrong-bytes-RED.txt` | byte count off by one | exit 1 |
| `d4d-wrong-blob-RED.txt` | `source_blob` replaced | exit 1 |
| `d4e-manifest-GREEN.txt` | none | exit 0 |
| `d5-unknown-ref-RED.txt` | vendoring from a ref that does not resolve | exit 2, nothing written |

## Lanes

| Transcript | Command | Result |
|---|---|---|
| `gate-npm-run-ci.txt` | `npm run ci` | exit 0 — lint, typecheck, **315 tests passed in 13 files, 0 skipped**, production build |
| `e2e-local.txt` | `npm run e2e` | exit 0 — 18 passed, coverage floor OK (9/9 desktop, 9/9 mobile), harness stamp OK (18 verified) |
| `ci-guard-local.txt` | the `ci-guard` scripts | all exit 0; `require-checks_test.sh` 102 cases / 109 assertions / 0 failed; shellcheck clean |

## What this evidence does NOT show

**Staleness.** Nothing here proves core's `main` is still at `415a6d1`, or even
that the commit exists in `yegamble/vizra-core` — only that the manifest is
internally honest and that the bytes match the blob recorded. `yegamble/vizra-core`
is private and this repository holds no read token for it. Providing one is an
owner action outside any pull request; the step to add once it exists is written
down in `AGENTS.md` ("Owed — STALENESS IS NOT DETECTED HERE").

The `provenance.txt` comparisons above were run against a **local** core
checkout, by hand. They are evidence for this PR; they are not a CI control.
