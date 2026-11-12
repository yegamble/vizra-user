// VZ-CI-001 N1: a skipped, todo or fixme test in a required lane fails the lane.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./check-no-skipped-tests.mjs", import.meta.url));

function run(format, report, allowlist) {
  const dir = mkdtempSync(join(tmpdir(), "skips-"));
  const reportPath = join(dir, "report.json");
  if (report !== undefined) writeFileSync(reportPath, typeof report === "string" ? report : JSON.stringify(report));
  const args = [SCRIPT, format, reportPath];
  if (allowlist !== undefined) {
    const allowPath = join(dir, "allow.json");
    writeFileSync(allowPath, JSON.stringify(allowlist));
    args.push(allowPath);
  }
  return spawnSync(process.execPath, args, { encoding: "utf8" });
}

const vitestReport = (...statuses) => ({
  numTotalTests: statuses.length,
  testResults: [
    {
      name: "/repo/a.test.ts",
      assertionResults: statuses.map((status, i) => ({ fullName: `case ${i}`, status })),
    },
  ],
});

const pwReport = (...statuses) => ({
  suites: [
    {
      title: "a.spec.ts",
      file: "a.spec.ts",
      specs: statuses.map((status, i) => ({
        title: `case ${i}`,
        file: "a.spec.ts",
        tests: [{ projectName: "desktop", status, results: [{ status: status === "skipped" ? "skipped" : "passed" }] }],
      })),
      suites: [],
    },
  ],
});

describe("check-no-skipped-tests vitest", () => {
  it("passes a clean report", () => {
    const r = run("vitest", vitestReport("passed", "passed"));
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });
  for (const status of ["skipped", "pending", "todo"]) {
    it(`fails a report with one ${status} test`, () => {
      const r = run("vitest", vitestReport("passed", status));
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("case 1");
    });
  }
  it("fails a missing report", () => {
    expect(run("vitest", undefined).status).toBe(1);
  });
  it("fails a report with zero tests", () => {
    expect(run("vitest", vitestReport()).status).toBe(1);
  });
  it("fails an unparseable report", () => {
    expect(run("vitest", "{not json").status).toBe(1);
  });
  it("fails an unknown status (fail closed)", () => {
    expect(run("vitest", vitestReport("passed", "weird")).status).toBe(1);
  });
});

describe("check-no-skipped-tests playwright", () => {
  it("passes a clean report", () => {
    expect(run("playwright", pwReport("expected", "flaky"), []).status).toBe(0);
  });
  it("fails a report with one skipped (skip or fixme) test", () => {
    const r = run("playwright", pwReport("expected", "skipped"), []);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("case 1");
  });
  it("fails a missing report", () => {
    expect(run("playwright", undefined, []).status).toBe(1);
  });
  it("fails a report with zero tests", () => {
    expect(run("playwright", pwReport(), []).status).toBe(1);
  });
  it("accepts a skip listed in the allowlist with a reason", () => {
    const allow = [{ file: "a.spec.ts", title: "case 1", project: "desktop", reason: "documented" }];
    expect(run("playwright", pwReport("expected", "skipped"), allow).status).toBe(0);
  });
  it("rejects an allowlist entry without a reason", () => {
    const allow = [{ file: "a.spec.ts", title: "case 1", project: "desktop" }];
    expect(run("playwright", pwReport("expected", "skipped"), allow).status).toBe(1);
  });
  it("the committed allowlist is empty", async () => {
    const { readFileSync } = await import("node:fs");
    const list = JSON.parse(readFileSync(new URL("./skip-allowlist.json", import.meta.url), "utf8"));
    expect(list).toEqual([]);
  });
});
