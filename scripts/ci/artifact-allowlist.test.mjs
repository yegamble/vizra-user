import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";

import { describe, expect, it } from "vitest";

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
    expect(sh).toMatch(/^node scripts\/ci\/artifact-allowlist\.mjs "\$\{dirs\[@\]\}" \|\| exit 1$/m);
  });
});
