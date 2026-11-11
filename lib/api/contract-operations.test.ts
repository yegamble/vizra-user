import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import type { operations, paths } from "./generated";

/**
 * The operation set this application expects from vizra-core (VZ-FOUND-002,
 * success case S2).
 *
 * WHY THIS EXISTS. `npm run check:contract` proves the generated client is
 * byte-for-byte what the VENDORED contract generates. It says nothing about
 * whether the vendored contract is the one the product needs: a vendor that
 * was two operations behind core's `main` (4 of 6; both `/api/v1/setup/*`
 * operations missing) passed every lane. This list is the explicit statement
 * of what must be there, so a vendored contract missing an operation the
 * product expects — or carrying one nobody reviewed — fails the `frontend`
 * lane in both directions.
 *
 * WHAT THIS DOES NOT PROVE: that the list is current with vizra-core's `main`.
 * This repository's CI cannot see the private core repository (AGENTS.md,
 * "Owed — STALENESS IS NOT DETECTED HERE"). Taking a newer contract means
 * running `node scripts/vendor-contract.mjs` AND updating this list in the
 * same reviewed change.
 *
 * Nothing here sends a request. `claimOwner` carries a credential; it is
 * checked for presence only.
 */
const EXPECTED_OPERATIONS = [
  { method: "get", path: "/healthz", operationId: "getHealthz" },
  { method: "get", path: "/readyz", operationId: "getReadyz" },
  { method: "get", path: "/version", operationId: "getVersion" },
  { method: "get", path: "/schemaz", operationId: "getSchemaz" },
  { method: "get", path: "/api/v1/setup/claim-status", operationId: "getSetupClaimStatus" },
  { method: "post", path: "/api/v1/setup/claim-owner", operationId: "claimOwner" },
] as const;

type Expected = (typeof EXPECTED_OPERATIONS)[number];
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// Type level (the `typecheck` step): the generated client's operation ids and
// paths are exactly the expected ones, and each path+method is bound to its
// operation. A missing or extra operation makes one of these `false`, which is
// not assignable to `true`.
const operationIdsMatch: Equal<keyof operations, Expected["operationId"]> = true;
const pathsMatch: Equal<keyof paths, Expected["path"]> = true;
const bindingsMatch: {
  [E in Expected as E["operationId"]]: E["path"] extends keyof paths
    ? E["method"] extends keyof paths[E["path"]]
      ? Equal<paths[E["path"]][E["method"]], operations[E["operationId"] & keyof operations]>
      : false
    : false;
} = {
  getHealthz: true,
  getReadyz: true,
  getVersion: true,
  getSchemaz: true,
  getSetupClaimStatus: true,
  claimOwner: true,
};

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
const key = (o: { method: string; path: string; operationId: string }) =>
  `${o.method.toUpperCase()} ${o.path} ${o.operationId}`;

function vendoredOperations(): string[] {
  const spec = parse(read("../../contracts/vizra-core/api/openapi.yaml")) as {
    paths: Record<string, Record<string, { operationId: string }>>;
  };
  return Object.entries(spec.paths).flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([method]) => HTTP_METHODS.includes(method))
      .map(([method, operation]) => key({ method, path, operationId: operation.operationId })),
  );
}

/** `METHOD path operationId` for every binding in the generated `paths` interface. */
function generatedOperations(): string[] {
  const source = read("./generated.ts");
  const start = source.indexOf("export interface paths {");
  const end = source.indexOf("\n}\n", start);
  expect(start, "generated.ts has a paths interface").toBeGreaterThanOrEqual(0);
  const found: string[] = [];
  let path = "";
  for (const line of source.slice(start, end).split("\n")) {
    const pathLine = /^ {4}"([^"]+)": \{$/.exec(line);
    if (pathLine?.[1]) path = pathLine[1];
    const binding = /^ {8}(\w+): operations\["(\w+)"\];$/.exec(line);
    if (binding?.[1] && binding[2]) {
      found.push(key({ method: binding[1], path, operationId: binding[2] }));
    }
  }
  return found;
}

describe("the vendored contract carries the operations the product expects", () => {
  const expected = EXPECTED_OPERATIONS.map(key).sort();

  it("vendored spec operation set equals the expected list", () => {
    expect(vendoredOperations().sort()).toEqual(expected);
  });

  it("generated client exposes exactly the expected operations", () => {
    expect(generatedOperations().sort()).toEqual(expected);
  });

  it("generated client declares exactly the expected operation ids", () => {
    const source = read("./generated.ts");
    const body = source.slice(source.indexOf("export interface operations {"));
    const declared = [...body.matchAll(/^ {4}(\w+): \{$/gm)].map((match) => match[1]).sort();
    expect(declared).toEqual(EXPECTED_OPERATIONS.map((o) => o.operationId).sort());
  });

  it("type-level checks are in force", () => {
    expect(operationIdsMatch && pathsMatch).toBe(true);
    expect(Object.values(bindingsMatch).every(Boolean)).toBe(true);
  });
});
