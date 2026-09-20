#!/usr/bin/env node
/**
 * Regenerate `lib/api/generated.ts` from the vendored copy of vizra-core's
 * OpenAPI contract.
 *
 * ADR-002: "The hand-written `vizra-core/api/openapi.yaml` is the API source …
 * The TypeScript client is generated into one committed file in `vizra-user`
 * with byte-for-byte drift CI."
 *
 * The input is ALWAYS `contracts/vizra-core/api/openapi.yaml` — the vendored
 * copy, whose provenance (source repo, commit, sha256) is recorded in
 * `contracts/manifest.json`. Generating from whatever happens to be checked
 * out next door would make the output depend on the developer's working tree;
 * `npm run check:contract` could then pass on one machine and fail on another.
 *
 * To take a NEWER contract, run `node scripts/vendor-contract.mjs` — it copies
 * the spec, records the core commit it came from, and calls this script.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { NonLocalRefError, assertLocalRefsOnly } from "./check-spec-refs.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const VENDORED_SPEC = resolve(ROOT, "contracts", "vizra-core", "api", "openapi.yaml");
export const GENERATED_CLIENT = resolve(ROOT, "lib", "api", "generated.ts");
export const MANIFEST = resolve(ROOT, "contracts", "manifest.json");

/**
 * Run the PINNED, locally installed openapi-typescript (never `npx`, which
 * could resolve a different version from the network) and write to `out`.
 *
 * The spec is VALIDATED AS INPUT before the generator is allowed to read it.
 * openapi-typescript resolves external `$ref` targets through
 * `@redocly/openapi-core`, http(s) included, so an edited vendored spec would
 * otherwise make codegen — and the `contract` lane, which calls this same
 * function on every pull request — fetch a host of the spec author's choosing.
 * `scripts/check-spec-refs.mjs` refuses anything but an in-document pointer;
 * the throw is a named `NonLocalRefError` so the caller can tell "the contract
 * is not acceptable input" from "the generator failed".
 */
export function generate(out) {
  const bin = resolve(ROOT, "node_modules", ".bin", "openapi-typescript");
  if (!existsSync(bin)) {
    console.error("codegen: openapi-typescript is not installed. Run `npm ci` first.");
    process.exit(2);
  }
  try {
    assertLocalRefsOnly(VENDORED_SPEC);
  } catch (error) {
    if (error instanceof NonLocalRefError) {
      console.error(`\n❌ codegen refused the contract: ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
  execFileSync(bin, [VENDORED_SPEC, "-o", out], { stdio: ["ignore", "inherit", "inherit"] });
}

function main() {
  if (!existsSync(VENDORED_SPEC)) {
    console.error(`codegen: vendored contract not found at ${VENDORED_SPEC}`);
    console.error("Run `node scripts/vendor-contract.mjs` against a vizra-core checkout first.");
    process.exit(2);
  }
  generate(GENERATED_CLIENT);
  console.log(`codegen: wrote ${GENERATED_CLIENT}`);
  console.log(`         from ${VENDORED_SPEC}`);
  console.log("         commit the result; CI compares it byte for byte.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
