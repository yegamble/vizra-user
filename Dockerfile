# syntax=docker/dockerfile:1
#
# Production image for vizra-user, built on Next's standalone output
# (next.config.ts sets `output: "standalone"`). Multi-stage, so the runtime
# image ships only the pruned server bundle plus static assets.
#
# RUNTIME CONFIGURATION, NOT BUILD CONFIGURATION. Nothing about a deployment is
# baked in: `INTERNAL_API_BASE_URL` and `PUBLIC_ORIGIN` are read per request by
# lib/config.ts (ADR-002 — the env file is boot truth), so one image serves any
# host. There is deliberately no `NEXT_PUBLIC_*` build argument: a value baked
# into the browser bundle would make the image host-specific and would be one
# more thing an operator could get wrong in a way no probe reports.
#
# PLATFORM. ADR-009 fixes the acceptance platform at linux/amd64 on Ubuntu
# 24.04; the docker-build CI lane builds exactly that. A native arm64 build
# works for development and carries no support claim.
#
# BASE IMAGE PIN. The tag below is the Node version `.nvmrc` pins — keep the
# two in step, as AGENTS.md ("Pins") requires — and the `@sha256:` digest makes
# the reference immutable. A tag alone, even an exact patch tag, can be
# repointed by the registry, which would change what ships with no diff and no
# review; this repository already refuses mutable references for GitHub Actions
# (40-character commit SHAs) and for the codegen generator and spec (version +
# sha256), and the base image was the last input that escaped that standard.
#
#   digest:   sha256:9bef0ef1e268f60627da9ba7d7605e8831d5b56ad07487d24d1aa386336d1944
#   resolved: 2026-09-20, `docker buildx imagetools inspect node:22.14.0-alpine`
#   kind:     multi-arch OCI index (application/vnd.oci.image.index.v1+json),
#             NOT a per-platform manifest — so linux/amd64 in CI and an arm64
#             development machine resolve the same pin.
#
# `scripts/ci/check-image-pins.sh` (run by ci-guard) asserts every FROM carries
# a 64-character digest and that every node tag still matches `.nvmrc`, so
# bumping the Node version without re-resolving the digest is a red lane rather
# than a silent mismatch. Re-resolve with the command above and take the
# top-level `Digest:`.

# --- deps: install exactly what the lockfile pins -------------------------
FROM node:22.14.0-alpine@sha256:9bef0ef1e268f60627da9ba7d7605e8831d5b56ad07487d24d1aa386336d1944 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# --- builder: compile the standalone server -------------------------------
FROM node:22.14.0-alpine@sha256:9bef0ef1e268f60627da9ba7d7605e8831d5b56ad07487d24d1aa386336d1944 AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# --- runner: minimal production runtime ------------------------------------
FROM node:22.14.0-alpine@sha256:9bef0ef1e268f60627da9ba7d7605e8831d5b56ad07487d24d1aa386336d1944 AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# `apk upgrade` in the runner stage only — the one stage that ships. The base
# image lags its package repository, so a plain rebuild would re-ship the
# base's copy of a package that has since been fixed. The honest trade-off:
# two builds of one commit can then differ in patch-level packages, which is
# why the release records what it resolved rather than assuming.
# `-G nodejs` matters: BusyBox `adduser` without it puts the user in `nogroup`,
# so the `--chown=nextjs:nodejs` below would set a group the runtime user is
# not in — inert today, and a confusing failure the first time anything relies
# on group permissions (a writable cache directory, say).
#
# The package managers go with it. This stage runs `node server.js` and never
# installs anything: the standalone output already carries its own pruned
# `node_modules`, and `npm`, `npx`, `yarn` and `corepack` exist here only
# because the base image ships them. They are not merely dead weight — on
# 2026-09-20 they were the WHOLE of this image's vulnerability surface. Trivy
# 0.70.0 over the built image found 0 findings in the Alpine packages, 0 in the
# application's bundled node_modules, and 53 (3 CRITICAL, 35 HIGH) in npm's own
# vendored tree (`tar`, `minimatch`, `glob`, `pacote`, `sigstore`, …), every
# one of them under /usr/local/lib/node_modules/npm. `npm audit` over our
# lockfile reported none of these, because they are not our dependencies —
# which is exactly why the image scan exists alongside the dependency scan.
# Deleting them removes the surface instead of documenting it, and leaves a
# shell in the runtime with nothing to install with.
#
# The paths are globbed and the removal is ASSERTED: `rm -rf` on a path that
# does not exist succeeds silently, so a future base image that moved them
# would otherwise re-ship them with the build still green.
RUN apk upgrade --no-cache \
  && rm -rf /usr/local/lib/node_modules/npm \
            /usr/local/lib/node_modules/corepack \
            /opt/yarn-* \
            /usr/local/bin/npm /usr/local/bin/npx \
            /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
  && for gone in npm npx yarn yarnpkg corepack; do \
       if command -v "$gone" > /dev/null 2>&1; then \
         echo "runner stage: $gone survived removal at $(command -v "$gone")" >&2; \
         exit 1; \
       fi; \
     done \
  && node --version \
  && addgroup -S -g 1001 nodejs \
  && adduser -S -u 1001 -G nodejs nextjs
# Standalone output bundles a minimal server plus a pruned node_modules; the
# static assets and public/ must be copied alongside it.
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
# Liveness only, matching app/health/page.tsx: this says the process renders,
# not that vizra-core is reachable.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
