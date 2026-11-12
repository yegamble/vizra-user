# QUEUE-2f — CI job-log filtering proof (VZ-FOUND-008)

Builder evidence, not a verdict. Date 2026-11-12. Repo yegamble/vizra-user, branch fix/2f-joblog-timeout.

## Sentinel (RED)
- Commit `37e03f7e60ae0e0a6fed103d531d7f1cbbf4d412`: temporary edit of `e2e/specs/shell.spec.ts:20`
  (`toHaveText("Skip to content")` → `toHaveText("SENTINEL-abcPW")`). No new spec; nothing authenticates.
- e2e run: https://github.com/yegamble/vizra-user/actions/runs/43290238134 — job `e2e` conclusion **failure**.
- `gh run view 43290238134 -R yegamble/vizra-user --log > /tmp/2f-sentinel.log` (1016 lines):
  - failure reported: `✘ ... shell.spec.ts:13:7 › app shell › has one banner, one main, and the skip link first in the document`
    (desktop-1440 and mobile-390, plus retries), `expect(locator).toHaveText(expected) failed`,
    `Locator:  locator(<withheld>).first()`, `Timeout:  10000ms`, `at .../e2e/specs/shell.spec.ts:20:25`, summary `2 failed`.
  - Expected/received lines appear only as `(N line(s) withheld from the public log)`.
  - `grep -c SENTINEL-abcPW /tmp/2f-sentinel.log` → **0**; `grep -c abcPW` → **0**.

## Revert (GREEN)
- Commit `9b020a40c44c3b8e84a799d1622f9194315b1c9b` = `git revert` of the sentinel (no force-push); tree identical to `6407655`.
- e2e run: https://github.com/yegamble/vizra-user/actions/runs/43290823132 — **success**, `42 passed`.
  The only `✘` lines are the four intentional harness-canary RED demos (console-error, failed-request, uncaught-exception, aborted-request).
- `grep -c SENTINEL-abcPW /tmp/2f-revert.log` → **0**.
