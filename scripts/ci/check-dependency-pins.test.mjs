// VZ-FOUND-001 / VZ-FOUND-004 controlled mutations: each one breaks one pin in
// a copy of the real tree and must turn the check red; the real tree is green.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkPins } from "./check-dependency-pins.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
let dirs = [];
function copy() {
  const d = mkdtempSync(join(tmpdir(), "pins-"));
  dirs.push(d);
  for (const f of ["package.json", "package-lock.json", ".nvmrc"]) cpSync(join(ROOT, f), join(d, f));
  cpSync(join(ROOT, ".github/workflows"), join(d, ".github/workflows"), { recursive: true });
  mkdirSync(join(d, "scripts/ci"), { recursive: true });
  cpSync(join(ROOT, "scripts/ci/adr-001-pins.json"), join(d, "scripts/ci/adr-001-pins.json"));
  return d;
}
const edit = (d, f, fn) => writeFileSync(join(d, f), fn(readFileSync(join(d, f), "utf8")));
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });

describe("check-dependency-pins", () => {
  it("passes on the real tree", () => {
    expect(checkPins(ROOT)).toEqual([]);
  });
  it("fails when package-lock.json is missing", () => {
    const d = copy(); rmSync(join(d, "package-lock.json"));
    expect(checkPins(d).join("\n")).toMatch(/package-lock\.json is missing/);
  });
  it("fails when the lockfile is out of sync with package.json", () => {
    const d = copy();
    edit(d, "package.json", (s) => s.replace('"lucide-react": "1.46.0"', '"lucide-react": "1.46.1"'));
    const e = checkPins(d).join("\n");
    expect(e).toMatch(/dependencies is out of sync/);
    expect(e).toMatch(/resolves lucide-react to '1\.46\.0'/);
  });
  it("fails when .nvmrc changes away from engines.node", () => {
    const d = copy(); writeFileSync(join(d, ".nvmrc"), "22.15.0\n");
    expect(checkPins(d).join("\n")).toMatch(/engines\.node is '22\.14\.0', must equal \.nvmrc '22\.15\.0'/);
  });
  it("fails when .nvmrc is a range", () => {
    const d = copy(); writeFileSync(join(d, ".nvmrc"), "22\n");
    expect(checkPins(d).join("\n")).toMatch(/\.nvmrc must be an exact version/);
  });
  it("fails when engines.node is a range", () => {
    const d = copy(); edit(d, "package.json", (s) => s.replace('"node": "22.14.0"', '"node": ">=22.13.0"'));
    expect(checkPins(d).join("\n")).toMatch(/engines\.node is '>=22\.13\.0'/);
  });
  it.each(["^16.4.1", "~16.4.1", "latest", ">=16"])("fails when next is pinned as %s", (spec) => {
    const d = copy(); edit(d, "package.json", (s) => s.replace('"next": "16.4.1"', `"next": "${spec}"`));
    expect(checkPins(d).join("\n")).toContain(`next: '${spec}' is not an exact version`);
  });
  it("fails when a workflow installs with npm install", () => {
    const d = copy(); edit(d, ".github/workflows/frontend-ci.yml", (s) => s.replace("run: npm ci", "run: npm install"));
    expect(checkPins(d).join("\n")).toMatch(/frontend-ci\.yml:\d+ installs with 'npm install'/);
  });
  it("fails when setup-node does not read .nvmrc", () => {
    const d = copy(); edit(d, ".github/workflows/frontend-ci.yml", (s) => s.replace("node-version-file: .nvmrc", "node-version: 22"));
    const e = checkPins(d).join("\n");
    expect(e).toMatch(/sets node-version directly/);
    expect(e).toMatch(/setup-node without node-version-file/);
  });
  it("fails on an unrecorded ADR-001 divergence, naming the row", () => {
    const d = copy(); edit(d, "scripts/ci/adr-001-pins.json", (s) => s.replace('"1.46.x"', '"1.47.x"'));
    expect(checkPins(d).join("\n")).toContain("lucide-react: ADR-001 row 'lucide-react' says 1.47.x, package.json pins 1.46.0");
  });
  it("fails on a stale recorded gap", () => {
    const d = copy(); edit(d, "scripts/ci/adr-001-pins.json", (s) => s.replace('"16.3.x"', '"16.4.x"'));
    expect(checkPins(d).join("\n")).toMatch(/stale adr_gaps entry.*next: ADR-001 row 'Next\.js' says 16\.3\.x/);
  });
});
