# When the redactor fails, nothing is uploaded (FINDING 7)

The verifier's FINDING 7: the redaction step and the upload step both carried a
bare `if: failure()`. GitHub's `failure()` is true whenever **any** earlier step
failed, so the two were not a sequence — a redactor that exits non-zero (exit 2
on a missing `perl`/`unzip`/`zip`, exit 1 on a repack failure) satisfied its own
condition and the **unredacted** tree was published for 14 days.

The fix: `id: redact` on the redaction step, and
`if: failure() && steps.redact.outcome == 'success'` on the upload.
`scripts/ci/check-e2e-lane.mjs` asserts that exact relationship, and six cases in
`scripts/ci/require-checks_test.sh` drive it with mutated workflows (upload on
bare `failure()`, gated on the wrong step, gated on "ran" rather than
"succeeded", redact step with no `id`, redact step `continue-on-error`, redaction
after the upload).

Those cases prove the **guard**. This proves the **gate**, in GitHub's own
expression evaluator, which no local test can exercise.

## The run
A throwaway branch (`chore/e2e-redactor-failure-proof`) and pull request
(yegamble/vizra-user#5, based on `feat/m0-browser-env`, **never merged**) added a
spec that fails for a real reason — a 404 sub-resource — so the artifact steps
would run at all, and forced the redaction step to `exit 2`, the code a missing
tool produces. Both were deleted immediately afterwards.

- Workflow run: <https://github.com/yegamble/vizra-user/actions/runs/35538966116>
- Platform: GitHub-hosted `ubuntu-24.04`, linux/amd64
- `e2e`: **failed**. `ci-required`: **failed** — a red required lane blocks the merge.

## Step outcomes, from the API
```
  success	Set up job
  success	Run actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
  success	Run actions/setup-node@820762786026740c76f36085b0efc47a31fe5020
  success	Install dependencies
  success	Install the pinned Chromium
  success	Record the browser revision
  success	Build the production image (linux/amd64)
  success	The image contains no browser-harness file or fixture
  success	Start the production image
  failure	Browser lane (desktop 1440, mobile 390)
  skipped	The coverage floor was actually satisfied
  success	Container logs
  failure	Redact URL query strings in the artifacts
  skipped	Upload Playwright artifacts
  success	Stop the container
  skipped	Post Run actions/setup-node@820762786026740c76f36085b0efc47a31fe5020
  success	Post Run actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
  success	Complete job
```

The browser lane failed (as designed), the redaction step **failed** (forced),
and the upload step is **skipped** — not failed, not partially run. Skipped.

## Artifacts published
```
  total_count: 0
```

**Zero.** Compare the same workflow with a healthy redactor, three hours
earlier: run 35536837315 published `playwright-artifacts-35536837315-1`,
1,251,268 bytes, 48 files (`ci-artifact-proof.md`). The only difference between
the two runs is whether the redaction succeeded.

## What this establishes
- The privacy control is **fail-closed**: if redaction does not succeed, nothing
  leaves the runner. A red lane with no artifact is a worse debugging
  experience and the correct one.
- It is the gate, not the guard, that was tested here — GitHub evaluated
  `steps.redact.outcome == 'success'` and skipped the step.
- It does **not** establish anything about a real credential; nothing in this
  repository authenticates yet, which is the subject of the hard line in
  `AGENTS.md` and of `e2e/harness/no-credentials-in-specs.test.ts`.
