/**
 * ESLint rule: a Playwright spec may only get `test`/`expect` from the guarded
 * harness entry, and may not reach `@playwright/test` at all.
 *
 * WHY THIS IS A RULE AND NOT A REGEX. The first version of this control was a
 * regex sweep over each spec's source:
 *
 *     /^\s*import\s+\{[^}]*\}\s+from\s+"@playwright\/test";?$/gm
 *
 * An independent verifier walked through it twice, with a spec whose page
 * 404s and throws an uncaught error on every load:
 *
 *     import * as pw from "@playwright/test";  const test = pw.test;   // braces?  no
 *     import { expect, test } from '@playwright/test';                 // quotes?  single
 *
 * Both gave `npm run ci` exit 0 and `npm run e2e` exit 0 — "20 passed,
 * coverage floor: OK" — on a broken page. Matching import SYNTAX is guessing
 * at spellings; the spellings are unbounded (namespace, default, side-effect,
 * `require`, dynamic `import()`, either quote style, a local shim that
 * re-exports the raw binding). So this rule works on the AST and on the module
 * SPECIFIER, which is the thing that actually has to be true.
 *
 * TWO BANS.
 *
 * 1. **Nothing in a guarded file may reference `@playwright/test`.** Any string
 *    literal or template literal naming the package — wherever it appears, in
 *    an import, a `require`, a dynamic `import()`, a computed member, anything
 *    — is an error. The single exception is a position that provably cannot
 *    yield a runnable `test`: a fully type-only `import type … from` and an
 *    inline `import("@playwright/test").Page` in a type position. A type import
 *    of `test` or `expect` is still refused, because there is no honest reason
 *    to want the type of the thing you are forbidden to call, and allowing it
 *    would put a value-shaped name one `importKind` edit away from working.
 *
 * 2. **`test` and `expect` may only come from the harness entry.** Importing
 *    either name from any other module is an error, which is what closes the
 *    shim: `e2e/specs/shim.ts` re-exporting the raw `test` does not work,
 *    because the shim's own reference to the package is ban 1 and importing
 *    `test` from the shim is ban 2. Re-exporting from a guarded file
 *    (`export { test } from …`) is refused for the same reason.
 *
 * SCOPE. Enabled in `eslint.config.mjs` for `e2e/specs/**` and `e2e/demos/**` —
 * every file Playwright can collect as a test. `e2e/harness/**` is deliberately
 * NOT guarded: it is the module that must import the real Playwright, and it is
 * the directory `.github/CODEOWNERS` covers.
 *
 * Options: `{ harnessEntry: "e2e/harness/test" }` — repository-root-relative,
 * extension-less.
 */

import path from "node:path";

/**
 * Every package that can yield a runnable `test`, or the browser API a spec
 * could drive around the harness.
 *
 * `playwright/test` is here because an independent verifier found that
 * `import * as pw from "playwright/test"` passed lint and RAN — the unscoped
 * package re-exports the same runner. It failed the lane only because loading a
 * second runner copy breaks the real tests, which is a module-loading accident,
 * not a control. `playwright` (the library, not the runner) is here for the
 * same reason one level down: nothing in a spec has any business launching its
 * own browser.
 *
 * Subpaths count: `@playwright/test/reporter`, `playwright/lib/…`, anything
 * under a banned root.
 */
const PACKAGES = ["@playwright/test", "playwright/test", "playwright"];
const GUARDED_NAMES = new Set(["test", "expect"]);

/** Does this specifier string name a banned package (or a subpath of one)? */
function referencesPlaywright(value) {
  if (typeof value !== "string") return false;
  return PACKAGES.some((name) => value === name || value.startsWith(`${name}/`));
}

/** The cooked string of a Literal or a no-substitution template literal. */
function stringValueOf(node) {
  if (!node) return undefined;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis.map((quasi) => quasi.value.cooked ?? "").join("");
  }
  return undefined;
}

/** An `import type … from "x"` declaration, or one whose every specifier is `type`. */
function isTypeOnlyImport(declaration) {
  if (declaration.importKind === "type") return true;
  const specifiers = declaration.specifiers ?? [];
  if (specifiers.length === 0) return false; // side-effect import: runs the module
  return specifiers.every((specifier) => specifier.importKind === "type");
}

/** Names a type-only import brings in, so `import type { test }` can still be refused. */
function importedNames(declaration) {
  const names = [];
  for (const specifier of declaration.specifiers ?? []) {
    if (specifier.type === "ImportSpecifier") {
      names.push(specifier.imported.name ?? specifier.imported.value);
    } else if (specifier.type === "ImportDefaultSpecifier") {
      names.push("default");
    } else if (specifier.type === "ImportNamespaceSpecifier") {
      names.push("*");
    }
  }
  return names;
}

/**
 * Is this module specifier the harness entry?
 *
 * `../harness/test`, `../harness/test.ts` and `@/e2e/harness/test` must all
 * answer yes. The comparison is on the PATH SUFFIX rather than on a
 * repository-root-relative path, deliberately: the rule must give the same
 * answer under `npx eslint`, under an editor, and under `RuleTester` (which
 * does not necessarily run with the repository root as its cwd). A cwd-
 * dependent answer would mean the rule is enforced in one place and silently
 * inert in another, which is the whole defect class this rule exists to close.
 */
function isHarnessEntry(specifier, filename, entry) {
  let candidate = specifier;
  if (candidate.startsWith("@/")) candidate = candidate.slice(2);
  const absolute = candidate.startsWith(".")
    ? path.resolve(path.dirname(filename), candidate)
    : candidate;
  const normalised = absolute.replace(/\\/g, "/").replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "");
  const wanted = entry.replace(/^\.?\//, "");
  return normalised === wanted || normalised.endsWith(`/${wanted}`);
}

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Playwright specs must take `test`/`expect` from the guarded harness entry and must not reference @playwright/test.",
    },
    schema: [
      {
        type: "object",
        properties: { harnessEntry: { type: "string" } },
        additionalProperties: false,
      },
    ],
    messages: {
      packageReference:
        "This file must not reference `{{specifier}}`. Playwright's own `test` is not guarded: a spec that uses it is exempt from the console/network/page-error checks in e2e/harness/test.ts, and passes while the page is broken. Import { test, expect } from the harness entry ({{entry}}) instead.",
      typeImportOfGuardedName:
        "`{{name}}` may not be imported from `{{specifier}}`, even as a type. Take it from the harness entry ({{entry}}): a type-only import of a value-shaped name is one `importKind` edit away from bypassing the guard.",
      wrongSource:
        "`{{name}}` must be imported from the harness entry ({{entry}}), not from `{{specifier}}`. A module that re-exports Playwright's raw `test` is a bypass with extra steps.",
      reExport:
        "This file must not re-export from `{{specifier}}`. Re-exporting makes the unguarded `test` reachable from a spec that looks compliant.",
    },
  },

  create(context) {
    const entry = context.options[0]?.harnessEntry ?? "e2e/harness/test";
    const filename = context.filename ?? context.getFilename();

    /** The one ban-1 exemption: a type position that cannot produce a value. */
    const typePositionLiterals = new WeakSet();

    const reportPackage = (node, specifier) =>
      context.report({ node, messageId: "packageReference", data: { specifier, entry } });

    return {
      // `import("@playwright/test").Page` — a TYPE, never a value. Mark its
      // literal so the catch-all below leaves it alone.
      TSImportType(node) {
        // The property has been spelled `parameter`, then `argument`, then
        // `source` across typescript-eslint majors (v8.70.0 uses `source`).
        // All three are accepted rather than pinned to today's spelling: if a
        // future parser renames it again, the exemption disappears and the
        // rule gets STRICTER (a legitimate type import starts failing and is
        // fixed deliberately), never looser.
        const literal = node.source ?? node.argument ?? node.parameter;
        const inner = literal?.type === "TSLiteralType" ? literal.literal : literal;
        if (inner) typePositionLiterals.add(inner);
      },

      ImportDeclaration(node) {
        const specifier = stringValueOf(node.source);
        if (specifier === undefined) return;

        if (referencesPlaywright(specifier)) {
          // Mark the source either way, so the catch-all below does not report
          // the same literal a second time.
          typePositionLiterals.add(node.source);
          if (!isTypeOnlyImport(node)) {
            reportPackage(node, specifier);
            return;
          }
          // Type-only: allowed, EXCEPT for the two names that matter.
          for (const name of importedNames(node)) {
            if (GUARDED_NAMES.has(name) || name === "default" || name === "*") {
              context.report({
                node,
                messageId: "typeImportOfGuardedName",
                data: { name, specifier, entry },
              });
            }
          }
          return;
        }

        // Ban 2: `test`/`expect` may only come from the harness entry.
        if (isHarnessEntry(specifier, filename, entry)) return;
        for (const imported of node.specifiers ?? []) {
          const localName = imported.local?.name;
          const importedName =
            imported.type === "ImportSpecifier"
              ? (imported.imported.name ?? imported.imported.value)
              : undefined;
          if (GUARDED_NAMES.has(importedName) || GUARDED_NAMES.has(localName)) {
            context.report({
              node: imported,
              messageId: "wrongSource",
              data: { name: importedName ?? localName, specifier, entry },
            });
          }
        }
      },

      ExportNamedDeclaration(node) {
        const specifier = stringValueOf(node.source);
        if (specifier !== undefined && referencesPlaywright(specifier)) {
          context.report({ node, messageId: "reExport", data: { specifier, entry } });
          typePositionLiterals.add(node.source);
        }
      },

      ExportAllDeclaration(node) {
        const specifier = stringValueOf(node.source);
        if (specifier !== undefined && referencesPlaywright(specifier)) {
          context.report({ node, messageId: "reExport", data: { specifier, entry } });
          typePositionLiterals.add(node.source);
        }
      },

      // THE CATCH-ALL, and the reason this rule is spelling-agnostic. Any other
      // way of naming the package — `require("@playwright/test")`, a dynamic
      // `import(...)`, `createRequire(...)`, a computed member, a bare string
      // handed to something clever — is reported, because every one of them can
      // yield the unguarded `test`. Only the type positions marked above are
      // exempt. Run on exit so the handlers above have marked theirs.
      "Literal:exit"(node) {
        if (typePositionLiterals.has(node)) return;
        const value = stringValueOf(node);
        if (value !== undefined && referencesPlaywright(value)) reportPackage(node, value);
      },

      "TemplateLiteral:exit"(node) {
        if (typePositionLiterals.has(node)) return;
        const value = stringValueOf(node);
        if (value !== undefined && referencesPlaywright(value)) reportPackage(node, value);
      },
    };
  },
};

export default rule;
