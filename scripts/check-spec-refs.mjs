#!/usr/bin/env node
/**
 * Reject a non-local `$ref` in the vendored OpenAPI contract, BEFORE the
 * generator is allowed to read it (security review FINDING 6; VZ-FOUND-002).
 *
 * WHY, precisely. `scripts/codegen.mjs` runs the pinned, locally installed
 * `openapi-typescript` through `execFileSync` with an argument array — no
 * shell, no `npx` — which closes command injection. What it does not close is
 * the generator's own resolver: openapi-typescript depends on
 * `@redocly/openapi-core`, which RESOLVES external `$ref` targets, http(s)
 * ones included. `scripts/check-contract.mjs` calls the same `generate()`
 * inside the `contract` lane on every pull request.
 *
 * So a pull request that edits the vendored spec — updating the manifest's
 * sha256 to match, which any contributor can do — makes CI issue an outbound
 * request to a host of the author's choosing during codegen, and splices an
 * unreviewed schema into a committed artifact.
 *
 * The blast radius is bounded and that is why the reviewer filed it as a
 * follow-up rather than a blocker: `contract-ci` has `permissions: contents:
 * read`, `persist-credentials: false`, no secrets in scope, and runs on plain
 * `pull_request`, so a fork gets a read-only token and nothing to exfiltrate.
 * The realistic harm is a build-time network dependency and an unreviewed
 * schema, not credential theft. Three rules of grep turn a review-dependent
 * property into a checked one.
 *
 * WHAT COUNTS AS LOCAL. Only a JSON Pointer into this same document:
 * `#/components/schemas/Image`. Everything else is refused, including forms
 * that are perfectly legal OpenAPI:
 *
 *   https://example.org/schema.yaml#/X   remote, the case this exists for
 *   ./shared.yaml#/components/schemas/X  relative file, unreviewed input
 *   shared.yaml                          the same, bare
 *   /abs/path.yaml                       the same, absolute
 *
 * A relative file ref is refused even though it cannot reach the network,
 * because the vendored contract is a SINGLE file recorded by a single sha256
 * in `contracts/manifest.json`: a second file would be input the drift check
 * does not cover. If core's contract ever legitimately splits, that is an
 * ADR-002 conversation and this check is where the decision gets written down.
 *
 * The parse is deliberately textual rather than YAML-semantic: it needs no
 * parser (so nothing new resolves anything while deciding whether resolution
 * is allowed) and it over-reports rather than under-reports — a `$ref:` inside
 * a description string would be refused, which is a conversation, not a leak.
 *
 * Run: node scripts/check-spec-refs.mjs [spec]
 * Called by: scripts/codegen.mjs (before every generation, so `npm run codegen`
 * and the `contract` lane are both covered) and contract-ci.yml (explicitly,
 * so the lane shows it as a step of its own).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A `$ref` in the vendored contract that points outside this document.
 *
 * Named, and exported, so callers can distinguish "the contract is not
 * acceptable input" from "the generator failed" — the two want different
 * answers from a reviewer.
 */
export class NonLocalRefError extends Error {
  constructor(spec, offenders) {
    const lines = offenders.map((o) => `  line ${o.line}: $ref: ${o.ref}`);
    super(
      [
        `${spec} contains ${offenders.length} non-local $ref${offenders.length === 1 ? "" : "s"}:`,
        ...lines,
        "",
        "Only in-document pointers (`#/...`) may appear in the vendored contract.",
        "A remote $ref makes codegen fetch a host of the spec author's choosing in CI;",
        "a file $ref adds an input that contracts/manifest.json's sha256 does not cover.",
        "The contract is vizra-core's to change (ADR-002): re-vendor it with",
        "scripts/vendor-contract.mjs rather than editing the copy here.",
      ].join("\n"),
    );
    this.name = "NonLocalRefError";
    this.spec = spec;
    this.offenders = offenders;
  }
}

/**
 * Every `$ref` value in `text`, with its 1-based line number. Handles the
 * three spellings YAML allows for the value: bare, single- and double-quoted.
 */
export function findRefs(text) {
  const found = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const match = /(?:^|[\s{,])['"]?\$ref['"]?\s*:\s*(.+?)\s*$/.exec(lines[i]);
    if (!match) continue;
    let value = match[1];
    // Strip a trailing JSON/flow-mapping comma or brace, then quotes.
    value = value.replace(/[,}\]]+$/, "").trim();
    const quoted = /^(['"])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2];
    found.push({ line: i + 1, ref: value });
  }
  return found;
}

/** Is this `$ref` a pointer into the same document? */
export function isLocalRef(ref) {
  return ref.startsWith("#/") || ref === "#";
}

/**
 * Throw `NonLocalRefError` unless every `$ref` in `specPath` is local.
 * Returns the refs it accepted, so a caller can report how many it checked —
 * a check that silently found nothing to check is not a check.
 */
export function assertLocalRefsOnly(specPath) {
  const text = readFileSync(specPath, "utf8");
  const refs = findRefs(text);
  const offenders = refs.filter((r) => !isLocalRef(r.ref));
  if (offenders.length > 0) throw new NonLocalRefError(specPath, offenders);
  return refs;
}

function main() {
  const spec =
    process.argv[2] ??
    resolve(
      fileURLToPath(new URL("..", import.meta.url)),
      "contracts",
      "vizra-core",
      "api",
      "openapi.yaml",
    );
  try {
    const refs = assertLocalRefsOnly(spec);
    console.log(`OK: all ${refs.length} $ref values in ${spec} are in-document pointers.`);
  } catch (error) {
    if (error instanceof NonLocalRefError) {
      console.error(`\n❌ ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
