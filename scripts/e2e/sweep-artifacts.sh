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
# It searches a COPY, with every `.zip` unpacked beside itself AND every
# base64-embedded archive decoded and unpacked, so trace.zip members and the HTML
# report's base64 payload are both covered. `grep -a` treats binary files as
# text, so a `.png` or `.webm` carrying the value would be found too — which is
# what makes `redact-artifacts.sh`'s deliberate exclusion of those extensions a
# verified claim rather than an assumption.
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

# BASE64-EMBEDDED ARCHIVES, DECODED BEFORE THE SEARCH.
#
# `AGENTS.md` names this script as the proof that "no query string leaves this
# repository". It was not, and the gap is measured: Playwright's HTML reporter
# appends to `playwright-report/index.html`
# (`playwright/lib/runner/index.js:3704-3712`)
#
#     <template id="playwrightReportBase64">data:application/zip;base64,…</template>
#
# whose payload decodes (magic 504b0304) to a ZIP of the entire report dataset —
# error messages, step titles and subtitles, attachment bodies. A raw `grep -ral`
# over the tree cannot see any of it. In a probe, three planted markers — a
# scheme-less signed URL, a typed password and an assertion's received value —
# lived only inside that payload, and were STILL LIVE after
# `scripts/ci/redact-artifacts.sh` reported success, because that script rewrites
# index.html as TEXT and unpacks `*.zip` FILES only.
#
# So every base64 run long enough to be an archive is decoded, and anything whose
# magic says ZIP or gzip is unpacked beside it and searched with everything else.
# This is a SEARCH, so a false positive costs a wasted decode and nothing more —
# which is the right way round for a tool whose job is to find what should not be
# there.
decoded=0
while IFS= read -r -d '' html; do
  while IFS= read -r payload; do
    [ -n "$payload" ] || continue
    out=$scan/.decoded-$decoded.bin
    if printf '%s' "$payload" | base64 -d > "$out" 2> /dev/null && [ -s "$out" ]; then
      decoded=$((decoded + 1))
    else
      rm -f "$out"
    fi
  done < <(perl -0777 -ne 'while (/;base64,([A-Za-z0-9+\/=\s]{64,}?)(?:"|<)/g) { my $d = $1; $d =~ s/\s+//g; print "$d\n"; }' "$html")
done < <(find "$scan" -type f \( -name '*.html' -o -name '*.htm' \) -print0)

archives=0
while IFS= read -r -d '' archive; do
  unzip -qq -o "$archive" -d "${archive}.unzipped" > /dev/null 2>&1 || true
  archives=$((archives + 1))
done < <(find "$scan" -type f \( -name '*.zip' -o -name '.decoded-*.bin' \) -print0)

files=$(find "$scan" -type f | wc -l | tr -d ' ')
if [ "$files" -eq 0 ]; then
  echo "BLOCKED: $root contains no files — nothing was searched."
  exit 2
fi

echo "searched:  $files file(s), $archives archive(s) unpacked, $decoded base64 payload(s) decoded, under $root"

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
