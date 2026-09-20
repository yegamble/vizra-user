# The CI artifact path, executed once on purpose (FINDING 5 + FINDING 4)

The verifier's FINDING 5: the `e2e` lane's `if: failure()` artifact upload had
**never run** — both runs of the lane in this repository's history were green —
so nobody had seen it produce a downloadable trace, and `if-no-files-found: warn`
would have made a wrong path a warning nobody reads. The VZ-FOUND-008 ledger
entry asks for "CI artifact links; retained traces for a deliberately failing
spec". This is that evidence.

A throwaway branch (`chore/e2e-artifact-upload-proof`) and pull request
(yegamble/vizra-user#4, based on `feat/m0-browser-env`, **never merged**) added
one spec that fails for a real reason — the page requests a resource the
production server answers 404 — and that carries a signed-URL-shaped query
string, so the same run also proves FINDING 4's redaction on bytes GitHub
actually stored. The branch and the PR were deleted immediately afterwards.

## The run
- Workflow run: <https://github.com/yegamble/vizra-user/actions/runs/35536837315>
- Job: `e2e` — **failed**, as intended (the deliberately failing spec)
- Platform: GitHub-hosted `ubuntu-24.04`, linux/amd64 (the ADR-009 acceptance platform)
- `ci-required`: **failed**, correctly — a red required lane blocks the merge

## The artifact GitHub stored
```
  name: playwright-artifacts-35536837315-1
  id: 10612777314
  size: 1251268 bytes
  expired: false
```
Download URL (14-day retention):
<https://github.com/yegamble/vizra-user/actions/runs/35536837315/artifacts/10612777314>

The redaction step ran before the upload:
```
e2e	Redact URL query strings in the artifacts	2026-09-20T20:53:22.3988472Z OK: redacted URL query strings in 26 file(s) and 8 archive(s) across: test-results playwright-report
```
and the upload step reported `With the provided path, there will be 48 files
uploaded` — so `if-no-files-found: error` had files to find, and the path in
the workflow is correct.

## The sweep, over the DOWNLOADED artifact
Not over local bytes: the artifact was downloaded with
`gh run download 35536837315 --name playwright-artifacts-35536837315-1` and
searched with the same script the demonstrations use.

```
$ bash scripts/e2e/sweep-artifacts.sh "SENTINEL-SIGNATURE-DO-NOT-SHIP" <downloaded> "__vizra_e2e_fixture__/media/photo.jpg"
searched:  182 file(s), 8 archive(s) unpacked, under /private/tmp/claude-501/ciart
members containing the sentinel: 0
members still naming the request path: 46
OK: the sentinel appears in no member, and the request path is still readable.
```
Exit 0.

**182 files, 8 archives unpacked, the sentinel in zero members, and the request
path still readable in 46.** Redacted and still diagnosable — which is the whole
trade: dropping `trace.zip` would have satisfied the privacy requirement by
making every future red lane undiagnosable.

## What this does and does not establish
- It **does** establish that the `if: failure()` path executes, that the paths
  in the workflow are right, that the artifact is retrievable, and that a
  signed-URL-shaped query string does not survive into it.
- It does **not** establish anything about a real signed URL from vizra-core,
  which does not exist yet. The sentinel is shaped like one; it is not one.
- The proof PR was based on `feat/m0-browser-env`, not on `main`, and was
  closed without merging. Nothing from it is in this pull request except this
  file.
