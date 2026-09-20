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
};

export default nextConfig;
