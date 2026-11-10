#!/usr/bin/env bash
# THE LANE A UPLOAD GATE: stage ONE allowlisted text file, check it, and nothing else.
#
# The pinned `redact` step of .github/workflows/e2e.yml runs exactly
# `bash scripts/ci/redact-artifacts.sh` (see .github/e2e-pinned-steps.yml), and
# the upload step after it is gated on this step having SUCCEEDED and uploads
# exactly one directory, `e2e-artifacts/`, which this script creates.
#
# WHY AN ALLOWLIST (PR #10, chair ruling on war-room rule R3). The repositories
# are public, so every artifact is published. This script used to DETECT images
# in whatever Playwright wrote - by name, by signature, by `data:` prefix, by
# archive magic - and every verification round found another shape it missed:
# screencast frames, data URIs, symbolic links, nested archives, eight more
# compression formats, `data:application/octet-stream` images Chromium renders,
# a HAR recorded with `content: "embed"`, and an uploaded file it never read
# (PR #10 VERIFY FINDINGS 9-12; sentinel F-1, F-2). Detection over a space the
# code under test can write cannot be made complete. So the gate no longer asks
# what a file IS. It copies the bytes of exactly one file,
# `playwright-report/results.json`, into a fresh directory, checks those bytes,
# and the upload reads only that directory. A trace, the HTML report, a HAR, an
# archive, a screenshot, `error-context.md` or anything a spec wrote is never
# copied, so it is never published, whatever it holds. Traces, the HTML report
# and pixels belong to the private authenticated Lane B.
#
# WHY NOT error-context.md (security seat, PR #10 plan review, S-1). A failing
# locator assertion that resolves to no element makes Playwright write a
# whole-page aria snapshot - page text and typed input values - into
# `error-context.md` under `# Error details`, whatever PLAYWRIGHT_NO_COPY_PROMPT
# says. Everything else that file holds is already in `results.json`.
#
# THE CHECKS, each a whole-upload refusal, naming the rule and never the content:
# a real directory and a regular file (no link), at most 8 MiB, strict UTF-8, no
# control byte but TAB and LF, no run of more than 89 base64, base64url or hex
# characters (the measured limit - see redact-artifacts.pl), valid JSON, no
# `errorContext` key, no page-snapshot heading or ```yaml block, and no git
# metadata. URL query strings and fragments are redacted first, with the shared
# programs of e2e/harness/redaction-patterns.json. Then the staged directory is
# re-walked and must be exactly what was written.
#
# WHAT IT DOES NOT DO, stated (AGENTS.md § Artifact privacy, residuals R-A to
# R-D): text cannot be made image-proof - data written with separators, or
# under 67 bytes, passes the run rule; the public JOB LOG prints the same error
# text and stdout and no gate reads it; a process the code under test leaves
# running can write into `e2e-artifacts/` after this step; and a pull request
# can edit this workflow.
#
# Exit codes: 0 staged; 1 a page or matcher snapshot; 2 a read, write or tool
# error, or a usage error (fail closed); 3 `playwright-report/results.json` is
# absent; 4 a content rule; 5 a link, a non-regular file, or unexpected staged
# content; 6 `e2e-artifacts/` already exists.
#
# Usage:  bash scripts/ci/redact-artifacts.sh                 (the gate)
#         bash scripts/ci/redact-artifacts.sh --redact-stdin  (redaction only, a filter; for the corpus test)
#         bash scripts/ci/redact-artifacts.sh --verify-staging SHA256 SIZE  (the last check alone; for the unit test)
set -euo pipefail

command -v perl > /dev/null 2>&1 || {
  echo "::error::redact-artifacts: 'perl' is not available; this is BLOCKED, not a pass. Nothing will be uploaded." >&2
  exit 2
}
perl -MJSON::PP -MDigest::SHA -MFcntl -MErrno -e 1 2> /dev/null || {
  echo "::error::redact-artifacts: a core perl module (JSON::PP, Digest::SHA, Fcntl, Errno) is missing; BLOCKED, not a pass. Nothing will be uploaded." >&2
  exit 2
}
exec perl "$(cd "$(dirname "$0")" && pwd)/redact-artifacts.pl" "$@"
