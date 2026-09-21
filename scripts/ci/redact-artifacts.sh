#!/usr/bin/env bash
# Redact URL query strings inside every artifact before CI uploads it.
#
# THE LEAK THIS CLOSES. `e2e/harness/redact.ts` strips query strings from
# everything the HARNESS prints — failure messages, attachments, committed
# transcripts. It cannot reach Playwright's own recordings: the trace is
# written by the browser driver before any harness code sees it. An independent
# verifier drove the production server with
# `/media/photo.jpg?X-Amz-Signature=<value>&X-Amz-Expires=60` and found the
# value REDACTED in every harness line and in browser-signals.json, and present
# VERBATIM inside `trace.zip` members `1-trace.network` and `1-trace.trace` —
# which `.github/workflows/e2e.yml` uploads as a 14-day downloadable artifact.
#
# From M1, when vizra-core issues signed media URLs (ADR-005), the first red
# browser lane on a page holding one would publish that signed URL in full. The
# meta `AGENTS.md` forbids exactly that ("Never log credentials, private signed
# URLs, or raw private metadata"), so it is fixed here rather than recorded as a
# future problem.
#
# THE CHOICE MADE, of the two the chair offered: **redact in place and keep
# uploading traces.** Dropping trace.zip would make every future red lane
# undiagnosable, which is the opposite of what the artifact upload is for. So
# the query string goes and the origin, path and everything else stays — the
# same trade `redact.ts` makes, applied to bytes the harness never touched.
#
# WHAT IT DOES. For every text-shaped file under the given directories, and for
# every member of every `.zip` among them (trace.zip, and the HTML report's
# `data/*.zip`), replace the query string and fragment of every URL with
# `?<redacted>`, keeping scheme, host and path. BOTH absolute
# (`https://host/p?q`) and RELATIVE (`/p?q`) URLs — the relative case is the
# common one in a Next application, and the first version of this script missed
# it, which the D9 demonstration caught. Byte-level substitution, so JSON
# members stay valid JSON (`<redacted>` contains no quote, backslash or control
# character).
#
# WHAT IT DELIBERATELY DOES NOT TOUCH, beyond the binaries below: request and
# response BODIES (`postData`, and the resource blobs a trace stores). A
# credential in a POST body is a different shape from a query string and is out
# of this script's stated scope; if a slice ever posts one, that is the slice's
# problem to raise, and `scripts/e2e/sweep-artifacts.sh` is the tool to prove it.
#
# WHAT IT DELIBERATELY DOES NOT TOUCH: `.png`, `.jpg`, `.webm`, `.mp4`, fonts.
# Those are compressed or encoded containers where a byte-level substitution
# could corrupt the file, and a URL cannot appear in one as greppable text —
# a screenshot of a page is pixels, not a string. `scripts/e2e/demonstrate.sh`
# (D9) greps EVERY member of the produced artifacts for a sentinel signature
# value, binary files included, so this exclusion is verified rather than
# assumed.
#
# Usage:  bash scripts/ci/redact-artifacts.sh [dir ...]
# Default: test-results playwright-report
set -euo pipefail

dirs=("$@")
[ ${#dirs[@]} -gt 0 ] || dirs=(test-results playwright-report)

for tool in perl unzip zip; do
  command -v "$tool" > /dev/null 2>&1 || {
    echo "::error::redact-artifacts: '$tool' is not available; this is BLOCKED, not a pass." >&2
    exit 2
  }
done

# The substitution, applied to raw bytes. `$1` below is PERL's capture group,
# not a shell parameter, which is why the program is single-quoted and why
# SC2016 is suppressed on the line rather than "fixed" by switching to double
# quotes — double quotes would make the shell expand `$1` to this script's
# first argument and silently delete the host and path from every URL.
# (A comment line here may not begin with the linter's own name, or the linter
# reads the prose as a malformed directive.)
#
#   ((?:https?|wss?|ftp)://[^\s"'<>\\)\]]*?)   scheme, host and path, non-greedy
#   [?#][^\s"'<>\\)\]]*                        the query and/or fragment
#
# The terminator class includes the characters that end a URL inside JSON, HTML
# and log prose, so a match stops at the URL rather than running to end of line.
# shellcheck disable=SC2016
ABSOLUTE_PROGRAM='s{((?:https?|wss?|ftp)://[^\s"'"'"'<>\\)\]]*?)[?\#][^\s"'"'"'<>\\)\]]*}{$1?<redacted>}g'

# RELATIVE URLs need the same treatment, and the first version of this script
# missed them. The demonstration caught it: the trace recorded
# `/__vizra_e2e_fixture__/media/photo.jpg?X-Amz-Signature=...` as the ARGUMENT
# of a page call, with no scheme and no host, so the absolute pattern above did
# not match and the sentinel survived into `1-trace.network` and
# `1-trace.trace`. A Next application emits relative URLs everywhere — this is
# the common case, not the exotic one.
#
#   (^|[\s"'(\[=,>])      a boundary, so ordinary prose is not rewritten
#   (/[A-Za-z0-9._~%/+-]*)  a URL PATH and nothing else
#   [?#]…                   the query and/or fragment
# shellcheck disable=SC2016
RELATIVE_PROGRAM='s{(^|[\s"'"'"'(\[=,>])(/[A-Za-z0-9._~%/+-]*)[?\#][^\s"'"'"'<>\\)\]]*}{$1$2?<redacted>}g'

# AND THE SCHEME-LESS FORM, WHICH IS HOW PLAYWRIGHT WRITES A STEP SUBTITLE.
#
# An independent verifier reduced the gap to three lines against this script
# (PR #3 re-verification, FINDING 13):
#
#   "url":"http://host/m.jpg?X-Amz-Sig=SENTINELVALUE&e=60"     -> ?<redacted>  OK
#   "path":"/m.jpg?X-Amz-Sig=SENTINELVALUE&e=60"               -> ?<redacted>  OK
#   "subtitle":"host:3219/m.jpg?X-Amz-Sig=SENTINELVALUE&e=60"  -> UNCHANGED    LEAK
#
# The absolute program requires `scheme://` and the relative program requires
# the match to begin at `/`; `host:port/path?query` satisfies neither. Playwright
# DROPS THE SCHEME when it writes a `test.trace` step subtitle, so any
# `page.goto(signedUrl)` produces one — measured in a probe as
# `"title":"Navigate","subtitle":"127.0.0.1:3987/media/p.jpg?X-Amz-Signature=…"`
# beside a `params.url` the absolute program does catch. The verifier measured a
# sentinel going 3 members -> 1 after redaction, surviving in `test.trace`.
#
# D9 never exercised this: its fixture injects the signed URL as a SUB-RESOURCE
# (`img.src = url`) and navigates to `/`, and a sub-resource never becomes a step
# subtitle. The demonstration was sound for what it covered and blind to this.
#
#   (^|[\s"'(\[=,>])              a boundary, so prose is not rewritten
#   ((?:[\w-]+\.)+[\w-]+(?::\d+)?  a DOTTED host (or IPv4), optional port
#    |[\w-]+:\d{1,5}              or ANY label with an explicit :port
#    |localhost)                  or bare localhost
#   (/[^\s"'<>\\)\]?\#]*)          a path, which MUST start at `/`
#   [?#]…                        the query and/or fragment
#
# The bare-label alternative is what makes the verifier's own reduction line
# redact: `host:3219/m.jpg?…` has an undotted hostname, which a dotted-only
# pattern misses, and a dotted-only pattern was the first version of this. The
# price is deliberate OVER-redaction: `1:23/foo?x=y` in prose would be rewritten
# too. That costs a little diagnostic text and leaks nothing, which is the right
# way round — `see step 3/4?` has no authority and no path and is untouched.
# `e2e/harness/redact.ts` carries the same shape for the harness's own output.
# shellcheck disable=SC2016
AUTHORITY_PROGRAM='s{(^|[\s"'"'"'(\[=,>])((?:[\w-]+\.)+[\w-]+(?::\d+)?|[\w-]+:\d{1,5}|localhost)(/[^\s"'"'"'<>\\)\]?\#]*)[?\#][^\s"'"'"'<>\\)\]]*}{$1$2$3?<redacted>}g'

# AND THE STRUCTURED COPY. A trace's `*.network` member is HAR-shaped, and HAR
# stores the query a SECOND time, parsed into fields:
#
#   "queryString":[{"name":"X-Amz-Signature","value":"…"},{"name":"X-Amz-Expires","value":"60"}]
#
# No URL rewriting can reach that, because it is not a URL. The D9
# demonstration found the sentinel surviving here after both programs above had
# run — which is exactly why the demonstration greps every member rather than
# trusting the regexes. The array is emptied rather than filtered: deciding
# which parameter names are sensitive is a list someone forgets to update, and
# the URL line right beside it still names the host and path.
# shellcheck disable=SC2016
HAR_QUERY_PROGRAM='s{"queryString":\[[^\]]*\]}{"queryString":[]}g'

# Extensions excluded from byte rewriting (see the header).
BINARY_PRUNE=(-name '*.png' -o -name '*.jpg' -o -name '*.jpeg' -o -name '*.gif' \
  -o -name '*.webm' -o -name '*.mp4' -o -name '*.woff' -o -name '*.woff2' -o -name '*.ico')

# redact_tree ROOT [extra find predicates...] -> prints the number of files rewritten
redact_tree() {
  local root=$1
  shift
  local count=0 file
  while IFS= read -r -d '' file; do
    perl -0777 -pi -e "$ABSOLUTE_PROGRAM" "$file"
    perl -0777 -pi -e "$RELATIVE_PROGRAM" "$file"
    perl -0777 -pi -e "$AUTHORITY_PROGRAM" "$file"
    perl -0777 -pi -e "$HAR_QUERY_PROGRAM" "$file"
    count=$((count + 1))
  done < <(find "$root" -type f ! \( "${BINARY_PRUNE[@]}" \) "$@" -print0)
  printf '%s' "$count"
}

total_files=0
total_zips=0

for dir in "${dirs[@]}"; do
  if [ ! -d "$dir" ]; then
    echo "redact-artifacts: $dir does not exist, nothing to redact there."
    continue
  fi

  # 1. Zip members first: unzip, redact the tree, repack in place. Done before
  #    the plain-file pass, which then skips `*.zip` — running the byte
  #    substitution over a compressed archive could corrupt it.
  while IFS= read -r -d '' archive; do
    absolute=$(cd "$(dirname "$archive")" && pwd)/$(basename "$archive")
    work=$(mktemp -d)
    if ! unzip -qq -o "$absolute" -d "$work" > /dev/null 2>&1; then
      rm -rf "$work"
      echo "::warning::redact-artifacts: could not open $archive; removing it rather than uploading unredacted bytes." >&2
      rm -f "$absolute"
      continue
    fi
    redact_tree "$work" > /dev/null
    rm -f "$absolute"
    # Repack from inside the tree so member paths stay relative, as Playwright
    # expects. `-X` drops extra file attributes; `-r` recurses; `-q` is quiet.
    if ! (cd "$work" && zip -qXr "$absolute" .); then
      echo "::error::redact-artifacts: failed to repack $archive" >&2
      rm -rf "$work"
      exit 1
    fi
    rm -rf "$work"
    total_zips=$((total_zips + 1))
  done < <(find "$dir" -type f -name '*.zip' -print0)

  # 2. Everything else: error-context.md, results.json, the HTML report,
  #    stdout/stderr captures, the recorded browser revision.
  n=$(redact_tree "$dir" ! -name '*.zip')
  total_files=$((total_files + n))
done

echo "OK: redacted URL query strings (absolute, relative and authority-relative) in ${total_files} file(s) and ${total_zips} archive(s) across: ${dirs[*]}"
