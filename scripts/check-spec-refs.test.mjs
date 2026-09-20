import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  NonLocalRefError,
  assertLocalRefsOnly,
  findRefs,
  isLocalRef,
} from "./check-spec-refs.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT = join(ROOT, "scripts", "check-spec-refs.mjs");
const VENDORED = join(ROOT, "contracts", "vizra-core", "api", "openapi.yaml");

let scratch;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "vizra-spec-refs-"));
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Write a spec fixture and return its path. */
function fixture(name, body) {
  const path = join(scratch, name);
  writeFileSync(path, body, "utf8");
  return path;
}

/** Run the script as the `contract` lane does; return { code, output }. */
function run(specPath) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, specPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, output: stdout };
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

describe("isLocalRef", () => {
  it("accepts an in-document JSON pointer", () => {
    expect(isLocalRef("#/components/schemas/Image")).toBe(true);
    expect(isLocalRef("#")).toBe(true);
  });

  it("refuses remote and file references", () => {
    // The case this check exists for: codegen's resolver
    // (@redocly/openapi-core) would fetch this during the contract lane.
    expect(isLocalRef("https://evil.example/schema.yaml#/X")).toBe(false);
    expect(isLocalRef("http://evil.example/schema.yaml")).toBe(false);
    expect(isLocalRef("//evil.example/schema.yaml")).toBe(false);
    // A file ref cannot reach the network, but it is an input the vendored
    // spec's single sha256 does not cover.
    expect(isLocalRef("./shared.yaml#/components/schemas/X")).toBe(false);
    expect(isLocalRef("../core/openapi.yaml")).toBe(false);
    expect(isLocalRef("shared.yaml")).toBe(false);
    expect(isLocalRef("/etc/passwd")).toBe(false);
  });
});

describe("findRefs", () => {
  it("reads bare, single-quoted and double-quoted values", () => {
    const refs = findRefs(
      ["    $ref: '#/a'", '    $ref: "#/b"', "    $ref: #/c", '    "$ref": "#/d"'].join("\n"),
    );
    expect(refs.map((r) => r.ref)).toEqual(["#/a", "#/b", "#/c", "#/d"]);
    expect(refs.map((r) => r.line)).toEqual([1, 2, 3, 4]);
  });

  it("reads a JSON flow mapping", () => {
    expect(findRefs(`schema: { "$ref": "https://evil.example/x" }`).map((r) => r.ref)).toEqual([
      "https://evil.example/x",
    ]);
  });

  it("does not invent refs in a spec that has none", () => {
    expect(findRefs("openapi: 3.1.0\ninfo:\n  title: x\n")).toEqual([]);
  });
});

describe("assertLocalRefsOnly", () => {
  it("passes a spec whose refs are all in-document", () => {
    const spec = fixture(
      "local.yaml",
      ["components:", "  schemas:", "    A:", "      $ref: '#/components/schemas/B'", ""].join("\n"),
    );
    expect(assertLocalRefsOnly(spec)).toHaveLength(1);
  });

  it("throws a NAMED error for a remote ref, naming the line and the value", () => {
    const spec = fixture(
      "remote.yaml",
      ["paths:", "  /x:", "    get:", "      $ref: 'https://evil.example/schema.yaml#/X'", ""].join(
        "\n",
      ),
    );
    let thrown;
    try {
      assertLocalRefsOnly(spec);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(NonLocalRefError);
    expect(thrown.name).toBe("NonLocalRefError");
    expect(thrown.offenders).toEqual([
      { line: 4, ref: "https://evil.example/schema.yaml#/X" },
    ]);
    expect(thrown.message).toContain("line 4");
  });

  it("throws for a relative file ref alongside a legitimate local one", () => {
    const spec = fixture(
      "mixed.yaml",
      [
        "components:",
        "  schemas:",
        "    A:",
        "      $ref: '#/components/schemas/B'",
        "    C:",
        "      $ref: './shared.yaml#/components/schemas/C'",
        "",
      ].join("\n"),
    );
    expect(() => assertLocalRefsOnly(spec)).toThrow(NonLocalRefError);
  });
});

describe("the script, as the contract lane runs it", () => {
  it("exits 0 on the spec vendored in this repository, unchanged", () => {
    const { code, output } = run(VENDORED);
    expect(code).toBe(0);
    expect(output).toMatch(/all \d+ \$ref values .* are in-document pointers/);
    // The current spec really does have refs — a check that found nothing to
    // check would be reporting its own vacuity as a pass.
    const count = Number(/all (\d+) \$ref/.exec(output)[1]);
    expect(count).toBeGreaterThan(0);
    expect(findRefs(readFileSync(VENDORED, "utf8")).every((r) => isLocalRef(r.ref))).toBe(true);
  });

  it("exits 1 and names the offender on a poisoned spec", () => {
    const poisoned = fixture(
      "poisoned.yaml",
      [
        "openapi: 3.1.0",
        "components:",
        "  schemas:",
        "    Pwned:",
        "      $ref: 'https://attacker.example/pwn.yaml#/Schema'",
        "",
      ].join("\n"),
    );
    const { code, output } = run(poisoned);
    expect(code).toBe(1);
    expect(output).toContain("non-local $ref");
    expect(output).toContain("https://attacker.example/pwn.yaml#/Schema");
  });
});
