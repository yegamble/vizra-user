/**
 * ONE CORPUS, BOTH REDACTORS, EVERY BYTE.
 *
 * `e2e/harness/redact.ts` redacts what the harness prints; the SHIPPED
 * `scripts/ci/redact-artifacts.sh` redacts the bytes CI uploads. AGENTS.md used
 * to say they carried "the same four programs". An independent verifier showed
 * they did not (PR #8, R2-FINDING C): a fully slash-escaped URL was redacted by
 * one and survived the other — the one that touches uploaded bytes — and the
 * double-escaped form Playwright writes when a spec prints a slash-escaped URL
 * survived both, into `results.json` and `trace.zip::test.trace`, after the
 * redactor reported OK. The only test of escaped URLs pinned the half-escaped
 * spelling, which no serializer produces.
 *
 * Both now read `redaction-patterns.json`, and this file runs both over the
 * same inputs. The shell half runs the real script as CI does, so a change to
 * how it loads or applies the programs is caught here, not in a verifier's
 * report.
 *
 * It also pins the literal the upload gate depends on — Playwright's
 * `# Page snapshot` heading — so a Playwright bump that renames it is a red test
 * rather than a gate that has silently gone blind.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import corpus from "./redaction-corpus.json";
import { redactUrlsInText } from "./redact";

type Entry = {
  name: string;
  input: string;
  harness: string;
  shell: string;
  keep?: string[];
  json?: boolean;
  unchanged?: boolean;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const shipped = path.join(repoRoot, "scripts", "ci", "redact-artifacts.sh");
const entries = corpus.entries as Entry[];
const MARKER = corpus.marker;

/** Every corpus input through the SHIPPED shell redactor, once, as CI runs it. */
let shellOutputs: string[] = [];
let workDir = "";

beforeAll(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "vizra-redaction-corpus-"));
  entries.forEach((entry, index) => writeFileSync(path.join(workDir, `${index}.txt`), entry.input));
  execFileSync("bash", [shipped, workDir], { stdio: "pipe" });
  shellOutputs = entries.map((_, index) => readFileSync(path.join(workDir, `${index}.txt`), "utf8"));
}, 60_000);

afterAll(() => {
  if (workDir !== "") rmSync(workDir, { recursive: true, force: true });
});

describe("the corpus itself", () => {
  it("is not empty, and every entry has a unique name", () => {
    expect(entries.length).toBeGreaterThanOrEqual(20);
    expect(new Set(entries.map((entry) => entry.name)).size).toBe(entries.length);
  });

  it("covers the shapes the verifier named, so they cannot be dropped quietly", () => {
    const names = entries.map((entry) => entry.name).join("\n");
    for (const shape of ["FULLY escaped", "DOUBLE-escaped", "TRIPLE-escaped", "zone id", "\\u0026", "HALF-escaped"]) {
      expect(names).toContain(shape);
    }
  });
});

describe.each(entries.map((entry, index) => [entry.name, entry, index] as const))(
  "%s",
  (_name, entry, index) => {
    it("the HARNESS redactor produces exactly the pinned output", () => {
      expect(redactUrlsInText(entry.input)).toBe(entry.harness);
    });

    it("the SHIPPED shell redactor produces exactly the pinned output", () => {
      expect(shellOutputs[index]).toBe(entry.shell);
    });

    if (entry.unchanged) {
      it("is left untouched by both", () => {
        expect(entry.harness).toBe(entry.input);
        expect(entry.shell).toBe(entry.input);
      });
    } else {
      it("loses the marker in both, and keeps what makes it diagnosable", () => {
        expect(entry.input).toContain(MARKER);
        for (const output of [entry.harness, shellOutputs[index] ?? ""]) {
          expect(output).not.toContain(MARKER);
          for (const kept of entry.keep ?? []) expect(output).toContain(kept);
        }
      });
    }

    if (entry.json) {
      it("is still valid JSON after both", () => {
        expect(() => JSON.parse(entry.input)).not.toThrow();
        expect(() => JSON.parse(entry.harness)).not.toThrow();
        expect(() => JSON.parse(shellOutputs[index] ?? "")).not.toThrow();
      });
    }
  },
);

describe("the upload gate: no page snapshot leaves the runner", () => {
  it("Playwright still writes the heading the gate looks for", () => {
    const errorContext = readFileSync(
      path.join(repoRoot, "node_modules", "playwright", "lib", "errorContext.js"),
      "utf8",
    );
    expect(errorContext).toContain('"# Page snapshot"');
  });

  function runGate(tree: Record<string, string>) {
    const dir = mkdtempSync(path.join(tmpdir(), "vizra-page-snapshot-gate-"));
    try {
      for (const [relative, content] of Object.entries(tree)) {
        mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
        writeFileSync(path.join(dir, relative), content);
      }
      return spawnSync("bash", [shipped, dir], { encoding: "utf8" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("REFUSES a tree carrying a page snapshot, exits non-zero, and names it", () => {
    const result = runGate({
      "t/error-context.md": "# Error details\n\nboom\n\n# Page snapshot\n\n```yaml\n- textbox: typed\n```\n",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("PAGE SNAPSHOT is present");
    expect(result.stderr).toContain("error-context.md");
  });

  it("passes a tree whose error-context has no page snapshot (the inverse control)", () => {
    const result = runGate({ "t/error-context.md": "# Error details\n\nboom\n" });
    expect(result.status).toBe(0);
  });

  it("REFUSES a page snapshot inside a ZIP member - a trace.zip carries a copy of error-context.md", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vizra-page-snapshot-zip-"));
    try {
      const inner = path.join(dir, "inner");
      mkdirSync(path.join(inner, "attachments"), { recursive: true });
      writeFileSync(path.join(inner, "attachments", "0123abcd"), "# Page snapshot\n\n- textbox: typed\n");
      mkdirSync(path.join(dir, "t"), { recursive: true });
      execFileSync("zip", ["-qr", path.join(dir, "t", "trace.zip"), "."], { cwd: inner });
      rmSync(inner, { recursive: true, force: true });
      const result = spawnSync("bash", [shipped, dir], { encoding: "utf8" });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("PAGE SNAPSHOT is present");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not trip on the phrase used in prose, only on the heading line", () => {
    const result = runGate({ "t/notes.md": "the # Page snapshot section is suppressed in CI\n" });
    expect(result.status).toBe(0);
  });
});
