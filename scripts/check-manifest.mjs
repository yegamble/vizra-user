#!/usr/bin/env node
/**
 * Read `contracts/manifest.json` and check it against the file it describes.
 *
 * WHY THIS EXISTS. The independent verifier of PR #1 filed it (Finding 3):
 * nothing in this repository ever READ the manifest's provenance. The drift
 * lane compared the vendored spec's sha256 to the manifest and the generated
 * client to the spec, which means the provenance fields — the source repo, the
 * branch, the commit — were prose. PR #1 proved the cost of that: the manifest
 * named `b0dbeb6…` on core's `feat/m0-foundation`, core squash-merged and
 * deleted that branch, and the recorded commit became unreachable from any ref
 * in the canonical repository with nothing going red.
 *
 * WHAT IS CHECKABLE FROM HERE. `yegamble/vizra-core` is private and this
 * repository holds no token for it, so nothing here can ask core what its
 * `main` says. What it CAN do, offline and for free, is refuse a manifest that
 * is malformed or that disagrees with the bytes sitting next to it:
 *
 *   * `$schema_version` is the one this code understands;
 *   * the source repo and path are the ones ADR-002 names;
 *   * `source_ref` is `main` — a commit on a feature branch can be squashed
 *     and deleted out from under the manifest, which is exactly what happened;
 *   * `source_commit` and `source_blob` are full 40-hex object ids, not a
 *     short sha, not `null`, not a branch name;
 *   * `sha256`, `bytes` and `source_blob` all match the vendored file, so the
 *     manifest cannot describe one file while another is committed.
 *
 * WHAT IT STILL DOES NOT PROVE — say this plainly rather than let a green
 * check imply otherwise: that `source_commit` EXISTS in vizra-core, that the
 * blob is the one that commit holds, or that core's `main` has not moved on
 * since. All three need a read token for the private repository. That is an
 * open owner item (AGENTS.md, "Owed").
 *
 * Run: node scripts/check-manifest.mjs   (also called by scripts/check-contract.mjs)
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The contract's identity, per ADR-002. Shared with scripts/vendor-contract.mjs. */
export const SOURCE_REPO = "yegamble/vizra-core";
export const SOURCE_PATH = "api/openapi.yaml";
export const VENDORED_PATH = "contracts/vizra-core/api/openapi.yaml";
/** The only ref a mergeable vendor may come from. */
export const REQUIRED_REF = "main";
/** Bumped when the manifest's shape changes, so a half-updated file fails loudly. */
export const SCHEMA_VERSION = 2;

const OBJECT_ID = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * The git object id of `bytes` as a blob: sha1 of `blob <length>\0<content>`.
 *
 * Computed here rather than shelled out to `git hash-object` so the check
 * needs no git, no repository and no subprocess — `check:contract` runs from a
 * plain source tree. It assumes git's default sha1 object format, which is
 * what `yegamble/vizra-core` uses; if core ever migrates to sha256 objects,
 * this field is what will go red, and that is the right place to have the
 * conversation.
 */
export function gitBlobId(bytes) {
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}

/**
 * Every problem with `manifest` as a description of `bytes`.
 *
 * Returns an array of `{ message, detail[] }` — all of them, not the first, so
 * one run tells a reviewer everything that is wrong. An empty array means the
 * manifest is internally honest; see the header for what that does not mean.
 */
export function checkManifest(manifest, bytes) {
  const problems = [];
  const bad = (message, ...detail) => problems.push({ message, detail });

  if (manifest?.$schema_version !== SCHEMA_VERSION) {
    bad(
      `contracts/manifest.json has $schema_version ${JSON.stringify(manifest?.$schema_version)}, expected ${SCHEMA_VERSION}.`,
      "Re-vendor with scripts/vendor-contract.mjs rather than editing the manifest by hand.",
    );
    // The field names below belong to schema 2; checking them against another
    // shape would produce noise, not information.
    return problems;
  }

  const spec = manifest.spec;
  if (spec === null || typeof spec !== "object") {
    bad("contracts/manifest.json has no `spec` object.");
    return problems;
  }

  if (spec.source_repo !== SOURCE_REPO) {
    bad(
      `manifest source_repo is ${JSON.stringify(spec.source_repo)}, expected ${JSON.stringify(SOURCE_REPO)}.`,
      "The API contract is vizra-core's (ADR-002); it is not vendored from anywhere else.",
    );
  }
  if (spec.source_path !== SOURCE_PATH) {
    bad(
      `manifest source_path is ${JSON.stringify(spec.source_path)}, expected ${JSON.stringify(SOURCE_PATH)}.`,
    );
  }
  if (spec.vendored_path !== VENDORED_PATH) {
    bad(
      `manifest vendored_path is ${JSON.stringify(spec.vendored_path)}, expected ${JSON.stringify(VENDORED_PATH)}.`,
    );
  }

  if (spec.source_ref !== REQUIRED_REF) {
    bad(
      `manifest source_ref is ${JSON.stringify(spec.source_ref)}, expected ${JSON.stringify(REQUIRED_REF)}.`,
      "A contract vendored from a feature branch pins a commit that can be squashed and deleted:",
      "PR #1 vendored b0dbeb6… from feat/m0-foundation and the commit became unreachable.",
      "Re-vendor from core's default branch: node scripts/vendor-contract.mjs --from ../vizra-core --ref main",
    );
  }

  if (typeof spec.source_commit !== "string" || !OBJECT_ID.test(spec.source_commit)) {
    bad(
      `manifest source_commit is ${JSON.stringify(spec.source_commit)}, expected a 40-character hex commit id.`,
      "An abbreviated or missing commit is not provenance anyone can resolve later.",
    );
  }
  if (typeof spec.source_blob !== "string" || !OBJECT_ID.test(spec.source_blob)) {
    bad(
      `manifest source_blob is ${JSON.stringify(spec.source_blob)}, expected a 40-character hex blob id.`,
    );
  } else {
    const actual = gitBlobId(bytes);
    if (actual !== spec.source_blob) {
      bad(
        `${VENDORED_PATH} is not the blob the manifest names.`,
        `manifest: ${spec.source_blob}`,
        `on disk:  ${actual}`,
        "Compare with: git -C ../vizra-core rev-parse <source_commit>:api/openapi.yaml",
      );
    }
  }

  if (typeof spec.sha256 !== "string" || !SHA256.test(spec.sha256)) {
    bad(
      `manifest sha256 is ${JSON.stringify(spec.sha256)}, expected a 64-character hex digest.`,
    );
  } else {
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== spec.sha256) {
      bad(
        `${VENDORED_PATH} does not match its manifest.`,
        `manifest: ${spec.sha256}`,
        `on disk:  ${actual}`,
        "The contract is vizra-core's to change. Re-vendor it with scripts/vendor-contract.mjs;",
        "do not edit the vendored copy here.",
      );
    }
  }

  if (!Number.isInteger(spec.bytes) || spec.bytes < 0) {
    bad(`manifest bytes is ${JSON.stringify(spec.bytes)}, expected a non-negative integer.`);
  } else if (spec.bytes !== bytes.length) {
    bad(
      `${VENDORED_PATH} is ${bytes.length} bytes; the manifest says ${spec.bytes}.`,
      "Re-vendor rather than adjusting the number.",
    );
  }

  return problems;
}

/** Read the manifest and the vendored spec from `root` and check them. */
export function checkManifestFiles(root) {
  const manifestPath = resolve(root, "contracts", "manifest.json");
  const specPath = resolve(root, VENDORED_PATH);
  if (!existsSync(manifestPath)) {
    return [
      {
        message: "contracts/manifest.json is missing.",
        detail: ["Run: node scripts/vendor-contract.mjs --from ../vizra-core --ref main"],
      },
    ];
  }
  if (!existsSync(specPath)) {
    return [
      {
        message: `${VENDORED_PATH} is missing, but contracts/manifest.json describes it.`,
        detail: ["Run: node scripts/vendor-contract.mjs --from ../vizra-core --ref main"],
      },
    ];
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return [{ message: `contracts/manifest.json is not valid JSON: ${error.message}`, detail: [] }];
  }
  return checkManifest(manifest, readFileSync(specPath));
}

function main() {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const problems = checkManifestFiles(root);
  if (problems.length > 0) {
    for (const p of problems) {
      console.error(`\n❌ ${p.message}`);
      for (const line of p.detail) console.error(`   ${line}`);
    }
    console.error("");
    process.exit(1);
  }
  console.log(
    `✅ manifest: describes ${VENDORED_PATH} correctly (sha256, bytes and blob id all match),`,
  );
  console.log(
    `   and names ${SOURCE_REPO}@${REQUIRED_REF} at a full 40-character commit id.`,
  );
  console.log(
    "   NOT checked here (needs a read token for the private vizra-core): that the commit exists,",
  );
  console.log("   or that core's main has not moved on since. See AGENTS.md, \"Owed\".");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
