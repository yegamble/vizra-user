import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit a self-contained production server (.next/standalone) so the Docker
  // image runs `node server.js` against a pruned node_modules. See Dockerfile.
  output: "standalone",
  // Never advertise the framework version to every visitor.
  poweredByHeader: false,
  // `next build` must fail the same way `npm run typecheck` does. Next can be
  // told to ignore type errors during builds; saying so explicitly here means a
  // later edit that flips it is a reviewable diff, not a default.
  // (Next 16 removed `next lint` and the `eslint` config key — linting is
  // `npm run lint`, a separate step of `npm run ci`.)
  typescript: { ignoreBuildErrors: false },
  // `next dev` otherwise WRITES to the checked-in AGENTS.md and CLAUDE.md,
  // appending a managed `nextjs-agent-rules` block on every start (observed
  // 2026-09-20: `next dev` added ten lines to AGENTS.md, the engineering
  // contract, as an uncommitted change). A framework that edits the contract
  // file is not acceptable — the contract is reviewed, not generated — and it
  // also makes the browser lane's dev-server demonstration dirty the tree every
  // time it runs. `NextConfig.agentRules` (node_modules/next/dist/server/
  // config-shared.d.ts) turns it off; the version-matched docs it points at are
  // still on disk for anyone who wants them.
  agentRules: false,
};

export default nextConfig;
