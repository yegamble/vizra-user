/**
 * Two cheap integrity checks over the checked-in tree.
 *
 * WHY EACH EXISTS — both are incidents, not hypotheticals.
 *
 * 1. CONTROL BYTES IN A TEXT SOURCE. While writing the artifact-privacy slice a
 *    tool's JSON encoding interpreted the `\uXXXX` escapes in a regular-expression
 *    character class, and `e2e/harness/redact.ts` was committed-adjacent with
 *    LITERAL NUL, backspace, vertical-tab, form-feed and DEL bytes in its source.
 *    Every lane was green on it: `tsc` accepted it, ESLint accepted it, vitest
 *    accepted it, and the behaviour was even correct, because a literal control
 *    character inside a character class means the same thing as its escape. It
 *    was caught by dumping the bytes with `od -c` by hand.
 *
 *    That is the whole problem: nothing in CI would have caught a recurrence, and
 *    the next one might not be behaviour-preserving. A NUL in a source file is
 *    also the kind of byte that truncates a string in whatever reads it next.
 *
 * 2. THE MUTATION-DIGEST LEDGER vs THE TREE. `docs/evidence/VZ-FOUND-008/
 *    mutation-digests.txt` records a sha256 of each byte-pinned harness file
 *    BEFORE a demonstration mutates it and AFTER it is restored. Its whole value
 *    is that a verifier can confirm from the evidence alone that the tree they
 *    inherited is the tree the demonstrations ran against. Nothing read it back.
 *    An independent verifier noticed that the ledger committed in one commit
 *    described a `browser-errors.ts` the file only acquired two commits later
 *    (it matches at the head, and the note lives in the evidence README) — which
 *    is exactly the drift this check refuses to let recur.
 *
 * Neither is a security control. Both are the cheap kind of check whose absence
 * is only visible after the incident.
 *
 * Usage:  node scripts/ci/check-source-hygiene.mjs
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const problems = [];
const add = (message) => problems.push(message);

/**
 * Text-shaped tracked files. Extensions rather than content sniffing, because a
 * sniffer that guesses "binary" on a file with a NUL in it would skip exactly
 * the file this check exists to find.
 */
const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".yml", ".yaml",
  ".sh", ".css", ".html", ".txt", ".nvmrc", ".gitignore",
]);

/**
 * Control bytes that must not appear literally in a text source: C0 except tab
 * (0x09), line feed (0x0A) and carriage return (0x0D), plus DEL (0x7F).
 */
function offendingBytes(buffer) {
  const seen = new Map();
  for (const byte of buffer) {
    const forbidden = (byte < 0x09) || (byte > 0x0d && byte < 0x20) || byte === 0x0b || byte === 0x0c || byte === 0x7f;
    if (!forbidden) continue;
    seen.set(byte, (seen.get(byte) ?? 0) + 1);
  }
  return seen;
}

let tracked;
try {
  tracked = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 })
    .toString("utf8")
    .split("\0")
    .filter((name) => name !== "");
} catch (error) {
  console.error(
    `::error::source-hygiene: could not list tracked files ` +
      `(${error instanceof Error ? error.message : String(error)}). This check is BLOCKED, not passed.`,
  );
  process.exit(2);
}

if (tracked.length === 0) {
  console.error("::error::source-hygiene: git listed no tracked files; refusing to pass vacuously.");
  process.exit(2);
}

let scanned = 0;
for (const relative of tracked) {
  const extension = path.extname(relative) || path.basename(relative);
  if (!TEXT_EXTENSIONS.has(extension)) continue;
  const absolute = path.join(repoRoot, relative);
  let buffer;
  try {
    if (!statSync(absolute).isFile()) continue;
    buffer = readFileSync(absolute);
  } catch {
    continue; // a tracked path that is not readable here (a submodule, a symlink)
  }
  scanned += 1;
  const offenders = offendingBytes(buffer);
  if (offenders.size === 0) continue;
  const described = [...offenders.entries()]
    .map(([byte, count]) => `0x${byte.toString(16).padStart(2, "0")}×${count}`)
    .join(", ");
  add(
    `${relative} contains literal control bytes (${described}). Write them as source escapes ` +
      "(`\\u0000`), not as raw bytes: a tool that JSON-encodes file content will turn an escape " +
      "into the byte itself, every lane stays green, and the next occurrence may not be " +
      "behaviour-preserving.",
  );
}

if (scanned === 0) {
  add("no text-shaped tracked file was scanned at all; this check would have passed vacuously.");
}

/** The digest ledger must describe the tree it is committed with. */
const LEDGER = path.join(repoRoot, "docs", "evidence", "VZ-FOUND-008", "mutation-digests.txt");
let ledgerLines;
try {
  ledgerLines = readFileSync(LEDGER, "utf8").split("\n").filter((line) => line.trim() !== "");
} catch {
  add("docs/evidence/VZ-FOUND-008/mutation-digests.txt is missing; the demonstrations' tree cannot be confirmed.");
  ledgerLines = [];
}

let checked = 0;
for (const line of ledgerLines) {
  // "<label>  <sha256>  <path relative to the repo root>"
  const match = /^(.*?)\s{2,}([0-9a-f]{64})\s{2,}(\S.*)$/.exec(line);
  if (!match) {
    add(`mutation-digests.txt line is not "<label>  <sha256>  <path>": ${JSON.stringify(line.slice(0, 80))}`);
    continue;
  }
  const [, label, digest, relative] = match;
  // A MUTATED line is meant to differ from the restored tree — that is its point.
  if (/\bMUTATED\b/.test(label)) continue;
  checked += 1;
  let actual;
  try {
    actual = createHash("sha256").update(readFileSync(path.join(repoRoot, relative))).digest("hex");
  } catch {
    add(`mutation-digests.txt names ${relative}, which does not exist in this tree.`);
    continue;
  }
  if (actual !== digest) {
    add(
      `mutation-digests.txt's "${label}" records ${digest.slice(0, 12)}… for ${relative}, ` +
        `but the file at this revision is ${actual.slice(0, 12)}…. The ledger describes a tree ` +
        "that is not this one, so it cannot confirm what the demonstrations ran against. " +
        "Re-run `npm run e2e:demos` in the SAME commit that changes a pinned file.",
    );
  }
}

// THE LEDGER MUST BE COMPLETE, not merely consistent.
//
// The first version refused a line that CONTRADICTED the tree and accepted one
// that had stopped describing it: an independent verifier emptied the file and
// got "0 mutation-digest line(s) match this tree", exit 0, and deleted one line
// and got "12 ... match", exit 0 (R2-FINDING D). Its own vacuity guard read
// `ledgerLines.length > 0 && checked === 0`, which an empty file skips — so the
// cheapest way to clear a stale-ledger red was to delete the stale lines.
//
// The expected set is not a list kept here, which would drift. It is read from
// `scripts/e2e/demonstrate.sh` itself: every `digest "<label>" …` call the
// suite makes is a line the ledger it writes must contain. A label the suite
// records and the ledger lacks is red, a label the ledger carries and the suite
// no longer records is red, and zero checked lines is red unconditionally.
const DEMONSTRATE = path.join(repoRoot, "scripts", "e2e", "demonstrate.sh");
let expectedLabels = [];
try {
  expectedLabels = [...readFileSync(DEMONSTRATE, "utf8").matchAll(/^digest "([^"]+)"/gm)].map((m) => m[1]);
} catch {
  add("scripts/e2e/demonstrate.sh is missing, so the ledger's expected contents cannot be known.");
}
if (expectedLabels.length === 0) {
  add("scripts/e2e/demonstrate.sh records no `digest` label; the ledger check would pass vacuously.");
}
const ledgerLabels = ledgerLines
  .map((line) => /^(.*?)\s{2,}[0-9a-f]{64}\s{2,}\S/.exec(line)?.[1])
  .filter((label) => label !== undefined);
for (const label of expectedLabels) {
  if (!ledgerLabels.includes(label)) {
    add(
      `mutation-digests.txt has no "${label}" line, which scripts/e2e/demonstrate.sh records. A ` +
        "ledger with lines deleted confirms nothing about the files those lines described — " +
        "re-run `npm run e2e:demos` rather than trimming it.",
    );
  }
}
for (const label of ledgerLabels) {
  if (!expectedLabels.includes(label)) {
    add(`mutation-digests.txt carries "${label}", which scripts/e2e/demonstrate.sh no longer records.`);
  }
}
if (checked === 0) {
  add("mutation-digests.txt has no BEFORE/RESTORED line to check; it would have passed vacuously.");
}

if (problems.length > 0) {
  console.error("::error::source hygiene:");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(
  `OK: ${scanned} text source(s) carry no literal control bytes, and ${checked} ` +
    "mutation-digest line(s) match this tree.",
);
