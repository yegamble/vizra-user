/**
 * Facts about a TypeScript source file, read from a PARSED TREE.
 *
 * WHY THIS EXISTS, AND WHAT IT REPLACES. `scripts/ci/check-e2e-lane.mjs` used to
 * assert that the harness still CALLS its own guard functions by running a regex
 * over the source with comments crudely removed. Its header claimed that the
 * stripping "can only make the patterns match LESS, i.e. fail closed". That
 * sentence was FALSE, and an independent verifier measured three ways through it
 * (PR #7 re-verification, FINDING 7; reproduced by a second verifier at
 * `f0ee8f1`). With the CALL deleted in each case:
 *
 *     nothing left behind                       -> RED   (the control working)
 *     `// name(…)` starting a line              -> RED   (stripped)
 *     a block comment / JSDoc naming it         -> RED   (stripped)
 *     `void 0; // name(a, b)`  TRAILING comment -> GREEN   DEFEATED
 *     `const s = "name(";`     string literal   -> GREEN   DEFEATED
 *     `void name(a, b);`       call-and-discard -> GREEN   DEFEATED
 *
 * The third of those was driven end to end on the one control the canary cannot
 * reach: delete the orphan assertion from `e2e/harness/test.ts`, leave
 * `// formatOrphans(…)` trailing, and `tsc`, the lane guard, the canary and an
 * `afterAll` that breaks a page were all green.
 *
 * A comment is not a node and a string literal is not a call, so parsing removes
 * the first two defeats by construction rather than by a better regex — which is
 * the point: this file exists because the previous three fixes were all better
 * regexes. The `void` form is refused explicitly below.
 *
 * WHAT IT STILL CANNOT DECIDE, and the honest sentence that goes with it:
 * whether a call's RESULT is used in a way that matters. `const _ = f();`, a call
 * inside a branch that never runs, and a call whose return value is dropped on
 * the floor all satisfy `hasGenuineCall`. That is not decidable by a parser
 * without a type checker and a reachability analysis, and pretending otherwise
 * would be the same overstatement this module was written to retract. The
 * general case is **review-only**, and `AGENTS.md § Residuals` says so. What is
 * refused here is the `void` spelling, because that is the spelling an
 * independent verifier actually reached for.
 *
 * SHADOWING IS REFUSED TOO. Matching "a call to an identifier named X" without
 * asking WHICH X trades a string defeat for a scope defeat: a local
 * `const guardBrowser = () => {};` above the call satisfies a naive AST matcher
 * exactly as a string literal satisfied the regex. Every enclosing scope is
 * therefore walked, and a binding of the same name that is not the module's own
 * import makes the check FAIL CLOSED with a distinct reason.
 *
 * No new dependency: `typescript` is already a direct devDependency (5.9.3), and
 * is what `npm run typecheck` uses.
 */

import ts from "typescript";

/** Parse a TS source. Parent pointers are required for the scope walk. */
export function parseTypeScript(fileName, source) {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** Every identifier a binding name introduces, destructuring patterns included. */
function bindingNames(name, into) {
  if (!name) return into;
  if (ts.isIdentifier(name)) {
    into.add(name.text);
    return into;
  }
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) bindingNames(element.name, into);
    }
  }
  return into;
}

function isScopeIntroducer(node) {
  return (
    ts.isSourceFile(node) ||
    ts.isBlock(node) ||
    ts.isModuleBlock(node) ||
    ts.isCaseBlock(node) ||
    ts.isCatchClause(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node)
  );
}

/**
 * The names a single scope introduces, each tagged `"import"` or `"value"`.
 * Only the scope's OWN declarations — nested scopes are not descended into,
 * which is what makes the upward walk in `resolveBinding` correct.
 */
function declaredIn(scope) {
  const names = new Map();
  const addValue = (name) => {
    for (const id of bindingNames(name, new Set())) names.set(id, "value");
  };

  const visitStatements = (statements) => {
    for (const statement of statements) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) addValue(declaration.name);
      } else if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
        if (statement.name) names.set(statement.name.text, "value");
      } else if (ts.isImportDeclaration(statement) && statement.importClause) {
        const clause = statement.importClause;
        if (clause.name) names.set(clause.name.text, "import");
        const bindings = clause.namedBindings;
        if (bindings) {
          if (ts.isNamespaceImport(bindings)) names.set(bindings.name.text, "import");
          else for (const element of bindings.elements) names.set(element.name.text, "import");
        }
      }
    }
  };

  if (ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isModuleBlock(scope)) {
    visitStatements(scope.statements);
  } else if (ts.isCaseBlock(scope)) {
    for (const clause of scope.clauses) visitStatements(clause.statements);
  } else if (ts.isCatchClause(scope)) {
    if (scope.variableDeclaration) addValue(scope.variableDeclaration.name);
  } else if (ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)) {
    const initializer = scope.initializer;
    if (initializer && ts.isVariableDeclarationList(initializer)) {
      for (const declaration of initializer.declarations) addValue(declaration.name);
    }
  } else if (ts.isClassDeclaration(scope) || ts.isClassExpression(scope)) {
    if (scope.name) names.set(scope.name.text, "value");
  } else {
    // function-like: its parameters, and its own name where it has one.
    for (const parameter of scope.parameters ?? []) addValue(parameter.name);
    if (scope.name && ts.isIdentifier(scope.name)) names.set(scope.name.text, "value");
  }

  return names;
}

/**
 * Walk outward from `node` and say what `name` resolves to:
 * `"import"` (the module's own import — the only acceptable answer),
 * `"value"` (a local or module-level binding that SHADOWS it), or
 * `"unresolved"` (declared nowhere in this file).
 */
function resolveBinding(node, name) {
  for (let current = node.parent; current; current = current.parent) {
    if (!isScopeIntroducer(current)) continue;
    const kind = declaredIn(current).get(name);
    if (kind !== undefined) return kind;
  }
  return "unresolved";
}

/** Strip the wrappers that sit between a call and the expression that consumes it. */
function consumerOf(call) {
  let current = call.parent;
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isTypeAssertionExpression?.(current))
  ) {
    current = current.parent;
  }
  return current;
}

function forEachNode(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => forEachNode(child, visit));
}

/**
 * Is there a real, unshadowed, non-`void`-discarded call to `name` in this file?
 *
 * Returns `{ ok, reason }`. `reason` is one of:
 *   "absent"          no call expression names it at all
 *   "void-discarded"  every call is the operand of `void`
 *   "shadowed"        the callee resolves to a local binding, not the import
 * The reason is reported so a red lane says WHICH defeat it is looking at, not
 * merely that a string was missing.
 */
export function hasGenuineCall(sourceFile, name) {
  let sawCall = false;
  let sawUnshadowed = false;
  let ok = false;

  forEachNode(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    if (!ts.isIdentifier(callee) || callee.text !== name) return;
    sawCall = true;

    if (resolveBinding(node, name) === "value") return;
    sawUnshadowed = true;

    const consumer = consumerOf(node);
    if (consumer && ts.isVoidExpression(consumer)) return;
    ok = true;
  });

  if (ok) return { ok: true };
  if (!sawCall) return { ok: false, reason: "absent" };
  if (!sawUnshadowed) return { ok: false, reason: "shadowed" };
  return { ok: false, reason: "void-discarded" };
}

/**
 * Is `name` REFERENCED somewhere other than an import statement?
 *
 * The eleventh lane check demanded only the presence of the string
 * `STAMP_ANNOTATION`. A second verifier measured the consequence at `f0ee8f1`:
 * deleting the whole `testInfo.annotations.push({ type: STAMP_ANNOTATION, … })`
 * statement leaves the guard GREEN, because the identifier survives on its own
 * import line — the same import-satisfies-a-name defect the other ten checks
 * were fixed for. It was immaterial there only because two runtime controls sit
 * behind that symbol. It is fixed here anyway, since parsing makes it free.
 */
export function hasNonImportReference(sourceFile, name) {
  let found = false;
  forEachNode(sourceFile, (node) => {
    if (found || !ts.isIdentifier(node) || node.text !== name) return;
    for (let current = node.parent; current; current = current.parent) {
      if (ts.isImportDeclaration(current) || ts.isExportDeclaration(current)) return;
      if (ts.isSourceFile(current)) break;
    }
    found = true;
  });
  return found;
}

/**
 * Is there an object-literal property whose name is `name` anywhere in the file?
 * Used for the fixture declarations (`vizraHarnessGuard:`, `vizraWorkerGuard:`),
 * where a string literal naming the fixture previously satisfied the check.
 */
export function hasObjectProperty(sourceFile, name) {
  let found = false;
  forEachNode(sourceFile, (node) => {
    if (found) return;
    if (!ts.isPropertyAssignment(node) && !ts.isShorthandPropertyAssignment(node) && !ts.isMethodDeclaration(node)) {
      return;
    }
    const key = node.name;
    if (!key) return;
    const text = ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : undefined;
    if (text === name) found = true;
  });
  return found;
}

/**
 * Does the file `import` this exact module specifier — as a side-effect import,
 * a named one, a default one, or a namespace one?
 *
 * `playwright.config.ts`'s `import "./e2e/harness/test"` is a LOAD-BEARING side
 * effect: it is what lets `e2e/harness/stamp.ts` take the per-run key out of the
 * worker's environment before any spec is loaded. Read from the tree rather than
 * with a regex so that the paragraph in that file explaining why the import is
 * load-bearing cannot stand in for the import.
 */
export function importsModule(sourceFile, specifier) {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const moduleSpecifier = statement.moduleSpecifier;
    if (ts.isStringLiteral(moduleSpecifier) && moduleSpecifier.text === specifier) return true;
  }
  return false;
}

/**
 * Does this exact module specifier appear anywhere as a STRING LITERAL VALUE?
 *
 * A Playwright reporter is registered as a string inside an array
 * (`["./e2e/harness/stamp-reporter"]`), so there is no import to look for. This
 * is still a tree read and not a grep: a specifier named in a comment, or spelled
 * across a concatenation, does not satisfy it.
 */
export function moduleSpecifierAppears(sourceFile, specifier) {
  let found = false;
  forEachNode(sourceFile, (node) => {
    if (found) return;
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === specifier) {
      found = true;
    }
  });
  return found;
}

const UNREADABLE = Symbol("unreadable");
export { UNREADABLE };

/**
 * The OPTIONS of a Playwright fixture declared in the tuple form
 * `name: [fn, { scope: "worker", auto: true }]`, as a plain object of the
 * literal values this function can read.
 *
 * Returns `undefined` when the fixture is not declared in that form at all, and
 * `UNREADABLE` when it is declared but its options are not a literal object —
 * which a caller must treat as a failure, since a guard that cannot read its
 * subject must not say yes. Checked this way rather than with a regex over
 * `scope:\s*"worker"` because that regex is satisfied by any string anywhere in
 * the file, including a comment explaining why the fixture is worker-scoped.
 */
export function fixtureOptions(sourceFile, fixtureName) {
  let result;
  forEachNode(sourceFile, (node) => {
    if (result !== undefined) return;
    if (!ts.isPropertyAssignment(node)) return;
    const key = node.name;
    const text = ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : undefined;
    if (text !== fixtureName) return;
    const value = node.initializer;
    if (!ts.isArrayLiteralExpression(value) || value.elements.length < 2) {
      result = UNREADABLE;
      return;
    }
    const options = value.elements[1];
    if (!ts.isObjectLiteralExpression(options)) {
      result = UNREADABLE;
      return;
    }
    const read = {};
    for (const property of options.properties) {
      if (!ts.isPropertyAssignment(property)) {
        result = UNREADABLE;
        return;
      }
      const name = property.name;
      const propertyName = ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
      if (propertyName === undefined) {
        result = UNREADABLE;
        return;
      }
      const initializer = property.initializer;
      if (initializer.kind === ts.SyntaxKind.TrueKeyword) read[propertyName] = true;
      else if (initializer.kind === ts.SyntaxKind.FalseKeyword) read[propertyName] = false;
      else if (ts.isStringLiteral(initializer)) read[propertyName] = initializer.text;
      else read[propertyName] = UNREADABLE;
    }
    result = read;
  });
  return result;
}

/**
 * Does the file override a Playwright BUILT-IN fixture by assigning a function
 * to it inside a `.extend({ … })` call? Used for the `page` override, which is
 * where the guard used to live and must not live again: a page-scoped guard is
 * removable by `test.extend({ page: … })` in a spec with the stamp left intact
 * (FINDING 11). A property whose value is not a function — a viewport object, a
 * string — is not an override of the fixture's behaviour and is not reported.
 */
export function overridesFixtureWithFunction(sourceFile, fixtureName) {
  let found = false;
  forEachNode(sourceFile, (node) => {
    if (found || !ts.isCallExpression(node)) return;
    const callee = node.expression;
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "extend") return;
    const argument = node.arguments[0];
    if (!argument || !ts.isObjectLiteralExpression(argument)) return;
    for (const property of argument.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const key = property.name;
      const text = ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : undefined;
      if (text !== fixtureName) continue;
      const value = property.initializer;
      if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) found = true;
    }
  });
  return found;
}

/**
 * Read a top-level property of the object literal a module `export default`s —
 * which is the shape of every Playwright configuration here, whether written as
 * `export default defineConfig({ … })` or `export default { … }`.
 *
 * Returns the string value, `undefined` when the key is absent, or `UNREADABLE`
 * when the key is present but its value is not a literal this function can read.
 * A caller must treat `UNREADABLE` as a failure: a guard that cannot tell must
 * not say yes. That is the same rule `hidesFailure` already applies to
 * `continue-on-error` in the lane guard.
 */
function defaultExportedObject(sourceFile) {
  let objectLiteral;
  for (const statement of sourceFile.statements) {
    if (!ts.isExportAssignment(statement) || statement.isExportEquals) continue;
    let expression = statement.expression;
    for (let hop = 0; hop < 4; hop += 1) {
      while (
        ts.isParenthesizedExpression(expression) ||
        ts.isAsExpression(expression) ||
        ts.isSatisfiesExpression(expression)
      ) {
        expression = expression.expression;
      }
      // `export default defineConfig({ … })`
      if (ts.isCallExpression(expression) && expression.arguments.length > 0) {
        expression = expression.arguments[0];
        continue;
      }
      // `const cfg = { … }; export default cfg;` — the demos configuration's
      // shape. Followed rather than refused, because refusing it would make the
      // guard's answer depend on where an author put a newline.
      if (ts.isIdentifier(expression)) {
        const name = expression.text;
        let target;
        for (const candidate of sourceFile.statements) {
          if (!ts.isVariableStatement(candidate)) continue;
          for (const declaration of candidate.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer) {
              target = declaration.initializer;
            }
          }
        }
        if (!target) break;
        expression = target;
        continue;
      }
      break;
    }
    if (ts.isObjectLiteralExpression(expression)) objectLiteral = expression;
  }
  return objectLiteral;
}

export function defaultExportProperty(sourceFile, name) {
  const objectLiteral = defaultExportedObject(sourceFile);
  if (!objectLiteral) return UNREADABLE;

  for (const property of objectLiteral.properties) {
    const key = property.name;
    const text = key && (ts.isIdentifier(key) || ts.isStringLiteral(key)) ? key.text : undefined;
    if (text !== name) continue;
    if (!ts.isPropertyAssignment(property)) return UNREADABLE;
    const value = property.initializer;
    if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
    return UNREADABLE;
  }
  return undefined;
}

/**
 * Does the module's default-exported configuration object declare `name` as a
 * top-level key, in any form? `defaultExportProperty` answers "what is its
 * value"; this answers "is it there at all", which is what a refusal needs.
 *
 * A configuration whose default export cannot be read as an object literal
 * answers `true` for every key, so an unreadable config is refused rather than
 * waved through — `globalSetup` behind a spread or a computed key must not be a
 * way past this.
 */
export function defaultExportDeclaresKey(sourceFile, name) {
  const objectLiteral = defaultExportedObject(sourceFile);
  // A default export this function cannot resolve to an object literal answers
  // `true` for every key: the key could be anywhere inside it, and a guard that
  // cannot rule something out must not say it is absent.
  if (!objectLiteral) return { declared: true, via: "unreadable-default-export" };

  for (const property of objectLiteral.properties) {
    if (ts.isSpreadAssignment(property)) {
      // A spread could carry the key. Where the spread is a plain identifier
      // bound to an `import … from "./other-config"`, the answer is deferred to
      // that FILE, which the caller checks in its own right — the demos
      // configuration spreads the lane configuration, and refusing that outright
      // would be a guard that fails on the repository's own honest shape rather
      // than on a weakness. Any other spread fails closed.
      const source = property.expression;
      if (ts.isIdentifier(source)) {
        const specifier = importedFrom(sourceFile, source.text);
        if (specifier !== undefined) continue;
      }
      return { declared: true, via: "unreadable-spread" };
    }
    const key = property.name;
    if (!key) continue;
    if (ts.isComputedPropertyName(key)) return { declared: true, via: "computed-key" };
    const text = ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : undefined;
    if (text === name) return { declared: true, via: "literal-key" };
  }
  return { declared: false };
}

/** The module specifier a module-level import binds `name` from, if any. */
function importedFrom(sourceFile, name) {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    const clause = statement.importClause;
    const specifier = ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : undefined;
    if (clause.name && clause.name.text === name) return specifier;
    const bindings = clause.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) {
      if (bindings.name.text === name) return specifier;
    } else {
      for (const element of bindings.elements) if (element.name.text === name) return specifier;
    }
  }
  return undefined;
}

/** A string literal whose value STARTS WITH `prefix` — a module specifier with
 * or without its extension (`"./x/stamp-reporter"` vs `"./x/stamp-reporter.ts"`).
 */
export function moduleSpecifierStartsWith(sourceFile, prefix) {
  let found = false;
  forEachNode(sourceFile, (node) => {
    if (found) return;
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      node.text.startsWith(prefix)
    ) {
      found = true;
    }
  });
  return found;
}

/**
 * The plain value of a literal expression: a string, number, boolean, `null`,
 * or an object literal of such values with plain keys. Anything else (an
 * identifier, a call, a spread, a computed key, a template with substitutions)
 * is `UNREADABLE`, and so is an object containing one: a guard that asserts a
 * value must be able to read all of it, or it must not say yes.
 */
function literalValue(node) {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    node = node.expression;
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text.replace(/_/g, ""));
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isObjectLiteralExpression(node)) {
    const value = {};
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) return UNREADABLE;
      const key = property.name;
      if (!(ts.isIdentifier(key) || ts.isStringLiteral(key))) return UNREADABLE;
      const inner = literalValue(property.initializer);
      if (inner === UNREADABLE) return UNREADABLE;
      value[key.text] = inner;
    }
    return value;
  }
  return UNREADABLE;
}

/**
 * The property `name` of an object literal, for a key-path walk. A spread or a
 * computed key could supply or override `name`, so either one makes the answer
 * `UNREADABLE` rather than "absent". A plain key whose value is not written in
 * the object (a shorthand `{ baseURL }`) is readable only as "present".
 */
function ownProperty(objectLiteral, name) {
  let found;
  for (const property of objectLiteral.properties) {
    if (ts.isSpreadAssignment(property)) return UNREADABLE;
    const key = property.name;
    if (!key || ts.isComputedPropertyName(key)) return UNREADABLE;
    const text = ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : undefined;
    if (text !== name) continue;
    found = ts.isPropertyAssignment(property) ? property.initializer : UNREADABLE;
  }
  return found;
}

/**
 * The LITERAL value at a key path inside the module's default-exported
 * configuration object, e.g. `["use", "screenshot"]`.
 *
 * A SOURCE READER, AND ONLY AN EARLY WARNING. It reads `arguments[0]` of the
 * exported call and an identifier's initializer, nothing else: a second call
 * argument, a later assignment, an `Object.assign` on an imported object or a
 * mutated device descriptor are all invisible to it, and each was measured
 * turning the recorders back on while it answered OK (PR #10 VERIFY, E1–E5). The
 * control for the recorder values is the runtime check on the RESOLVED options
 * (`e2e/harness/recorders.ts`). "Fails closed" below is about what this function
 * reads, not about the configuration Playwright loads.
 *
 * Returns the plain value, `undefined` when the path is absent, or `UNREADABLE`
 * when any object on the path carries a spread or a computed key (either could
 * supply the key), or the value is not a literal. A caller asserting a value
 * must treat both `undefined` and `UNREADABLE` as a failure.
 */
export function defaultExportLiteralAt(sourceFile, keyPath) {
  let node = defaultExportedObject(sourceFile);
  if (!node) return UNREADABLE;
  for (const name of keyPath) {
    while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
      node = node.expression;
    }
    if (!ts.isObjectLiteralExpression(node)) return UNREADABLE;
    const next = ownProperty(node, name);
    if (next === undefined || next === UNREADABLE) return next;
    node = next;
  }
  return literalValue(node);
}

/**
 * Does any entry of the default-exported configuration's `projects` array set
 * one of `keys` in its `use`, or hide one where this function cannot see?
 *
 * Returns a list of human-readable findings, empty when every project is read in
 * full and sets none of the keys. The ONE spread a project's `use` may carry is
 * a Playwright device descriptor, `...devices["<string literal>"]`, with
 * `devices` imported from `@playwright/test`: the installed 1.63.0 descriptors
 * were read and none carries `screenshot`, `video` or `trace` (207 descriptors,
 * 2026-09-23). Every other spread, a computed key, or a `projects` value that is
 * not an array of object literals is a finding, because the key could be in it.
 */
export function projectsSettingUseKeys(sourceFile, keys) {
  const findings = [];
  const root = defaultExportedObject(sourceFile);
  if (!root) return ["the default export could not be read as an object literal"];
  const projects = ownProperty(root, "projects");
  if (projects === undefined) return findings;
  if (projects === UNREADABLE || !ts.isArrayLiteralExpression(projects)) {
    return ["`projects` is not an array literal this guard can read"];
  }
  projects.elements.forEach((element, index) => {
    if (!ts.isObjectLiteralExpression(element)) {
      findings.push(`project #${index + 1} is not an object literal`);
      return;
    }
    for (const property of element.properties) {
      const key = property.name;
      if (ts.isSpreadAssignment(property) || !key || ts.isComputedPropertyName(key)) {
        findings.push(`project #${index + 1} has a spread or computed key`);
        continue;
      }
      const text = ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : undefined;
      if (keys.includes(text)) findings.push(`project #${index + 1} sets \`${text}\` outside \`use\``);
      if (text !== "use") continue;
      const use = ts.isPropertyAssignment(property) ? property.initializer : undefined;
      if (!use || !ts.isObjectLiteralExpression(use)) {
        findings.push(`project #${index + 1}'s \`use\` is not an object literal`);
        continue;
      }
      for (const entry of use.properties) {
        if (ts.isSpreadAssignment(entry)) {
          if (isDeviceDescriptor(sourceFile, entry.expression)) continue;
          findings.push(`project #${index + 1}'s \`use\` spreads something other than a device descriptor`);
          continue;
        }
        const entryKey = entry.name;
        if (!entryKey || ts.isComputedPropertyName(entryKey)) {
          findings.push(`project #${index + 1}'s \`use\` has a computed key`);
          continue;
        }
        const entryText = ts.isIdentifier(entryKey) || ts.isStringLiteral(entryKey) ? entryKey.text : undefined;
        if (keys.includes(entryText)) findings.push(`project #${index + 1}'s \`use\` sets \`${entryText}\``);
      }
    }
  });
  return findings;
}

/** `devices["<string literal>"]`, with `devices` imported from `@playwright/test`. */
function isDeviceDescriptor(sourceFile, expression) {
  return (
    ts.isElementAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "devices" &&
    importedFrom(sourceFile, "devices") === "@playwright/test" &&
    ts.isStringLiteral(expression.argumentExpression)
  );
}

/**
 * The Playwright configuration a script selects, read from its PARSED source.
 *
 * Returns findings (empty when the script selects exactly `expected`): the
 * script must contain exactly one string literal `--config`, immediately
 * followed, in the same array literal, by the string literal `expected`; and no
 * other configuration selector anywhere: no `-c`, no `--config=…`, no second
 * `--config`, no other string naming a `playwright…config` file, and no template
 * literal with substitutions that mentions `config`. A non-literal element after
 * `--config` is a finding, because the value cannot be read.
 */
export function configArgumentFindings(sourceFile, expected) {
  const findings = [];
  const selectors = [];
  forEachNode(sourceFile, (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const text = node.text;
      if (text === "--config" || text === "-c" || text.startsWith("--config=")) selectors.push(node);
      else if (/playwright[\w.-]*config/.test(text) && text !== expected) {
        findings.push(`a second configuration is named (${JSON.stringify(text)})`);
      }
    } else if (ts.isTemplateExpression(node) && /config/i.test(node.getText(sourceFile))) {
      findings.push("a template literal with substitutions mentions `config`, which this guard cannot read");
    }
  });
  if (selectors.length !== 1) {
    findings.push(`it has ${selectors.length} configuration selector(s); exactly one \`--config\` is required`);
    return findings;
  }
  const [selector] = selectors;
  if (selector.text !== "--config") {
    findings.push(`its configuration selector is ${JSON.stringify(selector.text)}, not \`--config\` followed by a literal`);
    return findings;
  }
  const array = selector.parent;
  if (!array || !ts.isArrayLiteralExpression(array)) {
    findings.push("`--config` is not an element of an array literal this guard can read");
    return findings;
  }
  const next = array.elements[array.elements.indexOf(selector) + 1];
  if (!next || !(ts.isStringLiteral(next) || ts.isNoSubstitutionTemplateLiteral(next))) {
    findings.push("the element after `--config` is not a string literal this guard can read");
  } else if (next.text !== expected) {
    findings.push(`\`--config\` selects ${JSON.stringify(next.text)}`);
  }
  return findings;
}
