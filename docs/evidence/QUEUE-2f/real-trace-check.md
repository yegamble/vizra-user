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
