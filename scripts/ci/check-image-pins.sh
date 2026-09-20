#!/usr/bin/env bash
# Assert every Dockerfile base image is pinned to an immutable digest, and that
# its tag still names the Node version `.nvmrc` pins
# (security review FINDING 5; VZ-FOUND-002; ADR-001 pins, ADR-009 platform).
#
# WHY. This repository already refuses mutable references everywhere else:
# ci-guard rejects any GitHub Action not pinned to a 40-character commit SHA,
# and check-contract.mjs pins the codegen generator by version and the spec by
# sha256. The base image was the one input that escaped that standard —
# `node:22.14.0-alpine` is an exact patch tag, but a tag, and Docker Hub can
# repoint it. A repointed tag changes what ships with no diff and no review.
#
# WHAT IT CANNOT DO. Nothing offline can tell whether a digest is the RIGHT
# digest for a tag; that needs a registry round trip, which this check
# deliberately does not make (CI integrity checks that need the network fail
# for reasons unrelated to the code). What it can do, and does:
#
#   1. every `FROM` carries `@sha256:<64 hex>`;
#   2. every `node:` tag matches `.nvmrc`, so bumping the Node version without
#      touching the Dockerfile — which is what would leave a stale digest
#      behind — is a named red failure rather than a silent mismatch.
#
# Binding (1) and (2) together is what makes the digest maintainable: the
# version and the digest live on the same line, so the check that catches a
# drifting version also forces the digest to be re-resolved.
#
# Re-resolve a digest with:
#   docker buildx imagetools inspect node:<version>-alpine
# and take the top-level `Digest:` — the multi-arch INDEX digest, not a
# per-platform manifest, so linux/amd64 (the acceptance platform) and an arm64
# development machine both resolve from the same pin.
#
# Usage:  bash scripts/ci/check-image-pins.sh [dockerfile] [nvmrc]
# TWIN (intended): vizra-core and vizra-search carry the same script for their
# own images. Keep in step.
set -euo pipefail

dockerfile=${1:-Dockerfile}
nvmrc=${2:-.nvmrc}

[ -r "$dockerfile" ] || { echo "::error::image-pin guard: $dockerfile is missing" >&2; exit 1; }
[ -r "$nvmrc" ] || { echo "::error::image-pin guard: $nvmrc is missing" >&2; exit 1; }

node_version=$(tr -d '[:space:]' <"$nvmrc")
[ -n "$node_version" ] || { echo "::error::image-pin guard: $nvmrc is empty" >&2; exit 1; }

problems=""
stages=0

# `FROM <image>[ AS <stage>]`, comments and blank lines ignored. `FROM
# --platform=…` is accepted and its flags skipped; `FROM <earlier stage>` (a
# bare name with no registry path, tag or digest) is an internal reference and
# carries no pin of its own.
while IFS= read -r raw; do
  line=${raw%%#*}
  case $line in
    [Ff][Rr][Oo][Mm][[:space:]]*) ;;
    *) continue ;;
  esac

  # shellcheck disable=SC2086  # deliberate word splitting: FROM's arguments
  set -- $line
  shift                       # drop FROM
  while [ $# -gt 0 ]; do      # drop any --platform=… / --link style flags
    case $1 in
      --*) shift ;;
      *) break ;;
    esac
  done
  image=${1:-}
  [ -n "$image" ] || { problems="${problems}${raw}: FROM has no image"$'\n'; continue; }

  # A reference to an earlier stage: no registry, no tag, no digest.
  case $image in
    *:*|*/*|*@*) ;;
    *) continue ;;
  esac

  stages=$((stages + 1))

  case $image in
    *@sha256:[0-9a-f][0-9a-f]*)
      digest=${image##*@sha256:}
      case ${#digest} in
        64) ;;
        *) problems="${problems}${image}: @sha256 digest is ${#digest} characters, want 64"$'\n' ;;
      esac
      ;;
    *)
      problems="${problems}${image}: not pinned to an immutable @sha256 digest"$'\n'
      ;;
  esac

  # The Node tag must still be the version .nvmrc pins.
  case $image in
    node:*)
      tag=${image#node:}
      tag=${tag%%@*}
      case $tag in
        "$node_version"|"$node_version"-*) ;;
        *)
          problems="${problems}${image}: tag '${tag}' does not match ${nvmrc} ('${node_version}')"$'\n'
          ;;
      esac
      ;;
  esac
done < "$dockerfile"

if [ "$stages" -eq 0 ]; then
  echo "::error::image-pin guard: $dockerfile declares no external FROM — refusing to pass vacuously" >&2
  exit 1
fi

if [ -n "$problems" ]; then
  echo "::error::$dockerfile base images are not immutably pinned:" >&2
  printf '%s' "$problems" | sed 's/^/  /' >&2
  echo "  Re-resolve with: docker buildx imagetools inspect node:${node_version}-alpine" >&2
  echo "  and use the top-level (multi-arch index) Digest." >&2
  exit 1
fi

echo "OK: all $stages external FROM lines in $dockerfile are @sha256-pinned at node ${node_version}."
