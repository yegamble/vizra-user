/**
 * The parsed-source matcher's own tests.
 *
 * These are the three measured defeats of the regex it replaces, plus the two
 * the seat's review added (a shadowed callee, and an import line satisfying a
 * presence check), plus the inverse controls — because a matcher that refused
 * everything would pass all the red halves and be useless.
 *
 * The end-to-end halves live in `scripts/ci/require-checks_test.sh`, which drives
 * the real `check-e2e-lane.sh` against a mutated harness tree. These are the unit
 * layer underneath.
 */

import { describe, expect, it } from "vitest";

import {
  defaultExportDeclaresKey,
  defaultExportProperty,
  hasGenuineCall,
  hasNonImportReference,
  hasObjectProperty,
  importsModule,
  moduleSpecifierStartsWith,
  parseTypeScript,
  UNREADABLE,
} from "./ts-source-facts.mjs";

const parse = (source) => parseTypeScript("probe.ts", source);
const call = (source, name = "guardBrowser") => hasGenuineCall(parse(source), name);

const IMPORT = 'import { guardBrowser } from "./browser-errors";\n';

describe("hasGenuineCall — the control working", () => {
  it("finds a plain call", () => {
    expect(call(`${IMPORT}const g = guardBrowser(browser);`)).toEqual({ ok: true });
  });

  it("finds an awaited call", () => {
    expect(call(`${IMPORT}async function f() { await guardBrowser(browser); }`)).toEqual({ ok: true });
  });

  it("finds a call used in a condition", () => {
    expect(call(`${IMPORT}if (guardBrowser(browser)) { throw new Error("x"); }`)).toEqual({ ok: true });
  });

  it("finds a call nested inside another call", () => {
    expect(call(`${IMPORT}register(guardBrowser(browser));`)).toEqual({ ok: true });
  });
});

describe("hasGenuineCall — the three measured regex defeats", () => {
  it("a TRAILING line comment does NOT satisfy it (defeated the regex)", () => {
    expect(call(`${IMPORT}void 0; // guardBrowser(browser)`)).toEqual({ ok: false, reason: "absent" });
  });

  it("a STRING LITERAL does NOT satisfy it (defeated the regex)", () => {
    expect(call(`${IMPORT}const s = "guardBrowser(";`)).toEqual({ ok: false, reason: "absent" });
  });

  it("CALL-AND-DISCARD via `void` does NOT satisfy it (defeated the regex)", () => {
    expect(call(`${IMPORT}void guardBrowser(browser);`)).toEqual({ ok: false, reason: "void-discarded" });
  });

  it("`void` through parentheses is still refused", () => {
    expect(call(`${IMPORT}void (guardBrowser(browser));`)).toEqual({ ok: false, reason: "void-discarded" });
  });

  it("a line comment and a block comment are still refused, as before", () => {
    expect(call(`${IMPORT}// guardBrowser(browser)\n/* guardBrowser(browser) */`)).toEqual({
      ok: false,
      reason: "absent",
    });
  });

  it("a template literal naming it does not satisfy it", () => {
    expect(call(`${IMPORT}const s = \`guardBrowser(\${x})\`;`)).toEqual({ ok: false, reason: "absent" });
  });
});

describe("hasGenuineCall — shadowing, the defeat an AST matcher would have introduced", () => {
  it("a LOCAL binding of the same name does not satisfy it", () => {
    expect(
      call(`${IMPORT}function setup() { const guardBrowser = () => ({}); return guardBrowser(browser); }`),
    ).toEqual({ ok: false, reason: "shadowed" });
  });

  it("a PARAMETER of the same name does not satisfy it", () => {
    expect(call(`${IMPORT}function setup(guardBrowser) { return guardBrowser(browser); }`)).toEqual({
      ok: false,
      reason: "shadowed",
    });
  });

  it("a MODULE-LEVEL redefinition does not satisfy it", () => {
    expect(call(`const guardBrowser = () => ({});\nconst g = guardBrowser(browser);`)).toEqual({
      ok: false,
      reason: "shadowed",
    });
  });

  it("a shadow in a SIBLING scope does not hide a genuine call elsewhere", () => {
    expect(
      call(
        `${IMPORT}function other() { const guardBrowser = () => ({}); return guardBrowser(1); }\n` +
          `const g = guardBrowser(browser);`,
      ),
    ).toEqual({ ok: true });
  });

  it("an unresolved name still counts — the import may be re-exported", () => {
    expect(call("const g = guardBrowser(browser);")).toEqual({ ok: true });
  });
});

describe("hasGenuineCall — the honest limit, recorded rather than hidden", () => {
  it("assigning the result to an unused binding DOES satisfy it (review-only)", () => {
    // Not a bug: whether a result is "used in a way that matters" needs a type
    // checker and reachability analysis. AGENTS.md § Residuals says so.
    expect(call(`${IMPORT}const _unused = guardBrowser(browser);`)).toEqual({ ok: true });
  });

  it("a call in a branch that never runs DOES satisfy it (review-only)", () => {
    expect(call(`${IMPORT}if (false) { guardBrowser(browser); }`)).toEqual({ ok: true });
  });
});

describe("hasNonImportReference", () => {
  it("an import line alone does NOT satisfy it", () => {
    const source = 'import { STAMP_ANNOTATION } from "./stamp";\nconst x = 1;';
    expect(hasNonImportReference(parse(source), "STAMP_ANNOTATION")).toBe(false);
  });

  it("a real use satisfies it", () => {
    const source =
      'import { STAMP_ANNOTATION } from "./stamp";\n' +
      "testInfo.annotations.push({ type: STAMP_ANNOTATION, description: sig });";
    expect(hasNonImportReference(parse(source), "STAMP_ANNOTATION")).toBe(true);
  });

  it("a mention in a comment does not satisfy it", () => {
    const source = 'import { STAMP_ANNOTATION } from "./stamp";\n// STAMP_ANNOTATION is written below';
    expect(hasNonImportReference(parse(source), "STAMP_ANNOTATION")).toBe(false);
  });
});

describe("hasObjectProperty", () => {
  it("finds a fixture declaration", () => {
    expect(hasObjectProperty(parse("const t = base.extend({ vizraHarnessGuard: [f, { auto: true }] });"), "vizraHarnessGuard")).toBe(true);
  });

  it("a string naming it does not satisfy it", () => {
    expect(hasObjectProperty(parse('const s = "vizraHarnessGuard: ";'), "vizraHarnessGuard")).toBe(false);
  });
});

describe("defaultExportProperty / defaultExportDeclaresKey", () => {
  const config = (body) => parse(`import { defineConfig } from "@playwright/test";\nexport default defineConfig({${body}});`);

  it("reads a string property through defineConfig", () => {
    expect(defaultExportProperty(config('testDir: "./e2e/specs",'), "testDir")).toBe("./e2e/specs");
  });

  it("reports an absent key as undefined", () => {
    expect(defaultExportProperty(config('testDir: "./e2e/specs",'), "globalSetup")).toBeUndefined();
  });

  it("reports a non-literal value as UNREADABLE rather than absent", () => {
    expect(defaultExportProperty(config("testDir: dir,"), "testDir")).toBe(UNREADABLE);
  });

  it("declares a plain key", () => {
    expect(defaultExportDeclaresKey(config('globalSetup: "./setup.ts",'), "globalSetup")).toEqual({
      declared: true,
      via: "literal-key",
    });
  });

  it("does not declare a key that is only named in a comment", () => {
    expect(defaultExportDeclaresKey(config("// globalSetup: none\n"), "globalSetup")).toEqual({ declared: false });
  });

  it("does not declare a key that is only named in a string", () => {
    expect(defaultExportDeclaresKey(config('testDir: "globalSetup",'), "globalSetup")).toEqual({ declared: false });
  });

  it("FAILS CLOSED on a spread of something not imported from another config", () => {
    expect(defaultExportDeclaresKey(config("...shared,"), "globalSetup")).toEqual({
      declared: true,
      via: "unreadable-spread",
    });
  });

  it("DEFERS a spread of an imported config — that file is checked in its own right", () => {
    const withImport = parse(
      'import base from "./playwright.config";\nexport default { ...base, testDir: "./e2e/demos" };',
    );
    expect(defaultExportDeclaresKey(withImport, "globalSetup")).toEqual({ declared: false });
  });

  it("FAILS CLOSED on a computed key", () => {
    expect(defaultExportDeclaresKey(config("[key]: value,"), "globalSetup")).toEqual({
      declared: true,
      via: "computed-key",
    });
  });

  it("FAILS CLOSED when the default export cannot be resolved to an object", () => {
    expect(defaultExportDeclaresKey(parse("export default buildConfig(1);"), "globalSetup")).toEqual({
      declared: true,
      via: "unreadable-default-export",
    });
  });

  it("follows `const cfg = {…}; export default cfg;` — the demos config's shape", () => {
    const indirect = parse('const cfg = { testDir: "./e2e/demos" };\nexport default cfg;');
    expect(defaultExportProperty(indirect, "testDir")).toBe("./e2e/demos");
    expect(defaultExportDeclaresKey(indirect, "globalSetup")).toEqual({ declared: false });
    expect(defaultExportDeclaresKey(indirect, "testDir")).toEqual({ declared: true, via: "literal-key" });
  });

  it("reads a plain object default export too", () => {
    expect(defaultExportProperty(parse('export default { testDir: "./e2e/specs" };'), "testDir")).toBe("./e2e/specs");
  });
});

describe("importsModule / moduleSpecifierStartsWith", () => {
  it("finds a side-effect import", () => {
    expect(importsModule(parse('import "./e2e/harness/test";'), "./e2e/harness/test")).toBe(true);
  });

  it("a comment naming the import does not satisfy it", () => {
    expect(importsModule(parse('// import "./e2e/harness/test";'), "./e2e/harness/test")).toBe(false);
  });

  it("a string elsewhere in the file is not an import", () => {
    expect(importsModule(parse('const s = "./e2e/harness/test";'), "./e2e/harness/test")).toBe(false);
  });

  it("a reporter specifier is found with or without its extension", () => {
    const cfg = parse('export default { reporter: [["./e2e/harness/stamp-reporter.ts"]] };');
    expect(moduleSpecifierStartsWith(cfg, "./e2e/harness/stamp-reporter")).toBe(true);
  });

  it("a reporter named only in a comment is not found", () => {
    const cfg = parse('export default { reporter: [["list"]] }; // ./e2e/harness/stamp-reporter.ts');
    expect(moduleSpecifierStartsWith(cfg, "./e2e/harness/stamp-reporter")).toBe(false);
  });
});
