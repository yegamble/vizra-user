# QUEUE-2f real-trace check (session 2, 2026-11-12)

Scratch copy of HEAD 8212193 at /tmp/vz2f-scratch (not on the branch), plus one
forced-failure spec `e2e/specs/zz-forced-fail.spec.ts` (expects `#does-not-exist`
on /health). Production build, then `npx playwright test` (config playwright.config.ts):
2 failed, 42 passed, exit 1. Then `bash scripts/ci/redact-artifacts.sh test-results playwright-report`: exit 1,
"51 refusal(s); nothing will be uploaded."

Refusals by reason: trace.zip members not allowlisted (resources/*.css|html,
screencast/*.jpeg, test.trace, attachments/<sha>) 18; trace events
dom-snapshot 4, body 4, call-parameters 2, console-text 2; HTML report
files (index.html, data/*.zip, trace viewer assets) 21.
Not refused: test-failed-1.png, video.webm, error-context.md, results.json, .last-run.json.

## Finding (OPEN)
The gate is all-or-nothing, so a real failing run uploads NOTHING — not even
the admitted screenshots. That fails the plan goal "a failing run still uploads
useful, safe evidence". Decisions per shape:
- trace.zip (dom snapshots, bodies, call params, console text, screencast): unsafe — keep refused.
- HTML report (embeds trace zips + page text): unsafe — keep refused.
- png / error-context.md / results.json: admitted today; error-context.md holds
  the page's aria snapshot and failure text — needs review before upload.
Remaining fix: gate should emit a filtered upload tree of admitted files plus a
text failure summary instead of refusing the whole upload. Not done this session.

## Session 3 (2026-11-12): filtered upload
Finding above addressed by `artifact-allowlist.mjs --stage artifact-upload DIR...`
(called from redact-artifacts.sh): copies only admitted `*.png|*.jpe?g|*.webm|results.json`
into `artifact-upload/`, writes a redacted `SUMMARY.txt` (failed title, file:line,
assertion message; URL queries, bearer/JWT/long tokens, header values, emails redacted),
logs every refused file as `REFUSED <path> <rule>`, then re-scans the staging tree
and exits 1 (deleting it) on any hit. The upload step and its pin upload `artifact-upload/`
plus `playwright-browsers.txt` only.
error-context.md: REFUSED (`not-staged`). It is the page outline plus the failure
message; the failure message already reaches SUMMARY.txt redacted from results.json, so
redacting error-context.md down to "the failure message only" would duplicate SUMMARY.txt
while keeping a page-content-shaped file in the upload path.
Red first: new `filtered upload` tests against HEAD c5026ae's gate: 3 failed (exit 1);
against the new gate: 19/19 passed.
