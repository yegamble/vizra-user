/**
 * The registry against the INSTALLED package — the ledger's success case
 * "icon registry test that every name exists in the pinned package".
 *
 * Three independent readings of `node_modules/lucide-react`, none of which is
 * the registry's own import statement:
 *   1. the runtime module's export table;
 *   2. the shipped type declarations (`dist/lucide-react.d.ts`);
 *   3. the package's own `package.json`, against the exact pin in ours and in
 *      the lockfile.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as lucide from "lucide-react";
import { describe, expect, it } from "vitest";

import { ICONS } from "./registry";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...segments: string[]) => readFileSync(path.join(repoRoot, ...segments), "utf8");

const PINNED = "1.46.0";
const declarations = read("node_modules", "lucide-react", "dist", "lucide-react.d.ts");
const exportTable = lucide as unknown as Record<string, unknown>;
const entries = Object.entries(ICONS) as ReadonlyArray<[string, unknown]>;

/** Every runtime export name that is this exact component. */
function exportNamesOf(component: unknown): string[] {
  return Object.keys(exportTable).filter((name) => exportTable[name] === component);
}

describe("the pinned lucide-react", () => {
  it("is pinned exactly, and the installed copy is that version", () => {
    const ours = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
    const lock = JSON.parse(read("package-lock.json")) as {
      packages: Record<string, { version?: string; license?: string }>;
    };
    const installed = JSON.parse(read("node_modules", "lucide-react", "package.json")) as {
      version: string;
      license: string;
    };
    expect(ours.dependencies["lucide-react"]).toBe(PINNED);
    expect(lock.packages["node_modules/lucide-react"]?.version).toBe(PINNED);
    expect(installed.version).toBe(PINNED);
    expect(installed.license).toBe("ISC");
  });
});

describe("the icon registry", () => {
  it("has the 40 purposes the accepted design names (an empty sweep would pass vacuously)", () => {
    expect(entries.length).toBe(40);
  });

  it.each(entries)("%s is an export of the installed package", (name, component) => {
    expect(component, `ICONS["${name}"] is undefined: its import is not an export`).toBeDefined();
    const names = exportNamesOf(component);
    expect(names, `ICONS["${name}"] is not an export of lucide-react ${PINNED}`).not.toEqual([]);
  });

  it.each(entries)("%s uses the canonical export, declared in the shipped types", (name, component) => {
    // Lucide keeps renamed icons as aliases (`Trash2` is `Trash` in 1.46.0).
    // The canonical name is the component's own displayName, and it is the
    // one name the type declarations declare as a constant.
    const canonical = (component as { displayName?: string } | undefined)?.displayName;
    expect(canonical, `ICONS["${name}"] has no displayName`).toEqual(expect.any(String));
    expect(exportTable[canonical as string]).toBe(component);
    expect(
      declarations.includes(`\ndeclare const ${canonical}: LucideIcon;\n`),
      `lucide-react ${PINNED} types do not declare ${canonical}`,
    ).toBe(true);
  });

  it("imports the canonical names, never an alias, and no wildcard", () => {
    const source = read("components", "icons", "registry.ts");
    const block = /import \{([^}]+)\} from "lucide-react";/.exec(source);
    expect(block, "registry.ts must use one named import from lucide-react").not.toBeNull();
    const imported = (block?.[1] ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "" && !part.startsWith("type "));
    const canonical = entries.map(([, component]) => (component as { displayName: string }).displayName);
    expect([...imported].sort()).toEqual([...canonical].sort());
    expect(source).not.toMatch(/import \* as|DynamicIcon|lucide-react\/dynamic/);
  });

  it("gives every purpose its own glyph (favorite and rating must not be the same icon)", () => {
    expect(new Set(entries.map(([, component]) => component)).size).toBe(entries.length);
    expect(ICONS.favorite).not.toBe(ICONS.rating);
  });

  it("names purposes in kebab-case", () => {
    for (const [name] of entries) expect(name).toMatch(/^[a-z]+(-[a-z]+)*$/);
  });
});
