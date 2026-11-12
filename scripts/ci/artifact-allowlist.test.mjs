import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { stage } from "./artifact-allowlist.mjs";

const GATE = new URL("./artifact-allowlist.mjs", import.meta.url).pathname;

// Minimal zip writer (deflate) so fixtures need no zip binary.
function zip(entries) {
  const locals = [], centrals = [];
  let off = 0;
  for (const [name, text] of Object.entries(entries)) {
    const n = Buffer.from(name), raw = Buffer.from(text), data = deflateRawSync(raw);
    const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(8, 8);
    l.writeUInt32LE(data.length, 18); l.writeUInt32LE(raw.length, 22); l.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42);
    locals.push(l, n, data); centrals.push(c, n); off += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(centrals.length / 2, 8); e.writeUInt16LE(centrals.length / 2, 10);
  e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, e]);
}
const lines = (...evs) => evs.map((e) => JSON.stringify(e)).join("\n");
const CLEAN_TRACE = {
  "0-trace.trace": lines({ type: "before", callId: "c1", apiName: "page.goto", params: {} }, { type: "after", callId: "c1" }),
  "0-trace.network": lines({ type: "resource-snapshot", snapshot: undefined, request: { url: "http://127.0.0.1:3000/health?<redacted>", headers: [{ name: "accept", value: "*/*" }] } }),
};

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), "2f-")), dir = join(root, "test-results");
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}
const run = (...args) => spawnSync(process.execPath, [GATE, ...args], { encoding: "utf8" });
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]);

const FORBIDDEN = {
  "header-value": { "a/trace.zip": zip({ ...CLEAN_TRACE, "0-trace.network": lines({ request: { headers: [{ name: "Authorization", value: "Bearer s3cr3tvalue" }] } }) }) },
  "set-cookie header": { "a/trace.zip": zip({ "0-trace.network": lines({ response: { headers: [{ name: "set-cookie", value: "sid=1" }] } }) }) },
  "x-amz-security-token": { "a/trace.zip": zip({ "0-trace.network": lines({ request: { headers: [{ name: "X-Amz-Security-Token", value: "t" }] } }) }) },
  body: { "a/trace.zip": zip({ "0-trace.network": lines({ request: { postData: "password=hunter2" } }) }) },
  "body resource": { "a/trace.zip": zip({ ...CLEAN_TRACE, "resources/abc.json": "{}" }) },
  "dom-snapshot": { "a/trace.zip": zip({ "0-trace.trace": lines({ type: "frame-snapshot", snapshot: { html: [] } }) }) },
  "call-parameters": { "a/trace.zip": zip({ "0-trace.trace": lines({ type: "before", params: { value: "typed secret" } }) }) },
  "console-text": { "a/trace.zip": zip({ "0-trace.trace": lines({ type: "console", text: "token abcdef" }) }) },
  "schemeless-url-query": { "a/trace.zip": zip({ "0-trace.trace": lines({ type: "after", title: "goto 127.0.0.1:3000/media/p.jpg?X-Amz-Signature=deadbeef" }) }) },
  "page-snapshot": { "a/error-context.md": "x\n# Page snapshot\n- textbox: hunter2\n" },
  "html report": { "index.html": "<html></html>" },
  "fake png": { "a/shot.png": "not a png" },
};

describe("artifact-allowlist gate (QUEUE-2f)", () => {
  it("admits a clean fixture", () => {
    const dir = tree({ "a/trace.zip": zip(CLEAN_TRACE), "a/shot.png": png, "results.json": "{}" });
    const r = run(dir);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });
  for (const [name, files] of Object.entries(FORBIDDEN)) {
    it(`refuses ${name}, naming the file and the rule, never the content`, () => {
      const r = run(tree(files));
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/^REFUSED \S+test-results\/\S+ [a-z0-9-]+$/m);
      expect(r.stderr).not.toMatch(/hunter2|s3cr3t|deadbeef|typed secret/);
    });
  }
  it("refuses a missing directory and an empty argument list", () => {
    expect(run("/nonexistent-2f").status).toBe(1);
    expect(run().status).toBe(2);
  });
  it("gates a job log line carrying a token (2ac)", () => {
    const dir = tree({ "log.txt": "ok line\nAuthorization: Bearer abcdefghijk\n" });
    const r = run("--log", join(dir, "log.txt"));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/log\.txt:2 header-value/);
    expect(run("--log", join(tree({ "l.txt": "1 passed\n" }), "l.txt")).status).toBe(0);
  });
  it("is wired into redact-artifacts.sh after redaction", () => {
    const sh = execFileSync("cat", [new URL("./redact-artifacts.sh", import.meta.url).pathname], { encoding: "utf8" });
    expect(sh).toMatch(/^node scripts\/ci\/artifact-allowlist\.mjs --stage "\$\{VZ_ARTIFACT_STAGE:-artifact-upload\}" "\$\{dirs\[@\]\}" \|\| exit 1$/m);
  });
});

// Session 3: shapes from the real failing run (docs/evidence/QUEUE-2f/real-trace-check.md),
// synthesized with no real tokens.
const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0]);
const RESULTS = JSON.stringify({ suites: [{ file: "zz-forced-fail.spec.ts", specs: [{ title: "forced fail", file: "zz-forced-fail.spec.ts", line: 3,
  tests: [{ projectName: "chromium", results: [{ status: "failed", errors: [{ message: "expect(locator).toBeVisible() failed\nLocator: #does-not-exist\nnavigated to /health?sig=SYNTHSECRET1 by qa@example.com Authorization: Bearer SYNTHSECRET2",
    location: { file: "e2e/specs/zz-forced-fail.spec.ts", line: 5 } }] }] }] }] }] });
const REAL_SHAPES = {
  "test-results/zz-forced-fail-chromium/test-failed-1.png": png,
  "test-results/zz-forced-fail-chromium/video.webm": webm,
  "test-results/zz-forced-fail-chromium/error-context.md": "# Instructions\n# Test info\n- Name: forced fail\n# Error details\nboom\n",
  "test-results/zz-forced-fail-chromium/trace.zip": zip({ "0-trace.trace": lines({ type: "frame-snapshot", snapshot: { html: ["SYNTHPAGE"] } }), "resources/a.css": "x", "test.trace": "{}" }),
  "test-results/.last-run.json": '{"status":"failed"}',
  "playwright-report/index.html": "<html>SYNTHPAGE</html>",
  "playwright-report/data/abc.zip": zip({ "x.html": "SYNTHPAGE" }),
  "playwright-report/results.json": RESULTS,
};
function realTree() {
  const root = mkdtempSync(join(tmpdir(), "2f-real-"));
  for (const [rel, body] of Object.entries(REAL_SHAPES)) { mkdirSync(join(root, rel, ".."), { recursive: true }); writeFileSync(join(root, rel), body); }
  return root;
}
const walkFiles = (d, base = d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walkFiles(join(d, e.name), base) : [join(d, e.name).slice(base.length + 1)]);

describe("filtered upload (QUEUE-2f session 3)", () => {
  it("uploads safe evidence from a real-shaped failing run: screenshots, video, results.json, SUMMARY.txt and nothing else", () => {
    const root = realTree(), out = join(root, "stage");
    const r = spawnSync(process.execPath, [GATE, "--stage", out, "test-results", "playwright-report"], { cwd: root, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(existsSync(out)).toBe(true);
    const got = walkFiles(out).sort();
    expect(got).toContain("SUMMARY.txt");
    expect(got).toContain("test-results/zz-forced-fail-chromium/test-failed-1.png");
    expect(got).toContain("test-results/zz-forced-fail-chromium/video.webm");
    expect(got.every((f) => /^(SUMMARY\.txt|.*\.png|.*\.webm|playwright-report\/results\.json)$/.test(f))).toBe(true);
    const summary = readFileSync(join(out, "SUMMARY.txt"), "utf8");
    expect(summary).toMatch(/FAILED \[chromium\] forced fail/);
    expect(summary).toMatch(/e2e\/specs\/zz-forced-fail\.spec\.ts:5/);
    expect(summary).toMatch(/#does-not-exist/);
    for (const forbidden of ["SYNTHSECRET1", "SYNTHSECRET2", "qa@example.com"]) expect(summary).not.toContain(forbidden);
    // refused files are named by path and rule; contents never printed
    expect(r.stderr).toMatch(/^REFUSED playwright-report\/index\.html \S+$/m);
    expect(r.stderr).toMatch(/^REFUSED test-results\/zz-forced-fail-chromium\/error-context\.md not-staged$/m);
    expect(r.stderr).toMatch(/^REFUSED test-results\/zz-forced-fail-chromium\/trace\.zip not-staged$/m);
    expect(r.stderr).not.toMatch(/SYNTHPAGE|SYNTHSECRET/);
  });
  it("admits a clean results.json into staging", () => {
    const root = realTree(), out = join(root, "stage");
    writeFileSync(join(root, "playwright-report/results.json"), JSON.stringify({ suites: [] }));
    expect(spawnSync(process.execPath, [GATE, "--stage", out, "test-results", "playwright-report"], { cwd: root }).status).toBe(0);
    expect(walkFiles(out)).toContain("playwright-report/results.json");
  });
  it("a forbidden file never reaches staging, even with an allowed extension", () => {
    const root = realTree(), out = join(root, "stage");
    writeFileSync(join(root, "test-results/zz-forced-fail-chromium/fake.png"), "Authorization: Bearer SYNTHSECRET3");
    const r = spawnSync(process.execPath, [GATE, "--stage", out, "test-results", "playwright-report"], { cwd: root, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(walkFiles(out)).not.toContain("test-results/zz-forced-fail-chromium/fake.png");
    expect(r.stderr).toMatch(/REFUSED test-results\/zz-forced-fail-chromium\/fake\.png content-not-png/);
    for (const f of walkFiles(out)) expect(readFileSync(join(out, f), "utf8")).not.toMatch(/SYNTHSECRET|SYNTHPAGE/);
  });
});

// QUEUE-2f follow-ups F-1/F-2 (verifier, 2026-11-12-vizra-user-pr18-2f-VERIFY.md).
describe("F-1: assertion values and messages never reach the staged upload", () => {
  const LEAKY = JSON.stringify({ suites: [{ file: "login.spec.ts", specs: [{ title: "types a password", file: "login.spec.ts", line: 3, tags: [],
    tests: [{ projectName: "chromium", results: [{ status: "failed", errors: [{
      message: 'Error: expect(locator).toHaveValue(expected) failed\nLocator: getByLabel(\'Password\')\nExpected: "x"\nReceived: "CorrectHorse!PWSENTINEL"\nnote sent Bearer TOKSENTINEL to https://b.s3.amazonaws.com/k.jpg?X-Amz-Signature=SIGSENTINEL',
      stack: "Error: Received: CorrectHorse!PWSENTINEL\n at x", value: "CorrectHorse!PWSENTINEL",
      location: { file: "e2e/specs/login.spec.ts", line: 9 } }] }] }] }] }] });
  it("drops results.json and keeps only title, location and matcher header in SUMMARY.txt", () => {
    const root = realTree(), out = join(root, "stage");
    writeFileSync(join(root, "playwright-report/results.json"), LEAKY);
    const r = spawnSync(process.execPath, [GATE, "--stage", out, "test-results", "playwright-report"], { cwd: root, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(walkFiles(out)).not.toContain("playwright-report/results.json");
    expect(r.stderr).toMatch(/^REFUSED playwright-report\/results\.json not-staged$/m);
    for (const f of walkFiles(out)) {
      const body = readFileSync(join(out, f), "latin1");
      for (const s of ["PWSENTINEL", "TOKSENTINEL", "SIGSENTINEL", "amazonaws", "Received", "Expected"]) expect(body, f).not.toContain(s);
    }
    const summary = readFileSync(join(out, "SUMMARY.txt"), "utf8");
    expect(summary).toMatch(/FAILED \[chromium\] types a password \(failed\)/);
    expect(summary).toMatch(/e2e\/specs\/login\.spec\.ts:9/);
    expect(summary).toMatch(/expect\(locator\)\.toHaveValue\(expected\) failed/);
    expect(r.stderr).not.toMatch(/SENTINEL/);
  });
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("MEDIASENTINEL")]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from("MEDIASENTINEL")]);
function mediaTree(tags) {
  const root = mkdtempSync(join(tmpdir(), "2f-media-"));
  const dir = "test-results/health-shows-chromium";
  const res = { suites: [{ file: "health.spec.ts", specs: [{ title: "shows", file: "health.spec.ts", line: 1, tags,
    tests: [{ projectName: "chromium", results: [{ status: "failed", errors: [{ message: "Error: boom" }], attachments: [
      { name: "screenshot", contentType: "image/png", path: `/home/runner/work/x/${dir}/test-failed-1.png` },
      { name: "video", contentType: "video/webm", path: `/home/runner/work/x/${dir}/video.webm` }] }] }] }] }] };
  for (const [rel, body] of [[`${dir}/test-failed-1.png`, PNG], [`${dir}/video.webm`, WEBM], ["test-results/stray.jpg", Buffer.from([0xff, 0xd8, 0xff, 0])], ["playwright-report/results.json", JSON.stringify(res)]]) {
    mkdirSync(join(root, rel, ".."), { recursive: true }); writeFileSync(join(root, rel), body);
  }
  return root;
}
const runStage = (root, mediaAllowlist) => {
  const cwd = process.cwd();
  try { process.chdir(root); return stage(join(root, "stage"), ["test-results", "playwright-report"], { mediaAllowlist }); } finally { process.chdir(cwd); }
};
describe("F-2: binary media is refused unless a spec opts in with a reason, and never for an authenticated spec", () => {
  it("refuses png/webm/jpeg by default (empty allow-list)", () => {
    const root = mediaTree([]);
    const { refused } = runStage(root, []);
    expect(walkFiles(join(root, "stage"))).toEqual(["SUMMARY.txt"]);
    expect(refused).toContainEqual(["test-results/health-shows-chromium/test-failed-1.png", "media-not-opted-in"]);
    expect(refused).toContainEqual(["test-results/health-shows-chromium/video.webm", "media-not-opted-in"]);
    expect(refused).toContainEqual(["test-results/stray.jpg", "media-not-opted-in"]);
  });
  it("the shipped allow-list opts nothing in", () => {
    const root = realTree(), out = join(root, "stage");
    spawnSync(process.execPath, [GATE, "--stage", out, "test-results", "playwright-report"], { cwd: root, encoding: "utf8" });
    expect(walkFiles(out).filter((f) => /\.(png|jpe?g|webm|zip)$/i.test(f))).toEqual([]);
  });
  it("admits media of an opted-in, unauthenticated spec; refuses an entry with no reason", () => {
    const root = mediaTree([]);
    runStage(root, [{ spec: "health.spec.ts", reason: "public page, no session" }]);
    expect(walkFiles(join(root, "stage")).sort()).toEqual(["SUMMARY.txt", "test-results/health-shows-chromium/test-failed-1.png", "test-results/health-shows-chromium/video.webm"]);
    const r2 = mediaTree([]);
    runStage(r2, [{ spec: "health.spec.ts", reason: "  " }]);
    expect(walkFiles(join(r2, "stage"))).toEqual(["SUMMARY.txt"]);
  });
  it("never admits media of a spec tagged @authenticated, even if opted in", () => {
    const root = mediaTree(["@authenticated"]);
    const { refused } = runStage(root, [{ spec: "health.spec.ts", reason: "wants it" }]);
    expect(walkFiles(join(root, "stage"))).toEqual(["SUMMARY.txt"]);
    expect(refused).toContainEqual(["test-results/health-shows-chromium/test-failed-1.png", "media-authenticated-spec"]);
  });
});
