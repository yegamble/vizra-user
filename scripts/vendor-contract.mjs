#!/usr/bin/env node
/**
 * Vendor vizra-core's OpenAPI contract into this repository and regenerate the
 * client from it.
 *
 * WHY A VENDORED COPY. ADR-002 says the client is generated from
 * `vizra-core/api/openapi.yaml` and drift-checked byte for byte, but it does
 * not say how this repository's CI obtains that file. The Vidra precedent
 * checks the other repository out inside the workflow — which works because
 * that repository is public. `yegamble/vizra-core` is private, so a cross-repo
 * `actions/checkout` needs a token this repository does not have.
 *
 * So the contract is vendored, with its provenance recorded in
 * `contracts/manifest.json`: source repo, path, the core commit it was taken
 * from, its sha256, and when. `npm run check:contract` then proves three
 * things with no network and no credentials:
 *   1. the vendored file is the one the manifest describes (sha256),
 *   2. the committed client is exactly what the pinned generator produces
 *      from it,
 *   3. the generator version in the manifest is the one installed.
 *
 * WHAT THIS DOES NOT PROVE: that the vendored copy is still current with
 * core's `main`. That check belongs in CI and needs a read-only token for
 * vizra-core; it is recorded as owed in AGENTS.md. Until then, a stale vendor
 * is caught by core's own route↔spec test plus review of this manifest's
 * commit field — not by this script.
 *
 * Usage:
 *   node scripts/vendor-contract.mjs [--from <path to vizra-core checkout>]
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { GENERATED_CLIENT, MANIFEST, ROOT, VENDORED_SPEC, generate } from "./codegen.mjs";

const SOURCE_REPO = "yegamble/vizra-core";
const SOURCE_PATH = "api/openapi.yaml";

export function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function gitOutput(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function parseArgs(argv) {
  let from = resolve(ROOT, "..", "vizra-core");
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--from") {
      const next = argv[i + 1];
      if (!next) {
        console.error("vendor-contract: --from needs a path");
        process.exit(2);
      }
      from = resolve(next);
      i++;
    }
  }
  return { from };
}

function main() {
  const { from } = parseArgs(process.argv.slice(2));
  const source = resolve(from, SOURCE_PATH);
  if (!existsSync(source)) {
    console.error(`vendor-contract: no contract at ${source}`);
    console.error("Pass --from <path to a vizra-core checkout>.");
    process.exit(2);
  }

  // The commit that last touched api/ in that checkout. Empty when the spec is
  // not committed yet — recorded as null rather than guessed, because a
  // manifest that names a commit the file did not come from is worse than one
  // that admits it does not know.
  const commit = gitOutput(from, ["log", "-1", "--format=%H", "--", "api/"]);
  const head = gitOutput(from, ["rev-parse", "HEAD"]);
  const branch = gitOutput(from, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const dirty = gitOutput(from, ["status", "--porcelain", "--", "api/"]) !== "";

  mkdirSync(dirname(VENDORED_SPEC), { recursive: true });
  copyFileSync(source, VENDORED_SPEC);

  const manifest = {
    $schema_version: 1,
    $comment:
      "Provenance of the vendored vizra-core OpenAPI contract. See scripts/vendor-contract.mjs and AGENTS.md.",
    spec: {
      source_repo: SOURCE_REPO,
      source_path: SOURCE_PATH,
      source_commit: commit || null,
      source_head: head || null,
      source_branch: branch || null,
      source_working_tree_dirty_for_api: dirty,
      vendored_path: "contracts/vizra-core/api/openapi.yaml",
      sha256: sha256(VENDORED_SPEC),
      vendored_at: new Date().toISOString().slice(0, 10),
    },
    generated_client: {
      path: "lib/api/generated.ts",
      generator: "openapi-typescript",
      generator_version: JSON.parse(
        readFileSync(resolve(ROOT, "package.json"), "utf8"),
      ).devDependencies["openapi-typescript"],
    },
  };
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);

  generate(GENERATED_CLIENT);

  console.log(`vendor-contract: ${source}`);
  console.log(`              -> ${VENDORED_SPEC}`);
  console.log(`   source commit: ${commit || "(uncommitted in vizra-core)"}`);
  console.log(`          sha256: ${manifest.spec.sha256}`);
  console.log(`       generated: ${GENERATED_CLIENT}`);
  if (!commit || dirty) {
    console.warn(
      "warning: the contract is not committed in vizra-core, so this manifest pins a file, not a revision. Re-run once core has committed api/.",
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
