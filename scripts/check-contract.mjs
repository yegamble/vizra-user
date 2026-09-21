#!/usr/bin/env node
/**
 * Contract drift guard (VZ-FOUND-002, this repository's half).
 *
 * Fails when any of these is not true:
 *
 *   1. `contracts/manifest.json` is well formed and describes the vendored
 *      contract truthfully — `scripts/check-manifest.mjs`: schema version, the
 *      source repo and path ADR-002 names, `source_ref: main`, a full 40-hex
 *      `source_commit` and `source_blob`, and a sha256, byte count and blob id
 *      that match the file on disk. So the spec cannot be edited here to make
 *      a stale client look fresh, and the provenance fields are read rather
 *      than being prose (verifier Finding 3 on PR #1);
 *   2. `lib/api/generated.ts` exists, is non-trivial, and is byte-for-byte
 *      what the pinned generator produces from that contract — so a
 *      hand-edited generated file is rejected (ADR-002; the ledger's negative
 *      case for VZ-FOUND-002);
 *   3. the generator version the manifest names is the one installed, since
 *      byte-for-byte equality is only meaningful against a fixed generator.
 *
 * It still cannot tell whether the vendored copy is STALE relative to core's
 * `main` — that needs a read token for the private vizra-core and is an open
 * owner item (AGENTS.md, "Owed"). A green run here means the manifest is
 * internally honest, not that it is current.
 *
 * It writes the regenerated client to a temporary file, never over the
 * committed one: the check must be readable on a dirty tree and must not
 * "fix" the thing it is checking.
 *
 * Run: npm run check:contract
 */

import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checkManifestFiles } from "./check-manifest.mjs";
import { GENERATED_CLIENT, MANIFEST, ROOT, VENDORED_SPEC, generate } from "./codegen.mjs";

const rel = (p) => relative(ROOT, p);

function fail(message, ...detail) {
  console.error(`\n❌ ${message}`);
  for (const line of detail) console.error(`   ${line}`);
  process.exitCode = 1;
}

function main() {
  let ok = true;
  const die = (...args) => {
    ok = false;
    fail(...args);
  };

  // --- 1. the manifest is well formed and describes the file on disk
  for (const problem of checkManifestFiles(ROOT)) die(problem.message, ...problem.detail);

  // Nothing further is checkable without both files and a parseable manifest;
  // the loop above has already said why.
  if (!existsSync(MANIFEST) || !existsSync(VENDORED_SPEC)) {
    process.exit(1);
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  } catch {
    process.exit(1);
  }

  // --- 3. the generator is the one the manifest names
  const installed = JSON.parse(
    readFileSync(resolve(ROOT, "node_modules", "openapi-typescript", "package.json"), "utf8"),
  ).version;
  const pinned = manifest.generated_client?.generator_version;
  if (installed !== pinned) {
    die(
      `generator version mismatch: manifest says ${pinned}, node_modules has ${installed}.`,
      "Byte-for-byte drift detection only means something against a fixed generator.",
      "Update the pin in package.json and re-run scripts/vendor-contract.mjs together.",
    );
  }

  // --- 2. the committed client is exactly what the generator produces
  if (!existsSync(GENERATED_CLIENT)) {
    die(
      `${rel(GENERATED_CLIENT)} is missing.`,
      "Run: npm run codegen  (and commit the result)",
    );
    return;
  }
  const committed = readFileSync(GENERATED_CLIENT, "utf8");
  if (committed.trim().length < 100) {
    die(
      `${rel(GENERATED_CLIENT)} is suspiciously small (${committed.length} bytes).`,
      "An emptied client would make every later type check vacuous.",
    );
  }

  const scratch = mkdtempSync(join(tmpdir(), "vizra-contract-"));
  try {
    const fresh = join(scratch, "generated.ts");
    generate(fresh);
    const expected = readFileSync(fresh, "utf8");
    if (expected !== committed) {
      ok = false;
      const a = committed.split("\n");
      const b = expected.split("\n");
      const at = a.findIndex((line, i) => line !== b[i]);
      fail(
        `${rel(GENERATED_CLIENT)} is not what the contract generates.`,
        `first difference at line ${at + 1}:`,
        `  committed: ${JSON.stringify(a[at] ?? "(end of file)")}`,
        `  generated: ${JSON.stringify(b[at] ?? "(end of file)")}`,
        `(${a.length} committed lines vs ${b.length} generated)`,
        "",
        "lib/api/generated.ts is generated, never hand-edited (AGENTS.md).",
        "Run `npm run codegen` and commit the result — or, if the API changed,",
        "re-vendor the contract from vizra-core first.",
      );
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  if (!ok) {
    console.error("");
    process.exit(1);
  }
  console.log(
    `✅ contract: ${rel(VENDORED_SPEC)} matches its manifest (sha256 ${manifest.spec.sha256.slice(0, 12)}…, ${manifest.spec.bytes} bytes,`,
  );
  console.log(`   blob ${manifest.spec.source_blob.slice(0, 12)}…),`);
  console.log(
    `   and ${rel(GENERATED_CLIENT)} is exactly what openapi-typescript ${installed} generates from it.`,
  );
  console.log(
    `   source: ${manifest.spec.source_repo}@${manifest.spec.source_ref} (${manifest.spec.source_commit}) :${manifest.spec.source_path}`,
  );
  console.log(
    "   NOT proven here: that core's main is still at that commit. See AGENTS.md, \"Owed\".",
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
