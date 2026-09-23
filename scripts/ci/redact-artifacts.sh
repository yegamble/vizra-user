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
# A DIRECTORY THAT DOES NOT EXIST IS REFUSED - exit 3 - and never "nothing to
# redact". This used to print "does not exist, nothing to redact there" and carry
# on, so `redact-artifacts.sh test-result playwright-reports` (a typo) or
# `redact-artifacts.sh /tmp/empty` exited 0 having redacted and gated nothing,
# and the upload gated on this step's SUCCESS published the real tree (PR #8,
# R3-FINDING H). The CI step's bytes are now pinned
# (`.github/e2e-pinned-steps.yml`), and this is the second half: no argument can
# empty the gate.
#
# The case this makes red on purpose: the step runs only `if: failure()`, and when
# the failure came BEFORE the lane (the image did not build, the container did not
# start) neither directory exists. Then this exits 3, the upload is skipped, and
# nothing is published - which is correct, because there is nothing the lane wrote
# to diagnose, and a gate that reports success over an absent tree is the defect
# being fixed. The build or start step's own log carries that failure.
#
# Usage:  bash scripts/ci/redact-artifacts.sh [dir ...]
# Default: test-results playwright-report
set -euo pipefail

dirs=("$@")
[ ${#dirs[@]} -gt 0 ] || dirs=(test-results playwright-report)

for dir in "${dirs[@]}"; do
  if [ ! -d "$dir" ]; then
    echo "::error::redact-artifacts: '$dir' is not a directory. Every directory named here must exist:" \
      "a missing or mistyped one would otherwise be redacted and gated by nothing while this step" \
      "reports success. Nothing will be uploaded." >&2
    exit 3
  fi
done

for tool in perl unzip zip; do
  command -v "$tool" > /dev/null 2>&1 || {
    echo "::error::redact-artifacts: '$tool' is not available; this is BLOCKED, not a pass." >&2
    exit 2
  }
done

# THE URL PROGRAMS ARE SHARED WITH e2e/harness/redact.ts, NOT COPIED.
#
# This script used to carry its own four perl programs, and AGENTS.md said they
# were "the same four programs" as the harness redactor. An independent verifier
# showed otherwise (PR #8, R2-FINDING C): a fully slash-escaped
# `https:\/\/host\/p?sig=...` was redacted by the harness and SURVIVED here, and
# the double-escaped form Playwright writes when a spec prints a slash-escaped URL
# survived both - into `results.json` and `trace.zip::test.trace`, both uploaded,
# after this script reported OK.
#
# So both redactors read `e2e/harness/redaction-patterns.json`, and
# `e2e/harness/redaction-corpus.test.ts` runs THIS script and the harness over one
# corpus and checks every output byte for byte. Each pattern has exactly one
# capture group - the kept prefix (boundary, scheme, authority, path) - and what
# it matches after that is replaced with `?<redacted>`. The history of how each
# shape was found - relative URLs (D9), the scheme-less step subtitle (PR #3
# F13), protocol-relative / IPv6 / uppercase / escaped (PR #8 F4), fully and
# double escaped and `&` (PR #8 R2-C) - is in AGENTS.md § Artifact privacy.
patterns=$(cd "$(dirname "$0")/../.." && pwd)/e2e/harness/redaction-patterns.json
[ -r "$patterns" ] || {
  echo "::error::redact-artifacts: $patterns is missing; there is nothing to redact WITH. BLOCKED, not a pass." >&2
  exit 2
}
perl -MJSON::PP -e 1 2> /dev/null || {
  echo "::error::redact-artifacts: perl's core JSON::PP module is not available; BLOCKED, not a pass." >&2
  exit 2
}
export VZ_REDACTION_PATTERNS=$patterns

# One perl process per file: load the shared programs, apply them in order, then
# the HAR program below. `$1` is PERL's capture group - hence single quotes.
# shellcheck disable=SC2016
URL_PROGRAMS='BEGIN {
  open(my $fh, "<", $ENV{VZ_REDACTION_PATTERNS}) or die "redaction patterns: $!";
  local $/; my $doc = JSON::PP::decode_json(<$fh>);
  # `<<NAME>>` is the fragment of that name, declared above its first use;
  # e2e/harness/redact.ts expands them the same way. Unknown names die.
  my %frag;
  my $expand = sub {
    my $p = shift;
    $p =~ s/<<([A-Za-z0-9_]+)>>/exists $frag{$1} ? $frag{$1} : die "redaction patterns: unknown fragment $1\n"/ge;
    die "redaction patterns: unexpanded placeholder in $p\n" if index($p, "<<") >= 0;
    $p;
  };
  $frag{ $_->{name} } = $expand->($_->{pattern}) for @{ $doc->{fragments} // [] };
  @VZ_PROGRAMS = map { my $p = $expand->($_->{pattern}); ($_->{flags} // "") =~ /i/ ? qr/$p/i : qr/$p/ } @{ $doc->{programs} };
  die "redaction patterns: no programs" unless @VZ_PROGRAMS;
}
for my $re (@VZ_PROGRAMS) { s/$re/$1?<redacted>/g }'

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
    perl -MJSON::PP -0777 -pi -e "$URL_PROGRAMS" "$file"
    perl -0777 -pi -e "$HAR_QUERY_PROGRAM" "$file"
    count=$((count + 1))
  done < <(find "$root" -type f ! \( "${BINARY_PRUNE[@]}" \) "$@" -print0)
  printf '%s' "$count"
}

# THE UPLOAD GATE FOR THE PAGE SNAPSHOT.
#
# `error-context.md`'s `# Page snapshot` section is an aria snapshot of the LIVE
# page - every DOM text node and every input's current value. The `e2e` job sets
# PLAYWRIGHT_NO_COPY_PROMPT=1 so Playwright never writes it, the lane guard
# refuses every route to change that it can read, and the harness asserts the
# value inside the Playwright worker. An independent verifier still turned the
# snapshot back on twice, by routes the static guard could not see (a step-level
# `env:`, then a committed `.npmrc`).
#
# So the last gate before upload does not ask HOW the variable was changed. If
# any file - or any member of any archive - carries that section heading, this
# script exits non-zero, and the upload step, which is gated on this step having
# SUCCEEDED, publishes nothing. The heading is Playwright's literal
# (`playwright/lib/errorContext.js`); `e2e/harness/redaction-corpus.test.ts` pins
# that it still is, so a Playwright bump that renames it is a red unit test
# rather than a silently blind gate.
PAGE_SNAPSHOT_HEADING='# Page snapshot'
refuse_page_snapshots() {
  local root=$1 label=$2 hits
  hits=$(grep -rlxF -- "$PAGE_SNAPSHOT_HEADING" "$root" 2> /dev/null || true)
  [ -z "$hits" ] && return 0
  echo "::error::redact-artifacts: a PAGE SNAPSHOT is present in $label - an aria snapshot of the" \
    "live page, carrying every DOM text node and input value. Nothing will be uploaded." >&2
  printf '%s\n' "$hits" | sed "s|^$root|  <$label>|" >&2
  echo "  PLAYWRIGHT_NO_COPY_PROMPT was not \"1\" in the Playwright process; see AGENTS.md § Artifact privacy." >&2
  exit 1
}

# THE UPLOAD GATE FOR PIXELS (PR #10 fix round 2; war-room rule R6: a failure
# signal must not be the publishing trigger).
#
# Lane A records no pixels: `screenshot` and `video` are "off", and the trace
# records no screencast frames. The harness checks the RESOLVED options at
# runtime, and that check is the EARLY control. An independent verifier fooled it
# twice with an option object the spec controls (a `toJSON()`, then getters that
# answer differently to the check), and produced pixels past it two more ways
# that turn the lane RED (replacing the branded fixtures, importing
# `@playwright/test` directly). A red lane is exactly when this step runs and the
# upload fires, so a red signal alone would have PUBLISHED those pixels.
#
# So, like the page-snapshot gate above, this does not ask HOW the pixels were
# produced. If a regular file under the named directories, or a member of a
# `.zip` among them, is an image or a video IN ONE OF THE SHAPES BELOW, this
# script exits 4, and the upload step, gated on this step having SUCCEEDED,
# publishes nothing. That covers what Playwright's recorders and capture APIs
# write. It is not a detector of every image: BMP, TIFF, ICO or JPEG XL bytes
# under another name, and a signature not at byte 0, are not recognised. Images
# inlined as `data:` URIs, links and archives this script does not open are
# refused by the two gates after this one. It identifies them:
#
#   - by NAME: `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, `.avif`, `.bmp`,
#     `.webm`, `.mp4`, `.mov` (case-insensitive), and any archive member whose
#     path contains `screencast` (Playwright's trace screencast frames);
#   - by CONTENT, whatever the name: the PNG, JPEG, GIF, WebP, Matroska/WebM
#     and ISO-BMFF (MP4, MOV, AVIF) signatures in the first 12 bytes, so a
#     renamed or extension-less attachment is refused too;
#   - in the JSON report: an attachment whose `contentType` is `image/*` or
#     `video/*`, because the JSON reporter can carry an attachment's bytes
#     inline, in no file of their own.
#
# It prints the offending PATH, relative to the directory it was given, and
# never any content.
PIXEL_NAME_RE='\.(png|jpe?g|webp|gif|avif|bmp|webm|mp4|mov)$'
pixel_magic() {
  # pixel_magic FILE -> exit 0 when the file's first 12 bytes carry an image or video signature
  local head
  head=$(head -c 12 "$1" 2> /dev/null | od -An -tx1 | tr -d ' \n')
  case "$head" in
    89504e47*) return 0 ;;                  # PNG
    ffd8ff*) return 0 ;;                    # JPEG
    47494638*) return 0 ;;                  # GIF
    52494646????????57454250*) return 0 ;;  # RIFF....WEBP
    1a45dfa3*) return 0 ;;                  # Matroska / WebM
    ????????66747970*) return 0 ;;          # ISO BMFF (ftyp): MP4, MOV, AVIF
  esac
  return 1
}
refuse_pixels() {
  local root=$1 label=$2 file relative hits=""
  while IFS= read -r -d '' file; do
    relative=${file#"$root"/}
    if printf '%s' "$relative" | grep -Eiq -- "$PIXEL_NAME_RE" ||
      printf '%s' "$relative" | grep -iq -- 'screencast' ||
      pixel_magic "$file"; then
      hits="${hits}  <${label}>/${relative}
"
    fi
  done < <(find "$root" -type f ! -name '*.zip' -print0)
  while IFS= read -r -d '' file; do
    if perl -MJSON::PP -0777 -ne '
      my $doc = eval { JSON::PP->new->decode($_) } or exit 1;
      my $found = 0;
      my $walk; $walk = sub {
        my ($n) = @_;
        if (ref $n eq "HASH") {
          $found = 1 if defined $n->{contentType} && !ref $n->{contentType}
            && $n->{contentType} =~ m{^(image|video)/}i;
          $walk->($_) for values %$n;
        } elsif (ref $n eq "ARRAY") { $walk->($_) for @$n }
      };
      $walk->($doc); exit($found ? 0 : 1);' "$file" 2> /dev/null; then
      hits="${hits}  <${label}>/${file#"$root"/} (an image or video attachment)
"
    fi
  done < <(find "$root" -type f -name '*.json' -print0)
  [ -z "$hits" ] && return 0
  echo "::error::redact-artifacts: IMAGE OR VIDEO bytes are present in $label - Lane A records no" \
    "pixels, and a screenshot, a video or a screencast frame is pixels no redactor can read." \
    "Nothing will be uploaded." >&2
  printf '%s' "$hits" >&2
  echo "  See AGENTS.md § Artifact privacy, \"Lane A records NO PIXELS\"." >&2
  exit 4
}

# THE UPLOAD GATE FOR IMAGES ENCODED AS TEXT (PR #10 close, FINDING 9).
#
# The pixel gate above reads NAMES and FIRST BYTES. An image a page inlines -
# `<img src="data:image/png;base64,...">`, a blur placeholder, an SVG
# `<image href="data:...">` - is neither: an independent verifier served one from
# a failing spec and recovered the whole PNG, as base64, from
# `trace.zip::1-trace.trace` (the DOM snapshot) and `resources/<sha1>.html` (the
# response body) after this script had printed OK. So any file, and any member of
# an opened archive, that contains `data:image/` or `data:video/` - any case, and
# with the slash written `\/` as JSON may write it - is refused, exit 4.
#
# ONE EXCEPTION, BY EXACT PATH, AND WHY. Playwright's HTML reporter writes its own
# viewer into `playwright-report/`: `index.html` inlines `report.js`, and
# `trace/assets/codeMirrorModule-*.js` is the trace viewer, and both carry
# `data:image/` literals in Playwright's OWN code (measured on a red run of
# 1.63.0: those two files and nothing else). Neither is uploaded - the upload is
# an allowlist of `test-results/`, `playwright-report/results.json` and
# `playwright-browsers.txt`, which `check-e2e-lane.mjs` enforces - so, under a
# directory named `playwright-report`, this scan skips `index.html` at its root
# and its `trace/` subtree, and nothing else. Every other gate still reads them.
#
# It does NOT decode anything: an image in base64 with no `data:` prefix, a hex
# dump, or any other encoding is not detected. AGENTS.md § Artifact privacy
# states that scope.
DATA_URI_RE='data:(image|video)\\*/'
refuse_data_uris() {
  local root=$1 label=$2 file relative rc hits="" report=""
  [ "$(basename "$root")" = "playwright-report" ] && report=1
  while IFS= read -r -d '' file; do
    relative=${file#"$root"/}
    if [ -n "$report" ]; then
      case "$relative" in index.html | trace/*) continue ;; esac
    fi
    rc=0
    LC_ALL=C grep -qaiE -- "$DATA_URI_RE" "$file" || rc=$?
    case "$rc" in
      0) hits="${hits}  <${label}>/${relative} (a data:image/ or data:video/ URI)
" ;;
      1) ;;
      *)
        echo "::error::redact-artifacts: could not read <${label}>/${relative} to look for an inlined image;" \
          "a file this gate cannot read is not a clean file. Nothing will be uploaded." >&2
        exit 2
        ;;
    esac
  done < <(find "$root" -type f -print0)
  [ -z "$hits" ] && return 0
  echo "::error::redact-artifacts: IMAGE OR VIDEO bytes are present in $label, encoded as a data: URI -" \
    "an image a page inlined, which the trace keeps in its DOM snapshot and response bodies." \
    "Nothing will be uploaded." >&2
  printf '%s' "$hits" >&2
  echo "  See AGENTS.md § Artifact privacy, \"Lane A records NO PIXELS\"." >&2
  exit 4
}

# THE UPLOAD GATE FOR WHAT THIS SCRIPT CANNOT INSPECT (PR #10 close, FINDING 9).
#
# Every check above reads regular files, and opens `.zip` archives one level
# deep. Three shapes went around that, each measured by an independent verifier:
#
#   - a SYMBOLIC LINK. `find -type f` skips it, and the pinned
#     `actions/upload-artifact` (v4.6.2) follows links by default, so a link to a
#     PNG outside the tree uploaded the PNG's bytes. A named directory that is
#     itself a link was skipped whole. And inside an opened archive a link is
#     worse: `zip -r` follows it when this script repacks, so the link's TARGET
#     would be stored in the re-packed trace. So anything under the named
#     directories, or inside an opened archive, that is neither a regular file
#     nor a directory - a link, a FIFO, a socket, a device - is refused;
#   - an ARCHIVE INSIDE AN ARCHIVE (a zip in a trace, a gzip or tar stream stored
#     as a resource) - refused rather than recursed into, by name or by
#     signature, whatever it is called;
#   - an archive this script does not open: at the top level only files NAMED
#     `*.zip` are opened, so a zip called `a.dat` or `trace.zip.bak`, a `.gz`, or
#     a tar was never looked inside. Any archive not named `*.zip` is refused.
#
# Exit 5, naming the path, never the content. Archives are recognised by name
# (`.zip .jar .gz .tgz .tar .bz2 .tbz .tbz2 .xz .txz .zst .7z .rar`, any case) and
# by signature: zip, gzip, bzip2, xz, zstd, 7z, rar at byte 0, and `ustar` at
# byte 257. An old-style (pre-POSIX) tar with no name and no `ustar` magic is not
# recognised.
ARCHIVE_NAME_RE='\.(zip|jar|gz|tgz|tar|bz2|tbz2?|xz|txz|zst|7z|rar)$'
archive_magic() {
  # archive_magic FILE -> exit 0 when the file carries an archive or compressed-stream signature
  local head tar
  head=$(head -c 8 "$1" 2> /dev/null | od -An -tx1 | tr -d ' \n')
  case "$head" in
    504b0304* | 504b0506* | 504b0708*) return 0 ;; # zip
    1f8b*) return 0 ;;                              # gzip
    425a68*) return 0 ;;                            # bzip2
    fd377a585a00*) return 0 ;;                      # xz
    28b52ffd*) return 0 ;;                          # zstd
    377abcaf271c*) return 0 ;;                      # 7z
    526172211a07*) return 0 ;;                      # rar
  esac
  tar=$(dd if="$1" bs=1 skip=257 count=5 2> /dev/null | od -An -tx1 | tr -d ' \n')
  [ "$tar" = "7573746172" ] # "ustar"
}
# refuse_uninspectable ROOT LABEL top|member
#   top:    ROOT is a directory named to this script; `*.zip` files are opened later
#   member: ROOT is an opened archive; any archive inside it is refused
refuse_uninspectable() {
  local root=$1 label=$2 mode=$3 file relative hits=""
  while IFS= read -r -d '' file; do
    relative=${file#"$root"/}
    [ "$file" = "$root" ] && relative="."
    hits="${hits}  <${label}>/${relative} (a symbolic link or other non-regular file)
"
  done < <(find "$root" ! -type f ! -type d -print0)
  while IFS= read -r -d '' file; do
    relative=${file#"$root"/}
    if [ "$mode" = "top" ]; then
      case "$relative" in *.zip) continue ;; esac
    fi
    if printf '%s' "$relative" | grep -Eiq -- "$ARCHIVE_NAME_RE" || archive_magic "$file"; then
      if [ "$mode" = "top" ]; then
        hits="${hits}  <${label}>/${relative} (an archive not named .zip, which this gate does not open)
"
      else
        hits="${hits}  <${label}>/${relative} (an archive inside an archive, which this gate does not open)
"
      fi
    fi
  done < <(find "$root" -type f -print0)
  [ -z "$hits" ] && return 0
  echo "::error::redact-artifacts: content the gate CANNOT INSPECT is present in $label - a symbolic" \
    "link (the upload action follows it), or an archive this script does not open. Nothing will be" \
    "uploaded." >&2
  printf '%s' "$hits" >&2
  echo "  See AGENTS.md § Artifact privacy, \"Lane A records NO PIXELS\"." >&2
  exit 5
}

# Before anything is unpacked or rewritten: a link or an unopened archive
# anywhere in what would be uploaded refuses the whole set.
for dir in "${dirs[@]}"; do
  refuse_uninspectable "$dir" "$dir" top
done

total_files=0
total_zips=0

for dir in "${dirs[@]}"; do
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
    refuse_uninspectable "$work" "$archive" member
    redact_tree "$work" > /dev/null
    refuse_page_snapshots "$work" "$archive"
    refuse_pixels "$work" "$archive"
    refuse_data_uris "$work" "$archive"
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
  refuse_page_snapshots "$dir" "$dir"
  refuse_pixels "$dir" "$dir"
  refuse_data_uris "$dir" "$dir"
done

echo "OK: redacted URL query strings with the shared programs (absolute, protocol-relative, authority-relative, path-relative) in ${total_files} file(s) and ${total_zips} archive(s), and no page snapshot is present, and no image or video is present in the shapes this gate reads (named or signed files and first-level .zip members, data:image/ and data:video/ URIs), and no link or unopened archive is present, across: ${dirs[*]}"
