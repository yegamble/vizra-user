/**
 * THE LANE A UPLOAD GATE IS AN ALLOWLIST (PR #10, chair ruling on war-room rule R3).
 *
 * `scripts/ci/redact-artifacts.sh` is the pinned step the upload is gated on. It
 * copies the bytes of exactly one file, `playwright-report/results.json`, into
 * `e2e-artifacts/`, checks them, and the upload publishes only that directory.
 * These cases run the SHIPPED script, as CI does, over small trees.
 *
 * ONE ORACLE FOR EVERY CASE: `published(root)`, what would be uploaded.
 *   - the shipped gate: every file under `e2e-artifacts/` if the gate exited 0,
 *     otherwise nothing;
 *   - with `VZ_GATE_LEGACY=<an earlier redact-artifacts.sh>`: the upload as it was
 *     at b68294b and 5c5c971 — `<gate> test-results playwright-report`, then, if
 *     it exited 0, `test-results/`, `playwright-report/results.json` and
 *     `playwright-browsers.txt`, with symbolic links FOLLOWED as the pinned
 *     `actions/upload-artifact` follows them.
 * Each regression case asserts, of what would be published, that every path is
 * `playwright-report/results.json` and that no byte carries the synthetic image
 * in any encoding this oracle knows (its raw bytes; base64 and base64url at every
 * alignment; hex) or the case's planted marker. Run with `VZ_GATE_LEGACY` pointing
 * at an earlier gate, the escape cases go RED on those assertions — that is the
 * red half, kept as a transcript in docs/evidence/VZ-FOUND-008/. The cases that
 * only make sense for the staging gate run without it.
 *
 * The end-to-end halves are D24-D28 in `scripts/e2e/demonstrate.sh`.
 */

import { createHash } from "node:crypto";
import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, deflateRawSync, deflateSync, gzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import { DESKTOP_PROJECT, MOBILE_PROJECT } from "./required-projects";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const shipped = path.join(repoRoot, "scripts", "ci", "redact-artifacts.sh");
const legacy = process.env.VZ_GATE_LEGACY ? path.resolve(process.env.VZ_GATE_LEGACY) : undefined;
const staging = !legacy;

// A synthetic 1x1 PNG (70 bytes, generated, never a real image), and a text marker.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPQyr/wHwAEmQJpkss54gAAAABJRU5ErkJggg==",
  "base64",
);
const MARKER = "VZ_UPLOAD_GATE_MARKER_7c41e9";
const JPEG = Buffer.concat([Buffer.from("ffd8ffe000104a464946", "hex"), PNG]);
const PNG_B64 = PNG.toString("base64");

/** Pieces of the PNG in every encoding the oracle searches for. */
const ENCODINGS: [string, Buffer][] = (() => {
  const out: [string, Buffer][] = [["raw bytes", PNG.subarray(8, 48)]];
  for (let shift = 0; shift < 3; shift += 1) {
    const b64 = PNG.subarray(shift).toString("base64").slice(4, 60);
    out.push([`base64 (alignment ${shift})`, Buffer.from(b64)]);
    out.push([`base64url (alignment ${shift})`, Buffer.from(b64.replace(/\+/g, "-").replace(/\//g, "_"))]);
  }
  const hex = PNG.subarray(8, 48).toString("hex");
  out.push(["hex", Buffer.from(hex)], ["HEX", Buffer.from(hex.toUpperCase())]);
  return out;
})();

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      execFileSync("chmod", ["-R", "u+rwx", dir]);
    } catch {
      // already gone, or nothing to fix
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** A realistic JSON report: the shape a red Lane A run writes, with no attachment body. */
function report(extra: { stdout?: string[]; message?: string; attachments?: unknown[]; metadata?: Record<string, unknown> } = {}) {
  const outputDir = "__measure-measurement-real-4aa24-ils-with-its-received-value-desktop-chromium-1440-retry1";
  return {
    config: {
      metadata: {
        ci: { commitHref: "https://github.com/yegamble/vizra-user/commit/5c5c971", prTitle: "an inert title", buildHref: "https://github.com/yegamble/vizra-user/actions/runs/1" },
        actualWorkers: 2,
        ...(extra.metadata ?? {}),
      },
      rootDir: "/home/runner/work/vizra-user/vizra-user/e2e/specs",
    },
    suites: [
      {
        title: "home.spec.ts",
        specs: [
          {
            title: "an assertion on page text fails with its received value",
            tests: [
              {
                projectName: "desktop-chromium-1440",
                results: [
                  {
                    status: "failed",
                    errors: [{ message: extra.message ?? 'Error: expect(locator).toHaveText(expected) failed\n\nExpected: "x"\nReceived: "Vizra"' }],
                    stdout: (extra.stdout ?? ["navigated to http://127.0.0.1:3000/"]).map((text) => ({ text })),
                    stderr: [],
                    annotations: [{ type: "vizra-harness-stamp", description: "b".repeat(64) }],
                    attachments: extra.attachments ?? [
                      { name: "trace", contentType: "application/zip", path: `/home/runner/work/vizra-user/vizra-user/test-results/${outputDir}/trace.zip` },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
    errors: [],
    stats: { expected: 17, unexpected: 1 },
  };
}

/** A throwaway working directory shaped like the runner's after a red lane. */
function tree(options: { results?: Buffer | string | object; files?: Record<string, Buffer | string>; browsers?: Buffer | string } = {}): string {
  const root = scratch("vizra-upload-gate-");
  mkdirSync(path.join(root, "test-results"));
  mkdirSync(path.join(root, "playwright-report"));
  const results = options.results ?? report();
  writeFileSync(
    path.join(root, "playwright-report", "results.json"),
    typeof results === "string" || Buffer.isBuffer(results) ? results : JSON.stringify(results, null, 2),
  );
  for (const [relative, body] of Object.entries(options.files ?? {})) {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), body);
  }
  if (options.browsers !== undefined) writeFileSync(path.join(root, "playwright-browsers.txt"), options.browsers);
  return root;
}

/** A zip archive's bytes, from `members`. */
function zipBytes(members: Record<string, Buffer | string>): Buffer {
  const inner = scratch("vizra-upload-gate-zip-");
  for (const [name, body] of Object.entries(members)) {
    mkdirSync(path.dirname(path.join(inner, name)), { recursive: true });
    writeFileSync(path.join(inner, name), body);
  }
  const out = path.join(scratch("vizra-upload-gate-zipout-"), "a.zip");
  execFileSync("zip", ["-qr", out, "."], { cwd: inner });
  return readFileSync(out);
}

/** A ustar archive's bytes, holding `members`. */
function tarBytes(members: Record<string, Buffer | string>): Buffer {
  const inner = scratch("vizra-upload-gate-tar-");
  for (const [name, body] of Object.entries(members)) writeFileSync(path.join(inner, name), body);
  const out = path.join(scratch("vizra-upload-gate-tarout-"), "a.tar");
  execFileSync("tar", ["--format", "ustar", "-cf", out, "."], { cwd: inner });
  return readFileSync(out);
}

function outsideFile(name: string, body: Buffer | string): string {
  const dir = scratch("vizra-upload-gate-outside-");
  writeFileSync(path.join(dir, name), body);
  return path.join(dir, name);
}

function gate(root: string, args: string[] = [], shell = ""): SpawnSyncReturns<string> {
  if (legacy) return spawnSync("bash", [legacy, "test-results", "playwright-report"], { cwd: root, encoding: "utf8", timeout: 60_000 });
  if (shell !== "") return spawnSync("bash", ["-c", `${shell}; exec bash "$0" "$@"`, shipped, ...args], { cwd: root, encoding: "utf8", timeout: 20_000 });
  return spawnSync("bash", [shipped, ...args], { cwd: root, encoding: "utf8", timeout: 20_000 });
}

/** Every file under `dir`, links FOLLOWED (as the pinned upload action follows them), keyed by `prefix/relative`. */
function collect(dir: string, prefix: string, out: Map<string, Buffer>): void {
  let names: string[];
  try {
    if (!existsSync(dir)) return;
    if (statSync(dir).isFile()) {
      out.set(prefix, readFileSync(dir));
      return;
    }
    names = readdirSync(dir);
  } catch {
    return; // unreadable: the upload action could not read it either
  }
  for (const name of names) {
    if (name.startsWith(".")) continue; // the pinned action skips hidden files (include-hidden-files: false)
    collect(path.join(dir, name), `${prefix}/${name}`, out);
  }
}

/** What would be uploaded, for this gate, after `after` (a writer that runs once the gate is done). */
function published(root: string, result: SpawnSyncReturns<string>, after?: () => void): Map<string, Buffer> {
  after?.();
  const out = new Map<string, Buffer>();
  if (result.status !== 0) return out;
  if (legacy) {
    collect(path.join(root, "test-results"), "test-results", out);
    collect(path.join(root, "playwright-report", "results.json"), "playwright-report/results.json", out);
    collect(path.join(root, "playwright-browsers.txt"), "playwright-browsers.txt", out);
  } else {
    collect(path.join(root, "e2e-artifacts"), "", out);
    return new Map([...out].map(([key, value]) => [key.replace(/^\//, ""), value]));
  }
  return out;
}

/** THE ORACLE: only the allowlisted file, and no image or marker in any known encoding. */
function expectNothingEscapes(root: string, options: { after?: () => void; marker?: string } = {}) {
  const result = gate(root);
  const set = published(root, result, options.after);
  const paths = [...set.keys()].sort();
  const extra = paths.filter((name) => name !== "playwright-report/results.json");
  expect(extra, `published beyond the allowlist (gate exit ${result.status})`).toEqual([]);
  for (const [name, bytes] of set) {
    for (const [label, needle] of ENCODINGS) {
      expect(bytes.includes(needle), `${name} carries the synthetic image as ${label}`).toBe(false);
    }
    expect(bytes.includes(Buffer.from(options.marker ?? MARKER)), `${name} carries the planted marker`).toBe(false);
  }
  const output = `${result.stdout}${result.stderr}`;
  expect(output).not.toContain(MARKER);
  expect(output).not.toContain(PNG_B64.slice(0, 40));
  return result;
}

// ---------------------------------------------------------------------------
describe("regression: every shape that got past an earlier gate stays unpublished", () => {
  describe("binary shapes Playwright or a spec writes under test-results/ (VERIFY G3, FINDING 10)", () => {
    const shapes: Record<string, Record<string, Buffer | string>> = {
      "G3: a PNG with one leading byte, a.dat": { "test-results/t/a.dat": Buffer.concat([Buffer.from([0]), PNG]) },
      "G3: a JPEG with one leading byte": { "test-results/t/b.dat": Buffer.concat([Buffer.from([0]), JPEG]) },
      "G3: a zip inside a zip": { "test-results/t/outer.zip": zipBytes({ "inner.zip": zipBytes({ "a.png": PNG }) }) },
      "G3: a zip named a.dat": { "test-results/t/a.dat": zipBytes({ "a.png": PNG }) },
      "G3: a zip named trace.zip.bak": { "test-results/t/trace.zip.bak": zipBytes({ "a.png": PNG }) },
      "G3: a.png.gz and a.dat.gz": { "test-results/t/a.png.gz": gzipSync(PNG), "test-results/t/a.dat.gz": gzipSync(PNG) },
      "G3: a tar": { "test-results/t/a.tar": tarBytes({ "a.png": PNG }) },
      "G3: an SVG with an embedded raster": {
        "test-results/t/figure.svg": `<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,${PNG_B64}"/></svg>`,
      },
      "G3: a trace member with one leading byte": {
        "test-results/t/trace.zip": zipBytes({ "test.trace": "{}", "resources/77ab": Buffer.concat([Buffer.from([0]), PNG]) }),
      },
      "G3: BMP, TIFF and ICO names": {
        "test-results/t/a.bmp.dat": Buffer.concat([Buffer.from("BM"), PNG]),
        "test-results/t/a.tif": Buffer.concat([Buffer.from("49492a00", "hex"), PNG]),
        "test-results/t/a.ico": Buffer.concat([Buffer.from("00000100", "hex"), PNG]),
      },
      "G3: a hex dump in a text file": { "test-results/t/a.txt": PNG.toString("hex") },
      "FINDING 10: lz4, compress, lzma, cpio, ar signatures as x.dat": {
        "test-results/t/lz4.dat": Buffer.concat([Buffer.from("04224d18", "hex"), PNG]),
        "test-results/t/z.dat": Buffer.concat([Buffer.from("1f9d", "hex"), PNG]),
        "test-results/t/lzma.dat": Buffer.concat([Buffer.from("5d00008000", "hex"), PNG]),
        "test-results/t/cpio.dat": Buffer.concat([Buffer.from("070701"), PNG]),
        "test-results/t/ar.dat": Buffer.concat([Buffer.from("!<arch>\n"), PNG]),
      },
      "FINDING 10: brotli, zlib and raw deflate as x.dat": {
        "test-results/t/br.dat": brotliCompressSync(PNG),
        "test-results/t/zlib.dat": deflateSync(PNG),
        "test-results/t/raw.dat": deflateRawSync(PNG),
      },
      "FINDING 10: the same under their own names": {
        "test-results/t/a.lz4": Buffer.concat([Buffer.from("04224d18", "hex"), PNG]),
        "test-results/t/a.Z": Buffer.concat([Buffer.from("1f9d", "hex"), PNG]),
        "test-results/t/a.lzma": Buffer.concat([Buffer.from("5d00008000", "hex"), PNG]),
        "test-results/t/a.cpio": Buffer.concat([Buffer.from("070701"), PNG]),
        "test-results/t/a.ar": Buffer.concat([Buffer.from("!<arch>\n"), PNG]),
      },
      "FINDING 10: a zlib, cpio or lz4 payload as a trace member": {
        "test-results/t/trace.zip": zipBytes({
          "test.trace": "{}",
          "resources/77ab": deflateSync(PNG),
          "resources/77ac": Buffer.concat([Buffer.from("070701"), PNG]),
          "resources/77ad": Buffer.concat([Buffer.from("04224d18", "hex"), PNG]),
        }),
      },
      "FINDING 10: a zip with one leading byte, at top level and as a member": {
        "test-results/t/lead.dat": Buffer.concat([Buffer.from([0]), zipBytes({ "a.png": PNG })]),
        "test-results/u/trace.zip": zipBytes({ "test.trace": "{}", "resources/9f": Buffer.concat([Buffer.from([0]), zipBytes({ "a.png": PNG })]) }),
      },
      "FINDING 11: an untyped and an octet-stream data: URI in a trace's DOM snapshot and stored HTML": {
        "test-results/t/trace.zip": zipBytes({
          "test.trace": "{}",
          "1-trace.trace": JSON.stringify({ snapshot: { html: ["IMG", { src: `data:application/octet-stream;base64,${PNG_B64}` }] } }),
          "resources/9c1f.html": `<img src="data:;base64,${PNG_B64}">`,
        }),
      },
      "sentinel F-2: a HAR recorded with content: embed": {
        "test-results/zz-har/net.har": JSON.stringify({
          log: { entries: [{ response: { content: { mimeType: "image/png", encoding: "base64", text: PNG_B64 } } }] },
        }),
      },
      "security seat S-1: error-context.md with a matcher aria snapshot and a typed value": {
        "test-results/t/error-context.md":
          `# Error details\n\n\`\`\`\nError: expect(locator).toBeVisible() failed\n\`\`\`\n\n\`\`\`yaml\n- textbox "Password": ${MARKER}\n\`\`\`\n`,
      },
      "the recorders' own shapes: a screenshot, a video and a trace screencast frame": {
        "test-results/t/test-failed-1.png": PNG,
        "test-results/t/video.webm": Buffer.concat([Buffer.from("1a45dfa3", "hex"), PNG]),
        "test-results/t/trace.zip": zipBytes({ "test.trace": "{}", "screencast/page@1-1.jpeg": JPEG }),
      },
    };
    for (const [name, files] of Object.entries(shapes)) {
      it(name, () => {
        expectNothingEscapes(tree({ files }));
      });
    }
  });

  it("G3: a symbolic link to a PNG outside the tree, and to a directory (the upload action follows links)", () => {
    const root = tree();
    const png = outsideFile("secret.dat", PNG);
    symlinkSync(png, path.join(root, "test-results", "s.dat"));
    symlinkSync(path.dirname(png), path.join(root, "test-results", "linked"));
    expectNothingEscapes(root);
  });

  it("FINDING 12 / sentinel F-1: playwright-browsers.txt replaced with PNG bytes, or with a link to one", () => {
    expectNothingEscapes(tree({ browsers: PNG }));
    const root = tree();
    symlinkSync(outsideFile("secret.png", PNG), path.join(root, "playwright-browsers.txt"));
    expectNothingEscapes(root);
  });

  it("G3: a PNG written into test-results/ AFTER the gate has run", () => {
    const root = tree();
    expectNothingEscapes(root, {
      after: () => writeFileSync(path.join(root, "test-results", "late.bin"), PNG),
    });
  });

  describe("text shapes inside results.json itself (FINDINGS 9, 11; VERIFY G3; security seat S-1, S-2)", () => {
    const refused: Record<string, () => object | string> = {
      "G3: a data:image/png URI in stdout": () => report({ stdout: [`seen data:image/png;base64,${PNG_B64}`] }),
      "FINDING 11: an octet-stream data: URI in stdout": () =>
        report({ stdout: [`<img src="data:application/octet-stream;base64,${PNG_B64}">`] }),
      "FINDING 11: an untyped data:;base64 URI in an error message": () =>
        report({ message: `Expected: "x"\nReceived: "data:;base64,${PNG_B64}"` }),
      "G3: base64 with no data: prefix in stdout": () => report({ stdout: [PNG_B64] }),
      "G3: an attachment typed application/octet-stream with a base64 body": () =>
        report({ attachments: [{ name: "blob", contentType: "application/octet-stream", body: PNG_B64 }] }),
      "G3: a hex dump in stdout": () => report({ stdout: [PNG.toString("hex")] }),
      "sentinel F-2: HAR-style base64 text in stdout": () =>
        report({ stdout: [JSON.stringify({ mimeType: "image/png", encoding: "base64", text: PNG_B64 })] }),
      "base64url, as a URL-safe encoder writes it": () =>
        report({ stdout: [PNG_B64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")] }),
      "security seat S-1: an errorContext key carrying an aria snapshot": () => {
        const doc = report() as { suites: { specs: { tests: { results: { errors: object[] }[] }[] }[] }[] };
        doc.suites[0]!.specs[0]!.tests[0]!.results[0]!.errors = [{ message: "boom", errorContext: `- textbox "Password": ${MARKER}` }];
        return doc;
      },
      "a # Page snapshot section inside a JSON string": () =>
        report({ message: `Error: boom\n\n# Page snapshot\n\n- textbox: ${MARKER}` }),
      "a ```yaml block inside a JSON string": () => report({ message: `Error: boom\n\n\`\`\`yaml\n- textbox: ${MARKER}\n\`\`\`` }),
      "security seat S-2: config.metadata.gitDiff": () => report({ metadata: { gitDiff: `+  "integrity": "sha512-${MARKER}"` } }),
      "security seat S-2: config.metadata.gitCommit": () => report({ metadata: { gitCommit: { author: { email: `${MARKER}@example.invalid` } } } }),
    };
    for (const [name, build] of Object.entries(refused)) {
      it(name, () => {
        const result = expectNothingEscapes(tree({ results: build() }));
        if (staging) expect(result.status, result.stderr).not.toBe(0);
      });
    }
  });

  it("FINDING 14: a read-only playwright-report/ holding a signed URL: the published copy is redacted", () => {
    const root = tree({ results: report({ stdout: [`https://h.example/p?X-Amz-Signature=${MARKER}`] }) });
    chmodSync(path.join(root, "playwright-report"), 0o555);
    expect(() => writeFileSync(path.join(root, "playwright-report", "probe"), "x"), "the chmod took effect").toThrow();
    const result = expectNothingEscapes(root);
    if (staging) {
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(path.join(root, "e2e-artifacts", "playwright-report", "results.json"), "utf8")).toContain("?<redacted>");
    }
  });

  it("FINDING 14: an unreadable directory, and an unreadable results.json, refuse the upload (fail closed)", () => {
    const a = tree({ results: report({ stdout: [MARKER] }) });
    chmodSync(path.join(a, "playwright-report", "results.json"), 0o000);
    expect(() => readFileSync(path.join(a, "playwright-report", "results.json")), "the chmod took effect").toThrow();
    const ra = expectNothingEscapes(a);
    if (staging) expect(ra.status, ra.stderr).toBe(2);
    const b = tree({ results: report({ stdout: [MARKER] }) });
    chmodSync(path.join(b, "playwright-report"), 0o000);
    expect(() => readdirSync(path.join(b, "playwright-report")), "the chmod took effect").toThrow();
    const rb = expectNothingEscapes(b);
    if (staging) expect(rb.status, rb.stderr).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describe.runIf(staging)("the staging gate's own rules", () => {
  function expectRefused(root: string, status: number, reason: string, args: string[] = [], shell = "") {
    const result = gate(root, args, shell);
    expect(result.status, result.stderr).toBe(status);
    expect(result.stderr).toContain(reason);
    expect(result.stderr).toContain("Nothing will be uploaded");
    expect(`${result.stdout}${result.stderr}`).not.toContain(MARKER);
    return result;
  }

  it("the inverse control: a realistic red-run report is staged alone, URL-redacted and otherwise byte-identical", () => {
    const doc = report({ stdout: ["fetched /media/p.jpg?sig=abc (image/png)", "done"] });
    const root = tree({ results: doc, files: { "test-results/t/error-context.md": "# Error details\n", "test-results/t/trace.zip": zipBytes({ "test.trace": "{}" }) } });
    const result = gate(root);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("OK: staged playwright-report/results.json");
    const set = published(root, result);
    expect([...set.keys()]).toEqual(["playwright-report/results.json"]);
    const expected = JSON.stringify(doc, null, 2).replace("/media/p.jpg?sig=abc", "/media/p.jpg?<redacted>");
    expect(set.get("playwright-report/results.json")!.toString("utf8")).toBe(expected);
  });

  it("the output directory name (89 characters) and the 64-hex stamp pass; results.json with metadata.ci passes", () => {
    const result = gate(tree());
    expect(result.status, result.stderr).toBe(0);
  });

  it("no test-results/ at all still stages results.json (a floor failure after a green lane)", () => {
    const root = tree();
    rmSync(path.join(root, "test-results"), { recursive: true });
    expect(gate(root).status).toBe(0);
  });

  it("a missing results.json exits 3, and nothing is staged", () => {
    const root = tree();
    rmSync(path.join(root, "playwright-report", "results.json"));
    expectRefused(root, 3, "does not exist");
    expect(existsSync(path.join(root, "e2e-artifacts"))).toBe(false);
  });

  it("an e2e-artifacts/ that already exists, in any form, exits 6", () => {
    const a = tree({ files: { "e2e-artifacts/playwright-report/extra.png": PNG } });
    expectRefused(a, 6, "already exists");
    const b = tree();
    symlinkSync(scratch("vizra-upload-gate-elsewhere-"), path.join(b, "e2e-artifacts"));
    expectRefused(b, 6, "already exists");
  });

  it("any argument is refused (exit 2): it cannot be widened or pointed elsewhere", () => {
    expectRefused(tree(), 2, "takes no arguments", ["test-results"]);
    expectRefused(tree(), 2, "takes no arguments", ["test-results", "playwright-report"]);
  });

  it("a symbolic link as results.json, even to a text file, is refused (exit 5)", () => {
    const root = tree();
    rmSync(path.join(root, "playwright-report", "results.json"));
    symlinkSync(outsideFile("notes.json", JSON.stringify({ note: MARKER })), path.join(root, "playwright-report", "results.json"));
    expectRefused(root, 5, "symbolic link");
  });

  it("a symbolic link as playwright-report/ is refused (exit 5)", () => {
    const root = tree();
    const elsewhere = scratch("vizra-upload-gate-report-");
    writeFileSync(path.join(elsewhere, "results.json"), JSON.stringify({ note: MARKER }));
    rmSync(path.join(root, "playwright-report"), { recursive: true });
    symlinkSync(elsewhere, path.join(root, "playwright-report"));
    expectRefused(root, 5, "not a real directory");
  });

  it("a FIFO as results.json is refused, not waited on (exit 5; opened O_NONBLOCK)", () => {
    const root = tree();
    rmSync(path.join(root, "playwright-report", "results.json"));
    execFileSync("mkfifo", [path.join(root, "playwright-report", "results.json")]);
    expectRefused(root, 5, "not a regular file");
  });

  it("a results.json over the 8 MiB cap is refused (exit 4)", () => {
    const big = JSON.stringify({ s: "word ".repeat(1_700_000) });
    expect(big.length).toBeGreaterThan(8 * 1024 * 1024);
    expectRefused(tree({ results: big }), 4, "larger than the size cap");
  });

  it("invalid UTF-8 is refused (exit 4), naming the offset", () => {
    const bytes = Buffer.concat([Buffer.from('{"s":"caf'), Buffer.from([0xe9]), Buffer.from('"}')]);
    expectRefused(tree({ results: bytes }), 4, "not valid UTF-8 (the first invalid byte is at offset 9)");
  });

  it("control bytes are refused (exit 4): ESC, NUL, CR, DEL and a C1 character", () => {
    expectRefused(tree({ results: '{"s":"a\u001b[31mb"}' }), 4, "control byte 0x1B at offset 7");
    expectRefused(tree({ results: '{"s":"a\u0000b"}' }), 4, "control byte 0x00");
    expectRefused(tree({ results: '{"s":"a"}\r\n' }), 4, "control byte 0x0D");
    expectRefused(tree({ results: '{"s":"a\u007fb"}' }), 4, "control byte 0x7F");
    expectRefused(tree({ results: '{"s":"a\u0085b"}' }), 4, "C1 control character at offset 7");
  });

  it("results.json that does not parse as JSON is refused (exit 4)", () => {
    expectRefused(tree({ results: '{"suites": [' }), 4, "does not parse as JSON");
  });

  for (const [alphabet, unit] of [
    ["base64", "Ab+/"],
    ["base64url", "Ab_-"],
    ["hex", "a0F9"],
  ] as const) {
    it(`a ${alphabet} run of exactly 89 passes, and of 90 is refused naming the alphabet, length and offset`, () => {
      const run = (length: number) => unit.repeat(30).slice(0, length);
      expect(gate(tree({ results: { s: run(89) } })).status).toBe(0);
      const result = expectRefused(tree({ results: { s: run(90) } }), 4, `a run of 90 ${alphabet}-alphabet characters at byte offset 10`);
      expect(result.stderr).not.toContain(run(90));
    });
  }

  it("the N it enforces is the N the measurement derives: 60 + 1 + the longest project name + \"-retry\" + CI retries", () => {
    // Playwright 1.63.0 names a test's output directory trimLongString(…, 60), then
    // "-" + the project id, then "-retry<n>" (workerProcessEntry.js:904-910). That name
    // appears in results.json's attachment paths and is the longest legitimate run.
    const config = readFileSync(path.join(repoRoot, "playwright.config.ts"), "utf8");
    const retries = /retries:\s*process\.env\.CI\s*\?\s*(\d+)\s*:\s*0,/.exec(config);
    expect(retries, "playwright.config.ts's CI retry count is no longer the literal this test reads").not.toBeNull();
    const ciRetries = Number(retries![1]);
    const longestProject = Math.max(DESKTOP_PROJECT.length, MOBILE_PROJECT.length);
    const derived = 60 + 1 + longestProject + (ciRetries > 0 ? `-retry${ciRetries}`.length : 0);
    const gateSource = readFileSync(path.join(repoRoot, "scripts", "ci", "redact-artifacts.pl"), "utf8");
    const n = Number(/^my \$N = (\d+);$/m.exec(gateSource)?.[1]);
    expect(derived).toBe(89);
    expect(derived).toBeLessThanOrEqual(n);
    expect(n).toBe(89);
  });

  it("the root cannot take the staging directory (mkdir fails): exit 2", () => {
    const root = tree();
    chmodSync(root, 0o555);
    expect(() => mkdirSync(path.join(root, "probe")), "the chmod took effect").toThrow();
    expectRefused(root, 2, "could not create e2e-artifacts");
  });

  it("a write that fails (a file-size limit) refuses the upload", () => {
    // SIGXFSZ ignored, so the write RETURNS an error rather than killing the process:
    // the gate must see the error and refuse, not carry on.
    const result = gate(tree({ results: { s: "word ".repeat(4000) } }), [], "ulimit -f 4; trap '' XFSZ");
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain("could not write e2e-artifacts/playwright-report/results.json");
  });

  it("the last check refuses a staging directory that is not exactly what was written", () => {
    const body = Buffer.from('{"a":1}\n');
    const sha = createHash("sha256").update(body).digest("hex");
    const make = () => {
      const root = scratch("vizra-upload-gate-verify-");
      mkdirSync(path.join(root, "e2e-artifacts", "playwright-report"), { recursive: true });
      writeFileSync(path.join(root, "e2e-artifacts", "playwright-report", "results.json"), body);
      return root;
    };
    const verify = (root: string) => gate(root, ["--verify-staging", sha, String(body.length)]);
    expect(verify(make()).status, "the inverse control").toBe(0);
    const extra = make();
    writeFileSync(path.join(extra, "e2e-artifacts", "playwright-report", "extra.png"), PNG);
    expect(verify(extra).stderr).toContain("holds something this gate did not write");
    const linked = make();
    symlinkSync(outsideFile("x", "x"), path.join(linked, "e2e-artifacts", "late"));
    expect(verify(linked).status).toBe(5);
    const changed = make();
    writeFileSync(path.join(changed, "e2e-artifacts", "playwright-report", "results.json"), '{"a":2}\n');
    expect(verify(changed).stderr).toContain("sha256 differs");
    const hard = make();
    execFileSync("ln", [path.join(hard, "e2e-artifacts", "playwright-report", "results.json"), path.join(hard, "hardlink")]);
    expect(verify(hard).stderr).toContain("not a regular file with one link");
    const swapped = make();
    rmSync(path.join(swapped, "e2e-artifacts", "playwright-report"), { recursive: true });
    const elsewhere = scratch("vizra-upload-gate-swap-");
    writeFileSync(path.join(elsewhere, "results.json"), body);
    symlinkSync(elsewhere, path.join(swapped, "e2e-artifacts", "playwright-report"));
    expect(verify(swapped).stderr).toContain("is not a real directory");
    expect(lstatSync(path.join(swapped, "e2e-artifacts", "playwright-report")).isSymbolicLink()).toBe(true);
  });

  it("RESIDUAL R-A, named: a decimal-per-line byte dump (what a failing toEqual on a Buffer prints) is NOT refused", () => {
    const dump = [...PNG].map((byte) => `+   ${byte},`).join("\n");
    const result = gate(tree({ results: report({ message: `expect(received).toEqual(expected)\n\n${dump}` }) }));
    expect(result.status, "this is the stated residual, not a control").toBe(0);
  });
});
