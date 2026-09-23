/**
 * THE UPLOAD GATE REFUSES PIXELS, whatever produced them (PR #10 fix round 2,
 * war-room rule R6).
 *
 * `scripts/ci/redact-artifacts.sh` is the pinned step the upload is gated on.
 * These cases run the SHIPPED script, as CI does, over small trees that each
 * carry one kind of pixel, and require exit 4, the offending path named, and
 * nothing of the content echoed. The inverse control is a tree shaped like a
 * real red Lane A run (a trace with no screencast and no image resource, an
 * `error-context.md`, a JSON report whose only attachment is a trace), which
 * must pass.
 *
 * The end-to-end halves (the verifier's N1, N2 and a replaced-fixture spec
 * producing pixels, refused at the gate; and the refusal switched off letting
 * them upload) are D24 in `scripts/e2e/demonstrate.sh`.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const shipped = path.join(repoRoot, "scripts", "ci", "redact-artifacts.sh");

// The first bytes of each format, plus a planted marker the output must never echo.
const MARKER = "VZ_PIXEL_CONTENT_MARKER_5d1e";
const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from(MARKER)]);
const JPEG = Buffer.concat([Buffer.from("ffd8ffe000104a464946", "hex"), Buffer.from(MARKER)]);
const WEBM = Buffer.concat([Buffer.from("1a45dfa3", "hex"), Buffer.from(MARKER)]);
const MP4 = Buffer.concat([Buffer.from("0000001866747970", "hex"), Buffer.from(MARKER)]);
const WEBP = Buffer.concat([Buffer.from("52494646", "hex"), Buffer.from("00000000", "hex"), Buffer.from("WEBP"), Buffer.from(MARKER)]);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway `test-results/` (named as the pinned step names it). */
function tree(files: Record<string, Buffer | string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "vizra-upload-gate-"));
  dirs.push(root);
  const results = path.join(root, "test-results");
  mkdirSync(results);
  for (const [relative, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(results, relative)), { recursive: true });
    writeFileSync(path.join(results, relative), body);
  }
  return results;
}

/** A trace.zip inside `dir/relative`, built from `members`. */
function traceZip(dir: string, relative: string, members: Record<string, Buffer | string>): void {
  const inner = mkdtempSync(path.join(tmpdir(), "vizra-upload-gate-zip-"));
  dirs.push(inner);
  for (const [name, body] of Object.entries(members)) {
    mkdirSync(path.dirname(path.join(inner, name)), { recursive: true });
    writeFileSync(path.join(inner, name), body);
  }
  mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
  execFileSync("zip", ["-qr", path.join(dir, relative), "."], { cwd: inner });
}

function gate(dir: string) {
  return spawnSync("bash", [shipped, dir], { encoding: "utf8" });
}

function expectRefused(dir: string, pathFragment: string) {
  const result = gate(dir);
  expect(result.status, result.stderr).toBe(4);
  expect(result.stderr).toContain("IMAGE OR VIDEO bytes are present");
  expect(result.stderr).toContain(pathFragment);
  expect(`${result.stdout}${result.stderr}`).not.toContain(MARKER);
}

describe("the upload gate refuses image and video files (exit 4)", () => {
  it("a Playwright screenshot and video by name", () => {
    expectRefused(tree({ "t/test-failed-1.png": PNG }), "t/test-failed-1.png");
    expectRefused(tree({ "t/video.webm": WEBM }), "t/video.webm");
    expectRefused(tree({ "t/x.MP4": MP4 }), "t/x.MP4");
  });

  it("an image whose name hides it is refused by its bytes", () => {
    expectRefused(tree({ "t/attachments/shot": PNG }), "t/attachments/shot");
    expectRefused(tree({ "t/data.bin": JPEG }), "t/data.bin");
    expectRefused(tree({ "t/clip": WEBP }), "t/clip");
  });

  it("a trace archive with screencast frames is refused, naming the archive and member", () => {
    const dir = tree({});
    traceZip(dir, "t/trace.zip", { "test.trace": "{}", "screencast/page@1-1.jpeg": JPEG });
    expectRefused(dir, "screencast/page@1-1.jpeg");
  });

  it("a trace archive with an image resource is refused, even with no extension", () => {
    const dir = tree({});
    traceZip(dir, "t/trace.zip", { "test.trace": "{}", "resources/3f2a9c": PNG });
    expectRefused(dir, "resources/3f2a9c");
  });

  it("a JSON report carrying an inline image attachment is refused", () => {
    const report = JSON.stringify({
      suites: [{ specs: [{ tests: [{ results: [{ attachments: [{ name: "shot", contentType: "image/png", body: PNG.toString("base64") }] }] }] }] }],
    });
    expectRefused(tree({ "results.json": report }), "results.json");
  });
});

describe("the inverse control: a real red Lane A tree passes", () => {
  it("a trace with no screencast and no image, error-context.md, and a report whose attachment is a trace", () => {
    const dir = tree({
      "t/error-context.md": "# Instructions\n\n# Error details\n\nexpected 1, received 2\n",
      "results.json": JSON.stringify({
        suites: [{ specs: [{ tests: [{ results: [{ attachments: [{ name: "trace", contentType: "application/zip", path: "t/trace.zip" }] }] }] }] }],
      }),
    });
    traceZip(dir, "t/trace.zip", { "test.trace": "{}", "0-trace.network": "{}", "resources/abc.json": "{}" });
    const result = gate(dir);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("no image or video is present");
  });
});
