# PR1b hardening — red/green evidence

Every *demonstrated* acceptance bullet in this PR has a controlled mutation
recorded here: the check red against the mutation, green with it restored. The
transcripts live in the repository so they travel with the PR rather than
sitting in a review comment.

Source: the two reviews of vizra-user PR #1, filed in the meta repo under
`docs/evidence/warroom/` — `…-pr1-skeleton-SECURITY.md` (FINDINGs 4, 5, 6 and
the FLOOR note in the closure section) and `…-pr1-skeleton-VERIFY.md`
(FINDINGs 6 and 7). Base: `main` at `752253c`.

Environment for every transcript below: darwin arm64, node v22.14.0, npm
10.9.2, docker 29.8.0, jq 1.7.1, shellcheck 0.11.0, Trivy 0.70.0. CI
(ubuntu-24.04, linux/amd64) is the acceptance platform (ADR-009) and is what
the PR's own run proves.

| File | Finding | What the mutation was |
|---|---|---|
| `a1-server-only-RED.txt` | security F4 | `import "server-only";` deleted — from both modules, then from each alone |
| `a1-server-only-GREEN.txt` | security F4 | restored; dependency, lockfile integrity and `assertServer` coverage recorded |
| `a1-bundle-leak-RED.txt` | security F4 | a Client Component inlining a `NEXT_PUBLIC_` value; the grep finds it in a real chunk |
| `a2-image-pin-RED.txt` | security F5 | the runner stage's `@sha256` digest removed |
| `a2-image-pin-GREEN.txt` | security F5 | restored; the guard and the shell suite both green |
| `a2-supply-chain-BASELINE.txt` | security F5 | scan baselines, before and after removing the base image's package managers |
| `a3-spec-refs-RED.txt` | security F6 | a local `$ref` in the vendored spec replaced by `https://attacker.example/…` |
| `a3-spec-refs-GREEN.txt` | security F6 | the committed spec, unchanged, passing |
| `a4-no-raw-fetch-RED.txt` | verifier F6 | the 14 new lint cases against the merged rule |
| `a4-no-raw-fetch-GREEN.txt` | verifier F6 | the same cases against the fixed rule |
| `a5-floor-RED.txt` | verifier F7 | `check-required-floor.sh` reverted to the merged version |
| `a5-floor-GREEN.txt` | verifier F7 | the blank-`FLOOR` guard in place |

## Two things the mutations caught that reading would not have

**The `$ref` reachability claim was UNVERIFIED in the review, and now is not.**
`a3-spec-refs-RED.txt` drives openapi-typescript 7.13.0 directly at a poisoned
spec with no guard in the way. It crashes with `Can't resolve $ref: fetch
failed` — the outbound request to `attacker.example` actually happened. The
finding said "reachability by dependency behaviour rather than by
demonstration"; it is now by demonstration.

**The first version of the server-only guard was wrong, and its own red run
said so.** It grepped for the string `server-only` anywhere in the build
output, and "passed" with both imports deleted: Next's code frames quote the
source, and `assertServer`'s message and `fetch.ts`'s docblock both contain the
phrase — and `lib/api/fetch.ts` imports `next/headers`, which Next refuses on
its own, so the build failed either way. The guard now matches Next's
diagnostic sentences exactly, strips the ANSI colouring first, and requires the
diagnostic to be attributed to *each* of the two modules by its own probe
route. `a1-server-only-RED.txt` records all three single- and double-module
mutations failing by name.
