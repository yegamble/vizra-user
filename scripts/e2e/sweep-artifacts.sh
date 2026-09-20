#!/usr/bin/env bash
# Search EVERY member of a produced artifact tree for a sentinel value.
#
# This is the acceptance check for the artifact-redaction requirement: "grep -r
# over every unzipped member finds the sentinel ZERO times, while the path and
# host remain readable for debugging". It is a script rather than a line in the
# demonstration because both halves of that demonstration need exactly the same
# search — the red half proves the leak is real, the green half proves it is
# closed — and a search that differed between them would prove nothing.
#
# It searches a COPY, with every `.zip` unpacked beside itself, so trace.zip
# members are covered. `grep -a` treats binary files as text, so a `.png` or
# `.webm` carrying the value would be found too — which is what makes
# `redact-artifacts.sh`'s deliberate exclusion of those extensions a verified
# claim rather than an assumption.
#
# It prints COUNTS and FILE NAMES, never matching lines: a transcript that
# reproduced the value would be the very thing being guarded against.
#
# Exit 0 when the sentinel appears nowhere, 1 when it appears anywhere, 2 when
# there is nothing to search (an empty artifact tree must not read as success).
#
# Usage:  bash scripts/e2e/sweep-artifacts.sh SENTINEL DIR [READABLE_MARKER]
set -euo pipefail

sentinel=${1:?usage: sweep-artifacts.sh SENTINEL DIR [READABLE_MARKER]}
root=${2:?usage: sweep-artifacts.sh SENTINEL DIR [READABLE_MARKER]}
readable_marker=${3:-}

command -v unzip > /dev/null 2>&1 || {
  echo "BLOCKED: unzip is not available, so archive members cannot be searched." >&2
  exit 2
}

[ -d "$root" ] || {
  echo "BLOCKED: $root does not exist — there are no artifacts to search."
  exit 2
}

scan=$(mktemp -d)
trap 'rm -rf "$scan"' EXIT
cp -R "$root/." "$scan/"

archives=0
while IFS= read -r -d '' archive; do
  unzip -qq -o "$archive" -d "${archive}.unzipped" > /dev/null 2>&1 || true
  archives=$((archives + 1))
done < <(find "$scan" -type f -name '*.zip' -print0)

files=$(find "$scan" -type f | wc -l | tr -d ' ')
if [ "$files" -eq 0 ]; then
  echo "BLOCKED: $root contains no files — nothing was searched."
  exit 2
fi

echo "searched:  $files file(s), $archives archive(s) unpacked, under $root"

# `|| true` on every grep: `set -o pipefail` is on, and grep exits 1 when it
# finds nothing — which is the SUCCESS case here. Without this the script
# vanished silently at exactly the moment the redaction started working.
hits=$(grep -ral -- "$sentinel" "$scan" 2> /dev/null | wc -l | tr -d ' ' || true)
echo "members containing the sentinel: $hits"
if [ "$hits" -gt 0 ]; then
  echo "members (names only — the value itself is never printed):"
  grep -ral -- "$sentinel" "$scan" 2> /dev/null | sed "s|^$scan|<artifacts>|" | head -20 || true
fi

if [ -n "$readable_marker" ]; then
  kept=$(grep -ral -- "$readable_marker" "$scan" 2> /dev/null | wc -l | tr -d ' ' || true)
  echo "members still naming the request path: $kept"
  if [ "$kept" -eq 0 ]; then
    echo "::error::redaction destroyed the diagnostic value: no member still names '$readable_marker'." >&2
    echo "  The artifact exists to make a red lane debuggable; host and path must survive." >&2
    exit 1
  fi
fi

if [ "$hits" -gt 0 ]; then
  echo "::error::the sentinel survives into the artifacts that CI would upload." >&2
  exit 1
fi

echo "OK: the sentinel appears in no member, and the request path is still readable."
