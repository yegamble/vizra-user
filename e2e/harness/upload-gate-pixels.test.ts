/**
 * THE UPLOAD GATE REFUSES PIXELS IN THE SHAPES IT KNOWS (PR #10, war-room rule
 * R6), AND REFUSES WHAT IT CANNOT INSPECT (PR #10 close, FINDING 9).
 *
 * `scripts/ci/redact-artifacts.sh` is the pinned step the upload is gated on.
 * These cases run the SHIPPED script, as CI does, over small trees that each
 * carry one shape, and require a refusal (exit 4 for image or video bytes,
 * exit 5 for content the gate cannot inspect), the offending path named, and
 * nothing of the content echoed. The inverse control is a tree shaped like a
 * real red Lane A run (a trace with no screencast and no image resource, an
 * `error-context.md`, a JSON report whose only attachment is a trace), which
 * must pass.
 *
 * The gate is a check on KNOWN shapes, not a detector of every image: BMP,
 * TIFF, ICO or JPEG XL bytes, a signature not at byte 0, a hex dump, and a
 * file written after the gate has run are not detected. AGENTS.md § Artifact
 * privacy states that scope; the cases below are the shapes it does cover.
 *
 * The end-to-end halves (the verifier's N1, N2 and a replaced-fixture spec
 * producing pixels, refused at the gate; and the refusal switched off letting
 * them upload) are D24 in `scripts/e2e/demonstrate.sh`; the inline data-URI
 * image served by a failing spec is D25.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

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

/** A zip file at `dir/relative` whose content is `members` (Buffers, strings) and `links` (name -> target). */
function zipWith(dir: string, relative: string, members: Record<string, Buffer | string>, links: Record<string, string> = {}): void {
  const inner = mkdtempSync(path.join(tmpdir(), "vizra-upload-gate-zip-"));
  dirs.push(inner);
  for (const [name, body] of Object.entries(members)) {
    mkdirSync(path.dirname(path.join(inner, name)), { recursive: true });
    writeFileSync(path.join(inner, name), body);
  }
  for (const [name, target] of Object.entries(links)) {
    mkdirSync(path.dirname(path.join(inner, name)), { recursive: true });
    symlinkSync(target, path.join(inner, name));
  }
  mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
  // `-y` stores a symbolic link AS a link; without it zip would store the target's bytes.
  execFileSync("zip", ["-qry", path.join(dir, relative), "."], { cwd: inner });
}

/** A zip archive's bytes, built from `members`. */
function zipBytes(members: Record<string, Buffer | string>): Buffer {
  const scratch = mkdtempSync(path.join(tmpdir(), "vizra-upload-gate-bytes-"));
  dirs.push(scratch);
  zipWith(scratch, "a.zip", members);
  return readFileSync(path.join(scratch, "a.zip"));
}

/** A ustar archive's bytes, holding `members`. */
function tarBytes(members: Record<string, Buffer | string>): Buffer {
  const scratch = mkdtempSync(path.join(tmpdir(), "vizra-upload-gate-tar-"));
  dirs.push(scratch);
  const inner = path.join(scratch, "in");
  mkdirSync(inner);
  for (const [name, body] of Object.entries(members)) writeFileSync(path.join(inner, name), body);
  execFileSync("tar", ["--format", "ustar", "-cf", path.join(scratch, "a.tar"), "."], { cwd: inner });
  return readFileSync(path.join(scratch, "a.tar"));
}

/** A PNG outside the tree, for a link to point at. */
function outsidePng(): string {
  const outside = mkdtempSync(path.join(tmpdir(), "vizra-upload-gate-outside-"));
  dirs.push(outside);
  writeFileSync(path.join(outside, "secret.dat"), PNG);
  return outside;
}

// An image inlined as text: the shape a page's `<img src="data:image/png;base64,…">`,
// a blur placeholder or an SVG `<image href>` leaves in a trace's DOM snapshot and
// in the HTML response it stores. Built from the synthetic PNG above, never a real image.
const DATA_URI_PNG = `data:image/png;base64,${PNG.toString("base64")}`;

function expectDataUriRefused(dir: string, pathFragment: string) {
  const result = gate(dir);
  expect(result.status, result.stderr).toBe(4);
  expect(result.stderr).toContain("encoded as a data: URI");
  expect(result.stderr).toContain(pathFragment);
  expect(`${result.stdout}${result.stderr}`).not.toContain(MARKER);
  expect(`${result.stdout}${result.stderr}`).not.toContain(PNG.toString("base64"));
}

function expectUninspectable(dir: string, pathFragment: string) {
  const result = gate(dir);
  expect(result.status, result.stderr).toBe(5);
  expect(result.stderr).toContain("the gate CANNOT INSPECT");
  expect(result.stderr).toContain(pathFragment);
  expect(`${result.stdout}${result.stderr}`).not.toContain(MARKER);
}

describe("the upload gate refuses an image or video encoded as a data: URI (exit 4)", () => {
  it("in a trace's DOM snapshot and in the HTML response the trace stores", () => {
    const html = `<!doctype html><title>t</title><img alt="" src="${DATA_URI_PNG}">`;
    const dom = JSON.stringify({ type: "frame-snapshot", snapshot: { html: ["IMG", { src: DATA_URI_PNG }] } });
    const a = tree({});
    traceZip(a, "t/trace.zip", { "test.trace": "{}", "1-trace.trace": `${dom}\n` });
    expectDataUriRefused(a, "1-trace.trace");
    const b = tree({});
    traceZip(b, "t/trace.zip", { "test.trace": "{}", "resources/9c1f0e2d.html": html });
    expectDataUriRefused(b, "resources/9c1f0e2d.html");
  });

  it("in a plain file: error-context.md, results.json stdout, an SVG with an embedded raster", () => {
    expectDataUriRefused(tree({ "t/error-context.md": `# Error details\n\n<img src="${DATA_URI_PNG}">\n` }), "t/error-context.md");
    const stdout = JSON.stringify({ suites: [], stdout: [{ text: `seen ${DATA_URI_PNG}` }] });
    expectDataUriRefused(tree({ "results.json": stdout }), "results.json");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><image href="${DATA_URI_PNG}"/></svg>`;
    expectDataUriRefused(tree({ "t/attachments/figure.svg": svg }), "t/attachments/figure.svg");
  });

  it("the HTML reporter's own viewer is the ONLY exemption, and only under playwright-report/", () => {
    // Playwright's `index.html` and `trace/` viewer carry data:image/ literals in its own code and
    // are never uploaded. Pinned so the exemption cannot widen: same names elsewhere are refused.
    const root = mkdtempSync(path.join(tmpdir(), "vizra-upload-gate-"));
    dirs.push(root);
    const report = path.join(root, "playwright-report");
    mkdirSync(path.join(report, "trace", "assets"), { recursive: true });
    writeFileSync(path.join(report, "index.html"), `<script>const s="${DATA_URI_PNG}"</script>`);
    writeFileSync(path.join(report, "trace", "assets", "viewer.js"), `const s="${DATA_URI_PNG}";`);
    const exempt = spawnSync("bash", [shipped, report], { encoding: "utf8" });
    expect(exempt.status, exempt.stderr).toBe(0);
    for (const name of ["results.json", "data/5f0c.md", "sub/index.html", "sub/trace/x.js"]) {
      mkdirSync(path.dirname(path.join(report, name)), { recursive: true });
      writeFileSync(path.join(report, name), DATA_URI_PNG);
      expectDataUriRefused(report, name);
      rmSync(path.join(report, name));
    }
    expectDataUriRefused(tree({ "index.html": DATA_URI_PNG }), "index.html");
    expectDataUriRefused(tree({ "trace/assets/viewer.js": DATA_URI_PNG }), "trace/assets/viewer.js");
  });

  it("whatever the case of the scheme and type, slash-escaped as JSON may write it, and for video", () => {
    expectDataUriRefused(tree({ "t/a.txt": `x DATA:Image/PNG;base64,${PNG.toString("base64")}` }), "t/a.txt");
    // The bytes on disk are `data:image\/png`: JSON may escape a slash, and a later reader unescapes it.
    expectDataUriRefused(tree({ "t/b.json": '{"v":"data:image\\/png;base64,AAAA"}' }), "t/b.json");
    expectDataUriRefused(tree({ "t/c.log": "data:video/webm;base64,GkXfow==" }), "t/c.log");
  });
});

describe("the upload gate refuses what it cannot inspect (exit 5)", () => {
  it("a symbolic link to a file outside the tree (the pinned upload action follows links)", () => {
    const outside = outsidePng();
    const dir = tree({ "t/ok.txt": "fine" });
    symlinkSync(path.join(outside, "secret.dat"), path.join(dir, "t", "s.dat"));
    expectUninspectable(dir, "t/s.dat");
  });

  it("a symbolic link to a directory, and a named directory that is itself a link", () => {
    const outside = outsidePng();
    const dir = tree({ "t/ok.txt": "fine" });
    symlinkSync(outside, path.join(dir, "t", "linked"));
    expectUninspectable(dir, "t/linked");
    const parent = mkdtempSync(path.join(tmpdir(), "vizra-upload-gate-"));
    dirs.push(parent);
    symlinkSync(outside, path.join(parent, "test-results"));
    expectUninspectable(path.join(parent, "test-results"), "test-results");
  });

  it("a symbolic link stored inside a trace archive (repacking would store its target's bytes)", () => {
    const outside = outsidePng();
    const dir = tree({});
    zipWith(dir, "t/trace.zip", { "test.trace": "{}" }, { "resources/5e7a": path.join(outside, "secret.dat") });
    expectUninspectable(dir, "resources/5e7a");
  });

  it("an archive inside an archive, whatever its name or kind, is refused rather than opened", () => {
    const zipInZip = tree({});
    zipWith(zipInZip, "t/outer.zip", { "inner.zip": zipBytes({ "a.png": PNG }) });
    expectUninspectable(zipInZip, "inner.zip");
    const renamedMember = tree({});
    traceZip(renamedMember, "t/trace.zip", { "test.trace": "{}", "resources/77ab": zipBytes({ "a.png": PNG }) });
    expectUninspectable(renamedMember, "resources/77ab");
    const gzipMember = tree({});
    traceZip(gzipMember, "t/trace.zip", { "test.trace": "{}", "resources/41c0": gzipSync(PNG) });
    expectUninspectable(gzipMember, "resources/41c0");
    const tarMember = tree({});
    traceZip(tarMember, "t/trace.zip", { "test.trace": "{}", "resources/0d9e": tarBytes({ "a.dat": PNG }) });
    expectUninspectable(tarMember, "resources/0d9e");
  });

  it("an archive the gate does not open: a zip under another name, gzip, tar", () => {
    expectUninspectable(tree({ "t/a.dat": zipBytes({ "a.png": PNG }) }), "t/a.dat");
    expectUninspectable(tree({ "t/trace.zip.bak": zipBytes({ "a.png": PNG }) }), "t/trace.zip.bak");
    expectUninspectable(tree({ "t/a.png.gz": gzipSync(PNG) }), "t/a.png.gz");
    expectUninspectable(tree({ "t/a.dat.gz": gzipSync(PNG) }), "t/a.dat.gz");
    expectUninspectable(tree({ "t/a.tar": tarBytes({ "a.png": PNG }) }), "t/a.tar");
    expectUninspectable(tree({ "t/blob": tarBytes({ "a.dat": PNG }) }), "t/blob");
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

  it("text that names an image type without inlining one, a non-image data: URI, and a regular trace.zip pass", () => {
    const dir = tree({
      "t/error-context.md": '# Error details\n\nexpected content-type "image/png", received "text/html"; data:text/plain,hello\n',
      "t/stdout.txt": "fetched /media/photo.webp (image/webp)\n",
    });
    traceZip(dir, "t/trace.zip", { "test.trace": "{}", "resources/abc.css": "body{background:url(/bg.webp)}" });
    const result = gate(dir);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("no image or video is present");
  });
});
