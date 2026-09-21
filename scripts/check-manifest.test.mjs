import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  REQUIRED_REF,
  SCHEMA_VERSION,
  SOURCE_PATH,
  SOURCE_REPO,
  VENDORED_PATH,
  checkManifest,
  checkManifestFiles,
  gitBlobId,
} from "./check-manifest.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT = join(ROOT, "scripts", "check-manifest.mjs");
const REAL_MANIFEST = join(ROOT, "contracts", "manifest.json");
const REAL_SPEC = join(ROOT, VENDORED_PATH);

const BYTES = Buffer.from("openapi: 3.1.0\ninfo:\n  title: pretend\n");

/** A manifest that describes BYTES correctly. Each test breaks one field. */
function goodManifest(overrides = {}) {
  return {
    $schema_version: SCHEMA_VERSION,
    spec: {
      source_repo: SOURCE_REPO,
      source_path: SOURCE_PATH,
      source_ref: REQUIRED_REF,
      source_commit: "415a6d19cfc0acedd8ad84c1857c95db0ed63627",
      source_blob: gitBlobId(BYTES),
      vendored_path: VENDORED_PATH,
      sha256: createHash("sha256").update(BYTES).digest("hex"),
      bytes: BYTES.length,
      vendored_at: "2026-09-20",
      ...overrides,
    },
  };
}

const messages = (problems) => problems.map((p) => `${p.message} ${p.detail.join(" ")}`).join("\n");

let scratch;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "vizra-manifest-"));
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("gitBlobId", () => {
  it("agrees with `git hash-object` on the real vendored contract", () => {
    // The value is only useful if it is the id git would print, so this is
    // checked against git itself rather than against a constant copied from a
    // previous run of this same function.
    const fromGit = execFileSync("git", ["hash-object", REAL_SPEC], {
      encoding: "utf8",
      cwd: ROOT,
    }).trim();
    expect(gitBlobId(readFileSync(REAL_SPEC))).toBe(fromGit);
  });
});

describe("checkManifest", () => {
  it("accepts a manifest that describes the bytes", () => {
    expect(checkManifest(goodManifest(), BYTES)).toEqual([]);
  });

  it("refuses a schema version it does not understand, and checks nothing else", () => {
    const problems = checkManifest({ ...goodManifest(), $schema_version: 1 }, BYTES);
    expect(problems).toHaveLength(1);
    expect(problems[0].message).toContain("$schema_version");
  });

  it("refuses a source_ref that is not main — the PR #1 failure", () => {
    const problems = checkManifest(goodManifest({ source_ref: "feat/m0-foundation" }), BYTES);
    expect(messages(problems)).toContain("source_ref");
    expect(messages(problems)).toContain("main");
  });

  it("refuses a missing source_ref", () => {
    const spec = goodManifest().spec;
    delete spec.source_ref;
    expect(messages(checkManifest({ $schema_version: SCHEMA_VERSION, spec }, BYTES))).toContain(
      "source_ref",
    );
  });

  it.each([
    ["an abbreviated commit", "415a6d1"],
    ["a branch name", "main"],
    ["null", null],
    ["uppercase hex", "415A6D19CFC0ACEDD8AD84C1857C95DB0ED63627"],
    ["41 characters", "415a6d19cfc0acedd8ad84c1857c95db0ed636270"],
  ])("refuses %s as source_commit", (_label, value) => {
    expect(messages(checkManifest(goodManifest({ source_commit: value }), BYTES))).toContain(
      "source_commit",
    );
  });

  it("accepts the 40-hex commit", () => {
    expect(checkManifest(goodManifest(), BYTES)).toEqual([]);
  });

  it("refuses a sha256 that does not match the bytes", () => {
    const wrong = createHash("sha256").update("something else").digest("hex");
    const problems = checkManifest(goodManifest({ sha256: wrong }), BYTES);
    expect(messages(problems)).toContain("does not match its manifest");
  });

  it("refuses a malformed sha256", () => {
    expect(messages(checkManifest(goodManifest({ sha256: "deadbeef" }), BYTES))).toContain(
      "sha256",
    );
  });

  it("refuses a byte count that does not match the file", () => {
    const problems = checkManifest(goodManifest({ bytes: BYTES.length + 1 }), BYTES);
    expect(messages(problems)).toContain(`is ${BYTES.length} bytes`);
  });

  it("refuses a non-integer byte count", () => {
    expect(messages(checkManifest(goodManifest({ bytes: "10695" }), BYTES))).toContain("bytes");
  });

  it("refuses a blob id that is not the blob id of the bytes", () => {
    const problems = checkManifest(
      goodManifest({ source_blob: "0".repeat(40) }),
      BYTES,
    );
    expect(messages(problems)).toContain("is not the blob the manifest names");
  });

  it("refuses another repo or another path", () => {
    expect(messages(checkManifest(goodManifest({ source_repo: "attacker/spec" }), BYTES))).toContain(
      "source_repo",
    );
    expect(messages(checkManifest(goodManifest({ source_path: "api/other.yaml" }), BYTES))).toContain(
      "source_path",
    );
    expect(
      messages(checkManifest(goodManifest({ vendored_path: "contracts/elsewhere.yaml" }), BYTES)),
    ).toContain("vendored_path");
  });

  it("reports EVERY problem, not just the first", () => {
    const problems = checkManifest(
      goodManifest({ source_ref: "topic", source_commit: "415a6d1", bytes: 1 }),
      BYTES,
    );
    expect(problems.length).toBeGreaterThanOrEqual(3);
  });

  it("does not crash on a manifest with no spec object", () => {
    expect(checkManifest({ $schema_version: SCHEMA_VERSION }, BYTES)[0].message).toContain(
      "no `spec` object",
    );
  });
});

describe("the manifest committed in this repository", () => {
  it("describes the vendored contract truthfully", () => {
    expect(checkManifestFiles(ROOT)).toEqual([]);
  });

  it("names vizra-core's main at a 40-hex commit", () => {
    const manifest = JSON.parse(readFileSync(REAL_MANIFEST, "utf8"));
    expect(manifest.spec.source_repo).toBe(SOURCE_REPO);
    expect(manifest.spec.source_ref).toBe(REQUIRED_REF);
    expect(manifest.spec.source_commit).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("the script, as the contract lane runs it", () => {
  /** A throwaway copy of the repository's contract files, so mutations are local. */
  function fakeRoot(name, mutate) {
    const root = join(scratch, name);
    mkdirSync(join(root, "contracts"), { recursive: true });
    mkdirSync(dirname(join(root, VENDORED_PATH)), { recursive: true });
    cpSync(REAL_SPEC, join(root, VENDORED_PATH));
    const manifest = JSON.parse(readFileSync(REAL_MANIFEST, "utf8"));
    mutate?.(manifest, root);
    writeFileSync(join(root, "contracts", "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return root;
  }

  it("exits 0 on this repository, unchanged", () => {
    const out = execFileSync(process.execPath, [SCRIPT], { encoding: "utf8", cwd: ROOT });
    expect(out).toContain("✅ manifest");
    // It must also say what it does NOT prove, so a green line is not read as
    // "the vendored contract is current".
    expect(out).toContain("NOT checked here");
  });

  it("exits 1 when the vendored spec is edited in place", () => {
    const root = fakeRoot("edited-spec");
    writeFileSync(join(root, VENDORED_PATH), `${readFileSync(join(root, VENDORED_PATH), "utf8")}\n# nudge\n`);
    const problems = checkManifestFiles(root);
    expect(messages(problems)).toContain("does not match its manifest");
  });

  it("exits 1 when the manifest is re-pointed at a feature branch", () => {
    const root = fakeRoot("feature-branch", (m) => {
      m.spec.source_ref = "feat/something";
    });
    expect(messages(checkManifestFiles(root))).toContain("source_ref");
  });

  it("exits 1 when the manifest names a short commit", () => {
    const root = fakeRoot("short-commit", (m) => {
      m.spec.source_commit = m.spec.source_commit.slice(0, 7);
    });
    expect(messages(checkManifestFiles(root))).toContain("source_commit");
  });

  it("exits 1 when the manifest is missing entirely", () => {
    const root = join(scratch, "no-manifest");
    mkdirSync(root, { recursive: true });
    expect(messages(checkManifestFiles(root))).toContain("manifest.json is missing");
  });
});
