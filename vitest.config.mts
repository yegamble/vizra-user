import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\//, replacement: fileURLToPath(new URL("./", import.meta.url)) },
      {
        // `server-only` is a marker package: its default entry point THROWS on
        // import, and only the `react-server` export condition resolves to the
        // empty module. Next applies that condition when it bundles a Server
        // Component; vitest runs plain Node, so without this alias every test
        // that imports lib/config.ts or lib/api/fetch.ts dies at import with
        // "This module cannot be imported from a Client Component module".
        //
        // The alias points at the PACKAGE'S OWN `empty.js` — the exact file the
        // `react-server` condition selects — rather than a stub written here,
        // so the tests resolve what Next resolves and nothing is faked.
        //
        // This is not a hole: the boundary `server-only` enforces is a BUNDLER
        // property and cannot be observed from vitest at all. It is asserted by
        // `scripts/ci/check-server-only-boundary.sh`, which builds a real
        // Client Component that imports both modules and requires `next build`
        // to fail with the server-only diagnostic attributed to each of them.
        find: /^server-only$/,
        replacement: fileURLToPath(new URL("./node_modules/server-only/empty.js", import.meta.url)),
      },
    ],
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts", "**/*.test.mjs"],
    exclude: ["node_modules/**", ".next/**", "contracts/**"],
    // A run that collected nothing is not a pass: an empty selection (a broken
    // glob, a renamed directory) would otherwise exit 0 with no tests.
    passWithNoTests: false,
  },
});
