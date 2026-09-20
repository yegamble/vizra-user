#!/usr/bin/env node
/**
 * Contract drift guard (VZ-FOUND-002, this repository's half).
 *
 * Fails when any of these is not true:
 *
 *   1. the vendored contract exists and its sha256 is the one
 *      `contracts/manifest.json` records — so the spec cannot be edited here
 *      to make a stale client look fresh;
 *   2. `lib/api/generated.ts` exists, is non-trivial, and is byte-for-byte
 *      what the pinned generator produces from that contract — so a
 *      hand-edited generated file is rejected (ADR-002; the ledger's negative
 *      case for VZ-FOUND-002);
 *   3. the generator version the manifest names is the one installed, since
 *      byte-for-byte equality is only meaningful against a fixed generator.
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

import { GENERATED_CLIENT, MANIFEST, ROOT, VENDORED_SPEC, generate } from "./codegen.mjs";
import { sha256 } from "./vendor-contract.mjs";

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

  if (!existsSync(MANIFEST)) {
    die(`${rel(MANIFEST)} is missing.`, "Run: node scripts/vendor-contract.mjs");
    return;
  }
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));

  // --- 1. the vendored contract is the one the manifest describes
  if (!existsSync(VENDORED_SPEC)) {
    die(
      `${rel(VENDORED_SPEC)} is missing, but ${rel(MANIFEST)} describes it.`,
      "Run: node scripts/vendor-contract.mjs --from ../vizra-core",
    );
    return;
  }
  const actualSpecHash = sha256(VENDORED_SPEC);
  if (actualSpecHash !== manifest.spec.sha256) {
    die(
      `${rel(VENDORED_SPEC)} does not match its manifest.`,
      `manifest: ${manifest.spec.sha256}`,
      `on disk:  ${actualSpecHash}`,
      "The contract is vizra-core's to change. Re-vendor it with scripts/vendor-contract.mjs;",
      "do not edit the vendored copy here.",
    );
  }

  // --- 3. the generator is the one the manifest names
  const installed = JSON.parse(
    readFileSync(resolve(ROOT, "node_modules", "openapi-typescript", "package.json"), "utf8"),
  ).version;
  const pinned = manifest.generated_client.generator_version;
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
    `✅ contract: ${rel(VENDORED_SPEC)} matches its manifest (sha256 ${actualSpecHash.slice(0, 12)}…),`,
  );
  console.log(
    `   and ${rel(GENERATED_CLIENT)} is exactly what openapi-typescript ${installed} generates from it.`,
  );
  console.log(
    `   source: ${manifest.spec.source_repo}@${manifest.spec.source_commit ?? "(uncommitted)"} :${manifest.spec.source_path}`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
