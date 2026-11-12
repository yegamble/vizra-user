#!/usr/bin/env bash
# VZ-FOUND-004 negative case: the deps-scan verdict (`npm audit
# --audit-level=high`) must FAIL on a known-vulnerable lockfile. Runs that exact
# command against a fixture lockfile (lodash 4.17.20, high advisories). Nothing
# is installed: npm audit reads only the lockfile, and the fixture is not part
# of this repo's dependency tree.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
fixture="$here/fixtures/audit-vulnerable"
if (cd "$fixture" && npm audit --audit-level=high >/dev/null 2>&1); then
  echo "::error::npm audit --audit-level=high PASSED a lockfile with a known high advisory; the deps-scan verdict is not a gate" >&2
  exit 1
fi
cd "$fixture"
out=$(npm audit --json 2>/dev/null) || true
if ! grep -q '"lodash"' <<<"$out"; then
  echo "::error::npm audit failed but did not report the fixture advisory (registry unreachable?) — not evidence" >&2
  exit 1
fi
echo "OK: npm audit --audit-level=high fails on the vulnerable fixture (lodash 4.17.20)."
