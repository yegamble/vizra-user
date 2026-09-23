/**
 * ESLint rule: a spec, a demonstration or a fixture outside `e2e/harness/**` may
 * READ `process.env.NAME` and do nothing else with `process.env`.
 *
 * WHY. Two environment variables decide whether Playwright writes the live page
 * into an uploaded artifact: `PLAYWRIGHT_NO_COPY_PROMPT` gates the `# Page
 * snapshot` section of `error-context.md` (an aria snapshot carrying every DOM
 * text node and every input's current value), and `CI` switches the harness's
 * runtime assertion of it on. An independent verifier switched both off with two
 * lines of ordinary TypeScript in a spec (PR #8, R3-FINDING J):
 *
 *     delete process.env.CI;
 *     process.env.PLAYWRIGHT_NO_COPY_PROMPT = "";
 *
 * `eslint` exit 0, the credential tripwire 11/11, `tsc` 0, the lane guard 0 —
 * and a typed value in the uploaded page snapshot.
 *
 * THIS IS THE EARLY WARNING, NOT THE CONTROL. The control is
 * `e2e/harness/ci-environment.ts`, which captures both values when the
 * configuration loads — before any spec is imported — and compares, restores and
 * fails the run by name at every boundary. This rule fails in seconds in
 * `npm run ci`, before anything runs.
 *
 * WHAT IT REFUSES, default-deny rather than a list of write spellings: every use
 * of `process.env` other than reading one member (`process.env.X`,
 * `process.env["X"]`, `process.env[name]`) or `"X" in process.env`. So an
 * assignment, `delete`, `++`, a destructuring target, `for (… in)`, and ANY
 * hand-off of the object — `Object.assign(process.env, …)`,
 * `Reflect.set/deleteProperty/defineProperty(process.env, …)`,
 * `const e = process.env`, `{ ...process.env }` — are errors, because once the
 * object is handed to something the rule cannot see what happens to it. `process`
 * itself may be used only as `process.<member>`; aliasing it, passing it, reaching
 * it through `globalThis`/`global`/`window`/`self`, `require("process")`, a dynamic
 * `import("process")`, or importing `env` from `process`/`node:process` is an
 * error for the same reason. A default or namespace import of `process` is
 * followed like the global.
 *
 * LIMITS, so this does not over-claim: `eval`, a `Function` constructor and a
 * helper module outside the linted glob are not followed. The runtime check is
 * what does not depend on spelling.
 */

const PROCESS_MODULES = new Set(["process", "node:process"]);
const GLOBAL_OBJECTS = new Set(["globalThis", "global", "window", "self"]);

/** The name a member expression reads, or undefined when it is computed from something unreadable. */
function memberName(node) {
  if (!node.computed) return node.property.type === "Identifier" ? node.property.name : undefined;
  if (node.property.type === "Literal" && typeof node.property.value === "string") return node.property.value;
  if (node.property.type === "TemplateLiteral" && node.property.expressions.length === 0) {
    return node.property.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
}

/** Is `node` the target of a write — assignment, update, delete, loop head, destructuring? */
function isWriteTarget(node) {
  const parent = node.parent;
  if (!parent) return false;
  switch (parent.type) {
    case "AssignmentExpression":
      return parent.left === node;
    case "UpdateExpression":
      return true;
    case "UnaryExpression":
      return parent.operator === "delete";
    case "ForInStatement":
    case "ForOfStatement":
      return parent.left === node;
    case "ArrayPattern":
    case "RestElement":
      return true;
    case "AssignmentPattern":
      return parent.left === node;
    case "Property":
      return parent.value === node && parent.parent?.type === "ObjectPattern";
    default:
      return false;
  }
}

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Outside the harness, `process.env` may only be READ. CI and PLAYWRIGHT_NO_COPY_PROMPT gate the page snapshot (AGENTS.md § Artifact privacy).",
    },
    schema: [],
    messages: {
      write:
        "vizra/no-process-env-write: this WRITES `process.env` ({{how}}). A spec may not change its own " +
        "environment: `CI` and `PLAYWRIGHT_NO_COPY_PROMPT` decide whether a live page snapshot is " +
        "uploaded, and a verifier switched both off from a spec (PR #8, R3-FINDING J). The harness " +
        "also refuses it at runtime.",
      handoff:
        "vizra/no-process-env-write: `process.env` is {{how}}, so this rule cannot see what is done " +
        "to it. Read one member (`process.env.NAME`) instead.",
      processAlias:
        "vizra/no-process-env-write: `process` is {{how}}. Outside the harness it may be used only " +
        "as `process.<member>`, so every write to `process.env` stays visible to this rule.",
      envImport:
        "vizra/no-process-env-write: importing `{{name}}` from `{{source}}` hands this file the " +
        "environment object under another name. Read `process.env.NAME` instead.",
      untrackable:
        "vizra/no-process-env-write: {{how}} reaches `process` by a route this rule cannot follow.",
    },
  },

  create(context) {
    const sourceCode = context.sourceCode;
    /** Identifiers that ARE `process`: the global, or a default/namespace import of it. */
    const processRefs = [];

    function checkEnvUse(envNode) {
      const parent = envNode.parent;
      if (parent?.type === "MemberExpression" && parent.object === envNode) {
        if (isWriteTarget(parent)) {
          const name = memberName(parent);
          const how =
            parent.parent.type === "UnaryExpression"
              ? `delete process.env.${name ?? "[…]"}`
              : `process.env.${name ?? "[…]"} as the target of ${parent.parent.type}`;
          context.report({ node: parent, messageId: "write", data: { how } });
        }
        return;
      }
      if (parent?.type === "BinaryExpression" && parent.operator === "in" && parent.right === envNode) return;
      if (isWriteTarget(envNode)) {
        context.report({ node: envNode, messageId: "write", data: { how: "replacing `process.env` itself" } });
        return;
      }
      const how =
        parent?.type === "CallExpression" || parent?.type === "NewExpression"
          ? `passed to ${sourceCode.getText(parent.callee)}(…)`
          : parent?.type === "SpreadElement"
            ? "spread"
            : parent?.type === "VariableDeclarator"
              ? "aliased to a variable"
              : `used as a value (${parent?.type ?? "unknown"})`;
      context.report({ node: envNode, messageId: "handoff", data: { how } });
    }

    function checkProcessUse(id) {
      const parent = id.parent;
      if (parent?.type === "MemberExpression" && parent.object === id) {
        const name = memberName(parent);
        if (name === undefined) {
          context.report({
            node: parent,
            messageId: "processAlias",
            data: { how: "indexed by a computed key the rule cannot read" },
          });
          return;
        }
        if (name === "env") checkEnvUse(parent);
        else if (isWriteTarget(parent)) {
          context.report({ node: parent, messageId: "processAlias", data: { how: `written (process.${name})` } });
        }
        return;
      }
      if (parent?.type === "UnaryExpression" && parent.operator === "typeof") return;
      if (parent?.type === "ImportDefaultSpecifier" || parent?.type === "ImportNamespaceSpecifier") return;
      const how =
        parent?.type === "CallExpression" || parent?.type === "NewExpression"
          ? `passed to ${sourceCode.getText(parent.callee)}(…)`
          : parent?.type === "VariableDeclarator"
            ? "aliased to a variable"
            : `used as a value (${parent?.type ?? "unknown"})`;
      context.report({ node: id, messageId: "processAlias", data: { how } });
    }

    return {
      ImportDeclaration(node) {
        if (!PROCESS_MODULES.has(node.source.value)) return;
        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportSpecifier") {
            const imported =
              specifier.imported.type === "Identifier" ? specifier.imported.name : String(specifier.imported.value);
            if (imported === "env" || imported === "default") {
              context.report({
                node: specifier,
                messageId: "envImport",
                data: { name: imported, source: node.source.value },
              });
            }
            continue;
          }
          // default or namespace: every reference to the local name IS `process`.
          for (const variable of sourceCode.getDeclaredVariables(specifier)) {
            for (const reference of variable.references) processRefs.push(reference.identifier);
          }
        }
      },

      ImportExpression(node) {
        if (node.source.type === "Literal" && PROCESS_MODULES.has(node.source.value)) {
          context.report({ node, messageId: "untrackable", data: { how: `import("${node.source.value}")` } });
        }
      },

      CallExpression(node) {
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "require" &&
          node.arguments[0]?.type === "Literal" &&
          PROCESS_MODULES.has(node.arguments[0].value)
        ) {
          context.report({ node, messageId: "untrackable", data: { how: `require("${node.arguments[0].value}")` } });
        }
      },

      MemberExpression(node) {
        if (node.object.type !== "Identifier" || !GLOBAL_OBJECTS.has(node.object.name)) return;
        const scope = sourceCode.getScope(node);
        let local = false;
        for (let current = scope; current; current = current.upper) {
          const variable = current.variables.find((v) => v.name === node.object.name);
          if (variable) {
            local = variable.defs.length > 0 && current.type !== "global";
            break;
          }
        }
        if (local) return;
        const name = memberName(node);
        if (name === "process") {
          context.report({ node, messageId: "untrackable", data: { how: `${node.object.name}.process` } });
        } else if (name === undefined) {
          context.report({
            node,
            messageId: "untrackable",
            data: { how: `${node.object.name}[…] with a computed key` },
          });
        }
      },

      "Program:exit"(program) {
        const globalScope = sourceCode.getScope(program);
        for (const reference of globalScope.through) {
          if (reference.identifier.name === "process") processRefs.push(reference.identifier);
        }
        const globalVariable = globalScope.set.get("process");
        if (globalVariable) {
          for (const reference of globalVariable.references) processRefs.push(reference.identifier);
        }
        const seen = new Set();
        for (const id of processRefs) {
          if (seen.has(id)) continue;
          seen.add(id);
          checkProcessUse(id);
        }
      },
    };
  },
};

export default rule;
