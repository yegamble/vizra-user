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

# --- deps: install exactly what the lockfile pins -------------------------
FROM node:22.14.0-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# --- builder: compile the standalone server -------------------------------
FROM node:22.14.0-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# --- runner: minimal production runtime ------------------------------------
FROM node:22.14.0-alpine AS runner
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
RUN apk upgrade --no-cache \
  && addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs
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
