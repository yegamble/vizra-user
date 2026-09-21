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
 * `contracts/manifest.json`: source repo, path, the core REF and COMMIT it was
 * taken from, the git blob id of those exact bytes, their sha256 and length,
 * and when. `npm run check:contract` then proves four things with no network
 * and no credentials:
 *   1. the manifest is well formed and self-consistent with the file on disk
 *      (`scripts/check-manifest.mjs`: 40-hex commit, `source_ref: main`,
 *      matching sha256, byte count and blob id),
 *   2. the vendored file is the one the manifest describes (sha256),
 *   3. the committed client is exactly what the pinned generator produces
 *      from it,
 *   4. the generator version in the manifest is the one installed.
 *
 * WHY A REF AND NOT A WORKING TREE. This script used to copy
 * `<checkout>/api/openapi.yaml` straight out of whatever the developer had
 * checked out next door, and record `git log -1 -- api/` as the provenance.
 * That produced the failure this rewrite exists to fix: PR #1 vendored from
 * `b0dbeb6…` on core's `feat/m0-foundation`; core squash-merged that branch
 * and deleted it, so the manifest named a commit unreachable from any ref in
 * the canonical repository. A working tree is also dirty-able, so the bytes
 * and the commit could disagree with nothing to say so.
 *
 * It now reads the blob out of the object database — `git show <ref>:<path>` —
 * so the bytes and the recorded commit cannot disagree, and the default ref is
 * `main`. Vendoring from any other ref still works for local experiments, but
 * `check:contract` refuses a manifest whose `source_ref` is not `main`, so such
 * a vendor cannot merge.
 *
 * WHAT THIS DOES NOT PROVE: that the vendored copy is still CURRENT with
 * core's `main` — only that it came from a commit that was on `main` when it
 * was taken. Detecting staleness needs a read-only token for the private
 * vizra-core; it is recorded as an open owner item in AGENTS.md.
 *
 * Usage:
 *   node scripts/vendor-contract.mjs [--from <path to vizra-core checkout>] [--ref <rev>]
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SOURCE_PATH, SOURCE_REPO, SCHEMA_VERSION, VENDORED_PATH } from "./check-manifest.mjs";
import { GENERATED_CLIENT, MANIFEST, ROOT, VENDORED_SPEC, generate } from "./codegen.mjs";

const DEFAULT_REF = "main";

export function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** Run git in `cwd`, failing loudly. Provenance must not be guessed. */
function git(cwd, args, { encoding = "utf8" } = {}) {
  const out = execFileSync("git", args, { cwd, encoding, maxBuffer: 64 * 1024 * 1024 });
  return encoding === "utf8" ? out.trim() : out;
}

/** Run git in `cwd`, returning null when it fails. For optional lookups only. */
function gitOrNull(cwd, args) {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  let from = resolve(ROOT, "..", "vizra-core");
  let ref = DEFAULT_REF;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--from" || argv[i] === "--ref") {
      const next = argv[i + 1];
      if (!next) {
        console.error(`vendor-contract: ${argv[i]} needs a value`);
        process.exit(2);
      }
      if (argv[i] === "--from") from = resolve(next);
      else ref = next;
      i++;
    } else {
      console.error(`vendor-contract: unknown argument ${argv[i]}`);
      console.error("Usage: node scripts/vendor-contract.mjs [--from <checkout>] [--ref <rev>]");
      process.exit(2);
    }
  }
  return { from, ref };
}

function main() {
  const { from, ref } = parseArgs(process.argv.slice(2));

  if (!existsSync(resolve(from, ".git"))) {
    console.error(`vendor-contract: ${from} is not a git checkout.`);
    console.error("Pass --from <path to a vizra-core checkout>.");
    process.exit(2);
  }

  // Resolve the ref to a commit, then read the blob AT THAT COMMIT. The
  // checkout's working tree and current branch are never consulted: it may be
  // on any branch, and it may be dirty.
  let commit;
  let blob;
  let bytes;
  try {
    commit = git(from, ["rev-parse", "--verify", `${ref}^{commit}`]);
    blob = git(from, ["rev-parse", "--verify", `${commit}:${SOURCE_PATH}`]);
    bytes = git(from, ["show", `${commit}:${SOURCE_PATH}`], { encoding: "buffer" });
  } catch (error) {
    console.error(`vendor-contract: cannot read ${SOURCE_PATH} at ${ref} in ${from}`);
    console.error(`  ${error.message.split("\n")[0]}`);
    console.error("Fetch the ref first, e.g. `git -C <checkout> fetch origin main`.");
    process.exit(2);
  }

  // A local `main` that is behind `origin/main` is exactly how a stale vendor
  // gets recorded with a perfectly valid-looking commit. This cannot fail the
  // run (the checkout may legitimately have no remote), but it must be said.
  const remote = gitOrNull(from, ["rev-parse", "--verify", `refs/remotes/origin/${ref}`]);
  const behindRemote = remote !== null && remote !== commit;

  mkdirSync(dirname(VENDORED_SPEC), { recursive: true });
  writeFileSync(VENDORED_SPEC, bytes);

  const manifest = {
    $schema_version: SCHEMA_VERSION,
    $comment:
      "Provenance of the vendored vizra-core OpenAPI contract. See scripts/vendor-contract.mjs, scripts/check-manifest.mjs and AGENTS.md.",
    spec: {
      source_repo: SOURCE_REPO,
      source_path: SOURCE_PATH,
      source_ref: ref,
      source_commit: commit,
      source_blob: blob,
      vendored_path: VENDORED_PATH,
      sha256: sha256(VENDORED_SPEC),
      bytes: bytes.length,
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

  console.log(`vendor-contract: ${SOURCE_REPO}@${ref} (${commit})`);
  console.log(`              :${SOURCE_PATH} -> ${VENDORED_SPEC}`);
  console.log(`            blob: ${blob}`);
  console.log(`          sha256: ${manifest.spec.sha256}`);
  console.log(`           bytes: ${manifest.spec.bytes}`);
  console.log(`       generated: ${GENERATED_CLIENT}`);
  if (behindRemote) {
    console.warn(
      `\nwarning: ${ref} in ${from} is ${commit}, but origin/${ref} is ${remote}.\n` +
        "         You are vendoring from a local ref that is not the remote's. Fetch and re-run\n" +
        "         unless you meant this.",
    );
  }
  if (ref !== DEFAULT_REF) {
    console.warn(
      `\nwarning: vendored from ref '${ref}', not '${DEFAULT_REF}'. check:contract will refuse this\n` +
        "         manifest, so it cannot merge — a feature branch can be deleted and squashed away,\n" +
        "         leaving the recorded commit unreachable (this is what happened to PR #1).",
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
