/**
 * Make a demonstration transcript REPRODUCIBLE, so "the tree is clean
 * afterwards" is a check a verifier can actually run.
 *
 * WHY. `npm run e2e:demos` writes its transcripts into
 * `docs/evidence/VZ-FOUND-008/`, where they travel with the pull request. An
 * independent verifier ran the suite from a clean clone: exit 0, 104/104
 * halves — and **95 transcripts modified afterwards**. Every modified line was
 * noise (the checkout's absolute path, a wall-clock duration, Playwright's
 * parallel completion order); no verdict changed. But it meant `git status`
 * after the demos said nothing useful, and it embedded the builder's home
 * directory in committed evidence.
 *
 * WHAT IS NORMALISED, and nothing else:
 *
 *   1. the checkout path            -> `<repo>`
 *   2. wall-clock durations         -> `<time>`, in every shape Playwright and
 *      vitest print them, and the per-test video index Playwright assigns in
 *      completion order
 *   3. Playwright's completion ORDER for the result lines of one run: the
 *      per-run index is replaced by `<n>` and each contiguous block of result
 *      lines is sorted. That removes WHICH WORKER FINISHED FIRST and keeps
 *      every other fact — which tests ran, and whether each passed or failed.
 *   4. the DELIVERY order of the guard's own records inside one failure
 *      message. One broken page produces a 404 response, a console error and an
 *      uncaught exception, and Chromium does not deliver them in a fixed order:
 *      ten transcripts differed run to run on nothing else. Each `[kind] …`
 *      entry, with its indented `at:` continuation, is sorted as a unit. No
 *      half asserts on record ORDER — the canary asserts the exact SET of kinds
 *      — so this preserves every fact any assertion reads.
 *
 * WHAT IS DELIBERATELY NOT NORMALISED: exit codes, counts, diagnostics, record
 * kinds, file names, and every string a half asserts on. A normaliser that
 * could change a verdict would be a way to make a demonstration lie, so it
 * only ever rewrites things no assertion reads.
 *
 * Usage: node scripts/e2e/normalise-transcript.mjs <file> <repo-root>
 */

import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const [file, repoRoot] = process.argv.slice(2);
if (!file || !repoRoot) {
  console.error("usage: normalise-transcript.mjs <file> <repo-root>");
  process.exit(2);
}

/** A Playwright list-reporter result line, with its per-run index. */
const RESULT_LINE = /^(\s*)([✓✘✕×]|-)(\s+)(\d+)(\s)(.*)$/u;

/** One guard record in a failure message: `  [kind] detail`. */
const RECORD_LINE = /^\s*\[(console|pageerror|requestfailed|response)\]\s/;
/** Its continuation: a more-indented line, e.g. `      at: <url>`. */
const RECORD_CONTINUATION = /^\s{6,}\S/;

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

let text = readFileSync(file, "utf8");

// 1. the checkout path. Longest-first is not needed: there is exactly one root,
// and every absolute path in these transcripts is under it.
text = text.replaceAll(new RegExp(escapeForRegExp(repoRoot), "g"), "<repo>");

// 2. wall-clock durations.
text = text
  .replace(/\((\d+(?:\.\d+)?)(ms|s|m)\)/g, "(<time>)")
  .replace(/^(\s*)Duration\s+\S+.*$/gm, "$1Duration <time>")
  .replace(/^(\s*)Start at\s+.*$/gm, "$1Start at <time>")
  .replace(/^real\s+\S+$/gm, "real <time>")
  .replace(/^(user|sys)\s+\S+$/gm, "$1 <time>")
  // vitest prints a bare duration with no parentheses, both at end of line
  // (`× a case 9ms`) and inside its file summary (`(11 tests | 1 failed) 22ms`).
  .replace(/(\s)\d+(?:\.\d+)?(?:ms|s)$/gm, "$1<time>")
  // Playwright numbers a test's videos in the order they finish, so two pages
  // in one test swap `video.webm` and `video-1.webm` between runs.
  .replace(/\bvideo(?:-\d+)?\.webm\b/g, "video<n>.webm")
  // Same class: when one test fails with two pages open, Playwright numbers the
  // screenshots in the order they finish.
  .replace(/\btest-failed-\d+\.png\b/g, "test-failed-<n>.png");

// 3. completion order. Each contiguous block of result lines is sorted, with
// the per-run index blanked first so the sort is over the test identity.
const lines = text.split("\n");
const out = [];
let resultBlock = [];
/** Record entries, each an array of lines whose first matches RECORD_LINE. */
let recordBlock = [];

const flushResults = () => {
  if (resultBlock.length > 0) {
    resultBlock.sort();
    out.push(...resultBlock);
    resultBlock = [];
  }
};
const flushRecords = () => {
  if (recordBlock.length > 0) {
    recordBlock.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    for (const entry of recordBlock) out.push(...entry);
    recordBlock = [];
  }
};
const flush = () => {
  flushResults();
  flushRecords();
};

for (const line of lines) {
  const result = RESULT_LINE.exec(line);
  if (result) {
    flushRecords();
    // The GAP is dropped, not kept: Playwright right-aligns the index, so ` 1`
    // and `10` produce different leading whitespace and a sort over the raw
    // line would order two identical results differently from run to run.
    const [, indent, mark, , , , rest] = result;
    resultBlock.push(`${indent}${mark} <n> ${rest}`);
    continue;
  }
  if (RECORD_LINE.test(line)) {
    flushResults();
    recordBlock.push([line]);
    continue;
  }
  // A continuation belongs to the record entry immediately above it, and moves
  // with it when the block is sorted.
  if (recordBlock.length > 0 && RECORD_CONTINUATION.test(line)) {
    recordBlock[recordBlock.length - 1].push(line);
    continue;
  }
  flush();
  out.push(line);
}
flush();

writeFileSync(file, out.join("\n"));
