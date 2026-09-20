/**
 * Serve the PRODUCTION build locally, exactly as the image serves it.
 *
 * WHY NOT `next start`. `next.config.ts` sets `output: "standalone"`, and Next
 * itself warns that `next start` "does not work with output: standalone —
 * use node .next/standalone/server.js instead". The production image's CMD is
 * `node server.js` against that standalone tree, so that is what the harness
 * must drive: testing a different server than the one that ships is how a lane
 * goes green on an application nobody deploys.
 *
 * WHAT IT DOES
 *   1. refuses to start if there is no production build (no `.next/BUILD_ID`),
 *      naming the command to run — never falls back to `next dev`;
 *   2. refuses to start if `.next/standalone/server.js` is missing (a build
 *      made without `output: "standalone"`);
 *   3. copies `public/` and `.next/static/` into the standalone tree, which is
 *      the same copy the Dockerfile's runner stage performs;
 *   4. runs `node server.js` with production configuration, inheriting stdio.
 *
 * Usage:  node scripts/e2e/serve-production.mjs [--port 3210]
 */

import { spawn } from "node:child_process";
import { cpSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function fail(message, hint) {
  console.error(`serve-production: ${message}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
}

function argPort() {
  const index = process.argv.indexOf("--port");
  const raw = index >= 0 ? process.argv[index + 1] : process.env.PORT;
  const port = Number(raw ?? 3210);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    fail(`--port must be a TCP port, got ${String(raw)}`);
  }
  return port;
}

const port = argPort();

const buildIdPath = path.join(repoRoot, ".next", "BUILD_ID");
if (!existsSync(buildIdPath)) {
  fail(
    "there is no production build to serve (.next/BUILD_ID is missing).",
    "Run: INTERNAL_API_BASE_URL=... PUBLIC_ORIGIN=... npm run build — this script will never " +
      "start a development server as a fallback.",
  );
}

const standaloneServer = path.join(repoRoot, ".next", "standalone", "server.js");
if (!existsSync(standaloneServer)) {
  fail(
    ".next/standalone/server.js is missing.",
    'next.config.ts must keep `output: "standalone"` — the production image runs that server.',
  );
}

const buildId = readFileSync(buildIdPath, "utf8").trim();
if (buildId === "" || buildId === "development") {
  fail(
    `.next/BUILD_ID is "${buildId}", which is not a production build id.`,
    "A production `next build` writes a generated id here.",
  );
}

// The same assembly the Dockerfile's runner stage does: standalone output
// bundles the server and a pruned node_modules, but not the static assets.
const standaloneDir = path.join(repoRoot, ".next", "standalone");
cpSync(path.join(repoRoot, "public"), path.join(standaloneDir, "public"), { recursive: true });
cpSync(path.join(repoRoot, ".next", "static"), path.join(standaloneDir, ".next", "static"), {
  recursive: true,
});

console.log(`serve-production: build id ${buildId}, listening on http://127.0.0.1:${port}`);

const child = spawn(process.execPath, ["server.js"], {
  cwd: standaloneDir,
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    NEXT_TELEMETRY_DISABLED: "1",
    INTERNAL_API_BASE_URL: process.env.INTERNAL_API_BASE_URL ?? "http://api.sentinel.invalid:8080",
    PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN ?? `http://127.0.0.1:${port}`,
  },
});

const forward = (signal) => {
  process.on(signal, () => {
    child.kill(signal);
  });
};
forward("SIGINT");
forward("SIGTERM");

child.on("exit", (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});
